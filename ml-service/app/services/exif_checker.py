"""
EXIF validation.

Extracts camera timestamp, embedded GPS, and the Software/editor tag.
A populated Software tag naming a known photo editor is a strong signal
the image was touched up or synthetically generated after capture.
"""
from __future__ import annotations

from typing import Optional
from PIL import Image
from PIL.ExifTags import TAGS

EDITOR_SIGNATURES = [
    "photoshop", "canva", "snapseed", "lightroom", "gimp",
    "picsart", "facetune", "vsco", "pixlr", "affinity photo",
]


def _decode_exif(img: Image.Image) -> dict:
    raw = img.getexif()
    if not raw:
        return {}
    return {TAGS.get(tag_id, tag_id): value for tag_id, value in raw.items()}


def check_exif(img: Image.Image) -> dict:
    """
    Returns:
    {
      "exif_present": bool,
      "camera_timestamp": str|None,
      "has_gps": bool,
      "software": str|None,
      "is_edited": bool,
      "editor_match": str|None
    }
    """
    exif = _decode_exif(img)

    if not exif:
        return {
            "exif_present": False,
            "camera_timestamp": None,
            "has_gps": False,
            "software": None,
            "is_edited": False,
            "editor_match": None,
        }

    camera_timestamp = exif.get("DateTime") or exif.get("DateTimeOriginal")
    software = exif.get("Software")
    has_gps = "GPSInfo" in exif and bool(exif.get("GPSInfo"))

    editor_match: Optional[str] = None
    if software:
        software_lower = str(software).lower()
        for sig in EDITOR_SIGNATURES:
            if sig in software_lower:
                editor_match = sig
                break

    return {
        "exif_present": True,
        "camera_timestamp": str(camera_timestamp) if camera_timestamp else None,
        "has_gps": has_gps,
        "software": str(software) if software else None,
        "is_edited": editor_match is not None,
        "editor_match": editor_match,
    }
