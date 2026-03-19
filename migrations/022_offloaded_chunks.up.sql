CREATE TABLE offloaded_chunks (
    stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ NOT NULL,
    size_bytes  INT NOT NULL,
    PRIMARY KEY (stream_id, started_at)
);
