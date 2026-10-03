package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type InsertOffloadedChunkParams struct {
	StreamID    string
	StartedAt   time.Time
	EndedAt     time.Time
	SizeBytes   int64
	WFFrames    int
	Events      int
	AudioBytes  int
	StreamState int
	HealthFlags int
	InBandSNRdB *float64
}

type OffloadedChunkRow struct {
	StreamID    string    `json:"stream_id"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     time.Time `json:"ended_at"`
	SizeBytes   int64     `json:"size_bytes"`
	WFFrames    int       `json:"wf_frames"`
	Events      int       `json:"events"`
	AudioBytes  int       `json:"audio_bytes"`
	StreamState int       `json:"stream_state"`
	HealthFlags int       `json:"health_flags"`
	InBandSNRdB *float64  `json:"in_band_snr_db"`
}

type OffloadedChunkStats struct {
	Count      int       `json:"count"`
	TotalBytes int64     `json:"total_bytes"`
	Oldest     time.Time `json:"oldest"`
	Newest     time.Time `json:"newest"`
}

func (db *DB) InsertOffloadedChunk(ctx context.Context, p InsertOffloadedChunkParams) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO offloaded_chunks (stream_id, started_at, ended_at, size_bytes, wf_frames, events, audio_bytes, stream_state, health_flags, in_band_snr_db)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (stream_id, started_at) DO NOTHING
	`, p.StreamID, p.StartedAt, p.EndedAt, p.SizeBytes, p.WFFrames, p.Events, p.AudioBytes, p.StreamState, p.HealthFlags, p.InBandSNRdB)
	return err
}

func (db *DB) ListOffloadedChunks(ctx context.Context, streamID string, from, to time.Time) ([]OffloadedChunkRow, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT stream_id, started_at, ended_at, size_bytes, wf_frames, events, audio_bytes, stream_state, health_flags, in_band_snr_db
		FROM offloaded_chunks
		WHERE stream_id = $1 AND started_at >= $2 AND started_at < $3
		ORDER BY started_at ASC
	`, streamID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []OffloadedChunkRow
	for rows.Next() {
		var r OffloadedChunkRow
		if err := rows.Scan(&r.StreamID, &r.StartedAt, &r.EndedAt, &r.SizeBytes, &r.WFFrames, &r.Events, &r.AudioBytes, &r.StreamState, &r.HealthFlags, &r.InBandSNRdB); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func (db *DB) HasOffloadedChunks(ctx context.Context, streamID string) (bool, error) {
	var exists bool
	err := db.Pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM offloaded_chunks WHERE stream_id = $1)
	`, streamID).Scan(&exists)
	return exists, err
}

func (db *DB) OffloadedChunkStats(ctx context.Context, streamID string) (*OffloadedChunkStats, error) {
	var stats OffloadedChunkStats
	var oldest, newest *time.Time
	err := db.Pool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(SUM(size_bytes), 0),
		       MIN(started_at), MAX(ended_at)
		FROM offloaded_chunks
		WHERE stream_id = $1
	`, streamID).Scan(&stats.Count, &stats.TotalBytes, &oldest, &newest)
	if err != nil {
		return nil, err
	}
	if stats.Count == 0 {
		return nil, nil
	}
	stats.Oldest = *oldest
	stats.Newest = *newest
	return &stats, nil
}

func (db *DB) DeleteStreamChunksInRange(ctx context.Context, streamID string, from, to time.Time) (int64, error) {
	tag, err := db.Pool.Exec(ctx, `
		DELETE FROM offloaded_chunks
		WHERE stream_id = $1 AND started_at >= $2 AND started_at < $3
	`, streamID, from, to)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (db *DB) DeleteExpiredChunks(ctx context.Context, olderThan time.Time) (int64, error) {
	tag, err := db.Pool.Exec(ctx, `
		DELETE FROM offloaded_chunks WHERE started_at < $1
	`, olderThan)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// StreamsWithOffloading returns IDs of streams with offload_chunks enabled.
func (db *DB) StreamsWithOffloading(ctx context.Context) ([]string, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT id FROM streams WHERE offload_chunks = true
	`)
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

// AllOffloadedChunks returns all offloaded chunks for a stream, ordered by time.
func (db *DB) AllOffloadedChunks(ctx context.Context, streamID string) ([]OffloadedChunkRow, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT stream_id, started_at, ended_at, size_bytes, wf_frames, events, audio_bytes, stream_state, health_flags, in_band_snr_db
		FROM offloaded_chunks
		WHERE stream_id = $1
		ORDER BY started_at ASC
	`, streamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []OffloadedChunkRow
	for rows.Next() {
		var r OffloadedChunkRow
		if err := rows.Scan(&r.StreamID, &r.StartedAt, &r.EndedAt, &r.SizeBytes, &r.WFFrames, &r.Events, &r.AudioBytes, &r.StreamState, &r.HealthFlags, &r.InBandSNRdB); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// HourBucket holds aggregate chunk statistics for a single UTC hour.
type HourBucket struct {
	Hour       int `json:"hour"`
	ChunkCount int `json:"chunk_count"`
	WFFrames   int `json:"wf_frames"`
}

// DayBucket holds aggregate chunk statistics for a single UTC day.
type DayBucket struct {
	Date       string       `json:"date"`
	ChunkCount int          `json:"chunk_count"`
	WFFrames   int          `json:"wf_frames"`
	HasGaps    bool         `json:"has_gaps"`
	Hours      []HourBucket `json:"hours"`
}

// ChunkSummaryByHour returns per-day/per-hour aggregate chunk counts for
// offloaded chunks within the given time range. Ring-buffer chunks are not
// included — the caller merges those separately.
func (db *DB) ChunkSummaryByHour(ctx context.Context, streamID string, from, to time.Time) ([]DayBucket, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT
			to_char((started_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
			EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')::int AS hour,
			COUNT(*)::int AS chunk_count,
			COALESCE(SUM(wf_frames), 0)::int AS wf_frames
		FROM offloaded_chunks
		WHERE stream_id = $1 AND started_at >= $2 AND started_at < $3
		GROUP BY 1, 2
		ORDER BY 1, 2
	`, streamID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	dayMap := make(map[string]*DayBucket)
	var dayOrder []string

	for rows.Next() {
		var dayStr string
		var hb HourBucket
		if err := rows.Scan(&dayStr, &hb.Hour, &hb.ChunkCount, &hb.WFFrames); err != nil {
			return nil, err
		}
		bucket, ok := dayMap[dayStr]
		if !ok {
			bucket = &DayBucket{Date: dayStr}
			dayMap[dayStr] = bucket
			dayOrder = append(dayOrder, dayStr)
		}
		bucket.ChunkCount += hb.ChunkCount
		bucket.WFFrames += hb.WFFrames
		bucket.Hours = append(bucket.Hours, hb)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Detect gaps: any hour with 0 chunks between the first and last populated hour.
	for _, d := range dayMap {
		if len(d.Hours) == 0 {
			continue
		}
		occupied := make(map[int]bool, len(d.Hours))
		minH, maxH := 23, 0
		for _, h := range d.Hours {
			occupied[h.Hour] = true
			if h.Hour < minH {
				minH = h.Hour
			}
			if h.Hour > maxH {
				maxH = h.Hour
			}
		}
		for h := minH; h <= maxH; h++ {
			if !occupied[h] {
				d.HasGaps = true
				break
			}
		}
	}

	result := make([]DayBucket, 0, len(dayOrder))
	for _, k := range dayOrder {
		result = append(result, *dayMap[k])
	}
	return result, nil
}

// GetOffloadedChunkByTime returns a single offloaded chunk whose started_at
// falls within the same unix second as the given timestamp.
func (db *DB) GetOffloadedChunkByTime(ctx context.Context, streamID string, startedAt time.Time) (*OffloadedChunkRow, error) {
	truncated := startedAt.Truncate(time.Second)
	nextSecond := truncated.Add(time.Second)
	var r OffloadedChunkRow
	err := db.Pool.QueryRow(ctx, `
		SELECT stream_id, started_at, ended_at, size_bytes, wf_frames, events, audio_bytes, stream_state, health_flags, in_band_snr_db
		FROM offloaded_chunks
		WHERE stream_id = $1 AND started_at >= $2 AND started_at < $3
	`, streamID, truncated, nextSecond).Scan(&r.StreamID, &r.StartedAt, &r.EndedAt, &r.SizeBytes, &r.WFFrames, &r.Events, &r.AudioBytes, &r.StreamState, &r.HealthFlags, &r.InBandSNRdB)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}
