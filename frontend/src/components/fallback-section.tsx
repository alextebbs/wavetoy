import {
  type FallbackSuggestion,
  type FallbacksResponse,
  type Stream,
  fallbackProbeAudioUrl,
  fallbackRefAudioUrl,
  getFallbacks,
  reprobeStream,
} from "@/lib/api";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import {
  ArrowUpIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  UndoIcon,
  Volume2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface FallbackSectionProps {
  stream: Stream | null;
  streamId: string;
  onToggleFallback: (enabled: boolean) => void;
  wsRef: React.RefObject<WebSocket | null>;
}

export function FallbackSection({
  stream,
  streamId,
  onToggleFallback,
  wsRef,
}: FallbackSectionProps) {
  const [suggestions, setSuggestions] = useState<FallbackSuggestion[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState<{
    total: number;
    probed: number;
  } | null>(null);
  const [reprobing, setReprobing] = useState(false);
  const [prevSource, setPrevSource] = useState<{
    id: string;
    host: string;
    port: number;
  } | null>(null);
  const enabled = stream?.auto_fallback ?? false;
  const prevEnabledRef = useRef(enabled);

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
    if (enabled) {
      void loadFallbacks();
    } else {
      setSuggestions([]);
      setProbing(false);
      setProbeProgress(null);
      setPrevSource(null);
    }
  }, [enabled, loadFallbacks]);

  useEffect(() => {
    if (!prevEnabledRef.current && enabled) {
      setProbing(true);
      setSuggestions([]);
    }
    prevEnabledRef.current = enabled;
  }, [enabled]);

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
          from_source_id?: string;
          to_source_id?: string;
          from_source_host?: string;
          from_source_port?: number;
          reason?: string;
        };
        if (msg.stream_id !== streamId) return;

        if (msg.type === "fallback_updated") {
          const list = msg.suggestions ?? [];
          setSuggestions(list);
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
          if (msg.from_source_id && msg.from_source_host) {
            setPrevSource({
              id: msg.from_source_id,
              host: msg.from_source_host,
              port: msg.from_source_port ?? 0,
            });
          }
        }
      } catch {
        // ignore
      }
    };

    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [wsRef, streamId]);

  const handleReprobe = async () => {
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

  const handleRevert = () => {
    if (!prevSource) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setPrevSource(null);
    setSuggestions([]);
    ws.send(JSON.stringify({ type: "switch_fallback", source_id: prevSource.id }));
  };

  return (
    <section className="border-t border-border/60">
      <div className="px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Fallback probing
          </h3>
          <div className="flex items-center gap-2">
            {enabled && (
              <>
                <Tooltip content="Download reference snapshot">
                  <a
                    href={fallbackRefAudioUrl(streamId)}
                    download
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Volume2Icon className="size-3" />
                  </a>
                </Tooltip>
                <Tooltip content="Reprobe sources">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    disabled={reprobing}
                    onClick={() => void handleReprobe()}
                  >
                    <RefreshCwIcon
                      className={`size-3 ${reprobing ? "animate-spin" : ""}`}
                    />
                  </Button>
                </Tooltip>
              </>
            )}
            <Tooltip content={enabled ? "Disable auto-fallback" : "Enable auto-fallback"}>
              <Switch
                checked={enabled}
                onCheckedChange={onToggleFallback}
              />
            </Tooltip>
          </div>
        </div>

        {enabled && (
          <div className="mt-3">
            {prevSource && (
              <Button
                variant="outline"
                size="sm"
                className="mb-2 h-7 w-full gap-1.5 text-[10px] font-normal text-muted-foreground"
                onClick={handleRevert}
              >
                <UndoIcon className="size-3" />
                Back to {prevSource.port ? `${prevSource.host}:${prevSource.port}` : prevSource.host}
              </Button>
            )}
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
              <p className="py-2 text-xs text-muted-foreground">
                No fallback sources found nearby.
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
                  />
                ))}
              </div>
            )}
          </div>
        )}
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
}: {
  suggestion: FallbackSuggestion;
  streamId: string;
  onSwitch: (sourceId: string) => void;
  isCurrentSource: boolean;
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
          <Tooltip content="Download probe audio">
            <a
              href={fallbackProbeAudioUrl(streamId, s.rank)}
              download
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
            >
              <DownloadIcon className="size-3" />
            </a>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            disabled={isCurrentSource}
            onClick={() => onSwitch(s.source_id)}
          >
            {isCurrentSource ? "Current" : "Switch"}
          </Button>
        </div>
      </div>
    </div>
  );
}
