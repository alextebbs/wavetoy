export type { ColorMapFn, ColorMapName } from "@/lib/display-colors";

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
}

export const WF_BINS = 1024;
export const MAX_FREQ_DEFAULT = 30000; // kHz
