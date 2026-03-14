ALTER TABLE streams ADD COLUMN ref_audio BYTEA;
ALTER TABLE streams ADD COLUMN ref_audio_sample_rate INTEGER NOT NULL DEFAULT 12000;
ALTER TABLE streams ADD COLUMN ref_audio_at TIMESTAMPTZ;

ALTER TABLE fallback_suggestions ADD COLUMN probe_audio BYTEA;
ALTER TABLE fallback_suggestions ADD COLUMN probe_sample_rate INTEGER NOT NULL DEFAULT 12000;
