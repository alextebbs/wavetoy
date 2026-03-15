import type { Source } from "@/lib/api";
import { StarIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { SourceDetailsPanel } from "./source-details-panel";
import { SourceMiniMap } from "./source-mini-map";

interface SourceSectionProps {
  source: Source | null;
  sourceId: string;
  action?: ReactNode;
  isFavorite?: boolean;
  onToggleFavorite?: (sourceId: string) => void;
}

export function SourceSection({
  source,
  sourceId,
  action,
  isFavorite,
  onToggleFavorite,
}: SourceSectionProps) {
  return (
    <section className="min-w-0">
      <div className="relative">
        <SourceMiniMap source={source} className="h-80 w-full" />
        {(action || (source && onToggleFavorite)) && (
          <div className="absolute right-2 top-2 flex gap-1">
            {source && onToggleFavorite && (
              <Tooltip content={isFavorite ? "Remove from favorites" : "Add to favorites"}>
                <Button
                  variant={isFavorite ? "outline" : "ghost"}
                  size="icon-sm"
                  onClick={() => onToggleFavorite(source.id)}
                  aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                >
                  <StarIcon
                    className="size-3.5"
                    fill={isFavorite ? "currentColor" : "none"}
                  />
                </Button>
              </Tooltip>
            )}
            {action}
          </div>
        )}
      </div>
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
              className="font-xanh-mono min-w-0 truncate text-base text-foreground hover:text-primary transition-colors block"
              title={`${source.host}:${source.port}`}
            >
              {source.host}:{source.port}
            </a>
          ) : (
            <span className="font-xanh-mono text-base text-muted-foreground">
              —
            </span>
          )}
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
