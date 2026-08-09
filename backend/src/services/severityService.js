// ============================================================
// Severity Service
// ------------------------------------------------------------
// Rule-based severity estimation for image-verified complaints.
// area_ratio comes from a simple contour-segmentation estimate
// today (see TODO below); the rule shapes are ready to swap over
// to real YOLOv8 segmentation output without changing callers.
// ============================================================

/**
 * @param {Object} params
 * @param {string} params.issueType
 * @param {number} params.confidence     0-1
 * @param {number} [params.areaRatio]     0-1, estimated affected-area fraction
 * @returns {"CRITICAL"|"HIGH"|"MEDIUM"|"LOW"}
 */
function estimateSeverity({ issueType, confidence = 0, areaRatio = 0 }) {
  if (issueType === 'waterlogging' && confidence > 0.9) return 'CRITICAL';
  if (issueType === 'sewage') return 'CRITICAL';
  if (issueType === 'garbage' && areaRatio > 0.4) return 'HIGH';
  if (issueType === 'illegal_dumping' && areaRatio > 0.4) return 'HIGH';
  if (issueType === 'pothole' && areaRatio > 0.2) return 'HIGH';
  if (issueType === 'road_damage' && areaRatio > 0.2) return 'HIGH';
  if (issueType === 'streetlight') return 'MEDIUM';
  return 'LOW';
}

// TODO(YOLOv8 segmentation): replace this stub with a real affected-area
// ratio computed from a YOLOv8-seg mask over the uploaded image. For now
// we approximate using simple OpenCV contour area on the ML service side
// (ml-service can be extended to return `area_ratio` in /analyze's response);
// until then this defaults conservatively to 0 so severity falls back to
// the confidence/category-only rules above.
function estimateAreaRatioStub() {
  return 0;
}

module.exports = { estimateSeverity, estimateAreaRatioStub };
