import { AutonotchMeter } from "@/components/autonotch-meter";
import { ClipperCurve } from "@/components/clipper-curve";
import { NoiseBlankerMeter } from "@/components/noise-blanker-meter";
import { NoiseGateMeter } from "@/components/noise-gate-meter";
import { NoiseReducerSpectrum } from "@/components/noise-reducer-spectrum";
import { NotchSpectrum } from "@/components/notch-spectrum";
import { PassFilterSpectrum } from "@/components/pass-filter-spectrum";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import type { FilterConfig } from "@/lib/api";
import { useDebounce, CONTROL_THROTTLE_MS } from "@/lib/timing";
import { InfoIcon } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

type Props = {
  filters: FilterConfig;
  onFiltersChange: (filters: FilterConfig) => void;
  samplesRef: RefObject<Float32Array>;
  disabled?: boolean;
};

const DEFAULTS: Required<FilterConfig> = {
  bypassed: false,
  noise_blanker: { enabled: false, threshold: 50 },
  low_pass: { enabled: false, cutoff_hz: 3000 },
  high_pass: { enabled: false, cutoff_hz: 100 },
  notch: { enabled: false, center_hz: 1000, q: 10 },
  autonotch: { enabled: false, strength: 0.5 },
  noise_gate: {
    enabled: false,
    threshold_db: -40,
    hold_ms: 100,
    attack_ms: 5,
    release_ms: 50,
  },
  soft_clipper: { enabled: false, drive_db: 6, ceiling_db: -3 },
  noise_reducer: { enabled: false, strength: 0.5, floor_db: -20 },
};

function merge(filters: FilterConfig): Required<FilterConfig> {
  return {
    bypassed: filters.bypassed ?? false,
    noise_blanker: { ...DEFAULTS.noise_blanker, ...filters.noise_blanker },
    low_pass: { ...DEFAULTS.low_pass, ...filters.low_pass },
    high_pass: { ...DEFAULTS.high_pass, ...filters.high_pass },
    notch: { ...DEFAULTS.notch, ...filters.notch },
    autonotch: { ...DEFAULTS.autonotch, ...filters.autonotch },
    noise_gate: { ...DEFAULTS.noise_gate, ...filters.noise_gate },
    soft_clipper: { ...DEFAULTS.soft_clipper, ...filters.soft_clipper },
    noise_reducer: { ...DEFAULTS.noise_reducer, ...filters.noise_reducer },
  };
}

export function PostProcessingPanel({ filters, onFiltersChange, samplesRef, disabled }: Props) {
  const [local, setLocal] = useState(() => merge(filters));

  useEffect(() => {
    setLocal(merge(filters));
  }, [filters]);

  const emitDebounced = useDebounce((next: Required<FilterConfig>) => {
    onFiltersChange(next);
  }, CONTROL_THROTTLE_MS);

  const push = (next: Required<FilterConfig>) => {
    setLocal(next);
    emitDebounced(next);
  };

  return (
    <div className={disabled ? "border-t border-border/60 opacity-40 pointer-events-none select-none" : "border-t border-border/60"}>
      {/* ── Noise Blanker ── */}
      <FilterSection
        label="Noise Blanker"
        enabled={local.noise_blanker.enabled}
        onToggle={(on) =>
          push({
            ...local,
            noise_blanker: { ...local.noise_blanker, enabled: on },
          })
        }
        tip={
          <FilterTip
            what="Suppresses impulse noise — clicks, pops, static crashes, and ignition interference."
            when="Use when you hear sharp, crackling bursts of noise, especially on HF bands near electrical equipment or thunderstorms."
            how="Compares instantaneous amplitude against a short moving average. When a spike exceeds the threshold ratio, the output is blanked (replaced with silence) for a brief gate period. A delay line ensures blanking starts slightly before the impulse reaches the output."
          />
        }
      >
        <NoiseBlankerMeter
          samplesRef={samplesRef}
          threshold={local.noise_blanker.threshold}
          height={48}
          className="rounded border border-border/40"
        />
        <SliderRow
          label="Sensitivity"
          value={local.noise_blanker.threshold}
          min={5}
          max={95}
          step={5}
          unit=""
          onChange={(v) =>
            push({
              ...local,
              noise_blanker: { ...local.noise_blanker, threshold: v },
            })
          }
        />
      </FilterSection>

      {/* ── High-Pass ── */}
      <FilterSection
        label="High-Pass"
        enabled={local.high_pass.enabled}
        onToggle={(on) =>
          push({ ...local, high_pass: { ...local.high_pass, enabled: on } })
        }
        tip={
          <FilterTip
            what="Removes low-frequency content below the cutoff frequency."
            when="Use to eliminate mains hum (50/60 Hz), DC offset, or low-frequency rumble from the antenna or receiver."
            how="Second-order Butterworth IIR biquad filter with 12 dB/octave rolloff. Coefficients are computed from the Audio EQ Cookbook (Bristow-Johnson). 5 multiply-adds per sample, zero latency."
          />
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
        tip={
          <FilterTip
            what="Removes a narrow frequency band while passing everything else."
            when="Use to kill a specific known interference tone — a heterodyne whistle, birdie, or power-supply whine at a fixed frequency."
            how="Second-order IIR band-reject biquad filter. Q controls the notch width: higher Q = narrower and deeper notch. At Q=10, the notch is a few tens of Hz wide with >20 dB rejection at center."
          />
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
          max={50}
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

      {/* ── Autonotch ── */}
      <FilterSection
        label="Autonotch"
        enabled={local.autonotch.enabled}
        onToggle={(on) =>
          push({
            ...local,
            autonotch: { ...local.autonotch, enabled: on },
          })
        }
        tip={
          <FilterTip
            what="Automatically finds and removes tonal interference without you needing to know the frequency."
            when="Use when you hear whistles, carriers, or birdies but don't know their exact frequency, or when the interference drifts. Unlike the manual notch, this adapts in real time."
            how="Variable-leak LMS (Least Mean Squares) adaptive FIR filter. Learns to predict tonal (repetitive) components of the signal — the prediction is subtracted, leaving only broadband content (voice, noise). Converges within ~100ms. Based on Warren Pratt's WDSP algorithm."
          />
        }
      >
        <AutonotchMeter
          samplesRef={samplesRef}
          strength={local.autonotch.strength}
          height={72}
          className="rounded border border-border/40"
        />
        <SliderRow
          label="Strength"
          value={Math.round(local.autonotch.strength * 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          onChange={(v) =>
            push({
              ...local,
              autonotch: { ...local.autonotch, strength: v / 100 },
            })
          }
        />
      </FilterSection>

      {/* ── Noise Reduction ── */}
      <FilterSection
        label="Noise Reduction"
        enabled={local.noise_reducer.enabled}
        onToggle={(on) =>
          push({
            ...local,
            noise_reducer: { ...local.noise_reducer, enabled: on },
          })
        }
        tip={
          <FilterTip
            what="Reduces broadband background noise (hiss, static) while preserving the signal."
            when="Use on any noisy reception — especially weak HF signals buried in atmospheric or receiver noise. The primary tool for improving intelligibility."
            how="MMSE-STSA (Ephraim-Malah 1984) spectral noise reduction. 512-point FFT with 50% overlap-add. Estimates noise per frequency bin using speech probability tracking, computes optimal gain via the Ephraim-Malah function, and applies decision-directed a priori SNR smoothing. Dynamic frequency averaging reduces musical noise artifacts. Strength controls the smoothing factor; floor sets the minimum gain per bin."
          />
        }
      >
        <NoiseReducerSpectrum
          samplesRef={samplesRef}
          strength={local.noise_reducer.strength}
          floorDb={local.noise_reducer.floor_db}
          height={72}
          className="rounded border border-border/40"
        />
        <SliderRow
          label="Strength"
          value={Math.round(local.noise_reducer.strength * 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          onChange={(v) =>
            push({
              ...local,
              noise_reducer: { ...local.noise_reducer, strength: v / 100 },
            })
          }
        />
        <SliderRow
          label="Floor"
          value={local.noise_reducer.floor_db}
          min={-60}
          max={0}
          step={1}
          unit="dB"
          onChange={(v) =>
            push({
              ...local,
              noise_reducer: { ...local.noise_reducer, floor_db: v },
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
        tip={
          <FilterTip
            what="Removes high-frequency content above the cutoff frequency."
            when="Use to cut high-frequency hiss and noise above the signal of interest. For SSB voice, a cutoff around 2.5–3 kHz removes upper hiss without affecting intelligibility."
            how="Second-order Butterworth IIR biquad filter with 12 dB/octave rolloff. Same structure as the high-pass but with low-pass coefficients. Zero latency, 5 multiply-adds per sample."
          />
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
          max={5500}
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
        tip={
          <FilterTip
            what="Silences the output when signal level drops below a threshold, producing clean silence between transmissions."
            when="Use when monitoring a frequency with intermittent transmissions (repeaters, marine channels). Mutes the background noise during gaps."
            how="Per-sample envelope follower with attack/release smoothing and a hold timer. When signal drops below threshold, the hold timer counts down before the gate closes with a smooth fade-out. This prevents clicky transitions and keeps the gate open during natural speech pauses."
          />
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
          max={2000}
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
          max={1000}
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
        tip={
          <FilterTip
            what="Smoothly compresses loud peaks instead of hard-clipping them, taming sudden volume spikes."
            when="Use when strong nearby stations or static crashes cause jarring volume jumps. Keeps the listening level comfortable without harsh distortion."
            how="Tanh waveshaping curve: output = ceiling * tanh(input * drive / ceiling). Small signals pass linearly; large signals are smoothly compressed toward the ceiling. Drive controls how much gain is applied before the curve; ceiling sets the maximum output level. Same nonlinearity used in analog tube amplifiers."
          />
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
          max={36}
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
          min={-24}
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
  tip,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  tip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border px-3 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {tip && (
            <Tooltip content={tip} rich side="left" align="start">
              <button type="button" className="text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                <InfoIcon className="h-3 w-3" />
              </button>
            </Tooltip>
          )}
          <Label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </Label>
        </div>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>
      {enabled && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  );
}

function FilterTip({ what, when, how }: { what: string; when: string; how: string }) {
  return (
    <div className="space-y-1.5">
      <p>{what}</p>
      <p className="text-muted-foreground">{when}</p>
      <p className="text-muted-foreground/70">{how}</p>
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
