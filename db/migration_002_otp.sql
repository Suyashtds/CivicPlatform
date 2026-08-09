-- Migration: OTP Verification Table
CREATE TABLE IF NOT EXISTS otp_verifications (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(150)  NOT NULL,
    otp_code    VARCHAR(6)    NOT NULL,
    type        VARCHAR(20)   NOT NULL CHECK (type IN ('register', 'login')),
    expires_at  TIMESTAMPTZ   NOT NULL,
    used        BOOLEAN       DEFAULT FALSE,
    created_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_email   ON otp_verifications(email);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_verifications(expires_at);