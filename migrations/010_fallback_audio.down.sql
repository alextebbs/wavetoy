ALTER TABLE fallback_suggestions DROP COLUMN probe_sample_rate;
ALTER TABLE fallback_suggestions DROP COLUMN probe_audio;

ALTER TABLE streams DROP COLUMN ref_audio_at;
ALTER TABLE streams DROP COLUMN ref_audio_sample_rate;
ALTER TABLE streams DROP COLUMN ref_audio;
