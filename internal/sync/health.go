package sync

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
)

const defaultConcurrency = 100

// HealthChecker fetches /status from each source and updates the DB.
type HealthChecker struct {
	db          *db.DB
	concurrency int
	client      *http.Client
}

func NewHealthChecker(database *db.DB) *HealthChecker {
	return &HealthChecker{
		db:          database,
		concurrency: defaultConcurrency,
		client:      &http.Client{Timeout: 10 * time.Second},
	}
}

// NewHealthCheckerWithConcurrency sets max concurrent probes (default 100).
func NewHealthCheckerWithConcurrency(database *db.DB, concurrency int) *HealthChecker {
	if concurrency <= 0 {
		concurrency = defaultConcurrency
	}
	return &HealthChecker{
		db:          database,
		concurrency: concurrency,
		client:      &http.Client{Timeout: 10 * time.Second},
	}
}

// Run checks all sources once, concurrently.
func (h *HealthChecker) Run(ctx context.Context) error {
	sources, err := h.db.ListSourceIDsForHealthCheck(ctx)
	if err != nil {
		return err
	}
	if len(sources) == 0 {
		return nil
	}

	sem := make(chan struct{}, h.concurrency)
	var wg sync.WaitGroup
	for _, s := range sources {
		wg.Add(1)
		go func(src db.SourceForHealthCheck) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			st := h.fetchStatus(ctx, src.Host, src.Port, src.UseTLS)
			if err := h.db.SetSourceStatus(ctx, src.ID, st); err != nil {
				log.Printf("health: set %s: %v", src.ID, err)
			}
		}(s)
	}
	wg.Wait()

	log.Printf("health: checked %d sources", len(sources))
	return nil
}

// RunForSources checks a specific set of sources by ID, concurrently.
func (h *HealthChecker) RunForSources(ctx context.Context, sourceIDs []string) error {
	if len(sourceIDs) == 0 {
		return nil
	}
	allSources, err := h.db.ListSourceIDsForHealthCheck(ctx)
	if err != nil {
		return err
	}
	idSet := make(map[string]struct{}, len(sourceIDs))
	for _, id := range sourceIDs {
		idSet[id] = struct{}{}
	}

	var targets []db.SourceForHealthCheck
	for _, s := range allSources {
		if _, ok := idSet[s.ID]; ok {
			targets = append(targets, s)
		}
	}

	sem := make(chan struct{}, h.concurrency)
	var wg sync.WaitGroup
	for _, s := range targets {
		wg.Add(1)
		go func(src db.SourceForHealthCheck) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			st := h.fetchStatus(ctx, src.Host, src.Port, src.UseTLS)
			if err := h.db.SetSourceStatus(ctx, src.ID, st); err != nil {
				log.Printf("health: set %s: %v", src.ID, err)
			}
		}(s)
	}
	wg.Wait()
	return nil
}

func (h *HealthChecker) fetchStatus(ctx context.Context, host string, port int, useTLS bool) db.SourceStatus {
	// Probe both schemes and persist whichever succeeds.
	// Prefer the previously known scheme first for lower latency.
	schemes := []string{"http", "https"}
	if useTLS {
		schemes = []string{"https", "http"}
	}

	for _, scheme := range schemes {
		st, ok := h.fetchStatusForScheme(ctx, host, port, scheme)
		if ok {
			return st
		}
	}

	return db.SourceStatus{Available: false}
}

func (h *HealthChecker) fetchStatusForScheme(ctx context.Context, host string, port int, scheme string) (db.SourceStatus, bool) {
	url := fmt.Sprintf("%s://%s:%d/status", scheme, host, port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return db.SourceStatus{}, false
	}
	req.Header.Set("User-Agent", "sdr-radio/1.0")

	resp, err := h.client.Do(req)
	if err != nil {
		return db.SourceStatus{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return db.SourceStatus{}, false
	}

	body := make([]byte, 0, 4096)
	buf := make([]byte, 512)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if n == 0 || err != nil {
			break
		}
	}

	st := parseStatus(string(body))
	useTLS := scheme == "https"
	st.UseTLS = &useTLS
	return st, true
}

func parseStatus(body string) db.SourceStatus {
	kv := make(map[string]string)
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if idx := strings.Index(line, "="); idx > 0 {
			k := strings.TrimSpace(line[:idx])
			v := strings.TrimSpace(line[idx+1:])
			kv[k] = v
		}
	}

	st := db.SourceStatus{
		Available:    kv["status"] == "active" && kv["offline"] != "yes",
		AntConnected: kv["ant_connected"] == "1",
		Offline:      kv["offline"] == "yes",
		Status:       kv["status"],
		Name:         kv["name"],
		Location:     kv["loc"],
		Grid:         kv["grid"],
		Antenna:      kv["antenna"],
	}

	if v := kv["users"]; v != "" {
		st.Users, _ = strconv.Atoi(v)
	}
	if v := kv["users_max"]; v != "" {
		st.MaxListeners, _ = strconv.Atoi(v)
	}
	if st.MaxListeners == 0 {
		st.MaxListeners = 4
	}

	// snr is "50,51" - take average
	if v := kv["snr"]; v != "" {
		parts := strings.Split(v, ",")
		var sum float64
		var n int
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if f, err := strconv.ParseFloat(p, 64); err == nil {
				sum += f
				n++
			}
		}
		if n > 0 {
			avg := sum / float64(n)
			st.SNRDBM = &avg
		}
	}

	// gps=(51.317266, -2.950479)
	if v := kv["gps"]; v != "" {
		v = strings.TrimPrefix(v, "(")
		v = strings.TrimSuffix(v, ")")
		parts := strings.Split(v, ",")
		if len(parts) >= 2 {
			if lat, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64); err == nil {
				st.Latitude = &lat
			}
			if lon, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64); err == nil {
				st.Longitude = &lon
			}
		}
	}

	return st
}
