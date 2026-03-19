import { create } from "zustand";

interface ScrollBackState {
  isInScrollBack: boolean;
  set: (v: boolean) => void;
}

export const useScrollBackStore = create<ScrollBackState>((set) => ({
  isInScrollBack: false,
  set: (isInScrollBack) => set({ isInScrollBack }),
}));
