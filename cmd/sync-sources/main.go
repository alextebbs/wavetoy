package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/sourcefetcher"
	"github.com/sammy/sdr-radio/internal/sync"
)

func main() {
	_ = godotenv.Load()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://localhost:5432/sdrradio?sslmode=disable"
	}

	listURL := os.Getenv("KIWI_PUBLIC_URL")
	if listURL == "" {
		listURL = sourcefetcher.KiwiPublicURL
	}

	// Run migrations so schema exists
	migrationsPath := filepath.Join("migrations")
	if p := os.Getenv("MIGRATIONS_PATH"); p != "" {
		migrationsPath = p
	}
	if err := db.RunMigrations(dbURL, migrationsPath); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	ctx := context.Background()
	database, err := db.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer database.Close()

	fetcher := sourcefetcher.NewKiwiPublicFetcher(listURL)
	sourceSync := sync.NewSourceSyncStrict(database, fetcher)

	log.Printf("syncing from %s", listURL)
	if err := sourceSync.Run(ctx); err != nil {
		log.Fatalf("sync: %v", err)
	}
	log.Println("sync complete")
}
