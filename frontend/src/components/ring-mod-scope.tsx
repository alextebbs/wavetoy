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
  carrierHz: number;
  mix: number;
  height?: number;
  className?: string;
};

export function RingModScope({
  carrierHz,
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
    const midY = h / 2;
    const numPoints = Math.round(w);

    // Horizontal divider
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Show ~4 cycles of carrier in the visible width
    const visibleCycles = 4;
    const period = w / visibleCycles;
    const omega = (2 * Math.PI) / period;

    // Simulated input: sum of two sine waves to look "voice-like"
    const inputOmega1 = (2 * Math.PI) / (w / 1.3);
    const inputOmega2 = (2 * Math.PI) / (w / 3.7);

    // Top half: carrier sine wave
    const topAmp = midY * 0.7;
    const topCenter = midY / 2;
    ctx.strokeStyle = hexToRgba(c, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const y = topCenter - Math.sin(omega * i) * topAmp;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    // Bottom half: modulated output (input × carrier, blended by mix)
    const botAmp = (h - midY) * 0.7;
    const botCenter = midY + (h - midY) / 2;
    ctx.strokeStyle = hexToRgba(c, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const input =
        0.6 * Math.sin(inputOmega1 * i) + 0.4 * Math.sin(inputOmega2 * i);
      const carrier = Math.sin(omega * i);
      const modulated = input * carrier;
      const blended = input * (1 - mix) + modulated * mix;
      const y = botCenter - blended * botAmp;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    // Fill under the modulated waveform
    ctx.lineTo(numPoints - 1, botCenter);
    ctx.lineTo(0, botCenter);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(c, 0.08);
    ctx.fill();

    // Carrier frequency label
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`${carrierHz} Hz`, w - 3, 2);
  }, [carrierHz, mix, primaryColor]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}
