// ============================================================
// Audit Service
// ------------------------------------------------------------
// Append-only action log. Every write is a plain INSERT — there is
// intentionally no update/delete helper exported here, matching the
// "never delete audit logs" requirement.
// ============================================================
const db = require('../db');

/**
 * @param {Object} p
 * @param {string} p.action       e.g. 'complaint.status_changed'
 * @param {string} p.entityType   e.g. 'complaint' | 'officer' | 'auth'
 * @param {string|number} [p.entityId]
 * @param {Object} [p.actor]      req.user, if available
 * @param {Object} [p.metadata]   any extra JSON-serialisable context
 * @param {Object} [p.req]       Express req, used to pull IP if present
 */
async function logAction({ action, entityType, entityId = null, actor = null, metadata = null, req = null }) {
  try {
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor?.id || null, actor?.role || null, action, entityType, String(entityId ?? ''), metadata ? JSON.stringify(metadata) : null, ip]
    );
  } catch (err) {
    // Audit logging must never break the primary request flow.
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAction };
