import { useCallback, useRef, useState } from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { useThemeStore } from "@/lib/theme";

const HANDLE_PX = 8;
const MAX_BW_HZ = 6000;

interface TuningOverlayProps {
  centerFreqKHz: number;
  passbandLowHz: number;
  passbandHighHz: number;
  onFrequencyChange?: (freqKHz: number) => void;
  onBandwidthChange?: (lo: number, hi: number) => void;
}

type DragKind = "left" | "right" | "center";

export function TuningOverlay({
  centerFreqKHz,
  passbandLowHz,
  passbandHighHz,
  onFrequencyChange,
  onBandwidthChange,
}: TuningOverlayProps) {
  const startKHz = useBandViewStore((s) => s.startKHz);
  const endKHz = useBandViewStore((s) => s.endKHz);
  const containerRef = useRef<HTMLDivElement>(null);

  const [activeElement, setActiveElement] = useState<DragKind | null>(null);
  const [hoveredElement, setHoveredElement] = useState<DragKind | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const dragRef = useRef<{
    kind: DragKind;
    startX: number;
    origLo: number;
    origHi: number;
    origFreq: number;
  } | null>(null);

  const thickElement = activeElement ?? hoveredElement;
  const mirrorBandwidth = shiftHeld && (activeElement === "left" || activeElement === "right");
  const leftThick = thickElement === "left" || mirrorBandwidth;
  const rightThick = thickElement === "right" || mirrorBandwidth;

  const pxToHz = useCallback(
    (dx: number): number => {
      const el = containerRef.current;
      if (!el) return 0;
      const w = el.getBoundingClientRect().width;
      if (w <= 0) return 0;
      const span = endKHz - startKHz;
      return (dx / w) * span * 1000;
    },
    [startKHz, endKHz]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent, kind: DragKind) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setActiveElement(kind);
      dragRef.current = {
        kind,
        startX: e.clientX,
        origLo: passbandLowHz,
        origHi: passbandHighHz,
        origFreq: centerFreqKHz,
      };
    },
    [passbandLowHz, passbandHighHz, centerFreqKHz]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.stopPropagation();

      setShiftHeld(e.shiftKey);
      const deltaHz = pxToHz(e.clientX - d.startX);

      if (d.kind === "left" && onBandwidthChange) {
        if (e.shiftKey) {
          let newLo = Math.round(d.origLo + deltaHz);
          let newHi = Math.round(d.origHi - deltaHz);
          newLo = Math.max(-MAX_BW_HZ, Math.min(newLo, newHi - 100));
          newHi = Math.min(MAX_BW_HZ, Math.max(newHi, newLo + 100));
          onBandwidthChange(newLo, newHi);
        } else {
          let newLo = Math.round(d.origLo + deltaHz);
          newLo = Math.max(-MAX_BW_HZ, Math.min(newLo, d.origHi - 100));
          onBandwidthChange(newLo, d.origHi);
        }
      } else if (d.kind === "right" && onBandwidthChange) {
        if (e.shiftKey) {
          let newLo = Math.round(d.origLo - deltaHz);
          let newHi = Math.round(d.origHi + deltaHz);
          newLo = Math.max(-MAX_BW_HZ, Math.min(newLo, newHi - 100));
          newHi = Math.min(MAX_BW_HZ, Math.max(newHi, newLo + 100));
          onBandwidthChange(newLo, newHi);
        } else {
          let newHi = Math.round(d.origHi + deltaHz);
          newHi = Math.min(MAX_BW_HZ, Math.max(newHi, d.origLo + 100));
          onBandwidthChange(d.origLo, newHi);
        }
      } else if (d.kind === "center" && onFrequencyChange) {
        const deltaKHz = deltaHz / 1000;
        onFrequencyChange(
          Math.round((d.origFreq + deltaKHz) * 100) / 100
        );
      }
    },
    [pxToHz, onBandwidthChange, onFrequencyChange]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = null;
    setActiveElement(null);
    setShiftHeld(false);
  }, []);

  const span = endKHz - startKHz;
  if (span <= 0) return null;

  const lowKHz = centerFreqKHz + passbandLowHz / 1000;
  const highKHz = centerFreqKHz + passbandHighHz / 1000;

  const leftPct = ((lowKHz - startKHz) / span) * 100;
  const rightPct = ((highKHz - startKHz) / span) * 100;
  const centerPct = ((centerFreqKHz - startKHz) / span) * 100;

  const tuning = useThemeStore((s) => s.theme.tuning);

  const visible = rightPct > 0 && leftPct < 100;
  if (!visible) return null;

  return (
    <div ref={containerRef} className="absolute inset-0 z-30 pointer-events-none">
      {/* Passband group: fill + handles */}
      <div
        className="absolute inset-y-0 pointer-events-auto"
        style={{
          left: `${Math.max(0, leftPct)}%`,
          right: `${Math.max(0, 100 - rightPct)}%`,
        }}
      >
        {/* Passband fill */}
        <div
          className="absolute inset-0 pointer-events-none transition-[border-width] duration-150"
          style={{
            backgroundColor: tuning.passbandFill,
            borderLeft: `${leftThick ? 3 : 1}px solid ${tuning.passbandBorder}`,
            borderRight: `${rightThick ? 3 : 1}px solid ${tuning.passbandBorder}`,
          }}
        />
        {/* Left edge drag handle */}
        <div
          className="absolute inset-y-0 cursor-ew-resize"
          style={{
            left: 0,
            width: HANDLE_PX,
            transform: "translateX(-50%)",
          }}
          onMouseEnter={() => setHoveredElement("left")}
          onMouseLeave={() => setHoveredElement(null)}
          onPointerDown={(e) => onPointerDown(e, "left")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* Right edge drag handle */}
        <div
          className="absolute inset-y-0 cursor-ew-resize"
          style={{
            right: 0,
            left: "auto",
            width: HANDLE_PX,
            transform: "translateX(50%)",
          }}
          onMouseEnter={() => setHoveredElement("right")}
          onMouseLeave={() => setHoveredElement(null)}
          onPointerDown={(e) => onPointerDown(e, "right")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* Center drag handle */}
        {centerPct >= 0 && centerPct <= 100 && leftPct < centerPct && centerPct < rightPct && (
          <div
            className="absolute inset-y-0 cursor-grab active:cursor-grabbing"
            style={{
              left: `${((centerPct - leftPct) / (rightPct - leftPct)) * 100}%`,
              width: HANDLE_PX,
              transform: "translateX(-50%)",
            }}
            onMouseEnter={() => setHoveredElement("center")}
            onMouseLeave={() => setHoveredElement(null)}
            onPointerDown={(e) => onPointerDown(e, "center")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        )}
      </div>
      {/* Center frequency line */}
      {centerPct >= 0 && centerPct <= 100 && (
        <div
          className="absolute inset-y-0 pointer-events-none transition-[width] duration-150"
          style={{
            left: `${centerPct}%`,
            width: thickElement === "center" ? 3 : 1,
            transform: "translateX(-50%)",
            backgroundColor: tuning.centerLine,
          }}
        />
      )}
    </div>
  );
}
