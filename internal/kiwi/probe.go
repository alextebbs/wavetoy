package kiwi

import (
	"context"
	"fmt"
	"time"
)

const quickProbeIdent = "sdr-radio-probe"

type QuickProbeResult struct {
	SourceID  string  `json:"source_id"`
	Connected bool    `json:"connected"`
	SndOK     bool    `json:"snd_ok"`
	WfOK      bool    `json:"wf_ok"`
	LatencyMs float64 `json:"latency_ms"`
	Error     string  `json:"error,omitempty"`
}

// QuickProbe tests connectivity to a KiwiSDR source by connecting both
// SND and WF WebSockets and waiting for at least one frame on each.
// It is intentionally lightweight: no scoring, no extended collection.
func QuickProbe(ctx context.Context, sourceID, host string, port int, useTLS bool, freqKHz float64, mode string) QuickProbeResult {
	result := QuickProbeResult{SourceID: sourceID}
	start := time.Now()

	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	ts := ConnectTimestamp()

	client, err := Connect(probeCtx, Config{
		Host:         host,
		Port:         port,
		UseTLS:       useTLS,
		Name:         quickProbeIdent,
		FrequencyKHz: freqKHz,
		Mode:         mode,
		AGCOn:        true,
	}, ts, nil)
	if err != nil {
		result.Error = fmt.Sprintf("SND connect failed: %v", err)
		result.LatencyMs = float64(time.Since(start).Milliseconds())
		return result
	}
	defer client.Close()

	result.Connected = true

	wfClient, wfErr := ConnectWF(probeCtx, WFConfig{
		Host:      host,
		Port:      port,
		UseTLS:    useTLS,
		Name:      quickProbeIdent,
		Zoom:      0,
		CenterKHz: 15000.0,
		Speed:     4,
		Compress:  false,
	}, ts, nil)
	if wfErr != nil {
		result.Error = fmt.Sprintf("WF connect failed: %v", wfErr)
	}
	if wfClient != nil {
		defer wfClient.Close()
	}

	frameTimeout := 5 * time.Second
	timer := time.NewTimer(frameTimeout)
	defer timer.Stop()

	// Wait for first SND frame
	select {
	case _, ok := <-client.Samples():
		if ok {
			result.SndOK = true
		}
	case <-client.Done():
		if result.Error == "" {
			result.Error = "SND connection closed before receiving data"
		}
	case <-timer.C:
		if result.Error == "" {
			result.Error = "timeout waiting for SND data"
		}
	case <-probeCtx.Done():
		if result.Error == "" {
			result.Error = "probe cancelled"
		}
	}

	// Wait for first WF frame (only if WF connected)
	if wfClient != nil && result.Error == "" {
		timer.Reset(frameTimeout)
		select {
		case _, ok := <-wfClient.Frames():
			if ok {
				result.WfOK = true
			}
		case <-wfClient.Done():
			if !result.WfOK {
				result.Error = "WF connection closed before receiving data"
			}
		case <-timer.C:
			result.Error = "timeout waiting for WF data"
		case <-probeCtx.Done():
			if result.Error == "" {
				result.Error = "probe cancelled"
			}
		}
	}

	result.LatencyMs = float64(time.Since(start).Milliseconds())
	return result
}
