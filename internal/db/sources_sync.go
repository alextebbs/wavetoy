package db

import (
	"context"
	"time"

	"github.com/sammy/sdr-radio/internal/sourcefetcher"
	"github.com/segmentio/ksuid"
)

// UpsertSource inserts or updates a source by host+port.
func (db *DB) UpsertSource(ctx context.Context, raw sourcefetcher.RawSource) error {
	id := ksuid.New().String()
	now := time.Now()
	lat, lon := raw.Latitude, raw.Longitude
	var latPtr, lonPtr *float64
	if lat != 0 || lon != 0 {
		latPtr, lonPtr = &lat, &lon
	}
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO sources (id, type, host, port, use_tls, latitude, longitude, name, max_listeners, available, last_synced_at, created_at, updated_at)
		VALUES ($1, 'kiwisdr', $2, $3, $4, $5, $6, $7, 4, true, $8, $9, $9)
		ON CONFLICT (host, port) DO UPDATE SET
			name = COALESCE(NULLIF(EXCLUDED.name, ''), sources.name),
			latitude = COALESCE(EXCLUDED.latitude, sources.latitude),
			longitude = COALESCE(EXCLUDED.longitude, sources.longitude),
			use_tls = (sources.use_tls OR EXCLUDED.use_tls),
			last_synced_at = $8,
			updated_at = $9
	`, id, raw.Host, raw.Port, raw.UseTLS, latPtr, lonPtr, raw.Name, now, now)
	return err
}

// SourceForHealthCheck is a minimal source row for health checking.
type SourceForHealthCheck struct {
	ID     string
	Host   string
	Port   int
	UseTLS bool
}

// ListSourceIDsForHealthCheck returns all sources for health checking.
func (db *DB) ListSourceIDsForHealthCheck(ctx context.Context) ([]SourceForHealthCheck, error) {
	rows, err := db.Pool.Query(ctx, `SELECT id, host, port, use_tls FROM sources WHERE type = 'kiwisdr'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []SourceForHealthCheck
	for rows.Next() {
		var r SourceForHealthCheck
		if err := rows.Scan(&r.ID, &r.Host, &r.Port, &r.UseTLS); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// SetSourceAvailable updates availability and last_health_check_at. Deprecated: use SetSourceStatus.
func (db *DB) SetSourceAvailable(ctx context.Context, id string, available bool) error {
	_, err := db.Pool.Exec(ctx, `UPDATE sources SET available = $1, last_health_check_at = now(), updated_at = now() WHERE id = $2`, available, id)
	return err
}

// SourceStatus is the parsed result from a KiwiSDR /status endpoint.
type SourceStatus struct {
	Available    bool
	Users        int
	MaxListeners int
	SNRDBM       *float64
	Antenna      string
	Location     string
	Grid         string
	Status       string
	AntConnected bool
	Offline      bool
	Latitude     *float64
	Longitude    *float64
	Name         string
	UseTLS       *bool
}

// SetSourceStatus updates all status-derived fields from a health check.
func (db *DB) SetSourceStatus(ctx context.Context, id string, st SourceStatus) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE sources SET
			available = $1, users = $2, max_listeners = $3, snr_dbm = $4,
			antenna = NULLIF($5, ''), location = NULLIF($6, ''), grid = NULLIF($7, ''),
			status = NULLIF($8, ''), ant_connected = $9, offline = $10,
			latitude = COALESCE($11, sources.latitude),
			longitude = COALESCE($12, sources.longitude),
			name = COALESCE(NULLIF($13, ''), sources.name),
			use_tls = COALESCE($14, sources.use_tls),
			last_health_check_at = now(), updated_at = now()
		WHERE id = $15
	`, st.Available, st.Users, st.MaxListeners, st.SNRDBM,
		st.Antenna, st.Location, st.Grid, st.Status, st.AntConnected, st.Offline,
		st.Latitude, st.Longitude, st.Name, st.UseTLS, id)
	return err
}
