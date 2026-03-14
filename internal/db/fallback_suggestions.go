package db

import (
	"context"
	"encoding/json"
	"time"
)

type FallbackSuggestionRow struct {
	StreamID        string          `json:"stream_id"`
	SourceID        string          `json:"source_id"`
	SourceName      string          `json:"source_name"`
	SourceHost      string          `json:"source_host"`
	SourcePort      int             `json:"source_port"`
	Rank            int             `json:"rank"`
	Score           float64         `json:"score"`
	DistanceKm      float64         `json:"distance_km"`
	ProbeMetrics    json.RawMessage `json:"probe_metrics"`
	LastProbed      time.Time       `json:"last_probed"`
	CreatedAt       time.Time       `json:"created_at"`
	ProbeAudio      []byte          `json:"-"`
	ProbeSampleRate int             `json:"-"`
}

func (db *DB) UpsertFallbackSuggestions(ctx context.Context, streamID string, suggestions []FallbackSuggestionRow) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `DELETE FROM fallback_suggestions WHERE stream_id = $1`, streamID)
	if err != nil {
		return err
	}

	for _, s := range suggestions {
		_, err = tx.Exec(ctx, `
			INSERT INTO fallback_suggestions (stream_id, source_id, rank, score, distance_km, probe_metrics, last_probed, probe_audio, probe_sample_rate)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		`, s.StreamID, s.SourceID, s.Rank, s.Score, s.DistanceKm, s.ProbeMetrics, s.LastProbed, s.ProbeAudio, s.ProbeSampleRate)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (db *DB) DeleteFallbackSuggestions(ctx context.Context, streamID string) error {
	_, err := db.Pool.Exec(ctx, `DELETE FROM fallback_suggestions WHERE stream_id = $1`, streamID)
	return err
}

func (db *DB) UpdateStreamRefAudio(ctx context.Context, streamID string, audio []byte, sampleRate int) error {
	_, err := db.Pool.Exec(ctx, `
		UPDATE streams SET ref_audio = $1, ref_audio_sample_rate = $2, ref_audio_at = now() WHERE id = $3
	`, audio, sampleRate, streamID)
	return err
}

func (db *DB) GetStreamRefAudio(ctx context.Context, streamID string) ([]byte, int, error) {
	var audio []byte
	var sampleRate int
	err := db.Pool.QueryRow(ctx, `
		SELECT ref_audio, ref_audio_sample_rate FROM streams WHERE id = $1
	`, streamID).Scan(&audio, &sampleRate)
	if err != nil {
		return nil, 0, err
	}
	return audio, sampleRate, nil
}

type FallbackProbeAudio struct {
	Audio      []byte
	SampleRate int
	SourceID   string
	LastProbed time.Time
}

func (db *DB) GetFallbackProbeAudio(ctx context.Context, streamID string, rank int) (*FallbackProbeAudio, error) {
	var r FallbackProbeAudio
	err := db.Pool.QueryRow(ctx, `
		SELECT probe_audio, probe_sample_rate, source_id, last_probed FROM fallback_suggestions WHERE stream_id = $1 AND rank = $2
	`, streamID, rank).Scan(&r.Audio, &r.SampleRate, &r.SourceID, &r.LastProbed)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (db *DB) ListFallbackSuggestions(ctx context.Context, streamID string) ([]FallbackSuggestionRow, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT fs.stream_id, fs.source_id, COALESCE(s.name, ''), COALESCE(s.host, ''), COALESCE(s.port, 0),
		       fs.rank, fs.score, fs.distance_km, fs.probe_metrics, fs.last_probed, fs.created_at
		FROM fallback_suggestions fs
		LEFT JOIN sources s ON s.id = fs.source_id
		WHERE fs.stream_id = $1
		ORDER BY fs.rank
	`, streamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []FallbackSuggestionRow
	for rows.Next() {
		var r FallbackSuggestionRow
		if err := rows.Scan(&r.StreamID, &r.SourceID, &r.SourceName, &r.SourceHost, &r.SourcePort,
			&r.Rank, &r.Score, &r.DistanceKm, &r.ProbeMetrics, &r.LastProbed, &r.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
