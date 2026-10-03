package db

import (
	"context"
	"time"
)

type SNRReading struct {
	SourceID   string    `json:"source_id"`
	RecordedAt time.Time `json:"t"`
	SNRDBM     float64   `json:"snr"`
	Users      *int      `json:"users,omitempty"`
	MaxUsers   *int      `json:"max_users,omitempty"`
}

func (db *DB) InsertSNRReading(ctx context.Context, sourceID string, snrDBM float64, users, maxUsers int) error {
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO snr_readings (source_id, snr_dbm, users, max_users) VALUES ($1, $2, $3, $4)`,
		sourceID, snrDBM, users, maxUsers)
	return err
}

func (db *DB) ListSNRReadings(ctx context.Context, sourceID string, from, to time.Time) ([]SNRReading, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT source_id, recorded_at, snr_dbm, users, max_users
		FROM snr_readings
		WHERE source_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
		ORDER BY recorded_at ASC
	`, sourceID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var readings []SNRReading
	for rows.Next() {
		var r SNRReading
		if err := rows.Scan(&r.SourceID, &r.RecordedAt, &r.SNRDBM, &r.Users, &r.MaxUsers); err != nil {
			return nil, err
		}
		readings = append(readings, r)
	}
	return readings, rows.Err()
}

func (db *DB) DeleteExpiredSNRReadings(ctx context.Context, olderThan time.Time) (int64, error) {
	tag, err := db.Pool.Exec(ctx, `DELETE FROM snr_readings WHERE recorded_at < $1`, olderThan)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
