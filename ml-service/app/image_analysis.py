"""
Image verification pipeline endpoint.

POST /analyze — accepts a multipart image + citizen-supplied metadata,
runs authenticity checks, duplicate detection, EfficientNet-B0
classification, and the trust-score engine, then returns a single
structured verdict the Node backend uses to approve / queue / reject
the complaint.

This is an additive router mounted onto the existing FastAPI app in
app/main.py via `app.include_router(image_analysis.router)` — the
existing text-based /ml/analyze-complaint endpoint is untouched.
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .services.authenticity import run_authenticity_checks
from .services.classifier import classify_image
from .services.duplicate import find_duplicate, store_hash
from .services.trust_score import compute_trust_score, build_rejection_reasons
from .utils.image_utils import load_image

router = APIRouter()


class AnalyzeResponse(BaseModel):
    status: str
    issue_type: Optional[str]
    confidence: float
    trust_score: int
    severity: str
    is_duplicate: bool
    is_blurry: bool
    is_screenshot: bool
    rejection_reasons: list[str]
    breakdown: dict
    top3: list


def _estimate_severity(issue_type: Optional[str], confidence: float) -> str:
    """Lightweight severity rule, mirrors backend/src/services/severityService.js
    so the ML service can return a first-pass severity even before the
    backend's own rule engine runs (backend value is authoritative)."""
    if issue_type in ("waterlogging",) and confidence > 0.9:
        return "CRITICAL"
    if issue_type == "sewage":
        return "CRITICAL"
    if issue_type in ("garbage", "pothole", "road_damage", "illegal_dumping"):
        return "HIGH"
    if issue_type == "streetlight":
        return "MEDIUM"
    return "LOW"


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(
    image: UploadFile = File(...),
    latitude: Optional[float] = Form(None),
    longitude: Optional[float] = Form(None),
    accuracy: Optional[float] = Form(None),
    captured_at: Optional[str] = Form(None),
    user_reputation: float = Form(1.0),
    complaint_temp_id: Optional[str] = Form(None),
):
    raw_bytes = await image.read()
    size_bytes = len(raw_bytes)

    try:
        img = load_image(raw_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    content_type = image.content_type or "application/octet-stream"

    # 1. Authenticity: file validation, blur, EXIF, screenshot
    auth = run_authenticity_checks(img, content_type, size_bytes)

    # 2. Duplicate detection (pHash + Hamming distance vs stored hashes)
    dup = await run_in_threadpool(find_duplicate, img)

    # 3. Classification (EfficientNet-B0 / demo fallback)
    classification = classify_image(img)

    # 4. GPS availability — from citizen-supplied metadata, not EXIF,
    #    since mobile browsers strip EXIF GPS but the frontend captures
    #    navigator.geolocation separately (see NewComplaint.jsx patch).
    gps_available = latitude is not None and longitude is not None

    # 5. Trust score
    trust = compute_trust_score(
        ml_confidence=classification["confidence"],
        gps_available=gps_available,
        exif_present=auth["exif"]["exif_present"],
        is_blurry=auth["blur"]["is_blurry"],
        is_duplicate=dup["is_duplicate"],
        is_screenshot=auth["screenshot"]["is_screenshot"],
        is_edited=auth["exif"]["is_edited"],
        user_reputation=user_reputation,
    )

    reasons = build_rejection_reasons(
        is_blurry=auth["blur"]["is_blurry"],
        is_duplicate=dup["is_duplicate"],
        is_screenshot=auth["screenshot"]["is_screenshot"],
        screenshot_reason=auth["screenshot"]["reason"],
        is_edited=auth["exif"]["is_edited"],
        editor_match=auth["exif"]["editor_match"],
        gps_available=gps_available,
        file_valid=auth["file_valid"],
        file_reason=auth["file_reason"],
    )

    severity = _estimate_severity(classification["issue_type"], classification["confidence"])

    # Only persist the new hash if the image wasn't rejected outright —
    # avoids polluting the duplicate index with junk/invalid uploads.
    if trust["status"] != "rejected":
        await run_in_threadpool(store_hash, dup["phash"], complaint_temp_id, None)

    return AnalyzeResponse(
        status=trust["status"],
        issue_type=classification["issue_type"],
        confidence=classification["confidence"],
        trust_score=trust["trust_score"],
        severity=severity,
        is_duplicate=dup["is_duplicate"],
        is_blurry=auth["blur"]["is_blurry"],
        is_screenshot=auth["screenshot"]["is_screenshot"],
        rejection_reasons=reasons,
        breakdown=trust["breakdown"],
        top3=classification["top3"],
    )
