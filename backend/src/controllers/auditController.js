const db = require('../db');

// ── GET /admin/audit-logs ────────────────────────────────────
const listAuditLogs = async (req, res) => {
  const { entity_type, entity_id, actor_id, action, from_date, to_date, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (entity_type) { conditions.push(`entity_type = $${idx++}`); values.push(entity_type); }
  if (entity_id)   { conditions.push(`entity_id = $${idx++}`);   values.push(String(entity_id)); }
  if (actor_id)    { conditions.push(`actor_id = $${idx++}`);    values.push(actor_id); }
  if (action)      { conditions.push(`action = $${idx++}`);      values.push(action); }
  if (from_date)   { conditions.push(`created_at >= $${idx++}`); values.push(from_date); }
  if (to_date)     { conditions.push(`created_at <= $${idx++}::date + 1`); values.push(to_date); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await db.query(
      `SELECT al.*, u.name AS actor_name FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_id
         ${where}
        ORDER BY al.created_at DESC
        LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );
    const count = await db.query(`SELECT COUNT(*) FROM audit_logs ${where}`, values);
    res.json({ logs: rows, total: parseInt(count.rows[0].count), page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { listAuditLogs };
