package models

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"
)

type FilterConfig struct {
	LowPass     *LowPassConfig     `json:"low_pass,omitempty"`
	HighPass    *HighPassConfig    `json:"high_pass,omitempty"`
	Notch       *NotchConfig       `json:"notch,omitempty"`
	NoiseGate   *NoiseGateConfig   `json:"noise_gate,omitempty"`
	SoftClipper *SoftClipperConfig `json:"soft_clipper,omitempty"`
}

type LowPassConfig struct {
	Enabled  bool    `json:"enabled"`
	CutoffHz float64 `json:"cutoff_hz"`
}

type HighPassConfig struct {
	Enabled  bool    `json:"enabled"`
	CutoffHz float64 `json:"cutoff_hz"`
}

type NoiseGateConfig struct {
	Enabled     bool    `json:"enabled"`
	ThresholdDB float64 `json:"threshold_db"`
	HoldMs      float64 `json:"hold_ms"`
	AttackMs    float64 `json:"attack_ms"`
	ReleaseMs   float64 `json:"release_ms"`
}

type SoftClipperConfig struct {
	Enabled   bool    `json:"enabled"`
	DriveDB   float64 `json:"drive_db"`
	CeilingDB float64 `json:"ceiling_db"`
}

type NotchConfig struct {
	Enabled  bool    `json:"enabled"`
	CenterHz float64 `json:"center_hz"`
	Q        float64 `json:"q"`
}

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
	LastSyncedAt      *time.Time `json:"last_synced_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
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
	Version                  int64        `json:"version"`
	Filters                  FilterConfig `json:"filters"`
	WFViewStartKHz           float64      `json:"wf_view_start_khz"`
	WFViewEndKHz             float64      `json:"wf_view_end_khz"`
	AutoFallback             bool         `json:"auto_fallback"`
	AutoFallbackKind         string       `json:"auto_fallback_kind"`
	CreatedAt                time.Time    `json:"created_at"`
	UpdatedAt                time.Time    `json:"updated_at"`
}
