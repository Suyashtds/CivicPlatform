const axios = require('axios');
const db    = require('../db');
const { reverseGeocode } = require('../services/geocodingService');
const {
  notifyComplaintSubmitted,
  notifyStatusUpdate,
  notifyUpvote,
} = require('./notificationController');

const ML_URL = () => process.env.ML_SERVICE_URL || 'http://localhost:8000';

// ── POST /complaints ─────────────────────────────────────────
const createComplaint = async (req, res) => {
  let { title, description, latitude, longitude, address, city, ward, city_id, ward_id, confirmed_duplicate_of } = req.body;
  const image_url = req.file?.path || req.body.image_url || null;

  // Convert to numbers
  latitude  = parseFloat(latitude);
  longitude = parseFloat(longitude);

  try {
    // ── Step 1: Auto-fill address via reverse geocoding ──────
    if (!address || !city) {
      const geo = await reverseGeocode(latitude, longitude);
      if (geo) {
        address = address || geo.address;
        city    = city    || geo.city;
        ward    = ward    || geo.ward;
      }
    }

    // ── Step 2: Call ML service ──────────────────────────────
    let mlResult = {
      predicted_category: null, confidence: null,
      duplicate_score: 0, duplicate_match_id: null,
      severity_score: 0, priority_score: 0, model_version: 'none',
    };

    try {
      const { data } = await axios.post(`${ML_URL()}/ml/analyze-complaint`, {
        title, description, image_url, latitude, longitude, ward_id, city_id,
      });
      mlResult = { ...mlResult, ...data };
    } catch (mlErr) {
      console.warn('ML service unavailable:', mlErr.message);
    }

    // ── Step 3: Duplicate check (skipped if citizen already confirmed a link) ──
    const THRESHOLD = parseFloat(process.env.DUPLICATE_SIMILARITY_THRESHOLD || 0.75);
    if (!confirmed_duplicate_of && mlResult.duplicate_score >= THRESHOLD && mlResult.duplicate_match_id) {
      return res.status(200).json({
        is_duplicate:   true,
        duplicate_of:   mlResult.duplicate_match_id,
        duplicate_score: mlResult.duplicate_score,
        message: 'A similar complaint already exists nearby. Would you like to upvote it instead?',
      });
    }

    // ── Step 3b: Rule-based duplicate fallback ───────────────
    // Works even when the ML service is down or didn't flag anything —
    // uses PostGIS distance + trigram text similarity (see
    // services/duplicateDetectionService.js).
    let ruleBasedDuplicate = null;
    if (!confirmed_duplicate_of) {
      try {
        const { findDuplicate } = require('../services/duplicateDetectionService');
        ruleBasedDuplicate = await findDuplicate({
          title, description, category: mlResult.predicted_category, latitude, longitude, ward_id,
        });
      } catch (dupErr) {
        console.warn('Rule-based duplicate check skipped:', dupErr.message);
      }
    }

    if (ruleBasedDuplicate) {
      return res.status(200).json({
        is_duplicate:    true,
        duplicate_of:    ruleBasedDuplicate.id,
        duplicate_score: ruleBasedDuplicate.score,
        detection_method: 'rule_based',
        message: 'A similar complaint already exists nearby. Would you like to upvote it instead?',
      });
    }

    // ── Step 4: Route to department ──────────────────────────
    let assigned_department_id = null;
    if (mlResult.predicted_category && ward_id) {
      const dept = await db.query(
        `SELECT id FROM departments
          WHERE ($1 = ANY(categories) OR categories IS NULL)
            AND (ward_id = $2 OR ward_id IS NULL)
          ORDER BY ward_id DESC NULLS LAST LIMIT 1`,
        [mlResult.predicted_category, ward_id]
      );
      assigned_department_id = dept.rows[0]?.id || null;
    }

    // ── Step 5: Save complaint ───────────────────────────────
    const { rows } = await db.query(
      `INSERT INTO complaints
         (user_id, title, description, category, category_confidence,
          image_url, latitude, longitude, address, city, ward, city_id, ward_id,
          severity_score, priority_score, assigned_department_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        req.user.id, title, description,
        mlResult.predicted_category, mlResult.confidence, image_url,
        latitude, longitude, address, city, ward, city_id, ward_id,
        mlResult.severity_score, mlResult.priority_score, assigned_department_id,
      ]
    );

    const complaint = rows[0];

    // ── Step 5a: Link as duplicate report if citizen confirmed one ──
    if (confirmed_duplicate_of) {
      try {
        const { linkAsDuplicate } = require('../services/duplicateDetectionService');
        await linkAsDuplicate(confirmed_duplicate_of, complaint.id);
      } catch (linkErr) {
        console.warn('Failed to link duplicate report:', linkErr.message);
      }
    }

    // ── Step 5b: Stamp SLA deadlines ─────────────────────────
    try {
      const { assignSlaToComplaint } = require('../services/slaService');
      await assignSlaToComplaint(complaint.id, {
        category: mlResult.predicted_category,
        priority_score: mlResult.priority_score,
      });
    } catch (slaErr) {
      console.warn('SLA assignment skipped:', slaErr.message);
    }

    // ── Step 6: Save ML audit ────────────────────────────────
    await db.query(
      `INSERT INTO ml_predictions
         (complaint_id, predicted_category, confidence, duplicate_score,
          severity_score, priority_score, model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [complaint.id, mlResult.predicted_category, mlResult.confidence,
       mlResult.duplicate_score, mlResult.severity_score,
       mlResult.priority_score, mlResult.model_version]
    );

    // ── Step 7: Status history ───────────────────────────────
    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks)
       VALUES ($1, 'reported', $2, 'Complaint submitted by citizen')`,
      [complaint.id, req.user.id]
    );

    // ── Step 8: Send notification ────────────────────────────
    notifyComplaintSubmitted(complaint.id).catch(console.error);

    // ── Real-time push (additive — no-op if sockets aren't initialized) ──
    try {
      const { emitComplaintCreated } = require('../realtime/socket');
      emitComplaintCreated(complaint);
    } catch (sockErr) {
      console.warn('Socket emit skipped:', sockErr.message);
    }

    res.status(201).json({ is_duplicate: false, complaint, ml: mlResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /complaints ──────────────────────────────────────────
const listComplaints = async (req, res) => {
  const {
    category, status, ward_id, city_id,
    lat, lng, radius_m = 2000,
    page = 1, limit = 20,
    sort = 'priority',
  } = req.query;

  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (category) { conditions.push(`c.category = $${idx++}`);  values.push(category); }
  if (status)   { conditions.push(`c.status = $${idx++}`);    values.push(status); }
  if (ward_id)  { conditions.push(`c.ward_id = $${idx++}`);   values.push(ward_id); }
  if (city_id)  { conditions.push(`c.city_id = $${idx++}`);   values.push(city_id); }

  if (lat && lng) {
    conditions.push(
      `ST_DWithin(c.geo_point, ST_SetSRID(ST_MakePoint($${idx++}, $${idx++}), 4326)::geography, $${idx++})`
    );
    values.push(parseFloat(lng), parseFloat(lat), parseFloat(radius_m));
  }

  const where   = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = sort === 'priority'
    ? 'c.priority_score DESC, c.created_at DESC'
    : 'c.created_at DESC';

  try {
    const { rows } = await db.query(
      `SELECT c.*, u.name AS reporter_name, d.name AS department_name,
              COUNT(v.id) AS vote_count
         FROM complaints c
         LEFT JOIN users       u ON u.id = c.user_id
         LEFT JOIN departments d ON d.id = c.assigned_department_id
         LEFT JOIN votes       v ON v.complaint_id = c.id
         ${where}
         GROUP BY c.id, u.name, d.name
         ORDER BY ${orderBy}
         LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );
    res.json({ page: Number(page), limit: Number(limit), complaints: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /complaints/:id ──────────────────────────────────────
const getComplaint = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.name AS reporter_name, d.name AS department_name,
              (SELECT COUNT(*) FROM votes WHERE complaint_id = c.id) AS vote_count
         FROM complaints c
         LEFT JOIN users       u ON u.id = c.user_id
         LEFT JOIN departments d ON d.id = c.assigned_department_id
        WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });

    const history = await db.query(
      `SELECT sh.*, u.name AS updated_by_name
         FROM status_history sh
         LEFT JOIN users u ON u.id = sh.updated_by
        WHERE sh.complaint_id = $1
        ORDER BY sh.created_at ASC`,
      [req.params.id]
    );

    res.json({ complaint: rows[0], timeline: history.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /complaints/:id/status ───────────────────────────────
const updateStatus = async (req, res) => {
  const { status, remarks, proof_image_url } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE complaints SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });

    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks, proof_image_url)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, status, req.user.id, remarks, proof_image_url]
    );

    notifyStatusUpdate(req.params.id, status, remarks).catch(console.error);

    try {
      const { emitComplaintStatusUpdated } = require('../realtime/socket');
      emitComplaintStatusUpdated(req.params.id, status, remarks);
    } catch (sockErr) {
      console.warn('Socket emit skipped:', sockErr.message);
    }

    res.json({ complaint: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /complaints/:id/upvote ──────────────────────────────
const upvoteComplaint = async (req, res) => {
  try {
    const comp = await db.query('SELECT id, upvote_count FROM complaints WHERE id = $1', [req.params.id]);
    if (!comp.rows.length) return res.status(404).json({ error: 'Complaint not found' });

    await db.query(
      'INSERT INTO votes (complaint_id, user_id) VALUES ($1,$2)',
      [req.params.id, req.user.id]
    );

    await db.query(
      `UPDATE complaints
          SET upvote_count = upvote_count + 1,
              priority_score = priority_score + 2,
              updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );

    notifyUpvote(req.params.id, req.user.id).catch(console.error);

    res.json({ message: 'Upvoted successfully' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You have already upvoted this complaint' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /complaints/:id/feedback ────────────────────────────
const submitFeedback = async (req, res) => {
  const { rating, comment } = req.body;

  try {
    await db.query(
      `INSERT INTO feedback (complaint_id, user_id, rating, comment)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (complaint_id, user_id) DO UPDATE SET rating=$3, comment=$4`,
      [req.params.id, req.user.id, rating, comment]
    );
    res.json({ message: 'Feedback submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  createComplaint, listComplaints, getComplaint,
  updateStatus, upvoteComplaint, submitFeedback,
};

// ── PUT /complaints/:id ───────────────────────────────────────
// Citizen can edit title/description only if status is still 'reported'
const editComplaint = async (req, res) => {
  const { title, description } = req.body;

  if (!title && !description) {
    return res.status(400).json({ error: 'Provide at least title or description to update' });
  }

  try {
    // Check complaint exists and belongs to this user
    const { rows: existing } = await db.query(
      'SELECT id, user_id, status FROM complaints WHERE id = $1',
      [req.params.id]
    );

    if (!existing.length) return res.status(404).json({ error: 'Complaint not found' });

    const complaint = existing[0];

    // Only owner can edit
    if (complaint.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to edit this complaint' });
    }

    // Can only edit if still in reported status
    if (complaint.status !== 'reported') {
      return res.status(400).json({
        error: `Cannot edit complaint with status '${complaint.status}'. Only 'reported' complaints can be edited.`
      });
    }

    // Build update query dynamically
    const updates = [];
    const values  = [];
    let idx = 1;

    if (title)       { updates.push(`title = $${idx++}`);       values.push(title); }
    if (description) { updates.push(`description = $${idx++}`); values.push(description); }
    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE complaints SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    res.json({ message: 'Complaint updated successfully', complaint: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── DELETE /complaints/:id ────────────────────────────────────
// Soft delete — marks complaint as rejected rather than removing from DB
// Preserves data integrity and audit trail
const deleteComplaint = async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT id, user_id, status FROM complaints WHERE id = $1',
      [req.params.id]
    );

    if (!existing.length) return res.status(404).json({ error: 'Complaint not found' });

    const complaint = existing[0];

    // Only owner or admin can delete
    if (complaint.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this complaint' });
    }

    // Can only delete if still reported (not already in progress)
    if (!['reported', 'verified'].includes(complaint.status) && req.user.role !== 'admin') {
      return res.status(400).json({
        error: `Cannot delete complaint with status '${complaint.status}'. Contact admin for assistance.`
      });
    }

    // Soft delete — mark as rejected with a note
    await db.query(
      `UPDATE complaints SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks)
       VALUES ($1, 'rejected', $2, 'Complaint withdrawn by citizen')`,
      [req.params.id, req.user.id]
    );

    res.json({ message: 'Complaint withdrawn successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.editComplaint   = editComplaint;
module.exports.deleteComplaint = deleteComplaint;

// ── GET /complaints/my ───────────────────────────────────────
// Returns only complaints submitted by the logged-in citizen
const myComplaints = async (req, res) => {
  const { page = 1, limit = 20, status, sort = 'recent' } = req.query;
  const offset  = (page - 1) * limit;
  const orderBy = sort === 'priority' ? 'c.priority_score DESC' : 'c.created_at DESC';

  const conditions = ['c.user_id = $1'];
  const values     = [req.user.id];
  let idx = 2;

  if (status) { conditions.push(`c.status = $${idx++}`); values.push(status); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const { rows } = await db.query(
      `SELECT c.*,
              d.name AS department_name,
              (SELECT COUNT(*) FROM votes WHERE complaint_id = c.id) AS vote_count,
              (SELECT sh.status FROM status_history sh
                WHERE sh.complaint_id = c.id
                ORDER BY sh.created_at DESC LIMIT 1) AS latest_status_update
         FROM complaints c
         LEFT JOIN departments d ON d.id = c.assigned_department_id
         ${where}
         ORDER BY ${orderBy}
         LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );

    // Total count for pagination
    const countResult = await db.query(
      `SELECT COUNT(*) FROM complaints c ${where}`,
      values.slice(0, idx - 3)
    );

    res.json({
      page:       Number(page),
      limit:      Number(limit),
      total:      parseInt(countResult.rows[0].count),
      complaints: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /complaints/search ───────────────────────────────────
// Full-text search across complaint title and description
const searchComplaints = async (req, res) => {
  const { q, category, status, ward_id, page = 1, limit = 20 } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  const offset = (page - 1) * limit;
  const conditions = [
    `to_tsvector('english', c.title || ' ' || c.description) @@ plainto_tsquery('english', $1)`
  ];
  const values = [q.trim()];
  let idx = 2;

  if (category) { conditions.push(`c.category = $${idx++}`); values.push(category); }
  if (status)   { conditions.push(`c.status = $${idx++}`);   values.push(status); }
  if (ward_id)  { conditions.push(`c.ward_id = $${idx++}`);  values.push(ward_id); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const { rows } = await db.query(
      `SELECT c.*,
              u.name AS reporter_name,
              d.name AS department_name,
              ts_rank(to_tsvector('english', c.title || ' ' || c.description),
                      plainto_tsquery('english', $1)) AS relevance_score
         FROM complaints c
         LEFT JOIN users       u ON u.id = c.user_id
         LEFT JOIN departments d ON d.id = c.assigned_department_id
         ${where}
         ORDER BY relevance_score DESC, c.created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );

    res.json({
      query:      q,
      page:       Number(page),
      limit:      Number(limit),
      results:    rows.length,
      complaints: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.myComplaints     = myComplaints;
module.exports.searchComplaints = searchComplaints;

// ── OVERRIDE submitFeedback with status check ─────────────────
const submitFeedbackValidated = async (req, res) => {
  const { rating, comment } = req.body;

  try {
    // Check complaint is resolved before allowing feedback
    const { rows: comp } = await db.query(
      'SELECT status, user_id FROM complaints WHERE id = $1',
      [req.params.id]
    );

    if (!comp.length) return res.status(404).json({ error: 'Complaint not found' });

    if (comp[0].status !== 'resolved') {
      return res.status(400).json({
        error: `Feedback can only be submitted after complaint is resolved. Current status: ${comp[0].status}`
      });
    }

    await db.query(
      `INSERT INTO feedback (complaint_id, user_id, rating, comment)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (complaint_id, user_id) DO UPDATE SET rating=$3, comment=$4`,
      [req.params.id, req.user.id, rating, comment]
    );

    res.json({ message: 'Feedback submitted successfully. Thank you!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.submitFeedbackValidated = submitFeedbackValidated;

// ── GET /complaints/public ───────────────────────────────────
// Public feed — no authentication required
// Citizens can browse complaints without logging in
const publicFeed = async (req, res) => {
  const {
    category, status, ward_id, city_id,
    page = 1, limit = 12,
    sort = 'priority',
  } = req.query;

  const offset = (page - 1) * limit;
  const conditions = ['c.status != $1'];
  const values = ['rejected'];
  let idx = 2;

  if (category) { conditions.push(`c.category = $${idx++}`); values.push(category); }
  if (status)   { conditions.push(`c.status = $${idx++}`);   values.push(status); }
  if (ward_id)  { conditions.push(`c.ward_id = $${idx++}`);  values.push(ward_id); }
  if (city_id)  { conditions.push(`c.city_id = $${idx++}`);  values.push(city_id); }

  const where   = `WHERE ${conditions.join(' AND ')}`;
  const orderBy = sort === 'priority'
    ? 'c.priority_score DESC, c.created_at DESC'
    : 'c.created_at DESC';

  try {
    const { rows } = await db.query(
      `SELECT
         c.id, c.title, c.description, c.category,
         c.image_url, c.address, c.city, c.ward,
         c.status, c.priority_score, c.upvote_count,
         c.created_at, c.ward_id, c.city_id,
         d.name AS department_name
       FROM complaints c
       LEFT JOIN departments d ON d.id = c.assigned_department_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );

    // Note: reporter name and exact coordinates NOT exposed in public feed for privacy
    res.json({
      page:       Number(page),
      limit:      Number(limit),
      complaints: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.publicFeed = publicFeed;
