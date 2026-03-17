import { ProbeStatusBox } from "@/components/probe-status-box";
import { SourceSearchPanel } from "@/components/source-search-panel";
import { SourceSection } from "@/components/source-section";
import { WavetoyLogo } from "@/components/wavetoy-logo";
import { SourceMapPicker, type SourceMapPickerHandle } from "@/components/source-map-picker";
import { SourceMiniMap } from "@/components/source-mini-map";
import { SourceOverlay } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  type MapSourceCounts,
  type ProbeResult,
  type Source,
  type Stream,
  addFavorite,
  createStream,
  getMapSources,
  getSessionColor,
  getSessionId,
  getSource,
  listFavorites,
  listFavoriteSources,
  listSourceNotes,
  listStreams,
  probeSource,
  removeFavorite,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function StreamsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "wavetoy - streams";
  }, []);

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
  const [probeStatus, setProbeStatus] = useState<"idle" | "probing" | "done">("idle");
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const probeGenRef = useRef(0);
  const mapPickerRef = useRef<SourceMapPickerHandle>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoriteSources, setFavoriteSources] = useState<Source[]>([]);
  const [notesBySourceId, setNotesBySourceId] = useState<Map<string, string>>(new Map());

  const refreshFavoriteSources = useCallback(() => {
    void listFavoriteSources()
      .then((sources) => setFavoriteSources(sources))
      .catch(() => {});
  }, []);

  const refreshNotes = useCallback(() => {
    void listSourceNotes()
      .then((notes) => {
        const m = new Map<string, string>();
        for (const n of notes) m.set(n.source_id, n.content);
        setNotesBySourceId(m);
      })
      .catch(() => {});
  }, []);

  const toggleFavorite = useCallback(async (sourceId: string) => {
    const isFav = favoriteIds.has(sourceId);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
    try {
      if (isFav) await removeFavorite(sourceId);
      else await addFavorite(sourceId);
      refreshFavoriteSources();
    } catch {
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (isFav) next.add(sourceId);
        else next.delete(sourceId);
        return next;
      });
    }
  }, [favoriteIds, refreshFavoriteSources]);

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
    void listFavorites().then((ids) => setFavoriteIds(new Set(ids))).catch(() => {});
    refreshFavoriteSources();
    refreshNotes();
    connectWS();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [refreshStreams, refreshMapSources, refreshFavoriteSources, connectWS]);

  useEffect(() => {
    if (streams.length === 0 || mapSources.length === 0) return;
    const missing = streams
      .map((s) => s.source_id)
      .filter((id) => !mapSources.some((ms) => ms.id === id));
    const unique = [...new Set(missing)];
    if (unique.length === 0) return;
    Promise.all(unique.map((id) => getSource(id).catch(() => null)))
      .then((results) => {
        const found = results.filter((s): s is Source => s !== null);
        if (found.length > 0) {
          setMapSources((prev) => [...prev, ...found]);
        }
      });
  }, [streams, mapSources.length]);

  const openCreateDrawer = () => {
    setSelectedSource(null);
    setHoveredSource(null);
    setCreateDrawerOpen(true);
    if (mapSources.length === 0 && !mapLoading) {
      void refreshMapSources();
    }
  };

  const onCreate = async () => {
    if (!selectedSource) return;
    setCreating(true);
    setError("");
    try {
      const created = await createStream({
        source_id: selectedSource.id,
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

  const displayedSource = hoveredSource ?? selectedSource;

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
              const source = mapSources.find((s) => s.id === stream.source_id) ?? null;
              return (
                <Link
                  key={stream.id}
                  to="/streams/$streamId"
                  params={{ streamId: stream.id }}
                >
                  <Card className="relative overflow-hidden p-0 transition-colors hover:ring-foreground/25" style={{ backgroundColor: "#000" }}>
                    <SourceMiniMap
                      source={source}
                      className="h-[26rem] w-full"
                    />
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
            sources={mapSources}
            favoriteSources={favoriteSources}
            favoriteIds={favoriteIds}
            counts={mapCounts}
            selectedSourceId={selectedSource?.id}
            notesBySourceId={notesBySourceId}
            onSelectSource={(source) => {
              setSelectedSource(source);
              setProbeStatus("probing");
              setProbeResult(null);
              const gen = ++probeGenRef.current;
              probeSource(source.id, "")
                .then((result) => {
                  if (gen !== probeGenRef.current) return;
                  setProbeStatus("done");
                  setProbeResult(result);
                })
                .catch(() => {
                  if (gen !== probeGenRef.current) return;
                  setProbeStatus("done");
                  setProbeResult({
                    source_id: source.id,
                    connected: false,
                    snd_ok: false,
                    wf_ok: false,
                    latency_ms: 0,
                    error: "Probe request failed",
                  });
                });
            }}
            onFlyTo={(source) => {
              if (source.latitude != null && source.longitude != null) {
                mapPickerRef.current?.flyTo(source.latitude, source.longitude, 6);
              }
            }}
          />
        }
        globe={
          mapLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading map sources...
            </div>
          ) : (
            <SourceMapPicker
              ref={mapPickerRef}
              sources={mapSources}
              counts={mapCounts}
              selectedSourceId={selectedSource?.id}
              favoriteIds={favoriteIds}
              showCounts={false}
              className="h-full"
              onHoverSource={setHoveredSource}
              onDeselectSource={() => {
                setSelectedSource(null);
                setProbeStatus("idle");
                setProbeResult(null);
              }}
              onSelectSource={(source) => {
                setSelectedSource(source);
                setProbeStatus("probing");
                setProbeResult(null);
                const gen = ++probeGenRef.current;
                probeSource(source.id, "")
                  .then((result) => {
                    if (gen !== probeGenRef.current) return;
                    setProbeStatus("done");
                    setProbeResult(result);
                  })
                  .catch(() => {
                    if (gen !== probeGenRef.current) return;
                    setProbeStatus("done");
                    setProbeResult({
                      source_id: source.id,
                      connected: false,
                      snd_ok: false,
                      wf_ok: false,
                      latency_ms: 0,
                      error: "Probe request failed",
                    });
                  });
              }}
            />
          )
        }
        sidebar={
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              {displayedSource ? (
                <SourceSection
                  source={displayedSource}
                  sourceId={selectedSource?.id ?? ""}
                  isFavorite={favoriteIds.has(displayedSource.id)}
                  onToggleFavorite={toggleFavorite}
                  onNotesChanged={refreshNotes}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">No source selected</p>
                </div>
              )}
            </div>
            {selectedSource && (
              <div className="shrink-0 border-t border-border/80 p-3">
                <ProbeStatusBox
                  status={probeStatus}
                  result={probeResult}
                  actionLabel={creating ? "Creating..." : "Create"}
                  disabled={creating}
                  onAction={() => void onCreate()}
                  onSkip={() => {
                    probeGenRef.current++;
                    setProbeStatus("idle");
                    setProbeResult(null);
                  }}
                />
              </div>
            )}
          </>
        }
      />
    </div>
  );
}
