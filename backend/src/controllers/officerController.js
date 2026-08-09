const bcrypt = require('bcryptjs');
const db = require('../db');
const { logAction } = require('../services/auditService');
const { getOfficerWorkload } = require('../services/officerAssignmentService');

// ── POST /officers ──────────────────────────────────────────
// Admin/department-head creates an officer account
const createOfficer = async (req, res) => {
  const { name, email, phone, password, department_id, officer_rank = 'officer', max_active_complaints = 15 } = req.body;

  if (!name || !email || !password || !department_id) {
    return res.status(400).json({ error: 'name, email, password and department_id are required' });
  }
  if (!['officer', 'senior_officer', 'department_head', 'commissioner'].includes(officer_rank)) {
    return res.status(400).json({ error: 'Invalid officer_rank' });
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, phone, password_hash, role, department_id, officer_rank, max_active_complaints, is_verified)
       VALUES ($1,$2,$3,$4,'officer',$5,$6,$7,TRUE)
       RETURNING id, name, email, role, department_id, officer_rank, max_active_complaints, is_available`,
      [name, email, phone || null, passwordHash, department_id, officer_rank, max_active_complaints]
    );

    await logAction({ action: 'officer.created', entityType: 'officer', entityId: rows[0].id, actor: req.user, req });
    res.status(201).json({ officer: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /officers ────────────────────────────────────────────
const listOfficers = async (req, res) => {
  const { department_id, officer_rank, available_only } = req.query;
  const conditions = [`role = 'officer'`];
  const values = [];
  let idx = 1;

  if (department_id) { conditions.push(`department_id = $${idx++}`); values.push(department_id); }
  if (officer_rank)  { conditions.push(`officer_rank = $${idx++}`);  values.push(officer_rank); }
  if (available_only === 'true') conditions.push(`is_available = TRUE`);

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.department_id, u.officer_rank,
              u.is_available, u.max_active_complaints, d.name AS department_name,
              COUNT(c.id) FILTER (WHERE c.status NOT IN ('resolved','closed','rejected')) AS active_complaints
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN complaints c  ON c.assigned_officer_id = u.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY u.id, d.name
        ORDER BY u.officer_rank, u.name`,
      values
    );
    res.json({ officers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /officers/:id/workload ──────────────────────────────
const getWorkload = async (req, res) => {
  try {
    const activeCount = await getOfficerWorkload(req.params.id);
    const { rows } = await db.query(
      `SELECT id, title, category, status, priority_score, sla_resolution_due_at
         FROM complaints WHERE assigned_officer_id = $1
          AND status NOT IN ('resolved','closed','rejected')
        ORDER BY priority_score DESC`,
      [req.params.id]
    );
    res.json({ officer_id: req.params.id, active_count: activeCount, complaints: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /officers/:id/availability ──────────────────────────
const setAvailability = async (req, res) => {
  const { is_available } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE users SET is_available = $1, updated_at = NOW() WHERE id = $2 AND role = 'officer' RETURNING id, name, is_available`,
      [!!is_available, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Officer not found' });
    res.json({ officer: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /officers/:id/performance ───────────────────────────
const getPerformance = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
          COUNT(*) AS total_assigned,
          SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN escalation_level > 0 THEN 1 ELSE 0 END) AS escalated,
          ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(closed_at, NOW()) - created_at))/3600)::numeric,1) AS avg_resolution_hours,
          SUM(CASE WHEN sla_resolution_met = TRUE THEN 1 ELSE 0 END) AS sla_met,
          SUM(CASE WHEN sla_resolution_met = FALSE THEN 1 ELSE 0 END) AS sla_missed
        FROM complaints WHERE assigned_officer_id = $1`,
      [req.params.id]
    );
    const feedback = await db.query(
      `SELECT ROUND(AVG(f.rating)::numeric,2) AS avg_rating, COUNT(*) AS feedback_count
         FROM feedback f JOIN complaints c ON c.id = f.complaint_id
        WHERE c.assigned_officer_id = $1`,
      [req.params.id]
    );
    res.json({ officer_id: req.params.id, ...rows[0], ...feedback.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /officers/leave ────────────────────────────────────
const requestLeave = async (req, res) => {
  const { start_date, end_date, reason } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });

  try {
    const { rows } = await db.query(
      `INSERT INTO officer_leaves (officer_id, start_date, end_date, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, start_date, end_date, reason || null]
    );
    res.status(201).json({ leave: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /officers/leave ──────────────────────────────────────
const listLeaves = async (req, res) => {
  const { status, officer_id } = req.query;
  const conditions = [];
  const values = [];
  let idx = 1;
  if (status)     { conditions.push(`l.status = $${idx++}`);     values.push(status); }
  if (officer_id) { conditions.push(`l.officer_id = $${idx++}`); values.push(officer_id); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await db.query(
      `SELECT l.*, u.name AS officer_name FROM officer_leaves l
         JOIN users u ON u.id = l.officer_id ${where}
        ORDER BY l.created_at DESC`,
      values
    );
    res.json({ leaves: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── PUT /officers/leave/:id/review ──────────────────────────
const reviewLeave = async (req, res) => {
  const { decision } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  try {
    const { rows } = await db.query(
      `UPDATE officer_leaves SET status = $1, reviewed_by = $2 WHERE id = $3 RETURNING *`,
      [decision, req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Leave request not found' });

    if (decision === 'approved') {
      await db.query(`UPDATE users SET is_available = FALSE WHERE id = $1`, [rows[0].officer_id]);
    }
    await logAction({ action: `leave.${decision}`, entityType: 'officer_leave', entityId: rows[0].id, actor: req.user, req });
    res.json({ leave: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  createOfficer, listOfficers, getWorkload, setAvailability,
  getPerformance, requestLeave, listLeaves, reviewLeave,
};
