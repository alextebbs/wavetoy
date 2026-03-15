import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type RefObject, useCallback, useEffect, useRef } from "react";

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
const NYQUIST = SAMPLE_RATE / 2;
const HZ_PER_BIN = SAMPLE_RATE / FFT_SIZE;

const TICK_HZ = [500, 1000, 2000, 3000, 4000, 5000];

type Props = {
  samplesRef: RefObject<Float32Array>;
  centerHz: number;
  q: number;
  onCenterChange?: (hz: number) => void;
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

function clampHz(hz: number): number {
  return Math.round(Math.max(50, Math.min(NYQUIST - 100, hz)) / 10) * 10;
}

export function NotchSpectrum({
  samplesRef,
  centerHz,
  q,
  onCenterChange,
  height = 80,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const avgRef = useRef(new Float64Array(NUM_BINS));
  const reRef = useRef(new Float64Array(FFT_SIZE));
  const imRef = useRef(new Float64Array(FFT_SIZE));
  const centerRef = useRef(centerHz);
  const qRef = useRef(q);
  const draggingRef = useRef(false);
  const onCenterChangeRef = useRef(onCenterChange);
  const primaryColor = useThemeStore((s) => s.theme.statusWarning);
  const colorRef = useRef(primaryColor);
  colorRef.current = primaryColor;

  centerRef.current = centerHz;
  qRef.current = q;
  onCenterChangeRef.current = onCenterChange;

  const LABEL_AREA = 14;

  const pxToHz = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return centerHz;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      return clampHz((x / rect.width) * NYQUIST);
    },
    [centerHz],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e: PointerEvent) => {
      draggingRef.current = true;
      canvas.setPointerCapture(e.pointerId);
      onCenterChangeRef.current?.(pxToHz(e.clientX));
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      onCenterChangeRef.current?.(pxToHz(e.clientX));
    };
    const onPointerUp = () => {
      draggingRef.current = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, [pxToHz]);

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
      const totalH = rect.height;
      const h = totalH - LABEL_AREA;
      const bw = Math.round(w * dpr);
      const bh = Math.round(totalH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, totalH);

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

      const cHz = centerRef.current;
      const cQ = qRef.current;

      // Notch bandwidth band
      const bw3dB = cHz / cQ;
      const leftX = ((cHz - bw3dB / 2) / NYQUIST) * w;
      const rightX = ((cHz + bw3dB / 2) / NYQUIST) * w;
      ctx.fillStyle = "rgba(251, 146, 60, 0.07)";
      ctx.fillRect(leftX, 0, rightX - leftX, h);

      const c = colorRef.current;

      ctx.fillStyle = hexToRgba(c, 0.10);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        const freq = (x / w) * NYQUIST;
        const binIdx = Math.min(Math.floor(freq / HZ_PER_BIN), NUM_BINS - 1);
        const norm = Math.max(0, (avg[binIdx] - floor) / DB_RANGE);
        ctx.lineTo(x, h * (1 - norm));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = hexToRgba(c, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const freq = (x / w) * NYQUIST;
        const binIdx = Math.min(Math.floor(freq / HZ_PER_BIN), NUM_BINS - 1);
        const norm = Math.max(0, (avg[binIdx] - floor) / DB_RANGE);
        const y = h * (1 - norm);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Notch center line
      const centerX = (cHz / NYQUIST) * w;
      ctx.strokeStyle = "rgba(251, 146, 60, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Frequency tick labels
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const hz of TICK_HZ) {
        const tx = (hz / NYQUIST) * w;
        ctx.fillRect(tx, h, 1, 3);
        const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
        ctx.fillText(label, tx, h + 3);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [samplesRef]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full cursor-crosshair", className)}
      style={{ height: height + LABEL_AREA }}
    />
  );
}
