"""
Civic Platform — ML Service (Python FastAPI)
Duplicate detection now queries PostgreSQL directly via PostGIS
"""
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
import math
import psycopg2
import os

app = FastAPI(title="Civic Platform ML Service", version="1.0.0")

# ── Image verification pipeline (additive) ──────────────────────
# New POST /analyze endpoint: blur/EXIF/screenshot checks, pHash
# duplicate detection, EfficientNet-B0 classification, trust score.
# Lives in app/image_analysis.py, does not touch anything below.
from . import image_analysis  # noqa: E402
app.include_router(image_analysis.router)

# ── Database connection ──────────────────────────────────────
DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:Aashi%40123@localhost:5432/civic_platform"
)

def get_db():
    return psycopg2.connect(DB_URL)

# ── Models ───────────────────────────────────────────────────
class ComplaintInput(BaseModel):
    title: str
    description: str
    image_url: Optional[str] = None
    latitude: float
    longitude: float
    ward_id: Optional[int] = None
    city_id: Optional[int] = None

class MLPrediction(BaseModel):
    predicted_category: Optional[str]
    confidence: float = 0.0
    duplicate_score: float = 0.0
    duplicate_match_id: Optional[str] = None
    severity_score: float = 0.0
    priority_score: float = 0.0
    model_version: str = "rule_v1"

# ── Category keywords ────────────────────────────────────────
CATEGORY_KEYWORDS = {
    "pothole":         ["pothole", "hole", "road damage", "broken road", "crater", "pit"],
    "garbage":         ["garbage", "waste", "trash", "dumping", "littering", "rubbish"],
    "streetlight":     ["streetlight", "street light", "lamp", "dark road", "no light"],
    "water_leakage":   ["water leak", "pipe burst", "leakage", "overflow", "flooding"],
    "drainage":        ["drain", "drainage", "blocked drain", "sewage", "manhole"],
    "illegal_dumping": ["illegal dump", "dumping ground", "debris", "construction waste"],
}

CATEGORY_SEVERITY = {
    "pothole":         0.7,
    "garbage":         0.5,
    "streetlight":     0.6,
    "water_leakage":   0.8,
    "drainage":        0.75,
    "illegal_dumping": 0.55,
}

HIGH_IMPORTANCE_WARDS: set = set()

# ── Helpers ──────────────────────────────────────────────────
def classify_text(text: str):
    text_lower = text.lower()
    scores = {}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        scores[cat] = sum(1 for kw in keywords if kw in text_lower)
    best_cat = max(scores, key=scores.get)
    best_score = scores[best_cat]
    if best_score == 0:
        return None, 0.0
    total = sum(scores.values()) or 1
    return best_cat, round(best_score / total, 3)

def text_similarity(a: str, b: str) -> float:
    set_a = set(a.lower().split())
    set_b = set(b.lower().split())
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)

def calculate_priority(severity, upvotes, age_hours, location_important):
    s_score = severity * 40
    v_score = min(30, math.log1p(upvotes) * 8)
    a_score = min(20, age_hours / 24 * 5)
    l_score = 10 if location_important else 0
    return round(min(100, s_score + v_score + a_score + l_score), 2)

# ── Duplicate detection using PostGIS ────────────────────────
def find_duplicate_in_db(
    title: str,
    description: str,
    latitude: float,
    longitude: float,
    radius_meters: float = 200,
):
    try:
        conn = get_db()
        cur  = conn.cursor()

        # Find complaints within radius using PostGIS
        cur.execute("""
            SELECT id, title, description
            FROM complaints
            WHERE duplicate_of IS NULL
              AND status != 'rejected'
              AND ST_DWithin(
                    geo_point,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                    %s
                  )
            ORDER BY created_at DESC
            LIMIT 20
        """, (longitude, latitude, radius_meters))

        nearby = cur.fetchall()
        cur.close()
        conn.close()

        if not nearby:
            return 0.0, None

        combined = f"{title} {description}"
        best_score = 0.0
        best_id    = None

        for row in nearby:
            comp_id   = str(row[0])
            comp_text = f"{row[1]} {row[2]}"
            sim = text_similarity(combined, comp_text)
            if sim > best_score:
                best_score = sim
                best_id    = comp_id

        return round(best_score, 3), best_id

    except Exception as e:
        print(f"DB duplicate check error: {e}")
        return 0.0, None

# ── Endpoints ─────────────────────────────────────────────────
@app.post("/ml/analyze-complaint", response_model=MLPrediction)
async def analyze_complaint(payload: ComplaintInput):
    combined_text = f"{payload.title} {payload.description}"

    # 1. Classify
    category, confidence = classify_text(combined_text)

    # 2. Severity
    severity = CATEGORY_SEVERITY.get(category or "", 0.5)

    # 3. Duplicate check from DB
    dup_score, dup_id = find_duplicate_in_db(
        payload.title,
        payload.description,
        payload.latitude,
        payload.longitude,
    )

    # 4. Priority
    location_important = payload.ward_id in HIGH_IMPORTANCE_WARDS
    priority = calculate_priority(
        severity=severity,
        upvotes=0,
        age_hours=0,
        location_important=location_important,
    )

    return MLPrediction(
        predicted_category=category,
        confidence=confidence,
        duplicate_score=dup_score,
        duplicate_match_id=dup_id,
        severity_score=round(severity, 3),
        priority_score=priority,
        model_version="rule_v1",
    )

@app.post("/ml/recalculate-priority/{complaint_id}")
async def recalculate_priority(
    complaint_id: str,
    severity: float = 0.5,
    upvotes: int = 0,
    age_hours: float = 0,
    ward_id: Optional[int] = None,
):
    location_important = ward_id in HIGH_IMPORTANCE_WARDS
    priority = calculate_priority(severity, upvotes, age_hours, location_important)
    return {"complaint_id": complaint_id, "priority_score": priority}

@app.get("/health")
async def health():
    return {"status": "ok"}