package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/sammy/sdr-radio/internal/models"
)

type MapSourceCounts struct {
	Total    int `json:"total"`
	Included int `json:"included"`
	Omitted  int `json:"omitted"`
}

func (db *DB) ListSources(ctx context.Context, limit, offset int) ([]models.Source, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT id, type, host, port, use_tls, latitude, longitude, name,
		       max_listeners, available, users, snr_dbm, antenna, location, grid,
		       status, COALESCE(ant_connected, false), COALESCE(offline, false),
		       last_health_check_at, last_reachable_at, last_synced_at, created_at, updated_at
		FROM sources
		ORDER BY name
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sources []models.Source
	for rows.Next() {
		var s models.Source
		err := rows.Scan(
			&s.ID, &s.Type, &s.Host, &s.Port, &s.UseTLS,
			&s.Latitude, &s.Longitude, &s.Name, &s.MaxListeners,
			&s.Available, &s.Users, &s.SNRDBM, &s.Antenna, &s.Location, &s.Grid,
			&s.Status, &s.AntConnected, &s.Offline,
			&s.LastHealthCheckAt, &s.LastReachableAt, &s.LastSyncedAt, &s.CreatedAt, &s.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		sources = append(sources, s)
	}
	return sources, rows.Err()
}

func (db *DB) ListMapSources(ctx context.Context) ([]models.Source, MapSourceCounts, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT id, type, host, port, use_tls, latitude, longitude, name,
		       max_listeners, available, users, snr_dbm, antenna, location, grid,
		       status, COALESCE(ant_connected, false), COALESCE(offline, false),
		       last_health_check_at, last_reachable_at, last_synced_at, created_at, updated_at
		FROM sources
		WHERE latitude IS NOT NULL
		  AND longitude IS NOT NULL
		  AND available = true
		  AND users < max_listeners
		ORDER BY name
	`)
	if err != nil {
		return nil, MapSourceCounts{}, err
	}
	defer rows.Close()

	var sources []models.Source
	for rows.Next() {
		var s models.Source
		err := rows.Scan(
			&s.ID, &s.Type, &s.Host, &s.Port, &s.UseTLS,
			&s.Latitude, &s.Longitude, &s.Name, &s.MaxListeners,
			&s.Available, &s.Users, &s.SNRDBM, &s.Antenna, &s.Location, &s.Grid,
			&s.Status, &s.AntConnected, &s.Offline,
			&s.LastHealthCheckAt, &s.LastReachableAt, &s.LastSyncedAt, &s.CreatedAt, &s.UpdatedAt,
		)
		if err != nil {
			return nil, MapSourceCounts{}, err
		}
		sources = append(sources, s)
	}
	if err := rows.Err(); err != nil {
		return nil, MapSourceCounts{}, err
	}

	var counts MapSourceCounts
	if err := db.Pool.QueryRow(ctx, `
		SELECT
			COUNT(*)::int AS total,
			COUNT(*) FILTER (
				WHERE latitude IS NOT NULL
				  AND longitude IS NOT NULL
				  AND available = true
				  AND users < max_listeners
			)::int AS included
		FROM sources
	`).Scan(&counts.Total, &counts.Included); err != nil {
		return nil, MapSourceCounts{}, err
	}
	counts.Omitted = counts.Total - counts.Included
	return sources, counts, nil
}

func (db *DB) GetSourceByID(ctx context.Context, id string) (*models.Source, error) {
	var s models.Source
	err := db.Pool.QueryRow(ctx, `
		SELECT id, type, host, port, use_tls, latitude, longitude, name,
		       max_listeners, available, users, snr_dbm, antenna, location, grid,
		       status, COALESCE(ant_connected, false), COALESCE(offline, false),
		       last_health_check_at, last_reachable_at, last_synced_at, created_at, updated_at
		FROM sources WHERE id = $1
	`, id).Scan(
		&s.ID, &s.Type, &s.Host, &s.Port, &s.UseTLS,
		&s.Latitude, &s.Longitude, &s.Name, &s.MaxListeners,
		&s.Available, &s.Users, &s.SNRDBM, &s.Antenna, &s.Location, &s.Grid,
		&s.Status, &s.AntConnected, &s.Offline,
		&s.LastHealthCheckAt, &s.LastReachableAt, &s.LastSyncedAt, &s.CreatedAt, &s.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}
