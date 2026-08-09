"""
Tests for POST /analyze.

Run with: pytest ml-service/tests/test_analyze.py
Requires DATABASE_URL to point at a reachable Postgres (image_hashes
table from migration_006). Duplicate lookup fails soft (logs + returns
is_duplicate=False) if the DB is unreachable, so these tests still run
against a DB-less environment, just without duplicate coverage.
"""
import io
import os
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/civic_platform")
os.environ.setdefault("ML_MODE", "demo")

from app.main import app  # noqa: E402

client = TestClient(app)


def _make_image_bytes(width=1000, height=750, color=(90, 140, 200), fmt="JPEG", textured=True) -> bytes:
    if textured:
        # Add per-pixel noise so the image has real edge content everywhere
        # (not just in random sparse spots) — a perfectly flat solid color
        # has zero Laplacian variance and near-zero regional variance, which
        # is (correctly) flagged as blurry / screenshot-like by the real
        # detectors, so a sparse/uneven noise pattern would make this
        # fixture unrealistic for a "clear photo" test case.
        rng = __import__("random").Random(42)
        base = Image.new("RGB", (width, height), color=color)
        pixels = base.load()
        for y in range(height):
            for x in range(0, width, 3):  # every 3rd column, still dense enough for real variance
                jitter = rng.randint(-70, 70)
                r, g, b = pixels[x, y]
                pixels[x, y] = (
                    max(0, min(255, r + jitter)),
                    max(0, min(255, g + jitter)),
                    max(0, min(255, b + jitter)),
                )
        img = base
    else:
        img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=90)
    return buf.getvalue()


def test_analyze_success_clear_photo_with_gps():
    """A reasonably sized, non-screenshot-ratio, sharp-ish photo with
    GPS attached should not be hard-rejected — status is approved or
    review, never rejected, and the response shape is well-formed."""
    image_bytes = _make_image_bytes(1200, 900)

    response = client.post(
        "/analyze",
        files={"image": ("photo.jpg", image_bytes, "image/jpeg")},
        data={
            "latitude": "21.1458",
            "longitude": "79.0882",
            "accuracy": "12.5",
            "captured_at": "2026-07-19T10:00:00Z",
            "user_reputation": "1.0",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in ("approved", "review")
    assert 0 <= body["trust_score"] <= 100
    assert isinstance(body["top3"], list) and len(body["top3"]) >= 1
    assert body["issue_type"] in (
        "garbage", "pothole", "waterlogging", "streetlight",
        "sewage", "illegal_dumping", "road_damage", "other",
    )


def test_analyze_rejects_screenshot_like_upload_without_gps():
    """A 9:16 screen-ratio image with no GPS metadata and a tiny file
    size (screenshot-like) should score low enough to land in review
    or rejected, and rejection_reasons should be populated."""
    image_bytes = _make_image_bytes(1080, 1920, color=(245, 245, 245), fmt="PNG", textured=False)

    response = client.post(
        "/analyze",
        files={"image": ("screenshot.png", image_bytes, "image/png")},
        data={"user_reputation": "0.3"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in ("review", "rejected")
    assert len(body["rejection_reasons"]) >= 1


def test_analyze_rejects_undersized_file():
    """Below the 640x480 minimum resolution should fail file validation
    and surface in rejection_reasons even if trust score math would
    otherwise pass it."""
    image_bytes = _make_image_bytes(100, 80)

    response = client.post(
        "/analyze",
        files={"image": ("tiny.jpg", image_bytes, "image/jpeg")},
        data={"latitude": "21.1", "longitude": "79.0"},
    )

    assert response.status_code == 200
    body = response.json()
    assert any("Invalid file" in r for r in body["rejection_reasons"])
