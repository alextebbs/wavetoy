package chunkring

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
	s3client "github.com/sammy/sdr-radio/internal/s3"
)

// S3Sink implements ChunkSink by uploading completed chunks to S3 and
// recording them in the offloaded_chunks manifest table.
type S3Sink struct {
	s3       *s3client.Client
	db       *db.DB
	streamID string
	onUpload func(startedAt time.Time, endedAt time.Time, totalBytes int64)
}

func NewS3Sink(s3 *s3client.Client, database *db.DB, streamID string) *S3Sink {
	return &S3Sink{
		s3:       s3,
		db:       database,
		streamID: streamID,
	}
}

func (s *S3Sink) SetOnUpload(fn func(startedAt time.Time, endedAt time.Time, totalBytes int64)) {
	s.onUpload = fn
}

func (s *S3Sink) OnChunkComplete(chunk *Chunk) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	base := fmt.Sprintf("%s/streams/%s/%d", s.s3.Prefix(), s.streamID, chunk.StartedAt.Unix())

	var audioBuf bytes.Buffer
	if err := SerializeAudioWAV(&audioBuf, chunk); err != nil {
		return fmt.Errorf("serialize audio: %w", err)
	}
	audioSize := audioBuf.Len()
	if err := s.s3.PutObject(ctx, base+"/audio.wav", &audioBuf, "audio/wav"); err != nil {
		return err
	}

	var wfBuf bytes.Buffer
	if err := SerializeWF(&wfBuf, chunk); err != nil {
		return fmt.Errorf("serialize wf: %w", err)
	}
	wfSize := wfBuf.Len()
	if err := s.s3.PutObject(ctx, base+"/wf.bin", &wfBuf, "application/octet-stream"); err != nil {
		return err
	}

	var evBuf bytes.Buffer
	if err := SerializeEvents(&evBuf, chunk); err != nil {
		return fmt.Errorf("serialize events: %w", err)
	}
	evSize := evBuf.Len()
	if err := s.s3.PutObject(ctx, base+"/events.jsonl", &evBuf, "application/x-ndjson"); err != nil {
		return err
	}

	totalBytes := int64(audioSize + wfSize + evSize)

	if err := s.db.InsertOffloadedChunk(ctx, db.InsertOffloadedChunkParams{
		StreamID:  s.streamID,
		StartedAt: chunk.StartedAt,
		EndedAt:   chunk.EndedAt,
		SizeBytes: totalBytes,
		WFFrames:  len(chunk.WFFrames),
		Events:    len(chunk.Events),
	}); err != nil {
		slog.Error("s3sink: manifest insert failed", "stream", s.streamID, "err", err)
	}

	slog.Debug("s3sink: chunk uploaded",
		"stream", s.streamID,
		"started_at", chunk.StartedAt.Unix(),
		"bytes", totalBytes,
	)

	if s.onUpload != nil {
		s.onUpload(chunk.StartedAt, chunk.EndedAt, totalBytes)
	}

	return nil
}
