import type { Source } from "@/lib/api";
import { SourceDetailsPanel } from "./source-details-panel";
import { SourceMiniMap } from "./source-mini-map";
import { Button } from "./ui/button";
import { RefreshCwIcon } from "lucide-react";

interface SourceSectionProps {
  source: Source | null;
  sourceId: string;
  onChangeSource: () => void;
}

export function SourceSection({
  source,
  sourceId,
  onChangeSource,
}: SourceSectionProps) {
  return (
    <section className="min-w-0 border-b">
      <SourceMiniMap source={source} className="h-56 w-full" />
      <div className="relative z-10 -mt-16 px-3 pb-3">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-t from-background to-transparent"
          aria-hidden
        />
        <div className="relative pt-4">
          {source ? (
            <a
              href={`http${source.use_tls ? "s" : ""}://${source.host}:${source.port}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-xanh-mono block truncate text-base text-foreground hover:text-primary transition-colors"
              title={`${source.host}:${source.port}`}
            >
              {source.host}:{source.port}
            </a>
          ) : (
            <span className="font-xanh-mono text-base text-muted-foreground">
              —
            </span>
          )}
          <div className="mt-1 flex items-center justify-between gap-2">
            <p
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={source?.name}
            >
              {source?.name ?? "—"}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              onClick={onChangeSource}
            >
              <RefreshCwIcon className="size-3" />
            </Button>
          </div>
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
