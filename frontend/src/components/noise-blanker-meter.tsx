import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type RefObject, useEffect, useRef } from "react";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const HISTORY_LEN = 200;
const MIN_DB = -60;
const MAX_DB = 0;
const DB_RANGE = MAX_DB - MIN_DB;

type Props = {
  samplesRef: RefObject<Float32Array>;
  threshold: number;
  height?: number;
  className?: string;
};

/**
 * Visualizes noise blanker activity as a scrolling waveform envelope with
 * impulse detections highlighted. When peak amplitude exceeds the threshold
 * relative to the moving average, those regions flash to show blanking.
 */
export function NoiseBlankerMeter({
  samplesRef,
  threshold,
  height = 48,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const historyRef = useRef(new Float64Array(HISTORY_LEN));
  const blankedRef = useRef(new Uint8Array(HISTORY_LEN));
  const writePos = useRef(0);
  const avgRef = useRef(0);
  const threshRef = useRef(threshold);
  const primaryColor = useThemeStore((s) => s.theme.statusWarning);
  const colorRef = useRef(primaryColor);
  colorRef.current = primaryColor;
  threshRef.current = threshold;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const history = historyRef.current;
    const blanked = blankedRef.current;

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
      let peakDb = -80;
      let wasBlanked = false;

      if (samples && samples.length > 0) {
        let peak = 0;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const abs = Math.abs(samples[i]);
          if (abs > peak) peak = abs;
          sum += abs;
        }
        const avg = sum / samples.length;
        avgRef.current = avgRef.current * 0.95 + avg * 0.05;

        peakDb = 20 * Math.log10(peak + 1e-10);

        // Simulate blanker detection: peak vs moving average ratio
        const ratio = 0.005 * threshRef.current;
        wasBlanked = ratio > 0 && peak > avgRef.current * (1 / ratio + 1);
      }

      const pos = writePos.current;
      history[pos] = peakDb;
      blanked[pos] = wasBlanked ? 1 : 0;
      writePos.current = (pos + 1) % HISTORY_LEN;

      const c = colorRef.current;

      // Draw scrolling envelope
      const barW = w / HISTORY_LEN;
      for (let i = 0; i < HISTORY_LEN; i++) {
        const idx = (writePos.current + i) % HISTORY_LEN;
        const db = history[idx];
        const norm = Math.max(0, Math.min(1, (db - MIN_DB) / DB_RANGE));
        const barH = norm * h;
        const x = i * barW;

        if (blanked[idx]) {
          ctx.fillStyle = hexToRgba(c, 0.5);
          ctx.fillRect(x, 0, Math.ceil(barW), h);
          ctx.fillStyle = hexToRgba(c, 0.8);
        } else {
          ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        }
        ctx.fillRect(x, h - barH, Math.ceil(barW), barH);
      }

      // Threshold reference text
      ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(`sens ${Math.round(threshRef.current)}`, w - 3, 2);

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
