-- Migration: add avatar_url to users table
-- Run this if you already created the DB with the original schema.sql
-- Safe to run multiple times (uses IF NOT EXISTS pattern)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;
