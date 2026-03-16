package interpreter

import (
	"math"
	"testing"
)

func TestResample12to16_OutputLength(t *testing.T) {
	// 12000 samples at 12 kHz = 1 second → should produce ~16000 samples at 16 kHz
	in := make([]int16, 12000)
	for i := range in {
		in[i] = int16(10000 * math.Sin(2*math.Pi*440*float64(i)/12000))
	}
	out := resample12to16(in)
	if len(out) != 16000 {
		t.Errorf("expected 16000 output samples, got %d", len(out))
	}
}

func TestResample12to16_Range(t *testing.T) {
	// Feed max-amplitude signal, ensure output stays in [-1, 1]
	in := make([]int16, 1200)
	for i := range in {
		if i%2 == 0 {
			in[i] = math.MaxInt16
		} else {
			in[i] = math.MinInt16
		}
	}
	out := resample12to16(in)
	for i, v := range out {
		if v < -1.0 || v > 1.0 {
			t.Fatalf("sample %d out of range: %f", i, v)
		}
	}
}

func TestResample12to16_Empty(t *testing.T) {
	out := resample12to16(nil)
	if out != nil {
		t.Errorf("expected nil for empty input, got %v", out)
	}
}

func TestResample12to16_PreservesTone(t *testing.T) {
	// Generate a 1 kHz sine at 12 kHz, resample, and verify the dominant
	// frequency is still ~1 kHz by checking zero-crossing rate.
	const freq = 1000.0
	const srcRate = 12000
	const dstRate = 16000
	const seconds = 0.1
	nSrc := int(srcRate * seconds)

	in := make([]int16, nSrc)
	for i := range in {
		in[i] = int16(20000 * math.Sin(2*math.Pi*freq*float64(i)/srcRate))
	}
	out := resample12to16(in)

	// Count zero crossings
	crossings := 0
	for i := 1; i < len(out); i++ {
		if (out[i-1] >= 0 && out[i] < 0) || (out[i-1] < 0 && out[i] >= 0) {
			crossings++
		}
	}
	// Each cycle has 2 crossings, so freq ≈ crossings / 2 / seconds
	estimatedFreq := float64(crossings) / 2.0 / seconds
	if math.Abs(estimatedFreq-freq) > 50 {
		t.Errorf("expected ~%.0f Hz, got ~%.0f Hz (%d crossings)", freq, estimatedFreq, crossings)
	}
}
