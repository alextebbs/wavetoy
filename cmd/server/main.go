package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"os/signal"

	"github.com/joho/godotenv"
	"github.com/sammy/sdr-radio/internal/api"
	"github.com/sammy/sdr-radio/internal/auth"
	"github.com/sammy/sdr-radio/internal/chunkring"
	"github.com/sammy/sdr-radio/internal/config"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/probe"
	"github.com/sammy/sdr-radio/internal/interpreter"
	s3client "github.com/sammy/sdr-radio/internal/s3"
	"github.com/sammy/sdr-radio/internal/startup"
	"github.com/sammy/sdr-radio/internal/streamlog"
	srcsync "github.com/sammy/sdr-radio/internal/sync"
	wsperpool "github.com/sammy/sdr-radio/internal/whisper"
)

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	if cfg.JWTSecret == "" {
		log.Fatal("JWT_SECRET is required")
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))

	migrationsPath := filepath.Join("migrations")
	if p := os.Getenv("MIGRATIONS_PATH"); p != "" {
		migrationsPath = p
	}
	if err := db.RunMigrations(cfg.DatabaseURL, migrationsPath); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	ctx := context.Background()
	database, err := db.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer database.Close()

	var passphraseHash string
	if cfg.DefaultPassphrase != "" {
		h, err := auth.HashPassphrase(cfg.DefaultPassphrase)
		if err != nil {
			log.Fatalf("hash passphrase: %v", err)
		}
		passphraseHash = h
	}
	if err := database.Seed(ctx, passphraseHash); err != nil {
		log.Fatalf("seed: %v", err)
	}

	streamLogger := streamlog.New()

	healthChecker := srcsync.NewHealthChecker(database)
	go func() {
		time.Sleep(30 * time.Second)
		ticker := time.NewTicker(cfg.HealthInterval)
		defer ticker.Stop()
		for {
			if err := healthChecker.Run(ctx); err != nil {
				slog.Error("health check", "err", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	srv := api.New(database, streamLogger, cfg.JWTSecret, cfg.JWTExpiry)

	probeMgr := probe.NewManager(database, streamLogger, healthChecker, srv.StreamManager(), func(streamID string, event map[string]any) {
		srv.BroadcastToStream(streamID, event)
	})
	srv.SetProbeManager(probeMgr)
	srv.StreamManager().SetOnDegraded(func(streamID, reason string) {
		probeMgr.HandleDegraded(streamID, reason)
	})
	srv.StreamManager().SetOnSuggestionSNR(func(streamID string) (float64, bool) {
		suggestions, err := probeMgr.GetSuggestions(context.Background(), streamID)
		if err != nil || len(suggestions) == 0 {
			return 0, false
		}
		return suggestions[0].InBandSNRdB, true
	})
	srv.StreamManager().SetOnIsFavorite(func(streamID, sourceID string) bool {
		stream, err := database.GetStreamByID(context.Background(), streamID)
		if err != nil || stream == nil {
			return false
		}
		favs, err := database.ListFavoriteSourceIDs(context.Background(), stream.TenantID)
		if err != nil {
			return false
		}
		for _, id := range favs {
			if id == sourceID {
				return true
			}
		}
		return false
	})
	probeMgr.SetGetBlacklist(func(streamID string) map[string]time.Time {
		mon := srv.StreamManager().GetQualityMonitor(streamID)
		if mon == nil {
			return nil
		}
		return mon.Blacklist()
	})
	probeMgr.SetBlacklistSource(func(streamID, sourceID string) {
		mon := srv.StreamManager().GetQualityMonitor(streamID)
		if mon != nil {
			mon.BlacklistSource(sourceID)
		}
	})
	srv.StreamManager().SetOnStateChange(func(streamID, state string, health []string) {
		srv.BroadcastToStream(streamID, map[string]any{
			"type":      "stream_state_changed",
			"stream_id": streamID,
			"state":     state,
			"health":    health,
		})
	})
	srv.StreamManager().SetOnInterpreterOutput(func(streamID string, output interpreter.Output) {
		srv.BroadcastToStream(streamID, map[string]any{
			"type":    "interpreter_output",
			"payload": output,
		})
	})
	srv.StreamManager().SetOnChunkComplete(func(streamID string, meta chunkring.ChunkMeta) {
		var endedAt int64
		if meta.EndedAt != nil {
			endedAt = meta.EndedAt.Unix()
		}
		evt := map[string]any{
			"type":        "chunk_complete",
			"index":       meta.Index,
			"started_at":  meta.StartedAt.Unix(),
			"ended_at":    endedAt,
			"source_id":   meta.SourceID,
			"wf_frames":   meta.WFFrames,
			"audio_bytes": meta.AudioBytes,
		}
		if meta.InBandSNRdB != nil {
			evt["in_band_snr_db"] = *meta.InBandSNRdB
			evt["has_activity"] = *meta.InBandSNRdB >= 6.0
		}
		srv.BroadcastToStream(streamID, evt)
	})

	// Register whisper pool for voice interpreter
	if os.Getenv("DISABLE_WHISPER") == "1" {
		slog.Info("whisper disabled via DISABLE_WHISPER=1")
	} else {
		modelsDir := filepath.Join("data", "whisper-models")
		if wsperpool.Available() {
			pool := wsperpool.NewPool(modelsDir, "small")
			defer pool.Close()
			interpreter.RegisterWhisperPool(pool)
			slog.Info("whisper pool registered", "models_dir", modelsDir)
		} else {
			slog.Info("whisper not available (build with -tags whisper to enable voice interpreter)")
		}
	}

	s3c := s3client.NewFromEnv()
	if s3c != nil {
		s3c.EnsureBucket(ctx)
		srv.StreamManager().SetS3Client(s3c)
		slog.Info("s3: configured", "bucket", s3c.Bucket(), "prefix", s3c.Prefix())
	} else {
		slog.Info("s3: not configured (chunk offloading unavailable)")
	}

	startup.Run(ctx, startup.Deps{
		DB:          database,
		StreamMgr:   srv.StreamManager(),
		ProbeMgr: probeMgr,
	})

	go func() {
		retentionDays := 30
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			cutoff := time.Now().AddDate(0, 0, -retentionDays)
			deleted, err := database.DeleteExpiredChunks(ctx, cutoff)
			if err != nil {
				slog.Error("retention: delete expired chunks", "err", err)
			} else if deleted > 0 {
				slog.Info("retention: cleaned expired chunk manifest rows", "deleted", deleted)
			}
			snrDeleted, err := database.DeleteExpiredSNRReadings(ctx, cutoff)
			if err != nil {
				slog.Error("retention: delete expired snr readings", "err", err)
			} else if snrDeleted > 0 {
				slog.Info("retention: cleaned expired snr readings", "deleted", snrDeleted)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	httpServer := &http.Server{Addr: cfg.HTTPAddr, Handler: srv.Router()}
	go func() {
		slog.Info("listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	slog.Info("shutting down")
	httpServer.Shutdown(context.Background())
}
