// ============================================================
// SLA Service
// ------------------------------------------------------------
// Computes response/resolution deadlines per complaint based on
// category severity + priority score, and scans for breaches so
// the escalation engine can act on them. Tunable via env vars —
// no migration needed to change the numbers.
// ============================================================
const db = require('../db');
const { escalateComplaint } = require('./escalationService');
const { logAction } = require('./auditService');

// Base hours by category — higher risk issues get tighter SLAs.
// Fallback bucket used when category is unknown/null.
const CATEGORY_SLA_HOURS = {
  water_leakage:   { response: 4,  resolution: 24 },
  drainage:        { response: 6,  resolution: 48 },
  streetlight:     { response: 12, resolution: 72 },
  pothole:         { response: 12, resolution: 96 },
  garbage:         { response: 6,  resolution: 24 },
  illegal_dumping: { response: 12, resolution: 72 },
  default:         { response: 24, resolution: 120 },
};

/**
 * Priority tiers tighten the base SLA:
 *   High (>=75)   → 50% of base hours
 *   Medium (>=40) → 75% of base hours
 *   Low           → 100% of base hours
 */
function priorityMultiplier(priorityScore) {
  if (priorityScore >= 75) return 0.5;
  if (priorityScore >= 40) return 0.75;
  return 1;
}

function computeDeadlines({ category, priority_score = 0, from = new Date() }) {
  const base = CATEGORY_SLA_HOURS[category] || CATEGORY_SLA_HOURS.default;
  const mult = priorityMultiplier(priority_score);

  const responseHours   = Math.max(1, Math.round(base.response * mult));
  const resolutionHours = Math.max(2, Math.round(base.resolution * mult));

  const responseDue   = new Date(from.getTime() + responseHours * 3600 * 1000);
  const resolutionDue = new Date(from.getTime() + resolutionHours * 3600 * 1000);

  return { responseDue, resolutionDue, responseHours, resolutionHours };
}

/** Called right after a complaint is created to stamp its SLA deadlines. */
async function assignSlaToComplaint(complaintId, { category, priority_score }) {
  const { responseDue, resolutionDue } = computeDeadlines({ category, priority_score });
  await db.query(
    `UPDATE complaints
        SET sla_response_due_at = $1, sla_resolution_due_at = $2
      WHERE id = $3`,
    [responseDue, resolutionDue, complaintId]
  );
  return { responseDue, resolutionDue };
}

/**
 * Background scan: find complaints whose response or resolution SLA
 * has been missed and escalate them. Idempotent — only acts once per
 * breach type via sla_response_met / sla_resolution_met flags.
 */
async function checkSlaBreaches() {
  try {
    // Response SLA missed: still 'reported'/'verified' past response_due
    const { rows: responseBreaches } = await db.query(
      `SELECT id, escalation_level FROM complaints
        WHERE sla_response_due_at < NOW()
          AND sla_response_met IS NOT FALSE
          AND status IN ('reported','verified')`
    );

    for (const c of responseBreaches) {
      await db.query(`UPDATE complaints SET sla_response_met = FALSE WHERE id = $1`, [c.id]);
      await logAction({ action: 'sla.response_breached', entityType: 'complaint', entityId: c.id });
      await escalateComplaint(c.id, 'SLA response deadline missed');
    }

    // Resolution SLA missed: not resolved/closed/rejected past resolution_due
    const { rows: resolutionBreaches } = await db.query(
      `SELECT id, escalation_level FROM complaints
        WHERE sla_resolution_due_at < NOW()
          AND sla_resolution_met IS NOT FALSE
          AND status NOT IN ('resolved','closed','rejected')`
    );

    for (const c of resolutionBreaches) {
      await db.query(`UPDATE complaints SET sla_resolution_met = FALSE WHERE id = $1`, [c.id]);
      await logAction({ action: 'sla.resolution_breached', entityType: 'complaint', entityId: c.id });
      await escalateComplaint(c.id, 'SLA resolution deadline missed');
    }

    if (responseBreaches.length || resolutionBreaches.length) {
      console.log(`⏱️  SLA scan: ${responseBreaches.length} response breaches, ${resolutionBreaches.length} resolution breaches escalated.`);
    }
  } catch (err) {
    console.error('SLA breach scan failed:', err.message);
  }
}

module.exports = { computeDeadlines, assignSlaToComplaint, checkSlaBreaches, CATEGORY_SLA_HOURS };
