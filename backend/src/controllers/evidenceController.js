const db = require('../db');
const { logAction } = require('../services/auditService');

const GPS_TOLERANCE_M = parseFloat(process.env.EVIDENCE_GPS_TOLERANCE_M || 150);

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── POST /complaints/:id/evidence ───────────────────────────
// Officer uploads before/after proof. image_url is expected to already
// be hosted (e.g. via the existing /upload/proof-image endpoint or
// Cloudinary) — this endpoint records the evidence metadata + GPS check.
const uploadEvidence = async (req, res) => {
  const { type, image_url, notes, latitude, longitude } = req.body;
  const complaintId = req.params.id;

  if (!['before', 'after'].includes(type)) {
    return res.status(400).json({ error: "type must be 'before' or 'after'" });
  }
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  try {
    const { rows: comp } = await db.query('SELECT latitude, longitude FROM complaints WHERE id = $1', [complaintId]);
    if (!comp.length) return res.status(404).json({ error: 'Complaint not found' });

    let gpsVerified = null;
    if (latitude != null && longitude != null) {
      const dist = haversineMeters(parseFloat(latitude), parseFloat(longitude), comp[0].latitude, comp[0].longitude);
      gpsVerified = dist <= GPS_TOLERANCE_M;
    }

    const { rows } = await db.query(
      `INSERT INTO evidence (complaint_id, officer_id, type, image_url, notes, latitude, longitude, gps_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [complaintId, req.user.id, type, image_url, notes || null, latitude || null, longitude || null, gpsVerified]
    );

    await logAction({ action: 'evidence.uploaded', entityType: 'complaint', entityId: complaintId, actor: req.user, metadata: { type, gpsVerified } });
    res.status(201).json({ evidence: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /complaints/:id/evidence ─────────────────────────────
const listEvidence = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT e.*, u.name AS officer_name FROM evidence e
         LEFT JOIN users u ON u.id = e.officer_id
        WHERE e.complaint_id = $1 ORDER BY e.captured_at ASC`,
      [req.params.id]
    );
    res.json({ evidence: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { uploadEvidence, listEvidence };
