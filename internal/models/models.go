package models

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"

	"github.com/sammy/sdr-radio/internal/interpreter"
)

type FilterConfig struct {
	Bypassed      bool                 `json:"bypassed,omitempty"`
	NoiseBlanker  *NoiseBlankerConfig  `json:"noise_blanker,omitempty"`
	LowPass       *LowPassConfig       `json:"low_pass,omitempty"`
	HighPass      *HighPassConfig      `json:"high_pass,omitempty"`
	Notch         *NotchConfig         `json:"notch,omitempty"`
	Autonotch     *AutonotchConfig     `json:"autonotch,omitempty"`
	NoiseGate     *NoiseGateConfig     `json:"noise_gate,omitempty"`
	SoftClipper   *SoftClipperConfig   `json:"soft_clipper,omitempty"`
	NoiseReducer  *NoiseReducerConfig  `json:"noise_reducer,omitempty"`
}

type LowPassConfig struct {
	Enabled  bool    `json:"enabled"`
	CutoffHz float64 `json:"cutoff_hz"`
}

func (c LowPassConfig) IsEnabled() bool { return c.Enabled }

type HighPassConfig struct {
	Enabled  bool    `json:"enabled"`
	CutoffHz float64 `json:"cutoff_hz"`
}

func (c HighPassConfig) IsEnabled() bool { return c.Enabled }

type NoiseGateConfig struct {
	Enabled     bool    `json:"enabled"`
	ThresholdDB float64 `json:"threshold_db"`
	HoldMs      float64 `json:"hold_ms"`
	AttackMs    float64 `json:"attack_ms"`
	ReleaseMs   float64 `json:"release_ms"`
}

func (c NoiseGateConfig) IsEnabled() bool { return c.Enabled }

type SoftClipperConfig struct {
	Enabled   bool    `json:"enabled"`
	DriveDB   float64 `json:"drive_db"`
	CeilingDB float64 `json:"ceiling_db"`
}

func (c SoftClipperConfig) IsEnabled() bool { return c.Enabled }

type NotchConfig struct {
	Enabled  bool    `json:"enabled"`
	CenterHz float64 `json:"center_hz"`
	Q        float64 `json:"q"`
}

func (c NotchConfig) IsEnabled() bool { return c.Enabled }

type NoiseReducerConfig struct {
	Enabled  bool    `json:"enabled"`
	Strength float64 `json:"strength"` // 0.0–1.0
	FloorDB  float64 `json:"floor_db"` // e.g. -20
}

func (c NoiseReducerConfig) IsEnabled() bool { return c.Enabled }

type NoiseBlankerConfig struct {
	Enabled   bool    `json:"enabled"`
	Threshold float64 `json:"threshold"` // 0–100, sensitivity
}

func (c NoiseBlankerConfig) IsEnabled() bool { return c.Enabled }

type AutonotchConfig struct {
	Enabled  bool    `json:"enabled"`
	Strength float64 `json:"strength"` // 0.0–1.0
}

func (c AutonotchConfig) IsEnabled() bool { return c.Enabled }

func (fc *FilterConfig) Scan(src interface{}) error {
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
		return fmt.Errorf("FilterConfig.Scan: unsupported type %T", src)
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, fc)
}

func (fc FilterConfig) Value() (driver.Value, error) {
	return json.Marshal(fc)
}

type Tenant struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	MagicPhraseHash string    `json:"-"`
	MaxStreams      int       `json:"max_streams"`
	CreatedAt       time.Time `json:"created_at"`
}

type Source struct {
	ID                string     `json:"id"`
	Type              string     `json:"type"`
	Host              string     `json:"host"`
	Port              int        `json:"port"`
	UseTLS            bool       `json:"use_tls"`
	Latitude          *float64   `json:"latitude,omitempty"`
	Longitude         *float64   `json:"longitude,omitempty"`
	Name              string     `json:"name"`
	MaxListeners      int        `json:"max_listeners"`
	Available         bool       `json:"available"`
	Users             int        `json:"users"`             // current listeners (from /status)
	SNRDBM            *float64   `json:"snr_dbm,omitempty"` // avg SNR in dB
	Antenna           *string    `json:"antenna,omitempty"`
	Location          *string    `json:"location,omitempty"` // loc from /status
	Grid              *string    `json:"grid,omitempty"`
	Status            *string    `json:"status,omitempty"` // active, etc.
	AntConnected      bool       `json:"ant_connected"`
	Offline           bool       `json:"offline"`
	LastHealthCheckAt *time.Time `json:"last_health_check_at,omitempty"`
	LastReachableAt   *time.Time `json:"last_reachable_at,omitempty"`
	LastSyncedAt      *time.Time `json:"last_synced_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type SourceNote struct {
	TenantID  string    `json:"tenant_id"`
	SourceID  string    `json:"source_id"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Stream struct {
	ID                       string    `json:"id"`
	TenantID                 string    `json:"tenant_id"`
	SourceID                 string    `json:"source_id"`
	FrequencyKHz             float64   `json:"frequency_khz"`
	BandwidthLowHz           int       `json:"bandwidth_low_hz"`
	BandwidthHighHz          int       `json:"bandwidth_high_hz"`
	Mode                     string    `json:"mode"`
	Name                     string    `json:"name"`
	AGCOn                    bool      `json:"agc_on"`
	AGCGainDB                *float64  `json:"agc_gain_db,omitempty"`
	BufferMinutes            int       `json:"buffer_minutes"`
	ActivityDetectionEnabled bool      `json:"activity_detection_enabled"`
	ActivitySensitivity      float64   `json:"activity_sensitivity"`
	State                    string    `json:"state"`
	Version                  int64              `json:"version"`
	Filters                  FilterConfig       `json:"filters"`
	Interpreter              interpreter.Config `json:"interpreter"`
	WFViewStartKHz           float64            `json:"wf_view_start_khz"`
	WFViewEndKHz             float64      `json:"wf_view_end_khz"`
	AutoFallback             bool         `json:"auto_fallback"`
	ViewLocked               bool         `json:"view_locked"`
	CreatedAt                time.Time    `json:"created_at"`
	UpdatedAt                time.Time    `json:"updated_at"`
}
