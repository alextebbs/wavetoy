import {
  type FallbackSuggestion,
  type Stream,
  fetchFallbackProbeAudio,
  fetchFallbackRefAudio,
  getFallbacks,
  reprobeStream,
} from "@/lib/api";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { SnapshotPlayButton } from "./snapshot-play-button";
import {
  ArrowUpIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface FallbackSectionProps {
  stream: Stream | null;
  streamId: string;
  onToggleFallback: (enabled: boolean) => void;
  wsRef: React.RefObject<WebSocket | null>;
  audioCtxRef: React.RefObject<AudioContext | null>;
  gainNodeRef: React.RefObject<GainNode | null>;
}

export function FallbackSection({
  stream,
  streamId,
  onToggleFallback,
  wsRef,
  audioCtxRef,
  gainNodeRef,
}: FallbackSectionProps) {
  const [suggestions, setSuggestions] = useState<FallbackSuggestion[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState<{
    total: number;
    probed: number;
  } | null>(null);
  const [reprobing, setReprobing] = useState(false);
  const autoFallback = stream?.auto_fallback ?? false;

  const loadFallbacks = useCallback(async () => {
    try {
      const data = await getFallbacks(streamId);
      setSuggestions(data.suggestions ?? []);
      if (data.suggestions?.length > 0) {
        setProbing(false);
        setProbeProgress(null);
      }
    } catch {
      // ignore
    }
  }, [streamId]);

  useEffect(() => {
    void loadFallbacks();
  }, [loadFallbacks]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handler = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as {
          type?: string;
          stream_id?: string;
          suggestions?: FallbackSuggestion[];
          candidates_total?: number;
          candidates_probed?: number;
        };
        if (msg.stream_id !== streamId) return;

        if (msg.type === "fallback_updated") {
          setSuggestions(msg.suggestions ?? []);
          setProbing(false);
          setProbeProgress(null);
        } else if (msg.type === "fallback_probing") {
          setProbing(true);
          setProbeProgress({
            total: msg.candidates_total ?? 0,
            probed: msg.candidates_probed ?? 0,
          });
        } else if (msg.type === "fallback_switch") {
          setSuggestions([]);
          setProbing(false);
          setProbeProgress(null);
        }
      } catch {
        // ignore
      }
    };

    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [wsRef, streamId]);

  const handleProbe = async () => {
    setReprobing(true);
    setProbing(true);
    setSuggestions([]);
    setProbeProgress(null);
    try {
      await reprobeStream(streamId);
    } catch {
      // ignore
    } finally {
      setReprobing(false);
    }
  };

  const handleSwitchSource = (sourceId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "switch_fallback", source_id: sourceId }));
  };

  return (
    <section className="border-t border-border/60">
      <div className="px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Fallback sources
          </h3>
          <div className="flex items-center gap-2">
            {suggestions.length > 0 && (
              <Tooltip content="Play reference audio">
                <SnapshotPlayButton
                  fetchAudio={() => fetchFallbackRefAudio(streamId)}
                  audioCtxRef={audioCtxRef}
                  gainNodeRef={gainNodeRef}
                  size={24}
                  tooltip="Play reference audio"
                />
              </Tooltip>
            )}
            <Tooltip content="Probe nearby sources">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                disabled={reprobing}
                onClick={() => void handleProbe()}
              >
                <RefreshCwIcon
                  className={`size-3 ${reprobing ? "animate-spin" : ""}`}
                />
              </Button>
            </Tooltip>
            <Tooltip
              content={
                autoFallback
                  ? "Keep alive & auto-fallback enabled"
                  : "Enable keep alive & auto-fallback"
              }
            >
              <Button
                variant={autoFallback ? "outline" : "ghost"}
                size="icon"
                className="size-6 shrink-0"
                onClick={() => onToggleFallback(!autoFallback)}
              >
                <ShieldCheckIcon className="size-3" />
              </Button>
            </Tooltip>
          </div>
        </div>

        <div className="mt-3">
          {probing && suggestions.length === 0 ? (
            <div className="flex items-center justify-center gap-1.5 py-4 text-[10px] text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              <span>
                {probeProgress
                  ? `Probing ${probeProgress.probed}/${probeProgress.total}`
                  : "Probing"}
              </span>
            </div>
          ) : suggestions.length === 0 ? (
            <p className="py-2 text-center text-[10px] uppercase tracking-widest text-muted-foreground">
              No fallback sources
            </p>
          ) : (
            <div className="space-y-2">
              {suggestions.map((s) => (
                <SuggestionCard
                  key={s.source_id}
                  suggestion={s}
                  streamId={streamId}
                  onSwitch={handleSwitchSource}
                  isCurrentSource={s.source_id === stream?.source_id}
                  audioCtxRef={audioCtxRef}
                  gainNodeRef={gainNodeRef}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const COMPASS_LABELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function bearingCompass(deg: number): string {
  return COMPASS_LABELS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function SuggestionCard({
  suggestion: s,
  streamId,
  onSwitch,
  isCurrentSource,
  audioCtxRef,
  gainNodeRef,
}: {
  suggestion: FallbackSuggestion;
  streamId: string;
  onSwitch: (sourceId: string) => void;
  isCurrentSource: boolean;
  audioCtxRef: React.RefObject<AudioContext | null>;
  gainNodeRef: React.RefObject<GainNode | null>;
}) {
  const scorePercent = Math.round(s.score * 100);
  const distLabel =
    s.distance_km < 1
      ? "<1 km"
      : s.distance_km < 100
        ? `${Math.round(s.distance_km)} km`
        : `${Math.round(s.distance_km).toLocaleString()} km`;
  const hostPort = s.source_port
    ? `${s.source_host}:${s.source_port}`
    : s.source_host;
  const compass = bearingCompass(s.bearing_deg);

  return (
    <div className="group rounded-md border border-border/60 px-2.5 py-2 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-foreground" title={`${hostPort} (${s.source_name})`}>
            {hostPort}
          </p>
          <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
            <Tooltip content={`${compass} (${Math.round(s.bearing_deg)}°)`}>
              <span className="inline-flex items-center gap-1">
                <ArrowUpIcon
                  className="size-2.5 shrink-0"
                  style={{ transform: `rotate(${s.bearing_deg}deg)` }}
                />
                {distLabel}
              </span>
            </Tooltip>
            <span>Score {scorePercent}%</span>
            <span>{Math.round(s.probe_metrics.latency_ms)}ms</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content="Play probe audio">
            <SnapshotPlayButton
              fetchAudio={() => fetchFallbackProbeAudio(streamId, s.rank)}
              audioCtxRef={audioCtxRef}
              gainNodeRef={gainNodeRef}
              size={24}
              tooltip="Play probe audio"
            />
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px]"
            disabled={isCurrentSource}
            onClick={() => onSwitch(s.source_id)}
          >
            {isCurrentSource ? "Current" : <><RotateCwIcon className="size-3" /> Swap</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
