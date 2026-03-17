package fallback

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"

	"github.com/sammy/sdr-radio/internal/models"
)

type FallbackSuggestion struct {
	StreamID     string       `json:"stream_id"`
	SourceID     string       `json:"source_id"`
	SourceName   string       `json:"source_name"`
	SourceHost   string       `json:"source_host"`
	SourcePort   int          `json:"source_port"`
	Rank         int          `json:"rank"`
	Score        float64      `json:"score"`
	DistanceKm   float64      `json:"distance_km"`
	BearingDeg   float64      `json:"bearing_deg"`
	LastProbed   time.Time    `json:"last_probed"`
	ProbeMetrics ProbeMetrics `json:"probe_metrics"`
}

type ProbeMetrics struct {
	AudioRMSDB           float64 `json:"audio_rms_db"`
	RMSSimilarity        float64 `json:"rms_similarity"`
	SilenceAgreement     float64 `json:"silence_agreement"`
	SpectralSimilarity   float64 `json:"spectral_similarity"`
	NoiseFloorSimilarity float64 `json:"noise_floor_similarity"`
	FrameRate            float64 `json:"frame_rate"`
	LatencyMs            float64 `json:"latency_ms"`
}

func (pm *ProbeMetrics) Scan(src interface{}) error {
	if src == nil {
		return nil
	}
	var data []byte
	switch v := src.(type) {
	case []byte:
		data = v
	case string:
		data = []byte(v)
	default:
		return fmt.Errorf("ProbeMetrics.Scan: unsupported type %T", src)
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, pm)
}

func (pm ProbeMetrics) Value() (driver.Value, error) {
	return json.Marshal(pm)
}

type AudioSnapshot struct {
	RMSDB        float64
	PeakRMSDB    float64
	FloorRMSDB   float64
	SilenceRatio float64
	FrameRate    float64
	WFBinsInBand []float64
}

type CandidateSource struct {
	Source      models.Source
	DistanceKm  float64
	BearingDeg  float64
}

type ProbeResult struct {
	SourceID   string
	SourceName string
	SourceHost string
	SourcePort int
	DistanceKm float64
	BearingDeg float64
	Snapshot   AudioSnapshot
	RawPCM     []byte
	SampleRate int
	LatencyMs  float64
	Connected  bool
	Error      error
}

