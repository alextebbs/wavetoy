import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type RefObject, useEffect, useRef } from "react";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

type Props = {
  samplesRef: RefObject<Float32Array>;
  height?: number;
  className?: string;
};

export function AudioWaveform({ samplesRef, height = 56, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const primaryColor = useThemeStore((s) => s.theme.statusWarning);

  const colorRef = useRef(primaryColor);
  colorRef.current = primaryColor;

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

      const midY = h / 2;

      const c = colorRef.current;

      ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.stroke();

      const allSamples = samplesRef.current;
      if (!allSamples || allSamples.length === 0) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const windowSize = Math.min(512, allSamples.length);
      const offset = Math.max(0, allSamples.length - windowSize);
      const samplesPerPx = windowSize / w;

      ctx.fillStyle = hexToRgba(c, 0.08);
      ctx.beginPath();
      ctx.moveTo(0, midY);
      for (let x = 0; x < w; x++) {
        const idx = offset + Math.min(Math.floor(x * samplesPerPx), windowSize - 1);
        ctx.lineTo(x, midY - allSamples[idx] * midY * 2);
      }
      ctx.lineTo(w, midY);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = c;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.shadowColor = hexToRgba(c, 0.3);
      ctx.shadowBlur = 3;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const idx = offset + Math.min(Math.floor(x * samplesPerPx), windowSize - 1);
        const y = midY - allSamples[idx] * midY * 2;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

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
