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
