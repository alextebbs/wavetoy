package sourcefetcher

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const KiwiPublicURL = "http://kiwisdr.com/.public/"

// KiwiPublicFetcher discovers KiwiSDR hosts from kiwisdr.com/.public/.
// We intentionally only ingest host+port here. Metadata is populated by health checks.
type KiwiPublicFetcher struct {
	URL    string
	Client *http.Client
}

func NewKiwiPublicFetcher(listURL string) *KiwiPublicFetcher {
	if listURL == "" {
		listURL = KiwiPublicURL
	}
	return &KiwiPublicFetcher{
		URL: listURL,
		Client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// urlPattern matches http(s)://host:port or http(s)://host (port optional)
// Captures host (domain or IP), optional port.
var urlPattern = regexp.MustCompile(`https?://([a-zA-Z0-9][-a-zA-Z0-9.]*[a-zA-Z0-9]|\d+\.\d+\.\d+\.\d+)(?::(\d+))?`)

func (f *KiwiPublicFetcher) Fetch(ctx context.Context) ([]RawSource, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "sdr-radio/1.0 (KiwiSDR source sync)")

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch: status %d", resp.StatusCode)
	}

	body := make([]byte, 0, 1024*1024)
	buf := make([]byte, 64*1024)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if n == 0 || err != nil {
			break
		}
	}

	return f.parse(body), nil
}

func (f *KiwiPublicFetcher) parse(body []byte) []RawSource {
	text := string(body)
	seen := make(map[string]bool)
	var sources []RawSource
	matches := urlPattern.FindAllStringSubmatch(text, -1)
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
		if port < 1024 || port > 65535 {
			continue
		}

		key := fmt.Sprintf("%s:%d", host, port)
		if seen[key] {
			continue
		}
		seen[key] = true

		sources = append(sources, RawSource{
			Host:   host,
			Port:   port,
			Name:   key,   // display fallback; health check fills canonical name
			UseTLS: false, // learned by health probe, not trusted from source page
		})
	}

	return sources
}

// ValidateURL checks that the fetcher URL is reachable.
func (f *KiwiPublicFetcher) ValidateURL() error {
	u, err := url.Parse(f.URL)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("invalid scheme: %s", u.Scheme)
	}
	return nil
}
