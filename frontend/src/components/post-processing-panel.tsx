import { ClipperCurve } from "@/components/clipper-curve";
import { NoiseGateMeter } from "@/components/noise-gate-meter";
import { NotchSpectrum } from "@/components/notch-spectrum";
import { PassFilterSpectrum } from "@/components/pass-filter-spectrum";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { FilterConfig } from "@/lib/api";
import { useDebounce, CONTROL_THROTTLE_MS } from "@/lib/timing";
import { type RefObject, useEffect, useState } from "react";

type Props = {
  filters: FilterConfig;
  onFiltersChange: (filters: FilterConfig) => void;
  samplesRef: RefObject<Float32Array>;
};

const DEFAULTS: Required<FilterConfig> = {
  low_pass: { enabled: false, cutoff_hz: 3000 },
  high_pass: { enabled: false, cutoff_hz: 100 },
  notch: { enabled: false, center_hz: 1000, q: 10 },
  noise_gate: {
    enabled: false,
    threshold_db: -40,
    hold_ms: 100,
    attack_ms: 5,
    release_ms: 50,
  },
  soft_clipper: { enabled: false, drive_db: 6, ceiling_db: -3 },
};

function merge(filters: FilterConfig): Required<FilterConfig> {
  return {
    low_pass: { ...DEFAULTS.low_pass, ...filters.low_pass },
    high_pass: { ...DEFAULTS.high_pass, ...filters.high_pass },
    notch: { ...DEFAULTS.notch, ...filters.notch },
    noise_gate: { ...DEFAULTS.noise_gate, ...filters.noise_gate },
    soft_clipper: { ...DEFAULTS.soft_clipper, ...filters.soft_clipper },
  };
}

export function PostProcessingPanel({ filters, onFiltersChange, samplesRef }: Props) {
  const [local, setLocal] = useState(() => merge(filters));

  useEffect(() => {
    setLocal(merge(filters));
  }, [filters]);

  const emitDebounced = useDebounce((next: Required<FilterConfig>) => {
    const out: FilterConfig = {};
    if (next.low_pass.enabled) out.low_pass = next.low_pass;
    if (next.high_pass.enabled) out.high_pass = next.high_pass;
    if (next.notch.enabled) out.notch = next.notch;
    if (next.noise_gate.enabled) out.noise_gate = next.noise_gate;
    if (next.soft_clipper.enabled) out.soft_clipper = next.soft_clipper;
    onFiltersChange(out);
  }, CONTROL_THROTTLE_MS);

  const push = (next: Required<FilterConfig>) => {
    setLocal(next);
    emitDebounced(next);
  };

  return (
    <div className="border-t border-border/60">
      {/* ── High-Pass ── */}
      <FilterSection
        label="High-Pass"
        enabled={local.high_pass.enabled}
        onToggle={(on) =>
          push({ ...local, high_pass: { ...local.high_pass, enabled: on } })
        }
      >
        <PassFilterSpectrum
          samplesRef={samplesRef}
          type="high-pass"
          cutoffHz={local.high_pass.cutoff_hz}
          height={72}
          className="rounded border border-border/40"
          onCutoffChange={(hz) =>
            push({
              ...local,
              high_pass: { ...local.high_pass, cutoff_hz: hz },
            })
          }
        />
        <SliderRow
          label="Cutoff"
          value={local.high_pass.cutoff_hz}
          min={20}
          max={1000}
          step={10}
          unit="Hz"
          onChange={(v) =>
            push({
              ...local,
              high_pass: { ...local.high_pass, cutoff_hz: v },
            })
          }
        />
      </FilterSection>

      {/* ── Notch Filter ── */}
      <FilterSection
        label="Notch Filter"
        enabled={local.notch.enabled}
        onToggle={(on) =>
          push({ ...local, notch: { ...local.notch, enabled: on } })
        }
      >
        <NotchSpectrum
          samplesRef={samplesRef}
          centerHz={local.notch.center_hz}
          q={local.notch.q}
          height={72}
          className="rounded border border-border/40"
          onCenterChange={(hz) =>
            push({
              ...local,
              notch: { ...local.notch, center_hz: hz },
            })
          }
        />
        <SliderRow
          label="Frequency"
          value={local.notch.center_hz}
          min={50}
          max={5900}
          step={10}
          unit="Hz"
          onChange={(v) =>
            push({
              ...local,
              notch: { ...local.notch, center_hz: v },
            })
          }
        />
        <SliderRow
          label="Q (sharpness)"
          value={local.notch.q}
          min={1}
          max={30}
          step={0.5}
          unit=""
          onChange={(v) =>
            push({
              ...local,
              notch: { ...local.notch, q: v },
            })
          }
        />
      </FilterSection>

      {/* ── Low-Pass ── */}
      <FilterSection
        label="Low-Pass"
        enabled={local.low_pass.enabled}
        onToggle={(on) =>
          push({ ...local, low_pass: { ...local.low_pass, enabled: on } })
        }
      >
        <PassFilterSpectrum
          samplesRef={samplesRef}
          type="low-pass"
          cutoffHz={local.low_pass.cutoff_hz}
          height={72}
          className="rounded border border-border/40"
          onCutoffChange={(hz) =>
            push({
              ...local,
              low_pass: { ...local.low_pass, cutoff_hz: hz },
            })
          }
        />
        <SliderRow
          label="Cutoff"
          value={local.low_pass.cutoff_hz}
          min={500}
          max={3000}
          step={50}
          unit="Hz"
          onChange={(v) =>
            push({
              ...local,
              low_pass: { ...local.low_pass, cutoff_hz: v },
            })
          }
        />
      </FilterSection>

      {/* ── Noise Gate ── */}
      <FilterSection
        label="Noise Gate"
        enabled={local.noise_gate.enabled}
        onToggle={(on) =>
          push({
            ...local,
            noise_gate: { ...local.noise_gate, enabled: on },
          })
        }
      >
        <NoiseGateMeter
          samplesRef={samplesRef}
          thresholdDb={local.noise_gate.threshold_db}
          height={32}
          className="rounded border border-border/40"
        />
        <SliderRow
          label="Threshold"
          value={local.noise_gate.threshold_db}
          min={-80}
          max={0}
          step={1}
          unit="dB"
          onChange={(v) =>
            push({
              ...local,
              noise_gate: { ...local.noise_gate, threshold_db: v },
            })
          }
        />
        <SliderRow
          label="Hold"
          value={local.noise_gate.hold_ms}
          min={0}
          max={500}
          step={10}
          unit="ms"
          onChange={(v) =>
            push({
              ...local,
              noise_gate: { ...local.noise_gate, hold_ms: v },
            })
          }
        />
        <SliderRow
          label="Release"
          value={local.noise_gate.release_ms}
          min={5}
          max={500}
          step={5}
          unit="ms"
          onChange={(v) =>
            push({
              ...local,
              noise_gate: { ...local.noise_gate, release_ms: v },
            })
          }
        />
      </FilterSection>

      {/* ── Soft Clipper ── */}
      <FilterSection
        label="Soft Clipper"
        enabled={local.soft_clipper.enabled}
        onToggle={(on) =>
          push({
            ...local,
            soft_clipper: { ...local.soft_clipper, enabled: on },
          })
        }
      >
        <ClipperCurve
          driveDb={local.soft_clipper.drive_db}
          ceilingDb={local.soft_clipper.ceiling_db}
          height={72}
          className="rounded border border-border/40"
        />
        <SliderRow
          label="Drive"
          value={local.soft_clipper.drive_db}
          min={0}
          max={24}
          step={1}
          unit="dB"
          onChange={(v) =>
            push({
              ...local,
              soft_clipper: { ...local.soft_clipper, drive_db: v },
            })
          }
        />
        <SliderRow
          label="Ceiling"
          value={local.soft_clipper.ceiling_db}
          min={-12}
          max={0}
          step={1}
          unit="dB"
          onChange={(v) =>
            push({
              ...local,
              soft_clipper: { ...local.soft_clipper, ceiling_db: v },
            })
          }
        />
      </FilterSection>
    </div>
  );
}

function FilterSection({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60 px-3 py-4">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </Label>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>
      {enabled && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs uppercase tracking-widest text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {value} {unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}
