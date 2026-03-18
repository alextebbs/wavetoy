package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sammy/sdr-radio/internal/interpreter"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/segmentio/ksuid"
)

var (
	ErrSourceNotFound    = errors.New("source not found")
	ErrSourceUnavailable = errors.New("source unavailable")
	ErrSourceAtCapacity  = errors.New("source at listener capacity")
	ErrVersionConflict   = errors.New("version conflict")
	ErrTenantAtCapacity  = errors.New("tenant stream limit reached")
)

const DefaultMaxStreamsPerTenant = 5

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
	SourceID         string
	FrequencyKHz     float64
	BandwidthLowHz   int
	BandwidthHighHz  int
	Mode             string
	Name             string
	AGCOn            bool
	AGCGainDB        *float64
	BufferMinutes    int
	Filters          models.FilterConfig
	Interpreter      interpreter.Config
	AutoFallback     bool
	ViewLocked       bool
}

func (db *DB) CreateStream(ctx context.Context, p CreateStreamParams) (*models.Stream, error) {
	var count int
	err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM streams WHERE tenant_id = $1`, p.TenantID).Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("count tenant streams: %w", err)
	}

	maxStreams := DefaultMaxStreamsPerTenant
	var tenantMax *int
	_ = db.Pool.QueryRow(ctx, `SELECT max_streams FROM tenants WHERE id = $1`, p.TenantID).Scan(&tenantMax)
	if tenantMax != nil {
		maxStreams = *tenantMax
	}

	if count >= maxStreams {
		return nil, ErrTenantAtCapacity
	}

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
		State:                    "created",
		Version:                  1,
		CreatedAt:                now,
		UpdatedAt:                now,
	}

	_, err = db.Pool.Exec(ctx, `
		INSERT INTO streams (
			id, tenant_id, source_id, frequency_khz, bandwidth_low_hz, bandwidth_high_hz,
			mode, name, agc_on, agc_gain_db, buffer_minutes,
			state, version, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11,
			$12, $13, $14, $15
		)
	`,
		stream.ID, stream.TenantID, stream.SourceID, stream.FrequencyKHz, stream.BandwidthLowHz, stream.BandwidthHighHz,
		stream.Mode, stream.Name, stream.AGCOn, stream.AGCGainDB, stream.BufferMinutes,
		stream.State, stream.Version, stream.CreatedAt, stream.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return stream, nil
}

// UpdateStream applies an update. If baseVersion > 0, it performs an atomic
// compare-and-swap: the update only succeeds when the current DB version
// matches baseVersion. On mismatch, ErrVersionConflict is returned.
// If baseVersion == 0, the version check is skipped (REST compat).
func (db *DB) UpdateStream(ctx context.Context, streamID, tenantID string, p UpdateStreamParams, baseVersion int64) (*models.Stream, error) {
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

	// Only enforce capacity when switching to a different source.
	// If the stream is already on this source, we already hold a connection
	// and shouldn't be blocked by other listeners filling it up.
	if source.Users >= source.MaxListeners {
		var currentSourceID string
		qErr := db.Pool.QueryRow(ctx,
			`SELECT source_id FROM streams WHERE id = $1 AND tenant_id = $2`,
			streamID, tenantID,
		).Scan(&currentSourceID)
		if qErr != nil || currentSourceID != p.SourceID {
			return nil, ErrSourceAtCapacity
		}
	}

	filtersJSON, jsonErr := p.Filters.Value()
	if jsonErr != nil {
		return nil, jsonErr
	}
	interpreterJSON, jsonErr := p.Interpreter.Value()
	if jsonErr != nil {
		return nil, jsonErr
	}

	var tag pgconn.CommandTag
	if baseVersion > 0 {
		tag, err = db.Pool.Exec(ctx, `
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
			    filters = $10,
			    interpreter = $11,
			    auto_fallback = $12,
			    view_locked = $13,
			    version = version + 1,
			    updated_at = now()
			WHERE id = $14 AND tenant_id = $15 AND version = $16
		`, p.SourceID, p.FrequencyKHz, p.BandwidthLowHz, p.BandwidthHighHz, p.Mode, p.Name, p.AGCOn, p.AGCGainDB, p.BufferMinutes, filtersJSON, interpreterJSON, p.AutoFallback, p.ViewLocked, streamID, tenantID, baseVersion)
	} else {
		tag, err = db.Pool.Exec(ctx, `
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
			    filters = $10,
			    interpreter = $11,
			    auto_fallback = $12,
			    view_locked = $13,
			    version = version + 1,
			    updated_at = now()
			WHERE id = $14 AND tenant_id = $15
		`, p.SourceID, p.FrequencyKHz, p.BandwidthLowHz, p.BandwidthHighHz, p.Mode, p.Name, p.AGCOn, p.AGCGainDB, p.BufferMinutes, filtersJSON, interpreterJSON, p.AutoFallback, p.ViewLocked, streamID, tenantID)
	}
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		if baseVersion > 0 {
			existing, getErr := db.GetStreamByID(ctx, streamID)
			if getErr != nil {
				return nil, getErr
			}
			if existing != nil {
				return nil, ErrVersionConflict
			}
		}
		return nil, nil
	}
	return db.GetStreamByID(ctx, streamID)
}

func (db *DB) GetStreamByID(ctx context.Context, id string) (*models.Stream, error) {
	var stream models.Stream
	err := db.Pool.QueryRow(ctx, `
		SELECT id, tenant_id, source_id, frequency_khz, bandwidth_low_hz, bandwidth_high_hz,
		       mode, name, agc_on, agc_gain_db, buffer_minutes,
		       state, version, filters, interpreter, wf_view_start_khz, wf_view_end_khz,
		       auto_fallback, view_locked,
		       created_at, updated_at
		FROM streams
		WHERE id = $1
	`, id).Scan(
		&stream.ID, &stream.TenantID, &stream.SourceID, &stream.FrequencyKHz, &stream.BandwidthLowHz, &stream.BandwidthHighHz,
		&stream.Mode, &stream.Name, &stream.AGCOn, &stream.AGCGainDB, &stream.BufferMinutes,
		&stream.State, &stream.Version, &stream.Filters, &stream.Interpreter, &stream.WFViewStartKHz, &stream.WFViewEndKHz,
		&stream.AutoFallback, &stream.ViewLocked,
		&stream.CreatedAt, &stream.UpdatedAt,
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
		       mode, name, agc_on, agc_gain_db, buffer_minutes,
		       state, version, filters, interpreter, wf_view_start_khz, wf_view_end_khz,
		       auto_fallback, view_locked,
		       created_at, updated_at
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
			&stream.Mode, &stream.Name, &stream.AGCOn, &stream.AGCGainDB, &stream.BufferMinutes,
			&stream.State, &stream.Version, &stream.Filters, &stream.Interpreter, &stream.WFViewStartKHz, &stream.WFViewEndKHz,
			&stream.AutoFallback, &stream.ViewLocked,
			&stream.CreatedAt, &stream.UpdatedAt,
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

func (db *DB) UpdateStreamView(ctx context.Context, streamID string, startKHz, endKHz float64) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE streams SET wf_view_start_khz = $1, wf_view_end_khz = $2 WHERE id = $3
	`, startKHz, endKHz, streamID)
	return err
}

func (db *DB) DeleteStream(ctx context.Context, streamID, tenantID string) (bool, error) {
	tag, err := db.Pool.Exec(ctx, `DELETE FROM streams WHERE id = $1 AND tenant_id = $2`, streamID, tenantID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
