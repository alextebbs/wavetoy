package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/segmentio/ksuid"
)

type CreateTenantParams struct {
	Name            string
	MagicPhraseHash string
	MaxStreams       int
}

func (db *DB) ListTenants(ctx context.Context) ([]models.Tenant, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT id, name, magic_phrase_hash, max_streams, created_at
		FROM tenants ORDER BY created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tenants []models.Tenant
	for rows.Next() {
		var t models.Tenant
		if err := rows.Scan(&t.ID, &t.Name, &t.MagicPhraseHash, &t.MaxStreams, &t.CreatedAt); err != nil {
			return nil, err
		}
		tenants = append(tenants, t)
	}
	return tenants, rows.Err()
}

func (db *DB) GetTenantByID(ctx context.Context, id string) (*models.Tenant, error) {
	var t models.Tenant
	err := db.Pool.QueryRow(ctx, `
		SELECT id, name, magic_phrase_hash, max_streams, created_at
		FROM tenants WHERE id = $1
	`, id).Scan(&t.ID, &t.Name, &t.MagicPhraseHash, &t.MaxStreams, &t.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (db *DB) CreateTenant(ctx context.Context, p CreateTenantParams) (*models.Tenant, error) {
	id := ksuid.New().String()
	maxStreams := p.MaxStreams
	if maxStreams <= 0 {
		maxStreams = 5
	}

	var t models.Tenant
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO tenants (id, name, magic_phrase_hash, max_streams)
		VALUES ($1, $2, $3, $4)
		RETURNING id, name, magic_phrase_hash, max_streams, created_at
	`, id, p.Name, p.MagicPhraseHash, maxStreams).Scan(
		&t.ID, &t.Name, &t.MagicPhraseHash, &t.MaxStreams, &t.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &t, nil
}
