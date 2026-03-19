import { useThemeStore } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

type Props = {
  roomSize: number;
  damping: number;
  mix: number;
  height?: number;
  className?: string;
};

export function ReverbDecay({
  roomSize,
  damping,
  mix,
  height = 72,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const primaryColor = useThemeStore((s) => s.theme.statusWarning);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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

    const c = primaryColor;
    const centerY = h / 2;
    const barCount = 200;
    const r = Math.max(roomSize, 0.01);

    const amplitudes: number[] = [];
    for (let i = 0; i < barCount; i++) {
      const time = i / 200;
      let amplitude: number;
      if (i === 0) {
        amplitude = 1;
      } else {
        amplitude =
          Math.exp((-time * (3 + damping * 5)) / r) *
          (0.3 + 0.7 * Math.abs(Math.sin(i * 13.7 + i * i * 0.1)));
      }
      amplitudes.push(amplitude);
    }

    const halfExtent = (h / 2) * 0.9;

    for (let i = 0; i < barCount; i++) {
      const amplitude = amplitudes[i];
      const x = (i / (barCount - 1)) * w;
      const barLen = amplitude * halfExtent;
      const top = centerY - barLen;
      const bottom = centerY + barLen;

      ctx.strokeStyle = hexToRgba(c, Math.max(0.05, 0.6 * amplitude));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < barCount; i++) {
      const amplitude = amplitudes[i];
      const x = (i / (barCount - 1)) * w;
      const barLen = amplitude * halfExtent;
      const y = centerY - barLen;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(Math.round(roomSize * 100) + "%", w - 4, 4);

  }, [roomSize, damping, mix, primaryColor]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}
