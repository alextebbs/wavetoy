package main

import (
	"context"
	"log"
	"os"

	"github.com/joho/godotenv"
	"github.com/sammy/sdr-radio/internal/db"
	srcsync "github.com/sammy/sdr-radio/internal/sync"
)

func main() {
	_ = godotenv.Load()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@localhost:5432/sdrradio?sslmode=disable"
	}
	ctx := context.Background()
	database, err := db.New(ctx, dbURL)
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()
	hc := srcsync.NewHealthChecker(database)
	if err := hc.Run(ctx); err != nil {
		log.Fatal(err)
	}
	log.Println("health check complete")
}
