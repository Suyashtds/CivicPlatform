// ============================================================
// Global Search Controller
// ------------------------------------------------------------
// Complements the existing /complaints/search (title+description
// full-text search) with a cross-entity search across complaint ID,
// citizens, officers, departments, location/ward, and status — the
// "Search System" feature. Admin/department/officer only, since it
// surfaces user records.
// ============================================================
const db = require('../db');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const globalSearch = async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q must be at least 2 characters' });
  const term = q.trim();
  const like = `%${term}%`;

  try {
    const queries = [];

    // Complaint by exact ID
    if (isUuid(term)) {
      queries.push(
        db.query(`SELECT id, title, status, category FROM complaints WHERE id = $1`, [term])
          .then(r => ({ type: 'complaint', results: r.rows }))
      );
    }

    // Complaints by title/description/ward/status/tags
    queries.push(
      db.query(
        `SELECT id, title, status, category, ward FROM complaints
          WHERE title ILIKE $1 OR ward ILIKE $1 OR status ILIKE $1 OR $2 = ANY(tags)
          ORDER BY created_at DESC LIMIT $3`,
        [like, term, limit]
      ).then(r => ({ type: 'complaint', results: r.rows }))
    );

    // Citizens
    queries.push(
      db.query(
        `SELECT id, name, email, role FROM users WHERE role = 'citizen' AND (name ILIKE $1 OR email ILIKE $1) LIMIT $2`,
        [like, limit]
      ).then(r => ({ type: 'citizen', results: r.rows }))
    );

    // Officers
    queries.push(
      db.query(
        `SELECT id, name, email, officer_rank, department_id FROM users WHERE role = 'officer' AND (name ILIKE $1 OR email ILIKE $1) LIMIT $2`,
        [like, limit]
      ).then(r => ({ type: 'officer', results: r.rows }))
    );

    // Departments
    queries.push(
      db.query(`SELECT id, name, city, ward FROM departments WHERE name ILIKE $1 LIMIT $2`, [like, limit])
        .then(r => ({ type: 'department', results: r.rows }))
    );

    const results = await Promise.all(queries);
    const combined = {};
    for (const r of results) {
      combined[r.type] = [...(combined[r.type] || []), ...r.results];
    }

    res.json({ query: term, results: combined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { globalSearch };
