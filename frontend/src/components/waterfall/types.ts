export type { ColorMapFn, ColorMapName } from "@/lib/display-colors";
export type { WaterfallMarker } from "./waterfall-overlay";

export interface WaterfallFrame {
  bins: Uint8Array;
  xBin: number;
  zoom: number;
  flags: number;
}

export interface WaterfallOptions {
  minLevel?: number;
  maxLevel?: number;
}

export interface WaterfallHandle {
  pushBins(bins: Uint8Array): void;
  pushFrame(bins: Uint8Array, xBin: number, zoom: number): void;
  setLevels(min: number, max: number): void;
  setMaxBandwidth(maxKHz: number): void;
  setDataCoverage(startKHz: number, endKHz: number): void;
  setCurrentTuning(freqKHz: number, passbandLo: number, passbandHi: number): void;
  setChunkSource(source: import("@/lib/chunk-loader").ChunkSource): void;
  loadManifest(
    chunks: import("@/lib/chunk-loader").ChunkMeta[],
    streamInfo?: { sampleRate: number; chunkDurationS: number },
  ): Promise<number>;
  onChunkComplete(msg: {
    started_at: number;
    ended_at?: number;
    source_id?: string;
    wf_frames?: number;
    audio_bytes?: number;
  }): void;
  resetLiveFrameCount(): void;
  rowCount(): number;
  getScrollOffset(): number;
  chunkManifest(): ReadonlyArray<{
    startedAt: number;
    startRow: number;
    frameCount: number;
    complete: boolean;
    audioBytes: number;
  }>;
  setScrollOffset(offset: number): void;
  scrollToLive(): void;
  setPlaybackHead(row: number | null): void;
  visibleRows(): number;
  cssToRows(px: number): number;
  requestRepaint(): void;
}

export const WF_BINS = 1024;
export const MAX_FREQ_DEFAULT = 30000; // kHz
