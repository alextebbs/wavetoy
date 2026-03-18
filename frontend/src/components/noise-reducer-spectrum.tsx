import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type RefObject, useEffect, useRef } from "react";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const FFT_SIZE = 512;
const NUM_BINS = FFT_SIZE / 2;
const DB_RANGE = 60;
const SAMPLE_RATE = 12000;
const MAX_DISPLAY_HZ = 3000;
const HZ_PER_BIN = SAMPLE_RATE / FFT_SIZE;

type Props = {
  samplesRef: RefObject<Float32Array>;
  strength: number;
  floorDb: number;
  height?: number;
  className?: string;
};

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

export function NoiseReducerSpectrum({
  samplesRef,
  strength,
  floorDb,
  height = 72,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const avgRef = useRef(new Float64Array(NUM_BINS));
  const reRef = useRef(new Float64Array(FFT_SIZE));
  const imRef = useRef(new Float64Array(FFT_SIZE));
  const strengthRef = useRef(strength);
  const floorRef = useRef(floorDb);
  const primaryColor = useThemeStore((s) => s.theme.statusWarning);
  const colorRef = useRef(primaryColor);
  colorRef.current = primaryColor;
  strengthRef.current = strength;
  floorRef.current = floorDb;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const avg = avgRef.current;
    const re = reRef.current;
    const im = imRef.current;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = rect.height;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const samples = samplesRef.current;
      if (samples && samples.length > 0) {
        const len = Math.min(samples.length, FFT_SIZE);
        re.fill(0);
        im.fill(0);
        for (let i = 0; i < len; i++) {
          const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
          re[i] = samples[i] * win;
        }
        fft(re, im);

        const alpha = 0.3;
        for (let i = 0; i < NUM_BINS; i++) {
          const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
          const db = 20 * Math.log10(mag + 1e-10);
          avg[i] = avg[i] * (1 - alpha) + db * alpha;
        }
      }

      let peak = -Infinity;
      for (let i = 0; i < NUM_BINS; i++) {
        if (avg[i] > peak) peak = avg[i];
      }
      if (!Number.isFinite(peak)) peak = 0;
      const floor = peak - DB_RANGE;

      const c = colorRef.current;
      const st = strengthRef.current;
      const flDb = floorRef.current;

      // Floor region: shade below the floor_db line to show subtraction floor
      const floorNorm = Math.max(0, (peak + flDb - floor) / DB_RANGE);
      const floorY = h * (1 - floorNorm);
      ctx.fillStyle = hexToRgba(c, 0.04 + st * 0.06);
      ctx.fillRect(0, floorY, w, h - floorY);

      // Spectrum fill
      ctx.fillStyle = hexToRgba(c, 0.10);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        const freq = (x / w) * MAX_DISPLAY_HZ;
        const binIdx = Math.min(
          Math.floor(freq / HZ_PER_BIN),
          NUM_BINS - 1,
        );
        const norm = Math.max(0, (avg[binIdx] - floor) / DB_RANGE);
        ctx.lineTo(x, h * (1 - norm));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      // Spectrum line
      ctx.strokeStyle = hexToRgba(c, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const freq = (x / w) * MAX_DISPLAY_HZ;
        const binIdx = Math.min(
          Math.floor(freq / HZ_PER_BIN),
          NUM_BINS - 1,
        );
        const norm = Math.max(0, (avg[binIdx] - floor) / DB_RANGE);
        const y = h * (1 - norm);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Floor line
      ctx.strokeStyle = "rgba(251, 146, 60, 0.8)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, floorY);
      ctx.lineTo(w, floorY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Strength label (right side)
      ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${Math.round(st * 100)}%`, w - 3, floorY - 2);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [samplesRef]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}
