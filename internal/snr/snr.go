package snr

import (
	"errors"
	"fmt"
	"math"
)

// BandConfig defines the frequency region of interest for SNR measurement.
type BandConfig struct {
	CenterKHz    float64
	PassbandLoHz int // lower edge relative to center (e.g. -4900)
	PassbandHiHz int // upper edge relative to center (e.g. 4900)
}

// Result holds a single SNR measurement.
type Result struct {
	InBandSNRdB   float64 // signal power minus noise floor, in dB
	SignalPowerdB float64 // mean power of in-band bins
	NoiseFloordB  float64 // mean power of out-of-band reference bins
	BinsUsed      int     // how many WF bins contributed to the measurement
}

// WFFrameData is a minimal representation of a waterfall frame
// decoupled from the kiwi package so this package stays dependency-free.
type WFFrameData struct {
	Bins         []byte
	XBin         uint32
	Zoom         uint16
	BandwidthKHz float64 // total KiwiSDR bandwidth (30000 or 32000); 0 defaults to 30000
}

var (
	ErrNoBins          = errors.New("snr: frame has no bins")
	ErrPassbandOutside = errors.New("snr: passband not covered by frame")
	ErrNoFrames        = errors.New("snr: no frames provided")
)

const (
	defaultBandwidthKHz = 30000.0
	altBandwidthKHz     = 32000.0
	wfBins              = 1024
	maxZoom             = 14
	totalMasterBins     = wfBins * (1 << maxZoom) // 16,777,216

	refMarginLoKHz = 2.0
	refMarginHiKHz = 5.0

	// KiwiSDR WF compression range (from w2_waterfall.cpp).
	// Byte 0 → wfCompMinDB dBm, byte 255 → wfCompMaxDB dBm.
	wfCompMinDB = -190.0
	wfCompMaxDB = -10.0
)

func wfByteToDBm(b float64) float64 {
	return b*(wfCompMaxDB-wfCompMinDB)/255.0 + wfCompMinDB
}

func effectiveBandwidth(bwKHz float64) float64 {
	if bwKHz > 0 {
		return bwKHz
	}
	return defaultBandwidthKHz
}

// binToFreqKHz converts a local frame bin index to a frequency in kHz.
// xBin is an index into the KiwiSDR master grid (wfBins * 2^maxZoom bins).
// Each displayed bin covers binScale = 2^(maxZoom - zoom) master bins.
func binToFreqKHz(binIndex int, xBin uint32, zoom uint16, bwKHz float64) float64 {
	binScale := 1 << (maxZoom - int(zoom))
	masterIdx := float64(int(xBin) + binIndex*binScale)
	return (masterIdx / totalMasterBins) * effectiveBandwidth(bwKHz)
}

// freqKHzToBin converts a frequency in kHz to a local bin index within the frame.
func freqKHzToBin(freqKHz float64, xBin uint32, zoom uint16, numBins int, bwKHz float64) int {
	bw := effectiveBandwidth(bwKHz)
	binScale := 1 << (maxZoom - int(zoom))
	masterIdx := (freqKHz / bw) * totalMasterBins
	idx := int(math.Round((masterIdx - float64(xBin)) / float64(binScale)))
	if idx < 0 {
		idx = 0
	}
	if idx >= numBins {
		idx = numBins - 1
	}
	return idx
}

// FromWFFrame computes in-band SNR from a single waterfall frame.
func FromWFFrame(frame WFFrameData, band BandConfig) (Result, error) {
	if len(frame.Bins) == 0 {
		return Result{}, ErrNoBins
	}

	numBins := len(frame.Bins)

	passLoKHz := band.CenterKHz + float64(band.PassbandLoHz)/1000.0
	passHiKHz := band.CenterKHz + float64(band.PassbandHiHz)/1000.0

	bw := effectiveBandwidth(frame.BandwidthKHz)

	binScale := 1 << (maxZoom - int(frame.Zoom))
	frameLoKHz := (float64(frame.XBin) / totalMasterBins) * bw
	frameHiKHz := (float64(int(frame.XBin)+numBins*binScale) / totalMasterBins) * bw
	if passHiKHz < frameLoKHz || passLoKHz > frameHiKHz {
		// KiwiSDR2 devices use 32 MHz bandwidth but may not report it.
		// If the passband doesn't overlap at the current bandwidth, try 32 MHz.
		if bw != altBandwidthKHz {
			altLo := (float64(frame.XBin) / totalMasterBins) * altBandwidthKHz
			altHi := (float64(int(frame.XBin)+numBins*binScale) / totalMasterBins) * altBandwidthKHz
			if passLoKHz < altHi && passHiKHz > altLo {
				bw = altBandwidthKHz
				frameLoKHz = altLo
				frameHiKHz = altHi
				goto passbandOK
			}
		}
		return Result{}, fmt.Errorf("%w (pass=%.1f-%.1fkHz frame=%.1f-%.1fkHz xBin=%d zoom=%d bins=%d bw=%.0f)",
			ErrPassbandOutside, passLoKHz, passHiKHz, frameLoKHz, frameHiKHz, frame.XBin, frame.Zoom, numBins, bw)
	}
passbandOK:

	loIdx := freqKHzToBin(passLoKHz, frame.XBin, frame.Zoom, numBins, bw)
	hiIdx := freqKHzToBin(passHiKHz, frame.XBin, frame.Zoom, numBins, bw)
	if loIdx > hiIdx {
		loIdx, hiIdx = hiIdx, loIdx
	}

	var inBandSum float64
	inBandCount := 0
	for i := loIdx; i <= hiIdx && i < numBins; i++ {
		inBandSum += float64(frame.Bins[i])
		inBandCount++
	}
	if inBandCount == 0 {
		return Result{}, ErrPassbandOutside
	}

	// Out-of-band reference: 2-5 kHz beyond each passband edge
	refLoStart := freqKHzToBin(passLoKHz-refMarginHiKHz, frame.XBin, frame.Zoom, numBins, bw)
	refLoEnd := freqKHzToBin(passLoKHz-refMarginLoKHz, frame.XBin, frame.Zoom, numBins, bw)
	refHiStart := freqKHzToBin(passHiKHz+refMarginLoKHz, frame.XBin, frame.Zoom, numBins, bw)
	refHiEnd := freqKHzToBin(passHiKHz+refMarginHiKHz, frame.XBin, frame.Zoom, numBins, bw)

	var outBandSum float64
	outBandCount := 0
	for i := refLoStart; i <= refLoEnd && i < numBins; i++ {
		if i >= 0 {
			outBandSum += float64(frame.Bins[i])
			outBandCount++
		}
	}
	for i := refHiStart; i <= refHiEnd && i < numBins; i++ {
		if i >= 0 {
			outBandSum += float64(frame.Bins[i])
			outBandCount++
		}
	}

	signalAvgByte := inBandSum / float64(inBandCount)
	noiseAvgByte := signalAvgByte // fallback if no out-of-band bins
	if outBandCount > 0 {
		noiseAvgByte = outBandSum / float64(outBandCount)
	}

	signalPowerdB := wfByteToDBm(signalAvgByte)
	noiseFloordB := wfByteToDBm(noiseAvgByte)
	snrdB := signalPowerdB - noiseFloordB

	return Result{
		InBandSNRdB:   snrdB,
		SignalPowerdB: signalPowerdB,
		NoiseFloordB:  noiseFloordB,
		BinsUsed:      inBandCount,
	}, nil
}

// FromWFFrames computes a time-averaged SNR from multiple frames.
// Averages the bin values across frames before computing SNR.
func FromWFFrames(frames []WFFrameData, band BandConfig) (Result, error) {
	if len(frames) == 0 {
		return Result{}, ErrNoFrames
	}
	if len(frames) == 1 {
		return FromWFFrame(frames[0], band)
	}

	// Average bins across frames. All frames must have the same bin count
	// and zoom/xBin (they come from the same probe session).
	first := frames[0]
	numBins := len(first.Bins)
	if numBins == 0 {
		return Result{}, ErrNoBins
	}

	avgBins := make([]float64, numBins)
	count := 0
	for _, f := range frames {
		if len(f.Bins) != numBins {
			continue
		}
		for i, b := range f.Bins {
			avgBins[i] += float64(b)
		}
		count++
	}
	if count == 0 {
		return Result{}, ErrNoBins
	}

	synthBins := make([]byte, numBins)
	for i := range avgBins {
		v := avgBins[i] / float64(count)
		if v < 0 {
			v = 0
		}
		if v > 255 {
			v = 255
		}
		synthBins[i] = byte(v)
	}

	return FromWFFrame(WFFrameData{
		Bins: synthBins,
		XBin: first.XBin,
		Zoom: first.Zoom,
	}, band)
}
