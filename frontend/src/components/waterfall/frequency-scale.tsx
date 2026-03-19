import { useBandViewStore } from "@/lib/band-view-store";
import {
  AMATEUR_BANDS,
  BROADCAST_BANDS,
  type FrequencyBand,
} from "@/lib/frequency-bands";
import { useThemeStore } from "@/lib/theme";
import { useRef, useMemo, useState } from "react";
import { createPortal } from "react-dom";

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

export const FREQ_SCALE_HEIGHT = 36;
const BAND_ROW_H = 3;
const TICK_MAJOR_H = 10;
const TICK_MINOR_H = 6;

interface VisibleBand extends FrequencyBand {
  leftPct: number;
  widthPct: number;
}

function visibleBands(
  bands: FrequencyBand[],
  startKHz: number,
  endKHz: number,
): VisibleBand[] {
  const span = endKHz - startKHz;
  if (span <= 0) return [];
  return bands
    .filter((b) => b.endKHz > startKHz && b.startKHz < endKHz)
    .map((b) => {
      const leftPct = Math.max(0, ((b.startKHz - startKHz) / span) * 100);
      const rightPct = Math.min(100, ((b.endKHz - startKHz) / span) * 100);
      return { ...b, leftPct, widthPct: rightPct - leftPct };
    });
}

function BandSegment({
  band,
  label,
  color,
  hoverColor,
}: {
  band: VisibleBand;
  label: string;
  color: string;
  hoverColor: string;
}) {
  const [hover, setHover] = useState(false);
  const [mouseX, setMouseX] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* Visual bar */}
      <div
        ref={barRef}
        className="absolute inset-y-0 transition-colors pointer-events-none"
        style={{
          left: `${band.leftPct}%`,
          width: `${band.widthPct}%`,
          backgroundColor: hover ? hoverColor : color,
        }}
      />
      {/* Extended hit area */}
      <div
        className="absolute"
        style={{
          left: `${band.leftPct}%`,
          width: `${band.widthPct}%`,
          top: -2,
          bottom: -2,
        }}
        onMouseEnter={(e) => {
          setHover(true);
          setMouseX(e.clientX);
        }}
        onMouseMove={(e) => setMouseX(e.clientX)}
        onMouseLeave={() => setHover(false)}
      />
      {hover &&
        createPortal(
          <div
            className="fixed z-[200] pointer-events-none whitespace-nowrap rounded bg-popover px-2 py-1 text-[11px] uppercase tracking-wide text-popover-foreground shadow-md border border-border"
            style={{
              left: mouseX + 12,
              top: (barRef.current?.getBoundingClientRect().top ?? 0) - 28,
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

interface FrequencyScaleProps {
  className?: string;
  onResizeStart?: (e: React.MouseEvent) => void;
  hideTopBorder?: boolean;
}

export function FrequencyScale({ className, onResizeStart, hideTopBorder }: FrequencyScaleProps) {
  const startKHz = useBandViewStore((s) => s.startKHz);
  const endKHz = useBandViewStore((s) => s.endKHz);
  const d = useThemeStore((s) => s.theme.display);
  const [hovered, setHovered] = useState(false);

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

  const amateurVisible = useMemo(
    () => visibleBands(AMATEUR_BANDS, startKHz, endKHz),
    [startKHz, endKHz],
  );
  const broadcastVisible = useMemo(
    () => visibleBands(BROADCAST_BANDS, startKHz, endKHz),
    [startKHz, endKHz],
  );

  return (
    <div
      className={`relative select-none overflow-visible ${hideTopBorder ? "border-b" : "border-y"} border-foreground/25 ${className ?? ""}`}
      style={{ height: FREQ_SCALE_HEIGHT, backgroundColor: d.freqScaleBg }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Ticks and labels */}
      {ticks.map((tick) => (
        <div
          key={tick.freqKHz}
          className="absolute inset-y-0"
          style={{ left: `${tick.xPercent}%` }}
        >
          {/* Top tick */}
          <div
            className="absolute top-0 w-px"
            style={{
              height: tick.major ? TICK_MAJOR_H : TICK_MINOR_H,
              backgroundColor: tick.major
                ? d.freqScaleTickMajor
                : d.freqScaleTickMinor,
            }}
          />
          {/* Bottom tick */}
          <div
            className="absolute bottom-0 w-px"
            style={{
              height: tick.major ? TICK_MAJOR_H : TICK_MINOR_H,
              backgroundColor: tick.major
                ? d.freqScaleTickMajor
                : d.freqScaleTickMinor,
            }}
          />
          {/* Centered label */}
          {tick.label && (
            <span
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] leading-none"
              style={{ color: d.freqScaleLabel }}
            >
              {tick.label}
            </span>
          )}
        </div>
      ))}

      <span
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] leading-none"
        style={{ color: d.freqScaleUnitLabel }}
      >
        kHz
      </span>

      {/* Band indicators — centered, visible on hover */}
      <div
        className="absolute inset-x-0 z-40 overflow-visible transition-opacity duration-150"
        style={{
          top: "50%",
          transform: "translateY(-50%)",
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
        }}
      >
        <div className="relative overflow-visible" style={{ height: BAND_ROW_H }}>
          {amateurVisible.map((b) => (
            <BandSegment
              key={b.name}
              band={b}
              label={`${b.name} amateur — ${formatFreq(b.startKHz)}–${formatFreq(b.endKHz)} kHz`}
              color="rgba(34,197,94,0.5)"
              hoverColor="rgba(34,197,94,0.9)"
            />
          ))}
        </div>
        <div style={{ height: 1 }} />
        <div className="relative overflow-visible" style={{ height: BAND_ROW_H }}>
          {broadcastVisible.map((b) => (
            <BandSegment
              key={b.name}
              band={b}
              label={`${b.name} broadcast — ${formatFreq(b.startKHz)}–${formatFreq(b.endKHz)} kHz`}
              color="rgba(245,158,11,0.5)"
              hoverColor="rgba(245,158,11,0.9)"
            />
          ))}
        </div>
      </div>

      {onResizeStart && (
        <div
          className="absolute inset-0 z-30 cursor-row-resize"
          onMouseDown={onResizeStart}
        />
      )}
    </div>
  );
}
