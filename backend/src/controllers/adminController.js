const db = require('../db');

// ── GET /admin/dashboard ────────────────────────────────────
const getDashboard = async (req, res) => {
  const { city_id, ward_id } = req.query;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (city_id) { conditions.push(`city_id = $${idx++}`); values.push(city_id); }
  if (ward_id) { conditions.push(`ward_id = $${idx++}`); values.push(ward_id); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // Totals by status
    const byStatus = await db.query(
      `SELECT status, COUNT(*) AS count
         FROM complaints ${where}
        GROUP BY status`,
      values
    );

    // Totals by category
    const byCategory = await db.query(
      `SELECT category, COUNT(*) AS count
         FROM complaints ${where}
        GROUP BY category ORDER BY count DESC`,
      values
    );

    // Top 10 urgent unresolved
    const urgent = await db.query(
      `SELECT c.id, c.title, c.category, c.status, c.priority_score,
              c.upvote_count, c.ward, c.created_at, u.name AS reporter
         FROM complaints c
         JOIN users u ON u.id = c.user_id
        ${where ? where + ' AND' : 'WHERE'} c.status NOT IN ('resolved','rejected')
        ORDER BY c.priority_score DESC
        LIMIT 10`,
      values
    );

    // Average resolution time (in hours)
    const avgTime = await db.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (sh_resolved.created_at - c.created_at))/3600)::numeric, 1) AS avg_hours
         FROM complaints c
         JOIN status_history sh_resolved ON sh_resolved.complaint_id = c.id AND sh_resolved.status = 'resolved'
        ${where}`,
      values
    );

    // Ward hotspots
    const hotspots = await db.query(
      `SELECT ward, ward_id, COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('resolved','rejected') THEN 1 ELSE 0 END) AS unresolved
         FROM complaints ${where}
        GROUP BY ward, ward_id
        ORDER BY total DESC
        LIMIT 10`,
      values
    );

    res.json({
      by_status:     byStatus.rows,
      by_category:   byCategory.rows,
      urgent:        urgent.rows,
      avg_resolution_hours: avgTime.rows[0]?.avg_hours || null,
      ward_hotspots: hotspots.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /admin/complaints/:id/assign ───────────────────────
const assignComplaint = async (req, res) => {
  const { department_id } = req.body;
  if (!department_id) return res.status(400).json({ error: 'department_id required' });

  try {
    const dept = await db.query('SELECT id, name FROM departments WHERE id = $1', [department_id]);
    if (!dept.rows.length) return res.status(404).json({ error: 'Department not found' });

    const { rows } = await db.query(
      `UPDATE complaints
          SET assigned_department_id = $1, status = 'assigned', updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [department_id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });

    await db.query(
      `INSERT INTO status_history (complaint_id, status, updated_by, remarks)
       VALUES ($1, 'assigned', $2, $3)`,
      [req.params.id, req.user.id, `Assigned to ${dept.rows[0].name}`]
    );

    res.json({ complaint: rows[0], department: dept.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /analytics/city ─────────────────────────────────────
const getCityAnalytics = async (req, res) => {
  const { city_id, ward_id, from_date, to_date } = req.query;
  const conds = [];
  const vals  = [];
  let idx = 1;

  if (city_id)   { conds.push(`city_id = $${idx++}`);             vals.push(city_id); }
  if (ward_id)   { conds.push(`ward_id = $${idx++}`);             vals.push(ward_id); }
  if (from_date) { conds.push(`created_at >= $${idx++}`);         vals.push(from_date); }
  if (to_date)   { conds.push(`created_at <= $${idx++}::date + 1`); vals.push(to_date); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const [byCat, byWard, byPriority, timeline] = await Promise.all([
      db.query(`SELECT category, COUNT(*) AS total,
                       SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved
                  FROM complaints ${where} GROUP BY category ORDER BY total DESC`, vals),

      db.query(`SELECT ward, ward_id, COUNT(*) AS total,
                       ROUND(AVG(priority_score)::numeric, 2) AS avg_priority
                  FROM complaints ${where} GROUP BY ward, ward_id ORDER BY total DESC`, vals),

      db.query(`SELECT
                  CASE WHEN priority_score >= 75 THEN 'High'
                       WHEN priority_score >= 40 THEN 'Medium'
                       ELSE 'Low' END AS priority_band,
                  COUNT(*) AS count
                FROM complaints ${where} GROUP BY priority_band`, vals),

      db.query(`SELECT DATE_TRUNC('week', created_at) AS week, COUNT(*) AS count
                  FROM complaints ${where} GROUP BY week ORDER BY week`, vals),
    ]);

    res.json({
      by_category:   byCat.rows,
      by_ward:       byWard.rows,
      by_priority:   byPriority.rows,
      weekly_trend:  timeline.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /admin/departments ──────────────────────────────────
const listDepartments = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM departments ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { getDashboard, assignComplaint, getCityAnalytics, listDepartments };

// ── GET /admin/ml-status ──────────────────────────────────────
// Returns whether ML service is reachable and responding correctly
const getMLStatus = async (req, res) => {
  const axios = require('axios');
  const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
  const start = Date.now();

  try {
    const { data } = await axios.get(`${ML_URL}/health`, { timeout: 3000 });
    const responseTime = Date.now() - start;

    res.json({
      status:        'online',
      ml_url:        ML_URL,
      response_time: `${responseTime}ms`,
      ml_response:   data,
    });
  } catch (err) {
    res.status(503).json({
      status:  'offline',
      ml_url:  ML_URL,
      error:   err.message,
      message: 'ML service is not reachable. Category classification and duplicate detection will not work until it is restarted.',
    });
  }
};

module.exports.getMLStatus = getMLStatus;

// ── POST /admin/recalculate-priorities ───────────────────────
// Admin manually triggers priority recalculation for all complaints
const recalculatePriorities = async (req, res) => {
  const { recalculateAllPriorities } = require('../services/priorityUpdateService');
  res.json({ message: 'Priority recalculation started in background.' });
  recalculateAllPriorities().catch(console.error);
};

module.exports.recalculatePriorities = recalculatePriorities;
