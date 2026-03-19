import { create } from "zustand";

const MAX_FREQ_KHZ = 30000;

export interface TuningState {
  sourceId: string;
  frequency: number;
  confirmedFrequency: number;
  mode: string;
  lo: number;
  hi: number;
  freqAnimating: boolean;
  lastRemoteAt: number;

  setFrequency: (kHz: number) => void;
  setMode: (mode: string, lo: number, hi: number) => void;
  setLo: (lo: number) => void;
  setHi: (hi: number) => void;
  setSourceId: (id: string) => void;
  applyRemote: (
    sourceId: string,
    frequency: number,
    mode: string,
    lo: number,
    hi: number,
  ) => void;
  isRemoteRecent: () => boolean;
  reset: () => void;
}

let freqAnimTimer: ReturnType<typeof setTimeout> | null = null;

export const useTuningStore = create<TuningState>((set, get) => ({
  sourceId: "",
  frequency: 10000,
  confirmedFrequency: 10000,
  mode: "am",
  lo: -4900,
  hi: 4900,
  freqAnimating: false,
  lastRemoteAt: 0,

  setFrequency: (kHz) => {
    set({ frequency: Math.min(kHz, MAX_FREQ_KHZ) });
  },

  setMode: (mode, lo, hi) => {
    set({ mode, lo, hi });
  },

  setLo: (lo) => set({ lo }),
  setHi: (hi) => set({ hi }),
  setSourceId: (id) => set({ sourceId: id }),

  applyRemote: (sourceId, frequency, mode, lo, hi) => {
    const current = get();
    const hasLocalPending = current.frequency !== current.confirmedFrequency;

    if (hasLocalPending) {
      set({ confirmedFrequency: frequency });
      return;
    }

    if (freqAnimTimer) clearTimeout(freqAnimTimer);
    set({
      sourceId,
      frequency,
      confirmedFrequency: frequency,
      mode,
      lo,
      hi,
      freqAnimating: true,
      lastRemoteAt: performance.now(),
    });
    freqAnimTimer = setTimeout(() => {
      freqAnimTimer = null;
      set({ freqAnimating: false });
    }, 250);
  },

  isRemoteRecent: () => performance.now() - get().lastRemoteAt < 150,

  reset: () => {
    if (freqAnimTimer) {
      clearTimeout(freqAnimTimer);
      freqAnimTimer = null;
    }
    set({
      sourceId: "",
      frequency: 10000,
      confirmedFrequency: 10000,
      mode: "am",
      lo: -4900,
      hi: 4900,
      freqAnimating: false,
      lastRemoteAt: 0,
    });
  },
}));
