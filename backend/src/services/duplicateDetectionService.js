// ============================================================
// Duplicate Detection Service
// ------------------------------------------------------------
// Works standalone (no dependency on the ML microservice being up)
// using: geo distance (PostGIS ST_DWithin) + same category + a
// recent time window + Postgres trigram text similarity on title.
// This is the engine that powers "Master Complaint + linked reports"
// (feature request #6). Image-similarity is intentionally NOT
// implemented here — real perceptual-hash/embedding comparison needs
// a proper vector pipeline; see docs/ARCHITECTURE.md "Deferred".
// ============================================================
const db = require('../db');

const RADIUS_M       = parseFloat(process.env.DUPLICATE_RADIUS_METERS || 200);
const TIME_WINDOW_DAYS = parseInt(process.env.DUPLICATE_TIME_WINDOW_DAYS || '14', 10);
const TEXT_SIM_THRESHOLD = parseFloat(process.env.DUPLICATE_TEXT_SIMILARITY || '0.35');

/**
 * Look for an existing "master" complaint that this new report is
 * likely describing again. Returns the best match (or null).
 *
 * Score = 0.5 * text_similarity + 0.5 * proximity_score
 *   proximity_score = 1 - (distance_m / RADIUS_M), clamped to [0,1]
 */
async function findDuplicate({ title, description, category, latitude, longitude, ward_id }) {
  const { rows } = await db.query(
    `SELECT id, title, description, created_at,
            ST_Distance(geo_point, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance_m,
            similarity(title, $3) AS title_sim
       FROM complaints
      WHERE (is_master IS TRUE OR is_master IS NULL)
        AND status NOT IN ('closed','rejected')
        AND category = $4
        AND created_at >= NOW() - ($5 || ' days')::interval
        AND ST_DWithin(geo_point, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $6)
      ORDER BY distance_m ASC
      LIMIT 5`,
    [longitude, latitude, title, category, TIME_WINDOW_DAYS, RADIUS_M]
  );

  if (!rows.length) return null;

  let best = null;
  for (const row of rows) {
    const proximityScore = Math.max(0, 1 - row.distance_m / RADIUS_M);
    const textSim = row.title_sim ?? 0;
    const score = 0.5 * textSim + 0.5 * proximityScore;
    if (!best || score > best.score) {
      best = { id: row.id, score, distance_m: row.distance_m, title_sim: textSim };
    }
  }

  if (best && (best.score >= TEXT_SIM_THRESHOLD || best.distance_m < 30)) {
    return best;
  }
  return null;
}

/** Link a new report to an existing master complaint instead of creating a standalone one. */
async function linkAsDuplicate(masterId, newComplaintId) {
  await db.query(
    `UPDATE complaints SET duplicate_of = $1, is_master = FALSE, status = 'reported' WHERE id = $2`,
    [masterId, newComplaintId]
  );
  await db.query(
    `UPDATE complaints
        SET linked_report_count = linked_report_count + 1,
            priority_score = priority_score + 3,
            updated_at = NOW()
      WHERE id = $1`,
    [masterId]
  );

  const { maybeEscalateOnDuplicatePressure } = require('./escalationService');
  await maybeEscalateOnDuplicatePressure(masterId);
}

module.exports = { findDuplicate, linkAsDuplicate, RADIUS_M, TIME_WINDOW_DAYS };
