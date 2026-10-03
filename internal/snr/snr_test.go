package snr

import (
	"errors"
	"math"
	"testing"
)

func TestBinToFreqKHz_Zoom0(t *testing.T) {
	// Zoom 0: binScale = 2^14 = 16384. Each of 1024 displayed bins covers 16384 master bins.
	// Bin 0, xBin 0 → freq 0.
	freq := binToFreqKHz(0, 0, 0, 0)
	if freq != 0 {
		t.Errorf("bin 0, xBin 0, zoom 0: got %.2f, want 0", freq)
	}
	// Bin 1023 → masterIdx = 1023*16384 = 16,760,832 → freq = 16760832/16777216*30000 ≈ 29970.7
	freq = binToFreqKHz(1023, 0, 0, 0)
	expected := float64(1023*16384) / totalMasterBins * defaultBandwidthKHz
	if math.Abs(freq-expected) > 0.01 {
		t.Errorf("bin 1023, zoom 0: got %.2f, want %.2f", freq, expected)
	}
}

func TestBinToFreqKHz_WithZoom(t *testing.T) {
	// Zoom 5: binScale = 2^(14-5) = 512.
	// xBin = 9_624_000 (master-grid index), bin 10 → masterIdx = 9624000 + 10*512 = 9629120
	// freq = 9629120 / 16777216 * 30000 ≈ 17218 kHz
	xBin := uint32(9_624_000)
	freq := binToFreqKHz(10, xBin, 5, 0)
	expected := float64(int(xBin)+10*512) / totalMasterBins * defaultBandwidthKHz
	if math.Abs(freq-expected) > 0.01 {
		t.Errorf("zoom 5: got %.2f, want %.2f", freq, expected)
	}
}

func TestFreqKHzToBin_Clamping(t *testing.T) {
	idx := freqKHzToBin(-100, 0, 0, 512, 0)
	if idx != 0 {
		t.Errorf("negative freq: got %d, want 0", idx)
	}

	idx = freqKHzToBin(999999, 0, 0, 512, 0)
	if idx != 511 {
		t.Errorf("huge freq: got %d, want 511", idx)
	}
}

func TestFreqKHzToBin_RoundTrip(t *testing.T) {
	xBin := uint32(5_000_000)
	zoom := uint16(5)
	numBins := 200

	for _, origBin := range []int{0, 10, 50, 100, 199} {
		freq := binToFreqKHz(origBin, xBin, zoom, 0)
		gotBin := freqKHzToBin(freq, xBin, zoom, numBins, 0)
		if math.Abs(float64(gotBin-origBin)) > 1 {
			t.Errorf("round-trip bin %d: freq=%.2f, gotBin=%d", origBin, freq, gotBin)
		}
	}
}

func TestFromWFFrame_EmptyBins(t *testing.T) {
	_, err := FromWFFrame(WFFrameData{}, BandConfig{CenterKHz: 14000})
	if err != ErrNoBins {
		t.Errorf("expected ErrNoBins, got %v", err)
	}
}

func TestFromWFFrame_SignalAboveNoise(t *testing.T) {
	// Zoom 5: binScale=512. 1024 bins cover 1024*512=524288 master bins.
	// Center 14200 kHz → masterIdx ≈ 7,941,405.
	// xBin = 7,700,000 → frameStart ≈ 13772 kHz, frameEnd ≈ 14710 kHz.
	numBins := 1024
	bins := make([]byte, numBins)
	for i := range bins {
		bins[i] = 50
	}

	band := BandConfig{CenterKHz: 14200, PassbandLoHz: -5000, PassbandHiHz: 5000}
	xBin := uint32(7_700_000)
	frame := WFFrameData{Bins: bins, XBin: xBin, Zoom: 5}

	loIdx := freqKHzToBin(14195.0, xBin, 5, numBins, 0)
	hiIdx := freqKHzToBin(14205.0, xBin, 5, numBins, 0)
	for i := loIdx; i <= hiIdx && i < numBins; i++ {
		bins[i] = 200
	}

	result, err := FromWFFrame(frame, band)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.InBandSNRdB <= 0 {
		t.Errorf("expected positive SNR, got %.2f dB", result.InBandSNRdB)
	}
	if result.BinsUsed == 0 {
		t.Error("expected non-zero BinsUsed")
	}
	if result.SignalPowerdB <= result.NoiseFloordB {
		t.Errorf("signal (%.2f) should be above noise (%.2f)", result.SignalPowerdB, result.NoiseFloordB)
	}
}

func TestFromWFFrame_FlatSpectrum(t *testing.T) {
	bins := make([]byte, 1024)
	for i := range bins {
		bins[i] = 100
	}

	band := BandConfig{CenterKHz: 14200, PassbandLoHz: -5000, PassbandHiHz: 5000}
	frame := WFFrameData{Bins: bins, XBin: 7_700_000, Zoom: 5}

	result, err := FromWFFrame(frame, band)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if math.Abs(result.InBandSNRdB) > 1.0 {
		t.Errorf("flat spectrum SNR should be ~0, got %.2f dB", result.InBandSNRdB)
	}
}

func TestFromWFFrame_PassbandOutside(t *testing.T) {
	bins := make([]byte, 1024)
	for i := range bins {
		bins[i] = 100
	}

	// Frame at 14 MHz, but passband at 3 MHz — completely outside
	band := BandConfig{CenterKHz: 3000, PassbandLoHz: -2500, PassbandHiHz: 2500}
	frame := WFFrameData{Bins: bins, XBin: 7_700_000, Zoom: 5}

	_, err := FromWFFrame(frame, band)
	if !errors.Is(err, ErrPassbandOutside) {
		t.Errorf("expected ErrPassbandOutside, got %v", err)
	}
}

func TestFromWFFrames_Averaging(t *testing.T) {
	bins1 := make([]byte, 1024)
	bins2 := make([]byte, 1024)
	for i := range bins1 {
		bins1[i] = 100
		bins2[i] = 200
	}

	xBin := uint32(7_700_000)
	frames := []WFFrameData{
		{Bins: bins1, XBin: xBin, Zoom: 5},
		{Bins: bins2, XBin: xBin, Zoom: 5},
	}

	band := BandConfig{CenterKHz: 14200, PassbandLoHz: -5000, PassbandHiHz: 5000}
	result, err := FromWFFrames(frames, band)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if math.Abs(result.InBandSNRdB) > 1.0 {
		t.Errorf("averaged flat spectrum SNR should be ~0, got %.2f dB", result.InBandSNRdB)
	}
	// Byte avg of (100+200)/2 = 150 → 150 * 180/255 - 190 ≈ -84.1 dBm
	expectedPower := 150.0*((-10.0)-(-190.0))/255.0 + (-190.0)
	if math.Abs(result.SignalPowerdB-expectedPower) > 2 {
		t.Errorf("expected signal power ~%.1f dBm, got %.2f", expectedPower, result.SignalPowerdB)
	}
}

func TestFromWFFrames_Empty(t *testing.T) {
	_, err := FromWFFrames(nil, BandConfig{})
	if err != ErrNoFrames {
		t.Errorf("expected ErrNoFrames, got %v", err)
	}
}

func TestFromWFFrames_SingleFrame(t *testing.T) {
	bins := make([]byte, 1024)
	for i := range bins {
		bins[i] = 80
	}
	xBin := uint32(7_700_000)
	frames := []WFFrameData{{Bins: bins, XBin: xBin, Zoom: 5}}
	band := BandConfig{CenterKHz: 14200, PassbandLoHz: -5000, PassbandHiHz: 5000}

	result, err := FromWFFrames(frames, band)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	singleResult, _ := FromWFFrame(frames[0], band)
	if math.Abs(result.InBandSNRdB-singleResult.InBandSNRdB) > 0.01 {
		t.Errorf("single-frame FromWFFrames should match FromWFFrame: %.2f vs %.2f",
			result.InBandSNRdB, singleResult.InBandSNRdB)
	}
}

func TestFromWFFrames_MismatchedBinLengths(t *testing.T) {
	xBin := uint32(7_700_000)
	frames := []WFFrameData{
		{Bins: make([]byte, 1024), XBin: xBin, Zoom: 5},
		{Bins: make([]byte, 512), XBin: xBin, Zoom: 5},
	}
	band := BandConfig{CenterKHz: 14200, PassbandLoHz: -5000, PassbandHiHz: 5000}

	_, err := FromWFFrames(frames, band)
	if err != nil {
		t.Fatalf("mismatched frames should still work (skip bad ones): %v", err)
	}
}
