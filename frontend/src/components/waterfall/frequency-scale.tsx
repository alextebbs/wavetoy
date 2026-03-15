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

const BAND_ROW_PX = 3;
const HIT_EXTEND_PX = 8;
const SCALE_PX = 36;
const TOTAL_HEIGHT = BAND_ROW_PX + SCALE_PX + BAND_ROW_PX;

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
  side,
}: {
  band: VisibleBand;
  label: string;
  color: string;
  hoverColor: string;
  side: "top" | "bottom";
}) {
  const [hover, setHover] = useState(false);
  const [mouseX, setMouseX] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);

  const tooltipY = () => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const centerY = rect.top + rect.height / 2;
    return side === "top" ? centerY - 26 : centerY + 10;
  };

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
          top: side === "top" ? 0 : -(HIT_EXTEND_PX - BAND_ROW_PX),
          height: HIT_EXTEND_PX,
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
              top: tooltipY(),
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
}

export function FrequencyScale({ className, onResizeStart }: FrequencyScaleProps) {
  const startKHz = useBandViewStore((s) => s.startKHz);
  const endKHz = useBandViewStore((s) => s.endKHz);
  const d = useThemeStore((s) => s.theme.display);

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
      className={`relative flex select-none flex-col overflow-visible border-y border-foreground/25 ${className ?? ""}`}
      style={{ height: TOTAL_HEIGHT, backgroundColor: d.freqScaleBg }}
    >
      {/* Amateur bands — top row */}
      <div className="relative z-40 shrink-0 overflow-visible" style={{ height: BAND_ROW_PX }}>
        {amateurVisible.map((b) => (
          <BandSegment
            key={b.name}
            band={b}
            label={`${b.name} amateur — ${formatFreq(b.startKHz)}–${formatFreq(b.endKHz)} kHz`}
            color="rgba(34,197,94,0.5)"
            hoverColor="rgba(34,197,94,0.9)"
            side="top"
          />
        ))}
      </div>

      {/* Scale area */}
      <div className="relative flex-1">
        {ticks.map((tick) => (
          <div
            key={tick.freqKHz}
            className="absolute top-0"
            style={{ left: `${tick.xPercent}%` }}
          >
            <div
              className="w-px"
              style={{
                height: tick.major ? 12 : 8,
                backgroundColor: tick.major
                  ? d.freqScaleTickMajor
                  : d.freqScaleTickMinor,
              }}
            />
            {tick.label && (
              <span
                className="absolute left-1/2 top-3.5 -translate-x-1/2 whitespace-nowrap text-[10px] leading-none"
                style={{ color: d.freqScaleLabel }}
              >
                {tick.label}
              </span>
            )}
          </div>
        ))}
        <span
          className="absolute right-1.5 top-3.5 text-[9px] leading-none"
          style={{ color: d.freqScaleUnitLabel }}
        >
          kHz
        </span>
      </div>

      {/* Broadcast bands — bottom row */}
      <div className="relative z-40 shrink-0 overflow-visible" style={{ height: BAND_ROW_PX }}>
        {broadcastVisible.map((b) => (
          <BandSegment
            key={b.name}
            band={b}
            label={`${b.name} broadcast — ${formatFreq(b.startKHz)}–${formatFreq(b.endKHz)} kHz`}
            color="rgba(245,158,11,0.5)"
            hoverColor="rgba(245,158,11,0.9)"
            side="bottom"
          />
        ))}
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
