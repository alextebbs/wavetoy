ALTER TABLE streams DROP COLUMN IF EXISTS ref_audio_at;
ALTER TABLE streams DROP COLUMN IF EXISTS ref_audio_sample_rate;
ALTER TABLE streams DROP COLUMN IF EXISTS ref_audio;

ALTER TABLE fallback_suggestions ADD COLUMN IF NOT EXISTS ref_audio BYTEA;
ALTER TABLE fallback_suggestions RENAME COLUMN probe_sample_rate TO sample_rate;
