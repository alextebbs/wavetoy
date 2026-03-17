import type { FilterConfig } from "@/lib/api";
import { PowerIcon } from "lucide-react";
import type { RefObject } from "react";
import { AudioWaveform } from "./audio-waveform";
import { PostProcessingPanel } from "./post-processing-panel";

interface FiltersSectionProps {
  filters: FilterConfig;
  onFiltersChange: (filters: FilterConfig) => void;
  samplesRef: RefObject<Float32Array>;
}

function hasAnyFilterEnabled(filters: FilterConfig): boolean {
  const checks = [
    filters.noise_blanker?.enabled,
    filters.high_pass?.enabled,
    filters.notch?.enabled,
    filters.autonotch?.enabled,
    filters.noise_reducer?.enabled,
    filters.noise_gate?.enabled,
    filters.low_pass?.enabled,
    filters.soft_clipper?.enabled,
  ];
  return checks.some(Boolean);
}

export function FiltersSection({
  filters,
  onFiltersChange,
  samplesRef,
}: FiltersSectionProps) {
  const bypassed = filters.bypassed ?? false;
  const anyEnabled = hasAnyFilterEnabled(filters);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <AudioWaveform samplesRef={samplesRef} height={120} />
        <PostProcessingPanel
          filters={filters}
          onFiltersChange={onFiltersChange}
          samplesRef={samplesRef}
          disabled={bypassed}
        />
      </div>
      {anyEnabled && (
        <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {bypassed ? "Filters disabled" : "Filters active"}
          </span>
          <button
            type="button"
            onClick={() => onFiltersChange({ ...filters, bypassed: !bypassed })}
            className={
              "flex h-6 items-center gap-1.5 rounded px-2 text-[10px] font-medium uppercase tracking-wider transition-colors " +
              (bypassed
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "bg-muted/60 text-muted-foreground hover:bg-muted")
            }
          >
            <PowerIcon className="h-3 w-3" />
            {bypassed ? "Enable filters" : "Disable filters"}
          </button>
        </div>
      )}
    </section>
  );
}
