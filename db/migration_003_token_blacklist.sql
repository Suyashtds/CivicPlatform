-- Migration: JWT Token Blacklist
-- Stores revoked tokens until their natural expiry, so logout actually works

CREATE TABLE IF NOT EXISTS token_blacklist (
    id          SERIAL PRIMARY KEY,
    token       TEXT          NOT NULL UNIQUE,
    user_id     UUID          REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ   NOT NULL,
    created_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blacklist_token   ON token_blacklist(token);
CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at);
