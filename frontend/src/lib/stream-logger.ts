type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEvent {
  level: LogLevel;
  action: string;
  from?: string;
  to?: string;
  msg?: string;
}

type PanelSink = (entry: {
  t: number;
  level: string;
  action: string;
  from?: string;
  to?: string;
  msg?: string;
  origin: "client";
}) => void;

const CONSOLE_METHOD: Record<LogLevel, "debug" | "log" | "warn" | "error"> = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

class StreamLogger {
  private _panelSink: PanelSink | null = null;
  private _pipeToPanel = false;

  get pipeToPanel() {
    return this._pipeToPanel;
  }
  set pipeToPanel(v: boolean) {
    this._pipeToPanel = v;
  }

  setPanelSink(sink: PanelSink | null) {
    this._panelSink = sink;
  }

  log(event: LogEvent) {
    const wire = [event.from, event.to].filter(Boolean).join("→") || "—";
    const tag = LEVEL_TAG[event.level];
    const parts = [`%c[${tag}]%c ${event.action} ${wire}`, this._style(event.level), ""];
    if (event.msg) parts[0] += ` — ${event.msg}`;
    console[CONSOLE_METHOD[event.level]](...parts);

    if (this._pipeToPanel && this._panelSink) {
      this._panelSink({
        t: Date.now(),
        level: event.level,
        action: event.action,
        from: event.from,
        to: event.to,
        msg: event.msg,
        origin: "client",
      });
    }
  }

  debug(action: string, msg?: string, from?: string, to?: string) {
    this.log({ level: "debug", action, from, to, msg });
  }

  info(action: string, msg?: string, from?: string, to?: string) {
    this.log({ level: "info", action, from, to, msg });
  }

  warn(action: string, msg?: string, from?: string, to?: string) {
    this.log({ level: "warn", action, from, to, msg });
  }

  error(action: string, msg?: string, from?: string, to?: string) {
    this.log({ level: "error", action, from, to, msg });
  }

  private _style(level: LogLevel): string {
    const colors: Record<LogLevel, string> = {
      debug: "color: #888",
      info: "color: #4a9eff",
      warn: "color: #f5a623",
      error: "color: #e25555",
    };
    return `${colors[level]}; font-weight: bold`;
  }
}

export const streamLog = new StreamLogger();

const PERF_FLUSH_INTERVAL_MS = 5_000;

/**
 * Accumulates high-frequency timing samples and periodically flushes a
 * summary via streamLog.debug.  Designed for hot paths (RAF loops, WS
 * handlers) where per-call logging would be too noisy.
 */
export class PerfBucket {
  private count = 0;
  private totalMs = 0;
  private maxMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly action: string) {}

  record(ms: number): void {
    this.count++;
    this.totalMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), PERF_FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private flush(): void {
    if (this.count === 0) return;
    const avg = this.totalMs / this.count;
    streamLog.debug(
      this.action,
      `calls=${this.count} avg=${avg.toFixed(2)}ms max=${this.maxMs.toFixed(2)}ms total=${this.totalMs.toFixed(1)}ms`,
    );
    this.count = 0;
    this.totalMs = 0;
    this.maxMs = 0;
  }
}

export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    this.flush();
    this.timer = setInterval(() => this.flush(), PERF_FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const heapMB = mem ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) : "?";
    const canvases = document.querySelectorAll("canvas").length;
    const domNodes = document.querySelectorAll("*").length;
    streamLog.debug(
      "perf.resources",
      `heap=${heapMB}MB canvases=${canvases} dom=${domNodes}`,
    );
  }
}
