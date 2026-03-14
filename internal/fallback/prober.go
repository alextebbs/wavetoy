package fallback

import (
	"context"
	"encoding/binary"
	"math"
	"time"

	"github.com/sammy/sdr-radio/internal/kiwi"
	"github.com/sammy/sdr-radio/internal/models"
)

const (
	ProbeAnalysisWindow = 3 * time.Second
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
		Zoom:      0,
		CenterKHz: 15000.0,
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
	firstFrameAt := time.Time{}
	deadline := time.After(ProbeAnalysisWindow)

	var audioFrames [][]byte
	var wfFrames []kiwi.WFFrame

	finalize := func() {
		result.Snapshot = analyzeFrames(audioFrames, wfFrames, connectStart, firstFrameAt, stream)
		result.LatencyMs = latencyMs(connectStart, firstFrameAt)
		result.RawPCM = concatFrames(audioFrames)
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
			if firstFrameAt.IsZero() {
				firstFrameAt = time.Now()
			}
			buf := make([]byte, len(frame))
			copy(buf, frame)
			audioFrames = append(audioFrames, buf)
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

func analyzeFrames(audioFrames [][]byte, wfFrames []kiwi.WFFrame, connectStart, firstFrameAt time.Time, stream models.Stream) AudioSnapshot {
	snap := AudioSnapshot{
		RMSDB:     -60,
		PeakRMSDB: -60,
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

	if len(wfFrames) > 0 {
		snap.WFBinsInBand = extractInBandBins(wfFrames, stream)
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

func extractInBandBins(wfFrames []kiwi.WFFrame, stream models.Stream) []float64 {
	if len(wfFrames) == 0 {
		return nil
	}

	last := wfFrames[len(wfFrames)-1]
	if len(last.Bins) == 0 {
		return nil
	}

	bins := make([]float64, len(last.Bins))
	for i, b := range last.Bins {
		bins[i] = float64(b)
	}
	return bins
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

func CaptureReferenceSnapshot(audioFrames [][]byte, wfFrames []kiwi.WFFrame, duration time.Duration, stream models.Stream) AudioSnapshot {
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
		snap.WFBinsInBand = extractInBandBins(wfFrames, stream)
	}

	return snap
}
