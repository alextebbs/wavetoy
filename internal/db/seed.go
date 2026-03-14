package db

import "context"

const DefaultTenantID = "tenant_default"

// Seed creates a single default tenant for Phase 1.
func (db *DB) Seed(ctx context.Context) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO tenants (id, name, magic_phrase_hash)
		VALUES ($1, $2, $3)
		ON CONFLICT (id) DO NOTHING
	`, DefaultTenantID, "Default Tenant", "phase1-no-auth")
	if err != nil {
		return err
	}
	return nil
}
