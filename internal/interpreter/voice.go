package interpreter

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/sammy/sdr-radio/internal/whisper"
)

// EnableVAD controls whether the energy-based VAD gate is active.
// When true, chunks with no energy above the noise floor are skipped.
// Set to false to send all audio to Whisper unconditionally.
var EnableVAD = false

const (
	voiceChunkSeconds    = 30
	vadFrameSamples      = 320 // ~26 ms at 12 kHz
	vadThresholdDB       = 10.0
	vadNoiseAlpha        = 0.05
	inferQueueSize       = 2
	progressUpdateEveryN = 12000 // ~1s at 12kHz
)

// whisperPool is the shared pool. Set by RegisterWhisperPool at startup.
var (
	whisperPoolMu sync.RWMutex
	whisperPool   *whisper.Pool
)

func RegisterWhisperPool(p *whisper.Pool) {
	whisperPoolMu.Lock()
	whisperPool = p
	whisperPoolMu.Unlock()
}

func getWhisperPool() *whisper.Pool {
	whisperPoolMu.RLock()
	defer whisperPoolMu.RUnlock()
	return whisperPool
}

type VoiceInterpreter struct {
	mu         sync.Mutex
	cfg        Config
	sampleRate int
	chunkSize  int // samples per chunk
	logFn      LogFunc

	pcmBuf          []int16
	samplesSinceUpd int

	// VAD state
	noiseFloor float64
	vadPrimed  bool

	// Async output
	outputFn func(Output)
	inferCh  chan []float32
	cancel   context.CancelFunc
}

func NewVoice(cfg Config, sampleRate int, logFn LogFunc) *VoiceInterpreter {
	chunkSize := sampleRate * voiceChunkSeconds

	logFn("info", "voice.create", fmt.Sprintf("sampleRate=%d chunk=%ds model=%q lang=%q vad=%v",
		sampleRate, voiceChunkSeconds, cfg.ModelSize, cfg.SourceLang, EnableVAD))

	ctx, cancel := context.WithCancel(context.Background())
	v := &VoiceInterpreter{
		cfg:        cfg,
		sampleRate: sampleRate,
		chunkSize:  chunkSize,
		logFn:      logFn,
		pcmBuf:     make([]int16, 0, chunkSize),
		noiseFloor: -30,
		inferCh:    make(chan []float32, inferQueueSize),
		cancel:     cancel,
	}

	go v.runInference(ctx)
	return v
}

func (v *VoiceInterpreter) SetOutputCallback(fn func(Output)) {
	v.mu.Lock()
	v.outputFn = fn
	v.mu.Unlock()
	v.logFn("debug", "voice.callback", fmt.Sprintf("wired=%v", fn != nil))
}

func (v *VoiceInterpreter) Feed(pcm []byte) []Output {
	if len(pcm) < 2 {
		return nil
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	nSamples := len(pcm) / 2
	for i := 0; i < nSamples; i++ {
		s := int16(binary.LittleEndian.Uint16(pcm[i*2:]))
		v.pcmBuf = append(v.pcmBuf, s)
	}
	v.samplesSinceUpd += nSamples

	if v.samplesSinceUpd >= progressUpdateEveryN && len(v.pcmBuf) < v.chunkSize {
		v.samplesSinceUpd = 0
		p := float64(len(v.pcmBuf)) / float64(v.chunkSize)
		fn := v.outputFn
		if fn != nil {
			fn(Output{Interpreter: "voice", Progress: &p})
		}
	}

	for len(v.pcmBuf) >= v.chunkSize {
		chunk := make([]int16, v.chunkSize)
		copy(chunk, v.pcmBuf[:v.chunkSize])
		v.pcmBuf = v.pcmBuf[v.chunkSize:]
		v.samplesSinceUpd = 0

		energy := chunkEnergyDB(chunk)
		if EnableVAD && !v.vadPass(chunk) {
			v.logFn("debug", "voice.vad.skip", fmt.Sprintf("energy=%.0fdB floor=%.0fdB", energy, v.noiseFloor))
			continue
		}

		resampled := resample12to16(chunk)
		queueLen := len(v.inferCh)
		v.logFn("info", "voice.chunk", fmt.Sprintf("%ds chunk (%.0fdB) queued (%d/%d)", voiceChunkSeconds, energy, queueLen+1, inferQueueSize))

		full := 1.0
		fn := v.outputFn
		if fn != nil {
			fn(Output{Interpreter: "voice", Progress: &full})
		}

		select {
		case v.inferCh <- resampled:
		default:
			v.logFn("warn", "voice.queue.full", "dropping oldest chunk")
			select {
			case <-v.inferCh:
			default:
			}
			select {
			case v.inferCh <- resampled:
			default:
			}
		}
	}

	return nil
}

func (v *VoiceInterpreter) vadPass(chunk []int16) bool {
	energy := chunkEnergyDB(chunk)

	if !v.vadPrimed {
		v.noiseFloor = energy
		v.vadPrimed = true
		return energy > -50
	}

	hasVoice := energy > v.noiseFloor+vadThresholdDB

	if !hasVoice {
		v.noiseFloor = v.noiseFloor*(1-vadNoiseAlpha) + energy*vadNoiseAlpha
	}

	return hasVoice
}

func chunkEnergyDB(samples []int16) float64 {
	if len(samples) == 0 {
		return -100
	}
	var sum float64
	for _, s := range samples {
		f := float64(s) / 32768.0
		sum += f * f
	}
	mean := sum / float64(len(samples))
	if mean < 1e-12 {
		return -100
	}
	return 10 * math.Log10(mean)
}

func (v *VoiceInterpreter) runInference(ctx context.Context) {
	v.logFn("info", "voice.infer.start", fmt.Sprintf("lang=%q vad=%v", v.cfg.SourceLang, EnableVAD))

	for {
		select {
		case <-ctx.Done():
			v.logFn("info", "voice.infer.stop", "context cancelled")
			return
		case samples, ok := <-v.inferCh:
			if !ok {
				v.logFn("info", "voice.infer.stop", "channel closed")
				return
			}

			pool := getWhisperPool()
			if pool == nil {
				v.logFn("error", "voice.infer.error", "whisper not available — rebuild with -tags whisper")
				return
			}

			dur := float64(len(samples)) / 16000.0
			task := "translate"

			v.mu.Lock()
			lang := v.cfg.SourceLang
			v.mu.Unlock()

			langLabel := lang
			if langLabel == "" {
				langLabel = "auto"
			}
			v.logFn("info", "voice.infer.run", fmt.Sprintf("%.0fs task=%s lang=%s", dur, task, langLabel))

			t0 := time.Now()
			segments, detectedLang, err := pool.Infer(samples, whisper.InferenceParams{
				Task:     task,
				Language: lang,
				Threads:  max(1, runtime.NumCPU()/2),
			})
			elapsed := time.Since(t0)

			if err != nil {
				v.logFn("error", "voice.infer.error", err.Error())
				continue
			}

			v.logFn("info", "voice.infer.done", fmt.Sprintf("%dms segments=%d detected=%s", elapsed.Milliseconds(), len(segments), detectedLang))

			v.mu.Lock()
			fn := v.outputFn
			v.mu.Unlock()
			if fn == nil {
				v.logFn("warn", "voice.output.nil", fmt.Sprintf("discarding %d segments", len(segments)))
				continue
			}

			var parts []string
			for _, seg := range segments {
				text := strings.TrimSpace(seg.Text)
				if text != "" {
					parts = append(parts, text)
				}
			}
			if len(parts) > 0 {
				fn(Output{
					Interpreter: "voice",
					Text:        strings.Join(parts, " "),
					Language:    detectedLang,
				})
			}
		}
	}
}

func (v *VoiceInterpreter) Reconfigure(cfg Config) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if cfg.ModelSize != "" && cfg.ModelSize != v.cfg.ModelSize {
		pool := getWhisperPool()
		if pool != nil {
			pool.SetModel(cfg.ModelSize)
		}
	}
	v.cfg = cfg
}

func (v *VoiceInterpreter) Reset() {
	if v.cancel != nil {
		v.cancel()
	}
	v.mu.Lock()
	v.pcmBuf = v.pcmBuf[:0]
	v.outputFn = nil
	v.mu.Unlock()
}
