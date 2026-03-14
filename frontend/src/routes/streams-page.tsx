import { SourceDetailsPanel } from "@/components/source-details-panel";
import { SourceMapPicker } from "@/components/source-map-picker";
import { SourceMiniMap } from "@/components/source-mini-map";
import { BottomDrawer } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  type MapSourceCounts,
  type Source,
  type Stream,
  createStream,
  getMapSources,
  getSessionColor,
  getSessionId,
  listStreams,
} from "@/lib/api";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function StreamsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
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

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectBackoffRef = useRef(1000);
  const intentionalCloseRef = useRef(false);

  const connectWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/ws`,
    );
    wsRef.current = ws;

    ws.onopen = () => {
      intentionalCloseRef.current = false;
      reconnectBackoffRef.current = 1000;
      ws.send(
        JSON.stringify({
          type: "hello",
          session_id: getSessionId(),
          color: getSessionColor(),
        }),
      );
      ws.send(
        JSON.stringify({
          type: "subscribe",
          topics: ["streams"],
        }),
      );
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as {
          type?: string;
          stream?: Stream;
          stream_id?: string;
        };
        if (msg.type === "stream_created" && msg.stream) {
          setStreams((prev) => [msg.stream!, ...prev]);
        } else if (msg.type === "stream_deleted" && msg.stream_id) {
          setStreams((prev) =>
            prev.filter((s) => s.id !== msg.stream_id),
          );
        } else if (msg.type === "stream_updated" && msg.stream) {
          setStreams((prev) =>
            prev.map((s) =>
              s.id === msg.stream!.id ? msg.stream! : s,
            ),
          );
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (intentionalCloseRef.current) return;
      const delay = reconnectBackoffRef.current;
      reconnectBackoffRef.current = Math.min(delay * 2, 30000);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectWS();
      }, delay);
    };
  }, []);

  useEffect(() => {
    void refreshStreams();
    void refreshMapSources();
    connectWS();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [refreshStreams, refreshMapSources, connectWS]);

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

      <div className="border-t border-border" />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section>
        {(loading ? [] : streams).length === 0 ? (
          <p className="font-xanh-mono py-10 text-center text-sm text-muted-foreground">
            no streams :(
          </p>
        ) : (
          <div className="grid gap-4">
            {streams.map((stream) => {
              const source = mapSources.find((s) => s.id === stream.source_id) ?? null;
              return (
                <Link
                  key={stream.id}
                  to="/streams/$streamId"
                  params={{ streamId: stream.id }}
                >
                  <Card className="p-0 transition-colors hover:ring-foreground/25">
                    <SourceMiniMap
                      source={source}
                      className="h-28 w-full overflow-hidden"
                    />
                    <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{stream.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {stream.frequency_khz} kHz · {stream.mode.toUpperCase()}
                        </p>
                        {source?.name && (
                          <p className="truncate text-[11px] text-muted-foreground/60">
                            {source.name}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {stream.state}
                      </span>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
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
