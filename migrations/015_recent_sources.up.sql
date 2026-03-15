CREATE TABLE recent_sources (
    id          SERIAL PRIMARY KEY,
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recent_sources_stream ON recent_sources(stream_id);
