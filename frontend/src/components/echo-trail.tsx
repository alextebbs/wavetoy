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
  delayMs: number;
  feedback: number;
  mix: number;
  height?: number;
  className?: string;
};

export function EchoTrail({
  delayMs,
  feedback,
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
    const pad = 8;
    const plotH = h - pad * 2;

    // Compute numTaps: amplitude starts at 1, multiply by feedback each tap until < 0.01, max 20
    let numTaps = 0;
    let amplitude = 1;
    while (amplitude >= 0.01 && numTaps < 20) {
      numTaps++;
      amplitude *= feedback;
    }
    numTaps = Math.max(1, numTaps);

    const totalTime = numTaps * delayMs;
    if (totalTime === 0) return;

    const barWidth = Math.max(2, (w / numTaps) * 0.6);

    // Thin horizontal time ticks between taps (short horizontal segments)
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    const tickLen = 4;
    const tickY = pad + plotH;
    for (let i = 1; i < numTaps; i++) {
      const x = (i * delayMs / totalTime) * w;
      ctx.beginPath();
      ctx.moveTo(x - tickLen / 2, tickY);
      ctx.lineTo(x + tickLen / 2, tickY);
      ctx.stroke();
    }

    // Draw each tap as a vertical bar
    for (let tapIndex = 0; tapIndex < numTaps; tapIndex++) {
      const x = (tapIndex * delayMs / totalTime) * w;
      const barLeft = x - barWidth / 2;
      const barX = Math.max(0, Math.min(barLeft, w - barWidth));

      if (tapIndex === 0) {
        // First bar (dry)
        const barHeight = pad + plotH * (1 - mix);
        ctx.fillStyle = hexToRgba(c, 0.5);
        ctx.fillRect(barX, h - barHeight, barWidth, barHeight);
      } else {
        // Subsequent bars (echo taps)
        const amp = Math.pow(feedback, tapIndex);
        const barHeight = plotH * mix * amp;
        const alpha = Math.max(0.08, 0.5 * amp);
        ctx.fillStyle = hexToRgba(c, alpha);
        ctx.fillRect(barX, pad + plotH - barHeight, barWidth, barHeight);
      }
    }

    // Mix label top-right
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`mix ${Math.round(mix * 100)}%`, w - 3, 2);
  }, [delayMs, feedback, mix, primaryColor]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}
