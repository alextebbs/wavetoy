package db

import (
	"context"

	"github.com/sammy/sdr-radio/internal/models"
)

func (db *DB) ListFavoriteSources(ctx context.Context, tenantID string) ([]models.Source, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT s.id, s.type, s.host, s.port, s.use_tls, s.latitude, s.longitude, s.name,
		       s.max_listeners, s.available, s.users, COALESCE(s.snr_ema, s.snr_dbm), s.antenna, s.location, s.grid,
		       s.status, COALESCE(s.ant_connected, false), COALESCE(s.offline, false),
		       s.last_health_check_at, s.last_reachable_at, s.last_synced_at, s.created_at, s.updated_at
		FROM favorite_sources f
		JOIN sources s ON s.id = f.source_id
		WHERE f.tenant_id = $1
		ORDER BY f.created_at
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sources []models.Source
	for rows.Next() {
		var s models.Source
		if err := rows.Scan(
			&s.ID, &s.Type, &s.Host, &s.Port, &s.UseTLS,
			&s.Latitude, &s.Longitude, &s.Name, &s.MaxListeners,
			&s.Available, &s.Users, &s.SNRDBM, &s.Antenna, &s.Location, &s.Grid,
			&s.Status, &s.AntConnected, &s.Offline,
			&s.LastHealthCheckAt, &s.LastReachableAt, &s.LastSyncedAt, &s.CreatedAt, &s.UpdatedAt,
		); err != nil {
			return nil, err
		}
		sources = append(sources, s)
	}
	return sources, rows.Err()
}

func (db *DB) ListFavoriteSourceIDs(ctx context.Context, tenantID string) ([]string, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT source_id FROM favorite_sources
		WHERE tenant_id = $1
		ORDER BY created_at
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (db *DB) AddFavoriteSource(ctx context.Context, tenantID, sourceID string) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO favorite_sources (tenant_id, source_id)
		VALUES ($1, $2)
		ON CONFLICT DO NOTHING
	`, tenantID, sourceID)
	return err
}

func (db *DB) RemoveFavoriteSource(ctx context.Context, tenantID, sourceID string) error {
	_, err := db.Pool.Exec(ctx, `
		DELETE FROM favorite_sources
		WHERE tenant_id = $1 AND source_id = $2
	`, tenantID, sourceID)
	return err
}
