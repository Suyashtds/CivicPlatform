-- ============================================================
--  Civic Issue Platform — PostgreSQL + PostGIS Schema
-- ============================================================

-- Enable PostGIS for geo-spatial queries
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100)  NOT NULL,
    email           VARCHAR(150)  UNIQUE NOT NULL,
    phone           VARCHAR(20)   UNIQUE,
    password_hash   TEXT          NOT NULL,
    role            VARCHAR(20)   NOT NULL DEFAULT 'citizen'
                        CHECK (role IN ('citizen', 'admin', 'department')),
    city            VARCHAR(100),
    ward            VARCHAR(100),
    city_id         INT,
    ward_id         INT,
    is_verified     BOOLEAN       DEFAULT FALSE,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
-- DEPARTMENTS
-- ============================================================
CREATE TABLE departments (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150)  NOT NULL,
    city            VARCHAR(100),
    ward            VARCHAR(100),
    city_id         INT,
    ward_id         INT,
    contact_email   VARCHAR(150),
    categories      TEXT[],       -- issue categories this dept handles
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
-- COMPLAINTS
-- ============================================================
CREATE TABLE complaints (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title                   VARCHAR(200)  NOT NULL,
    description             TEXT          NOT NULL,

    -- AI-assigned category
    category                VARCHAR(100),   -- pothole | garbage | streetlight | water_leakage | drainage | illegal_dumping
    category_confidence     FLOAT,

    -- Media
    image_url               TEXT,
    video_url               TEXT,

    -- Location
    latitude                DOUBLE PRECISION NOT NULL,
    longitude               DOUBLE PRECISION NOT NULL,
    geo_point               GEOGRAPHY(POINT, 4326),   -- PostGIS column
    address                 TEXT,
    city                    VARCHAR(100),
    ward                    VARCHAR(100),
    city_id                 INT,
    ward_id                 INT,

    -- Status lifecycle
    status                  VARCHAR(30)   NOT NULL DEFAULT 'reported'
                                CHECK (status IN ('reported','verified','assigned','in_progress','resolved','rejected')),

    -- AI scores
    priority_score          FLOAT         DEFAULT 0,
    severity_score          FLOAT         DEFAULT 0,
    duplicate_of            UUID          REFERENCES complaints(id), -- points to parent if duplicate

    -- Routing
    assigned_department_id  INT           REFERENCES departments(id),

    -- Counters (denormalised for speed)
    upvote_count            INT           DEFAULT 0,

    created_at              TIMESTAMPTZ   DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   DEFAULT NOW()
);

-- Auto-populate geo_point from lat/lng
CREATE OR REPLACE FUNCTION sync_geo_point()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geo_point = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_geo_point
BEFORE INSERT OR UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION sync_geo_point();

-- ============================================================
-- VOTES  (upvotes by nearby citizens)
-- ============================================================
CREATE TABLE votes (
    id              SERIAL PRIMARY KEY,
    complaint_id    UUID          NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    UNIQUE(complaint_id, user_id)         -- prevent duplicate voting
);

-- ============================================================
-- STATUS HISTORY  (full audit trail)
-- ============================================================
CREATE TABLE status_history (
    id              SERIAL PRIMARY KEY,
    complaint_id    UUID          NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    status          VARCHAR(30)   NOT NULL,
    updated_by      UUID          REFERENCES users(id),
    remarks         TEXT,
    proof_image_url TEXT,         -- resolution proof image
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
-- FEEDBACK  (citizen rating after resolution)
-- ============================================================
CREATE TABLE feedback (
    id              SERIAL PRIMARY KEY,
    complaint_id    UUID          NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating          SMALLINT      CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    UNIQUE(complaint_id, user_id)
);

-- ============================================================
-- ML PREDICTIONS  (auditability of AI decisions)
-- ============================================================
CREATE TABLE ml_predictions (
    id                  SERIAL PRIMARY KEY,
    complaint_id        UUID    NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    predicted_category  VARCHAR(100),
    confidence          FLOAT,
    duplicate_score     FLOAT,
    duplicate_match_id  UUID    REFERENCES complaints(id),
    severity_score      FLOAT,
    priority_score      FLOAT,
    model_version       VARCHAR(50),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_complaints_geo       ON complaints USING GIST(geo_point);
CREATE INDEX idx_complaints_status    ON complaints(status);
CREATE INDEX idx_complaints_category  ON complaints(category);
CREATE INDEX idx_complaints_ward      ON complaints(ward_id);
CREATE INDEX idx_complaints_priority  ON complaints(priority_score DESC);
CREATE INDEX idx_votes_complaint      ON votes(complaint_id);
CREATE INDEX idx_status_history_comp  ON status_history(complaint_id);
