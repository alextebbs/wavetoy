package api

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sammy/sdr-radio/internal/chunkring"
	"github.com/sammy/sdr-radio/internal/interpreter"
	"github.com/sammy/sdr-radio/internal/models"
)

const (
	mfStreamID   = "__minefield__"
	mfSampleRate = 12000
	mfChunkDur   = 60 // seconds
	mfWFBins     = 1024
	mfWFFPS      = 8
	mfMaxFreqKHz = 30000
)

type mfScenario struct {
	id       string
	tsOffset int // slot index from epoch; gap at slot 14 means no chunk there
}

var mfScenarios = []mfScenario{
	{id: "baseline", tsOffset: 0},
	{id: "empty-audio", tsOffset: 1},
	{id: "empty-wf", tsOffset: 2},
	{id: "both-empty", tsOffset: 3},
	{id: "huge-audio", tsOffset: 4},
	{id: "huge-wf", tsOffset: 5},
	{id: "short-audio", tsOffset: 6},
	{id: "short-wf", tsOffset: 7},
	{id: "wf-zoom-change", tsOffset: 8},
	{id: "wf-512-bins", tsOffset: 9},
	{id: "wf-mixed-bins", tsOffset: 10},
	{id: "wrong-sample-rate", tsOffset: 11},
	{id: "truncated-wav", tsOffset: 12},
	{id: "corrupt-wav", tsOffset: 13},
	// slot 14 is intentionally missing (gap test)
	{id: "wf-timestamps-reversed", tsOffset: 15},
	{id: "wf-zero-bins-frame", tsOffset: 16},
	{id: "manifest-lies-audio", tsOffset: 17},
	{id: "manifest-lies-wf", tsOffset: 18},
	{id: "source-change", tsOffset: 19},
	{id: "baseline-end", tsOffset: 20},
}

const mfTotalSlots = 21 // 0..20 inclusive

func mfEpoch() int64 {
	now := time.Now().Unix()
	hourAligned := (now / 3600) * 3600
	return hourAligned - 3600
}

func mfResolveScenario(r *http.Request) (int64, *mfScenario) {
	tsStr := chi.URLParam(r, "ts")
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return 0, nil
	}
	epoch := mfEpoch()
	offset := int((ts - epoch) / mfChunkDur)
	for i := range mfScenarios {
		if mfScenarios[i].tsOffset == offset {
			return ts, &mfScenarios[i]
		}
	}
	return 0, nil
}

func mfFakeStream() *models.Stream {
	return &models.Stream{
		ID:              mfStreamID,
		TenantID:        "minefield",
		SourceID:        "minefield-source",
		FrequencyKHz:    14100,
		BandwidthLowHz:  -3000,
		BandwidthHighHz: 3000,
		Mode:            "usb",
		Name:            "Minefield Stress Test",
		AGCOn:           true,
		BufferMinutes:   30,
		State:           "connected",
		Version:         1,
		WFViewStartKHz:  0,
		WFViewEndKHz:    float64(mfMaxFreqKHz),
		CreatedAt:       time.Now().Add(-1 * time.Hour),
		UpdatedAt:       time.Now(),
		Interpreter:     interpreter.Config{},
	}
}

// isMinefield returns true if the request targets the minefield stream.
func isMinefield(r *http.Request) bool {
	return chi.URLParam(r, "id") == mfStreamID
}

// minefieldStream handles GET /api/streams/__minefield__.
func (s *Server) minefieldStream(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, mfFakeStream())
}

// minefieldWSConnected returns the payload the WS should send when a client
// subscribes to stream:__minefield__.
func minefieldWSConnected() map[string]any {
	return map[string]any{
		"type":         "connected",
		"stream":       mfFakeStream(),
		"sample_rate":  mfSampleRate,
		"audio_type":   "pcm_s16le",
		"peers":        []any{},
		"max_freq_khz": mfMaxFreqKHz,
	}
}

// --- Manifest ---

func (s *Server) minefieldManifest(w http.ResponseWriter, r *http.Request) {
	fromStr := chi.URLParam(r, "from")
	toStr := chi.URLParam(r, "to")
	fromTS, _ := strconv.ParseInt(fromStr, 10, 64)
	toTS, _ := strconv.ParseInt(toStr, 10, 64)

	epoch := mfEpoch()
	chunks := make([]rewindChunkJSON, 0, len(mfScenarios))

	for _, sc := range mfScenarios {
		ts := epoch + int64(sc.tsOffset)*mfChunkDur
		if ts < fromTS || ts >= toTS {
			continue
		}

		chunk := buildMinefieldChunk(sc.id, ts)
		audioBytes := len(chunk.AudioPCM)
		wfFrames := len(chunk.WFFrames)
		sourceID := chunk.SourceID

		switch sc.id {
		case "manifest-lies-audio":
			audioBytes = 0
		case "manifest-lies-wf":
			wfFrames = 0
		case "truncated-wav":
			audioBytes = mfSampleRate * 2 * mfChunkDur
		}

		chunks = append(chunks, rewindChunkJSON{
			StartedAt:  ts,
			EndedAt:    ts + mfChunkDur,
			Complete:   true,
			AudioBytes: audioBytes,
			WFFrames:   wfFrames,
			Events:     len(chunk.Events),
			Source:     "ring",
			SourceID:   sourceID,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stream_id":        mfStreamID,
		"sample_rate":      mfSampleRate,
		"chunk_duration_s": mfChunkDur,
		"chunks":           chunks,
	})
}

// --- Audio ---

func (s *Server) minefieldAudio(w http.ResponseWriter, r *http.Request) {
	ts, sc := mfResolveScenario(r)
	if sc == nil {
		writeError(w, http.StatusNotFound, "chunk not found", "NOT_FOUND")
		return
	}

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "public, max-age=3600, immutable")

	if sc.id == "truncated-wav" {
		w.Write([]byte("RIFF\x00\x00\x00\x00WAVEfmt 5678"))
		return
	}

	chunk := buildMinefieldChunk(sc.id, ts)
	chunkring.SerializeAudioWAV(w, chunk)
}

// --- Waterfall ---

func (s *Server) minefieldWF(w http.ResponseWriter, r *http.Request) {
	ts, sc := mfResolveScenario(r)
	if sc == nil {
		writeError(w, http.StatusNotFound, "chunk not found", "NOT_FOUND")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=3600, immutable")

	chunk := buildMinefieldChunk(sc.id, ts)
	chunkring.SerializeWF(w, chunk)
}

// --- Events ---

func (s *Server) minefieldEvents(w http.ResponseWriter, r *http.Request) {
	ts, sc := mfResolveScenario(r)
	if sc == nil {
		writeError(w, http.StatusNotFound, "chunk not found", "NOT_FOUND")
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "public, max-age=3600, immutable")

	chunk := buildMinefieldChunk(sc.id, ts)
	chunkring.SerializeEvents(w, chunk)
}

// --- Chunk Builder ---

func buildMinefieldChunk(id string, startTS int64) *chunkring.Chunk {
	startTime := time.Unix(startTS, 0)
	endTime := startTime.Add(mfChunkDur * time.Second)
	startMS := startTS * 1000

	chunk := &chunkring.Chunk{
		StartedAt:  startTime,
		EndedAt:    endTime,
		Complete:   true,
		SampleRate: mfSampleRate,
		SourceID:   "minefield",
		Events: []chunkring.Event{
			{
				TimestampMs: startMS + 1000,
				Type:        "log",
				Data:        json.RawMessage(`{"msg":"minefield chunk: ` + id + `"}`),
			},
		},
	}

	audioDurS := mfChunkDur
	wfFrameCount := mfChunkDur * mfWFFPS
	wfBinCount := mfWFBins
	wfZoom := uint16(5)
	skipAudio := false
	skipWF := false

	switch id {
	case "baseline", "baseline-end", "manifest-lies-audio", "manifest-lies-wf":
		// defaults

	case "source-change":
		chunk.SourceID = "minefield-alt"

	case "empty-audio":
		skipAudio = true

	case "empty-wf":
		skipWF = true

	case "both-empty":
		skipAudio = true
		skipWF = true

	case "huge-audio":
		audioDurS = 180

	case "huge-wf":
		wfFrameCount = 1440

	case "short-audio":
		audioDurS = 10

	case "short-wf":
		wfFrameCount = 80

	case "wf-zoom-change", "wf-mixed-bins", "wf-timestamps-reversed", "wf-zero-bins-frame":
		// WF built in the special-case switch below

	case "wf-512-bins":
		wfBinCount = 512

	case "wrong-sample-rate":
		chunk.SampleRate = 44100

	case "truncated-wav":
		skipAudio = true

	case "corrupt-wav":
		skipAudio = true
	}

	if !skipAudio {
		chunk.AudioPCM = mfSineWavePCM(audioDurS, mfSampleRate)
	}

	if !skipWF {
		switch id {
		case "wf-zoom-change":
			first := mfGradientWF(240, mfWFBins, startMS, 5)
			second := mfGradientWF(240, mfWFBins, startMS+240*125, 8)
			chunk.WFFrames = append(first, second...)

		case "wf-mixed-bins":
			chunk.WFFrames = mfMixedBinsWF(wfFrameCount, startMS)

		case "wf-timestamps-reversed":
			frames := mfGradientWF(wfFrameCount, wfBinCount, startMS, wfZoom)
			for i, j := 0, len(frames)-1; i < j; i, j = i+1, j-1 {
				frames[i], frames[j] = frames[j], frames[i]
			}
			chunk.WFFrames = frames

		case "wf-zero-bins-frame":
			chunk.WFFrames = mfZeroBinsWF(wfFrameCount, startMS)

		default:
			chunk.WFFrames = mfGradientWF(wfFrameCount, wfBinCount, startMS, wfZoom)
		}
	}

	if id == "corrupt-wav" {
		rng := rand.New(rand.NewSource(42))
		pcm := make([]byte, mfSampleRate*2*mfChunkDur+1) // odd length
		rng.Read(pcm)
		chunk.AudioPCM = pcm
	}

	return chunk
}

// --- Data Generators ---

func mfSineWavePCM(durS int, sampleRate int) []byte {
	numSamples := durS * sampleRate
	pcm := make([]byte, numSamples*2)
	for i := 0; i < numSamples; i++ {
		t := float64(i) / float64(sampleRate)
		sample := int16(math.Sin(2*math.Pi*440*t) * 32000)
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(sample))
	}
	return pcm
}

func mfGradientWF(numFrames int, numBins int, startMS int64, zoom uint16) []chunkring.WFFrame {
	frames := make([]chunkring.WFFrame, numFrames)
	intervalMS := int64(1000 / mfWFFPS)
	for i := 0; i < numFrames; i++ {
		bins := make([]byte, numBins)
		for j := range bins {
			bins[j] = byte((j + i) % 256)
		}
		frames[i] = chunkring.WFFrame{
			TimestampMs: startMS + int64(i)*intervalMS,
			Bins:        bins,
			XBin:        0,
			Zoom:        zoom,
			FreqKHz:     14100.0,
			PassbandLo:  -3000,
			PassbandHi:  3000,
		}
	}
	return frames
}

func mfMixedBinsWF(numFrames int, startMS int64) []chunkring.WFFrame {
	frames := make([]chunkring.WFFrame, numFrames)
	intervalMS := int64(1000 / mfWFFPS)
	for i := range frames {
		binCount := mfWFBins
		if i%2 == 1 {
			binCount = 512
		}
		bins := make([]byte, binCount)
		for j := range bins {
			bins[j] = byte((j + i) % 256)
		}
		frames[i] = chunkring.WFFrame{
			TimestampMs: startMS + int64(i)*intervalMS,
			Bins:        bins,
			XBin:        0,
			Zoom:        5,
			FreqKHz:     14100.0,
			PassbandLo:  -3000,
			PassbandHi:  3000,
		}
	}
	return frames
}

func mfZeroBinsWF(numFrames int, startMS int64) []chunkring.WFFrame {
	frames := make([]chunkring.WFFrame, 0, numFrames)
	intervalMS := int64(1000 / mfWFFPS)
	for i := 0; i < 10 && i < numFrames; i++ {
		frames = append(frames, chunkring.WFFrame{
			TimestampMs: startMS + int64(i)*intervalMS,
			XBin:        0,
			Zoom:        5,
			FreqKHz:     14100.0,
			PassbandLo:  -3000,
			PassbandHi:  3000,
		})
	}
	rest := mfGradientWF(numFrames-len(frames), mfWFBins, startMS+int64(len(frames))*intervalMS, 5)
	frames = append(frames, rest...)
	return frames
}
