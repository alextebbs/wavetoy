-- Columns already correct from migration 010 when running fresh.
-- This migration originally fixed a naming mismatch that no longer exists.

ALTER TABLE fallback_suggestions DROP COLUMN IF EXISTS ref_audio;

ALTER TABLE streams ADD COLUMN IF NOT EXISTS ref_audio BYTEA;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS ref_audio_sample_rate INTEGER NOT NULL DEFAULT 12000;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS ref_audio_at TIMESTAMPTZ;
