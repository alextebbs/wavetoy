import { create } from "zustand";
import type { ColorMapName } from "./display-colors";

// ─── Theme shape ─────────────────────────────────────────────────────────────

interface UIColors {
  background: string; // HSL triplet, e.g. "216 47% 4%"
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

interface DisplayColors {
  defaultColorMap: ColorMapName;
  waterfallBg: string;
  spectrumBg: string;
  spectrumFillOpacity: number;
  spectrumGradientStops: [number, string][];
  spectrumGridLine: string;
  spectrumGridLabel: string;
  spectrumPeakTrace: string;
  spectrumPassbandFill: string;
  freqScaleBg: string;
  freqScaleTickMajor: string;
  freqScaleTickMinor: string;
  freqScaleLabel: string;
  freqScaleUnitLabel: string;
}

interface MapColors {
  background: string;
  countryLines: string;
  countryLineOpacity: number;
  markerColor: string;
  markerGlow: string;
  selectedRing: string;
  crosshair: string;
  snrFallback: string;
  snrHueRange: [number, number];
  snrSaturation: number;
  snrLightness: number;
}

interface TuningColors {
  passbandFill: string;
  passbandBorder: string;
  centerLine: string;
}

export interface SDRTheme {
  name: string;
  label: string;
  ui: UIColors;
  display: DisplayColors;
  map: MapColors;
  tuning: TuningColors;
  statusWarning: string;
}

// ─── Built-in themes ─────────────────────────────────────────────────────────

const phosphor: SDRTheme = {
  name: "phosphor",
  label: "Phosphor",
  ui: {
    background: "216 47% 4%",
    foreground: "166 25% 85%",
    card: "216 40% 7%",
    cardForeground: "166 25% 85%",
    popover: "216 40% 7%",
    popoverForeground: "166 25% 85%",
    primary: "168 52% 48%",
    primaryForeground: "216 47% 4%",
    secondary: "170 30% 13%",
    secondaryForeground: "166 25% 85%",
    muted: "170 25% 13%",
    mutedForeground: "168 18% 50%",
    accent: "170 30% 13%",
    accentForeground: "166 25% 85%",
    destructive: "0 55% 42%",
    destructiveForeground: "0 0% 95%",
    border: "170 30% 15%",
    input: "170 30% 15%",
    ring: "168 52% 48%",
  },
  display: {
    defaultColorMap: "phosphor",
    waterfallBg: "#020408",
    spectrumBg: "#060a12",
    spectrumFillOpacity: 0.8,
    spectrumGradientStops: [
      [0, "#fffce0"],
      [0.15, "#c8f040"],
      [0.35, "#40e850"],
      [0.55, "#14b880"],
      [0.75, "#0a6e6e"],
      [1, "#041820"],
    ],
    spectrumGridLine: "rgba(60, 185, 160, 0.1)",
    spectrumGridLabel: "rgba(60, 185, 160, 0.45)",
    spectrumPeakTrace: "#c8f040",
    spectrumPassbandFill: "rgba(251, 170, 199, 0.12)",
    freqScaleBg: "#060a12",
    freqScaleTickMajor: "#3cb8a0",
    freqScaleTickMinor: "#1a4a42",
    freqScaleLabel: "#3cb8a0",
    freqScaleUnitLabel: "#1a4a42",
  },
  map: {
    background: "#060a12",
    countryLines: "#1a4a42",
    countryLineOpacity: 0.8,
    markerColor: "#3cb8a0",
    markerGlow: "rgba(60,184,160,0.6)",
    selectedRing: "#5eead4",
    crosshair: "rgba(94,234,212,0.8)",
    snrFallback: "#3cb8a0",
    snrHueRange: [140, 180],
    snrSaturation: 70,
    snrLightness: 55,
  },
  tuning: {
    passbandFill: "rgba(251,170,199,0.10)",
    passbandBorder: "rgba(251,170,199,0.35)",
    centerLine: "rgba(252,185,210,0.75)",
  },
  statusWarning: "#2dd4bf",
};

const classic: SDRTheme = {
  name: "classic",
  label: "Classic",
  ui: {
    background: "0 0% 0%",
    foreground: "210 40% 98%",
    card: "222 84% 5%",
    cardForeground: "210 40% 98%",
    popover: "222 84% 5%",
    popoverForeground: "210 40% 98%",
    primary: "210 40% 98%",
    primaryForeground: "222 47% 11%",
    secondary: "217 33% 18%",
    secondaryForeground: "210 40% 98%",
    muted: "217 33% 18%",
    mutedForeground: "215 20% 65%",
    accent: "217 33% 18%",
    accentForeground: "210 40% 98%",
    destructive: "0 63% 31%",
    destructiveForeground: "210 40% 98%",
    border: "217 33% 18%",
    input: "217 33% 18%",
    ring: "213 27% 84%",
  },
  display: {
    defaultColorMap: "turbo",
    waterfallBg: "#000000",
    spectrumBg: "#09090b",
    spectrumFillOpacity: 0.75,
    spectrumGradientStops: [
      [0, "#ef4444"],
      [0.25, "#f59e0b"],
      [0.45, "#22c55e"],
      [0.7, "#06b6d4"],
      [1, "#1e3a5f"],
    ],
    spectrumGridLine: "rgba(255,255,255,0.08)",
    spectrumGridLabel: "rgba(255,255,255,0.35)",
    spectrumPeakTrace: "#facc15",
    spectrumPassbandFill: "rgba(255,255,255,0.1)",
    freqScaleBg: "#09090b",
    freqScaleTickMajor: "#a1a1aa",
    freqScaleTickMinor: "#52525b",
    freqScaleLabel: "#a1a1aa",
    freqScaleUnitLabel: "#52525b",
  },
  map: {
    background: "#09090b",
    countryLines: "#555555",
    countryLineOpacity: 0.6,
    markerColor: "#fbbf24",
    markerGlow: "rgba(251,191,36,0.6)",
    selectedRing: "#fde68a",
    crosshair: "rgba(253,230,138,0.9)",
    snrFallback: "#facc15",
    snrHueRange: [8, 120],
    snrSaturation: 95,
    snrLightness: 55,
  },
  tuning: {
    passbandFill: "rgba(255,255,255,0.07)",
    passbandBorder: "rgba(255,255,255,0.20)",
    centerLine: "rgba(251,191,36,0.50)",
  },
  statusWarning: "#f59e0b",
};

export const THEMES: Record<string, SDRTheme> = { phosphor, classic };

// ─── Store ───────────────────────────────────────────────────────────────────

interface ThemeStore {
  theme: SDRTheme;
  setTheme: (name: string) => void;
}

function applyCSSVariables(ui: UIColors) {
  const root = document.documentElement;
  root.style.setProperty("--background", ui.background);
  root.style.setProperty("--foreground", ui.foreground);
  root.style.setProperty("--card", ui.card);
  root.style.setProperty("--card-foreground", ui.cardForeground);
  root.style.setProperty("--popover", ui.popover);
  root.style.setProperty("--popover-foreground", ui.popoverForeground);
  root.style.setProperty("--primary", ui.primary);
  root.style.setProperty("--primary-foreground", ui.primaryForeground);
  root.style.setProperty("--secondary", ui.secondary);
  root.style.setProperty("--secondary-foreground", ui.secondaryForeground);
  root.style.setProperty("--muted", ui.muted);
  root.style.setProperty("--muted-foreground", ui.mutedForeground);
  root.style.setProperty("--accent", ui.accent);
  root.style.setProperty("--accent-foreground", ui.accentForeground);
  root.style.setProperty("--destructive", ui.destructive);
  root.style.setProperty("--destructive-foreground", ui.destructiveForeground);
  root.style.setProperty("--border", ui.border);
  root.style.setProperty("--input", ui.input);
  root.style.setProperty("--ring", ui.ring);
}

const DEFAULT_THEME = "phosphor";

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: THEMES[DEFAULT_THEME],
  setTheme: (name: string) => {
    const next = THEMES[name];
    if (!next) return;
    applyCSSVariables(next.ui);
    set({ theme: next });
  },
}));

export function initTheme() {
  const theme = useThemeStore.getState().theme;
  document.documentElement.classList.add("dark");
  applyCSSVariables(theme.ui);
}
