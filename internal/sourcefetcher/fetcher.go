package sourcefetcher

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RawSource is a source as returned by an external list (host, port, name, etc.)
type RawSource struct {
	Host      string  `json:"host"`
	Port      int     `json:"port"`
	Name      string  `json:"name"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	UseTLS    bool    `json:"use_tls"`
}

// Fetcher fetches KiwiSDR source lists from the public web.
type Fetcher interface {
	Fetch(ctx context.Context) ([]RawSource, error)
}

// HTTPFetcher fetches from a configurable URL. Supports:
// - JSON array: [{"host":"...","port":8073,"name":"..."}]
// - JSON object with "receivers" or "sources" key
// - HTML: scrapes links matching http(s)://host:port/ pattern
type HTTPFetcher struct {
	URL    string
	Client *http.Client
}

func NewHTTPFetcher(listURL string) *HTTPFetcher {
	if listURL == "" {
		listURL = "https://rx.kiwisdr.com/"
	}
	return &HTTPFetcher{
		URL: listURL,
		Client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// MultiURLFetcher tries multiple URLs until one succeeds.
func MultiURLFetcher(urls ...string) Fetcher {
	fetchers := make([]*HTTPFetcher, len(urls))
	for i, u := range urls {
		fetchers[i] = NewHTTPFetcher(u)
	}
	return &multiFetcher{fetchers: fetchers}
}

type multiFetcher struct {
	fetchers []*HTTPFetcher
}

func (m *multiFetcher) Fetch(ctx context.Context) ([]RawSource, error) {
	var lastErr error
	for _, f := range m.fetchers {
		sources, err := f.Fetch(ctx)
		if err == nil && len(sources) > 0 {
			return sources, nil
		}
		if err != nil {
			lastErr = err
			log.Printf("sourcefetcher: %s: %v", f.URL, err)
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("all fetchers failed")
}

// BootstrapSources returns a minimal list when the primary fetch fails (e.g. rx.kiwisdr.com down).
func BootstrapSources() []RawSource {
	return []RawSource{
		{Host: "kiwi.radioplayer.co.uk", Port: 8073, Name: "UK RadioPlayer"},
		{Host: "kiwi.radioplayer.co.uk", Port: 8074, Name: "UK RadioPlayer 2"},
		{Host: "sdr.ewb.us", Port: 8073, Name: "EWB US"},
	}
}

func (f *HTTPFetcher) Fetch(ctx context.Context) ([]RawSource, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "sdr-radio/1.0")

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch: status %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	body := make([]byte, 0, 512*1024)
	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if n == 0 || err != nil {
			break
		}
	}

	// Try JSON first
	if strings.Contains(contentType, "json") || json.Valid(body) {
		sources, err := f.parseJSON(body)
		if err == nil && len(sources) > 0 {
			return sources, nil
		}
		if err != nil {
			log.Printf("sourcefetcher: JSON parse failed: %v", err)
		}
	}

	// Fall back to HTML scraping
	sources := f.parseHTML(body)
	if len(sources) > 0 {
		return sources, nil
	}

	return nil, fmt.Errorf("no sources found at %s", f.URL)
}

func (f *HTTPFetcher) parseJSON(body []byte) ([]RawSource, error) {
	var decoded interface{}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}

	var items []interface{}
	switch v := decoded.(type) {
	case []interface{}:
		items = v
	case map[string]interface{}:
		for _, key := range []string{"receivers", "sources", "kiwis", "list"} {
			if arr, ok := v[key].([]interface{}); ok {
				items = arr
				break
			}
		}
	}
	if items == nil {
		return nil, fmt.Errorf("unexpected JSON structure")
	}

	var sources []RawSource
	for _, item := range items {
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		host, _ := obj["host"].(string)
		if host == "" {
			host, _ = obj["url"].(string)
			if host != "" {
				if u, err := url.Parse(host); err == nil {
					host = u.Hostname()
					if p := u.Port(); p != "" {
						if port, err := strconv.Atoi(p); err == nil {
							obj["port"] = float64(port)
						}
					}
				}
			}
		}
		port := 8073
		if p, ok := obj["port"].(float64); ok {
			port = int(p)
		}
		if host == "" || port <= 0 {
			continue
		}
		name, _ := obj["name"].(string)
		if name == "" {
			name = fmt.Sprintf("%s:%d", host, port)
		}
		lat, _ := obj["latitude"].(float64)
		lon, _ := obj["longitude"].(float64)
		useTLS, _ := obj["use_tls"].(bool)
		sources = append(sources, RawSource{
			Host:      host,
			Port:      port,
			Name:      name,
			Latitude:  lat,
			Longitude: lon,
			UseTLS:    useTLS,
		})
	}
	return sources, nil
}

// kiwiLink matches http(s)://host:port/ or host:port
var kiwiLinkRE = regexp.MustCompile(`(?i)(?:https?://)?([a-z0-9][-a-z0-9.]*[a-z0-9])(?::(\d{4,5}))?`)

func (f *HTTPFetcher) parseHTML(body []byte) []RawSource {
	seen := make(map[string]bool)
	var sources []RawSource
	matches := kiwiLinkRE.FindAllStringSubmatch(string(body), -1)
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		host := strings.TrimSpace(m[1])
		port := 8073
		if len(m) >= 3 && m[2] != "" {
			if p, err := strconv.Atoi(m[2]); err == nil && p > 0 && p < 65536 {
				port = p
			}
		}
		// Skip common non-Kiwi hosts
		if strings.Contains(host, "kiwisdr.com") && !strings.HasPrefix(host, "kiwi") {
			continue
		}
		key := fmt.Sprintf("%s:%d", host, port)
		if seen[key] {
			continue
		}
		seen[key] = true
		sources = append(sources, RawSource{
			Host: host,
			Port: port,
			Name: key,
		})
	}
	return sources
}
