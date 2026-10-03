const DEFAULT_BANDWIDTH_KHZ = 30_000;
const ALT_BANDWIDTH_KHZ = 32_000;
const WF_BINS = 1024;
const MAX_ZOOM = 14;
const TOTAL_BINS = WF_BINS * (1 << MAX_ZOOM); // 16,777,216 master-grid bins

const REF_MARGIN_LO_KHZ = 2;
const REF_MARGIN_HI_KHZ = 5;

/**
 * Convert a frequency in kHz to a local bin index within the displayed frame.
 * The KiwiSDR uses a master grid of TOTAL_BINS across the full bandwidth.
 * xBin indexes into that master grid, and each displayed bin covers
 * `binScale = 2^(MAX_ZOOM - zoom)` master bins.
 */
function freqKHzToBin(
  freqKHz: number,
  xBin: number,
  zoom: number,
  numBins: number,
  bwKHz: number,
): number {
  const binScale = 1 << (MAX_ZOOM - zoom);
  const masterIdx = (freqKHz / bwKHz) * TOTAL_BINS;
  let idx = Math.round((masterIdx - xBin) / binScale);
  if (idx < 0) idx = 0;
  if (idx >= numBins) idx = numBins - 1;
  return idx;
}

function detectBandwidth(
  xBin: number,
  numBins: number,
  zoom: number,
  passLoKHz: number,
  passHiKHz: number,
): number {
  const binScale = 1 << (MAX_ZOOM - zoom);
  const frameLo30 = (xBin / TOTAL_BINS) * DEFAULT_BANDWIDTH_KHZ;
  const frameHi30 = ((xBin + numBins * binScale) / TOTAL_BINS) * DEFAULT_BANDWIDTH_KHZ;
  if (passLoKHz < frameHi30 && passHiKHz > frameLo30) return DEFAULT_BANDWIDTH_KHZ;

  const frameLo32 = (xBin / TOTAL_BINS) * ALT_BANDWIDTH_KHZ;
  const frameHi32 = ((xBin + numBins * binScale) / TOTAL_BINS) * ALT_BANDWIDTH_KHZ;
  if (passLoKHz < frameHi32 && passHiKHz > frameLo32) return ALT_BANDWIDTH_KHZ;

  return DEFAULT_BANDWIDTH_KHZ;
}

export interface SNRResult {
  snrDB: number;
  signalPowerDB: number;
  noiseFloorDB: number;
  binsUsed: number;
}

interface WFFrame {
  bins: Uint8Array;
  xBin: number;
  zoom: number;
}

function computeSNRFromBins(
  bins: Uint8Array | Float64Array,
  xBin: number,
  zoom: number,
  centerKHz: number,
  passbandLoHz: number,
  passbandHiHz: number,
): SNRResult | null {
  const numBins = bins.length;
  if (numBins === 0) return null;

  const passLoKHz = centerKHz + passbandLoHz / 1000;
  const passHiKHz = centerKHz + passbandHiHz / 1000;

  const bw = detectBandwidth(xBin, numBins, zoom, passLoKHz, passHiKHz);

  const binScale = 1 << (MAX_ZOOM - zoom);
  const frameLoKHz = (xBin / TOTAL_BINS) * bw;
  const frameHiKHz = ((xBin + numBins * binScale) / TOTAL_BINS) * bw;
  if (passHiKHz < frameLoKHz || passLoKHz > frameHiKHz) return null;

  let loIdx = freqKHzToBin(passLoKHz, xBin, zoom, numBins, bw);
  let hiIdx = freqKHzToBin(passHiKHz, xBin, zoom, numBins, bw);
  if (loIdx > hiIdx) [loIdx, hiIdx] = [hiIdx, loIdx];

  let inBandSum = 0;
  let inBandCount = 0;
  for (let i = loIdx; i <= hiIdx && i < numBins; i++) {
    inBandSum += bins[i];
    inBandCount++;
  }
  if (inBandCount === 0) return null;

  const refLoStart = freqKHzToBin(passLoKHz - REF_MARGIN_HI_KHZ, xBin, zoom, numBins, bw);
  const refLoEnd = freqKHzToBin(passLoKHz - REF_MARGIN_LO_KHZ, xBin, zoom, numBins, bw);
  const refHiStart = freqKHzToBin(passHiKHz + REF_MARGIN_LO_KHZ, xBin, zoom, numBins, bw);
  const refHiEnd = freqKHzToBin(passHiKHz + REF_MARGIN_HI_KHZ, xBin, zoom, numBins, bw);

  let outBandSum = 0;
  let outBandCount = 0;
  for (let i = refLoStart; i <= refLoEnd && i < numBins; i++) {
    if (i >= 0) {
      outBandSum += bins[i];
      outBandCount++;
    }
  }
  for (let i = refHiStart; i <= refHiEnd && i < numBins; i++) {
    if (i >= 0) {
      outBandSum += bins[i];
      outBandCount++;
    }
  }

  const signalPowerDB = inBandSum / inBandCount;
  const noiseFloorDB = outBandCount > 0 ? outBandSum / outBandCount : signalPowerDB;
  const snrDB = signalPowerDB - noiseFloorDB;

  return { snrDB, signalPowerDB, noiseFloorDB, binsUsed: inBandCount };
}

/**
 * Compute in-band SNR from a single waterfall frame.
 * Returns null if the passband isn't covered by the frame.
 */
export function computeSNR(
  bins: Uint8Array,
  xBin: number,
  zoom: number,
  centerKHz: number,
  passbandLoHz: number,
  passbandHiHz: number,
): SNRResult | null {
  return computeSNRFromBins(bins, xBin, zoom, centerKHz, passbandLoHz, passbandHiHz);
}

/**
 * Buffers raw WF frames and computes time-averaged SNR,
 * matching the backend's FromWFFrames approach.
 */
export class SNRFrameBuffer {
  private frames: WFFrame[];
  private capacity: number;
  private idx = 0;
  private filled = 0;

  constructor(capacity = 20) {
    this.capacity = capacity;
    this.frames = new Array(capacity);
  }

  push(bins: Uint8Array, xBin: number, zoom: number): void {
    this.frames[this.idx % this.capacity] = { bins: new Uint8Array(bins), xBin, zoom };
    this.idx++;
    if (this.filled < this.capacity) this.filled++;
  }

  compute(centerKHz: number, passbandLoHz: number, passbandHiHz: number): SNRResult | null {
    if (this.filled === 0) return null;
    return averageAndCompute(this.getFrames(), centerKHz, passbandLoHz, passbandHiHz);
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
  }

  private getFrames(): WFFrame[] {
    const out: WFFrame[] = [];
    const start = this.filled < this.capacity ? 0 : this.idx % this.capacity;
    for (let i = 0; i < this.filled; i++) {
      out.push(this.frames[(start + i) % this.capacity]);
    }
    return out;
  }
}

/**
 * Compute SNR from an array of frames (e.g. a window around the playback head).
 * Averages bins across frames before computing, matching the backend.
 */
export function computeSNRFromFrames(
  frames: Array<{ bins: Uint8Array; xBin: number; zoom: number }>,
  centerKHz: number,
  passbandLoHz: number,
  passbandHiHz: number,
): SNRResult | null {
  if (frames.length === 0) return null;
  if (frames.length === 1) {
    return computeSNR(frames[0].bins, frames[0].xBin, frames[0].zoom, centerKHz, passbandLoHz, passbandHiHz);
  }
  return averageAndCompute(frames, centerKHz, passbandLoHz, passbandHiHz);
}

function averageAndCompute(
  frames: Array<{ bins: Uint8Array; xBin: number; zoom: number }>,
  centerKHz: number,
  passbandLoHz: number,
  passbandHiHz: number,
): SNRResult | null {
  const first = frames[0];
  const numBins = first.bins.length;
  if (numBins === 0) return null;

  const avgBins = new Float64Array(numBins);
  let count = 0;
  for (const f of frames) {
    if (f.bins.length !== numBins) continue;
    for (let i = 0; i < numBins; i++) {
      avgBins[i] += f.bins[i];
    }
    count++;
  }
  if (count === 0) return null;

  for (let i = 0; i < numBins; i++) {
    avgBins[i] /= count;
  }

  return computeSNRFromBins(avgBins, first.xBin, first.zoom, centerKHz, passbandLoHz, passbandHiHz);
}
