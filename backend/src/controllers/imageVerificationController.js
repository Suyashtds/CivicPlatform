// ============================================================
// Image Verification Controller
// ------------------------------------------------------------
// New, additive complaint-creation path: POST /complaints/verified
// Runs the full pipeline described in the image-verification spec:
//   1. Upload image to Cloudinary
//   2. Send image + metadata to ML service POST /analyze
//   3. Reject if trust score < 60
//   4. Create complaint if >= 80
//   5. Create review_queue entry if 60-79
//   6. Determine severity via severityService
//   7. Find ward + officer via geoRoutingService
//   8. Send automatic email
//
// The existing POST /complaints (complaintsController.createComplaint)
// is completely untouched — this is a parallel, opt-in route the
// frontend calls when an image is attached (see NewComplaint.jsx patch).
// ============================================================
const axios      = require('axios');
const FormData   = require('form-data');
const db         = require('../db');
const { uploadToCloudinary, MIN_SIZE } = require('../middleware/upload');
const { resolveWard }        = require('../services/geoRoutingService');
const { estimateSeverity }   = require('../services/severityService');
const { sendVerifiedComplaintEmail, sendReviewQueueEmail } = require('../services/emailService');
const { notifyComplaintSubmitted } = require('./notificationController');

const ML_URL = () => process.env.ML_SERVICE_URL || 'http://localhost:8000';
const APPROVE_THRESHOLD = 80;
const REVIEW_THRESHOLD  = 60;

/**
 * Calls the ML service's image-analysis endpoint with the raw image
 * buffer + citizen-supplied GPS/device metadata.
 */
async function callImageAnalysis(buffer, filename, mimetype, metadata) {
  const form = new FormData();
  form.append('image', buffer, { filename, contentType: mimetype });
  if (metadata.latitude   != null) form.append('latitude', String(metadata.latitude));
  if (metadata.longitude  != null) form.append('longitude', String(metadata.longitude));
  if (metadata.accuracy   != null) form.append('accuracy', String(metadata.accuracy));
  if (metadata.captured_at)        form.append('captured_at', metadata.captured_at);
  if (metadata.user_reputation != null) form.append('user_reputation', String(metadata.user_reputation));

  const { data } = await axios.post(`${ML_URL()}/analyze`, form, {
    headers: form.getHeaders(),
    timeout: parseInt(process.env.ML_REQUEST_TIMEOUT_MS || '30000', 10),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return data;
}

// ── POST /complaints/verified ────────────────────────────────
const createVerifiedComplaint = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'An image is required for verified complaint submission.' });
  }

  const {
    title, description, latitude, longitude,
    accuracy, captured_at, timezone, userAgent, heading,
  } = req.body;

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'Valid latitude/longitude are required.' });
  }

  // ── Patch F(4): minimum-size gate before any processing/storage ──
  if (req.file.size < MIN_SIZE) {
    return res.status(400).json({
      error: 'Image must be at least 200KB for verification',
    });
  }

  try {
    // ── Step 1: ML image analysis FIRST — nothing is stored until we
    // know the upload is worth storing (Patch B) ─────────────────
    let ml;
    try {
      ml = await callImageAnalysis(req.file.buffer, req.file.originalname || 'upload.jpg', req.file.mimetype, {
        latitude: lat, longitude: lng, accuracy, captured_at, user_reputation: 1.0,
      });
    } catch (mlErr) {
      console.error('ML image analysis failed:', mlErr.message);
      return res.status(502).json({
        error: 'Image verification service is unavailable. Please try again shortly.',
      });
    }

    const {
      status, issue_type, confidence, trust_score,
      is_duplicate, is_blurry, is_screenshot, rejection_reasons,
    } = ml;

    // ── Step 2: Reject if trust score < 60 — no Cloudinary upload ──
    if (trust_score < REVIEW_THRESHOLD) {
      return res.status(200).json({
        result: 'rejected',
        trust_score,
        reasons: rejection_reasons,
        message: 'This photo could not be verified as a genuine, unedited civic-issue photo.',
      });
    }

    // ── Step 3: Only review/approved statuses get uploaded to Cloudinary ──
    const uploadResult = await uploadToCloudinary(req.file.buffer, 'complaints', {
      transformation: [{ width: 1200, crop: 'limit' }, { quality: 'auto:good' }, { fetch_format: 'auto' }],
    });
    const image_url = uploadResult.secure_url;

    // ── Step 6/7: Severity + ward/officer routing (used either way) ──
    const severity = estimateSeverity({ issueType: issue_type, confidence });
    const ward = await resolveWard(lat, lng).catch((err) => {
      console.warn('Ward routing failed:', err.message);
      return null;
    });

    // ── Step 5: 60-79 -> manual review queue ─────────────────
    if (trust_score < APPROVE_THRESHOLD) {
      const { rows } = await db.query(
        `INSERT INTO review_queue
           (user_id, image_url, title, description, latitude, longitude,
            issue_type, confidence, trust_score, reasons, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')
         RETURNING *`,
        [
          req.user.id, image_url, title, description, lat, lng,
          issue_type, confidence, trust_score, JSON.stringify(rejection_reasons),
        ]
      );
      const queueEntry = rows[0];

      await db.query(
        `INSERT INTO ml_image_analysis
           (review_queue_id, issue_type, confidence, top3, is_blurry, is_screenshot,
            is_duplicate, trust_score, trust_breakdown, status, rejection_reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          queueEntry.id, issue_type, confidence, JSON.stringify(ml.top3 || []),
          is_blurry, is_screenshot, is_duplicate, trust_score,
          JSON.stringify(ml.breakdown || {}), 'review', JSON.stringify(rejection_reasons),
        ]
      );

      if (ward?.officer_email) {
        sendReviewQueueEmail({ to: ward.officer_email, queueEntry, ward, severity }).catch(console.error);
      }

      return res.status(202).json({
        result: 'review',
        trust_score,
        review_queue_id: queueEntry.id,
        message: 'Your report needs a quick manual check before it goes live. We\u2019ll notify you once it\u2019s verified.',
      });
    }

    // ── Step 4: >= 80 -> create the complaint ────────────────
    let assigned_department_id = null;
    if (ward?.department) {
      const dept = await db.query(
        `SELECT id FROM departments WHERE name ILIKE $1 LIMIT 1`,
        [ward.department]
      );
      assigned_department_id = dept.rows[0]?.id || null;
    }

    const device_metadata = { accuracy, captured_at, timezone, userAgent, heading };

    const { rows } = await db.query(
      `INSERT INTO complaints
         (user_id, title, description, category, category_confidence,
          image_url, latitude, longitude, ward, ward_id,
          severity_score, priority_score, assigned_department_id,
          trust_score, is_blurry, is_screenshot, is_duplicate_image,
          image_verification_status, image_reasons, device_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        req.user.id, title, description, issue_type, confidence,
        image_url, lat, lng, ward?.name || null, ward?.id || null,
        severityToScore(severity), Math.round(trust_score * 0.8), assigned_department_id,
        trust_score, is_blurry, is_screenshot, is_duplicate,
        'approved', JSON.stringify(rejection_reasons), JSON.stringify(device_metadata),
      ]
    );
    const complaint = rows[0];

    await db.query(
      `INSERT INTO ml_image_analysis
         (complaint_id, issue_type, confidence, top3, is_blurry, is_screenshot,
          is_duplicate, trust_score, trust_breakdown, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved')`,
      [
        complaint.id, issue_type, confidence, JSON.stringify(ml.top3 || []),
        is_blurry, is_screenshot, is_duplicate, trust_score, JSON.stringify(ml.breakdown || {}),
      ]
    );

    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks)
       VALUES ($1, 'reported', $2, 'Complaint auto-verified via image trust pipeline')`,
      [complaint.id, req.user.id]
    );

    notifyComplaintSubmitted(complaint.id).catch(console.error);

    try {
      const { emitComplaintCreated } = require('../realtime/socket');
      emitComplaintCreated(complaint);
    } catch (sockErr) {
      console.warn('Socket emit skipped:', sockErr.message);
    }

    if (ward?.officer_email) {
      sendVerifiedComplaintEmail({ to: ward.officer_email, complaint, ward, severity, trust_score }).catch(console.error);
    }

    return res.status(201).json({ result: 'approved', complaint, ml });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error during image verification.' });
  }
};

function severityToScore(severity) {
  return { CRITICAL: 0.95, HIGH: 0.75, MEDIUM: 0.5, LOW: 0.25 }[severity] ?? 0.5;
}

module.exports = { createVerifiedComplaint };
