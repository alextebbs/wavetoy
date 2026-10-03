import { ProbeStatusBox } from "@/components/probe-status-box";
import { SourceSearchPanel } from "@/components/source-search-panel";
import { SourceSection } from "@/components/source-section";
import { WavetoyLogo } from "@/components/wavetoy-logo";
import { SourceMapPicker } from "@/components/source-map-picker";
import { SourceMiniMap } from "@/components/source-mini-map";
import { SourceOverlay } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  type Source,
  type Stream,
  createStream,
  getSessionColor,
  getSessionId,
  getSource,
  listStreams,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { useSourcePicker } from "@/hooks/use-source-picker";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function streamChip(state: string, health?: string[]): { label: string; color: "green" | "red" | "blue" | "grey" } {
  switch (state) {
    case "active":
      if (health?.includes("too_busy"))
        return { label: "S/BUSY", color: "red" };
      if (health?.includes("audio_stale"))
        return { label: "S/SND", color: "red" };
      if (health?.includes("wf_stale"))
        return { label: "S/WF", color: "red" };
      return { label: "ACTIVE", color: "green" };
    case "connecting":
      return { label: "S/CON", color: "blue" };
    case "reconnecting":
      return { label: "S/RCN", color: "red" };
    case "error":
      return { label: "S/ERR", color: "red" };
    case "idle":
      return { label: "S/IDL", color: "grey" };
    default:
      return { label: state.toUpperCase(), color: "grey" };
  }
}

export function StreamsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "wavetoy - streams";
  }, []);

  const [creating, setCreating] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

  const picker = useSourcePicker();

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
    const token = getToken();
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/ws${token ? `?token=${token}` : ""}`,
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
          state?: string;
          health?: string[];
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
        } else if (msg.type === "stream_state_changed" && msg.stream_id && typeof msg.state === "string") {
          setStreams((prev) =>
            prev.map((s) =>
              s.id === msg.stream_id ? { ...s, state: msg.state!, health: msg.health ?? [] } : s,
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
    picker.loadAll();
    connectWS();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [refreshStreams, connectWS]);

  useEffect(() => {
    if (streams.length === 0 || picker.mapSources.length === 0) return;
    const missing = streams
      .map((s) => s.source_id)
      .filter((id) => !picker.mapSources.some((ms) => ms.id === id));
    const unique = [...new Set(missing)];
    if (unique.length === 0) return;
    Promise.all(unique.map((id) => getSource(id).catch(() => null)))
      .then((results) => {
        const found = results.filter((s): s is Source => s !== null);
        if (found.length > 0) {
          picker.appendSources(found);
        }
      });
  }, [streams, picker.mapSources.length]);

  const openCreateDrawer = () => {
    picker.clearSelection();
    picker.setHoveredSource(null);
    setCreateDrawerOpen(true);
    picker.ensureMapSources();
  };

  const onCreate = async () => {
    if (!picker.selectedSource) return;
    setCreating(true);
    setError("");
    try {
      const created = await createStream({
        source_id: picker.selectedSource.id,
        frequency_khz: 10000,
        mode: "am",
        name: "untitled",
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="leading-none">
          <WavetoyLogo className="text-3xl" />
        </h1>
        <Button type="button" variant="ghost" onClick={openCreateDrawer}>
          <PlusIcon className="size-4" />
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section>
        {(loading ? [] : streams).length === 0 ? (
          <p className="font-xanh-mono py-10 text-center text-sm text-muted-foreground">
            no streams :(
          </p>
        ) : (
          <div className="grid gap-4">
            {streams.map((stream) => {
              const source = picker.mapSources.find((s) => s.id === stream.source_id) ?? null;
              return (
                <Link
                  key={stream.id}
                  to="/streams/$streamId"
                  params={{ streamId: stream.id }}
                >
                  <Card className="relative overflow-hidden rounded-xl p-0 ring-border transition-colors hover:ring-border/60" style={{ backgroundColor: "#000" }}>
                    <SourceMiniMap
                      source={source}
                      className="h-[26rem] w-full"
                    />
                    {(() => {
                      const chip = streamChip(stream.state, stream.health);
                      const isMonitor = stream.auto_probe && stream.quality_fallback && stream.keep_alive && stream.offload_chunks;
                      return (
                        <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5">
                          {isMonitor && (
                            <span className="shrink-0 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-purple-400">
                              Monitor
                            </span>
                          )}
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                            chip.color === "green"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : chip.color === "red"
                                ? "bg-destructive/15 text-destructive"
                                : chip.color === "blue"
                                  ? "bg-primary/15 text-primary"
                                  : "bg-muted text-muted-foreground"
                          }`}>
                            {chip.label}
                          </span>
                        </div>
                      );
                    })()}
                    <div className="relative z-10 -mt-80 px-3 pb-3">
                      <div
                        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-gradient-to-t from-black to-transparent"
                        aria-hidden
                      />
                      <div className="relative flex items-end justify-between gap-4 pt-64">
                        <div className="min-w-0">
                          <p className="font-xanh-mono truncate text-base text-foreground">
                            {stream.name}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
                            {stream.frequency_khz} kHz · {stream.mode.toUpperCase()}
                          </p>
                        </div>
                        <div className="min-w-0 text-right">
                          <p className="font-xanh-mono truncate text-base text-muted-foreground">
                            {source ? `${source.host}:${source.port}` : "—"}
                          </p>
                          {source?.name && (
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">
                              {source.name}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <SourceOverlay
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        title="Create Stream"
        showSidebar
        leftPanel={
          <SourceSearchPanel
            sources={picker.mapSources}
            favoriteSources={picker.favoriteSources}
            favoriteIds={picker.favoriteIds}
            counts={picker.mapCounts}
            selectedSourceId={picker.selectedSourceId || undefined}
            notesBySourceId={picker.notesBySourceId}
            onSelectSource={picker.selectAndProbe}
            onFlyTo={(source) => {
              if (source.latitude != null && source.longitude != null) {
                picker.mapPickerRef.current?.flyTo(source.latitude, source.longitude, 6);
              }
            }}
          />
        }
        globe={
          picker.mapLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading map sources...
            </div>
          ) : (
            <SourceMapPicker
              ref={picker.mapPickerRef}
              sources={picker.mapSources}
              counts={picker.mapCounts}
              selectedSourceId={picker.selectedSourceId || undefined}
              favoriteIds={picker.favoriteIds}
              showCounts={false}
              className="h-full"
              onHoverSource={picker.setHoveredSource}
              onDeselectSource={picker.clearSelection}
              onSelectSource={picker.selectAndProbe}
            />
          )
        }
        sidebar={
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              {picker.displayedSource ? (
                <SourceSection
                  source={picker.displayedSource}
                  sourceId={picker.selectedSourceId}
                  isFavorite={picker.favoriteIds.has(picker.displayedSource.id)}
                  onToggleFavorite={picker.toggleFavorite}
                  onNotesChanged={picker.refreshNotes}
                  showSNRChart
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">No source selected</p>
                </div>
              )}
            </div>
            {picker.selectedSource && (
              <div className="shrink-0 border-t border-border/80 p-3">
                <ProbeStatusBox
                  status={picker.probeStatus}
                  result={picker.probeResult}
                  actionLabel={creating ? "Creating..." : "Create"}
                  disabled={creating}
                  onAction={() => void onCreate()}
                  onSkip={picker.skipProbe}
                />
              </div>
            )}
          </>
        }
      />
    </div>
  );
}
