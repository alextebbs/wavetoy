import type { MapSourceCounts, Source } from "@/lib/api";
import { cn } from "@/lib/utils";

type SourceDetailsPanelProps = {
  source: Source | null;
  selectedSourceId?: string;
  counts?: MapSourceCounts;
  showPickerSummary?: boolean;
  hideHostname?: boolean;
  hideSourceName?: boolean;
  className?: string;
};

export function SourceDetailsPanel({
  source,
  selectedSourceId,
  counts,
  showPickerSummary = false,
  hideHostname = false,
  hideSourceName = false,
  className,
}: SourceDetailsPanelProps) {
  return (
    <div className={cn("space-y-3 text-xs text-muted-foreground", className)}>
      {showPickerSummary ? (
        <div className="flex items-center justify-between border-b border-border/80 pb-2 text-xs uppercase tracking-widest text-muted-foreground">
          <span>Pick Source</span>
          <span className="normal-case tracking-normal">
            {counts?.included ?? 0}/{counts?.omitted ?? 0} shown/omitted
          </span>
        </div>
      ) : null}

      <div className="min-w-0 space-y-1">
        {source ? (
          <>
            {!hideHostname && (
              <a
                href={`http${source.use_tls ? "s" : ""}://${source.host}:${source.port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-sm uppercase text-foreground hover:text-primary transition-colors"
                title={`${source.host}:${source.port}`}
              >
                {source.host}:{source.port}
              </a>
            )}
            {!hideSourceName && (
              <p className="truncate text-muted-foreground" title={source.name}>
                {source.name}
              </p>
            )}
            <div className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5">
              <span className="shrink-0 uppercase tracking-widest text-muted-foreground">users</span>
              <span className="min-w-0 truncate text-right text-white" title={`${source.users}/${source.max_listeners}`}>
                {source.users}/{source.max_listeners}
              </span>
              <span className="shrink-0 uppercase tracking-widest text-muted-foreground">status</span>
              <span className="min-w-0 truncate text-right text-white" title={source.status ?? "n/a"}>
                {source.status ?? "n/a"}
              </span>
              <span className="shrink-0 uppercase tracking-widest text-muted-foreground">snr dbm</span>
              <span className="min-w-0 truncate text-right text-white" title={String(source.snr_dbm ?? "n/a")}>
                {source.snr_dbm ?? "n/a"}
              </span>
              <span className="shrink-0 uppercase tracking-widest text-muted-foreground">grid</span>
              <span className="min-w-0 truncate text-right text-white" title={source.grid ?? "n/a"}>
                {source.grid ?? "n/a"}
              </span>
              <span className="shrink-0 uppercase tracking-widest text-muted-foreground">location</span>
              <span className="min-w-0 truncate text-right text-white" title={source.location ?? "n/a"}>
                {source.location ?? "n/a"}
              </span>
              <span className="shrink-0 uppercase tracking-widest text-muted-foreground">antenna</span>
              <span className="min-w-0 truncate text-right text-white" title={source.antenna ?? "n/a"}>
                {source.antenna ?? "n/a"}
              </span>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">Hover or click a source</p>
        )}
      </div>
    </div>
  );
}
