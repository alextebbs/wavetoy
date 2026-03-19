import { AudioCropModal } from "@/components/audio-crop-modal";
import { ErrorPage } from "@/components/error-page";
import { FallbackSection } from "@/components/fallback-section";
import { FiltersSection } from "@/components/filters-section";
import { FrequencyInput } from "@/components/frequency-input";
import { LogsPanel } from "@/components/logs-panel";
import { ProbeStatusBox } from "@/components/probe-status-box";
import { SourceMapPicker } from "@/components/source-map-picker";
import { SourceSearchPanel } from "@/components/source-search-panel";
import { SourceSection } from "@/components/source-section";
import { SourceOverlay } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { SpectrumDisplay } from "@/components/spectrum/spectrum-display";
import type { SpectrumHandle } from "@/components/spectrum/spectrum-display";
import { BandViewport } from "@/components/waterfall/band-viewport";
import { FrequencyScale } from "@/components/waterfall/frequency-scale";
import { TuningOverlay } from "@/components/waterfall/tuning-overlay";
import { WaterfallDisplayGL as WaterfallDisplay } from "@/components/waterfall/waterfall-display-gl";
import { WaterfallTimeline, type WaterfallTimelineHandle } from "@/components/waterfall/waterfall-timeline";
import type { WaterfallHandle } from "@/components/waterfall/types";
import { useBandViewStore } from "@/lib/band-view-store";
import {
    type FilterConfig,
    type InterpreterConfig,
    type InterpreterOutput,
    type Peer,
    type RecentSource,
    type Stream,
    deleteStream,
    getSessionColor,
    getSessionId,
    getSource,
    getStream,
    listRecentSources,
    PEER_COLORS,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { useSourcePicker } from "@/hooks/use-source-picker";
import { useNavigate, useParams } from "@tanstack/react-router";
import { InfoPanelHolder, type InfoPanelTab } from "@/components/info-panel";
import { AudioWaveformIcon, ClockIcon, LanguagesIcon, LockIcon, LockOpenIcon, PanelRightIcon, RewindIcon, RotateCwIcon, ScissorsIcon, Volume2Icon, VolumeOffIcon, XIcon, RadioIcon, ScrollTextIcon } from "lucide-react";
import { InterpreterPanel } from "@/components/interpreter-panel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThrottle, CONTROL_THROTTLE_MS } from "@/lib/timing";
import { ALERT_THEME, MUTED_THEME, useThemeStore } from "@/lib/theme";
import { streamLog, PerfBucket, ResourceMonitor } from "@/lib/stream-logger";
import { useTuningStore } from "@/lib/tuning-store";
import { useScrollBackStore } from "@/lib/scroll-back-store";
import { RingBufferSource } from "@/lib/chunk-loader";
import { HistoricalAudioPlayer } from "@/lib/historical-audio-player";
import { ScrubController } from "@/lib/scrub-controller";
import { parseWFChunk } from "@/lib/chunk-parser";

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

import {
  type ResamplerState,
  createResamplerState,
  resamplePCM as resamplePCMShared,
} from "@/lib/resample";

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
  const [notFound, setNotFound] = useState(false);
  const [status, setStatus] = useState("idle");
  const [deleting, setDeleting] = useState(false);
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [captureFilename, setCaptureFilename] = useState("capture.wav");
  const [logLines, setLogLines] = useState<LogEntry[]>([]);
  const viewLocked = stream?.view_locked ?? false;

  const sourceId = useTuningStore((s) => s.sourceId);
  const frequency = useTuningStore((s) => s.frequency);
  const confirmedFrequency = useTuningStore((s) => s.confirmedFrequency);
  const mode = useTuningStore((s) => s.mode);
  const lo = useTuningStore((s) => s.lo);
  const hi = useTuningStore((s) => s.hi);
  const freqAnimating = useTuningStore((s) => s.freqAnimating);

  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false);
  const picker = useSourcePicker(streamId);
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [morseText, setMorseText] = useState("");
  const [voiceChunks, setVoiceChunks] = useState<{ text: string; receivedAt: number }[]>([]);
  const [interpreterWpm, setInterpreterWpm] = useState(0);
  const [detectedSidetoneHz, setDetectedSidetoneHz] = useState(0);
  const [voiceProgress, setVoiceProgress] = useState(0);

  const refreshRecentSources = useCallback(() => {
    void listRecentSources(streamId)
      .then((rs) => setRecentSources(rs))
      .catch(() => {});
  }, [streamId]);
  const refreshRecentSourcesRef = useRef(refreshRecentSources);
  refreshRecentSourcesRef.current = refreshRecentSources;

  const [timelineOpen, setTimelineOpen] = useState(false);
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
  const timelineRef = useRef<WaterfallTimelineHandle>(null);
  const spectrumRef = useRef<SpectrumHandle>(null);

  const setOverride = useThemeStore((s) => s.setOverride);
  const d = useThemeStore((s) => s.theme.display);
  const streamState = stream?.state;
  const [noAudio, setNoAudio] = useState(false);
  const [noWaterfall, setNoWaterfall] = useState(false);

  const statusChip = useMemo((): { label: string; color: "red" | "blue" | "grey"; tooltip: string } | null => {
    switch (status) {
      case "connecting":
        return { label: "C/CON", color: "blue", tooltip: "Opening WebSocket connection to the server." };
      case "reconnecting":
        return { label: "C/RCN", color: "blue", tooltip: "Connection to the server was lost. Attempting to reconnect with backoff." };
      case "error":
        return { label: "C/ERR", color: "red", tooltip: "WebSocket connection failed. Will retry automatically." };
      case "closed":
        return { label: "C/CLS", color: "red", tooltip: "WebSocket connection was closed. No data is flowing." };
      case "idle":
        return { label: "C/IDL", color: "grey", tooltip: "Waiting to connect." };
    }
    if (status === "connected") {
      switch (streamState) {
        case "connecting":
          return { label: "S/CON", color: "red", tooltip: "Server is dialing the SDR source. If this persists, the source may be unreachable." };
        case "reconnecting":
          return { label: "S/RCN", color: "red", tooltip: "The SDR source disconnected. The server is retrying with exponential backoff." };
        case "error":
          return { label: "S/ERR", color: "red", tooltip: "Failed to connect to the SDR source, or gave up after multiple retries. Try switching sources." };
        case "idle":
          return { label: "S/IDL", color: "grey", tooltip: "The server disconnected from the SDR source because no clients were listening." };
      }
      if (noAudio) {
        return { label: "S/SND", color: "red", tooltip: "The SDR source stopped sending audio data. The connection is still open but audio frames are not arriving." };
      }
      if (noWaterfall) {
        return { label: "S/WF", color: "red", tooltip: "The SDR source stopped sending waterfall data. The connection is still open but waterfall frames are not arriving." };
      }
    }
    return null;
  }, [status, streamState, noAudio, noWaterfall]);

  useEffect(() => {
    setOverride(statusChip?.color === "red" ? ALERT_THEME : null);
    return () => setOverride(null);
  }, [statusChip?.color, setOverride]);

  const wsRef = useRef<WebSocket | null>(null);
  const versionRef = useRef<number>(0);
  const sessionIdRef = useRef(getSessionId());
  const sessionColorRef = useRef(getSessionColor());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectBackoffRef = useRef(1000);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const lastWsDataAtRef = useRef(0);
  const silenceWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const liveGainRef = useRef<GainNode | null>(null);
  const histGainRef = useRef<GainNode | null>(null);
  const scrubGainRef = useRef<GainNode | null>(null);
  const histAnalyserRef = useRef<AnalyserNode | null>(null);
  const histWaveformRafRef = useRef(0);
  const scrubControllerRef = useRef<ScrubController | null>(null);
  const histPlayerRef = useRef<HistoricalAudioPlayer | null>(null);
  const [muted, setMuted] = useState(false);
  const [isPlayingHistory, setIsPlayingHistory] = useState(false);
  const isPlayingHistoryRef = useRef(false);
  const [playbackTuning, setPlaybackTuning] = useState<{
    freqKHz: number;
    passbandLo: number;
    passbandHi: number;
  } | null>(null);
  const isInScrollBack = useScrollBackStore((s) => s.isInScrollBack);
  const isSyncingScrollRef = useRef(false);
  const isDraggingTimelineRef = useRef(false);
  const tailScrollRafRef = useRef(0);
  const tailScrollOffsetRef = useRef(0);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const histWFCacheRef = useRef<{
    startedAt: string;
    frames: import("@/lib/chunk-parser").WFChunkFrame[];
    loading: boolean;
  } | null>(null);
  const histWFSourceRef = useRef<RingBufferSource | null>(null);
  const lastScrollBackSpectrumRowRef = useRef<number | null>(null);
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
  const prefillDoneRef = useRef(false);
  const prefillAbortRef = useRef<AbortController | null>(null);
  const lastAutoPatchRef = useRef("");
  const resamplerRef = useRef<ResamplerState>(createResamplerState());
  const waveformSamplesRef = useRef<Float32Array>(new Float32Array(0));
  const tabHiddenAtRef = useRef(0);
  const droppingStaleRef = useRef(false);
  const perfAudioRef = useRef(new PerfBucket("perf.audio"));
  const perfResampleRef = useRef(new PerfBucket("perf.resample"));
  const resourceMonRef = useRef(new ResourceMonitor());

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

  useEffect(() => {
    const resumeOnGesture = () => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended") {
        ctx.resume().then(() => {
          streamLog.debug("audio.resumed", `via user gesture, state=${ctx.state}`);
          setMuted(false);
        }).catch(() => {});
      }
      if (ctx?.state === "running") {
        setMuted(false);
        document.removeEventListener("click", resumeOnGesture, true);
        document.removeEventListener("keydown", resumeOnGesture, true);
      }
    };
    document.addEventListener("click", resumeOnGesture, true);
    document.addEventListener("keydown", resumeOnGesture, true);
    return () => {
      document.removeEventListener("click", resumeOnGesture, true);
      document.removeEventListener("keydown", resumeOnGesture, true);
    };
  }, []);


  useEffect(() => {
    const onVisChange = () => {
      if (document.hidden) {
        tabHiddenAtRef.current = performance.now();
      } else if (tabHiddenAtRef.current > 0) {
        const away = performance.now() - tabHiddenAtRef.current;
        if (away > 2000) {
          droppingStaleRef.current = true;
          workletRef.current?.port.postMessage("flush");
          setTimeout(() => { droppingStaleRef.current = false; }, 300);
        }
        tabHiddenAtRef.current = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, []);

  const ensureAudio = useCallback(async () => {
    if (!audioCtxRef.current) {
      streamLog.debug("audio.create", "creating AudioContext");
      const ctx = new AudioContext({ latencyHint: "interactive" });
      streamLog.debug("audio.create", `initial state=${ctx.state}`);
      const workletCode =
        "class SdrAudioProcessor extends AudioWorkletProcessor {\n" +
        "  constructor() { super(); this.bufferSize = 48000 * 3; this.buf = new Float32Array(this.bufferSize); this.w = 0; this.r = 0; this.started = false; this.threshold = 8192; this.lowWatermark = 768; this.fadeIn = 0; this.port.onmessage = (ev)=>{ if(ev.data==='flush'){ this.w=0; this.r=0; this.started=false; return; } const a=ev.data; for(let i=0;i<a.length;i++){ this.buf[this.w]=a[i]; this.w=(this.w+1)%this.bufferSize; if(this.w===this.r){ this.r=(this.r+1)%this.bufferSize; } } }; }\n" +
        "  process(_, outputs){ const out=outputs[0][0]; let rem=this.w-this.r; if(rem<0) rem+=this.bufferSize; if(this.started && rem < this.lowWatermark) this.started=false; if(!this.started && rem>=this.threshold) { this.started=true; this.fadeIn=128; } if(!this.started){ for(let i=0;i<out.length;i++) out[i]=0; return true; } for(let i=0;i<out.length;i++){ if(this.r===this.w){ out[i]=0; continue; } let s=this.buf[this.r]; this.r=(this.r+1)%this.bufferSize; if(this.fadeIn>0){ const k=(128-this.fadeIn)/128; s*=k; this.fadeIn--; } out[i]=s; } return true; }\n" +
        "}\nregisterProcessor('sdr-audio-processor', SdrAudioProcessor);\n";
      const blob = new Blob([workletCode], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      await ScrubController.registerProcessor(ctx);
      const node = new AudioWorkletNode(ctx, "sdr-audio-processor");
      const gain = ctx.createGain();
      gain.gain.value = 1;

      const liveGain = ctx.createGain();
      liveGain.gain.value = 1;
      node.connect(liveGain);
      liveGain.connect(gain);

      const histGain = ctx.createGain();
      histGain.gain.value = 0;
      histGain.connect(gain);

      const histAnalyser = ctx.createAnalyser();
      histAnalyser.fftSize = 2048;
      histGain.connect(histAnalyser);
      histAnalyserRef.current = histAnalyser;

      const scrubGain = ctx.createGain();
      scrubGain.gain.value = 0;
      scrubGain.connect(gain);

      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      workletRef.current = node;
      gainNodeRef.current = gain;
      liveGainRef.current = liveGain;
      histGainRef.current = histGain;
      scrubGainRef.current = scrubGain;
      streamLog.debug("audio.pipeline", `created, state=${ctx.state}`);
      ctx.onstatechange = () => {
        streamLog.debug("audio.state", ctx.state);
      };
    }
    if (audioCtxRef.current.state !== "running") {
      streamLog.debug("audio.resume", `calling resume(), state=${audioCtxRef.current.state}`);
      audioCtxRef.current.resume().then(() => {
        streamLog.debug("audio.resume", `resolved, state=${audioCtxRef.current?.state}`);
      }).catch((err) => {
        streamLog.warn("audio.resume", `rejected: ${err}`);
      });
    } else {
      streamLog.debug("audio.resume", "already running");
    }
  }, []);

  const resamplePCM = useCallback(
    (input: Int16Array, inRate: number, outRate: number): Float32Array =>
      resamplePCMShared(input, inRate, outRate, resamplerRef.current),
    [],
  );

  const FADE_TIME = 0.05;

  const stopHistoricalPlayback = useCallback(() => {
    const player = histPlayerRef.current;
    if (player?.playing) player.stopPlayback();
    setIsPlayingHistory(false);
    isPlayingHistoryRef.current = false;
    useScrollBackStore.getState().set(false);
    histWFCacheRef.current = null;
    histWFSourceRef.current = null;
    waterfallRef.current?.setPlaybackHead(null);
    setPlaybackTuning(null);
    if (histWaveformRafRef.current) {
      cancelAnimationFrame(histWaveformRafRef.current);
      histWaveformRafRef.current = 0;
    }
    if (tailScrollRafRef.current) {
      cancelAnimationFrame(tailScrollRafRef.current);
      tailScrollRafRef.current = 0;
    }
    if (scrubTimerRef.current) {
      clearTimeout(scrubTimerRef.current);
      scrubTimerRef.current = null;
    }
    scrubControllerRef.current?.destroy();
    scrubControllerRef.current = null;

    const ctx = audioCtxRef.current;
    if (ctx) {
      const now = ctx.currentTime;
      liveGainRef.current?.gain.setTargetAtTime(1, now, FADE_TIME);
      histGainRef.current?.gain.setTargetAtTime(0, now, FADE_TIME);
      scrubGainRef.current?.gain.setTargetAtTime(0, now, FADE_TIME);
    }
  }, []);

  const ensureScrubController = useCallback(() => {
    if (scrubControllerRef.current) return scrubControllerRef.current;
    const ctx = audioCtxRef.current;
    const scrubGain = scrubGainRef.current;
    if (!ctx || !scrubGain) return null;

    const source = new RingBufferSource(streamId);
    const ctrl = new ScrubController(ctx, scrubGain, source);

    ctrl.onSettled = (targetRow) => {
      const sg = scrubGainRef.current;
      if (sg) {
        sg.gain.cancelScheduledValues(ctx.currentTime);
        sg.gain.setValueAtTime(0, ctx.currentTime);
      }

      const player = histPlayerRef.current;
      if (player?.playing) {
        player.seek(targetRow);
      }
    };

    scrubControllerRef.current = ctrl;
    return ctrl;
  }, [streamId]);

  const pushSpectrumForRow = useCallback((row: number) => {
    const wf = waterfallRef.current;
    if (!wf) return;
    const m = wf.chunkManifest();
    let chunk: (typeof m)[number] | undefined;
    for (const c of m) {
      if (c.frameCount > 0 && row >= c.startRow && row < c.startRow + c.frameCount) {
        chunk = c;
        break;
      }
    }
    if (!chunk) return;

    const cache = histWFCacheRef.current;
    if (cache && cache.startedAt === chunk.startedAt && !cache.loading) {
      if (cache.frames.length > 0) {
        const progress = (row - chunk.startRow) / chunk.frameCount;
        const idx = Math.min(
          cache.frames.length - 1,
          Math.max(0, Math.floor(progress * cache.frames.length)),
        );
        const f = cache.frames[idx];
        spectrumRef.current?.pushFrame(f.bins, f.xBin, f.zoom);
        spectrumRef.current?.setPassband(f.freqKHz, f.passbandLo, f.passbandHi);
        if (isPlayingHistoryRef.current) {
          setPlaybackTuning({ freqKHz: f.freqKHz, passbandLo: f.passbandLo, passbandHi: f.passbandHi });
        }
      }
    } else if (!cache || cache.startedAt !== chunk.startedAt) {
      const startedAt = chunk.startedAt;
      const wfSource = histWFSourceRef.current;
      if (!wfSource) return;
      histWFCacheRef.current = { startedAt, frames: [], loading: true };
      wfSource.fetchWF(startedAt).then((buf) => {
        const c = histWFCacheRef.current;
        if (c && c.startedAt === startedAt) {
          c.frames = parseWFChunk(buf);
          c.loading = false;
        }
      }).catch(() => {
        const c = histWFCacheRef.current;
        if (c && c.startedAt === startedAt) c.loading = false;
      });
    }
  }, []);

  const startHistoricalPlayback = useCallback(async () => {
    const wf = waterfallRef.current;
    const ctx = audioCtxRef.current;
    const histGain = histGainRef.current;
    if (!wf || !ctx || !histGain) return;

    const manifest = wf.chunkManifest();
    if (manifest.length === 0) return;

    const totalRows = wf.rowCount();
    const scrollOffset = wf.getScrollOffset();
    const lookahead = Math.round(wf.visibleRows() * 0.1);
    const targetRow = totalRows - scrollOffset - lookahead;

    if (!histPlayerRef.current) {
      const source = new RingBufferSource(streamId);
      histPlayerRef.current = new HistoricalAudioPlayer(ctx, histGain, source);
    }

    const player = histPlayerRef.current;

    const wfSource = new RingBufferSource(streamId);
    histWFSourceRef.current = wfSource;
    histWFCacheRef.current = null;

    player.onRowChange = (row) => {
      isSyncingScrollRef.current = true;
      const total = wf.rowCount();
      const lookahead = Math.round(wf.visibleRows() * 0.1);
      const offset = Math.max(0, total - row - lookahead);
      wf.setScrollOffset(offset);
      wf.setPlaybackHead(row);
      isSyncingScrollRef.current = false;

      pushSpectrumForRow(row);
    };

    player.onReachLive = () => {
      stopHistoricalPlayback();
      wf.scrollToLive();
    };

    player.onTailing = () => {
      isPlayingHistoryRef.current = false;
      tailScrollOffsetRef.current = wf.getScrollOffset();
      const tick = () => {
        if (!histPlayerRef.current?.tailing) return;
        isSyncingScrollRef.current = true;
        wf.setScrollOffset(tailScrollOffsetRef.current);
        isSyncingScrollRef.current = false;
        tailScrollRafRef.current = requestAnimationFrame(tick);
      };
      tailScrollRafRef.current = requestAnimationFrame(tick);
    };

    const now = ctx.currentTime;
    liveGainRef.current?.gain.setTargetAtTime(0, now, FADE_TIME);
    histGainRef.current?.gain.setTargetAtTime(1, now, FADE_TIME);

    setIsPlayingHistory(true);
    isPlayingHistoryRef.current = true;
    spectrumRef.current?.setHistoricalMode(true);

    const analyser = histAnalyserRef.current;
    if (analyser) {
      const buf = new Float32Array(analyser.fftSize);
      const pumpWaveform = () => {
        if (!isPlayingHistoryRef.current) return;
        analyser.getFloatTimeDomainData(buf);
        waveformSamplesRef.current = new Float32Array(buf);
        histWaveformRafRef.current = requestAnimationFrame(pumpWaveform);
      };
      histWaveformRafRef.current = requestAnimationFrame(pumpWaveform);
    }

    try {
      await player.startPlayback({
        chunks: [...manifest],
        targetRow,
      });
    } catch (err) {
      console.warn("[hist-audio] startPlayback failed:", err);
      stopHistoricalPlayback();
    }
  }, [streamId, stopHistoricalPlayback]);

  const connect = useCallback(async () => {
    ensureAudio().catch(() => {});
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
      lastWsDataAtRef.current = performance.now();
      perfAudioRef.current.start();
      perfResampleRef.current.start();
      resourceMonRef.current.start();
      setNoAudio(false);
      setNoWaterfall(false);
      const wasReconnect = reconnectAttemptRef.current > 0;
      const attempts = reconnectAttemptRef.current;
      reconnectBackoffRef.current = 1000;
      reconnectAttemptRef.current = 0;
      streamLog.info(wasReconnect ? "ws.reconnect" : "ws.connect", wasReconnect ? `after ${attempts} attempt${attempts !== 1 ? "s" : ""}` : undefined, "client", "wavetoy");
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

      if (silenceWatchdogRef.current) clearInterval(silenceWatchdogRef.current);
      silenceWatchdogRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const silenceMs = performance.now() - lastWsDataAtRef.current;
        if (silenceMs > 10_000) {
          const silenceSec = Math.round(silenceMs / 1000);
          streamLog.warn("ws.silence", `no data for ${silenceSec}s readyState=${ws.readyState} buffered=${ws.bufferedAmount}`, "client", "wavetoy");
        }
      }, 5_000);
    };
    ws.onclose = (ev) => {
      perfAudioRef.current.stop();
      perfResampleRef.current.stop();
      resourceMonRef.current.stop();
      if (silenceWatchdogRef.current) {
        clearInterval(silenceWatchdogRef.current);
        silenceWatchdogRef.current = null;
      }
      const closeMsg = `code=${ev.code} clean=${ev.wasClean}${ev.reason ? ` reason=${ev.reason}` : ""}`;
      if (intentionalCloseRef.current) streamLog.info("ws.close", closeMsg, "client", "wavetoy");
      else streamLog.warn("ws.close", closeMsg, "client", "wavetoy");
      if (intentionalCloseRef.current) {
        setStatus("closed");
        return;
      }
      setStatus("reconnecting");
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (intentionalCloseRef.current) return;
      streamLog.error("ws.error", "connection error", "client", "wavetoy");
      setStatus("error");
    };
    ws.onmessage = (ev) => {
      lastWsDataAtRef.current = performance.now();
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
              useTuningStore.getState().applyRemote(
                s.source_id, s.frequency_khz, s.mode,
                s.bandwidth_low_hz, s.bandwidth_high_hz,
              );
            }

            if (!prefillDoneRef.current && waterfallRef.current) {
              prefillDoneRef.current = true;
              prefillAbortRef.current?.abort();
              const ac = new AbortController();
              prefillAbortRef.current = ac;

              const wf = waterfallRef.current;
              wf.resetLiveFrameCount();
              const source = new RingBufferSource(streamId);
              wf.setChunkSource(source);

              source.fetchRewind().then((rewind) => {
                if (ac.signal.aborted) return;
                wf.loadManifest(rewind.chunks, {
                  sampleRate: rewind.sample_rate,
                  chunkDurationS: rewind.chunk_duration_s,
                }).then(() => {}).catch((err) => {
                  console.error("[wf] loadManifest error:", err);
                });
              }).catch((err) => {
                console.error("[wf] fetchRewind error:", err);
              });
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
            useTuningStore.getState().applyRemote(
              s.source_id, s.frequency_khz, s.mode,
              s.bandwidth_low_hz, s.bandwidth_high_hz,
            );
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
              useTuningStore.getState().applyRemote(
                s.source_id, s.frequency_khz, s.mode,
                s.bandwidth_low_hz, s.bandwidth_high_hz,
              );
            } else if (msg.code === "VALIDATION" && typeof msg.error === "string" && msg.error.includes("not subscribed")) {
              streamLog.warn("ws.resub", "lost topic subscription, re-subscribing", "client", "wavetoy");
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
          } else if (msg.type === "chunk_complete") {
            waterfallRef.current?.onChunkComplete({
              started_at: msg.started_at,
              ended_at: msg.ended_at,
              source_id: msg.source_id,
              wf_frames: msg.wf_frames,
              audio_bytes: msg.audio_bytes,
            });
          } else if (msg.type === "stream_data_stale") {
            const stale = msg.stale === true;
            if (msg.channel === "audio") setNoAudio(stale);
            else if (msg.channel === "waterfall") setNoWaterfall(stale);
          } else if (msg.type === "wf_view_changed") {
            if (msg.start_khz != null && msg.end_khz != null) {
              setViewRemote(msg.start_khz, msg.end_khz);
            }
          } else if (msg.type === "interpreter_output" && msg.payload) {
            const payload = msg.payload as InterpreterOutput;
            if (payload.interpreter === "voice") {
              if (payload.clear) {
                setVoiceChunks([]);
              } else if (payload.text) {
                setVoiceChunks((prev) => [
                  ...prev,
                  { text: payload.text!, receivedAt: Date.now() },
                ]);
              }
              if (payload.progress != null) {
                setVoiceProgress(payload.progress);
              }
            } else {
              if (payload.clear) {
                setMorseText("");
              } else if (payload.text) {
                setMorseText((prev) => prev + payload.text);
              }
              if (payload.wpm) {
                setInterpreterWpm(payload.wpm);
              }
              if (payload.sidetone_hz) {
                setDetectedSidetoneHz(payload.sidetone_hz);
              }
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
        if (droppingStaleRef.current) return;
        const dv = new DataView(ev.data, 1, 8);
        const xBin = dv.getUint32(0, true);
        const zoom = dv.getUint16(4, true);
        const bins = new Uint8Array(ev.data, 9);
        waterfallRef.current?.pushFrame(bins, xBin, zoom);
        const inScrollBack = useScrollBackStore.getState().isInScrollBack;
        if (!isPlayingHistoryRef.current && !inScrollBack) {
          spectrumRef.current?.pushFrame(bins, xBin, zoom);
        }
        return;
      }

      if (packet[0] !== AUDIO_TYPE || packet.length < 3) return;
      if (droppingStaleRef.current) return;
      const t0 = performance.now();
      const pcmBytes = packet.subarray(1);
      const now = t0;
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
      if (!isPlayingHistoryRef.current) {
        const wfBuf = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          wfBuf[i] = pcm[i] / 32768;
        }
        waveformSamplesRef.current = wfBuf;
      }
      const outRate = audioCtxRef.current?.sampleRate ?? 48000;
      const rt0 = performance.now();
      const resampled = resamplePCM(pcm, streamRateRef.current, outRate);
      perfResampleRef.current.record(performance.now() - rt0);
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
      if (histPlayerRef.current?.playing) {
        histPlayerRef.current.pushLiveSamples(resampled);
      }
      perfAudioRef.current.record(performance.now() - t0);
    };
  }, [ensureAudio, appendLogEntry, appendLogEntries, resamplePCM, streamId]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    const attempt = ++reconnectAttemptRef.current;
    const delay = reconnectBackoffRef.current;
    reconnectBackoffRef.current = Math.min(delay * 2, 30000);
    streamLog.info("ws.backoff", `attempt=${attempt} delay=${delay >= 1000 ? `${delay / 1000}s` : `${delay}ms`}`, "client", "wavetoy");
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, delay);
  }, [connect]);

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
      view_locked?: boolean;
    },
  ) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      streamLog.warn("ws.patch", "skipped, ws not open", "client", "wavetoy");
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

  const captureWav = useCallback(async (): Promise<ArrayBuffer> => {
    const authToken = getToken();
    const res = await fetch(`/api/streams/${streamId}/capture`, {
      method: "POST",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    const disposition = res.headers.get("Content-Disposition");
    let filename = "capture.wav";
    if (disposition) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }
    setCaptureFilename(filename);
    return res.arrayBuffer();
  }, [streamId]);

  const onCapture = () => {
    setCropModalOpen(true);
  };


  const currentSource =
    picker.mapSources.find((s) => s.id === sourceId) ?? null;

  useEffect(() => {
    if (!sourceId || currentSource) return;
    getSource(sourceId)
      .then((s) => picker.appendSources([s]))
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
    if (isInScrollBack) return;
    if (useTuningStore.getState().isRemoteRecent()) return;
    throttledAutoPatch(sourceId, frequency, mode, lo, hi);
  }, [frequency, hi, lo, mode, sourceId, throttledAutoPatch, isInScrollBack]);

  useEffect(() => {
    spectrumRef.current?.setPassband(frequency, lo, hi);
  }, [frequency, lo, hi]);

  // Sync overflow permission with view lock state
  useEffect(() => {
    useBandViewStore.getState().setAllowOverflow(viewLocked);
  }, [viewLocked]);

  // When locked, re-center view on frequency whenever it changes.
  // Remote updates use setViewRemote (animated, no outbound wf_config).
  // Local updates use setView (instant, triggers wf_config for data coverage).
  useEffect(() => {
    if (!viewLocked) return;
    const store = useBandViewStore.getState();
    const span = store.endKHz - store.startKHz;
    const newStart = frequency - span / 2;
    const isRemote = useTuningStore.getState().isRemoteRecent();
    if (isRemote) {
      store.setViewRemote(newStart, newStart + span);
    } else {
      store.setView(newStart, newStart + span);
    }
  }, [frequency, viewLocked]);

  useEffect(() => {
    waterfallRef.current?.setCurrentTuning(frequency, lo, hi);
  }, [frequency, lo, hi]);

  useEffect(() => {
    spectrumRef.current?.setHistoricalMode(isInScrollBack || isPlayingHistory);
  }, [isInScrollBack, isPlayingHistory]);

  // When locked, panning/zooming should retune to center
  useEffect(() => {
    if (!viewLocked || isInScrollBack) return;
    return useBandViewStore.subscribe((state) => {
      if (state.viewSource !== "local") return;
      const center = (state.startKHz + state.endKHz) / 2;
      const rounded = Math.round(center * 100) / 100;
      if (Math.abs(rounded - frequency) > 0.01) {
        useTuningStore.getState().setFrequency(rounded);
      }
    });
  }, [viewLocked, frequency, isInScrollBack]);

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
        picker.setSelectedSourceId(s.source_id);
        useTuningStore.getState().applyRemote(
          s.source_id, s.frequency_khz, s.mode,
          s.bandwidth_low_hz, s.bandwidth_high_hz,
        );
      })
      .catch(() => { setNotFound(true); });

    picker.loadAll();
    refreshRecentSources();
    void connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (silenceWatchdogRef.current) {
        clearInterval(silenceWatchdogRef.current);
        silenceWatchdogRef.current = null;
      }
      intentionalCloseRef.current = true;
      wsRef.current?.close();
      prefillAbortRef.current?.abort();
      histPlayerRef.current?.destroy();
      histPlayerRef.current = null;
      useTuningStore.getState().reset();
    };
  }, [connect, streamId]);

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
              isFavorite={currentSource ? picker.favoriteIds.has(currentSource.id) : false}
              onToggleFavorite={picker.toggleFavorite}
              onNotesChanged={picker.refreshNotes}
              action={
                <Tooltip content="Swap source">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Swap source"
                    onClick={() => {
                      picker.setSelectedSourceId(sourceId);
                      picker.setHoveredSource(null);
                      picker.skipProbe();
                      setSourceDrawerOpen(true);
                      picker.ensureMapSources();
                    }}
                  >
                    <RotateCwIcon className="size-3.5" />
                  </Button>
                </Tooltip>
              }
            />
            <FallbackSection
              stream={stream}
              streamId={streamId}
              wsRef={wsRef}
              audioCtxRef={audioCtxRef}
              gainNodeRef={gainNodeRef}
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
                  Source history
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
                          className={`h-6 gap-1 px-2 text-[10px] transition-opacity duration-200 ${isInScrollBack ? "opacity-40 pointer-events-none" : ""}`}
                          onClick={() => sendPatch({ source_id: src.id })}
                        >
                          <RotateCwIcon className="size-3" />
                          Swap
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
      icon: <AudioWaveformIcon className="size-4" />,
      label: "Filters",
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
      icon: <LanguagesIcon className="size-4" />,
      label: "Interpreter",
      content: (
        <InterpreterPanel
          config={stream?.interpreter ?? {}}
          onConfigChange={(cfg) => sendPatch({ interpreter: cfg })}
          morseText={morseText}
          voiceChunks={voiceChunks}
          wpm={interpreterWpm}
          detectedSidetoneHz={detectedSidetoneHz}
          voiceProgress={voiceProgress}
          onClear={() => {
            setMorseText("");
            setVoiceChunks([]);
          }}
        />
      ),
    },
    {
      id: "logs",
      icon: <ScrollTextIcon className="size-4" />,
      label: "Logs",
      content: <LogsPanel lines={logLines} streamId={streamId} />,
    },
  ], [currentSource, sourceId, stream, streamId, logLines, picker.favoriteIds, picker.toggleFavorite, recentSources, morseText, voiceChunks, interpreterWpm, detectedSidetoneHz, voiceProgress, isInScrollBack]);

  if (notFound) return <ErrorPage code="404" />;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Main area (header + content) ── */}
      <div className="flex min-w-0 flex-1 flex-col">
      {/* ── Top bar ── */}
      <header className="grid h-[54px] shrink-0 items-center border-b bg-background" style={{ gridTemplateColumns: "1fr auto 1fr 54px", paddingLeft: 0, paddingRight: 16, columnGap: 12 }} dir="rtl">
        {/* Right: status + multiplayer + toggle info */}
        <div className="flex items-center gap-3 justify-self-start pl-4" dir="ltr">
          {statusChip && (
            <Tooltip content={statusChip.tooltip} className="normal-case tracking-normal">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                statusChip.color === "red"
                  ? "bg-destructive/15 text-destructive"
                  : statusChip.color === "blue"
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
              }`}>
                {statusChip.label}
              </span>
            </Tooltip>
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
        <div className="flex h-full items-center gap-5 justify-self-center self-stretch" dir="ltr">
          <FrequencyInput
            value={isPlayingHistory && playbackTuning ? playbackTuning.freqKHz : frequency}
            optimistic={!isPlayingHistory && frequency !== confirmedFrequency}
            onSubmit={(kHz) => useTuningStore.getState().setFrequency(kHz)}
            dimmed={isInScrollBack && !isPlayingHistory}
            playbackMode={isPlayingHistory}
          />
          <Tooltip content={viewLocked ? "Unlock view from frequency" : "Lock view to frequency"}>
            <Button
              variant={viewLocked ? "outline" : "ghost"}
              size="icon"
              className="size-8"
              style={isInScrollBack ? { opacity: 0.35, pointerEvents: "none", transition: "opacity 0.2s ease" } : { transition: "opacity 0.2s ease" }}
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
            <div
              className="flex h-8 overflow-hidden rounded-md border border-border"
              style={isInScrollBack ? { pointerEvents: "none" } : undefined}
            >
              {["am", "usb", "lsb", "cw", "nbfm"].map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    const [defaultLo, defaultHi] = MODE_PASSBAND[m] ?? [-4900, 4900];
                    useTuningStore.getState().setMode(m, defaultLo, defaultHi);
                  }}
                  className={`px-3.5 text-xs font-medium transition-colors ${
                    mode === m
                      ? isPlayingHistory
                        ? "text-black"
                        : "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:text-foreground"
                  }`}
                  style={{
                    ...(isInScrollBack && !isPlayingHistory && mode === m ? { opacity: 0.35 } : {}),
                    ...(isPlayingHistory && mode === m ? { backgroundColor: d.displayStatusPlayback, color: "black" } : {}),
                    transition: "opacity 0.2s ease, background-color 0.2s ease, color 0.2s ease",
                  }}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </Tooltip>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Lo</span>
            <Tooltip content="Low cut (Hz)">
              <div className="h-8 w-20 overflow-hidden rounded-md border border-input">
                <Input
                  type="number"
                  min={-6000}
                  max={6000}
                  value={isPlayingHistory && playbackTuning ? playbackTuning.passbandLo : lo}
                  onChange={(e) => useTuningStore.getState().setLo(Number(e.target.value))}
                  className="h-full w-full border-0 text-xs shadow-none focus-visible:ring-0"
                  disabled={isInScrollBack}
                  style={{
                    ...(isInScrollBack && !isPlayingHistory ? { opacity: 0.35 } : {}),
                    ...(isPlayingHistory ? { color: d.displayStatusPlaybackHead } : {}),
                    transition: "opacity 0.2s ease, color 0.2s ease",
                  }}
                />
              </div>
            </Tooltip>
            <Tooltip content="High cut (Hz)">
              <div className="h-8 w-20 overflow-hidden rounded-md border border-input">
                <Input
                  type="number"
                  min={-6000}
                  max={6000}
                  value={isPlayingHistory && playbackTuning ? playbackTuning.passbandHi : hi}
                  onChange={(e) => useTuningStore.getState().setHi(Number(e.target.value))}
                  className="h-full w-full border-0 text-xs shadow-none focus-visible:ring-0"
                  disabled={isInScrollBack}
                  style={{
                    ...(isInScrollBack && !isPlayingHistory ? { opacity: 0.35 } : {}),
                    ...(isPlayingHistory ? { color: d.displayStatusPlaybackHead } : {}),
                    transition: "opacity 0.2s ease, color 0.2s ease",
                  }}
                />
              </div>
            </Tooltip>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Hi</span>
          </div>
        </div>

        {/* Rewind button — 4th column, centered in 54px timeline column */}
        <div className="flex h-full items-center justify-center border-r" dir="ltr">
          <Tooltip content="Rewind">
            <Button
              variant={timelineOpen ? "outline" : "ghost"}
              size="icon"
              className="size-8"
              style={timelineOpen ? { borderColor: d.displayScrollbackAccent, color: d.displayScrollbackAccent, backgroundColor: d.displayScrollbackAccentSoft } : { color: d.displayScrollbackAccent }}
              onClick={() => setTimelineOpen((v) => !v)}
            >
              <RewindIcon className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* ── Content: timeline + waterfall + sidebar ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── Timeline bar ── */}
        {timelineOpen && <WaterfallTimeline
        ref={timelineRef}
        spectrumHeight={spectrumHeight}
        isPlayingHistory={isPlayingHistory}
        onScrollOffset={(offset) => {
          waterfallRef.current?.setScrollOffset(offset);
          useScrollBackStore.getState().set(offset > 0);
          const wf = waterfallRef.current;
          if (offset === 0) {
            if (isPlayingHistory) {
              stopHistoricalPlayback();
              waterfallRef.current?.scrollToLive();
            }
            histWFSourceRef.current = null;
            histWFCacheRef.current = null;
            lastScrollBackSpectrumRowRef.current = null;
            return;
          }
          if (offset > 0 && !isPlayingHistory && !isSyncingScrollRef.current) {
            if (!histWFSourceRef.current) {
              histWFSourceRef.current = new RingBufferSource(streamId);
            }
            if (wf) {
              const lookahead = Math.round(wf.visibleRows() * 0.1);
              const headRow = wf.rowCount() - offset - lookahead;
              lastScrollBackSpectrumRowRef.current = headRow;
              pushSpectrumForRow(headRow);
            }
          }
          if (isPlayingHistory && !isSyncingScrollRef.current) {
            if (wf) {
              const lookahead = Math.round(wf.visibleRows() * 0.1);
              const headRow = wf.rowCount() - offset - lookahead;
              wf.setPlaybackHead(headRow);
              pushSpectrumForRow(headRow);
            }
            const player = histPlayerRef.current;
            if (!player?.playing) return;
            player.scrubPause();

            const ctrl = ensureScrubController();
            if (ctrl && wf) {
              ctrl.setChunks([...wf.chunkManifest()]);
              const ctx = audioCtxRef.current;
              if (ctx) {
                const now = ctx.currentTime;
                scrubGainRef.current?.gain.cancelScheduledValues(now);
                scrubGainRef.current?.gain.setTargetAtTime(1, now, 0.01);
              }
              const la = Math.round(wf.visibleRows() * 0.1);
              ctrl.scrub(
                wf.rowCount() - offset - la,
                !isDraggingTimelineRef.current,
              );
            }
          }
        }}
        onSnapToLive={() => {
          if (isPlayingHistory) stopHistoricalPlayback();
          else {
            histWFSourceRef.current = null;
            histWFCacheRef.current = null;
            lastScrollBackSpectrumRowRef.current = null;
          }
          useScrollBackStore.getState().set(false);
          waterfallRef.current?.scrollToLive();
        }}
        onDragStart={() => {
          isDraggingTimelineRef.current = true;
        }}
        onDragEnd={() => {
          isDraggingTimelineRef.current = false;
          if (!isPlayingHistory) return;
          const wf = waterfallRef.current;
          const player = histPlayerRef.current;
          if (!wf || !player?.playing) return;
          const so = wf.getScrollOffset();
          const ctrl = scrubControllerRef.current;
          if (ctrl) {
            ctrl.settle();
          } else {
            const lookahead = Math.round(wf.visibleRows() * 0.1);
            const targetRow = wf.rowCount() - so - lookahead;
            player.seek(targetRow);
          }
        }}
      />}
        {/* ── Waterfall area ── */}
        <BandViewport
          className="min-w-0 flex-1"
          zoomToCenter={viewLocked}
          onClickFrequency={isInScrollBack ? undefined : (freqKHz) => {
            useTuningStore.getState().setFrequency(Math.round(freqKHz * 100) / 100);
          }}
          onWFConfigChange={isInScrollBack ? undefined : (zoom, centerKHz, viewStartKHz, viewEndKHz) => {
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
          <div
            className="absolute inset-0 z-[25] pointer-events-none transition-opacity duration-200 ease-out"
            style={{
              opacity: isInScrollBack || isPlayingHistory ? 0 : 1,
            }}
          >
            <TuningOverlay
              centerFreqKHz={isPlayingHistory && playbackTuning ? playbackTuning.freqKHz : frequency}
              passbandLowHz={isPlayingHistory && playbackTuning ? playbackTuning.passbandLo : lo}
              passbandHighHz={isPlayingHistory && playbackTuning ? playbackTuning.passbandHi : hi}
              centerLocked={viewLocked}
              animate={freqAnimating}
              playbackMode={isPlayingHistory}
              onFrequencyChange={isPlayingHistory ? undefined : viewLocked ? undefined : (kHz) => useTuningStore.getState().setFrequency(kHz)}
              onBandwidthChange={isPlayingHistory ? undefined : (newLo, newHi) => {
                const s = useTuningStore.getState();
                s.setLo(newLo);
                s.setHi(newHi);
              }}
            />
          </div>
          <SpectrumDisplay
            ref={spectrumRef}
            className="w-full shrink-0"
            style={{ height: spectrumHeight }}
          />
          <FrequencyScale onResizeStart={onSpectrumResizeStart} hideTopBorder={spectrumHeight <= 0} />
          <WaterfallDisplay
            ref={waterfallRef}
            timelineRef={timelineRef}
            className="min-h-0 flex-1"
            onPlay={startHistoricalPlayback}
            onStop={stopHistoricalPlayback}
            isPlaying={isPlayingHistory}
            showTuningTrace={timelineOpen}
            onOverlayState={(state) => {
              if (isPlayingHistoryRef.current || state.scrollOffset <= 0) return;
              const visibleRows = Math.ceil(state.height / state.rowScale);
              const lookahead = Math.round(visibleRows * 0.1);
              const headRow = state.totalRows - state.scrollOffset - lookahead;
              if (headRow === lastScrollBackSpectrumRowRef.current) return;
              lastScrollBackSpectrumRowRef.current = headRow;
              if (!histWFSourceRef.current) {
                histWFSourceRef.current = new RingBufferSource(streamId);
              }
              pushSpectrumForRow(headRow);
            }}
          />
        </BandViewport>
      </div>
      </div>

      {/* Right: info panel (full height) */}
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
              <Tooltip content="Ring buffer">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={status !== "connected"}
                  onClick={onCapture}
                >
                  <ScissorsIcon className="size-4" />
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
            sources={picker.mapSources}
            favoriteSources={picker.favoriteSources}
            favoriteIds={picker.favoriteIds}
            counts={picker.mapCounts}
            selectedSourceId={picker.selectedSourceId}
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
              selectedSourceId={picker.selectedSourceId}
              favoriteIds={picker.favoriteIds}
              showCounts={false}
              className="h-full"
              onHoverSource={picker.setHoveredSource}
              onSelectSource={picker.selectAndProbe}
              onDeselectSource={() => {
                picker.setSelectedSourceId(sourceId);
                picker.skipProbe();
              }}
            />
          )
        }
        sidebar={
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              {(picker.displayedSource ?? currentSource) ? (
                <SourceSection
                  source={(picker.displayedSource ?? currentSource)!}
                  sourceId={picker.selectedSourceId}
                  isFavorite={picker.favoriteIds.has((picker.displayedSource ?? currentSource)!.id)}
                  onToggleFavorite={picker.toggleFavorite}
                  onNotesChanged={picker.refreshNotes}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">No source selected</p>
                </div>
              )}
            </div>
            {picker.selectedSourceId && picker.selectedSourceId !== sourceId && (
              <div className="shrink-0 border-t border-border/80 p-3">
                <ProbeStatusBox
                  status={picker.probeStatus}
                  result={picker.probeResult}
                  actionLabel={<><RotateCwIcon className="size-3" /> Swap</>}
                  onAction={() => {
                    patchSource(picker.selectedSourceId);
                    setSourceDrawerOpen(false);
                    picker.clearSelection();
                  }}
                  onSkip={picker.skipProbe}
                />
              </div>
            )}
          </>
        }
      />

      <AudioCropModal
        open={cropModalOpen}
        onClose={() => setCropModalOpen(false)}
        fetchWav={captureWav}
        title="Ring Buffer"
        defaultFilename={captureFilename}
        streamGainRef={gainNodeRef}
      />
    </div>
  );
}
