import { useBandViewStore } from "@/lib/band-view-store";

interface TuningOverlayProps {
  centerFreqKHz: number;
  passbandLowHz: number;
  passbandHighHz: number;
}

export function TuningOverlay({
  centerFreqKHz,
  passbandLowHz,
  passbandHighHz,
}: TuningOverlayProps) {
  const startKHz = useBandViewStore((s) => s.startKHz);
  const endKHz = useBandViewStore((s) => s.endKHz);

  const span = endKHz - startKHz;
  if (span <= 0) return null;

  const lowKHz = centerFreqKHz + passbandLowHz / 1000;
  const highKHz = centerFreqKHz + passbandHighHz / 1000;

  const leftPct = ((lowKHz - startKHz) / span) * 100;
  const rightPct = ((highKHz - startKHz) / span) * 100;
  const centerPct = ((centerFreqKHz - startKHz) / span) * 100;

  const visible = rightPct > 0 && leftPct < 100;
  if (!visible) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {/* Passband rectangle */}
      <div
        className="absolute inset-y-0 bg-white/[0.07] border-x border-white/20"
        style={{
          left: `${Math.max(0, leftPct)}%`,
          right: `${Math.max(0, 100 - rightPct)}%`,
        }}
      />
      {/* Center frequency line */}
      {centerPct >= 0 && centerPct <= 100 && (
        <div
          className="absolute inset-y-0 w-px bg-amber-500/50"
          style={{ left: `${centerPct}%` }}
        />
      )}
    </div>
  );
}
