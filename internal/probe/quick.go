package probe

import (
	"context"
	"fmt"
	"time"

	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
)

const (
	QuickProbeTimeout      = 10 * time.Second
	QuickProbeFrameTimeout = 5 * time.Second
)

type QuickProbeResult struct {
	SourceID  string  `json:"source_id"`
	Connected bool    `json:"connected"`
	SndOK     bool    `json:"snd_ok"`
	WfOK      bool    `json:"wf_ok"`
	LatencyMs float64 `json:"latency_ms"`
	Error     string  `json:"error,omitempty"`
}

// QuickProbe tests connectivity to a KiwiSDR by opening SND and WF WebSockets
// and waiting for at least one frame on each. It uses the stream's actual
// frequency and mode so the test reflects real operating conditions.
func QuickProbe(ctx context.Context, source models.Source, freqKHz float64, mode string) QuickProbeResult {
	result := QuickProbeResult{SourceID: source.ID}
	start := time.Now()

	probeCtx, cancel := context.WithTimeout(ctx, QuickProbeTimeout)
	defer cancel()

	ts := kiwi.ConnectTimestamp()

	client, err := kiwi.Connect(probeCtx, kiwi.Config{
		Host:         source.Host,
		Port:         source.Port,
		UseTLS:       source.UseTLS,
		Name:         ProbeIdentUser,
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

	wfClient, wfErr := kiwi.ConnectWF(probeCtx, kiwi.WFConfig{
		Host:      source.Host,
		Port:      source.Port,
		UseTLS:    source.UseTLS,
		Name:      ProbeIdentUser,
		Zoom:      10,
		CenterKHz: freqKHz,
		Speed:     4,
		Compress:  false,
	}, ts, nil)
	if wfErr != nil {
		result.Error = fmt.Sprintf("WF connect failed: %v", wfErr)
	}
	if wfClient != nil {
		defer wfClient.Close()
	}

	timer := time.NewTimer(QuickProbeFrameTimeout)
	defer timer.Stop()

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

	if wfClient != nil && result.Error == "" {
		timer.Reset(QuickProbeFrameTimeout)
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

// QuickProbeMany runs QuickProbe on multiple candidates in parallel and returns
// only the ones that passed (Connected && SndOK && WfOK).
func QuickProbeMany(ctx context.Context, candidates []CandidateSource, freqKHz float64, mode string) (passed []CandidateSource, failed []QuickProbeResult) {
	type indexedResult struct {
		idx    int
		result QuickProbeResult
	}

	ch := make(chan indexedResult, len(candidates))
	for i, c := range candidates {
		go func(idx int, src models.Source) {
			ch <- indexedResult{idx: idx, result: QuickProbe(ctx, src, freqKHz, mode)}
		}(i, c.Source)
	}

	results := make([]QuickProbeResult, len(candidates))
	for range candidates {
		ir := <-ch
		results[ir.idx] = ir.result
	}

	for i, r := range results {
		if r.Connected && r.SndOK && r.WfOK {
			passed = append(passed, candidates[i])
		} else {
			failed = append(failed, r)
		}
	}
	return passed, failed
}
