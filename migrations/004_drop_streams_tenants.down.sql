CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  magic_phrase_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

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
  activity_detection_enabled BOOLEAN DEFAULT false,
  activity_sensitivity FLOAT DEFAULT 0.5,
  state TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_streams_tenant ON streams(tenant_id);
CREATE INDEX idx_streams_source ON streams(source_id);
