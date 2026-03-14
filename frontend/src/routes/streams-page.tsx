import { SourceDetailsPanel } from "@/components/source-details-panel";
import { SourceMapPicker } from "@/components/source-map-picker";
import { BottomDrawer } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type MapSourceCounts,
  type Source,
  type Stream,
  createStream,
  getMapSources,
  listStreams,
} from "@/lib/api";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function StreamsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [error, setError] = useState("");

  const [name, setName] = useState("Group Stream");
  const [creating, setCreating] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [mapSources, setMapSources] = useState<Source[]>([]);
  const [mapCounts, setMapCounts] = useState<MapSourceCounts>({
    total: 0,
    included: 0,
    omitted: 0,
  });
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const [hoveredSource, setHoveredSource] = useState<Source | null>(null);

  const refreshStreams = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStreams(await listStreams());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMapSources = useCallback(async () => {
    setMapLoading(true);
    setError("");
    try {
      const payload = await getMapSources();
      setMapSources(payload.included_sources);
      setMapCounts(payload.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMapLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStreams();
    void refreshMapSources();
  }, [refreshStreams, refreshMapSources]);

  const openCreateDrawer = () => {
    setSelectedSource(null);
    setHoveredSource(null);
    setCreateDrawerOpen(true);
    if (mapSources.length === 0 && !mapLoading) {
      void refreshMapSources();
    }
  };

  const onCreate = async () => {
    if (!selectedSource || !name.trim()) return;
    setCreating(true);
    setError("");
    try {
      const created = await createStream({
        source_id: selectedSource.id,
        frequency_khz: 10000,
        mode: "am",
        name: name.trim(),
        bandwidth_low_hz: -5000,
        bandwidth_high_hz: 5000,
      });
      await navigate({
        to: "/streams/$streamId",
        params: { streamId: created.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const displayedSource = hoveredSource ?? selectedSource;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <h1 className="font-xanh-mono text-3xl leading-none lowercase">
          wavetoy
        </h1>
        <Button type="button" variant="ghost" onClick={openCreateDrawer}>
          <PlusIcon className="size-4" />
        </Button>
      </div>

      <div className="border-t border-zinc-500/60" />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section className="space-y-2">
        {(loading ? [] : streams).length === 0 ? (
          <p className="font-xanh-mono py-10 text-center text-sm text-zinc-500">
            no streams :(
          </p>
        ) : (
          streams.map((stream) => (
            <Link
              key={stream.id}
              to="/streams/$streamId"
              params={{ streamId: stream.id }}
              className="block border-b py-3 transition-colors hover:bg-muted/20"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="font-medium">{stream.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {stream.frequency_khz} kHz {stream.mode} [
                    {stream.bandwidth_low_hz}, {stream.bandwidth_high_hz}]
                  </p>
                  <p className="text-xs text-muted-foreground">ID: {stream.id}</p>
                </div>
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  {stream.state}
                </span>
              </div>
            </Link>
          ))
        )}
      </section>

      <BottomDrawer
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        className="h-[95vh]"
        hideHeader
      >
        <div className="h-full">
          <div className="flex h-full">
            <div className="min-w-0 flex-1">
              {mapLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading map sources...
                </div>
              ) : (
                <SourceMapPicker
                  sources={mapSources}
                  counts={mapCounts}
                  selectedSourceId={selectedSource?.id}
                  showCounts={false}
                  className="h-full"
                  onHoverSource={setHoveredSource}
                  onSelectSource={(source) => {
                    setSelectedSource(source);
                  }}
                />
              )}
            </div>
            <aside className="h-full w-[380px] shrink-0 border-l border-border/80 px-4 py-4 md:px-6">
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1 overflow-auto">
                  <SourceDetailsPanel
                    source={displayedSource}
                    selectedSourceId={selectedSource?.id}
                    counts={mapCounts}
                    showPickerSummary
                  />
                </div>
                <div className="mt-3 pt-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Stream name"
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      disabled={creating || !selectedSource || !name.trim()}
                      onClick={() => void onCreate()}
                    >
                      {creating ? "Creating..." : "Create Stream"}
                    </Button>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </BottomDrawer>
    </div>
  );
}
