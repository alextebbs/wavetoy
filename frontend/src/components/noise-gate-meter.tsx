import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type RefObject, useEffect, useRef } from "react";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const MIN_DB = -80;
const MAX_DB = 0;
const DB_RANGE = MAX_DB - MIN_DB;

type Props = {
  samplesRef: RefObject<Float32Array>;
  thresholdDb: number;
  height?: number;
  className?: string;
};

export function NoiseGateMeter({
  samplesRef,
  thresholdDb,
  height = 32,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const smoothedDb = useRef(-80);
  const peakDb = useRef(-80);
  const peakHoldTime = useRef(0);
  const threshRef = useRef(thresholdDb);
  const primaryColor = useThemeStore((s) => s.theme.statusWarning);
  const colorRef = useRef(primaryColor);
  colorRef.current = primaryColor;
  threshRef.current = thresholdDb;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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
      let rms = 0;
      if (samples && samples.length > 0) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          sum += samples[i] * samples[i];
        }
        rms = Math.sqrt(sum / samples.length);
      }
      const currentDb = 20 * Math.log10(rms + 1e-10);
      smoothedDb.current += (currentDb - smoothedDb.current) * 0.25;

      if (smoothedDb.current > peakDb.current) {
        peakDb.current = smoothedDb.current;
        peakHoldTime.current = 60;
      } else if (peakHoldTime.current > 0) {
        peakHoldTime.current--;
      } else {
        peakDb.current -= 0.5;
      }

      const levelNorm = Math.max(0, Math.min(1, (smoothedDb.current - MIN_DB) / DB_RANGE));
      const peakNorm = Math.max(0, Math.min(1, (peakDb.current - MIN_DB) / DB_RANGE));
      const threshNorm = Math.max(0, Math.min(1, (threshRef.current - MIN_DB) / DB_RANGE));

      const barH = h - 16;
      const barY = 0;

      const c = colorRef.current;
      const gated = smoothedDb.current < threshRef.current;

      // Level bar background
      ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
      ctx.fillRect(0, barY, w, barH);

      // Level fill
      const levelW = levelNorm * w;
      ctx.fillStyle = gated ? "rgba(255, 255, 255, 0.1)" : hexToRgba(c, 0.35);
      ctx.fillRect(0, barY, levelW, barH);

      // Peak hold indicator
      const peakX = peakNorm * w;
      ctx.fillStyle = gated ? "rgba(255, 255, 255, 0.25)" : hexToRgba(c, 0.7);
      ctx.fillRect(peakX - 1, barY, 2, barH);

      // Threshold line
      const threshX = threshNorm * w;
      ctx.strokeStyle = "rgba(251, 146, 60, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(threshX, barY);
      ctx.lineTo(threshX, barY + barH);
      ctx.stroke();
      ctx.setLineDash([]);

      // dB tick labels
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const db of [-60, -40, -20, -10, 0]) {
        const tx = ((db - MIN_DB) / DB_RANGE) * w;
        ctx.fillRect(tx, barY + barH, 1, 3);
        ctx.fillText(`${db}`, tx, barY + barH + 3);
      }

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
