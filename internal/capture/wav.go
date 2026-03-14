package capture

import (
	"encoding/binary"
	"io"

	"github.com/sammy/sdr-radio/internal/ringbuf"
)

// WriteWAV writes a PCM16 mono WAV file from a ring buffer snapshot.
func WriteWAV(w io.Writer, snap *ringbuf.Snapshot) error {
	var totalSamples int
	for _, entry := range snap.Audio {
		totalSamples += len(entry.PCM) / 2 // 16-bit samples = 2 bytes each
	}

	sampleRate := snap.SampleRate
	if sampleRate <= 0 {
		sampleRate = 12000
	}
	channels := uint16(1)
	bitsPerSample := uint16(16)
	blockAlign := channels * bitsPerSample / 8
	byteRate := uint32(sampleRate) * uint32(blockAlign)
	dataSize := uint32(totalSamples) * uint32(blockAlign)
	fileSize := 36 + dataSize

	hdr := make([]byte, 44)
	copy(hdr[0:4], "RIFF")
	binary.LittleEndian.PutUint32(hdr[4:8], fileSize)
	copy(hdr[8:12], "WAVE")
	copy(hdr[12:16], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:20], 16) // PCM fmt chunk size
	binary.LittleEndian.PutUint16(hdr[20:22], 1)  // PCM format
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

	for _, entry := range snap.Audio {
		if _, err := w.Write(entry.PCM); err != nil {
			return err
		}
	}
	return nil
}
