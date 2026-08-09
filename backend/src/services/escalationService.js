// ============================================================
// Escalation Service
// ------------------------------------------------------------
// Escalation hierarchy: officer -> senior_officer -> department_head
// -> commissioner. Triggered by: SLA breach, no officer accepting an
// assignment in time, citizen reopening a complaint, or a complaint
// crossing a duplicate-report threshold (public pressure signal).
// ============================================================
const db = require('../db');

const HIERARCHY = ['officer', 'senior_officer', 'department_head', 'commissioner'];

/**
 * Find the next-tier officer in the same department to hand a complaint to.
 * Falls back to the department's designated head/commissioner contacts
 * (departments.head_id / commissioner_id) when no ranked officer exists.
 */
async function findNextTierAssignee(departmentId, currentLevel) {
  const nextRank = HIERARCHY[Math.min(currentLevel + 1, HIERARCHY.length - 1)];

  const { rows } = await db.query(
    `SELECT id, name, officer_rank FROM users
      WHERE department_id = $1 AND officer_rank = $2
      ORDER BY is_available DESC
      LIMIT 1`,
    [departmentId, nextRank]
  );
  if (rows.length) return rows[0];

  // Fallback to department's designated contacts
  const dept = await db.query(
    `SELECT head_id, commissioner_id FROM departments WHERE id = $1`,
    [departmentId]
  );
  if (!dept.rows.length) return null;

  const fallbackId = nextRank === 'commissioner'
    ? dept.rows[0].commissioner_id
    : dept.rows[0].head_id;

  if (!fallbackId) return null;
  const user = await db.query(`SELECT id, name, officer_rank FROM users WHERE id = $1`, [fallbackId]);
  return user.rows[0] || null;
}

/**
 * Escalate a complaint one level up the hierarchy and record why.
 * Safe to call repeatedly — caps at the top of the hierarchy (commissioner).
 */
async function escalateComplaint(complaintId, reason) {
  const { logAction } = require('./auditService');
  const { notifyEscalation } = require('../controllers/notificationController');

  const { rows } = await db.query(
    `SELECT id, escalation_level, assigned_department_id, assigned_officer_id
       FROM complaints WHERE id = $1`,
    [complaintId]
  );
  if (!rows.length) return null;
  const complaint = rows[0];

  if (complaint.escalation_level >= HIERARCHY.length - 1) {
    return { escalated: false, message: 'Already at top of escalation hierarchy (commissioner).' };
  }

  const nextLevel = complaint.escalation_level + 1;
  let assignee = null;

  if (complaint.assigned_department_id) {
    assignee = await findNextTierAssignee(complaint.assigned_department_id, complaint.escalation_level);
  }

  await db.query(
    `UPDATE complaints
        SET escalation_level = $1,
            escalated_at = NOW(),
            escalated_to = $2,
            escalation_reason = $3,
            assigned_officer_id = COALESCE($2, assigned_officer_id),
            updated_at = NOW()
      WHERE id = $4`,
    [nextLevel, assignee?.id || null, reason, complaintId]
  );

  await db.query(
    `INSERT INTO status_history (complaint_id, status, remarks)
     VALUES ($1, (SELECT status FROM complaints WHERE id = $1),
             $2)`,
    [complaintId, `Escalated to ${HIERARCHY[nextLevel]}${assignee ? ` (${assignee.name})` : ''}: ${reason}`]
  );

  await logAction({
    action: 'complaint.escalated',
    entityType: 'complaint',
    entityId: complaintId,
    metadata: { level: HIERARCHY[nextLevel], reason, assignee_id: assignee?.id || null },
  });

  notifyEscalation(complaintId, HIERARCHY[nextLevel], reason).catch(() => {});

  try {
    const { emitComplaintEscalated } = require('../realtime/socket');
    emitComplaintEscalated(complaintId, HIERARCHY[nextLevel], reason);
  } catch (sockErr) {
    console.warn('Socket emit skipped:', sockErr.message);
  }

  return { escalated: true, level: HIERARCHY[nextLevel], assignee };
}

/** Duplicate-pressure trigger: escalate once linked reports cross a threshold. */
async function maybeEscalateOnDuplicatePressure(masterComplaintId) {
  const THRESHOLD = parseInt(process.env.DUPLICATE_ESCALATION_THRESHOLD || '5', 10);
  const { rows } = await db.query(
    `SELECT linked_report_count, escalation_level FROM complaints WHERE id = $1`,
    [masterComplaintId]
  );
  if (!rows.length) return;
  if (rows[0].linked_report_count >= THRESHOLD && rows[0].escalation_level === 0) {
    await escalateComplaint(masterComplaintId, `${rows[0].linked_report_count} duplicate reports received — high public impact`);
  }
}

module.exports = { HIERARCHY, escalateComplaint, findNextTierAssignee, maybeEscalateOnDuplicatePressure };
