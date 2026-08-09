// ============================================================
// Geo-Routing Service
// ------------------------------------------------------------
// Resolves a lat/lng into the ward polygon that contains it, using
// the `wards` table added in db/migration_006_image_verification.sql
// (distinct from the existing free-text complaints.ward/ward_id
// columns, which come from reverse-geocoding — see geocodingService.js).
// ============================================================
const db = require('../db');

/**
 * Find the ward polygon containing a given point, plus its
 * department and officer contact for auto-routing.
 * Returns null if no ward polygon contains the point.
 */
async function findWard(lat, lng) {
  const { rows } = await db.query(
    `SELECT id, name, department, officer_email
       FROM wards
      WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      LIMIT 1`,
    [lng, lat]
  );
  return rows[0] || null;
}

/**
 * Fallback: nearest ward centroid within a radius, used when the point
 * falls just outside any polygon (e.g. GPS drift near a boundary).
 */
async function findNearestWard(lat, lng, radiusMeters = 300) {
  const { rows } = await db.query(
    `SELECT id, name, department, officer_email,
            ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
       FROM wards
      WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
      ORDER BY distance_m ASC
      LIMIT 1`,
    [lng, lat, radiusMeters]
  );
  return rows[0] || null;
}

/** Combined lookup used by the image-verification pipeline. */
async function resolveWard(lat, lng) {
  const exact = await findWard(lat, lng);
  if (exact) return { ...exact, match_type: 'contains' };

  const nearest = await findNearestWard(lat, lng);
  if (nearest) return { ...nearest, match_type: 'nearest' };

  return null;
}

module.exports = { findWard, findNearestWard, resolveWard };
