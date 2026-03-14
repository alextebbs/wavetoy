import { useBandViewStore } from "@/lib/band-view-store";
import { useMemo } from "react";

interface Tick {
  freqKHz: number;
  label: string;
  xPercent: number;
  major: boolean;
}

function pickTickSpacing(spanKHz: number): [number, number] {
  const targets: [number, number][] = [
    [10000, 2000],
    [5000, 1000],
    [2000, 500],
    [1000, 200],
    [500, 100],
    [200, 50],
    [100, 20],
    [50, 10],
    [20, 5],
    [10, 2],
    [5, 1],
    [2, 0.5],
    [1, 0.2],
  ];
  for (const [major, minor] of targets) {
    if (spanKHz / major >= 3 && spanKHz / major <= 20) {
      return [major, minor];
    }
  }
  if (spanKHz > 20000) return [10000, 2000];
  return [1, 0.2];
}

function formatFreq(kHz: number): string {
  if (kHz === Math.floor(kHz)) return `${kHz}`;
  return kHz.toFixed(1);
}

interface FrequencyScaleProps {
  className?: string;
  onResizeStart?: (e: React.MouseEvent) => void;
}

export function FrequencyScale({ className, onResizeStart }: FrequencyScaleProps) {
  const startKHz = useBandViewStore((s) => s.startKHz);
  const endKHz = useBandViewStore((s) => s.endKHz);

  const ticks = useMemo(() => {
    const span = endKHz - startKHz;
    if (span <= 0) return [];

    const [majorSpacing, minorSpacing] = pickTickSpacing(span);
    const result: Tick[] = [];

    const firstMinor = Math.ceil(startKHz / minorSpacing) * minorSpacing;
    for (let freq = firstMinor; freq <= endKHz; freq += minorSpacing) {
      const xPercent = ((freq - startKHz) / span) * 100;
      if (xPercent < -1 || xPercent > 101) continue;
      const isMajor =
        Math.abs(freq / majorSpacing - Math.round(freq / majorSpacing)) < 0.001;
      result.push({
        freqKHz: freq,
        label: isMajor ? formatFreq(freq) : "",
        xPercent,
        major: isMajor,
      });
    }
    return result;
  }, [startKHz, endKHz]);

  return (
    <div
      className={`relative select-none overflow-hidden bg-zinc-950 ${className ?? ""}`}
      style={{ height: 36 }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.freqKHz}
          className="absolute top-0"
          style={{ left: `${tick.xPercent}%` }}
        >
          <div
            className={`w-px ${tick.major ? "h-3 bg-zinc-400" : "h-2 bg-zinc-600"}`}
          />
          {tick.label && (
            <span className="absolute left-1/2 top-3.5 -translate-x-1/2 whitespace-nowrap text-[10px] leading-none text-zinc-400">
              {tick.label}
            </span>
          )}
        </div>
      ))}
      <span className="absolute right-1.5 top-3.5 text-[9px] leading-none text-zinc-600">
        kHz
      </span>
      {onResizeStart && (
        <div
          className="absolute inset-0 z-30 cursor-row-resize"
          onMouseDown={onResizeStart}
        />
      )}
    </div>
  );
}
