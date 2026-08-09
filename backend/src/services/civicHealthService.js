// ============================================================
// Civic Health Service
// ------------------------------------------------------------
// Original, rule-based (no ML/AI API) scoring engines that make this
// platform more than a complaint tracker:
//   - Civic Health Index        (per ward, 0-100, higher = healthier)
//   - Department Efficiency Score
//   - Recurring Civic Hotspots  (rule-based pattern detection)
//   - Citizen Trust Score       (system-wide metric, not personal)
// All formulas are transparent and documented inline so they can be
// tuned without touching call sites.
// ============================================================
const db = require('../db');

// ── Civic Health Index ───────────────────────────────────────
// health_score = 100
//   - (pending_ratio        * 30)   fewer pending complaints is healthier
//   - (escalation_rate      * 25)   fewer escalations is healthier
//   + (participation_bonus  * 15)   more community verification is healthier
//   - (density_penalty      * 30)   normalised complaint density vs. city avg
async function computeWardHealth(wardId) {
  const { rows } = await db.query(
    `SELECT
        COUNT(*)                                                    AS total,
        SUM(CASE WHEN status NOT IN ('resolved','closed','rejected') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN escalation_level > 0 THEN 1 ELSE 0 END)       AS escalated,
        ROUND(AVG(EXTRACT(EPOCH FROM (
          COALESCE(closed_at, NOW()) - created_at)) / 3600)::numeric, 1)      AS avg_hours,
        COALESCE(SUM(linked_report_count), 0)                       AS duplicate_reports
       FROM complaints
      WHERE ward_id = $1`,
    [wardId]
  );

  const votes = await db.query(
    `SELECT COUNT(DISTINCT v.user_id) AS voters
       FROM votes v JOIN complaints c ON c.id = v.complaint_id
      WHERE c.ward_id = $1`,
    [wardId]
  );

  const cityAvgDensity = await db.query(
    `SELECT AVG(cnt) AS avg_density FROM (
       SELECT ward_id, COUNT(*) AS cnt FROM complaints WHERE ward_id IS NOT NULL GROUP BY ward_id
     ) t`
  );

  const r = rows[0];
  const total = parseInt(r.total) || 0;
  if (total === 0) {
    return { ward_id: wardId, health_score: 100, total: 0, pending: 0, escalation_rate: 0, participation_rate: 0, complaint_density: 0, avg_resolution_hours: null };
  }

  const pendingRatio    = (parseInt(r.pending) || 0) / total;
  const escalationRate  = (parseInt(r.escalated) || 0) / total;
  const participation   = Math.min(1, (parseInt(votes.rows[0].voters) || 0) / total);
  const avgDensity      = parseFloat(cityAvgDensity.rows[0].avg_density) || total;
  const densityPenalty  = Math.min(1, total / (avgDensity * 1.5 || 1)) - 1 >= 0
    ? Math.min(1, total / (avgDensity * 1.5))
    : Math.max(0, (total - avgDensity) / (avgDensity || 1));

  let score = 100
    - pendingRatio * 30
    - escalationRate * 25
    + participation * 15
    - Math.min(1, Math.max(0, densityPenalty)) * 30;

  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  return {
    ward_id: wardId,
    total,
    pending: parseInt(r.pending) || 0,
    escalation_rate: Math.round(escalationRate * 1000) / 10,     // %
    participation_rate: Math.round(participation * 1000) / 10,   // %
    complaint_density: total,
    avg_resolution_hours: r.avg_hours ? parseFloat(r.avg_hours) : null,
    health_score: score,
  };
}

async function computeAllWardsHealth() {
  const { rows } = await db.query(
    `SELECT DISTINCT ward_id, ward FROM complaints WHERE ward_id IS NOT NULL`
  );
  const results = [];
  for (const w of rows) {
    const health = await computeWardHealth(w.ward_id);
    results.push({ ward: w.ward, ...health });
  }
  return results.sort((a, b) => a.health_score - b.health_score); // worst first
}

/** Persist a snapshot for trend charts (called by the daily scheduler). */
async function snapshotAllWards() {
  const wards = await computeAllWardsHealth();
  for (const w of wards) {
    await db.query(
      `INSERT INTO ward_health_snapshots
         (ward_id, ward, complaint_density, avg_resolution_hours, participation_rate, escalation_rate, pending_count, health_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [w.ward_id, w.ward, w.complaint_density, w.avg_resolution_hours, w.participation_rate, w.escalation_rate, w.pending, w.health_score]
    );
  }
  return wards.length;
}

// ── Department Efficiency Score ──────────────────────────────
// efficiency = 100
//   - (avg_response_hours_ratio  * 25)
//   - (avg_resolution_hours_ratio * 25)
//   - (escalation_rate            * 25)
//   + (sla_compliance_rate        * 25)
async function computeDepartmentEfficiency(departmentId) {
  const { rows } = await db.query(
    `SELECT
        COUNT(*)                                                                 AS total,
        SUM(CASE WHEN escalation_level > 0 THEN 1 ELSE 0 END)                    AS escalated,
        SUM(CASE WHEN sla_response_met = TRUE THEN 1 ELSE 0 END)                 AS resp_met,
        SUM(CASE WHEN sla_response_met = FALSE THEN 1 ELSE 0 END)                AS resp_breached,
        SUM(CASE WHEN sla_resolution_met = TRUE THEN 1 ELSE 0 END)               AS res_met,
        SUM(CASE WHEN sla_resolution_met = FALSE THEN 1 ELSE 0 END)              AS res_breached,
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(closed_at, NOW()) - created_at))/3600)::numeric,1) AS avg_hours
       FROM complaints WHERE assigned_department_id = $1`,
    [departmentId]
  );

  const feedbackAvg = await db.query(
    `SELECT ROUND(AVG(f.rating)::numeric, 2) AS avg_rating
       FROM feedback f
       JOIN complaints c ON c.id = f.complaint_id
      WHERE c.assigned_department_id = $1`,
    [departmentId]
  );

  const r = rows[0];
  const total = parseInt(r.total) || 0;
  if (total === 0) return { department_id: departmentId, efficiency_score: null, total: 0 };

  const escalationRate = (parseInt(r.escalated) || 0) / total;
  const slaTotal = (parseInt(r.resp_met) || 0) + (parseInt(r.resp_breached) || 0) +
                   (parseInt(r.res_met) || 0) + (parseInt(r.res_breached) || 0);
  const slaCompliance = slaTotal > 0
    ? ((parseInt(r.resp_met) || 0) + (parseInt(r.res_met) || 0)) / slaTotal
    : 0.5; // neutral until enough SLA data exists

  // Normalise avg resolution hours against a 96h reference window
  const hoursRatio = Math.min(1, (parseFloat(r.avg_hours) || 0) / 96);

  let score = 100
    - hoursRatio * 25
    - escalationRate * 25
    + slaCompliance * 25
    - Math.min(1, escalationRate) * 0; // escalationRate already counted once by design (kept explicit for clarity)

  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  return {
    department_id: departmentId,
    total,
    avg_resolution_hours: r.avg_hours ? parseFloat(r.avg_hours) : null,
    escalation_rate: Math.round(escalationRate * 1000) / 10,
    sla_compliance_rate: Math.round(slaCompliance * 1000) / 10,
    avg_citizen_rating: feedbackAvg.rows[0].avg_rating ? parseFloat(feedbackAvg.rows[0].avg_rating) : null,
    efficiency_score: score,
  };
}

// ── Recurring Civic Hotspots (rule-based, no ML) ─────────────
// Groups nearby complaints (rounded lat/lng grid ~ 100m cells) that
// recur across multiple distinct time windows — a genuinely
// "recurring" spot, not just one bad week.
async function computeHotspots({ minOccurrences = 3, cityId = null } = {}) {
  const params = [];
  let where = '';
  if (cityId) { where = 'WHERE city_id = $1'; params.push(cityId); }

  const { rows } = await db.query(
    `SELECT
        ROUND(latitude::numeric, 3)  AS grid_lat,
        ROUND(longitude::numeric, 3) AS grid_lng,
        category,
        COUNT(*)                      AS occurrences,
        COUNT(DISTINCT DATE_TRUNC('month', created_at)) AS distinct_months,
        MAX(created_at)               AS last_reported,
        ARRAY_AGG(id ORDER BY created_at DESC) AS complaint_ids,
        AVG(latitude)  AS avg_lat,
        AVG(longitude) AS avg_lng
       FROM complaints
       ${where}
       GROUP BY grid_lat, grid_lng, category
      HAVING COUNT(*) >= $${params.length + 1} AND COUNT(DISTINCT DATE_TRUNC('month', created_at)) >= 2
      ORDER BY occurrences DESC
      LIMIT 25`,
    [...params, minOccurrences]
  );

  return rows.map(r => ({
    category: r.category,
    occurrences: parseInt(r.occurrences),
    distinct_months: parseInt(r.distinct_months),
    last_reported: r.last_reported,
    latitude: parseFloat(r.avg_lat),
    longitude: parseFloat(r.avg_lng),
    complaint_ids: r.complaint_ids.slice(0, 10),
    label: 'Recurring Civic Hotspot',
  }));
}

// ── Citizen Trust Score (system-wide metric, not personal scoring) ──
async function computeCitizenTrustScore() {
  const { rows } = await db.query(
    `SELECT
        COUNT(*)                                                     AS total,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END)          AS rejected,
        SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) AS resolved
       FROM complaints`
  );
  const comments = await db.query(
    `SELECT COUNT(*) AS confirmations FROM complaint_comments WHERE is_confirmation = TRUE`
  );
  const feedbackAvg = await db.query(`SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating FROM feedback`);

  const r = rows[0];
  const total = parseInt(r.total) || 0;
  if (total === 0) return { trust_score: null, total: 0 };

  const falseReportRate = (parseInt(r.rejected) || 0) / total;
  const resolvedRate    = (parseInt(r.resolved) || 0) / total;
  const verificationRate = Math.min(1, (parseInt(comments.rows[0].confirmations) || 0) / total);
  const avgRating = parseFloat(feedbackAvg.rows[0].avg_rating) || 3; // neutral default on 1-5 scale

  const score = Math.max(0, Math.min(100, Math.round(
    (resolvedRate * 40 + verificationRate * 25 + (avgRating / 5) * 25 - falseReportRate * 20 + 20) * 10
  ) / 10));

  return {
    total,
    resolved_rate: Math.round(resolvedRate * 1000) / 10,
    false_report_rate: Math.round(falseReportRate * 1000) / 10,
    verification_rate: Math.round(verificationRate * 1000) / 10,
    avg_citizen_feedback: feedbackAvg.rows[0].avg_rating ? avgRating : null,
    trust_score: score,
  };
}

module.exports = {
  computeWardHealth, computeAllWardsHealth, snapshotAllWards,
  computeDepartmentEfficiency, computeHotspots, computeCitizenTrustScore,
};
