package probe

import (
	"context"
	"encoding/binary"
	"math"
	"time"

	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
	"github.com/sammy/sdr-radio/internal/snr"
)

const (
	ProbeAnalysisWindow = 30 * time.Second
	ProbeStoredAudio    = 3 * time.Second
	ProbeIdentUser      = "sdr-radio-probe"
	SilenceThresholdDB  = -60.0
)

func ProbeSource(ctx context.Context, candidate CandidateSource, stream models.Stream) ProbeResult {
	result := ProbeResult{
		SourceID:   candidate.Source.ID,
		SourceName: candidate.Source.Name,
		SourceHost: candidate.Source.Host,
		SourcePort: candidate.Source.Port,
		DistanceKm: candidate.DistanceKm,
		BearingDeg: candidate.BearingDeg,
	}

	connectStart := time.Now()

	ts := kiwi.ConnectTimestamp()
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	client, err := kiwi.Connect(probeCtx, kiwi.Config{
		Host:          candidate.Source.Host,
		Port:          candidate.Source.Port,
		UseTLS:        candidate.Source.UseTLS,
		Name:          ProbeIdentUser,
		FrequencyKHz:  stream.FrequencyKHz,
		Mode:          stream.Mode,
		BandwidthLoHz: stream.BandwidthLowHz,
		BandwidthHiHz: stream.BandwidthHighHz,
		AGCOn:         true,
	}, ts, nil)
	if err != nil {
		result.Error = err
		return result
	}
	defer client.Close()

	var wfClient *kiwi.WFClient
	wfClient, err = kiwi.ConnectWF(probeCtx, kiwi.WFConfig{
		Host:      candidate.Source.Host,
		Port:      candidate.Source.Port,
		UseTLS:    candidate.Source.UseTLS,
		Name:      ProbeIdentUser,
		Zoom:      10,
		CenterKHz: stream.FrequencyKHz,
		Speed:     4,
		Compress:  false,
	}, ts, nil)
	if err != nil {
		// W/F connect failed, continuing audio-only
	}
	if wfClient != nil {
		defer wfClient.Close()
	}

	result.Connected = true
	result.SampleRate = client.SampleRate()
	result.SlotUsers = candidate.Source.Users
	result.SlotMax = candidate.Source.MaxListeners
	firstFrameAt := time.Time{}
	deadline := time.After(ProbeAnalysisWindow)

	var audioFrames [][]byte
	var audioTimes []time.Time
	var wfFrames []kiwi.WFFrame

	finalize := func() {
		wfBandwidthKHz := 30000.0
		if wfClient != nil {
			if bw := wfClient.MaxFreqKHz(); bw > 0 {
				wfBandwidthKHz = float64(bw)
			}
		}
		result.Snapshot = analyzeFrames(audioFrames, audioTimes, wfFrames, connectStart, firstFrameAt, stream, wfBandwidthKHz)
		result.LatencyMs = latencyMs(connectStart, firstFrameAt)
		result.RawPCM = TruncateAudio(audioFrames, result.SampleRate, ProbeStoredAudio)
	}

	for {
		select {
		case <-probeCtx.Done():
			finalize()
			return result
		case <-deadline:
			finalize()
			return result
		case <-client.Done():
			finalize()
			return result
		case frame, ok := <-client.Samples():
			if !ok {
				finalize()
				return result
			}
			now := time.Now()
			if firstFrameAt.IsZero() {
				firstFrameAt = now
			}
			buf := make([]byte, len(frame))
			copy(buf, frame)
			audioFrames = append(audioFrames, buf)
			audioTimes = append(audioTimes, now)
		case wfFrame, ok := <-readWF(wfClient):
			if ok {
				wfFrames = append(wfFrames, wfFrame)
			}
		}
	}
}

func readWF(wf *kiwi.WFClient) <-chan kiwi.WFFrame {
	if wf == nil {
		return nil
	}
	return wf.Frames()
}

func latencyMs(connectStart time.Time, firstFrame time.Time) float64 {
	if firstFrame.IsZero() {
		return 5000
	}
	return float64(firstFrame.Sub(connectStart).Milliseconds())
}

func analyzeFrames(audioFrames [][]byte, audioTimes []time.Time, wfFrames []kiwi.WFFrame, connectStart, firstFrameAt time.Time, stream models.Stream, bandwidthKHz float64) AudioSnapshot {
	snap := AudioSnapshot{
		RMSDB:      -60,
		PeakRMSDB:  -60,
		FloorRMSDB: -60,
	}

	if len(audioFrames) == 0 {
		snap.SilenceRatio = 1.0
		return snap
	}

	elapsed := ProbeAnalysisWindow.Seconds()
	if !firstFrameAt.IsZero() {
		elapsed = time.Since(firstFrameAt).Seconds()
		if elapsed < 0.1 {
			elapsed = ProbeAnalysisWindow.Seconds()
		}
	}
	snap.FrameRate = float64(len(audioFrames)) / elapsed

	var totalRMS float64
	peakRMS := -100.0
	floorRMS := 0.0
	silentCount := 0

	for i, frame := range audioFrames {
		rms := frameRMSdB(frame)
		totalRMS += rms
		if rms > peakRMS {
			peakRMS = rms
		}
		if i == 0 || rms < floorRMS {
			floorRMS = rms
		}
		if rms < SilenceThresholdDB {
			silentCount++
		}
	}

	snap.RMSDB = totalRMS / float64(len(audioFrames))
	snap.PeakRMSDB = peakRMS
	snap.FloorRMSDB = floorRMS
	snap.SilenceRatio = float64(silentCount) / float64(len(audioFrames))

	// Frame delivery consistency (coefficient of variation of inter-frame intervals)
	if len(audioTimes) > 2 {
		intervals := make([]float64, len(audioTimes)-1)
		var sum float64
		for i := 1; i < len(audioTimes); i++ {
			d := audioTimes[i].Sub(audioTimes[i-1]).Seconds()
			intervals[i-1] = d
			sum += d
		}
		mean := sum / float64(len(intervals))
		if mean > 0 {
			var variance float64
			for _, d := range intervals {
				diff := d - mean
				variance += diff * diff
			}
			variance /= float64(len(intervals))
			snap.FrameDeliveryCV = math.Sqrt(variance) / mean
		}
	}

	snap.WFFrameCount = len(wfFrames)
	if len(wfFrames) > 0 {
		wfData := make([]snr.WFFrameData, len(wfFrames))
		for i, f := range wfFrames {
			wfData[i] = snr.WFFrameData{Bins: f.Bins, XBin: f.XBin, Zoom: f.Zoom, BandwidthKHz: bandwidthKHz}
		}
		band := snr.BandConfig{
			CenterKHz:    stream.FrequencyKHz,
			PassbandLoHz: stream.BandwidthLowHz,
			PassbandHiHz: stream.BandwidthHighHz,
		}
		if result, err := snr.FromWFFrames(wfData, band); err == nil {
			snap.InBandSNRdB = result.InBandSNRdB
			snap.NoiseFloordB = result.NoiseFloordB
		} else {
			snap.SNRError = err.Error()
		}
	}

	return snap
}

func frameRMSdB(pcm []byte) float64 {
	numSamples := len(pcm) / 2
	if numSamples == 0 {
		return -96
	}

	var sumSq float64
	for i := 0; i < numSamples; i++ {
		sample := int16(binary.LittleEndian.Uint16(pcm[i*2 : i*2+2]))
		norm := float64(sample) / 32768.0
		sumSq += norm * norm
	}

	rms := math.Sqrt(sumSq / float64(numSamples))
	if rms < 1e-10 {
		return -96
	}
	return 20 * math.Log10(rms)
}

func concatFrames(frames [][]byte) []byte {
	totalLen := 0
	for _, f := range frames {
		totalLen += len(f)
	}
	buf := make([]byte, 0, totalLen)
	for _, f := range frames {
		buf = append(buf, f...)
	}
	return buf
}

// TruncateAudio keeps only the first `dur` worth of PCM frames.
func TruncateAudio(frames [][]byte, sampleRate int, dur time.Duration) []byte {
	if sampleRate <= 0 {
		sampleRate = 12000
	}
	maxBytes := int(dur.Seconds()) * sampleRate * 2 // 16-bit mono
	var buf []byte
	for _, f := range frames {
		remaining := maxBytes - len(buf)
		if remaining <= 0 {
			break
		}
		if len(f) > remaining {
			buf = append(buf, f[:remaining]...)
		} else {
			buf = append(buf, f...)
		}
	}
	return buf
}

func CaptureReferenceSnapshot(audioFrames [][]byte, wfFrames []kiwi.WFFrame, duration time.Duration, stream models.Stream, bandwidthKHz float64) AudioSnapshot {
	snap := AudioSnapshot{
		RMSDB:      -60,
		PeakRMSDB:  -60,
		FloorRMSDB: -60,
	}

	if len(audioFrames) == 0 {
		snap.SilenceRatio = 1.0
		return snap
	}

	elapsed := duration.Seconds()
	if elapsed < 0.1 {
		elapsed = 3.0
	}
	snap.FrameRate = float64(len(audioFrames)) / elapsed

	var totalRMS float64
	peakRMS := -100.0
	floorRMS := 0.0
	silentCount := 0

	for i, frame := range audioFrames {
		rms := frameRMSdB(frame)
		totalRMS += rms
		if rms > peakRMS {
			peakRMS = rms
		}
		if i == 0 || rms < floorRMS {
			floorRMS = rms
		}
		if rms < SilenceThresholdDB {
			silentCount++
		}
	}

	snap.RMSDB = totalRMS / float64(len(audioFrames))
	snap.PeakRMSDB = peakRMS
	snap.FloorRMSDB = floorRMS
	snap.SilenceRatio = float64(silentCount) / float64(len(audioFrames))

	if len(wfFrames) > 0 {
		wfData := make([]snr.WFFrameData, len(wfFrames))
		for i, f := range wfFrames {
			wfData[i] = snr.WFFrameData{Bins: f.Bins, XBin: f.XBin, Zoom: f.Zoom, BandwidthKHz: bandwidthKHz}
		}
		band := snr.BandConfig{
			CenterKHz:    stream.FrequencyKHz,
			PassbandLoHz: stream.BandwidthLowHz,
			PassbandHiHz: stream.BandwidthHighHz,
		}
		if result, err := snr.FromWFFrames(wfData, band); err == nil {
			snap.InBandSNRdB = result.InBandSNRdB
			snap.NoiseFloordB = result.NoiseFloordB
		}
	}

	return snap
}
