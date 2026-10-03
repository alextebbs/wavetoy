import { create } from "zustand";

interface ScrollBackState {
  isInScrollBack: boolean;
  streamLocked: boolean;
  monitorMode: boolean;
  set: (v: boolean) => void;
  setStreamLocked: (v: boolean) => void;
  setMonitorMode: (v: boolean) => void;
}

export const useScrollBackStore = create<ScrollBackState>((set) => ({
  isInScrollBack: false,
  streamLocked: false,
  monitorMode: false,
  set: (isInScrollBack) => set({ isInScrollBack }),
  setStreamLocked: (streamLocked) => set({ streamLocked }),
  setMonitorMode: (monitorMode) => set({ monitorMode }),
}));
