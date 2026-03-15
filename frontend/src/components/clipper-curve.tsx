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
  driveDb: number;
  ceilingDb: number;
  height?: number;
  className?: string;
};

export function ClipperCurve({
  driveDb,
  ceilingDb,
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

    const pad = 8;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;

    // Unity line (diagonal)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad + plotH);
    ctx.lineTo(pad + plotW, pad);
    ctx.stroke();

    // Ceiling line (horizontal)
    const ceilingLin = Math.pow(10, ceilingDb / 20);
    const ceilingY = pad + plotH * (1 - ceilingLin);
    ctx.strokeStyle = "rgba(251, 146, 60, 0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, ceilingY);
    ctx.lineTo(pad + plotW, ceilingY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Transfer curve with soft clipping: out = ceiling * tanh(drive * in / ceiling)
    const driveLin = Math.pow(10, driveDb / 20);
    const c = primaryColor;

    ctx.fillStyle = hexToRgba(c, 0.06);
    ctx.beginPath();
    ctx.moveTo(pad, pad + plotH);
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const inVal = i / steps;
      const driven = inVal * driveLin;
      const outVal = ceilingLin * Math.tanh(driven / ceilingLin);
      const clampedOut = Math.min(outVal, 1);
      const x = pad + inVal * plotW;
      const y = pad + plotH * (1 - clampedOut);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(pad + plotW, pad + plotH);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = hexToRgba(c, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const inVal = i / steps;
      const driven = inVal * driveLin;
      const outVal = ceilingLin * Math.tanh(driven / ceilingLin);
      const clampedOut = Math.min(outVal, 1);
      const x = pad + inVal * plotW;
      const y = pad + plotH * (1 - clampedOut);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("out", pad + 2, pad + 6);
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("in", pad + plotW - 2, pad + plotH - 2);
  }, [driveDb, ceilingDb, primaryColor]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}
