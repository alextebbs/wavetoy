import type { MapSourceCounts, Source } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SearchIcon, StickyNoteIcon, StarIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "./ui/button";

type SourceSearchPanelProps = {
  sources: Source[];
  favoriteSources: Source[];
  favoriteIds: Set<string>;
  counts?: MapSourceCounts;
  selectedSourceId?: string;
  notesBySourceId?: Map<string, string>;
  onSelectSource: (source: Source) => void;
  onFlyTo?: (source: Source) => void;
};

const MAX_RESULTS = 100;

export function SourceSearchPanel({
  sources,
  favoriteSources,
  favoriteIds,
  counts,
  selectedSourceId,
  notesBySourceId,
  onSelectSource,
  onFlyTo,
}: SourceSearchPanelProps) {
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    let list = favoritesOnly ? favoriteSources : sources;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.name?.toLowerCase().includes(q) ||
          s.host.toLowerCase().includes(q) ||
          s.location?.toLowerCase().includes(q) ||
          s.grid?.toLowerCase().includes(q) ||
          s.antenna?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [sources, favoriteSources, favoritesOnly, query]);

  const capped = filtered.slice(0, MAX_RESULTS);

  return (
    <div className="flex h-full flex-col">
      {/* Star + search bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/80 p-2">
        <Button
          variant={favoritesOnly ? "outline" : "ghost"}
          size="icon"
          className="size-8"
          onClick={() => setFavoritesOnly((v) => !v)}
          aria-label={favoritesOnly ? "Show all sources" : "Show favorites only"}
        >
          <StarIcon className="size-3.5" fill={favoritesOnly ? "currentColor" : "none"} />
        </Button>
        <div className="relative flex-1">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SEARCH"
            className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 text-xs uppercase tracking-widest text-foreground placeholder:text-muted-foreground placeholder:uppercase placeholder:tracking-widest focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Source list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {capped.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4">
            <p className="text-center text-xs text-muted-foreground">
              {favoritesOnly && !query.trim()
                ? "No favorites yet — star a source to add it here."
                : "No sources match your search."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {capped.map((source) => {
              const isSelected = source.id === selectedSourceId;
              const isFav = favoriteIds.has(source.id);
              const note = notesBySourceId?.get(source.id);
              return (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => {
                    onSelectSource(source);
                    onFlyTo?.(source);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-foreground/5",
                    isSelected && "bg-foreground/10",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-xanh-mono block truncate text-sm text-foreground">
                      {source.host}:{source.port}
                    </p>
                    {source.name && (
                      <p className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {source.name}
                      </p>
                    )}
                    {source.location && (
                      <p className="mt-0.5 block truncate text-[11px] text-muted-foreground/60">
                        {source.location}
                      </p>
                    )}
                    {note && (
                      <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-primary/70">
                        <StickyNoteIcon className="size-2.5 shrink-0" />
                        <span className="truncate">{note}</span>
                      </p>
                    )}
                  </div>
                  {isFav && (
                    <StarIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" fill="currentColor" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer — always visible */}
      <div className="shrink-0 border-t border-border/80 px-3 py-2 text-center">
        <p className="text-[10px] shrink-0 uppercase tracking-widest text-muted-foreground">
          {filtered.length > MAX_RESULTS
            ? `Showing ${MAX_RESULTS} of ${filtered.length} results`
            : `${filtered.length} source${filtered.length !== 1 ? "s" : ""}`}
          {counts && counts.omitted > 0 && ` / ${counts.omitted} omitted`}
        </p>
      </div>
    </div>
  );
}
