"""
Duplicate image detection using perceptual hashing (pHash).

Hashes are stored in the `image_hashes` Postgres table (see
db/migration_006_image_verification.sql). A new upload is compared
against recent hashes; Hamming distance < 5 is treated as a duplicate.
"""
from __future__ import annotations

import os
from typing import Optional, Tuple

import imagehash
import psycopg2
from PIL import Image

DUPLICATE_HAMMING_THRESHOLD = 5
LOOKBACK_LIMIT = 500  # only compare against the most recent N hashes


def _get_db():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL not set — required for duplicate image lookup")
    return psycopg2.connect(db_url)


def compute_phash(img: Image.Image) -> str:
    return str(imagehash.phash(img))


def hamming_distance(hash_a: str, hash_b: str) -> int:
    return imagehash.hex_to_hash(hash_a) - imagehash.hex_to_hash(hash_b)


def find_duplicate(img: Image.Image) -> dict:
    """
    Returns:
    {"is_duplicate": bool, "matched_hash": str|None, "distance": int|None,
     "phash": str}
    """
    phash = compute_phash(img)

    try:
        conn = _get_db()
        cur = conn.cursor()
        cur.execute(
            "SELECT hash FROM image_hashes ORDER BY created_at DESC LIMIT %s",
            (LOOKBACK_LIMIT,),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as e:  # DB unreachable shouldn't hard-fail the pipeline
        print(f"duplicate image lookup skipped (DB error): {e}")
        return {"is_duplicate": False, "matched_hash": None, "distance": None, "phash": phash}

    best_distance: Optional[int] = None
    best_hash: Optional[str] = None

    for (stored_hash,) in rows:
        try:
            dist = hamming_distance(phash, stored_hash)
        except Exception:
            continue
        if best_distance is None or dist < best_distance:
            best_distance = dist
            best_hash = stored_hash

    is_duplicate = best_distance is not None and best_distance < DUPLICATE_HAMMING_THRESHOLD

    return {
        "is_duplicate": is_duplicate,
        "matched_hash": best_hash if is_duplicate else None,
        "distance": best_distance,
        "phash": phash,
    }


def store_hash(phash: str, complaint_id: Optional[str], image_url: Optional[str]) -> None:
    """Persist the new hash so future uploads can be checked against it."""
    try:
        conn = _get_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO image_hashes (hash, complaint_id, image_url) VALUES (%s, %s, %s)",
            (phash, complaint_id, image_url),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"failed to store image hash: {e}")
