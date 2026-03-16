//go:build whisper

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/sammy/sdr-radio/internal/whisper"
)

func main() {
	wavPath := "data/test-chinese-10min.wav"
	modelPath := "data/whisper-models/ggml-small.bin"
	outPath := "data/whisper-bench-results.txt"

	fmt.Println("Loading model...")
	ctx, err := whisper.LoadModel(modelPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load model: %v\n", err)
		os.Exit(1)
	}
	defer ctx.Close()
	fmt.Println("Model loaded.")

	samples12k, err := readWavPCM16(wavPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to read wav: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Loaded %d samples (%.1fs at 12kHz)\n", len(samples12k), float64(len(samples12k))/12000.0)

	chunkSize := 12000 * 30 // 30s at 12kHz
	var chunks [][]float32
	for i := 0; i < len(samples12k); i += chunkSize {
		end := i + chunkSize
		if end > len(samples12k) {
			end = len(samples12k)
		}
		chunk := samples12k[i:end]
		if len(chunk) < chunkSize/2 {
			break // skip very short trailing chunk
		}
		resampled := resample12to16(chunk)
		chunks = append(chunks, resampled)
	}
	fmt.Printf("Split into %d chunks of 30s\n\n", len(chunks))

	threads := max(1, runtime.NumCPU()/2)
	var out strings.Builder

	// Run auto-detect
	out.WriteString("=== AUTO-DETECT (language=\"\") ===\n\n")
	fmt.Println("=== AUTO-DETECT ===")
	for i, chunk := range chunks {
		t0 := time.Now()
		segments, lang, err := ctx.Infer(chunk, whisper.InferenceParams{
			Task:    "translate",
			Threads: threads,
		})
		elapsed := time.Since(t0)
		if err != nil {
			line := fmt.Sprintf("Chunk %d: ERROR %v\n", i+1, err)
			out.WriteString(line)
			fmt.Print(line)
			continue
		}

		var parts []string
		for _, seg := range segments {
			text := strings.TrimSpace(seg.Text)
			if text != "" {
				parts = append(parts, text)
			}
		}
		text := strings.Join(parts, " ")
		header := fmt.Sprintf("Chunk %d | detected=%s | %dms | %d segments\n", i+1, lang, elapsed.Milliseconds(), len(segments))
		out.WriteString(header)
		out.WriteString(text + "\n\n")
		fmt.Printf("  %d/%d detected=%s %dms segs=%d\n", i+1, len(chunks), lang, elapsed.Milliseconds(), len(segments))
	}

	// Run with zh
	out.WriteString("\n=== EXPLICIT CHINESE (language=\"zh\") ===\n\n")
	fmt.Println("\n=== EXPLICIT CHINESE (lang=zh) ===")
	for i, chunk := range chunks {
		t0 := time.Now()
		segments, lang, err := ctx.Infer(chunk, whisper.InferenceParams{
			Task:     "translate",
			Language: "zh",
			Threads:  threads,
		})
		elapsed := time.Since(t0)
		if err != nil {
			line := fmt.Sprintf("Chunk %d: ERROR %v\n", i+1, err)
			out.WriteString(line)
			fmt.Print(line)
			continue
		}

		var parts []string
		for _, seg := range segments {
			text := strings.TrimSpace(seg.Text)
			if text != "" {
				parts = append(parts, text)
			}
		}
		text := strings.Join(parts, " ")
		header := fmt.Sprintf("Chunk %d | detected=%s | %dms | %d segments\n", i+1, lang, elapsed.Milliseconds(), len(segments))
		out.WriteString(header)
		out.WriteString(text + "\n\n")
		fmt.Printf("  %d/%d detected=%s %dms segs=%d\n", i+1, len(chunks), lang, elapsed.Milliseconds(), len(segments))
	}

	if err := os.WriteFile(outPath, []byte(out.String()), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write results: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\nResults written to %s\n", outPath)
}

func readWavPCM16(path string) ([]int16, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Skip 44-byte WAV header
	if _, err := f.Seek(44, io.SeekStart); err != nil {
		return nil, err
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}

	samples := make([]int16, len(data)/2)
	for i := range samples {
		samples[i] = int16(binary.LittleEndian.Uint16(data[i*2:]))
	}
	return samples, nil
}

func resample12to16(in []int16) []float32 {
	if len(in) == 0 {
		return nil
	}
	ratio := 16000.0 / 12000.0
	outLen := int(float64(len(in)) * ratio)
	out := make([]float32, outLen)
	for i := range out {
		srcPos := float64(i) / ratio
		idx := int(srcPos)
		frac := float32(srcPos - float64(idx))
		if idx+1 < len(in) {
			out[i] = float32(in[idx])*(1-frac) + float32(in[idx+1])*frac
		} else if idx < len(in) {
			out[i] = float32(in[idx])
		}
	}
	const scale = 1.0 / 32768.0
	for i := range out {
		out[i] *= scale
	}
	return out
}
