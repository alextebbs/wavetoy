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
