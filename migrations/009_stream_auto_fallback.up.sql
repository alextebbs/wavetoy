ALTER TABLE streams ADD COLUMN auto_fallback BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE streams ADD COLUMN auto_fallback_kind TEXT NOT NULL DEFAULT 'auto';

CREATE TABLE fallback_suggestions (
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    rank        INTEGER NOT NULL,
    score       DOUBLE PRECISION NOT NULL,
    distance_km DOUBLE PRECISION NOT NULL,
    probe_metrics JSONB NOT NULL DEFAULT '{}',
    last_probed TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (stream_id, rank)
);

CREATE INDEX idx_fallback_suggestions_stream ON fallback_suggestions(stream_id);
