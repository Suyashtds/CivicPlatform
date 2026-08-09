const db = require('../db');

// ── GET /citizen/dashboard ────────────────────────────────────
// Aggregated view for the citizen dashboard: history summary,
// notifications count, bookmarks count, reputation.
const getDashboard = async (req, res) => {
  try {
    const [complaints, unreadNotifs, bookmarks, reputation] = await Promise.all([
      db.query(
        `SELECT status, COUNT(*) AS count FROM complaints WHERE user_id = $1 GROUP BY status`,
        [req.user.id]
      ),
      db.query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE`, [req.user.id]),
      db.query(`SELECT COUNT(*) FROM bookmarks WHERE user_id = $1`, [req.user.id]),
      computeReputation(req.user.id),
    ]);

    res.json({
      complaints_by_status: complaints.rows,
      unread_notifications: parseInt(unreadNotifs.rows[0].count),
      bookmark_count: parseInt(bookmarks.rows[0].count),
      reputation,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Citizen Reputation Score ──────────────────────────────────
// Rewards constructive participation, not popularity:
//   + verified/resolved complaints they filed
//   + confirmations they gave on others' complaints
//   + feedback they left
//   - complaints rejected as invalid/false (small penalty, capped)
// Score is descriptive (0-100), not used to gate access to any feature.
async function computeReputation(userId) {
  const { rows } = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('resolved','closed')) AS resolved_filed,
        COUNT(*) FILTER (WHERE status = 'rejected')             AS rejected_filed,
        COUNT(*)                                                AS total_filed
       FROM complaints WHERE user_id = $1`,
    [userId]
  );
  const confirmations = await db.query(
    `SELECT COUNT(*) FROM complaint_comments WHERE user_id = $1 AND is_confirmation = TRUE`,
    [userId]
  );
  const feedbackGiven = await db.query(`SELECT COUNT(*) FROM feedback WHERE user_id = $1`, [userId]);

  const r = rows[0];
  const resolved = parseInt(r.resolved_filed) || 0;
  const rejected = parseInt(r.rejected_filed) || 0;
  const confirmCount = parseInt(confirmations.rows[0].count) || 0;
  const feedbackCount = parseInt(feedbackGiven.rows[0].count) || 0;

  const score = Math.max(0, Math.min(100,
    50 + resolved * 5 + confirmCount * 2 + feedbackCount * 2 - Math.min(20, rejected * 4)
  ));

  return {
    score,
    resolved_complaints_filed: resolved,
    community_confirmations_given: confirmCount,
    feedback_given: feedbackCount,
  };
}

module.exports = { getDashboard, computeReputation };
