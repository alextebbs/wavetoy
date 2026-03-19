import { create } from "zustand";

interface ScrollBackState {
  isInScrollBack: boolean;
  streamLocked: boolean;
  set: (v: boolean) => void;
  setStreamLocked: (v: boolean) => void;
}

export const useScrollBackStore = create<ScrollBackState>((set) => ({
  isInScrollBack: false,
  streamLocked: false,
  set: (isInScrollBack) => set({ isInScrollBack }),
  setStreamLocked: (streamLocked) => set({ streamLocked }),
}));
