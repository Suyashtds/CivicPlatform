-- ============================================================
-- Migration 005: Smart Civic Governance Upgrade
-- Adds: extended lifecycle, SLA + escalation, officer management,
--       duplicate linking, evidence, audit logs, civic health index
-- Safe to run on top of schema.sql + migrations 001-004.
-- Purely additive — no existing column/table is dropped or renamed.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm; -- fuzzy text similarity, used for duplicate detection

-- ============================================================
-- USERS — officer hierarchy fields
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS department_id       INT REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS officer_rank        VARCHAR(20)
        CHECK (officer_rank IN ('officer','senior_officer','department_head','commissioner')),
  ADD COLUMN IF NOT EXISTS is_available        BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS max_active_complaints INT DEFAULT 15,
  ADD COLUMN IF NOT EXISTS reputation_score     INT DEFAULT 0; -- citizen participation score

-- Widen role check to add 'officer' while keeping legacy roles valid
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('citizen', 'admin', 'department', 'officer'));

-- ============================================================
-- DEPARTMENTS — escalation contacts + efficiency inputs
-- ============================================================
ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS head_id         UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS commissioner_id UUID REFERENCES users(id);

-- ============================================================
-- COMPLAINTS — extended lifecycle, SLA, escalation, master/duplicate
-- ============================================================

-- Widen status CHECK to support the full lifecycle. Old values kept
-- so every existing row and every existing API call stays valid.
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_status_check;
ALTER TABLE complaints ADD CONSTRAINT complaints_status_check
  CHECK (status IN (
    'reported','verified','assigned','accepted','work_started',
    'under_inspection','resolved','citizen_verification','closed',
    'reopened','in_progress','rejected'
  ));

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS assigned_officer_id     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS sla_response_due_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_resolution_due_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_response_met         BOOLEAN,
  ADD COLUMN IF NOT EXISTS sla_resolution_met       BOOLEAN,
  ADD COLUMN IF NOT EXISTS escalation_level         SMALLINT DEFAULT 0, -- 0=none,1=senior,2=head,3=commissioner
  ADD COLUMN IF NOT EXISTS escalated_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_to             UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS escalation_reason        TEXT,
  ADD COLUMN IF NOT EXISTS is_master                BOOLEAN DEFAULT TRUE, -- false if linked to a duplicate_of parent
  ADD COLUMN IF NOT EXISTS linked_report_count       INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS road_importance          SMALLINT DEFAULT 0,   -- 0-10, used by priority engine
  ADD COLUMN IF NOT EXISTS near_school               BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS near_hospital              BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tags                      TEXT[],
  ADD COLUMN IF NOT EXISTS citizen_verified_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_count            INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_at                 TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_complaints_officer      ON complaints(assigned_officer_id);
CREATE INDEX IF NOT EXISTS idx_complaints_sla_resp      ON complaints(sla_response_due_at);
CREATE INDEX IF NOT EXISTS idx_complaints_sla_res       ON complaints(sla_resolution_due_at);
CREATE INDEX IF NOT EXISTS idx_complaints_escalation    ON complaints(escalation_level);
CREATE INDEX IF NOT EXISTS idx_complaints_duplicate_of  ON complaints(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_complaints_title_trgm    ON complaints USING GIN (title gin_trgm_ops);

-- ============================================================
-- EVIDENCE — before/after images + officer notes per complaint
-- ============================================================
CREATE TABLE IF NOT EXISTS evidence (
    id              SERIAL PRIMARY KEY,
    complaint_id    UUID          NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    officer_id      UUID          REFERENCES users(id),
    type            VARCHAR(10)   NOT NULL CHECK (type IN ('before','after')),
    image_url       TEXT          NOT NULL,
    notes           TEXT,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    gps_verified    BOOLEAN       DEFAULT FALSE, -- true if within radius of complaint location
    captured_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_complaint ON evidence(complaint_id);

-- ============================================================
-- OFFICER LEAVE MANAGEMENT
-- ============================================================
CREATE TABLE IF NOT EXISTS officer_leaves (
    id              SERIAL PRIMARY KEY,
    officer_id      UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date      DATE          NOT NULL,
    end_date        DATE          NOT NULL,
    reason          TEXT,
    status          VARCHAR(20)   NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected')),
    reviewed_by     UUID          REFERENCES users(id),
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leaves_officer ON officer_leaves(officer_id);

-- ============================================================
-- COMMUNITY VERIFICATION (confirm / additional evidence / comments)
-- ============================================================
CREATE TABLE IF NOT EXISTS complaint_comments (
    id              SERIAL PRIMARY KEY,
    complaint_id    UUID          NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment         TEXT          NOT NULL,
    image_url       TEXT,
    is_confirmation BOOLEAN       DEFAULT FALSE, -- "I confirm this issue exists"
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comments_complaint ON complaint_comments(complaint_id);

-- ============================================================
-- BOOKMARKS (citizen "saved complaints")
-- ============================================================
CREATE TABLE IF NOT EXISTS bookmarks (
    id              SERIAL PRIMARY KEY,
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    complaint_id    UUID          NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    UNIQUE(user_id, complaint_id)
);

-- ============================================================
-- AUDIT LOGS — append-only, never deleted
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        UUID          REFERENCES users(id),
    actor_role      VARCHAR(20),
    action          VARCHAR(80)   NOT NULL,   -- e.g. 'complaint.status_changed'
    entity_type     VARCHAR(50)   NOT NULL,   -- 'complaint' | 'officer' | 'auth' | 'evidence' ...
    entity_id       TEXT,
    metadata        JSONB,
    ip_address      VARCHAR(64),
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- ============================================================
-- WARD HEALTH SNAPSHOTS — Civic Health Index history (for trend lines)
-- ============================================================
CREATE TABLE IF NOT EXISTS ward_health_snapshots (
    id                  SERIAL PRIMARY KEY,
    ward_id             INT,
    ward                VARCHAR(100),
    complaint_density   FLOAT,
    avg_resolution_hours FLOAT,
    participation_rate  FLOAT,
    escalation_rate     FLOAT,
    pending_count       INT,
    health_score        FLOAT,  -- 0-100, higher = healthier
    computed_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ward_health_ward ON ward_health_snapshots(ward_id, computed_at DESC);

-- ============================================================
-- IN-APP NOTIFICATIONS — read/unread tracking, notification history
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(50)   NOT NULL, -- 'status_update' | 'escalation' | 'assignment' | 'sla_breach' | 'evidence' | 'comment'
    title           VARCHAR(200)  NOT NULL,
    message         TEXT,
    complaint_id    UUID          REFERENCES complaints(id) ON DELETE SET NULL,
    is_read         BOOLEAN       DEFAULT FALSE,
    created_at      TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- ============================================================
-- SEED: sensible default SLA hours are handled in application code
-- (services/slaService.js) rather than in the DB, so they can be
-- tuned without a migration.
-- ============================================================
