package fallback

import (
	"context"
	"sort"

	"github.com/sammy/sdr-radio/internal/db"
	"github.com/sammy/sdr-radio/internal/models"
)

const (
	DefaultMaxCandidates = 5
	DefaultMaxRadiusKm   = 2000.0
)

func DiscoverCandidates(ctx context.Context, database *db.DB, currentSource models.Source, excludeSourceID string, maxCandidates int, maxRadiusKm float64) ([]CandidateSource, error) {
	if maxCandidates <= 0 {
		maxCandidates = DefaultMaxCandidates
	}
	if maxRadiusKm <= 0 {
		maxRadiusKm = DefaultMaxRadiusKm
	}

	if currentSource.Latitude == nil || currentSource.Longitude == nil {
		return nil, nil
	}
	srcLat := *currentSource.Latitude
	srcLon := *currentSource.Longitude

	sources, _, err := database.ListMapSources(ctx)
	if err != nil {
		return nil, err
	}

	var candidates []CandidateSource
	for _, s := range sources {
		if s.ID == excludeSourceID {
			continue
		}
		if s.Latitude == nil || s.Longitude == nil {
			continue
		}
		if !s.Available || s.Users >= s.MaxListeners || !s.AntConnected {
			continue
		}

		dist := HaversineKm(srcLat, srcLon, *s.Latitude, *s.Longitude)
		if dist > maxRadiusKm {
			continue
		}
		bearing := BearingDeg(srcLat, srcLon, *s.Latitude, *s.Longitude)
		candidates = append(candidates, CandidateSource{
			Source:      s,
			DistanceKm:  dist,
			BearingDeg:  bearing,
		})
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].DistanceKm < candidates[j].DistanceKm
	})

	if len(candidates) > maxCandidates {
		candidates = candidates[:maxCandidates]
	}

	return candidates, nil
}
