package sync

import (
	"context"
	"log"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/sourcefetcher"
)

// SourceSync runs the source list fetcher and upserts into the database.
type SourceSync struct {
	db             *db.DB
	fetcher        sourcefetcher.Fetcher
	allowBootstrap bool // if true, use bootstrap list when fetch fails
}

func NewSourceSync(database *db.DB, fetcher sourcefetcher.Fetcher) *SourceSync {
	return &SourceSync{db: database, fetcher: fetcher, allowBootstrap: true}
}

// NewSourceSyncStrict is like NewSourceSync but fails on fetch error (no bootstrap fallback).
func NewSourceSyncStrict(database *db.DB, fetcher sourcefetcher.Fetcher) *SourceSync {
	return &SourceSync{db: database, fetcher: fetcher, allowBootstrap: false}
}

// Run syncs sources once.
func (s *SourceSync) Run(ctx context.Context) error {
	candidates, err := s.fetcher.Fetch(ctx)
	if err != nil {
		if s.allowBootstrap {
			candidates = sourcefetcher.BootstrapSources()
			log.Printf("sync: fetch failed (%v), using bootstrap list (%d sources)", err, len(candidates))
		} else {
			return err
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	for _, raw := range candidates {
		if err := s.db.UpsertSource(ctx, raw); err != nil {
			log.Printf("sync: upsert %s:%d: %v", raw.Host, raw.Port, err)
		}
	}
	log.Printf("sync: upserted %d sources", len(candidates))
	return nil
}

// RunLoop runs sync on the given interval until ctx is done.
func (s *SourceSync) RunLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	if err := s.Run(ctx); err != nil {
		log.Printf("sync: initial run failed: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Run(ctx); err != nil {
				log.Printf("sync: %v", err)
			}
		}
	}
}
