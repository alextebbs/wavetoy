CREATE TABLE favorite_sources (
    tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source_id)
);

CREATE INDEX idx_favorite_sources_tenant ON favorite_sources(tenant_id);
