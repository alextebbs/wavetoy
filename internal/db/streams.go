package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/segmentio/ksuid"
)

var (
	ErrSourceNotFound    = errors.New("source not found")
	ErrSourceUnavailable = errors.New("source unavailable")
	ErrSourceAtCapacity  = errors.New("source at listener capacity")
)

type CreateStreamParams struct {
	TenantID        string
	SourceID        string
	FrequencyKHz    float64
	BandwidthLowHz  int
	BandwidthHighHz int
	Mode            string
	Name            string
	AGCOn           bool
	AGCGainDB       *float64
	BufferMinutes   int
}

type UpdateStreamParams struct {
	SourceID        string
	FrequencyKHz    float64
	BandwidthLowHz  int
	BandwidthHighHz int
	Mode            string
	Name            string
	AGCOn           bool
	AGCGainDB       *float64
	BufferMinutes   int
}

func (db *DB) CreateStream(ctx context.Context, p CreateStreamParams) (*models.Stream, error) {
	source, err := db.GetSourceByID(ctx, p.SourceID)
	if err != nil {
		return nil, err
	}
	if source == nil {
		return nil, ErrSourceNotFound
	}
	if !source.Available {
		return nil, ErrSourceUnavailable
	}
	if source.Users >= source.MaxListeners {
		return nil, ErrSourceAtCapacity
	}

	now := time.Now()
	stream := &models.Stream{
		ID:                       ksuid.New().String(),
		TenantID:                 p.TenantID,
		SourceID:                 p.SourceID,
		FrequencyKHz:             p.FrequencyKHz,
		BandwidthLowHz:           p.BandwidthLowHz,
		BandwidthHighHz:          p.BandwidthHighHz,
		Mode:                     p.Mode,
		Name:                     p.Name,
		AGCOn:                    p.AGCOn,
		AGCGainDB:                p.AGCGainDB,
		BufferMinutes:            p.BufferMinutes,
		ActivityDetectionEnabled: false,
		ActivitySensitivity:      0.5,
		State:                    "created",
		CreatedAt:                now,
		UpdatedAt:                now,
	}

	_, err = db.Pool.Exec(ctx, `
		INSERT INTO streams (
			id, tenant_id, source_id, frequency_khz, bandwidth_low_hz, bandwidth_high_hz,
			mode, name, agc_on, agc_gain_db, buffer_minutes, activity_detection_enabled,
			activity_sensitivity, state, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12,
			$13, $14, $15, $16
		)
	`,
		stream.ID, stream.TenantID, stream.SourceID, stream.FrequencyKHz, stream.BandwidthLowHz, stream.BandwidthHighHz,
		stream.Mode, stream.Name, stream.AGCOn, stream.AGCGainDB, stream.BufferMinutes, stream.ActivityDetectionEnabled,
		stream.ActivitySensitivity, stream.State, stream.CreatedAt, stream.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return stream, nil
}

func (db *DB) UpdateStream(ctx context.Context, streamID, tenantID string, p UpdateStreamParams) (*models.Stream, error) {
	source, err := db.GetSourceByID(ctx, p.SourceID)
	if err != nil {
		return nil, err
	}
	if source == nil {
		return nil, ErrSourceNotFound
	}
	if !source.Available {
		return nil, ErrSourceUnavailable
	}
	if source.Users >= source.MaxListeners {
		return nil, ErrSourceAtCapacity
	}

	tag, err := db.Pool.Exec(ctx, `
		UPDATE streams
		SET source_id = $1,
		    frequency_khz = $2,
		    bandwidth_low_hz = $3,
		    bandwidth_high_hz = $4,
		    mode = $5,
		    name = $6,
		    agc_on = $7,
		    agc_gain_db = $8,
		    buffer_minutes = $9,
		    updated_at = now()
		WHERE id = $10 AND tenant_id = $11
	`, p.SourceID, p.FrequencyKHz, p.BandwidthLowHz, p.BandwidthHighHz, p.Mode, p.Name, p.AGCOn, p.AGCGainDB, p.BufferMinutes, streamID, tenantID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}
	return db.GetStreamByID(ctx, streamID)
}

func (db *DB) GetStreamByID(ctx context.Context, id string) (*models.Stream, error) {
	var stream models.Stream
	err := db.Pool.QueryRow(ctx, `
		SELECT id, tenant_id, source_id, frequency_khz, bandwidth_low_hz, bandwidth_high_hz,
		       mode, name, agc_on, agc_gain_db, buffer_minutes, activity_detection_enabled,
		       activity_sensitivity, state, created_at, updated_at
		FROM streams
		WHERE id = $1
	`, id).Scan(
		&stream.ID, &stream.TenantID, &stream.SourceID, &stream.FrequencyKHz, &stream.BandwidthLowHz, &stream.BandwidthHighHz,
		&stream.Mode, &stream.Name, &stream.AGCOn, &stream.AGCGainDB, &stream.BufferMinutes, &stream.ActivityDetectionEnabled,
		&stream.ActivitySensitivity, &stream.State, &stream.CreatedAt, &stream.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &stream, nil
}

func (db *DB) ListStreamsByTenant(ctx context.Context, tenantID string, limit, offset int) ([]models.Stream, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT id, tenant_id, source_id, frequency_khz, bandwidth_low_hz, bandwidth_high_hz,
		       mode, name, agc_on, agc_gain_db, buffer_minutes, activity_detection_enabled,
		       activity_sensitivity, state, created_at, updated_at
		FROM streams
		WHERE tenant_id = $1
		ORDER BY updated_at DESC
		LIMIT $2 OFFSET $3
	`, tenantID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	streams := make([]models.Stream, 0, limit)
	for rows.Next() {
		var stream models.Stream
		if err := rows.Scan(
			&stream.ID, &stream.TenantID, &stream.SourceID, &stream.FrequencyKHz, &stream.BandwidthLowHz, &stream.BandwidthHighHz,
			&stream.Mode, &stream.Name, &stream.AGCOn, &stream.AGCGainDB, &stream.BufferMinutes, &stream.ActivityDetectionEnabled,
			&stream.ActivitySensitivity, &stream.State, &stream.CreatedAt, &stream.UpdatedAt,
		); err != nil {
			return nil, err
		}
		streams = append(streams, stream)
	}
	return streams, rows.Err()
}

func (db *DB) UpdateStreamState(ctx context.Context, streamID, state string) error {
	tag, err := db.Pool.Exec(ctx, `UPDATE streams SET state = $1, updated_at = now() WHERE id = $2`, state, streamID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("stream %s not found", streamID)
	}
	return nil
}

func (db *DB) DeleteStream(ctx context.Context, streamID, tenantID string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `DELETE FROM streams WHERE id = $1 AND tenant_id = $2`, streamID, tenantID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
