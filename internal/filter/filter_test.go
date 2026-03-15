package filter

import (
	"math"
	"testing"

	"github.com/sammy/sdr-radio/internal/models"
)

const sampleRate = 12000

func generateSine(freqHz, sampleRateHz float64, durationSec float64) []byte {
	n := int(sampleRateHz * durationSec)
	pcm := make([]byte, n*2)
	for i := 0; i < n; i++ {
		t := float64(i) / sampleRateHz
		s := math.Sin(2 * math.Pi * freqHz * t)
		v := int16(s * 32767)
		pcm[i*2] = byte(v)
		pcm[i*2+1] = byte(v >> 8)
	}
	return pcm
}

func measureRMS(pcm []byte) float64 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var sum float64
	for i := 0; i < n; i++ {
		v := int16(uint16(pcm[i*2]) | uint16(pcm[i*2+1])<<8)
		s := float64(v) / 32768.0
		sum += s * s
	}
	return math.Sqrt(sum / float64(n))
}

func rmsRatioDB(before, after float64) float64 {
	if before == 0 {
		return -math.Inf(1)
	}
	return 20 * math.Log10(after/before)
}

func TestLowPassAttenuatesHighFreq(t *testing.T) {
	pcm := generateSine(5000, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		LowPass: &models.LowPassConfig{Enabled: true, CutoffHz: 2000},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db > -10 {
		t.Errorf("expected >10 dB attenuation for 5kHz through 2kHz LP, got %.1f dB", db)
	}
}

func TestLowPassPassesLowFreq(t *testing.T) {
	pcm := generateSine(500, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		LowPass: &models.LowPassConfig{Enabled: true, CutoffHz: 3000},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db < -1.0 {
		t.Errorf("expected <1 dB loss for 500Hz through 3kHz LP, got %.1f dB", db)
	}
}

func TestHighPassAttenuatesLowFreq(t *testing.T) {
	pcm := generateSine(50, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		HighPass: &models.HighPassConfig{Enabled: true, CutoffHz: 300},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db > -10 {
		t.Errorf("expected >10 dB attenuation for 50Hz through 300Hz HP, got %.1f dB", db)
	}
}

func TestHighPassPassesHighFreq(t *testing.T) {
	pcm := generateSine(2000, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		HighPass: &models.HighPassConfig{Enabled: true, CutoffHz: 100},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db < -1.0 {
		t.Errorf("expected <1 dB loss for 2kHz through 100Hz HP, got %.1f dB", db)
	}
}

func TestNoiseGateSilencesQuiet(t *testing.T) {
	// Generate a very quiet signal (-60 dB)
	n := sampleRate / 2 // 0.5 sec
	pcm := make([]byte, n*2)
	amp := 32767.0 * 0.001 // -60 dB
	for i := 0; i < n; i++ {
		s := math.Sin(2*math.Pi*1000*float64(i)/float64(sampleRate)) * amp
		v := int16(s)
		pcm[i*2] = byte(v)
		pcm[i*2+1] = byte(v >> 8)
	}
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		NoiseGate: &models.NoiseGateConfig{
			Enabled:     true,
			ThresholdDB: -40,
			HoldMs:      0,
			AttackMs:    1,
			ReleaseMs:   10,
		},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db > -20 {
		t.Errorf("expected noise gate to heavily attenuate quiet signal, got %.1f dB", db)
	}
}

func TestNoiseGatePassesLoud(t *testing.T) {
	pcm := generateSine(1000, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		NoiseGate: &models.NoiseGateConfig{
			Enabled:     true,
			ThresholdDB: -40,
			HoldMs:      100,
			AttackMs:    1,
			ReleaseMs:   50,
		},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db < -1.0 {
		t.Errorf("expected noise gate to pass loud signal, got %.1f dB", db)
	}
}

func TestSoftClipperReducesPeaks(t *testing.T) {
	pcm := generateSine(1000, sampleRate, 0.5)

	chain := NewChain(models.FilterConfig{
		SoftClipper: &models.SoftClipperConfig{
			Enabled:   true,
			DriveDB:   6,
			CeilingDB: -3,
		},
	}, sampleRate)
	chain.Process(pcm)

	n := len(pcm) / 2
	var peak float64
	for i := 0; i < n; i++ {
		v := int16(uint16(pcm[i*2]) | uint16(pcm[i*2+1])<<8)
		s := math.Abs(float64(v) / 32768.0)
		if s > peak {
			peak = s
		}
	}
	ceiling := math.Pow(10, -3.0/20.0)
	if peak > ceiling*1.05 { // 5% tolerance for quantization
		t.Errorf("peak %.4f exceeds ceiling %.4f", peak, ceiling)
	}
}

func TestEmptyChainPassthrough(t *testing.T) {
	pcm := generateSine(1000, sampleRate, 0.1)
	original := make([]byte, len(pcm))
	copy(original, pcm)

	chain := NewChain(models.FilterConfig{}, sampleRate)
	result := chain.Process(pcm)

	if &result[0] != &pcm[0] {
		t.Error("empty chain should return the same slice (zero alloc)")
	}
	for i := range pcm {
		if pcm[i] != original[i] {
			t.Errorf("empty chain modified byte %d", i)
			break
		}
	}
}

func TestChainOrdering(t *testing.T) {
	// HP + LP should bandpass: pass 1kHz, attenuate 50Hz and 5kHz
	pcm1k := generateSine(1000, sampleRate, 0.5)
	before1k := measureRMS(pcm1k)

	chain := NewChain(models.FilterConfig{
		HighPass: &models.HighPassConfig{Enabled: true, CutoffHz: 200},
		LowPass:  &models.LowPassConfig{Enabled: true, CutoffHz: 3000},
	}, sampleRate)
	chain.Process(pcm1k)
	after1k := measureRMS(pcm1k)

	db1k := rmsRatioDB(before1k, after1k)
	if db1k < -2.0 {
		t.Errorf("1kHz should pass through bandpass, got %.1f dB", db1k)
	}

	pcm50 := generateSine(50, sampleRate, 0.5)
	before50 := measureRMS(pcm50)
	chain2 := NewChain(models.FilterConfig{
		HighPass: &models.HighPassConfig{Enabled: true, CutoffHz: 200},
		LowPass:  &models.LowPassConfig{Enabled: true, CutoffHz: 3000},
	}, sampleRate)
	chain2.Process(pcm50)
	after50 := measureRMS(pcm50)

	db50 := rmsRatioDB(before50, after50)
	if db50 > -10 {
		t.Errorf("50Hz should be attenuated by bandpass, got %.1f dB", db50)
	}
}

func TestNotchRemovesTone(t *testing.T) {
	// Generate a 2000 Hz tone and notch it out
	pcm := generateSine(2000, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		Notch: &models.NotchConfig{Enabled: true, CenterHz: 2000, Q: 10},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db > -20 {
		t.Errorf("expected notch to deeply attenuate 2kHz tone, got %.1f dB", db)
	}
}

func TestNotchPassesOffFrequency(t *testing.T) {
	// Generate 1000 Hz and notch at 3000 Hz — signal should pass
	pcm := generateSine(1000, sampleRate, 0.5)
	before := measureRMS(pcm)

	chain := NewChain(models.FilterConfig{
		Notch: &models.NotchConfig{Enabled: true, CenterHz: 3000, Q: 10},
	}, sampleRate)
	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	if db < -1.0 {
		t.Errorf("expected notch at 3kHz to pass 1kHz signal, got %.1f dB", db)
	}
}

func TestFFTRoundTrip(t *testing.T) {
	n := 512
	re := make([]float64, n)
	im := make([]float64, n)
	for i := range re {
		re[i] = math.Sin(2*math.Pi*3*float64(i)/float64(n)) + 0.5*math.Cos(2*math.Pi*7*float64(i)/float64(n))
	}
	orig := make([]float64, n)
	copy(orig, re)

	fft(re, im)
	ifft(re, im)

	for i := range re {
		if math.Abs(re[i]-orig[i]) > 1e-10 {
			t.Fatalf("FFT round-trip mismatch at %d: got %f, want %f", i, re[i], orig[i])
		}
	}
}

func TestFFTKnownFrequency(t *testing.T) {
	n := 256
	re := make([]float64, n)
	im := make([]float64, n)
	// Pure tone at bin 10
	for i := range re {
		re[i] = math.Cos(2 * math.Pi * 10 * float64(i) / float64(n))
	}
	fft(re, im)

	// Bin 10 should have the dominant magnitude
	peakBin := 0
	peakMag := 0.0
	for k := 0; k < n/2; k++ {
		mag := math.Sqrt(re[k]*re[k] + im[k]*im[k])
		if mag > peakMag {
			peakMag = mag
			peakBin = k
		}
	}
	if peakBin != 10 {
		t.Errorf("expected peak at bin 10, got bin %d", peakBin)
	}
}

func TestNoiseReducerReducesNoise(t *testing.T) {
	// Generate a 1kHz signal buried in noise
	dur := 1.0 // 1 second
	n := int(float64(sampleRate) * dur)
	signalAmp := 0.3
	noiseAmp := 0.15

	rng := newDeterministicRng(42)

	// Build the noisy PCM
	pcm := make([]byte, n*2)
	for i := 0; i < n; i++ {
		s := signalAmp*math.Sin(2*math.Pi*1000*float64(i)/float64(sampleRate)) + noiseAmp*rng.normalFloat64()
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		v := int16(s * 32767)
		pcm[i*2] = byte(v)
		pcm[i*2+1] = byte(v >> 8)
	}

	// Also generate pure noise for comparison
	noisePcm := make([]byte, n*2)
	rng2 := newDeterministicRng(99)
	for i := 0; i < n; i++ {
		s := noiseAmp * rng2.normalFloat64()
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		v := int16(s * 32767)
		noisePcm[i*2] = byte(v)
		noisePcm[i*2+1] = byte(v >> 8)
	}

	noiseBefore := measureRMS(noisePcm)

	chain := NewChain(models.FilterConfig{
		NoiseReducer: &models.NoiseReducerConfig{
			Enabled:  true,
			Strength: 1.0,
			FloorDB:  -20,
		},
	}, sampleRate)

	// Prime the noise estimator with pure noise
	chain.Process(noisePcm)
	noiseAfter := measureRMS(noisePcm)

	db := rmsRatioDB(noiseBefore, noiseAfter)
	t.Logf("Pure noise: before=%.4f after=%.4f reduction=%.1f dB", noiseBefore, noiseAfter, db)
	if db > -3 {
		t.Errorf("expected at least 3 dB noise reduction on pure noise, got %.1f dB", db)
	}

	// Now process the signal+noise — the signal should survive
	signalBefore := measureRMS(pcm)
	chain.Process(pcm)
	signalAfter := measureRMS(pcm)
	signalDB := rmsRatioDB(signalBefore, signalAfter)
	t.Logf("Signal+noise: before=%.4f after=%.4f change=%.1f dB", signalBefore, signalAfter, signalDB)

	// Signal should not be destroyed (less than 6 dB loss)
	if signalDB < -6 {
		t.Errorf("noise reducer destroyed the signal: %.1f dB loss", signalDB)
	}
}

func TestNoiseReducerPreservesCleanSignal(t *testing.T) {
	// In practice, the reducer sees quiet noise before signal starts.
	// Feed low-level noise to calibrate, then a clean 1kHz tone.
	noiseAmp := 0.01
	rng := newDeterministicRng(77)

	// Calibration: ~0.5s of quiet noise
	calN := sampleRate / 2
	calPcm := make([]byte, calN*2)
	for i := 0; i < calN; i++ {
		s := noiseAmp * rng.normalFloat64()
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}
		v := int16(s * 32767)
		calPcm[i*2] = byte(v)
		calPcm[i*2+1] = byte(v >> 8)
	}

	chain := NewChain(models.FilterConfig{
		NoiseReducer: &models.NoiseReducerConfig{
			Enabled:  true,
			Strength: 0.5,
			FloorDB:  -20,
		},
	}, sampleRate)
	chain.Process(calPcm) // prime noise estimate

	// Now feed a clean 1kHz tone — should pass through mostly intact
	dur := 0.5
	n := int(float64(sampleRate) * dur)
	pcm := make([]byte, n*2)
	for i := 0; i < n; i++ {
		s := 0.5 * math.Sin(2*math.Pi*1000*float64(i)/float64(sampleRate))
		v := int16(s * 32767)
		pcm[i*2] = byte(v)
		pcm[i*2+1] = byte(v >> 8)
	}
	before := measureRMS(pcm)

	chain.Process(pcm)
	after := measureRMS(pcm)

	db := rmsRatioDB(before, after)
	t.Logf("Clean signal after noise calibration: before=%.4f after=%.4f change=%.1f dB", before, after, db)
	if db < -3 {
		t.Errorf("noise reducer damaged clean signal: %.1f dB loss", db)
	}
}

// deterministic PRNG for reproducible noise tests
type detRng struct {
	state uint64
}

func newDeterministicRng(seed uint64) *detRng {
	return &detRng{state: seed}
}

func (r *detRng) uint64() uint64 {
	r.state ^= r.state << 13
	r.state ^= r.state >> 7
	r.state ^= r.state << 17
	return r.state
}

func (r *detRng) float64() float64 {
	return float64(r.uint64()>>11) / (1 << 53)
}

func (r *detRng) normalFloat64() float64 {
	// Box-Muller
	u1 := r.float64()
	u2 := r.float64()
	if u1 < 1e-15 {
		u1 = 1e-15
	}
	return math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
}

func TestReconfigure(t *testing.T) {
	chain := NewChain(models.FilterConfig{}, sampleRate)

	pcm := generateSine(5000, sampleRate, 0.1)
	before := measureRMS(pcm)
	chain.Process(pcm)
	after := measureRMS(pcm)
	if before != after {
		t.Error("empty chain should not modify signal")
	}

	chain.Reconfigure(BuildFilters(models.FilterConfig{
		LowPass: &models.LowPassConfig{Enabled: true, CutoffHz: 1000},
	}, sampleRate))

	pcm2 := generateSine(5000, sampleRate, 0.5)
	before2 := measureRMS(pcm2)
	chain.Process(pcm2)
	after2 := measureRMS(pcm2)
	db := rmsRatioDB(before2, after2)
	if db > -10 {
		t.Errorf("after reconfigure, expected LP to attenuate 5kHz, got %.1f dB", db)
	}
}
