package streammgr

import "github.com/sammy/sdr-radio/internal/models"

type StreamState string

const (
	StateConnecting   StreamState = "connecting"
	StateActive       StreamState = "active"
	StateReconnecting StreamState = "reconnecting"
	StateError        StreamState = "error"
	StateIdle         StreamState = "idle"
)

// StateInt maps StreamState strings to compact integers for chunk metadata.
var StateInt = map[StreamState]uint8{
	StateConnecting:   0,
	StateActive:       1,
	StateReconnecting: 2,
	StateError:        3,
	StateIdle:         4,
}

// Health flag bitmask constants for chunk metadata.
const (
	HealthAudioStale uint8 = 1 << iota
	HealthWFStale
	HealthTooBusy
	HealthReconnectChurn
)

// HealthFlag is the string representation used in the DB TEXT[] and JSON.
const (
	HealthFlagAudioStale    = "audio_stale"
	HealthFlagWFStale       = "wf_stale"
	HealthFlagTooBusy       = "too_busy"
	HealthFlagReconnectChurn = "reconnect_churn"
)

// PassbandInView returns true if the stream's listen passband falls within
// the current waterfall view. Used to validate that activity detection (SNR
// from WF frames) will produce meaningful results.
func PassbandInView(stream models.Stream) bool {
	passLo := stream.FrequencyKHz + float64(stream.BandwidthLowHz)/1000.0
	passHi := stream.FrequencyKHz + float64(stream.BandwidthHighHz)/1000.0
	return passLo >= stream.WFViewStartKHz && passHi <= stream.WFViewEndKHz
}

// HealthToFlags converts a health string slice to a bitmask.
func HealthToFlags(health []string) uint8 {
	var flags uint8
	for _, h := range health {
		switch h {
		case HealthFlagAudioStale:
			flags |= HealthAudioStale
		case HealthFlagWFStale:
			flags |= HealthWFStale
		case HealthFlagTooBusy:
			flags |= HealthTooBusy
		case HealthFlagReconnectChurn:
			flags |= HealthReconnectChurn
		}
	}
	return flags
}
