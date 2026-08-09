// ============================================================
// Review Queue Controller
// ------------------------------------------------------------
// Admin-facing endpoints for the manual review queue populated by
// imageVerificationController when trust_score is 60-79.
// ============================================================
const db = require('../db');
const { resolveWard } = require('../services/geoRoutingService');
const { estimateSeverity } = require('../services/severityService');

// ── GET /admin/review-queue ───────────────────────────────────
const listReviewQueue = async (req, res) => {
  const { status = 'PENDING', page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    const { rows } = await db.query(
      `SELECT rq.*, u.name AS reporter_name
         FROM review_queue rq
         LEFT JOIN users u ON u.id = rq.user_id
        WHERE rq.status = $1
        ORDER BY rq.created_at DESC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    res.json({ page: Number(page), limit: Number(limit), items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /admin/review-queue/:id/approve ─────────────────────
const approveReviewItem = async (req, res) => {
  try {
    const { rows: existing } = await db.query('SELECT * FROM review_queue WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Review item not found' });
    const item = existing[0];
    if (item.status !== 'PENDING') {
      return res.status(400).json({ error: `Item already ${item.status.toLowerCase()}` });
    }

    const ward = await resolveWard(item.latitude, item.longitude).catch(() => null);
    const severity = estimateSeverity({ issueType: item.issue_type, confidence: item.confidence || 0 });

    let assigned_department_id = null;
    if (ward?.department) {
      const dept = await db.query(`SELECT id FROM departments WHERE name ILIKE $1 LIMIT 1`, [ward.department]);
      assigned_department_id = dept.rows[0]?.id || null;
    }

    const { rows } = await db.query(
      `INSERT INTO complaints
         (user_id, title, description, category, category_confidence,
          image_url, latitude, longitude, ward, ward_id, assigned_department_id,
          trust_score, image_verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved_after_review')
       RETURNING *`,
      [
        item.user_id, item.title, item.description, item.issue_type, item.confidence,
        item.image_url, item.latitude, item.longitude, ward?.name || null, ward?.id || null,
        assigned_department_id, item.trust_score,
      ]
    );
    const complaint = rows[0];

    await db.query(
      `UPDATE review_queue SET status='APPROVED', reviewed_by=$1, reviewed_at=NOW(), resulting_complaint_id=$2 WHERE id=$3`,
      [req.user.id, complaint.id, item.id]
    );

    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks)
       VALUES ($1, 'reported', $2, 'Approved from manual review queue')`,
      [complaint.id, req.user.id]
    );

    try {
      const { emitComplaintCreated } = require('../realtime/socket');
      emitComplaintCreated(complaint);
    } catch (sockErr) {
      console.warn('Socket emit skipped:', sockErr.message);
    }

    res.json({ message: 'Approved and complaint created', complaint });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /admin/review-queue/:id/reject ───────────────────────
const rejectReviewItem = async (req, res) => {
  const { reason } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE review_queue
          SET status='REJECTED', reviewed_by=$1, reviewed_at=NOW(),
              reasons = COALESCE(reasons, '[]'::jsonb) || $2::jsonb
        WHERE id = $3 AND status='PENDING'
        RETURNING *`,
      [req.user.id, JSON.stringify(reason ? [reason] : []), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Review item not found or already actioned' });
    res.json({ message: 'Rejected', item: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { listReviewQueue, approveReviewItem, rejectReviewItem };
