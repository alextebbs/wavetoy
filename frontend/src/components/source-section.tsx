import type { Source } from "@/lib/api";
import type { ReactNode } from "react";
import { SourceDetailsPanel } from "./source-details-panel";
import { SourceMiniMap } from "./source-mini-map";

interface SourceSectionProps {
  source: Source | null;
  sourceId: string;
  action?: ReactNode;
}

export function SourceSection({
  source,
  sourceId,
  action,
}: SourceSectionProps) {
  return (
    <section className="min-w-0">
      <SourceMiniMap source={source} className="h-80 w-full" />
      <div className="relative z-10 -mt-16 px-3 pb-3">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-t from-background to-transparent"
          aria-hidden
        />
        <div className="relative pt-4">
          <div className="flex items-baseline justify-between gap-2">
            {source ? (
              <a
                href={`http${source.use_tls ? "s" : ""}://${source.host}:${source.port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-xanh-mono min-w-0 truncate text-base text-foreground hover:text-primary transition-colors"
                title={`${source.host}:${source.port}`}
              >
                {source.host}:{source.port}
              </a>
            ) : (
              <span className="font-xanh-mono text-base text-muted-foreground">
                —
              </span>
            )}
            {action}
          </div>
          <p
            className="mt-1 min-w-0 truncate text-xs text-muted-foreground"
            title={source?.name}
          >
            {source?.name ?? "—"}
          </p>
          <SourceDetailsPanel
            source={source}
            selectedSourceId={sourceId}
            hideHostname
            hideSourceName
            className="mt-3"
          />
        </div>
      </div>
    </section>
  );
}
