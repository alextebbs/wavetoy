package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/sammy/sdr-radio/internal/api"
	"github.com/sammy/sdr-radio/internal/config"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/sync"
)

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	// Run migrations
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

	if err := database.Seed(ctx); err != nil {
		log.Fatalf("seed: %v", err)
	}

	// Health check only. Source sync is manual: run `go run ./cmd/sync-sources` to populate from kiwisdr.com/.public/
	healthChecker := sync.NewHealthChecker(database)
	go func() {
		// Run health check shortly after first sync, then on interval
		time.Sleep(30 * time.Second)
		ticker := time.NewTicker(cfg.HealthInterval)
		defer ticker.Stop()
		for {
			if err := healthChecker.Run(ctx); err != nil {
				log.Printf("health: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	srv := api.New(database)

	httpServer := &http.Server{Addr: cfg.HTTPAddr, Handler: srv.Router()}
	go func() {
		log.Printf("listening on %s", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down...")
	httpServer.Shutdown(context.Background())
}
