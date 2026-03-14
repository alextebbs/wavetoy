-- Fix column naming mismatch from migration 010
-- Rename sample_rate -> probe_sample_rate on fallback_suggestions
ALTER TABLE fallback_suggestions RENAME COLUMN sample_rate TO probe_sample_rate;

-- Remove ref_audio from fallback_suggestions (belongs on streams)
ALTER TABLE fallback_suggestions DROP COLUMN IF EXISTS ref_audio;

-- Add ref_audio columns to streams (if not already present)
ALTER TABLE streams ADD COLUMN IF NOT EXISTS ref_audio BYTEA;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS ref_audio_sample_rate INTEGER NOT NULL DEFAULT 12000;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS ref_audio_at TIMESTAMPTZ;
