"""
Shared image-handling utilities for the image-verification pipeline.
Kept dependency-light: numpy + OpenCV + Pillow only.
"""
from __future__ import annotations

import io
from typing import Tuple

import numpy as np
from PIL import Image

try:
    import cv2
    HAS_CV2 = True
except ImportError:  # pragma: no cover - only hit if opencv isn't installed
    HAS_CV2 = False

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/jpg", "image/png"}
MIN_BYTES = 200 * 1024        # 200KB
MAX_BYTES = 10 * 1024 * 1024  # 10MB
MIN_WIDTH = 640
MIN_HEIGHT = 480


def load_image(raw_bytes: bytes) -> Image.Image:
    """Load raw bytes into a Pillow Image, raising ValueError on garbage input."""
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.load()
        return img
    except Exception as exc:
        raise ValueError(f"Could not decode image: {exc}") from exc


def to_bgr_ndarray(img: Image.Image) -> "np.ndarray":
    """Convert a Pillow image to an OpenCV-style BGR numpy array."""
    rgb = np.array(img.convert("RGB"))
    if HAS_CV2:
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    return rgb[:, :, ::-1]  # manual RGB->BGR flip if cv2 unavailable


def validate_file(content_type: str, size_bytes: int, img: Image.Image) -> Tuple[bool, str]:
    """Basic file-validation gate: type, size, and minimum resolution."""
    if content_type not in ALLOWED_CONTENT_TYPES:
        return False, f"unsupported_file_type:{content_type}"
    if size_bytes < MIN_BYTES:
        return False, "file_too_small"
    if size_bytes > MAX_BYTES:
        return False, "file_too_large"
    w, h = img.size
    if w < MIN_WIDTH or h < MIN_HEIGHT:
        return False, f"resolution_too_low:{w}x{h}"
    return True, "ok"


def laplacian_variance(img: Image.Image) -> float:
    """Blur metric — variance of the Laplacian. Lower = blurrier."""
    gray_pil = img.convert("L")
    gray = np.array(gray_pil, dtype=np.float64)

    if HAS_CV2:
        lap = cv2.Laplacian(gray, cv2.CV_64F)
        return float(lap.var())

    # Manual Laplacian convolution fallback (no OpenCV available)
    kernel = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float64)
    padded = np.pad(gray, 1, mode="edge")
    lap = np.zeros_like(gray)
    for i in range(gray.shape[0]):
        for j in range(gray.shape[1]):
            region = padded[i:i + 3, j:j + 3]
            lap[i, j] = np.sum(region * kernel)
    return float(lap.var())
