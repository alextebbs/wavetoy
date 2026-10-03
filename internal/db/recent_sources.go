package db

import (
	"context"
	"time"

	"github.com/sammy/sdr-radio/internal/models"
)

type RecentSource struct {
	Source    models.Source `json:"source"`
	StartedAt time.Time   `json:"started_at"`
}

func (db *DB) ListRecentSources(ctx context.Context, streamID string) ([]RecentSource, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT s.id, s.type, s.host, s.port, s.use_tls, s.latitude, s.longitude, s.name,
		       s.max_listeners, s.available, s.users, COALESCE(s.snr_ema, s.snr_dbm), s.antenna, s.location, s.grid,
		       s.status, COALESCE(s.ant_connected, false), COALESCE(s.offline, false),
		       s.last_health_check_at, s.last_reachable_at, s.last_synced_at, s.created_at, s.updated_at,
		       r.started_at
		FROM recent_sources r
		JOIN sources s ON s.id = r.source_id
		WHERE r.stream_id = $1
		ORDER BY r.started_at DESC
		LIMIT 20
	`, streamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []RecentSource
	for rows.Next() {
		var rs RecentSource
		if err := rows.Scan(
			&rs.Source.ID, &rs.Source.Type, &rs.Source.Host, &rs.Source.Port, &rs.Source.UseTLS,
			&rs.Source.Latitude, &rs.Source.Longitude, &rs.Source.Name, &rs.Source.MaxListeners,
			&rs.Source.Available, &rs.Source.Users, &rs.Source.SNRDBM, &rs.Source.Antenna, &rs.Source.Location, &rs.Source.Grid,
			&rs.Source.Status, &rs.Source.AntConnected, &rs.Source.Offline,
			&rs.Source.LastHealthCheckAt, &rs.Source.LastReachableAt, &rs.Source.LastSyncedAt, &rs.Source.CreatedAt, &rs.Source.UpdatedAt,
			&rs.StartedAt,
		); err != nil {
			return nil, err
		}
		results = append(results, rs)
	}
	return results, rows.Err()
}

func (db *DB) InsertRecentSource(ctx context.Context, streamID, sourceID string, startedAt time.Time) error {
	var lastSourceID *string
	err := db.Pool.QueryRow(ctx, `
		SELECT source_id FROM recent_sources
		WHERE stream_id = $1
		ORDER BY started_at DESC
		LIMIT 1
	`, streamID).Scan(&lastSourceID)
	if err == nil && lastSourceID != nil && *lastSourceID == sourceID {
		return nil
	}

	_, err = db.Pool.Exec(ctx, `
		INSERT INTO recent_sources (stream_id, source_id, started_at)
		VALUES ($1, $2, $3)
	`, streamID, sourceID, startedAt)
	if err != nil {
		return err
	}

	_, err = db.Pool.Exec(ctx, `
		DELETE FROM recent_sources
		WHERE stream_id = $1
		  AND id NOT IN (
		    SELECT id FROM recent_sources
		    WHERE stream_id = $1
		    ORDER BY started_at DESC
		    LIMIT 20
		  )
	`, streamID)
	return err
}
