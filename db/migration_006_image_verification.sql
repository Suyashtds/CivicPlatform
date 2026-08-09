-- ============================================================
-- Migration 006 — Image Verification & Geo-Routing Pipeline
-- ------------------------------------------------------------
-- Purely additive: new tables + new nullable columns only.
-- Nothing from migrations 001-005 or schema.sql is modified.
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS guards).
-- ============================================================

-- ── 1. Perceptual-hash store for duplicate image detection ───
CREATE TABLE IF NOT EXISTS image_hashes (
    id             SERIAL PRIMARY KEY,
    hash           VARCHAR(32)  NOT NULL,          -- phash, hex string
    complaint_id   UUID         REFERENCES complaints(id) ON DELETE CASCADE,
    image_url      TEXT,
    created_at     TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_image_hashes_hash ON image_hashes(hash);
CREATE INDEX IF NOT EXISTS idx_image_hashes_complaint ON image_hashes(complaint_id);

-- ── 2. Ward polygons for PostGIS-based geo-routing ────────────
-- Distinct from the existing free-text complaints.ward / ward_id
-- columns — this is the actual polygon boundary + officer contact
-- used by geoRoutingService.findWard(lat, lng).
CREATE TABLE IF NOT EXISTS wards (
    id             SERIAL PRIMARY KEY,
    name           TEXT         NOT NULL,
    department     TEXT,
    officer_email  VARCHAR(150),
    city_id        INT,
    geom           GEOMETRY(POLYGON, 4326) NOT NULL,
    created_at     TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wards_geom ON wards USING GIST (geom);

-- ── 3. Manual review queue for borderline-trust uploads (60-79) ──
CREATE TABLE IF NOT EXISTS review_queue (
    id                  SERIAL PRIMARY KEY,
    complaint_temp_id   UUID         DEFAULT uuid_generate_v4(),
    user_id             UUID         REFERENCES users(id) ON DELETE SET NULL,
    image_url           TEXT,
    title               VARCHAR(200),
    description         TEXT,
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,
    issue_type          VARCHAR(100),
    confidence          FLOAT,
    trust_score         INTEGER,
    reasons             JSONB,
    status              VARCHAR(20)  DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    reviewed_by         UUID         REFERENCES users(id),
    reviewed_at         TIMESTAMPTZ,
    resulting_complaint_id UUID      REFERENCES complaints(id),
    created_at          TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);

-- ── 4. Image-verification result columns on complaints ───────
-- All nullable so nothing that already inserts into `complaints`
-- (complaintsController.createComplaint) needs to change.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS trust_score            INTEGER;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS is_blurry              BOOLEAN;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS is_screenshot          BOOLEAN;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS is_duplicate_image     BOOLEAN;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS image_verification_status VARCHAR(20);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS image_reasons          JSONB;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS device_metadata        JSONB;

-- ── 5. Full ML image-analysis audit trail (separate from the ──
-- existing text-based ml_predictions table so that table's shape
-- is untouched) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_image_analysis (
    id                SERIAL PRIMARY KEY,
    complaint_id      UUID    REFERENCES complaints(id) ON DELETE CASCADE,
    review_queue_id   INT     REFERENCES review_queue(id) ON DELETE CASCADE,
    issue_type        VARCHAR(100),
    confidence        FLOAT,
    top3              JSONB,
    is_blurry         BOOLEAN,
    is_screenshot     BOOLEAN,
    screenshot_reason VARCHAR(100),
    is_duplicate      BOOLEAN,
    duplicate_hash    VARCHAR(32),
    duplicate_distance INT,
    exif_present      BOOLEAN,
    exif_editor_flag  VARCHAR(100),
    trust_score       INTEGER,
    trust_breakdown   JSONB,
    status            VARCHAR(20),
    rejection_reasons JSONB,
    model_version     VARCHAR(50) DEFAULT 'efficientnet-b0-v1',
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
