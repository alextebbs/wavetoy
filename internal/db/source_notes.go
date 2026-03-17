package db

import (
	"context"

	"github.com/sammy/sdr-radio/internal/models"
)

func (db *DB) ListSourceNotes(ctx context.Context, tenantID string) ([]models.SourceNote, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT tenant_id, source_id, content, created_at, updated_at
		FROM source_notes
		WHERE tenant_id = $1
		ORDER BY updated_at DESC
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notes []models.SourceNote
	for rows.Next() {
		var n models.SourceNote
		if err := rows.Scan(&n.TenantID, &n.SourceID, &n.Content, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func (db *DB) GetSourceNote(ctx context.Context, tenantID, sourceID string) (*models.SourceNote, error) {
	var n models.SourceNote
	err := db.Pool.QueryRow(ctx, `
		SELECT tenant_id, source_id, content, created_at, updated_at
		FROM source_notes
		WHERE tenant_id = $1 AND source_id = $2
	`, tenantID, sourceID).Scan(&n.TenantID, &n.SourceID, &n.Content, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, err
	}
	return &n, nil
}

func (db *DB) UpsertSourceNote(ctx context.Context, tenantID, sourceID, content string) (*models.SourceNote, error) {
	var n models.SourceNote
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO source_notes (tenant_id, source_id, content)
		VALUES ($1, $2, $3)
		ON CONFLICT (tenant_id, source_id) DO UPDATE
			SET content = EXCLUDED.content, updated_at = now()
		RETURNING tenant_id, source_id, content, created_at, updated_at
	`, tenantID, sourceID, content).Scan(&n.TenantID, &n.SourceID, &n.Content, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func (db *DB) DeleteSourceNote(ctx context.Context, tenantID, sourceID string) error {
	_, err := db.Pool.Exec(ctx, `
		DELETE FROM source_notes
		WHERE tenant_id = $1 AND source_id = $2
	`, tenantID, sourceID)
	return err
}
