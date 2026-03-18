// Center-lock rendering & animation: see planning/CONFLICTS.md
import { useCallback, useRef, useState } from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { useThemeStore } from "@/lib/theme";

const HANDLE_PX = 8;
const MAX_BW_HZ = 6000;

interface TuningOverlayProps {
  centerFreqKHz: number;
  passbandLowHz: number;
  passbandHighHz: number;
  centerLocked?: boolean;
  animate?: boolean;
  onFrequencyChange?: (freqKHz: number) => void;
  onBandwidthChange?: (lo: number, hi: number) => void;
}

type DragKind = "left" | "right" | "center";

const SLIDE_TRANSITION = "left 200ms ease-out, right 200ms ease-out";

export function TuningOverlay({
  centerFreqKHz,
  passbandLowHz,
  passbandHighHz,
  centerLocked,
  animate,
  onFrequencyChange,
  onBandwidthChange,
}: TuningOverlayProps) {
  const startKHz = useBandViewStore((s) => s.startKHz);
  const endKHz = useBandViewStore((s) => s.endKHz);
  const containerRef = useRef<HTMLDivElement>(null);

  const [activeElement, setActiveElement] = useState<DragKind | null>(null);
  const [hoveredElement, setHoveredElement] = useState<DragKind | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);

  const [localFreq, setLocalFreq] = useState<number | null>(null);
  const [localLo, setLocalLo] = useState<number | null>(null);
  const [localHi, setLocalHi] = useState<number | null>(null);

  const dragRef = useRef<{
    kind: DragKind;
    startX: number;
    origLo: number;
    origHi: number;
    origFreq: number;
  } | null>(null);

  const isDragging = dragRef.current !== null;
  const effectiveFreq = isDragging && localFreq !== null ? localFreq : centerFreqKHz;
  const effectiveLo = isDragging && localLo !== null ? localLo : passbandLowHz;
  const effectiveHi = isDragging && localHi !== null ? localHi : passbandHighHz;

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
      setLocalFreq(centerFreqKHz);
      setLocalLo(passbandLowHz);
      setLocalHi(passbandHighHz);
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
          const raw = Math.round(d.origLo + deltaHz);
          const abs = Math.min(MAX_BW_HZ, Math.max(50, Math.abs(raw)));
          setLocalLo(-abs);
          setLocalHi(abs);
          onBandwidthChange(-abs, abs);
        } else {
          let newLo = Math.round(d.origLo + deltaHz);
          newLo = Math.max(-MAX_BW_HZ, Math.min(newLo, d.origHi - 100));
          setLocalLo(newLo);
          onBandwidthChange(newLo, d.origHi);
        }
      } else if (d.kind === "right" && onBandwidthChange) {
        if (e.shiftKey) {
          const raw = Math.round(d.origHi + deltaHz);
          const abs = Math.min(MAX_BW_HZ, Math.max(50, Math.abs(raw)));
          setLocalLo(-abs);
          setLocalHi(abs);
          onBandwidthChange(-abs, abs);
        } else {
          let newHi = Math.round(d.origHi + deltaHz);
          newHi = Math.min(MAX_BW_HZ, Math.max(newHi, d.origLo + 100));
          setLocalHi(newHi);
          onBandwidthChange(d.origLo, newHi);
        }
      } else if (d.kind === "center" && onFrequencyChange) {
        const deltaKHz = deltaHz / 1000;
        const newFreq = Math.round((d.origFreq + deltaKHz) * 100) / 100;
        setLocalFreq(newFreq);
        onFrequencyChange(newFreq);
      }
    },
    [pxToHz, onBandwidthChange, onFrequencyChange]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = null;
    setActiveElement(null);
    setShiftHeld(false);
    setLocalFreq(null);
    setLocalLo(null);
    setLocalHi(null);
  }, []);

  const span = endKHz - startKHz;
  if (span <= 0) return null;

  let leftPct: number;
  let rightPct: number;
  let centerPct: number;

  if (centerLocked) {
    centerPct = 50;
    leftPct = 50 + ((effectiveLo / 1000) / span) * 100;
    rightPct = 50 + ((effectiveHi / 1000) / span) * 100;
  } else {
    const lowKHz = effectiveFreq + effectiveLo / 1000;
    const highKHz = effectiveFreq + effectiveHi / 1000;
    leftPct = ((lowKHz - startKHz) / span) * 100;
    rightPct = ((highKHz - startKHz) / span) * 100;
    centerPct = ((effectiveFreq - startKHz) / span) * 100;
  }

  const tuning = useThemeStore((s) => s.theme.tuning);

  const visible = rightPct > 0 && leftPct < 100;
  if (!visible) return null;

  return (
    <div ref={containerRef} className="absolute inset-0 z-30 pointer-events-none">
      {/* Passband group: fill + edge handles */}
      <div
        className={`absolute inset-y-0 ${onFrequencyChange ? "pointer-events-auto" : ""}`}
        style={{
          left: `${Math.max(0, leftPct)}%`,
          right: `${Math.max(0, 100 - rightPct)}%`,
          transition: animate && !isDragging ? SLIDE_TRANSITION : "none",
        }}
      >
        {/* Passband fill — drag to retune */}
        <div
          className={`absolute inset-0 transition-[border-width] duration-150 ${onFrequencyChange ? "cursor-grab active:cursor-grabbing" : ""}`}
          style={{
            backgroundColor: tuning.passbandFill,
            borderLeft: `${leftThick ? 3 : 1}px solid ${tuning.passbandBorder}`,
            borderRight: `${rightThick ? 3 : 1}px solid ${tuning.passbandBorder}`,
          }}
          onMouseEnter={() => onFrequencyChange && setHoveredElement("center")}
          onMouseLeave={() => onFrequencyChange && setHoveredElement(null)}
          onPointerDown={(e) => onPointerDown(e, "center")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* Left edge drag handle */}
        <div
          className="absolute inset-y-0 pointer-events-auto cursor-ew-resize"
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
          className="absolute inset-y-0 pointer-events-auto cursor-ew-resize"
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
      </div>
      {/* Center frequency line + drag handle (independent of passband bounds) */}
      {centerPct >= 0 && centerPct <= 100 && (
        <>
          <div
            className="absolute inset-y-0 z-10 pointer-events-none"
            style={{
              left: `${centerPct}%`,
              width: thickElement === "center" ? 3 : 1,
              transform: "translateX(-50%)",
              backgroundColor: tuning.centerLine,
              transition: animate && !isDragging
                ? "left 200ms ease-out, width 150ms"
                : "width 150ms",
            }}
          />
          <div
            className={`absolute inset-y-0 z-10 ${onFrequencyChange ? "pointer-events-auto cursor-grab active:cursor-grabbing" : ""}`}
            style={{
              left: `${centerPct}%`,
              width: HANDLE_PX,
              transform: "translateX(-50%)",
            }}
            onMouseEnter={() => onFrequencyChange && setHoveredElement("center")}
            onMouseLeave={() => onFrequencyChange && setHoveredElement(null)}
            onPointerDown={(e) => onPointerDown(e, "center")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </>
      )}
    </div>
  );
}
