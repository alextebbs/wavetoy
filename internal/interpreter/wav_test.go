package interpreter

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type wavHeader struct {
	SampleRate    int
	NumChannels   int
	BitsPerSample int
	DataSize      int
}

func parseWAV(data []byte) (wavHeader, []byte, error) {
	if len(data) < 44 {
		return wavHeader{}, nil, fmt.Errorf("file too small for WAV header")
	}
	if string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return wavHeader{}, nil, fmt.Errorf("not a WAV file")
	}

	// Walk chunks to find "fmt " and "data"
	var hdr wavHeader
	pos := 12
	var audioData []byte

	for pos+8 <= len(data) {
		chunkID := string(data[pos : pos+4])
		chunkSize := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		chunkData := pos + 8

		switch chunkID {
		case "fmt ":
			if chunkSize < 16 || chunkData+16 > len(data) {
				return wavHeader{}, nil, fmt.Errorf("fmt chunk too small")
			}
			format := binary.LittleEndian.Uint16(data[chunkData : chunkData+2])
			if format != 1 {
				return wavHeader{}, nil, fmt.Errorf("unsupported format %d (only PCM=1)", format)
			}
			hdr.NumChannels = int(binary.LittleEndian.Uint16(data[chunkData+2 : chunkData+4]))
			hdr.SampleRate = int(binary.LittleEndian.Uint32(data[chunkData+4 : chunkData+8]))
			hdr.BitsPerSample = int(binary.LittleEndian.Uint16(data[chunkData+14 : chunkData+16]))

		case "data":
			end := chunkData + chunkSize
			if end > len(data) {
				end = len(data)
			}
			audioData = data[chunkData:end]
			hdr.DataSize = len(audioData)
		}

		pos = chunkData + chunkSize
		if pos%2 != 0 {
			pos++ // WAV chunks are word-aligned
		}
	}

	if audioData == nil {
		return wavHeader{}, nil, fmt.Errorf("no data chunk found")
	}
	return hdr, audioData, nil
}

// toPCM16Mono converts WAV audio data to mono PCM16 little-endian samples.
func toPCM16Mono(hdr wavHeader, raw []byte) ([]int16, error) {
	bytesPerSample := hdr.BitsPerSample / 8
	frameSize := bytesPerSample * hdr.NumChannels
	nFrames := len(raw) / frameSize

	samples := make([]int16, nFrames)
	for i := 0; i < nFrames; i++ {
		offset := i * frameSize
		var val int16
		switch hdr.BitsPerSample {
		case 16:
			val = int16(binary.LittleEndian.Uint16(raw[offset : offset+2]))
		case 8:
			val = int16(raw[offset]-128) * 256
		case 32:
			val = int16(int32(binary.LittleEndian.Uint32(raw[offset:offset+4])) >> 16)
		default:
			return nil, fmt.Errorf("unsupported bits per sample: %d", hdr.BitsPerSample)
		}
		samples[i] = val
	}
	return samples, nil
}

// resample16 converts samples from srcRate to dstRate using linear interpolation.
func resample16(src []int16, srcRate, dstRate int) []int16 {
	if srcRate == dstRate {
		return src
	}
	ratio := float64(srcRate) / float64(dstRate)
	outLen := int(float64(len(src)) / ratio)
	out := make([]int16, outLen)
	for i := 0; i < outLen; i++ {
		srcPos := float64(i) * ratio
		idx := int(srcPos)
		frac := srcPos - float64(idx)
		if idx+1 < len(src) {
			out[i] = int16(float64(src[idx])*(1-frac) + float64(src[idx+1])*frac)
		} else if idx < len(src) {
			out[i] = src[idx]
		}
	}
	return out
}

// samplesToBytes converts int16 samples to PCM16 little-endian bytes.
func samplesToBytes(samples []int16) []byte {
	buf := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
	}
	return buf
}

const decoderSampleRate = 12000

// TestMorseWAVFiles reads .wav files from testdata/ and runs the Morse
// decoder against each one. Drop any CW .wav file into testdata/ and run:
//
//	go test ./internal/interpreter/ -run TestMorseWAVFiles -v
//
// Files can optionally have an expected output encoded in the filename:
//
//	testdata/SOS_20wpm.wav      → expects decoded text to contain "SOS"
//	testdata/CQ_DX.wav          → expects "CQ DX" (underscores → spaces)
//	testdata/random_signal.wav  → no assertion, just prints decoded output
//
// The part before the first numeric suffix or the whole stem (minus
// extension) is treated as the expected text. If the filename starts
// with "x_" it is treated as a freeform file with no expected output.
func TestMorseWAVFiles(t *testing.T) {
	testdataDir := filepath.Join("testdata")
	entries, err := os.ReadDir(testdataDir)
	if err != nil {
		t.Skipf("no testdata directory: %v", err)
	}

	var wavFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".wav") {
			wavFiles = append(wavFiles, filepath.Join(testdataDir, e.Name()))
		}
	}

	if len(wavFiles) == 0 {
		t.Skip("no .wav files in testdata/")
	}

	for _, path := range wavFiles {
		name := filepath.Base(path)
		t.Run(name, func(t *testing.T) {
			decoded, sidetoneHz := decodeMorseWAV(t, path)

			t.Logf("File:     %s", name)
			t.Logf("Sidetone: %d Hz", sidetoneHz)
			t.Logf("Decoded:  %q", decoded)
			t.Logf("")

			expected := expectedFromFilename(name)
			if expected != "" {
				normalized := strings.TrimSpace(strings.ToUpper(decoded))
				if !strings.Contains(normalized, expected) {
					t.Errorf("expected decoded text to contain %q, got %q", expected, normalized)
				}
			}
		})
	}
}

func decodeMorseWAV(t *testing.T, path string) (text string, sidetoneHz int) {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	hdr, rawAudio, err := parseWAV(data)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}

	t.Logf("WAV: %d Hz, %d ch, %d bit, %.1f sec",
		hdr.SampleRate, hdr.NumChannels, hdr.BitsPerSample,
		float64(hdr.DataSize)/float64(hdr.SampleRate*hdr.NumChannels*(hdr.BitsPerSample/8)))

	samples, err := toPCM16Mono(hdr, rawAudio)
	if err != nil {
		t.Fatalf("convert %s: %v", path, err)
	}

	if hdr.SampleRate != decoderSampleRate {
		t.Logf("Resampling %d Hz → %d Hz", hdr.SampleRate, decoderSampleRate)
		samples = resample16(samples, hdr.SampleRate, decoderSampleRate)
	}

	pcm := samplesToBytes(samples)

	// Use the real interpreter chain: Config → New() → NewRunner()
	cfg := Config{
		Type:    "morse",
		Enabled: true,
	}

	audioCh := make(chan []byte, 64)

	var mu sync.Mutex
	var sb strings.Builder
	sidetoneHz = 700

	runner := NewRunner(cfg, decoderSampleRate, audioCh, func(o Output) {
		mu.Lock()
		defer mu.Unlock()
		if o.Text != "" {
			sb.WriteString(o.Text)
		}
		if o.SidetoneHz > 0 {
			sidetoneHz = o.SidetoneHz
		}
	})

	// Feed audio in 100ms chunks, same way the stream manager does
	chunkSamples := decoderSampleRate / 10
	chunkBytes := chunkSamples * 2

	for i := 0; i < len(pcm); i += chunkBytes {
		end := i + chunkBytes
		if end > len(pcm) {
			end = len(pcm)
		}
		chunk := make([]byte, end-i)
		copy(chunk, pcm[i:end])
		audioCh <- chunk
	}

	// Feed trailing silence to flush any buffered character
	silence := make([]byte, decoderSampleRate*2)
	audioCh <- silence

	// Give the runner goroutines time to drain
	time.Sleep(100 * time.Millisecond)

	runner.Stop()

	mu.Lock()
	text = sb.String()
	mu.Unlock()

	return text, sidetoneHz
}

// expectedFromFilename extracts expected decoded text from the wav filename.
// "SOS_20wpm.wav" → "SOS", "CQ_DX.wav" → "CQ DX", "x_anything.wav" → ""
func expectedFromFilename(name string) string {
	stem := strings.TrimSuffix(name, filepath.Ext(name))

	if strings.HasPrefix(strings.ToLower(stem), "x_") {
		return ""
	}

	// Strip trailing _NNwpm or _NNNhz suffixes
	parts := strings.Split(stem, "_")
	var textParts []string
	for _, p := range parts {
		lower := strings.ToLower(p)
		if strings.HasSuffix(lower, "wpm") || strings.HasSuffix(lower, "hz") {
			if isNumericPrefix(lower) {
				continue
			}
		}
		textParts = append(textParts, p)
	}

	return strings.ToUpper(strings.Join(textParts, " "))
}

func isNumericPrefix(s string) bool {
	for _, c := range s {
		if c >= '0' && c <= '9' {
			return true
		}
		break
	}
	return false
}

// TestMorseAutoDetectSidetone verifies that auto-detection locks onto
// a non-default frequency, using the full Runner chain.
func TestMorseAutoDetectSidetone(t *testing.T) {
	sampleRate := 12000
	toneFreq := 550.0
	ditMs := 60.0

	segs := ditDahSegments("... --- ...", ditMs)
	pcm := generateCWTone(sampleRate, toneFreq, segs)

	for len(pcm) < autoDetectSamples*2+sampleRate*2 {
		pcm = append(pcm, generateCWTone(sampleRate, toneFreq, segs)...)
	}

	cfg := Config{
		Type:    "morse",
		Enabled: true,
	}
	audioCh := make(chan []byte, 64)

	var mu sync.Mutex
	var detectedHz int

	runner := NewRunner(cfg, sampleRate, audioCh, func(o Output) {
		mu.Lock()
		defer mu.Unlock()
		if o.SidetoneHz > 0 {
			detectedHz = o.SidetoneHz
		}
	})

	chunkBytes := 1024
	for i := 0; i < len(pcm); i += chunkBytes {
		end := i + chunkBytes
		if end > len(pcm) {
			end = len(pcm)
		}
		chunk := make([]byte, end-i)
		copy(chunk, pcm[i:end])
		audioCh <- chunk
	}

	time.Sleep(100 * time.Millisecond)
	runner.Stop()

	mu.Lock()
	hz := detectedHz
	mu.Unlock()

	if hz == 0 {
		t.Fatal("auto-detect did not emit a sidetone_hz event")
	}

	if math.Abs(float64(hz)-toneFreq) > float64(autoDetectStepHz) {
		t.Errorf("detected %d Hz, expected ~%d Hz (within %d Hz step)",
			hz, int(toneFreq), autoDetectStepHz)
	}

	t.Logf("Auto-detected sidetone: %d Hz (target: %.0f Hz)", hz, toneFreq)
}
