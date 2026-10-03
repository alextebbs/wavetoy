export type { ColorMapFn, ColorMapName } from "@/lib/display-colors";
export type { WaterfallMarker } from "@/lib/chunk-manager";

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
  loadInitialChunks(): Promise<void>;
  drainStaleQueue(): void;
  visibleRows(): number;
  cssToRows(px: number): number;
  requestRepaint(): void;
}

export const WF_BINS = 1024;
export const MAX_FREQ_DEFAULT = 30000; // kHz
