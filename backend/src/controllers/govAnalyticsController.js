const db = require('../db');
const {
  computeWardHealth, computeAllWardsHealth,
  computeDepartmentEfficiency, computeHotspots, computeCitizenTrustScore,
} = require('../services/civicHealthService');

// ── GET /analytics/civic-health ───────────────────────────────
const getCivicHealthIndex = async (req, res) => {
  try {
    if (req.query.ward_id) {
      const result = await computeWardHealth(req.query.ward_id);
      return res.json(result);
    }
    const results = await computeAllWardsHealth();
    res.json({ wards: results, city_avg: results.length ? Math.round((results.reduce((s, w) => s + w.health_score, 0) / results.length) * 10) / 10 : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /analytics/civic-health/history?ward_id= ──────────────
const getCivicHealthHistory = async (req, res) => {
  const { ward_id, limit = 30 } = req.query;
  if (!ward_id) return res.status(400).json({ error: 'ward_id is required' });
  try {
    const { rows } = await db.query(
      `SELECT * FROM ward_health_snapshots WHERE ward_id = $1 ORDER BY computed_at DESC LIMIT $2`,
      [ward_id, limit]
    );
    res.json({ history: rows.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /analytics/department-efficiency ──────────────────────
const getDepartmentEfficiency = async (req, res) => {
  try {
    if (req.query.department_id) {
      const result = await computeDepartmentEfficiency(req.query.department_id);
      return res.json(result);
    }
    const depts = await db.query(`SELECT id, name FROM departments ORDER BY name`);
    const results = [];
    for (const d of depts.rows) {
      const eff = await computeDepartmentEfficiency(d.id);
      results.push({ department_name: d.name, ...eff });
    }
    res.json({ departments: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /analytics/hotspots ────────────────────────────────────
const getHotspots = async (req, res) => {
  try {
    const { min_occurrences, city_id } = req.query;
    const hotspots = await computeHotspots({
      minOccurrences: min_occurrences ? parseInt(min_occurrences) : undefined,
      cityId: city_id || null,
    });
    res.json({ hotspots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /analytics/trust-score ─────────────────────────────────
const getTrustScore = async (req, res) => {
  try {
    const result = await computeCitizenTrustScore();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /analytics/export.csv ──────────────────────────────────
// Lightweight CSV export (opens directly in Excel/Sheets) — kept
// dependency-free on purpose; a binary PDF/XLSX exporter can be
// layered on later (see docs/ARCHITECTURE.md "Deferred").
const exportComplaintsCsv = async (req, res) => {
  const { city_id, ward_id, from_date, to_date, status } = req.query;
  const conditions = [];
  const values = [];
  let idx = 1;
  if (city_id)   { conditions.push(`city_id = $${idx++}`);   values.push(city_id); }
  if (ward_id)   { conditions.push(`ward_id = $${idx++}`);   values.push(ward_id); }
  if (status)    { conditions.push(`status = $${idx++}`);    values.push(status); }
  if (from_date) { conditions.push(`created_at >= $${idx++}`); values.push(from_date); }
  if (to_date)   { conditions.push(`created_at <= $${idx++}::date + 1`); values.push(to_date); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await db.query(
      `SELECT id, title, category, status, priority_score, ward, city,
              assigned_department_id, escalation_level, created_at, closed_at
         FROM complaints ${where} ORDER BY created_at DESC LIMIT 20000`,
      values
    );

    const header = ['id', 'title', 'category', 'status', 'priority_score', 'ward', 'city', 'department_id', 'escalation_level', 'created_at', 'closed_at'];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(header.map((h) => escape(r[h === 'department_id' ? 'assigned_department_id' : h])).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="complaints_export.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getCivicHealthIndex, getCivicHealthHistory, getDepartmentEfficiency,
  getHotspots, getTrustScore, exportComplaintsCsv,
};
