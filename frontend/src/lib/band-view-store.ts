// Conflict resolution & view source tagging: see planning/CONFLICTS.md
import { create } from "zustand";

export type ViewSource = "local" | "remote";

export interface BandViewState {
  startKHz: number;
  endKHz: number;
  maxBandwidthKHz: number;
  viewSource: ViewSource;
  initialized: boolean;
  allowOverflow: boolean;

  setView: (start: number, end: number) => void;
  setViewQuiet: (start: number, end: number) => void;
  setViewRemote: (start: number, end: number) => void;
  setMaxBandwidth: (maxKHz: number) => void;
  setAllowOverflow: (allow: boolean) => void;
  zoomAtNorm: (normX: number, factor: number) => void;
  panByNorm: (deltaNorm: number) => void;
  resetView: () => void;
}

const MIN_SPAN_KHZ = 22;
const REMOTE_LERP_DURATION_MS = 200;

function clampView(
  start: number,
  end: number,
  maxBw: number,
  overflow = false
): [number, number] {
  let s = start;
  let e = end;
  const span = e - s;
  if (span < MIN_SPAN_KHZ) {
    const mid = (s + e) / 2;
    s = mid - MIN_SPAN_KHZ / 2;
    e = mid + MIN_SPAN_KHZ / 2;
  }
  if (overflow) {
    const mid = (s + e) / 2;
    const clampedMid = Math.max(0, Math.min(maxBw, mid));
    const shift = clampedMid - mid;
    s += shift;
    e += shift;
  } else {
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
  }
  return [s, e];
}

let remoteAnimFrame: number | null = null;

export const useBandViewStore = create<BandViewState>((set, get) => ({
  startKHz: 0,
  endKHz: 30000,
  maxBandwidthKHz: 30000,
  viewSource: "local" as ViewSource,
  initialized: false,
  allowOverflow: false,

  setView: (start, end) => {
    const { maxBandwidthKHz, allowOverflow } = get();
    const [s, e] = clampView(start, end, maxBandwidthKHz, allowOverflow);
    set({ startKHz: s, endKHz: e, viewSource: "local", initialized: true });
  },

  setViewQuiet: (start, end) => {
    const { maxBandwidthKHz, allowOverflow } = get();
    const [s, e] = clampView(start, end, maxBandwidthKHz, allowOverflow);
    set({ startKHz: s, endKHz: e, viewSource: "remote", initialized: true });
  },

  setViewRemote: (targetStart, targetEnd) => {
    if (remoteAnimFrame !== null) {
      cancelAnimationFrame(remoteAnimFrame);
      remoteAnimFrame = null;
    }

    const { maxBandwidthKHz, allowOverflow } = get();
    const [ts, te] = clampView(targetStart, targetEnd, maxBandwidthKHz, allowOverflow);

    const fromStart = get().startKHz;
    const fromEnd = get().endKHz;
    const t0 = performance.now();

    const step = (now: number) => {
      const elapsed = now - t0;
      const t = Math.min(1, elapsed / REMOTE_LERP_DURATION_MS);
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
    const { startKHz, endKHz, allowOverflow } = get();
    const [s, e] = clampView(startKHz, endKHz, maxKHz, allowOverflow);
    set({ maxBandwidthKHz: maxKHz, startKHz: s, endKHz: e });
  },

  setAllowOverflow: (allow) => {
    set({ allowOverflow: allow });
    if (!allow) {
      const { startKHz, endKHz, maxBandwidthKHz } = get();
      const [s, e] = clampView(startKHz, endKHz, maxBandwidthKHz, false);
      if (s !== startKHz || e !== endKHz) {
        set({ startKHz: s, endKHz: e });
      }
    }
  },

  zoomAtNorm: (normX, factor) => {
    const { startKHz, endKHz, maxBandwidthKHz, allowOverflow } = get();
    const span = endKHz - startKHz;
    if (span <= MIN_SPAN_KHZ && factor < 1) return;
    if (span >= maxBandwidthKHz && factor > 1) return;
    const cursorKHz = startKHz + normX * span;
    const newSpan = span * factor;
    const newStart = cursorKHz - normX * newSpan;
    const newEnd = newStart + newSpan;
    const [s, e] = clampView(newStart, newEnd, maxBandwidthKHz, allowOverflow);
    set({ startKHz: s, endKHz: e, viewSource: "local" });
  },

  panByNorm: (deltaNorm) => {
    const { startKHz, endKHz, maxBandwidthKHz, allowOverflow } = get();
    const span = endKHz - startKHz;
    const deltaKHz = deltaNorm * span;
    const [s, e] = clampView(startKHz + deltaKHz, endKHz + deltaKHz, maxBandwidthKHz, allowOverflow);
    set({ startKHz: s, endKHz: e, viewSource: "local" });
  },

  resetView: () => {
    const { maxBandwidthKHz } = get();
    set({ startKHz: 0, endKHz: maxBandwidthKHz, viewSource: "local" });
  },
}));
