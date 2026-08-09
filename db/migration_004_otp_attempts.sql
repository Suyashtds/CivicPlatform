-- Migration: Add attempts counter to otp_verifications
ALTER TABLE otp_verifications
  ADD COLUMN IF NOT EXISTS attempts SMALLINT DEFAULT 0;