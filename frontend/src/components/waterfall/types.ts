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
  insertHistoricalTile(
    startRow: number,
    rawBins: Uint8Array[],
    dataStartKHz: number,
    dataEndKHz: number,
  ): void;
  setHistoryExtent(lowestRow: number): void;
  removeTilesInRange(startRow: number, endRow: number): void;
  addMarker(marker: import("./waterfall-overlay").WaterfallMarker): void;
  removeMarker(id: string): void;
  rowCount(): number;
  setScrollOffset(offset: number): void;
  scrollToLive(): void;
}

export const WF_BINS = 1024;
export const MAX_FREQ_DEFAULT = 30000; // kHz
