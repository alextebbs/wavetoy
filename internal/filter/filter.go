package filter

import (
	"sync"

	"github.com/sammy/sdr-radio/internal/models"
)

// Filter processes audio samples in-place. Samples are normalized
// float64 values in the range [-1.0, 1.0].
type Filter interface {
	Process(samples []float64)
	Reset()
}

// Chain applies a sequence of filters to PCM16 audio frames.
// The chain converts between []byte (PCM16 little-endian) at the boundary
// and []float64 internally, so individual filters avoid repeated conversion.
type Chain struct {
	mu      sync.RWMutex
	filters []Filter
	buf     []float64
}

func NewChain(cfg models.FilterConfig, sampleRate int) *Chain {
	return &Chain{filters: BuildFilters(cfg, sampleRate)}
}

// Process applies all filters to a PCM16 little-endian frame.
// When no filters are active, returns the input slice unmodified (zero alloc).
// Otherwise modifies the input slice in-place and returns it.
func (c *Chain) Process(pcm []byte) []byte {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if len(c.filters) == 0 || len(pcm) < 2 {
		return pcm
	}

	nSamples := len(pcm) / 2

	if cap(c.buf) < nSamples {
		c.buf = make([]float64, nSamples)
	}
	samples := c.buf[:nSamples]

	for i := 0; i < nSamples; i++ {
		v := int16(uint16(pcm[i*2]) | uint16(pcm[i*2+1])<<8)
		samples[i] = float64(v) / 32768.0
	}

	for _, f := range c.filters {
		f.Process(samples)
	}

	for i := 0; i < nSamples; i++ {
		s := samples[i]
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		v := int16(s * 32767.0)
		pcm[i*2] = byte(v)
		pcm[i*2+1] = byte(v >> 8)
	}

	return pcm
}

// Reconfigure swaps the active filter list. Safe to call while
// Process is running on another goroutine.
func (c *Chain) Reconfigure(filters []Filter) {
	c.mu.Lock()
	c.filters = filters
	c.mu.Unlock()
}

// BuildFilters constructs the ordered filter slice from a FilterConfig.
// The execution order is fixed for signal quality:
//  1. Noise Blanker   (suppress impulse noise first — clicks, pops, static)
//  2. High-Pass       (remove DC/hum)
//  3. Notch           (kill known tonal interference)
//  4. Autonotch       (adaptively find and remove unknown tonal interference)
//  5. Noise Reducer   (MMSE-STSA spectral noise reduction)
//  6. Noise Gate      (gate on cleaned signal)
//  7. Low-Pass        (shape frequency response)
//  8. Soft Clipper    (tame peaks last)
func BuildFilters(cfg models.FilterConfig, sampleRate int) []Filter {
	if cfg.Bypassed {
		return nil
	}

	var filters []Filter

	if cfg.NoiseBlanker != nil && cfg.NoiseBlanker.Enabled {
		filters = append(filters, NewNoiseBlanker(cfg.NoiseBlanker.Threshold, sampleRate))
	}
	if cfg.HighPass != nil && cfg.HighPass.Enabled {
		filters = append(filters, NewHighPass(cfg.HighPass.CutoffHz, float64(sampleRate)))
	}
	if cfg.Notch != nil && cfg.Notch.Enabled {
		filters = append(filters, NewNotch(cfg.Notch.CenterHz, cfg.Notch.Q, float64(sampleRate)))
	}
	if cfg.Autonotch != nil && cfg.Autonotch.Enabled {
		filters = append(filters, NewAutonotch(cfg.Autonotch.Strength))
	}
	if cfg.NoiseReducer != nil && cfg.NoiseReducer.Enabled {
		filters = append(filters, NewNoiseReducer(cfg.NoiseReducer.Strength, cfg.NoiseReducer.FloorDB))
	}
	if cfg.NoiseGate != nil && cfg.NoiseGate.Enabled {
		filters = append(filters, NewNoiseGate(
			cfg.NoiseGate.ThresholdDB,
			cfg.NoiseGate.HoldMs,
			cfg.NoiseGate.AttackMs,
			cfg.NoiseGate.ReleaseMs,
			sampleRate,
		))
	}
	if cfg.LowPass != nil && cfg.LowPass.Enabled {
		filters = append(filters, NewLowPass(cfg.LowPass.CutoffHz, float64(sampleRate)))
	}
	if cfg.SoftClipper != nil && cfg.SoftClipper.Enabled {
		filters = append(filters, NewSoftClipper(cfg.SoftClipper.DriveDB, cfg.SoftClipper.CeilingDB))
	}

	return filters
}
