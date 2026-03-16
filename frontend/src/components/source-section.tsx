import { getSourceStatus, type Source } from "@/lib/api";
import { InfoIcon, Loader2Icon, StarIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
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
  const [statusText, setStatusText] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!source) return;
    setStatusLoading(true);
    setStatusOpen(true);
    try {
      const raw = await getSourceStatus(source.id);
      setStatusText(raw);
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : "Failed to fetch status");
    } finally {
      setStatusLoading(false);
    }
  }, [source]);

  return (
    <section className="min-w-0">
      <div className="relative">
        <SourceMiniMap source={source} className="h-80 w-full" />
        {(action || (source && onToggleFavorite)) && (
          <div className="absolute right-2 top-2 flex gap-1">
            {source && (
              <Tooltip content="Source status">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void fetchStatus()}
                  disabled={statusLoading}
                  aria-label="Source status"
                >
                  {statusLoading ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <InfoIcon className="size-3.5" />
                  )}
                </Button>
              </Tooltip>
            )}
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

      {statusOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setStatusOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setStatusOpen(false);
          }}
        >
          <div className="mx-4 max-h-[80vh] w-full max-w-lg overflow-hidden rounded-lg border bg-background shadow-lg">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Source Status
              </h3>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setStatusOpen(false)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
            <div className="overflow-auto p-4" style={{ maxHeight: "calc(80vh - 52px)" }}>
              {statusLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
                  {statusText}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
