"""
Authenticity pipeline: blur detection + file validation + EXIF +
screenshot heuristics, combined into one structured result the
trust-score engine consumes.
"""
from __future__ import annotations

from PIL import Image

from ..utils.image_utils import laplacian_variance, validate_file
from .exif_checker import check_exif
from .screenshot_detector import detect_screenshot

BLUR_VARIANCE_THRESHOLD = 100.0


def check_blur(img: Image.Image) -> dict:
    variance = laplacian_variance(img)
    return {
        "is_blurry": variance < BLUR_VARIANCE_THRESHOLD,
        "laplacian_variance": round(variance, 2),
        "threshold": BLUR_VARIANCE_THRESHOLD,
    }


def run_authenticity_checks(img: Image.Image, content_type: str, size_bytes: int) -> dict:
    """
    Returns a combined structured result:
    {
      "file_valid": bool, "file_reason": str,
      "blur": {...}, "exif": {...}, "screenshot": {...}
    }
    """
    file_valid, file_reason = validate_file(content_type, size_bytes, img)
    blur = check_blur(img)
    exif = check_exif(img)
    screenshot = detect_screenshot(img, size_bytes, exif["exif_present"])

    return {
        "file_valid": file_valid,
        "file_reason": file_reason,
        "blur": blur,
        "exif": exif,
        "screenshot": screenshot,
    }
