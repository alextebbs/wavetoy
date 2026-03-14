import { create } from "zustand";

export type ViewSource = "local" | "remote";

export interface BandViewState {
  startKHz: number;
  endKHz: number;
  maxBandwidthKHz: number;
  viewSource: ViewSource;
  initialized: boolean;

  setView: (start: number, end: number) => void;
  setViewRemote: (start: number, end: number) => void;
  setMaxBandwidth: (maxKHz: number) => void;
  zoomAtNorm: (normX: number, factor: number) => void;
  panByNorm: (deltaNorm: number) => void;
  resetView: () => void;
}

const MIN_SPAN_KHZ = 50;
const REMOTE_LERP_DURATION_MS = 200;

function clampView(
  start: number,
  end: number,
  maxBw: number
): [number, number] {
  let s = start;
  let e = end;
  const span = e - s;
  if (span < MIN_SPAN_KHZ) {
    const mid = (s + e) / 2;
    s = mid - MIN_SPAN_KHZ / 2;
    e = mid + MIN_SPAN_KHZ / 2;
  }
  if (s < 0) {
    e += -s;
    s = 0;
  }
  if (e > maxBw) {
    s -= e - maxBw;
    e = maxBw;
  }
  s = Math.max(0, s);
  e = Math.min(maxBw, e);
  return [s, e];
}

let remoteAnimFrame: number | null = null;

export const useBandViewStore = create<BandViewState>((set, get) => ({
  startKHz: 0,
  endKHz: 30000,
  maxBandwidthKHz: 30000,
  viewSource: "local" as ViewSource,
  initialized: false,

  setView: (start, end) => {
    const { maxBandwidthKHz } = get();
    const [s, e] = clampView(start, end, maxBandwidthKHz);
    set({ startKHz: s, endKHz: e, viewSource: "local", initialized: true });
  },

  setViewRemote: (targetStart, targetEnd) => {
    if (remoteAnimFrame !== null) {
      cancelAnimationFrame(remoteAnimFrame);
      remoteAnimFrame = null;
    }

    const { maxBandwidthKHz } = get();
    const [ts, te] = clampView(targetStart, targetEnd, maxBandwidthKHz);

    const fromStart = get().startKHz;
    const fromEnd = get().endKHz;
    const t0 = performance.now();

    const step = (now: number) => {
      const elapsed = now - t0;
      const t = Math.min(1, elapsed / REMOTE_LERP_DURATION_MS);
      // Ease-out cubic for natural deceleration
      const ease = 1 - Math.pow(1 - t, 3);

      const s = fromStart + (ts - fromStart) * ease;
      const e = fromEnd + (te - fromEnd) * ease;
      set({ startKHz: s, endKHz: e, viewSource: "remote" });

      if (t < 1) {
        remoteAnimFrame = requestAnimationFrame(step);
      } else {
        remoteAnimFrame = null;
      }
    };

    remoteAnimFrame = requestAnimationFrame(step);
  },

  setMaxBandwidth: (maxKHz) => {
    const { startKHz, endKHz } = get();
    const [s, e] = clampView(startKHz, endKHz, maxKHz);
    set({ maxBandwidthKHz: maxKHz, startKHz: s, endKHz: e });
  },

  zoomAtNorm: (normX, factor) => {
    const { startKHz, endKHz, maxBandwidthKHz } = get();
    const span = endKHz - startKHz;
    // Already at min zoom and trying to zoom in — do nothing
    if (span <= MIN_SPAN_KHZ && factor < 1) return;
    // Already at max zoom out and trying to zoom out — do nothing
    if (span >= maxBandwidthKHz && factor > 1) return;
    const cursorKHz = startKHz + normX * span;
    const newSpan = span * factor;
    const newStart = cursorKHz - normX * newSpan;
    const newEnd = newStart + newSpan;
    const [s, e] = clampView(newStart, newEnd, maxBandwidthKHz);
    set({ startKHz: s, endKHz: e, viewSource: "local" });
  },

  panByNorm: (deltaNorm) => {
    const { startKHz, endKHz, maxBandwidthKHz } = get();
    const span = endKHz - startKHz;
    const deltaKHz = deltaNorm * span;
    const [s, e] = clampView(startKHz + deltaKHz, endKHz + deltaKHz, maxBandwidthKHz);
    set({ startKHz: s, endKHz: e, viewSource: "local" });
  },

  resetView: () => {
    const { maxBandwidthKHz } = get();
    set({ startKHz: 0, endKHz: maxBandwidthKHz, viewSource: "local" });
  },
}));
