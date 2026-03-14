package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL        string
	HTTPAddr           string
	KiwiSourceListURL  string   // primary
	KiwiSourceListURLs []string // for fallbacks (comma-separated in env)
	SyncInterval       time.Duration
	HealthInterval     time.Duration
}

func Load() *Config {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://localhost:5432/sdrradio?sslmode=disable"
	}
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	listURL := os.Getenv("KIWI_SOURCE_LIST_URL")
	if listURL == "" {
		listURL = "https://rx.kiwisdr.com/"
	}
	// KIWI_SOURCE_LIST_URLS can be comma-separated for fallbacks
	listURLs := strings.Split(listURL, ",")
	for i, u := range listURLs {
		listURLs[i] = strings.TrimSpace(u)
	}
	syncInterval := 6 * time.Hour
	if d := os.Getenv("SYNC_INTERVAL"); d != "" {
		if parsed, err := time.ParseDuration(d); err == nil {
			syncInterval = parsed
		}
	}
	healthInterval := 30 * time.Minute
	if d := os.Getenv("HEALTH_INTERVAL"); d != "" {
		if parsed, err := time.ParseDuration(d); err == nil {
			healthInterval = parsed
		}
	}
	return &Config{
		DatabaseURL:        dbURL,
		HTTPAddr:           addr,
		KiwiSourceListURL:  listURLs[0],
		KiwiSourceListURLs: listURLs,
		SyncInterval:       syncInterval,
		HealthInterval:     healthInterval,
	}
}
