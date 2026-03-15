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
	"github.com/sammy/sdr-radio/internal/config"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/fallback"
	"github.com/sammy/sdr-radio/internal/interpreter"
	"github.com/sammy/sdr-radio/internal/streamlog"
	srcsync "github.com/sammy/sdr-radio/internal/sync"
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

	fallbackMgr := fallback.NewManager(database, streamLogger, healthChecker, srv.StreamManager(), func(streamID string, event map[string]any) {
		srv.BroadcastToStream(streamID, event)
	})
	srv.SetFallbackManager(fallbackMgr)
	srv.StreamManager().SetOnDegraded(func(streamID, reason string) {
		fallbackMgr.HandleDegraded(streamID, reason)
	})
	srv.StreamManager().SetOnStateChange(func(streamID, state string) {
		srv.BroadcastToStream(streamID, map[string]any{
			"type":  "stream_state_changed",
			"state": state,
		})
	})
	srv.StreamManager().SetOnInterpreterOutput(func(streamID string, output interpreter.Output) {
		srv.BroadcastToStream(streamID, map[string]any{
			"type":    "interpreter_output",
			"payload": output,
		})
	})

	go func() {
		streams, err := database.ListStreamsByTenant(ctx, db.DefaultTenantID, 100, 0)
		if err != nil {
			slog.Error("fallback: list streams", "err", err)
			return
		}
		for _, stream := range streams {
			if stream.AutoFallback {
				fallbackMgr.Enable(ctx, stream.ID)
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
