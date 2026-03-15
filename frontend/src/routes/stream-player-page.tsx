import { FallbackSection } from "@/components/fallback-section";
import { FiltersSection } from "@/components/filters-section";
import { FrequencyInput } from "@/components/frequency-input";
import { LogsPanel } from "@/components/logs-panel";
import { ProbeStatusBox } from "@/components/probe-status-box";
import { SourceMapPicker, type SourceMapPickerHandle } from "@/components/source-map-picker";
import { SourceSearchPanel } from "@/components/source-search-panel";
import { SourceSection } from "@/components/source-section";
import { SourceOverlay } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { SpectrumDisplay } from "@/components/spectrum/spectrum-display";
import type { SpectrumHandle } from "@/components/spectrum/spectrum-display";
import { BandViewport, computeOptimalWFConfig } from "@/components/waterfall/band-viewport";
import { FrequencyScale } from "@/components/waterfall/frequency-scale";
import { TuningOverlay } from "@/components/waterfall/tuning-overlay";
import { WaterfallDisplay } from "@/components/waterfall/waterfall-display";
import type { WaterfallHandle } from "@/components/waterfall/types";
import { useBandViewStore } from "@/lib/band-view-store";
import {
  type FilterConfig,
  type InterpreterConfig,
  type InterpreterOutput,
  type MapSourceCounts,
  type Peer,
  type ProbeResult,
  type RecentSource,
  type Source,
  type Stream,
  addFavorite,
  deleteStream,
  getMapSources,
  getSessionColor,
  getSessionId,
  getSource,
  getStream,
  listFavorites,
  listFavoriteSources,
  listRecentSources,
  PEER_COLORS,
  probeSource,
  removeFavorite,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { useNavigate, useParams } from "@tanstack/react-router";
import { InfoPanelHolder, type InfoPanelTab } from "@/components/info-panel";
import { ClockIcon, LockIcon, LockOpenIcon, DownloadIcon, PanelRightIcon, RefreshCwIcon, Volume2Icon, VolumeOffIcon, XIcon, RadioIcon, SlidersHorizontalIcon, ScrollTextIcon, BrainCircuitIcon } from "lucide-react";
import { InterpreterPanel } from "@/components/interpreter-panel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThrottle, CONTROL_THROTTLE_MS } from "@/lib/timing";
import { ALERT_THEME, MUTED_THEME, useThemeStore } from "@/lib/theme";

const AUDIO_TYPE = 0x02;
const WATERFALL_TYPE = 0x01;

const MODE_PASSBAND: Record<string, [number, number]> = {
  am:   [-4900,  4900],
  amn:  [-2500,  2500],
  lsb:  [-2700,  -300],
  usb:  [  300,  2700],
  cw:   [  300,   700],
  cwn:  [  470,   530],
  nbfm: [-6000,  6000],
};

type ResamplerState = {
  carryPos: number;
  lastSample: number;
  hasLast: boolean;
  firFactor: number;
  firTaps: Float32Array;
  firTail: Float32Array;
};

import type { LogEntry } from "@/components/logs-panel";

type AudioMetrics = {
  startedAt: number;
  packets: number;
  bytes: number;
  maxPacketGapMs: number;
  peaksOver099: number;
  samplePeak: number;
  rms: number;
  clippedSamples: number;
  sampleCount: number;
};

function encodeControlPatch(
  sourceID: string,
  frequency: number,
  mode: string,
  lo: number,
  hi: number,
): string {
  return JSON.stringify({
    source_id: sourceID,
    frequency_khz: Number(frequency),
    mode,
    bandwidth_low_hz: Number(lo),
    bandwidth_high_hz: Number(hi),
  });
}

declare global {
  interface Window {
    dumpAudioMetrics?: () => AudioMetrics;
  }
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

export function StreamPlayerPage() {
  const { streamId } = useParams({ from: "/streams/$streamId" });
  const navigate = useNavigate();
  const [stream, setStream] = useState<Stream | null>(null);
  const [status, setStatus] = useState("idle");
  const [deleting, setDeleting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [logLines, setLogLines] = useState<LogEntry[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [frequency, setFrequency] = useState(10000);
  const viewLocked = stream?.view_locked ?? false;

  const [mode, setMode] = useState("am");
  const [lo, setLo] = useState(-4900);
  const [hi, setHi] = useState(4900);
  const [mapSources, setMapSources] = useState<Source[]>([]);
  const [mapCounts, setMapCounts] = useState<MapSourceCounts>({
    total: 0,
    included: 0,
    omitted: 0,
  });
  const [mapLoading, setMapLoading] = useState(false);
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false);
  const [pendingSourceId, setPendingSourceId] = useState("");
  const [hoveredSource, setHoveredSource] = useState<Source | null>(null);
  const [probeStatus, setProbeStatus] = useState<"idle" | "probing" | "done">("idle");
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const probeGenRef = useRef(0);
  const mapPickerRef = useRef<SourceMapPickerHandle>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoriteSources, setFavoriteSources] = useState<Source[]>([]);
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [interpreterText, setInterpreterText] = useState("");
  const [interpreterWpm, setInterpreterWpm] = useState(0);
  const [detectedSidetoneHz, setDetectedSidetoneHz] = useState(0);

  const refreshFavoriteSources = useCallback(() => {
    void listFavoriteSources()
      .then((sources) => setFavoriteSources(sources))
      .catch(() => {});
  }, []);

  const refreshRecentSources = useCallback(() => {
    void listRecentSources(streamId)
      .then((rs) => setRecentSources(rs))
      .catch(() => {});
  }, [streamId]);
  const refreshRecentSourcesRef = useRef(refreshRecentSources);
  refreshRecentSourcesRef.current = refreshRecentSources;

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

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [streamSettingsOpen, setStreamSettingsOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const setMaxBandwidth = useBandViewStore((s) => s.setMaxBandwidth);
  const setView = useBandViewStore((s) => s.setView);
  const setViewRemote = useBandViewStore((s) => s.setViewRemote);
  const [spectrumHeight, setSpectrumHeight] = useState(144);
  const draggingRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const waterfallRef = useRef<WaterfallHandle>(null);
  const spectrumRef = useRef<SpectrumHandle>(null);

  const setOverride = useThemeStore((s) => s.setOverride);
  const streamState = stream?.state;
  useEffect(() => {
    const wsDown = status === "closed" || status === "error";
    const sourceDown = streamState === "stopped" || streamState === "connecting";
    setOverride(wsDown || sourceDown ? ALERT_THEME : null);
    return () => setOverride(null);
  }, [status, streamState, setOverride]);

  const wsRef = useRef<WebSocket | null>(null);
  const versionRef = useRef<number>(0);
  const sessionIdRef = useRef(getSessionId());
  const sessionColorRef = useRef(getSessionColor());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectBackoffRef = useRef(1000);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const [muted, setMuted] = useState(false);
  const streamRateRef = useRef(12000);
  const audioMetricsRef = useRef<AudioMetrics>({
    startedAt: performance.now(),
    packets: 0,
    bytes: 0,
    maxPacketGapMs: 0,
    peaksOver099: 0,
    samplePeak: 0,
    rms: 0,
    clippedSamples: 0,
    sampleCount: 0,
  });
  const lastPacketAtRef = useRef(0);
  const lastAutoPatchRef = useRef("");
  const resamplerRef = useRef<ResamplerState>({
    carryPos: 0,
    hasLast: false,
    lastSample: 0,
    firFactor: 0,
    firTaps: new Float32Array(0),
    firTail: new Float32Array(0),
  });
  const waveformSamplesRef = useRef<Float32Array>(new Float32Array(0));

  const appendLogEntry = useCallback((entry: Omit<LogEntry, "id">) => {
    setLogLines((prev) => [
      ...prev.slice(-2000),
      {
        ...entry,
        id: `${entry.t}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ]);
  }, []);

  const appendLogEntries = useCallback((entries: Omit<LogEntry, "id">[]) => {
    setLogLines((prev) => {
      const withIds = entries.map((e) => ({
        ...e,
        id: `${e.t}-${Math.random().toString(36).slice(2, 8)}`,
      }));
      return [...prev, ...withIds].slice(-2000);
    });
  }, []);

  useEffect(() => {
    const name = stream?.name;
    document.title = name ? `${name} — wavetoy` : "wavetoy";
    return () => { document.title = "wavetoy"; };
  }, [stream?.name]);


  const ensureAudio = useCallback(async () => {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      const workletCode =
        "class SdrAudioProcessor extends AudioWorkletProcessor {\n" +
        "  constructor() { super(); this.bufferSize = 48000 * 3; this.buf = new Float32Array(this.bufferSize); this.w = 0; this.r = 0; this.started = false; this.threshold = 8192; this.lowWatermark = 768; this.fadeIn = 0; this.port.onmessage = (ev)=>{ const a=ev.data; for(let i=0;i<a.length;i++){ this.buf[this.w]=a[i]; this.w=(this.w+1)%this.bufferSize; if(this.w===this.r){ this.r=(this.r+1)%this.bufferSize; } } }; }\n" +
        "  process(_, outputs){ const out=outputs[0][0]; let rem=this.w-this.r; if(rem<0) rem+=this.bufferSize; if(this.started && rem < this.lowWatermark) this.started=false; if(!this.started && rem>=this.threshold) { this.started=true; this.fadeIn=128; } if(!this.started){ for(let i=0;i<out.length;i++) out[i]=0; return true; } for(let i=0;i<out.length;i++){ if(this.r===this.w){ out[i]=0; continue; } let s=this.buf[this.r]; this.r=(this.r+1)%this.bufferSize; if(this.fadeIn>0){ const k=(128-this.fadeIn)/128; s*=k; this.fadeIn--; } out[i]=s; } return true; }\n" +
        "}\nregisterProcessor('sdr-audio-processor', SdrAudioProcessor);\n";
      const blob = new Blob([workletCode], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "sdr-audio-processor");
      const gain = ctx.createGain();
      gain.gain.value = 1;
      node.connect(gain);
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      workletRef.current = node;
      gainNodeRef.current = gain;
    }
    if (audioCtxRef.current.state !== "running") {
      await audioCtxRef.current.resume();
    }
  }, []);

  const buildFIRTaps = useCallback((factor: number) => {
    const transitionBandwidth = 0.05;
    let numTaps = Math.round(4 / transitionBandwidth);
    if (numTaps % 2 === 0) numTaps += 1;
    const taps = new Float32Array(numTaps);
    const mid = Math.floor(numTaps / 2);
    const cutoff = 1 / factor / 2;
    const hamming = (r: number) => {
      const rate = 0.5 + r / 2;
      return 0.54 - 0.46 * Math.cos(2 * Math.PI * rate);
    };
    taps[mid] = 2 * Math.PI * cutoff * hamming(0);
    for (let i = 1; i <= mid; i++) {
      const value = (Math.sin(2 * Math.PI * cutoff * i) / i) * hamming(i / mid);
      taps[mid - i] = value;
      taps[mid + i] = value;
    }
    let sum = 0;
    for (let i = 0; i < taps.length; i++) sum += taps[i];
    for (let i = 0; i < taps.length; i++) taps[i] /= sum;
    return taps;
  }, []);

  const upsampleByIntegerFIR = useCallback(
    (input: Int16Array, factor: number): Float32Array => {
      const state = resamplerRef.current;
      if (state.firFactor !== factor || state.firTaps.length === 0) {
        state.firFactor = factor;
        state.firTaps = buildFIRTaps(factor);
        state.firTail = new Float32Array(state.firTaps.length - 1);
      }
      const taps = state.firTaps;
      const tail = state.firTail;
      const upLen = input.length * factor;
      const up = new Float32Array(upLen);
      for (let i = 0; i < input.length; i++) {
        up[i * factor] = (input[i] + 0.5) / 32768;
      }
      const work = new Float32Array(tail.length + up.length);
      work.set(tail, 0);
      work.set(up, tail.length);

      const out = new Float32Array(upLen);
      const tapCount = taps.length;
      const start = tapCount - 1;
      for (let wi = start; wi < work.length; wi++) {
        let acc = 0;
        for (let k = 0; k < tapCount; k++) {
          acc += work[wi - k] * taps[k];
        }
        out[wi - start] = factor * acc;
      }

      state.firTail = work.slice(work.length - (tapCount - 1));
      return out;
    },
    [buildFIRTaps],
  );

  const resamplePCM = useCallback(
    (input: Int16Array, inRate: number, outRate: number): Float32Array => {
      if (input.length === 0) return new Float32Array(0);
      if (!inRate || !outRate) return new Float32Array(0);
      if (inRate === outRate) {
        const passthrough = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
          passthrough[i] = (input[i] + 0.5) / 32768;
        }
        return passthrough;
      }
      if (outRate % inRate === 0) {
        return upsampleByIntegerFIR(input, outRate / inRate);
      }

      const state = resamplerRef.current;
      const step = inRate / outRate;
      const srcLen = input.length + (state.hasLast ? 1 : 0);
      const src = new Int16Array(srcLen);
      if (state.hasLast) {
        src[0] = state.lastSample;
        src.set(input, 1);
      } else {
        src.set(input);
      }
      const out: number[] = [];
      let pos = state.carryPos;
      while (pos + 1 < src.length) {
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const s0 = src[idx];
        const s1 = src[idx + 1];
        out.push((s0 + (s1 - s0) * frac + 0.5) / 32768);
        pos += step;
      }
      state.lastSample = src[src.length - 1];
      state.hasLast = true;
      state.carryPos = pos - (src.length - 1);
      if (
        !Number.isFinite(state.carryPos) ||
        state.carryPos < 0 ||
        state.carryPos >= 1
      ) {
        state.carryPos = 0;
      }
      return Float32Array.from(out);
    },
    [upsampleByIntegerFIR],
  );

  const connect = useCallback(async () => {
    await ensureAudio();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
    }
    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = getToken();
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/ws${token ? `?token=${token}` : ""}`,
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    audioMetricsRef.current = {
      startedAt: performance.now(),
      packets: 0,
      bytes: 0,
      maxPacketGapMs: 0,
      peaksOver099: 0,
      samplePeak: 0,
      rms: 0,
      clippedSamples: 0,
      sampleCount: 0,
    };
    lastPacketAtRef.current = 0;

    window.dumpAudioMetrics = () => ({ ...audioMetricsRef.current });

    ws.onopen = () => {
      setStatus("connected");
      intentionalCloseRef.current = false;
      const wasReconnect = reconnectAttemptRef.current > 0;
      const attempts = reconnectAttemptRef.current;
      reconnectBackoffRef.current = 1000;
      reconnectAttemptRef.current = 0;
      appendLogEntry({ t: Date.now(), level: "info", action: wasReconnect ? "ws.reconnect" : "ws.connect", from: "client", to: "wavetoy", msg: wasReconnect ? `after ${attempts} attempt${attempts !== 1 ? "s" : ""}` : undefined, origin: "client" });
      const currentVersion = versionRef.current;
      const helloMsg: Record<string, unknown> = {
        type: "hello",
        session_id: sessionIdRef.current,
        color: sessionColorRef.current,
      };
      if (currentVersion > 0) {
        helloMsg.resume = {
          [`stream:${streamId}`]: { version: currentVersion },
        };
      }
      ws.send(JSON.stringify(helloMsg));
      if (!currentVersion) {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            topics: [`stream:${streamId}`, "streams"],
          }),
        );
      }
    };
    ws.onclose = (ev) => {
      const level = intentionalCloseRef.current ? "info" : "warn";
      appendLogEntry({ t: Date.now(), level, action: "ws.close", from: "client", to: "wavetoy", msg: `code=${ev.code} clean=${ev.wasClean}${ev.reason ? ` reason=${ev.reason}` : ""}`, origin: "client" });
      if (intentionalCloseRef.current) {
        setStatus("closed");
        return;
      }
      setStatus("reconnecting");
      scheduleReconnect();
    };
    ws.onerror = () => {
      appendLogEntry({ t: Date.now(), level: "error", action: "ws.error", from: "client", to: "wavetoy", msg: "connection error", origin: "client" });
      setStatus("error");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as Record<string, any>;
          if (msg.type === "connected") {
            if (msg.sample_rate) streamRateRef.current = msg.sample_rate;
            if (msg.max_freq_khz) {
              setMaxBandwidth(msg.max_freq_khz);
              waterfallRef.current?.setMaxBandwidth(msg.max_freq_khz);
              waterfallRef.current?.setDataCoverage(0, msg.max_freq_khz);
              spectrumRef.current?.setMaxBandwidth(msg.max_freq_khz);
              spectrumRef.current?.setDataCoverage(0, msg.max_freq_khz);
            }
            if (msg.peers) setPeers(msg.peers);
            if (msg.stream) {
              const s = msg.stream as Stream;
              const vs = s.wf_view_start_khz;
              const ve = s.wf_view_end_khz;
              if (vs != null && ve != null && ve > vs && ve < 100000) {
                setView(vs, ve);
              }
              versionRef.current = s.version;
              lastAutoPatchRef.current = encodeControlPatch(
                s.source_id, s.frequency_khz, s.mode,
                s.bandwidth_low_hz, s.bandwidth_high_hz,
              );
              setStream(s);
              setSourceId(s.source_id);
              setFrequency(s.frequency_khz);
              setMode(s.mode);
              setLo(s.bandwidth_low_hz);
              setHi(s.bandwidth_high_hz);
            }
          } else if (msg.type === "stream_updated" && msg.stream) {
            const s = msg.stream as Stream;
            if (msg.sample_rate) streamRateRef.current = msg.sample_rate;
            versionRef.current = s.version;
            lastAutoPatchRef.current = encodeControlPatch(
              s.source_id, s.frequency_khz, s.mode,
              s.bandwidth_low_hz, s.bandwidth_high_hz,
            );
            setStream(s);
            setSourceId(s.source_id);
            setFrequency(s.frequency_khz);
            setMode(s.mode);
            setLo(s.bandwidth_low_hz);
            setHi(s.bandwidth_high_hz);
            refreshRecentSourcesRef.current();
          } else if (msg.type === "peer_joined" && msg.peer) {
            const peer = msg.peer as Peer;
            setPeers((prev) => {
              if (prev.some((p) => p.session_id === peer.session_id))
                return prev;
              return [...prev, peer];
            });
          } else if (msg.type === "peer_left" && msg.peer) {
            const peer = msg.peer as Peer;
            setPeers((prev) =>
              prev.filter((p) => p.session_id !== peer.session_id),
            );
          } else if (msg.type === "error") {
            // Error is logged server-side via streamlog; no client-side entry needed.
            if (msg.code === "CONFLICT" && msg.stream) {
              const s = msg.stream as Stream;
              versionRef.current = s.version;
              lastAutoPatchRef.current = encodeControlPatch(
                s.source_id, s.frequency_khz, s.mode,
                s.bandwidth_low_hz, s.bandwidth_high_hz,
              );
              setStream(s);
              setSourceId(s.source_id);
              setFrequency(s.frequency_khz);
              setMode(s.mode);
              setLo(s.bandwidth_low_hz);
              setHi(s.bandwidth_high_hz);
            } else if (msg.code === "VALIDATION" && typeof msg.error === "string" && msg.error.includes("not subscribed")) {
              appendLogEntry({ t: Date.now(), level: "warn", action: "ws.resub", from: "client", to: "wavetoy", msg: "lost topic subscription, re-subscribing", origin: "client" });
              ws.send(JSON.stringify({ type: "subscribe", topics: [`stream:${streamId}`, "streams"] }));
            }
          } else if (msg.type === "stream_log") {
            appendLogEntry({
              t: msg.t ?? Date.now(),
              level: msg.level ?? "info",
              action: msg.action ?? "",
              from: msg.from,
              to: msg.to,
              msg: msg.msg,
            });
          } else if (msg.type === "stream_log_history" && Array.isArray(msg.entries)) {
            const entries = (msg.entries as Record<string, any>[]).map((e) => ({
              t: e.t ?? Date.now(),
              level: e.level ?? "info",
              action: e.action ?? "",
              from: e.from as string | undefined,
              to: e.to as string | undefined,
              msg: e.msg as string | undefined,
            }));
            appendLogEntries(entries);
          } else if (msg.type === "stream_state_changed" && typeof msg.state === "string") {
            setStream((prev) => prev ? { ...prev, state: msg.state as string } : prev);
          } else if (msg.type === "wf_view_changed") {
            if (msg.start_khz != null && msg.end_khz != null) {
              setViewRemote(msg.start_khz, msg.end_khz);
            }
          } else if (msg.type === "interpreter_output" && msg.payload) {
            const payload = msg.payload as InterpreterOutput;
            if (payload.clear) {
              setInterpreterText("");
            } else if (payload.text) {
              setInterpreterText((prev) => prev + payload.text);
            }
            if (payload.wpm) {
              setInterpreterWpm(payload.wpm);
            }
            if (payload.sidetone_hz) {
              setDetectedSidetoneHz(payload.sidetone_hz);
            }
          }
        } catch {
          // ignore unparseable text
        }
        return;
      }

      const packet = new Uint8Array(ev.data);
      if (packet.length < 2) return;

      if (packet[0] === WATERFALL_TYPE && packet.length > 9) {
        const dv = new DataView(ev.data, 1, 8);
        const xBin = dv.getUint32(0, true);
        const zoom = dv.getUint16(4, true);
        const bins = new Uint8Array(ev.data, 9);
        waterfallRef.current?.pushFrame(bins, xBin, zoom);
        spectrumRef.current?.pushFrame(bins, xBin, zoom);
        return;
      }

      if (packet[0] !== AUDIO_TYPE || packet.length < 3) return;
      const pcmBytes = packet.subarray(1);
      const now = performance.now();
      if (lastPacketAtRef.current > 0) {
        audioMetricsRef.current.maxPacketGapMs = Math.max(
          audioMetricsRef.current.maxPacketGapMs,
          now - lastPacketAtRef.current,
        );
      }
      lastPacketAtRef.current = now;
      audioMetricsRef.current.packets += 1;
      audioMetricsRef.current.bytes += pcmBytes.byteLength;
      const count = Math.floor(pcmBytes.byteLength / 2);
      if (count <= 0) return;
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        const loByte = pcmBytes[i * 2];
        const hiByte = pcmBytes[i * 2 + 1];
        let sample = loByte | (hiByte << 8);
        if (sample & 0x8000) sample -= 0x10000;
        pcm[i] = sample;
      }
      const wfBuf = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        wfBuf[i] = pcm[i] / 32768;
      }
      waveformSamplesRef.current = wfBuf;
      const outRate = audioCtxRef.current?.sampleRate ?? 48000;
      const resampled = resamplePCM(pcm, streamRateRef.current, outRate);
      if (resampled.length > 0) {
        let sumSquares = 0;
        let peak = 0;
        let clipped = 0;
        for (let i = 0; i < resampled.length; i++) {
          const abs = Math.abs(resampled[i]);
          if (abs > peak) peak = abs;
          if (abs >= 0.999) clipped++;
          sumSquares += resampled[i] * resampled[i];
        }
        const m = audioMetricsRef.current;
        m.samplePeak = Math.max(m.samplePeak, peak);
        if (peak >= 0.99) m.peaksOver099 += 1;
        m.clippedSamples += clipped;
        m.sampleCount += resampled.length;
        m.rms = Math.sqrt(
          (m.rms * m.rms * (m.sampleCount - resampled.length) + sumSquares) /
            m.sampleCount,
        );
      }
      workletRef.current?.port.postMessage(resampled);
    };
  }, [ensureAudio, appendLogEntry, appendLogEntries, resamplePCM, streamId]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    const attempt = ++reconnectAttemptRef.current;
    const delay = reconnectBackoffRef.current;
    reconnectBackoffRef.current = Math.min(delay * 2, 30000);
    appendLogEntry({ t: Date.now(), level: "info", action: "ws.backoff", from: "client", to: "wavetoy", msg: `attempt=${attempt} delay=${delay >= 1000 ? `${delay / 1000}s` : `${delay}ms`}`, origin: "client" });
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, delay);
  }, [connect, appendLogEntry]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startX - ev.clientX;
      setSidebarWidth(Math.max(200, startWidth + delta));
    };
    const onUp = () => {
      draggingRef.current = false;
      setIsResizing(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSpectrumResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = spectrumHeight;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      setSpectrumHeight(Math.max(0, Math.min(500, startHeight + delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [spectrumHeight]);

  const sendPatch = (
    patch: {
      source_id?: string;
      frequency_khz?: number;
      mode?: string;
      bandwidth_low_hz?: number;
      bandwidth_high_hz?: number;
      name?: string;
      filters?: FilterConfig;
      interpreter?: InterpreterConfig;
      auto_fallback?: boolean;
      auto_fallback_kind?: string;
      view_locked?: boolean;
    },
  ) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendLogEntry({ t: Date.now(), level: "warn", action: "ws.patch", from: "client", to: "wavetoy", msg: "skipped, ws not open", origin: "client" });
      return;
    }
    ws.send(
      JSON.stringify({
        type: "patch",
        version: versionRef.current,
        patch,
      }),
    );
  };

  const patchSource = (nextSourceID: string) => {
    sendPatch({ source_id: nextSourceID });
  };

  const onMapHoverSource = useCallback((source: Source | null) => {
    setHoveredSource(source);
  }, []);

  const onMapSelectSource = useCallback((source: Source) => {
    setPendingSourceId(source.id);
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
  }, [streamId]);

  const onDeleteStream = async () => {
    setDeleting(true);
    try {
      await deleteStream(streamId);
      wsRef.current?.close();
      await navigate({ to: "/" });
    } catch {
      // delete failed
    } finally {
      setDeleting(false);
    }
  };

  const onCapture = async () => {
    setCapturing(true);
    try {
      const authToken = getToken();
      const res = await fetch(`/api/streams/${streamId}/capture`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      let filename = "capture.wav";
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // capture failed
    } finally {
      setCapturing(false);
    }
  };

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

  const currentSource =
    mapSources.find((s) => s.id === sourceId) ?? null;
  const selectedSource =
    mapSources.find((s) => s.id === pendingSourceId) ?? null;
  const displayedSource = hoveredSource ?? selectedSource ?? currentSource;

  useEffect(() => {
    if (!sourceId || currentSource) return;
    getSource(sourceId)
      .then((s) => setMapSources((prev) => [...prev, s]))
      .catch(() => {});
  }, [sourceId, currentSource]);

  const throttledAutoPatch = useThrottle(
    (sid: string, freq: number, m: string, bwLo: number, bwHi: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const patch = {
        source_id: sid,
        frequency_khz: Number(freq),
        mode: m,
        bandwidth_low_hz: Number(bwLo),
        bandwidth_high_hz: Number(bwHi),
      };
      const encoded = JSON.stringify(patch);
      if (encoded === lastAutoPatchRef.current) return;
      sendPatch(patch);
      lastAutoPatchRef.current = encoded;
    },
    CONTROL_THROTTLE_MS,
  );

  useEffect(() => {
    throttledAutoPatch(sourceId, frequency, mode, lo, hi);
  }, [frequency, hi, lo, mode, sourceId, throttledAutoPatch]);

  // When locked, re-center view on frequency whenever it changes
  useEffect(() => {
    if (!viewLocked) return;
    const { startKHz, endKHz } = useBandViewStore.getState();
    const span = endKHz - startKHz;
    const newStart = frequency - span / 2;
    useBandViewStore.getState().setView(newStart, newStart + span);
  }, [frequency, viewLocked]);

  // When locked, panning/zooming should retune to center
  useEffect(() => {
    if (!viewLocked) return;
    return useBandViewStore.subscribe((state) => {
      if (state.viewSource !== "local") return;
      const center = (state.startKHz + state.endKHz) / 2;
      const rounded = Math.round(center * 100) / 100;
      if (Math.abs(rounded - frequency) > 0.01) {
        setFrequency(Math.min(rounded, 30000));
      }
    });
  }, [viewLocked, frequency]);

  useEffect(() => {
    void getStream(streamId)
      .then((s) => {
        lastAutoPatchRef.current = encodeControlPatch(
          s.source_id,
          s.frequency_khz,
          s.mode,
          s.bandwidth_low_hz,
          s.bandwidth_high_hz,
        );
        setStream(s);
        setSourceId(s.source_id);
        setPendingSourceId(s.source_id);
        setFrequency(s.frequency_khz);
        setMode(s.mode);
        setLo(s.bandwidth_low_hz);
        setHi(s.bandwidth_high_hz);
      })
      .catch(() => { /* stream load failed */ });

    void refreshMapSources();
    void listFavorites().then((ids) => setFavoriteIds(new Set(ids))).catch(() => {});
    refreshFavoriteSources();
    refreshRecentSources();
    void connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [connect, refreshMapSources, streamId]);

  const sidebarTabs: InfoPanelTab[] = useMemo(() => [
    {
      id: "source",
      icon: <RadioIcon className="size-4" />,
      label: "Source",
      content: (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <SourceSection
              source={currentSource}
              sourceId={sourceId}
              isFavorite={currentSource ? favoriteIds.has(currentSource.id) : false}
              onToggleFavorite={toggleFavorite}
              action={
                <Tooltip content="Change source">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Change source"
                    onClick={() => {
                      setPendingSourceId(sourceId);
                      setHoveredSource(null);
                      setProbeStatus("idle");
                      setProbeResult(null);
                      setSourceDrawerOpen(true);
                      if (mapSources.length === 0 && !mapLoading) {
                        void refreshMapSources();
                      }
                    }}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </Tooltip>
              }
            />
            <FallbackSection
              stream={stream}
              streamId={streamId}
              wsRef={wsRef}
              onToggleFallback={(enabled) => {
                sendPatch({ auto_fallback: enabled });
              }}
            />
          </div>
          {recentSources.length > 0 && (
            <div className="shrink-0 border-t border-border/80">
              <div className="flex items-center gap-1.5 border-b border-border/80 px-3 py-2">
                <ClockIcon className="size-3 text-muted-foreground" />
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  Recent sources
                </span>
              </div>
              <div className="max-h-[300px] overflow-y-auto divide-y divide-border/50">
                {recentSources.map((rs, idx) => {
                  const src = rs.source;
                  const nextStarted = idx + 1 < recentSources.length ? recentSources[idx + 1].started_at : null;
                  const duration = nextStarted
                    ? new Date(rs.started_at).getTime() - new Date(nextStarted).getTime()
                    : null;
                  return (
                    <div
                      key={`${src.id}-${rs.started_at}`}
                      className="flex w-full items-center gap-2 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-xanh-mono block truncate text-sm text-foreground">
                          {src.host}:{src.port}
                        </p>
                        {src.name && (
                          <p className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {src.name}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <p className="text-[10px] text-muted-foreground/60">
                          {formatTimeAgo(rs.started_at)}
                          {duration != null && duration > 0 && ` · ${formatDuration(duration)}`}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-2 text-[10px]"
                          onClick={() => sendPatch({ source_id: src.id })}
                        >
                          <RefreshCwIcon className="size-3" />
                          Change
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      id: "filters",
      icon: <SlidersHorizontalIcon className="size-4" />,
      label: "Filters",
      active: !!stream?.filters && Object.values(stream.filters).some(
        (f) => f && typeof f === "object" && "enabled" in f && f.enabled,
      ),
      content: (
        <FiltersSection
          filters={stream?.filters ?? {}}
          onFiltersChange={(filters) => sendPatch({ filters })}
          samplesRef={waveformSamplesRef}
        />
      ),
    },
    {
      id: "interpreter",
      icon: <BrainCircuitIcon className="size-4" />,
      label: "Interpreter",
      active: !!stream?.interpreter?.enabled,
      content: (
        <InterpreterPanel
          config={stream?.interpreter ?? {}}
          onConfigChange={(cfg) => sendPatch({ interpreter: cfg })}
          text={interpreterText}
          wpm={interpreterWpm}
          detectedSidetoneHz={detectedSidetoneHz}
          onClear={() => setInterpreterText("")}
        />
      ),
    },
    {
      id: "logs",
      icon: <ScrollTextIcon className="size-4" />,
      label: "Logs",
      content: <LogsPanel lines={logLines} streamId={streamId} />,
    },
  ], [currentSource, sourceId, stream, streamId, logLines, mapSources.length, mapLoading, favoriteIds, toggleFavorite, recentSources, interpreterText, interpreterWpm, detectedSidetoneHz]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Left: top bar + waterfall area ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Top bar (waterfall area only) ── */}
        <header className="grid h-[54px] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b bg-background px-4" dir="rtl">
          {/* Right: status + multiplayer + toggle info */}
          <div className="flex items-center gap-3 justify-self-start pl-4" dir="ltr">
            {status !== "connected" && status !== "idle" && (
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                status === "connecting" || status === "reconnecting"
                  ? "bg-primary/15 text-primary"
                  : "bg-destructive/15 text-destructive"
              }`}>
                {status === "connecting" && "connecting"}
                {status === "reconnecting" && "reconnecting"}
                {status === "closed" && "disconnected"}
                {status === "error" && "error"}
              </span>
            )}
            {status === "connected" && (streamState === "stopped" || streamState === "connecting") && (
              <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
                {streamState === "connecting" ? "source connecting" : "source disconnected"}
              </span>
            )}
            <div className="flex items-center gap-1.5">
              {peers.map((p, i) => (
                <Tooltip key={p.session_id} content={`user ${p.session_id.slice(0, 8)} connected`}>
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: PEER_COLORS[i % PEER_COLORS.length] }}
                  />
                </Tooltip>
              ))}
            </div>
            <Tooltip content="Stream settings">
              <button
                className="font-xanh-mono min-w-0 truncate text-base transition-colors hover:text-muted-foreground"
                onClick={() => {
                  setEditName(stream?.name ?? "");
                  setStreamSettingsOpen(true);
                }}
              >
                {stream?.name || "Untitled stream"}
              </button>
            </Tooltip>
            <Tooltip content={muted ? "Unmute" : "Mute"}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  const g = gainNodeRef.current;
                  if (g) g.gain.setTargetAtTime(next ? 0 : 1, g.context.currentTime, 0.01);
                  useThemeStore.getState().setOverride(next ? MUTED_THEME : null);
                }}
              >
                {muted ? <VolumeOffIcon className="size-4" /> : <Volume2Icon className="size-4" />}
              </Button>
            </Tooltip>
            <Tooltip content={sidebarOpen ? "Hide info panel" : "Show info panel"}>
              <Button
                variant={sidebarOpen ? "outline" : "ghost"}
                size="icon"
                onClick={() => setSidebarOpen((v) => !v)}
              >
                <PanelRightIcon className="size-4" />
              </Button>
            </Tooltip>
          </div>

          {/* Center: knob + freq + lock (truly centered) */}
          <div className="flex h-full items-center gap-5 justify-self-center" dir="ltr">
            <FrequencyInput
              value={frequency}
              onSubmit={(kHz) => setFrequency(Math.min(kHz, 30000))}
            />
            <Tooltip content={viewLocked ? "Unlock view from frequency" : "Lock view to frequency"}>
              <Button
                variant={viewLocked ? "outline" : "ghost"}
                size="icon"
                className="size-8"
                onClick={() => {
                  const next = !viewLocked;
                  sendPatch({ view_locked: next });
                  if (next) {
                    const { startKHz, endKHz } = useBandViewStore.getState();
                    const span = endKHz - startKHz;
                    const newStart = frequency - span / 2;
                    useBandViewStore.getState().setView(newStart, newStart + span);
                  }
                }}
              >
                {viewLocked ? <LockIcon className="size-4" /> : <LockOpenIcon className="size-4" />}
              </Button>
            </Tooltip>
          </div>

          {/* Left: mode + bandwidth */}
          <div className="flex items-center gap-3 justify-self-end pr-4" dir="ltr">
            <Tooltip content="Demodulation mode">
              <div className="flex h-8 overflow-hidden rounded-md border border-border">
                {["am", "usb", "lsb", "cw", "nbfm"].map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m);
                      const [defaultLo, defaultHi] = MODE_PASSBAND[m] ?? [-4900, 4900];
                      setLo(defaultLo);
                      setHi(defaultHi);
                    }}
                    className={`px-3.5 text-xs font-medium transition-colors ${
                      mode === m
                        ? "bg-primary text-primary-foreground"
                        : "bg-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </Tooltip>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Lo</span>
              <Tooltip content="Low cut (Hz)">
                <Input
                  type="number"
                  min={-6000}
                  max={6000}
                  value={lo}
                  onChange={(e) => setLo(Number(e.target.value))}
                  className="h-8 w-20 text-xs"
                />
              </Tooltip>
              <Tooltip content="High cut (Hz)">
                <Input
                  type="number"
                  min={-6000}
                  max={6000}
                  value={hi}
                  onChange={(e) => setHi(Number(e.target.value))}
                  className="h-8 w-20 text-xs"
                />
              </Tooltip>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Hi</span>
            </div>
          </div>
        </header>

        {/* Spectrum + freq scale + waterfall */}
        <BandViewport
          className="min-w-0 flex-1"
          zoomToCenter={viewLocked}
          onClickFrequency={(freqKHz) => {
            setFrequency(Math.min(Math.round(freqKHz * 100) / 100, 30000));
          }}
          onWFConfigChange={(zoom, centerKHz, viewStartKHz, viewEndKHz) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "wf_config",
                  zoom,
                  center_khz: centerKHz,
                  start_khz: viewStartKHz,
                  end_khz: viewEndKHz,
                })
              );
            }
          }}
          onDataCoverageChange={() => {
            // Both waterfall and spectrum handle their own coverage
            // transitions via pushFrame() using actual frame metadata
          }}
        >
          <TuningOverlay
            centerFreqKHz={frequency}
            passbandLowHz={lo}
            passbandHighHz={hi}
            onFrequencyChange={viewLocked ? undefined : setFrequency}
            onBandwidthChange={(newLo, newHi) => {
              setLo(newLo);
              setHi(newHi);
            }}
          />
          <SpectrumDisplay
            ref={spectrumRef}
            className="w-full shrink-0"
            style={{ height: spectrumHeight }}
          />
          <FrequencyScale onResizeStart={onSpectrumResizeStart} />
          <WaterfallDisplay
            ref={waterfallRef}
            className="min-h-0 flex-1"
          />
        </BandViewport>
      </div>

      {/* Right: info panel (full height, animated) */}
      <aside
        className={`relative flex shrink-0 flex-col border-l ${isResizing ? "" : "transition-[width] duration-200 ease-in-out"}`}
        style={{ width: sidebarOpen ? sidebarWidth : 0, borderLeftWidth: sidebarOpen ? 1 : 0 }}
      >
        {/* Resize handle — positioned outside the overflow-hidden content wrapper */}
        <div
          className="absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize hover:bg-primary/30"
          onMouseDown={onResizeStart}
        />
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{ minWidth: sidebarWidth }}
        >
          <InfoPanelHolder
            tabs={sidebarTabs}
            defaultTab="source"
            actions={
              <Tooltip content="Download ring buffer">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={capturing || status !== "connected"}
                  onClick={() => void onCapture()}
                >
                  <DownloadIcon className="size-4" />
                </Button>
              </Tooltip>
            }
          />
        </div>
      </aside>

      {/* ── Stream settings modal ── */}
      {streamSettingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) setStreamSettingsOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setStreamSettingsOpen(false);
          }}
        >
          <div className="w-80 rounded-lg border bg-background p-4 shadow-lg">
            <Input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const name = editName.trim();
                  if (name && name !== stream?.name) {
                    sendPatch({ name });
                    if (stream) setStream({ ...stream, name });
                  }
                  setStreamSettingsOpen(false);
                  setEditName("");
                }
              }}
              className="mb-4 h-8 text-sm"
              placeholder="Untitled stream"
            />
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-destructive"
                disabled={deleting}
                onClick={() => void onDeleteStream()}
              >
                <XIcon className="size-3" />
                {deleting ? "..." : "Kill"}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    setStreamSettingsOpen(false);
                    setEditName("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    const name = editName.trim();
                    if (name && name !== stream?.name) {
                      sendPatch({ name });
                      if (stream) setStream({ ...stream, name });
                    }
                    setStreamSettingsOpen(false);
                    setEditName("");
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Source picker overlay ── */}
      <SourceOverlay
        open={sourceDrawerOpen}
        onClose={() => setSourceDrawerOpen(false)}
        leftPanel={
          <SourceSearchPanel
            sources={mapSources}
            favoriteSources={favoriteSources}
            favoriteIds={favoriteIds}
            counts={mapCounts}
            selectedSourceId={pendingSourceId}
            onSelectSource={(source) => {
              onMapSelectSource(source);
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
              selectedSourceId={pendingSourceId}
              favoriteIds={favoriteIds}
              showCounts={false}
              className="h-full"
              onHoverSource={onMapHoverSource}
              onSelectSource={onMapSelectSource}
              onDeselectSource={() => {
                setPendingSourceId(sourceId);
                setProbeStatus("idle");
                setProbeResult(null);
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
                  sourceId={pendingSourceId}
                  isFavorite={favoriteIds.has(displayedSource.id)}
                  onToggleFavorite={toggleFavorite}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">No source selected</p>
                </div>
              )}
            </div>
            {pendingSourceId && pendingSourceId !== sourceId && (
              <div className="shrink-0 border-t border-border/80 p-3">
                <ProbeStatusBox
                  status={probeStatus}
                  result={probeResult}
                  actionLabel="Change"
                  onAction={() => {
                    patchSource(pendingSourceId);
                    setSourceDrawerOpen(false);
                    setProbeStatus("idle");
                    setProbeResult(null);
                  }}
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
