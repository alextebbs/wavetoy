/**
 * Parsers for ChunkRing binary/text formats.
 * Used by the chunk loader to parse data fetched from rewind endpoints.
 */

export interface WFChunkFrame {
  timestampMs: number;
  xBin: number;
  zoom: number;
  bins: Uint8Array;
  freqKHz: number;
  passbandLo: number;
  passbandHi: number;
}

export interface ChunkEvent {
  t: number;
  type: string;
  data?: unknown;
}

/**
 * Parse the binary waterfall chunk format.
 *
 * Per-frame layout:
 *   [timestamp_ms   uint64 LE]   8 bytes
 *   [xbin           uint32 LE]   4 bytes
 *   [zoom           uint16 LE]   2 bytes
 *   [num_bins       uint16 LE]   2 bytes
 *   [freq_khz       float32 LE]  4 bytes
 *   [passband_lo    int16 LE]    2 bytes
 *   [passband_hi    int16 LE]    2 bytes
 *   [bins           uint8[]]     num_bins bytes
 */
const WF_FRAME_HEADER = 24;
export function parseWFChunk(buffer: ArrayBuffer): WFChunkFrame[] {
  const view = new DataView(buffer);
  const frames: WFChunkFrame[] = [];
  let offset = 0;
  while (offset + WF_FRAME_HEADER <= buffer.byteLength) {
    const timestampMs = Number(view.getBigUint64(offset, true));
    const xBin = view.getUint32(offset + 8, true);
    const zoom = view.getUint16(offset + 12, true);
    const numBins = view.getUint16(offset + 14, true);
    const freqKHz = view.getFloat32(offset + 16, true);
    const passbandLo = view.getInt16(offset + 20, true);
    const passbandHi = view.getInt16(offset + 22, true);
    if (offset + WF_FRAME_HEADER + numBins > buffer.byteLength) break;
    const bins = new Uint8Array(buffer, offset + WF_FRAME_HEADER, numBins);
    frames.push({
      timestampMs,
      xBin,
      zoom,
      bins: new Uint8Array(bins),
      freqKHz,
      passbandLo,
      passbandHi,
    });
    offset += WF_FRAME_HEADER + numBins;
  }
  return frames;
}

/**
 * Parse a WAV file and return the raw PCM data (skipping the 44-byte header).
 * Returns { pcm, sampleRate }.
 */
export function parseWAVChunk(buffer: ArrayBuffer): {
  pcm: ArrayBuffer;
  sampleRate: number;
} {
  if (buffer.byteLength < 44) {
    return { pcm: new ArrayBuffer(0), sampleRate: 12000 };
  }
  const view = new DataView(buffer);
  const sampleRate = view.getUint32(24, true);
  const pcm = buffer.slice(44);
  return { pcm, sampleRate };
}

/**
 * Parse JSONL (newline-delimited JSON) event data.
 */
export function parseEventsChunk(text: string): ChunkEvent[] {
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as ChunkEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is ChunkEvent => e !== null);
}
