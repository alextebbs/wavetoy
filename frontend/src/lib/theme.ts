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
    background: "0 0% 0%",
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
    snrHueRange: [0, 160],
    snrSaturation: 85,
    snrLightness: 55,
  },
  tuning: {
    passbandFill: "rgba(255,80,150,0.12)",
    passbandBorder: "rgba(255,80,150,0.50)",
    centerLine: "rgba(251,146,60,0.90)",
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
    snrHueRange: [0, 120],
    snrSaturation: 95,
    snrLightness: 58,
  },
  tuning: {
    passbandFill: "rgba(255,255,255,0.07)",
    passbandBorder: "rgba(255,255,255,0.20)",
    centerLine: "rgba(251,146,60,0.70)",
  },
  statusWarning: "#f59e0b",
};

const alert: SDRTheme = {
  name: "alert",
  label: "Alert",
  ui: {
    background: "0 30% 4%",
    foreground: "0 20% 80%",
    card: "0 25% 7%",
    cardForeground: "0 20% 80%",
    popover: "0 25% 7%",
    popoverForeground: "0 20% 80%",
    primary: "0 65% 55%",
    primaryForeground: "0 30% 4%",
    secondary: "0 25% 13%",
    secondaryForeground: "0 20% 80%",
    muted: "0 20% 13%",
    mutedForeground: "0 15% 50%",
    accent: "0 25% 13%",
    accentForeground: "0 20% 80%",
    destructive: "0 55% 42%",
    destructiveForeground: "0 0% 95%",
    border: "0 25% 18%",
    input: "0 25% 18%",
    ring: "0 65% 55%",
  },
  display: {
    defaultColorMap: "phosphor",
    waterfallBg: "#0a0204",
    spectrumBg: "#100408",
    spectrumFillOpacity: 0.8,
    spectrumGradientStops: [
      [0, "#ff4444"],
      [0.25, "#cc2222"],
      [0.5, "#881818"],
      [0.75, "#441010"],
      [1, "#180404"],
    ],
    spectrumGridLine: "rgba(200, 50, 50, 0.12)",
    spectrumGridLabel: "rgba(200, 50, 50, 0.45)",
    spectrumPeakTrace: "#ff4444",
    spectrumPassbandFill: "rgba(255, 80, 80, 0.12)",
    freqScaleBg: "#100408",
    freqScaleTickMajor: "#cc4444",
    freqScaleTickMinor: "#551818",
    freqScaleLabel: "#cc4444",
    freqScaleUnitLabel: "#551818",
  },
  map: {
    background: "#0a0204",
    countryLines: "#551818",
    countryLineOpacity: 0.8,
    markerColor: "#cc4444",
    markerGlow: "rgba(200,60,60,0.6)",
    selectedRing: "#ff6666",
    crosshair: "rgba(255,100,100,0.8)",
    snrFallback: "#cc4444",
    snrHueRange: [0, 60],
    snrSaturation: 80,
    snrLightness: 52,
  },
  tuning: {
    passbandFill: "rgba(255,80,80,0.12)",
    passbandBorder: "rgba(255,80,80,0.50)",
    centerLine: "rgba(251,146,60,0.90)",
  },
  statusWarning: "#ff4444",
};

const muted: SDRTheme = {
  name: "muted",
  label: "Muted",
  ui: {
    background: "0 0% 4%",
    foreground: "0 0% 65%",
    card: "0 0% 7%",
    cardForeground: "0 0% 65%",
    popover: "0 0% 7%",
    popoverForeground: "0 0% 65%",
    primary: "0 0% 45%",
    primaryForeground: "0 0% 4%",
    secondary: "0 0% 13%",
    secondaryForeground: "0 0% 65%",
    muted: "0 0% 13%",
    mutedForeground: "0 0% 40%",
    accent: "0 0% 13%",
    accentForeground: "0 0% 65%",
    destructive: "0 0% 35%",
    destructiveForeground: "0 0% 85%",
    border: "0 0% 15%",
    input: "0 0% 15%",
    ring: "0 0% 45%",
  },
  display: {
    defaultColorMap: "grayscale",
    waterfallBg: "#080808",
    spectrumBg: "#0a0a0a",
    spectrumFillOpacity: 0.6,
    spectrumGradientStops: [
      [0, "#d0d0d0"],
      [0.3, "#909090"],
      [0.6, "#505050"],
      [1, "#101010"],
    ],
    spectrumGridLine: "rgba(255, 255, 255, 0.08)",
    spectrumGridLabel: "rgba(255, 255, 255, 0.3)",
    spectrumPeakTrace: "#888888",
    spectrumPassbandFill: "rgba(255, 255, 255, 0.06)",
    freqScaleBg: "#0a0a0a",
    freqScaleTickMajor: "#777777",
    freqScaleTickMinor: "#333333",
    freqScaleLabel: "#777777",
    freqScaleUnitLabel: "#333333",
  },
  map: {
    background: "#0a0a0a",
    countryLines: "#333333",
    countryLineOpacity: 0.6,
    markerColor: "#888888",
    markerGlow: "rgba(136,136,136,0.4)",
    selectedRing: "#aaaaaa",
    crosshair: "rgba(170,170,170,0.6)",
    snrFallback: "#888888",
    snrHueRange: [0, 0],
    snrSaturation: 0,
    snrLightness: 55,
  },
  tuning: {
    passbandFill: "rgba(255,255,255,0.06)",
    passbandBorder: "rgba(255,255,255,0.20)",
    centerLine: "rgba(255,255,255,0.50)",
  },
  statusWarning: "#888888",
};

export const THEMES: Record<string, SDRTheme> = { phosphor, classic };
export const MUTED_THEME = muted;

// ─── Store ───────────────────────────────────────────────────────────────────

interface ThemeStore {
  theme: SDRTheme;
  baseTheme: SDRTheme;
  setTheme: (name: string) => void;
  setOverride: (theme: SDRTheme | null) => void;
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

export const ALERT_THEME = alert;

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: THEMES[DEFAULT_THEME],
  baseTheme: THEMES[DEFAULT_THEME],
  setTheme: (name: string) => {
    const next = THEMES[name];
    if (!next) return;
    applyCSSVariables(next.ui);
    set({ theme: next, baseTheme: next });
  },
  setOverride: (override: SDRTheme | null) => {
    const active = override ?? get().baseTheme;
    applyCSSVariables(active.ui);
    set({ theme: active });
  },
}));

export function initTheme() {
  const theme = useThemeStore.getState().theme;
  document.documentElement.classList.add("dark");
  applyCSSVariables(theme.ui);
}
