"""
Screenshot detection — heuristic, not a trained classifier.

Signals combined:
  1. Exact 9:16 / 16:9 (or very close to it) aspect ratio — phone
     screenshots are almost always screen-native ratios.
  2. Missing EXIF entirely — camera photos carry EXIF, screenshots don't.
  3. Suspiciously small file size for the given resolution.
  4. A simple top/bottom strip brightness-uniformity check standing in
     for "status bar / battery icon" detection — status bars tend to be
     a flat-color strip quite unlike a photographed real-world scene.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

SCREEN_RATIOS = [9 / 16, 16 / 9, 9 / 19.5, 19.5 / 9]
RATIO_TOLERANCE = 0.015


def _matches_screen_ratio(w: int, h: int) -> bool:
    ratio = w / h
    return any(abs(ratio - r) < RATIO_TOLERANCE for r in SCREEN_RATIOS)


def _status_bar_strip_detected(img: Image.Image) -> bool:
    """Crude heuristic: check if the top 4% of the image is unusually
    flat/uniform in color, which is typical of a phone status bar and
    very atypical of an outdoor/civic-issue photo."""
    w, h = img.size
    strip_h = max(1, int(h * 0.04))
    top_strip = np.array(img.convert("L").crop((0, 0, w, strip_h)), dtype=np.float64)
    if top_strip.size == 0:
        return False
    std_dev = float(top_strip.std())
    return std_dev < 12.0  # very low variance == near-flat color band


def detect_screenshot(img: Image.Image, size_bytes: int, exif_present: bool) -> dict:
    w, h = img.size
    reasons = []

    ratio_hit = _matches_screen_ratio(w, h)
    if ratio_hit:
        reasons.append("screen_native_aspect_ratio")

    if not exif_present:
        reasons.append("missing_exif")

    bytes_per_pixel = size_bytes / max(1, (w * h))
    if bytes_per_pixel < 0.08:
        reasons.append("unusually_small_filesize")

    if _status_bar_strip_detected(img):
        reasons.append("status_bar_detected")

    # Require at least 2 corroborating signals to call it a screenshot —
    # any single signal alone (e.g. missing EXIF) is too weak on its own.
    is_screenshot = len(reasons) >= 2

    return {
        "is_screenshot": is_screenshot,
        "reason": reasons[0] if reasons else None,
        "all_signals": reasons,
    }
