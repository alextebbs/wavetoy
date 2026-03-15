import { useCallback, useEffect, useRef, useState } from "react";

export type LogEntry = {
  id: string;
  t: number;
  level: string;
  action: string;
  from?: string;
  to?: string;
  msg?: string;
};

export type LogLine = LogEntry;

interface LogsPanelProps {
  lines: LogEntry[];
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-muted-foreground",
  debug: "text-muted-foreground/60",
};

const LEVEL_TAGS: Record<string, string> = {
  error: "ERR",
  warn: "WRN",
  info: "INF",
  debug: "DBG",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEntry(e: LogEntry): string {
  const ts = formatTime(e.t);
  const lvl = LEVEL_TAGS[e.level] ?? "???";
  const wire = e.from && e.to ? ` ${e.from}→${e.to}` : "";
  const msg = e.msg ? ` ${e.msg}` : "";
  return `${ts} ${lvl} ${e.action}${wire}${msg}`;
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

export function LogsPanel({ lines }: LogsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [filter, setFilter] = useState<FilterLevel>("all");
  const prevLenRef = useRef(0);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  }, []);

  const filtered = filter === "all"
    ? lines
    : lines.filter((l) => (LEVEL_SEVERITY[l.level] ?? 0) >= (LEVEL_SEVERITY[filter] ?? 0));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
  }, []);

  useEffect(() => {
    if (filtered.length === prevLenRef.current) return;
    prevLenRef.current = filtered.length;
    if (!stickRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2 font-mono text-[10px] leading-relaxed"
      >
        <div className="flex-1" />
        {filtered.map((entry) => (
          <div key={entry.id} className={LEVEL_COLORS[entry.level] ?? "text-muted-foreground"}>
            {formatEntry(entry)}
          </div>
        ))}
      </div>
    </section>
  );
}
