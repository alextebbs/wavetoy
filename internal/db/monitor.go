package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type InsertOffloadedChunkParams struct {
	StreamID  string
	StartedAt time.Time
	EndedAt   time.Time
	SizeBytes int64
	WFFrames  int
	Events    int
}

type OffloadedChunkRow struct {
	StreamID  string    `json:"stream_id"`
	StartedAt time.Time `json:"started_at"`
	EndedAt   time.Time `json:"ended_at"`
	SizeBytes int64     `json:"size_bytes"`
	WFFrames  int       `json:"wf_frames"`
	Events    int       `json:"events"`
}

type OffloadedChunkStats struct {
	Count      int       `json:"count"`
	TotalBytes int64     `json:"total_bytes"`
	Oldest     time.Time `json:"oldest"`
	Newest     time.Time `json:"newest"`
}

func (db *DB) InsertOffloadedChunk(ctx context.Context, p InsertOffloadedChunkParams) error {
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO offloaded_chunks (stream_id, started_at, ended_at, size_bytes, wf_frames, events)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (stream_id, started_at) DO NOTHING
	`, p.StreamID, p.StartedAt, p.EndedAt, p.SizeBytes, p.WFFrames, p.Events)
	return err
}

func (db *DB) ListOffloadedChunks(ctx context.Context, streamID string, from, to time.Time) ([]OffloadedChunkRow, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT stream_id, started_at, ended_at, size_bytes, wf_frames, events
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
		if err := rows.Scan(&r.StreamID, &r.StartedAt, &r.EndedAt, &r.SizeBytes, &r.WFFrames, &r.Events); err != nil {
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
		SELECT stream_id, started_at, ended_at, size_bytes, wf_frames, events
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
		if err := rows.Scan(&r.StreamID, &r.StartedAt, &r.EndedAt, &r.SizeBytes, &r.WFFrames, &r.Events); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// GetOffloadedChunkByTime returns a single offloaded chunk whose started_at
// falls within the same unix second as the given timestamp.
func (db *DB) GetOffloadedChunkByTime(ctx context.Context, streamID string, startedAt time.Time) (*OffloadedChunkRow, error) {
	truncated := startedAt.Truncate(time.Second)
	nextSecond := truncated.Add(time.Second)
	var r OffloadedChunkRow
	err := db.Pool.QueryRow(ctx, `
		SELECT stream_id, started_at, ended_at, size_bytes, wf_frames, events
		FROM offloaded_chunks
		WHERE stream_id = $1 AND started_at >= $2 AND started_at < $3
	`, streamID, truncated, nextSecond).Scan(&r.StreamID, &r.StartedAt, &r.EndedAt, &r.SizeBytes, &r.WFFrames, &r.Events)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}
