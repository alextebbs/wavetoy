-- Tenants
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  magic_phrase_hash TEXT NOT NULL,
  max_streams INT NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SDR Sources
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'kiwisdr' CHECK (type IN ('kiwisdr')),
  host TEXT NOT NULL,
  port INT NOT NULL DEFAULT 8073,
  use_tls BOOLEAN DEFAULT false,
  latitude FLOAT,
  longitude FLOAT,
  name TEXT,
  max_listeners INT DEFAULT 4,
  available BOOLEAN DEFAULT true,
  last_health_check_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  users INT DEFAULT 0,
  snr_dbm FLOAT,
  snr_ema FLOAT,
  antenna TEXT,
  location TEXT,
  grid TEXT,
  status TEXT,
  ant_connected BOOLEAN,
  offline BOOLEAN DEFAULT false,
  last_reachable_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(host, port)
);

-- Streams
CREATE TABLE streams (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  frequency_khz FLOAT NOT NULL,
  bandwidth_low_hz INT NOT NULL DEFAULT -5000,
  bandwidth_high_hz INT NOT NULL DEFAULT 5000,
  mode TEXT NOT NULL DEFAULT 'am',
  name TEXT NOT NULL,
  agc_on BOOLEAN DEFAULT true,
  agc_gain_db FLOAT,
  buffer_minutes INT NOT NULL DEFAULT 15,
  state TEXT NOT NULL DEFAULT 'idle',
  health TEXT[] NOT NULL DEFAULT '{}',
  version BIGINT NOT NULL DEFAULT 1,
  filters JSONB NOT NULL DEFAULT '{}',
  interpreter JSONB NOT NULL DEFAULT '{}',
  wf_view_start_khz FLOAT NOT NULL DEFAULT 0,
  wf_view_end_khz FLOAT NOT NULL DEFAULT 30000,
  auto_probe BOOLEAN NOT NULL DEFAULT false,
  quality_fallback BOOLEAN NOT NULL DEFAULT false,
  offload_chunks BOOLEAN NOT NULL DEFAULT false,
  keep_alive BOOLEAN NOT NULL DEFAULT false,
  locked BOOLEAN NOT NULL DEFAULT false,
  view_locked BOOLEAN NOT NULL DEFAULT false,
  log_level TEXT NOT NULL DEFAULT 'info' CHECK (log_level IN ('debug', 'info', 'warn', 'error')),
  ref_audio BYTEA,
  ref_audio_sample_rate INTEGER NOT NULL DEFAULT 12000,
  ref_audio_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_streams_tenant ON streams(tenant_id);
CREATE INDEX idx_streams_source ON streams(source_id);

-- Probe suggestions
CREATE TABLE probe_suggestions (
  stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rank        INTEGER NOT NULL,
  score       DOUBLE PRECISION NOT NULL,
  score_ema   DOUBLE PRECISION,
  in_band_snr_db DOUBLE PRECISION,
  distance_km DOUBLE PRECISION NOT NULL,
  probe_metrics JSONB NOT NULL DEFAULT '{}',
  probe_audio   BYTEA,
  probe_sample_rate INTEGER NOT NULL DEFAULT 12000,
  last_probed TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, rank)
);

CREATE INDEX idx_probe_suggestions_stream ON probe_suggestions(stream_id);

-- Favorite sources
CREATE TABLE favorite_sources (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id)
);

CREATE INDEX idx_favorite_sources_tenant ON favorite_sources(tenant_id);

-- Recent sources
CREATE TABLE recent_sources (
  id          SERIAL PRIMARY KEY,
  stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recent_sources_stream ON recent_sources(stream_id);

-- Source notes
CREATE TABLE source_notes (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id)
);

CREATE INDEX idx_source_notes_tenant ON source_notes(tenant_id);

-- Offloaded chunks (S3 manifest)
CREATE TABLE offloaded_chunks (
  stream_id    TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ NOT NULL,
  size_bytes   INT NOT NULL,
  wf_frames    INT NOT NULL DEFAULT 0,
  events       INT NOT NULL DEFAULT 0,
  audio_bytes  INT NOT NULL DEFAULT 0,
  stream_state SMALLINT NOT NULL DEFAULT 0,
  health_flags SMALLINT NOT NULL DEFAULT 0,
  in_band_snr_db DOUBLE PRECISION,
  PRIMARY KEY (stream_id, started_at)
);

-- SNR history
CREATE TABLE snr_readings (
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snr_dbm     FLOAT NOT NULL,
  users       INT,
  max_users   INT,
  PRIMARY KEY (source_id, recorded_at)
);

CREATE INDEX idx_snr_readings_source_time ON snr_readings (source_id, recorded_at DESC);
