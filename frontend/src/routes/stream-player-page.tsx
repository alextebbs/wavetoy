import { SourceDetailsPanel } from "@/components/source-details-panel";
import { SourceMapPicker } from "@/components/source-map-picker";
import { BottomDrawer } from "@/components/ui/bottom-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type MapSourceCounts,
  type Source,
  type Stream,
  deleteStream,
  getMapSources,
  getStream,
} from "@/lib/api";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

const AUDIO_TYPE = 0x02;

type ResamplerState = {
  carryPos: number;
  lastSample: number;
  hasLast: boolean;
  firFactor: number;
  firTaps: Float32Array;
  firTail: Float32Array;
};

type LogLine = {
  id: string;
  text: string;
};

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

export function StreamPlayerPage() {
  const { streamId } = useParams({ from: "/streams/$streamId" });
  const navigate = useNavigate();
  const [stream, setStream] = useState<Stream | null>(null);
  const [status, setStatus] = useState("idle");
  const [deleting, setDeleting] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [frequency, setFrequency] = useState(10000);
  const [mode, setMode] = useState("usb");
  const [lo, setLo] = useState(300);
  const [hi, setHi] = useState(2400);
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

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const hpFilterRef = useRef<BiquadFilterNode | null>(null);
  const lpFilterRef = useRef<BiquadFilterNode | null>(null);
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

  const log = useCallback((line: string) => {
    setLogLines((prev) => [
      ...prev.slice(-120),
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: `[${new Date().toLocaleTimeString()}] ${line}`,
      },
    ]);
  }, []);

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
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 80;
      hp.Q.value = Math.SQRT1_2;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 3000;
      lp.Q.value = Math.SQRT1_2;
      node.connect(hp);
      hp.connect(lp);
      lp.connect(ctx.destination);
      audioCtxRef.current = ctx;
      workletRef.current = node;
      hpFilterRef.current = hp;
      lpFilterRef.current = lp;
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
    if (wsRef.current) {
      wsRef.current.close();
    }
    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/streams/${streamId}/ws`,
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
      log("connected");
    };
    ws.onclose = () => {
      setStatus("closed");
      log("socket closed");
    };
    ws.onerror = () => {
      setStatus("error");
      log("socket error");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as {
            type?: string;
            stream?: Stream;
            sample_rate?: number;
            error?: string;
            code?: string;
          };
          if (msg.type === "connected") {
            if (msg.sample_rate) streamRateRef.current = msg.sample_rate;
            if (msg.stream) {
              lastAutoPatchRef.current = encodeControlPatch(
                msg.stream.source_id,
                msg.stream.frequency_khz,
                msg.stream.mode,
                msg.stream.bandwidth_low_hz,
                msg.stream.bandwidth_high_hz,
              );
              setStream(msg.stream);
              setSourceId(msg.stream.source_id);
              setFrequency(msg.stream.frequency_khz);
              setMode(msg.stream.mode);
              setLo(msg.stream.bandwidth_low_hz);
              setHi(msg.stream.bandwidth_high_hz);
            }
            log("session ready");
          } else if (msg.type === "stream_updated" && msg.stream) {
            if (msg.sample_rate) streamRateRef.current = msg.sample_rate;
            lastAutoPatchRef.current = encodeControlPatch(
              msg.stream.source_id,
              msg.stream.frequency_khz,
              msg.stream.mode,
              msg.stream.bandwidth_low_hz,
              msg.stream.bandwidth_high_hz,
            );
            setStream(msg.stream);
            setSourceId(msg.stream.source_id);
            setFrequency(msg.stream.frequency_khz);
            setMode(msg.stream.mode);
            setLo(msg.stream.bandwidth_low_hz);
            setHi(msg.stream.bandwidth_high_hz);
            log("stream updated");
          } else if (msg.type === "error") {
            log(`error: ${msg.error} (${msg.code})`);
          }
        } catch {
          log(`text: ${ev.data}`);
        }
        return;
      }

      const packet = new Uint8Array(ev.data);
      if (packet.length < 3 || packet[0] !== AUDIO_TYPE) return;
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
  }, [ensureAudio, log, resamplePCM, streamId]);

  const sendPatch = (
    patch: {
      source_id?: string;
      frequency_khz?: number;
      mode?: string;
      bandwidth_low_hz?: number;
      bandwidth_high_hz?: number;
    },
    logLine?: string,
  ) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log("not connected");
      return;
    }
    ws.send(
      JSON.stringify({
        type: "patch",
        patch,
      }),
    );
    if (logLine) {
      log(logLine);
    }
  };

  const patchSource = (nextSourceID: string) => {
    sendPatch({ source_id: nextSourceID }, "source change sent");
  };

  const onDeleteStream = async () => {
    if (!window.confirm("Delete this stream? This cannot be undone.")) {
      return;
    }
    setDeleting(true);
    try {
      await deleteStream(streamId);
      wsRef.current?.close();
      await navigate({ to: "/" });
    } catch (e) {
      log(`delete failed: ${String(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  const refreshMapSources = useCallback(async () => {
    setMapLoading(true);
    try {
      const payload = await getMapSources();
      setMapSources(payload.included_sources);
      setMapCounts(payload.counts);
    } catch (e) {
      log(`map source load failed: ${String(e)}`);
    } finally {
      setMapLoading(false);
    }
  }, [log]);

  const selectedSource =
    mapSources.find((s) => s.id === pendingSourceId) ?? null;
  const displayedSource = hoveredSource ?? selectedSource;

  useEffect(() => {
    const ctx = audioCtxRef.current;
    const hp = hpFilterRef.current;
    const lp = lpFilterRef.current;
    if (!ctx || !hp || !lp) {
      return;
    }

    const normalizedMode = mode.toLowerCase();
    const absLo = Math.abs(lo);
    const absHi = Math.abs(hi);
    let hpHz =
      normalizedMode === "am" ? 70 : Math.max(80, Math.min(650, absLo || 120));
    let lpHz = Math.max(1200, Math.min(5000, absHi || 3000));
    if (normalizedMode === "cw") {
      hpHz = Math.max(250, Math.min(1000, absLo || 400));
      lpHz = Math.max(900, Math.min(2600, absHi || 1400));
    }
    hp.frequency.setTargetAtTime(hpHz, ctx.currentTime, 0.015);
    lp.frequency.setTargetAtTime(lpHz, ctx.currentTime, 0.015);
  }, [hi, lo, mode]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const patch = {
      source_id: sourceId,
      frequency_khz: Number(frequency),
      mode,
      bandwidth_low_hz: Number(lo),
      bandwidth_high_hz: Number(hi),
    };
    const encoded = JSON.stringify(patch);
    if (encoded === lastAutoPatchRef.current) {
      return;
    }
    sendPatch(patch);
    lastAutoPatchRef.current = encoded;
  }, [frequency, hi, lo, mode, sourceId]);

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
      .catch((e) => log(`stream load failed: ${String(e)}`));

    void refreshMapSources();
    void connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect, log, refreshMapSources, streamId]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div className="flex items-end justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-xl font-semibold">
            {stream?.name ?? "Stream Player"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Status: {status} · ID: {streamId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={deleting}
            onClick={() => void onDeleteStream()}
          >
            {deleting ? "Deleting..." : "Delete"}
          </Button>
          <Button variant="secondary" onClick={() => void connect()}>
            Reconnect
          </Button>
          <Link to="/">
            <Button variant="ghost">Back</Button>
          </Link>
        </div>
      </div>

      <section className="space-y-2 border-b pb-6">
        <div className="font-xanh-mono text-center text-5xl leading-none font-normal tracking-tight md:text-7xl">
          {frequency.toFixed(3)}
        </div>
        <div className="text-center text-xs uppercase tracking-widest text-muted-foreground">
          kHz
        </div>
      </section>

      <section className="space-y-4 border-b pb-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Controls
        </h2>
        <div className="grid grid-cols-1 gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPendingSourceId("");
                setHoveredSource(null);
                setSourceDrawerOpen(true);
                if (mapSources.length === 0 && !mapLoading) {
                  void refreshMapSources();
                }
              }}
            >
              Change Source
            </Button>
            <span className="text-xs text-muted-foreground">
              {mapCounts.included} shown / {mapCounts.omitted} omitted
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Current source ID: {sourceId}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Frequency (kHz)</Label>
              <span className="text-sm text-muted-foreground">
                {frequency.toFixed(3)}
              </span>
            </div>
            <Input
              type="text"
              value={frequency}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) {
                  setFrequency(next);
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Mode" />
              </SelectTrigger>
              <SelectContent>
                {["am", "usb", "lsb", "cw", "nbfm"].map((m) => (
                  <SelectItem key={m} value={m}>
                    {m.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            type="number"
            value={lo}
            onChange={(e) => setLo(Number(e.target.value))}
            placeholder="Bandwidth low (Hz)"
          />
          <Input
            type="number"
            value={hi}
            onChange={(e) => setHi(Number(e.target.value))}
            placeholder="Bandwidth high (Hz)"
          />
        </div>
      </section>

      <section className="space-y-2 border-b pb-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Stream Details
        </h2>
        <p className="text-sm text-muted-foreground">
          {stream
            ? `${stream.name} · ${stream.frequency_khz} kHz ${stream.mode} [${stream.bandwidth_low_hz}, ${stream.bandwidth_high_hz}]`
            : "Loading stream..."}
        </p>
        <p className="text-xs text-muted-foreground">
          Tenant: {stream?.tenant_id ?? "tenant_default"}
        </p>
      </section>

      <section className="space-y-2 border-b pb-6">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Source
        </h2>
        <SourceDetailsPanel
          source={selectedSource}
          selectedSourceId={sourceId}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          Logs
        </h2>
        <div className="h-56 overflow-auto border p-3 text-xs text-muted-foreground">
          {logLines.map((line) => (
            <div key={line.id}>{line.text}</div>
          ))}
        </div>
      </section>

      <BottomDrawer
        open={sourceDrawerOpen}
        onClose={() => setSourceDrawerOpen(false)}
        className="h-[95vh]"
        hideHeader
      >
        <div className="h-full">
          <div className="flex h-full">
            <div className="min-w-0 flex-1">
              {mapLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading map sources...
                </div>
              ) : (
                <SourceMapPicker
                  sources={mapSources}
                  counts={mapCounts}
                  selectedSourceId={pendingSourceId}
                  showCounts={false}
                  className="h-full"
                  onHoverSource={setHoveredSource}
                  onSelectSource={(source) => {
                    setPendingSourceId(source.id);
                  }}
                />
              )}
            </div>
            <aside className="h-full w-[380px] shrink-0 border-l border-border/80 px-4 py-4 md:px-6">
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1 overflow-auto">
                  <SourceDetailsPanel
                    source={displayedSource}
                    selectedSourceId={pendingSourceId}
                    counts={mapCounts}
                    showPickerSummary
                  />
                </div>
                <div className="mt-3 pt-3">
                  <div className="flex items-center justify-end">
                    <Button
                      disabled={
                        !pendingSourceId || pendingSourceId === sourceId
                      }
                      onClick={() => {
                        patchSource(pendingSourceId);
                        setSourceDrawerOpen(false);
                      }}
                    >
                      Change
                    </Button>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </BottomDrawer>
    </div>
  );
}
