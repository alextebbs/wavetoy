package probe

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/models"
	srcsync "github.com/sammy/sdr-radio/internal/sync"
)

const (
	DefaultMaxCandidates = 12

	// Candidate ranking weights: balance proximity vs broadband SNR.
	candidateDistanceWeight = 0.4
	candidateSNRWeight      = 0.6

	// Normalization bounds for candidate ranking.
	maxRankDistanceKm = 10000.0
	maxRankSNRdB      = 40.0
)

// BuildSortedCandidates returns all non-blacklisted sources sorted by priority:
// locked-in sources first, then by distance ascending.
// No cap is applied — the caller iterates through the list in batches.
func BuildSortedCandidates(
	ctx context.Context,
	database *db.DB,
	currentSource models.Source,
	excludeSourceID string,
	blacklist map[string]time.Time,
	lockedInIDs map[string]bool,
) ([]CandidateSource, error) {
	if currentSource.Latitude == nil || currentSource.Longitude == nil {
		return nil, nil
	}
	srcLat := *currentSource.Latitude
	srcLon := *currentSource.Longitude

	sources, _, err := database.ListMapSources(ctx)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	var candidates []CandidateSource
	for _, s := range sources {
		if s.ID == excludeSourceID {
			continue
		}
		if s.Latitude == nil || s.Longitude == nil {
			continue
		}
		if blacklist != nil {
			if expiry, ok := blacklist[s.ID]; ok && now.Before(expiry) {
				continue
			}
		}
		dist := HaversineKm(srcLat, srcLon, *s.Latitude, *s.Longitude)
		bearing := BearingDeg(srcLat, srcLon, *s.Latitude, *s.Longitude)
		candidates = append(candidates, CandidateSource{
			Source:     s,
			DistanceKm: dist,
			BearingDeg: bearing,
		})
	}

	sort.Slice(candidates, func(i, j int) bool {
		iLocked := lockedInIDs != nil && lockedInIDs[candidates[i].Source.ID]
		jLocked := lockedInIDs != nil && lockedInIDs[candidates[j].Source.ID]
		if iLocked != jLocked {
			return iLocked
		}
		return candidateRank(candidates[i]) > candidateRank(candidates[j])
	})

	return candidates, nil
}

// candidateRank computes a composite score (higher = more attractive) that
// balances geographic proximity with KiwiSDR-reported broadband SNR.
// This ensures high-SNR sources further away can outrank low-SNR sources nearby.
func candidateRank(c CandidateSource) float64 {
	// Distance score: use log scale so the difference between 10km and 100km
	// matters more than between 5000km and 6000km.
	distScore := 1.0 - math.Log1p(c.DistanceKm)/math.Log1p(maxRankDistanceKm)
	if distScore < 0 {
		distScore = 0
	}

	// SNR score: linear 0-40 dB. Sources without SNR data get 0.
	var snrScore float64
	if c.Source.SNRDBM != nil && *c.Source.SNRDBM > 0 {
		snrScore = *c.Source.SNRDBM / maxRankSNRdB
		if snrScore > 1 {
			snrScore = 1
		}
	}

	return candidateDistanceWeight*distScore + candidateSNRWeight*snrScore
}

// VerifyBatch runs /status health checks on a batch of candidates, filters for
// availability, then QuickProbes the available ones. Returns the verified
// candidates and the IDs that failed (for blacklisting).
func VerifyBatch(
	ctx context.Context,
	database *db.DB,
	healthChecker *srcsync.HealthChecker,
	batch []CandidateSource,
	freqKHz float64,
	mode string,
) (passed []CandidateSource, failedIDs []QuickProbeResult) {
	if len(batch) == 0 {
		return nil, nil
	}

	// Health-check the batch via /status
	ids := make([]string, len(batch))
	for i, c := range batch {
		ids[i] = c.Source.ID
	}
	_ = healthChecker.RunForSources(ctx, ids)

	// Re-read from DB to get fresh availability, filter
	var available []CandidateSource
	for _, c := range batch {
		src, err := database.GetSourceByID(ctx, c.Source.ID)
		if err != nil || src == nil {
			continue
		}
		if !src.Available || src.Users >= src.MaxListeners || !src.AntConnected {
			continue
		}
		c.Source = *src
		available = append(available, c)
	}

	if len(available) == 0 {
		return nil, nil
	}

	return QuickProbeMany(ctx, available, freqKHz, mode)
}
