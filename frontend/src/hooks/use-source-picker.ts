import { useCallback, useRef, useState } from "react";
import {
  type MapSourceCounts,
  type ProbeResult,
  type Source,
  addFavorite,
  getMapSources,
  listFavorites,
  listFavoriteSources,
  listSourceNotes,
  probeSource,
  removeFavorite,
} from "@/lib/api";
import type { SourceMapPickerHandle } from "@/components/source-map-picker";

export type ProbeStatus = "idle" | "probing" | "done";

export function useSourcePicker(streamId = "") {
  const [mapSources, setMapSources] = useState<Source[]>([]);
  const [mapCounts, setMapCounts] = useState<MapSourceCounts>({
    total: 0,
    included: 0,
    omitted: 0,
  });
  const [mapLoading, setMapLoading] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [hoveredSource, setHoveredSource] = useState<Source | null>(null);
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const probeGenRef = useRef(0);
  const mapPickerRef = useRef<SourceMapPickerHandle>(null);

  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoriteSources, setFavoriteSources] = useState<Source[]>([]);
  const [notesBySourceId, setNotesBySourceId] = useState<Map<string, string>>(
    new Map(),
  );

  const refreshMapSources = useCallback(async () => {
    setMapLoading(true);
    try {
      const payload = await getMapSources();
      setMapSources(payload.included_sources);
      setMapCounts(payload.counts);
    } catch {
      // map source load failed
    } finally {
      setMapLoading(false);
    }
  }, []);

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

  const toggleFavorite = useCallback(
    async (sourceId: string) => {
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
    },
    [favoriteIds, refreshFavoriteSources],
  );

  const selectAndProbe = useCallback(
    (source: Source) => {
      setSelectedSourceId(source.id);
      setProbeStatus("probing");
      setProbeResult(null);
      const gen = ++probeGenRef.current;
      probeSource(source.id, streamId)
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
    },
    [streamId],
  );

  const clearSelection = useCallback(() => {
    setSelectedSourceId("");
    setProbeStatus("idle");
    setProbeResult(null);
  }, []);

  const skipProbe = useCallback(() => {
    probeGenRef.current++;
    setProbeStatus("idle");
    setProbeResult(null);
  }, []);

  const loadAll = useCallback(() => {
    void refreshMapSources();
    void listFavorites()
      .then((ids) => setFavoriteIds(new Set(ids)))
      .catch(() => {});
    refreshFavoriteSources();
    refreshNotes();
  }, [refreshMapSources, refreshFavoriteSources, refreshNotes]);

  const ensureMapSources = useCallback(() => {
    if (mapSources.length === 0 && !mapLoading) {
      void refreshMapSources();
    }
  }, [mapSources.length, mapLoading, refreshMapSources]);

  const appendSources = useCallback((sources: Source[]) => {
    setMapSources((prev) => [...prev, ...sources]);
  }, []);

  const selectedSource =
    mapSources.find((s) => s.id === selectedSourceId) ?? null;
  const displayedSource = hoveredSource ?? selectedSource;

  return {
    mapSources,
    mapCounts,
    mapLoading,
    mapPickerRef,
    favoriteIds,
    favoriteSources,
    notesBySourceId,
    hoveredSource,
    selectedSourceId,
    selectedSource,
    displayedSource,
    probeStatus,
    probeResult,

    setSelectedSourceId,
    setHoveredSource,
    selectAndProbe,
    clearSelection,
    skipProbe,
    toggleFavorite,
    refreshMapSources,
    refreshNotes,
    loadAll,
    ensureMapSources,
    appendSources,
  };
}
