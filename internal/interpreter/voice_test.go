package interpreter

import (
	"encoding/binary"
	"math"
	"sync"
	"testing"
	"time"
)

func TestVoiceInterpreter_BuffersAndChunks(t *testing.T) {
	cfg := Config{Type: "voice", Enabled: true}
	v := NewVoice(cfg, 12000)
	defer v.Reset()

	// Feed less than one chunk (5 seconds = 60000 samples at 12 kHz)
	frame := makeSilentPCM(1000)
	for i := 0; i < 50; i++ {
		v.Feed(frame)
	}
	// 50 * 1000 = 50000 samples, less than 60000 chunk size
	v.mu.Lock()
	bufLen := len(v.pcmBuf)
	v.mu.Unlock()
	if bufLen != 50000 {
		t.Errorf("expected 50000 buffered samples, got %d", bufLen)
	}
}

func TestVoiceInterpreter_VADSkipsQuietChunks(t *testing.T) {
	old := EnableVAD
	EnableVAD = true
	defer func() { EnableVAD = old }()

	cfg := Config{Type: "voice", Enabled: true}
	v := NewVoice(cfg, 12000)
	defer v.Reset()

	var mu sync.Mutex
	var outputs []Output
	v.SetOutputCallback(func(o Output) {
		mu.Lock()
		outputs = append(outputs, o)
		mu.Unlock()
	})

	// Feed exactly one chunk of silence (60000 samples)
	frame := makeSilentPCM(12000)
	for i := 0; i < 5; i++ {
		v.Feed(frame)
	}

	time.Sleep(50 * time.Millisecond)

	// No output should have been produced (VAD skipped silent chunk,
	// and even if it reached inference, there's no whisper pool)
	mu.Lock()
	n := len(outputs)
	mu.Unlock()
	if n != 0 {
		t.Errorf("expected no outputs for silent audio, got %d", n)
	}
}

func TestVoiceInterpreter_OutputCallbackWired(t *testing.T) {
	cfg := Config{Type: "voice", Enabled: true}
	v := NewVoice(cfg, 12000)
	defer v.Reset()

	v.SetOutputCallback(func(o Output) {})

	v.mu.Lock()
	fn := v.outputFn
	v.mu.Unlock()
	if fn == nil {
		t.Error("expected output callback to be set")
	}
}

func TestVoiceInterpreter_Reset(t *testing.T) {
	cfg := Config{Type: "voice", Enabled: true}
	v := NewVoice(cfg, 12000)

	frame := makeSilentPCM(1000)
	v.Feed(frame)

	v.Reset()

	v.mu.Lock()
	bufLen := len(v.pcmBuf)
	fn := v.outputFn
	v.mu.Unlock()
	if bufLen != 0 {
		t.Errorf("expected empty buffer after reset, got %d", bufLen)
	}
	if fn != nil {
		t.Error("expected nil outputFn after reset")
	}
}

func TestVADPass_DetectsTone(t *testing.T) {
	cfg := Config{Type: "voice", Enabled: true}
	v := NewVoice(cfg, 12000)
	defer v.Reset()

	// Prime with a quiet chunk first
	quiet := make([]int16, 60000)
	v.vadPass(quiet)

	// Now test with a loud tone
	loud := make([]int16, 60000)
	for i := range loud {
		loud[i] = int16(0.5 * 32767 * math.Sin(2*math.Pi*440*float64(i)/12000))
	}
	if !v.vadPass(loud) {
		t.Error("expected VAD to pass loud tone after silent calibration")
	}
}

func TestVADPass_RejectsSilence(t *testing.T) {
	cfg := Config{Type: "voice", Enabled: true}
	v := NewVoice(cfg, 12000)
	defer v.Reset()

	// Prime
	quiet := make([]int16, 60000)
	v.vadPass(quiet)

	// Another silent chunk should be rejected
	if v.vadPass(quiet) {
		t.Error("expected VAD to reject silence")
	}
}

func TestChunkEnergyDB(t *testing.T) {
	// Full-scale sine: RMS = 1/sqrt(2), energy in dB ≈ -3.01
	n := 48000
	samples := make([]int16, n)
	for i := range samples {
		samples[i] = int16(32767 * math.Sin(2*math.Pi*440*float64(i)/12000))
	}
	e := chunkEnergyDB(samples)
	if e < -4 || e > -2 {
		t.Errorf("expected energy ~-3 dB for full-scale sine, got %.1f dB", e)
	}

	// Silence should be very low
	silent := make([]int16, 1000)
	e = chunkEnergyDB(silent)
	if e > -90 {
		t.Errorf("expected very low energy for silence, got %.1f dB", e)
	}
}

func makeSilentPCM(nSamples int) []byte {
	return make([]byte, nSamples*2)
}

func makeTonePCM(nSamples int, freqHz float64, sampleRate int, amplitude float64) []byte {
	buf := make([]byte, nSamples*2)
	for i := 0; i < nSamples; i++ {
		s := int16(amplitude * 32767 * math.Sin(2*math.Pi*freqHz*float64(i)/float64(sampleRate)))
		binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
	}
	return buf
}
