"""
Trust score engine — weighted 0-100 score combining every signal
gathered by the authenticity + classifier + duplicate services.

Weights (sum to 100):
  ML confidence      : 40
  GPS available      : 15
  EXIF camera data   : 10
  Not blurry         : 10
  Not duplicate      : 15
  User reputation    : 10

Policy:
  >= 80        -> approved
  60-79        -> review
  <  60        -> rejected
"""
from __future__ import annotations

APPROVE_THRESHOLD = 80
REVIEW_THRESHOLD = 60

WEIGHTS = {
    "ml": 40,
    "gps": 15,
    "exif": 10,
    "blur": 10,
    "duplicate": 15,
    "reputation": 10,
}


def compute_trust_score(
    ml_confidence: float,
    gps_available: bool,
    exif_present: bool,
    is_blurry: bool,
    is_duplicate: bool,
    is_screenshot: bool,
    is_edited: bool,
    user_reputation: float = 1.0,
) -> dict:
    """
    user_reputation is expected in [0, 1] (e.g. 1.0 = clean history,
    lower for users with past rejected/flagged uploads).
    """
    breakdown = {
        "ml":         round(WEIGHTS["ml"] * max(0.0, min(1.0, ml_confidence)), 2),
        "gps":        WEIGHTS["gps"] if gps_available else 0,
        "exif":       WEIGHTS["exif"] if exif_present else 0,
        "blur":       0 if is_blurry else WEIGHTS["blur"],
        "duplicate":  0 if is_duplicate else WEIGHTS["duplicate"],
        "reputation": round(WEIGHTS["reputation"] * max(0.0, min(1.0, user_reputation)), 2),
    }

    trust_score = round(sum(breakdown.values()))

    # Hard penalties that override the weighted sum for clearly bad signals
    if is_screenshot:
        trust_score = min(trust_score, 45)
    if is_edited:
        trust_score = max(0, trust_score - 20)

    trust_score = max(0, min(100, trust_score))

    if trust_score >= APPROVE_THRESHOLD:
        status = "approved"
    elif trust_score >= REVIEW_THRESHOLD:
        status = "review"
    else:
        status = "rejected"

    return {
        "trust_score": trust_score,
        "breakdown": breakdown,
        "status": status,
    }


def build_rejection_reasons(
    is_blurry: bool,
    is_duplicate: bool,
    is_screenshot: bool,
    screenshot_reason: str | None,
    is_edited: bool,
    editor_match: str | None,
    gps_available: bool,
    file_valid: bool,
    file_reason: str,
) -> list[str]:
    """Human-readable reasons, used for both rejected and review statuses."""
    reasons = []
    if not file_valid:
        reasons.append(f"Invalid file: {file_reason}")
    if is_blurry:
        reasons.append("Image is too blurry to verify the issue clearly.")
    if is_duplicate:
        reasons.append("This image appears to match a previously submitted photo.")
    if is_screenshot:
        reasons.append(f"Image looks like a screenshot ({screenshot_reason or 'heuristic match'}), not a live photo.")
    if is_edited:
        reasons.append(f"Image metadata shows it was edited in {editor_match or 'a photo editor'}.")
    if not gps_available:
        reasons.append("No GPS location was attached to this photo.")
    return reasons
