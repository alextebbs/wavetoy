import type { MapSourceCounts, Source } from "@/lib/api";
import { cn } from "@/lib/utils";

type SourceDetailsPanelProps = {
  source: Source | null;
  selectedSourceId?: string;
  counts?: MapSourceCounts;
  showPickerSummary?: boolean;
  className?: string;
};

export function SourceDetailsPanel({
  source,
  selectedSourceId,
  counts,
  showPickerSummary = false,
  className,
}: SourceDetailsPanelProps) {
  return (
    <div className={cn("space-y-3 text-xs text-muted-foreground", className)}>
      {showPickerSummary ? (
        <div className="flex items-center justify-between border-b border-border/80 pb-2 text-xs uppercase tracking-widest text-muted-foreground">
          <span>Pick Source</span>
          <span className="font-xanh-mono normal-case tracking-normal">
            {counts?.included ?? 0}/{counts?.omitted ?? 0} shown/omitted
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {source?.name ?? "Hover or click a source"}
        </p>
        {source ? (
          <>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">url</span>
              <span
                className="font-xanh-mono min-w-0 flex-1 truncate text-right text-sm text-white"
                title={`${source.host}:${source.port}`}
              >
                {source.host}:{source.port}
              </span>
            </div>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">users</span>
              <span className="min-w-0 flex-1 truncate text-right text-white">
                <span className="font-xanh-mono">{source.users}</span>/
                <span className="font-xanh-mono">{source.max_listeners}</span>
              </span>
            </div>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">
                status
              </span>
              <span
                className="min-w-0 flex-1 truncate text-right text-white"
                title={source.status ?? "n/a"}
              >
                {source.status ?? "n/a"}
              </span>
            </div>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">
                snr dbm
              </span>
              <span className="min-w-0 flex-1 truncate text-right font-xanh-mono text-white">
                {source.snr_dbm ?? "n/a"}
              </span>
            </div>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">grid</span>
              <span
                className="min-w-0 flex-1 truncate text-right text-white"
                title={source.grid ?? "n/a"}
              >
                {source.grid ?? "n/a"}
              </span>
            </div>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">
                location
              </span>
              <span
                className="min-w-0 flex-1 truncate text-right text-white"
                title={source.location ?? "n/a"}
              >
                {source.location ?? "n/a"}
              </span>
            </div>
            <div className="flex items-start gap-4">
              <span className="w-20 shrink-0 text-muted-foreground">
                antenna
              </span>
              <span
                className="min-w-0 flex-1 truncate text-right text-white"
                title={source.antenna ?? "n/a"}
              >
                {source.antenna ?? "n/a"}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
