package chunkring

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
)

// SerializeAudioWAV writes a PCM16 mono WAV file from a chunk's audio data.
func SerializeAudioWAV(w io.Writer, chunk *Chunk) error {
	sampleRate := chunk.SampleRate
	if sampleRate <= 0 {
		sampleRate = 12000
	}
	pcm := chunk.AudioPCM
	// Round down to nearest sample boundary (2 bytes per sample).
	pcm = pcm[:len(pcm)&^1]

	channels := uint16(1)
	bitsPerSample := uint16(16)
	blockAlign := channels * bitsPerSample / 8
	byteRate := uint32(sampleRate) * uint32(blockAlign)
	dataSize := uint32(len(pcm))
	fileSize := 36 + dataSize

	hdr := make([]byte, 44)
	copy(hdr[0:4], "RIFF")
	binary.LittleEndian.PutUint32(hdr[4:8], fileSize)
	copy(hdr[8:12], "WAVE")
	copy(hdr[12:16], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:20], 16)
	binary.LittleEndian.PutUint16(hdr[20:22], 1)
	binary.LittleEndian.PutUint16(hdr[22:24], channels)
	binary.LittleEndian.PutUint32(hdr[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(hdr[28:32], byteRate)
	binary.LittleEndian.PutUint16(hdr[32:34], blockAlign)
	binary.LittleEndian.PutUint16(hdr[34:36], bitsPerSample)
	copy(hdr[36:40], "data")
	binary.LittleEndian.PutUint32(hdr[40:44], dataSize)

	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if len(pcm) > 0 {
		if _, err := w.Write(pcm); err != nil {
			return err
		}
	}
	return nil
}

// SerializeAudioWAVFromPCM writes a WAV file from raw PCM data and sample rate.
// Used by the capture endpoint which gets concatenated PCM from SnapshotAudio.
func SerializeAudioWAVFromPCM(w io.Writer, pcm []byte, sampleRate int) error {
	return SerializeAudioWAV(w, &Chunk{AudioPCM: pcm, SampleRate: sampleRate})
}

// SerializeWF writes waterfall frames in the binary chunk format.
//
// Per-frame layout:
//
//	[timestamp_ms   uint64 LE]   8 bytes
//	[xbin           uint32 LE]   4 bytes
//	[zoom           uint16 LE]   2 bytes
//	[num_bins       uint16 LE]   2 bytes
//	[freq_khz       float32 LE]  4 bytes
//	[passband_lo    int16 LE]    2 bytes
//	[passband_hi    int16 LE]    2 bytes
//	[bins           uint8[]]     num_bins bytes
func SerializeWF(w io.Writer, chunk *Chunk) error {
	hdr := make([]byte, 24)
	for _, f := range chunk.WFFrames {
		binary.LittleEndian.PutUint64(hdr[0:8], uint64(f.TimestampMs))
		binary.LittleEndian.PutUint32(hdr[8:12], f.XBin)
		binary.LittleEndian.PutUint16(hdr[12:14], f.Zoom)
		binary.LittleEndian.PutUint16(hdr[14:16], uint16(len(f.Bins)))
		binary.LittleEndian.PutUint32(hdr[16:20], math.Float32bits(f.FreqKHz))
		binary.LittleEndian.PutUint16(hdr[20:22], uint16(f.PassbandLo))
		binary.LittleEndian.PutUint16(hdr[22:24], uint16(f.PassbandHi))
		if _, err := w.Write(hdr); err != nil {
			return err
		}
		if _, err := w.Write(f.Bins); err != nil {
			return err
		}
	}
	return nil
}

// SerializeEvents writes events as newline-delimited JSON.
func SerializeEvents(w io.Writer, chunk *Chunk) error {
	for _, ev := range chunk.Events {
		obj := map[string]any{
			"t":    ev.TimestampMs,
			"type": ev.Type,
		}
		if ev.Data != nil {
			var parsed any
			if json.Unmarshal(ev.Data, &parsed) == nil {
				obj["data"] = parsed
			} else {
				obj["data"] = string(ev.Data)
			}
		}
		line, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		if _, err := w.Write(line); err != nil {
			return err
		}
		if _, err := w.Write([]byte{'\n'}); err != nil {
			return err
		}
	}
	return nil
}
