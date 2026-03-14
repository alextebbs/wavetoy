export interface WaterfallFrame {
  bins: Uint8Array;
  xBin: number;
  zoom: number;
  flags: number;
}

export type ColorMapFn = (t: number) => [number, number, number];

export type ColorMapName = "turbo" | "viridis" | "grayscale" | "kiwi";

export interface WaterfallOptions {
  colorMap?: ColorMapName;
  minLevel?: number;
  maxLevel?: number;
}

export interface WaterfallHandle {
  pushBins(bins: Uint8Array): void;
  setColorMap(name: ColorMapName): void;
  setLevels(min: number, max: number): void;
  setDataCoverage(startKHz: number, endKHz: number): void;
}

export const WF_BINS = 1024;
export const MAX_FREQ_DEFAULT = 30000; // kHz
