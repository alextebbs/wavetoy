package db

import "context"

const DefaultTenantID = "tenant_default"

// Seed ensures the default tenant exists. If passphraseHash is non-empty the
// hash is upserted (allows rotation). An empty hash skips the update when the
// tenant already exists.
func (db *DB) Seed(ctx context.Context, passphraseHash string) error {
	if passphraseHash == "" {
		// No passphrase provided — only insert if tenant doesn't exist yet.
		_, err := db.Pool.Exec(ctx, `
			INSERT INTO tenants (id, name, magic_phrase_hash, max_streams)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (id) DO NOTHING
		`, DefaultTenantID, "Default Tenant", "phase1-no-auth", 5)
		return err
	}
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO tenants (id, name, magic_phrase_hash, max_streams)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET magic_phrase_hash = EXCLUDED.magic_phrase_hash
	`, DefaultTenantID, "Default Tenant", passphraseHash, 5)
	return err
}
