const db = require('../db');

// ── POST /complaints/:id/comments ────────────────────────────
const addComment = async (req, res) => {
  const { comment, image_url, is_confirmation } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'comment text is required' });

  try {
    const { rows } = await db.query(
      `INSERT INTO complaint_comments (complaint_id, user_id, comment, image_url, is_confirmation)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user.id, comment.trim(), image_url || null, !!is_confirmation]
    );
    res.status(201).json({ comment: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /complaints/:id/comments ─────────────────────────────
const listComments = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cc.*, u.name AS user_name FROM complaint_comments cc
         JOIN users u ON u.id = cc.user_id
        WHERE cc.complaint_id = $1
        ORDER BY cc.created_at ASC`,
      [req.params.id]
    );
    const confirmations = rows.filter(r => r.is_confirmation).length;
    res.json({ comments: rows, confirmation_count: confirmations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /complaints/:id/bookmark ────────────────────────────
const toggleBookmark = async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id FROM bookmarks WHERE user_id = $1 AND complaint_id = $2`,
      [req.user.id, req.params.id]
    );
    if (existing.rows.length) {
      await db.query(`DELETE FROM bookmarks WHERE id = $1`, [existing.rows[0].id]);
      return res.json({ bookmarked: false });
    }
    await db.query(`INSERT INTO bookmarks (user_id, complaint_id) VALUES ($1,$2)`, [req.user.id, req.params.id]);
    res.json({ bookmarked: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /citizen/bookmarks ───────────────────────────────────
const listBookmarks = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.* FROM bookmarks b
         JOIN complaints c ON c.id = b.complaint_id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json({ bookmarks: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /citizen/nearby ───────────────────────────────────────
// "Community complaints nearby" for the citizen dashboard
const nearbyComplaints = async (req, res) => {
  const { lat, lng, radius_m = 1500, limit = 20 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });

  try {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.category, c.status, c.priority_score, c.upvote_count,
              c.latitude, c.longitude, c.created_at,
              ST_Distance(c.geo_point, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance_m
         FROM complaints c
        WHERE ST_DWithin(c.geo_point, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
          AND c.status NOT IN ('closed','rejected')
        ORDER BY distance_m ASC
        LIMIT $4`,
      [parseFloat(lng), parseFloat(lat), parseFloat(radius_m), limit]
    );
    res.json({ complaints: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { addComment, listComments, toggleBookmark, listBookmarks, nearbyComplaints };
