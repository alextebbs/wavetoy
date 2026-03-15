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
    <section>
      <AudioWaveform samplesRef={samplesRef} height={120} />
      <PostProcessingPanel
        filters={filters}
        onFiltersChange={onFiltersChange}
        samplesRef={samplesRef}
      />
    </section>
  );
}
