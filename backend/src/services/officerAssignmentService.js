// ============================================================
// Officer Assignment Service
// ------------------------------------------------------------
// Picks the least-loaded available officer in a department for a
// new assignment, respecting each officer's max_active_complaints.
// ============================================================
const db = require('../db');

async function getOfficerWorkload(officerId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS active_count
       FROM complaints
      WHERE assigned_officer_id = $1
        AND status NOT IN ('resolved','closed','rejected')`,
    [officerId]
  );
  return parseInt(rows[0].active_count) || 0;
}

/** Finds the best available officer in a department to assign a new complaint to. */
async function findLeastLoadedOfficer(departmentId) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.max_active_complaints,
            COUNT(c.id) FILTER (WHERE c.status NOT IN ('resolved','closed','rejected')) AS active_count
       FROM users u
       LEFT JOIN complaints c ON c.assigned_officer_id = u.id
      WHERE u.department_id = $1
        AND u.role = 'officer'
        AND u.officer_rank = 'officer'
        AND u.is_available = TRUE
      GROUP BY u.id, u.name, u.max_active_complaints
     HAVING COUNT(c.id) FILTER (WHERE c.status NOT IN ('resolved','closed','rejected')) < u.max_active_complaints
      ORDER BY active_count ASC
      LIMIT 1`,
    [departmentId]
  );
  return rows[0] || null;
}

module.exports = { getOfficerWorkload, findLeastLoadedOfficer };
