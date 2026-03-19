import { useCallback, useEffect, useRef, useState } from "react";
import { BugIcon, BracesIcon } from "lucide-react";
import { type Stream, setStreamDebug, downloadStreamLogs } from "@/lib/api";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

export type LogEntry = {
  id: string;
  t: number;
  level: string;
  action: string;
  from?: string;
  to?: string;
  msg?: string;
  origin?: "server" | "client";
};

export type LogLine = LogEntry;

interface LogsPanelProps {
  lines: LogEntry[];
  streamId?: string;
  stream?: Stream | null;
  onPatch?: (patch: Record<string, boolean>) => void;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-orange-400",
  info: "text-sky-400",
  debug: "text-muted-foreground",
};

const LEVEL_TAGS: Record<string, string> = {
  error: "ERR",
  warn: "WRN",
  info: "INF",
  debug: "DBG",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms3 = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms3}`;
}

type FilterLevel = "all" | "info" | "warn" | "error";

const FILTER_OPTIONS: { value: FilterLevel; label: string }[] = [
  { value: "all", label: "All" },
  { value: "info", label: "Info+" },
  { value: "warn", label: "Warn+" },
  { value: "error", label: "Errors" },
];

const LEVEL_SEVERITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function LogsPanel({ lines, streamId, stream, onPatch }: LogsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [filter, setFilter] = useState<FilterLevel>("all");
  const debug = stream?.log_level === "debug";

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  }, []);

  const filtered = filter === "all"
    ? lines
    : lines.filter((l) => (LEVEL_SEVERITY[l.level] ?? 0) >= (LEVEL_SEVERITY[filter] ?? 0));

  // Scroll to bottom on mount (tab switch remounts the component)
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // Scroll when new lines arrive
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [filtered.length, scrollToBottom]);

  const toggleDebug = useCallback(() => {
    if (!streamId) return;
    const next = !debug;
    setStreamDebug(streamId, next ? "debug" : "info").catch(() => {});
  }, [streamId, debug]);

  const downloadLogs = useCallback(() => {
    if (!streamId) return;
    downloadStreamLogs(streamId);
  }, [streamId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        <span className="text-xs font-medium uppercase text-muted-foreground">Logs</span>
        <div className="ml-auto flex items-center gap-1">
        <Tooltip content={debug ? "Disable debug logs" : "Enable debug logs"}>
          <Button
            variant={debug ? "outline" : "ghost"}
            size="icon"
            className="h-6 w-6"
            onClick={toggleDebug}
          >
            <BugIcon className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Download logs as JSON">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground/60"
            onClick={downloadLogs}
          >
            <BracesIcon className="size-3.5" />
          </Button>
        </Tooltip>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2 font-mono text-[10px] leading-relaxed"
      >
        <div className="flex-1" />
        {filtered.map((entry) => {
          const color = LEVEL_COLORS[entry.level] ?? "text-muted-foreground";
          const wire = entry.from && entry.to ? `${entry.from}→${entry.to}` : "—";
          return (
            <div key={entry.id} className={`flex gap-[2ch] ${color}`} style={entry.origin === "client" ? { opacity: 0.75 } : undefined}>
              <span className="w-[12ch] shrink-0">{formatTime(entry.t)}</span>
              <span className="w-[3ch] shrink-0">{LEVEL_TAGS[entry.level] ?? "???"}</span>
              <span className="w-[18ch] shrink-0 truncate">{entry.action || "—"}</span>
              <span className="w-[15ch] shrink-0">{wire}</span>
              <span className="min-w-0 truncate">{entry.msg || "—"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

