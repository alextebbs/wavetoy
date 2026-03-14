import type { FilterConfig } from "@/lib/api";
import type { RefObject } from "react";
import { AudioWaveform } from "./audio-waveform";
import { PostProcessingPanel } from "./post-processing-panel";

interface FiltersSectionProps {
  filters: FilterConfig;
  onFiltersChange: (filters: FilterConfig) => void;
  samplesRef: RefObject<Float32Array>;
}

export function FiltersSection({
  filters,
  onFiltersChange,
  samplesRef,
}: FiltersSectionProps) {
  return (
    <section className="border-b">
      <AudioWaveform samplesRef={samplesRef} height={56} />
      <div className="px-3 pb-3 pt-2">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Post-Processing
        </h3>
        <PostProcessingPanel
          filters={filters}
          onFiltersChange={onFiltersChange}
          samplesRef={samplesRef}
        />
      </div>
    </section>
  );
}
