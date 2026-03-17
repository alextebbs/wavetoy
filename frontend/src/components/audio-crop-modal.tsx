import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computePeaks, encodeWav, formatTime } from "@/lib/wav-utils";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  DownloadIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type AudioCropModalProps = {
  open: boolean;
  onClose: () => void;
  fetchWav: () => Promise<ArrayBuffer>;
  title?: string;
  defaultFilename?: string;
  streamGainRef?: React.RefObject<GainNode | null>;
};

type Peaks = { min: Float32Array; max: Float32Array };

const HANDLE_HIT_PX = 8;
const MIN_REGION_FRAC = 0.005;

export function AudioCropModal({
  open,
  onClose,
  fetchWav,
  title = "Audio Capture",
  defaultFilename = "capture.wav",
  streamGainRef,
}: AudioCropModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);

  const [playheadFrac, setPlayheadFrac] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [cropEnabled, setCropEnabled] = useState(false);
  const [regionStart, setRegionStart] = useState(0);
  const [regionEnd, setRegionEnd] = useState(1);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef(0);
  const playStartTimeRef = useRef(0);
  const playStartFracRef = useRef(0);

  const dragRef = useRef<"start" | "end" | null>(null);

  const regionStartRef = useRef(regionStart);
  regionStartRef.current = regionStart;
  const regionEndRef = useRef(regionEnd);
  regionEndRef.current = regionEnd;
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const playheadFracRef = useRef(playheadFrac);
  playheadFracRef.current = playheadFrac;
  const cropEnabledRef = useRef(cropEnabled);
  cropEnabledRef.current = cropEnabled;
  const audioBufferRef = useRef(audioBuffer);
  audioBufferRef.current = audioBuffer;

  // ── Fetch & decode ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setAudioBuffer(null);
    setPeaks(null);
    setPlayheadFrac(0);
    setPlaying(false);
    setCropEnabled(false);
    setRegionStart(0);
    setRegionEnd(1);

    (async () => {
      try {
        const ctx = audioCtxRef.current ?? new AudioContext();
        audioCtxRef.current = ctx;
        if (ctx.state !== "running") await ctx.resume();

        const raw = await fetchWav();
        if (cancelled) return;
        const decoded = await ctx.decodeAudioData(raw.slice(0));
        if (cancelled) return;

        setAudioBuffer(decoded);
        const p = computePeaks(decoded.getChannelData(0), 2000);
        setPeaks(p);
      } catch {
        if (!cancelled) setError("Failed to load audio");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, fetchWav]);

  // ── Stream gain ducking ──────────────────────────────────────────────────────

  const duckStream = useCallback(() => {
    const g = streamGainRef?.current;
    if (!g) return;
    g.gain.cancelScheduledValues(g.context.currentTime);
    g.gain.setTargetAtTime(0, g.context.currentTime, 0.08);
  }, [streamGainRef]);

  const restoreStream = useCallback(() => {
    const g = streamGainRef?.current;
    if (!g) return;
    g.gain.cancelScheduledValues(g.context.currentTime);
    g.gain.setTargetAtTime(1, g.context.currentTime, 0.15);
  }, [streamGainRef]);

  // ── Stop helpers ────────────────────────────────────────────────────────────

  const killSource = useCallback(() => {
    if (sourceNodeRef.current) {
      sourceNodeRef.current.onended = null;
      try {
        sourceNodeRef.current.stop();
      } catch {
        /* already stopped */
      }
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    killSource();
    setPlaying(false);
    restoreStream();
  }, [killSource, restoreStream]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup on close
  useEffect(() => {
    if (!open) stopPlayback();
  }, [open]);

  // ── Playback engine ─────────────────────────────────────────────────────────

  const startPlaybackFrom = useCallback(
    (frac: number) => {
      const buf = audioBufferRef.current;
      const ctx = audioCtxRef.current;
      if (!buf || !ctx) return;
      if (ctx.state !== "running") ctx.resume();

      killSource();
      duckStream();

      const startOffset = frac * buf.duration;
      if (startOffset >= buf.duration) return;

      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(ctx.destination);
      sourceNodeRef.current = source;

      playStartTimeRef.current = ctx.currentTime;
      playStartFracRef.current = frac;

      source.onended = () => {
        setPlayheadFrac(1);
        stopPlayback();
      };

      source.start(0, startOffset);
      setPlaying(true);
      setPlayheadFrac(frac);

      const tick = () => {
        if (!audioCtxRef.current) return;
        const elapsed =
          audioCtxRef.current.currentTime - playStartTimeRef.current;
        const f = playStartFracRef.current + elapsed / buf.duration;
        setPlayheadFrac(Math.min(f, 1));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [killSource, stopPlayback, duckStream],
  );

  const seekTo = useCallback(
    (frac: number) => {
      setPlayheadFrac(frac);
      if (playingRef.current) {
        startPlaybackFrom(frac);
      }
    },
    [startPlaybackFrom],
  );

  const togglePlay = useCallback(() => {
    if (!audioBufferRef.current) return;

    if (playingRef.current) {
      const ctx = audioCtxRef.current;
      const buf = audioBufferRef.current;
      if (ctx && buf) {
        const elapsed = ctx.currentTime - playStartTimeRef.current;
        const frac = playStartFracRef.current + elapsed / buf.duration;
        setPlayheadFrac(Math.min(frac, 1));
      }
      stopPlayback();
      return;
    }

    let startFrac = playheadFracRef.current;
    if (startFrac >= 0.999) startFrac = 0;
    startPlaybackFrom(startFrac);
  }, [stopPlayback, startPlaybackFrom]);

  // ── Drawing ─────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const pk = peaksRef.current;
    if (!canvas || !pk) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    const numBins = pk.min.length;
    const cropOn = cropEnabledRef.current;
    const rS = regionStartRef.current;
    const rE = regionEndRef.current;

    const drawWaveformSlice = (
      x0: number,
      x1: number,
      color: string,
      fillAlpha: number,
    ) => {
      if (x1 <= x0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, h);
      ctx.clip();

      ctx.fillStyle = color;
      ctx.globalAlpha = fillAlpha;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      for (let x = 0; x < w; x++) {
        const bin = Math.min(Math.floor((x / w) * numBins), numBins - 1);
        ctx.lineTo(x, midY - pk.max[bin] * midY * 0.9);
      }
      for (let x = w - 1; x >= 0; x--) {
        const bin = Math.min(Math.floor((x / w) * numBins), numBins - 1);
        ctx.lineTo(x, midY - pk.min[bin] * midY * 0.9);
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = Math.min(fillAlpha + 0.3, 1);
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const bin = Math.min(Math.floor((x / w) * numBins), numBins - 1);
        const val = (pk.max[bin] + pk.min[bin]) / 2;
        const y = midY - val * midY * 0.9;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    const WF_COLOR = "hsl(168 52% 48%)";

    if (cropOn) {
      const selL = Math.round(rS * w);
      const selR = Math.round(rE * w);

      drawWaveformSlice(0, selL, WF_COLOR, 0.15);
      drawWaveformSlice(selR, w, WF_COLOR, 0.15);
      drawWaveformSlice(selL, selR, WF_COLOR, 0.5);

      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(0, 0, selL, h);
      ctx.fillRect(selR, 0, w - selR, h);

      for (const xPos of [selL, selR]) {
        ctx.fillStyle = "hsl(168 52% 68%)";
        ctx.fillRect(xPos - 1, 0, 2, h);

        const triH = 8;
        const triW = 6;
        ctx.beginPath();
        ctx.moveTo(xPos, 0);
        ctx.lineTo(xPos - triW, triH);
        ctx.lineTo(xPos + triW, triH);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(xPos, h);
        ctx.lineTo(xPos - triW, h - triH);
        ctx.lineTo(xPos + triW, h - triH);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      drawWaveformSlice(0, w, WF_COLOR, 0.4);
    }

    // Center line
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Playhead
    const phx = Math.round(playheadFracRef.current * w);
    ctx.fillStyle = "hsl(0 0% 95%)";
    ctx.fillRect(phx - 0.5, 0, 1, h);
    ctx.beginPath();
    ctx.moveTo(phx, 6);
    ctx.lineTo(phx - 4, 0);
    ctx.lineTo(phx + 4, 0);
    ctx.closePath();
    ctx.fill();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: draw reads from refs; extra deps trigger redraws
  useEffect(() => {
    draw();
  }, [draw, peaks, regionStart, regionEnd, playing, playheadFrac, cropEnabled]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => draw());
    obs.observe(el);
    return () => obs.disconnect();
  }, [draw]);

  // ── Mouse interaction ───────────────────────────────────────────────────────

  const xToFrac = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!peaks) return;
      e.preventDefault();
      const frac = xToFrac(e.clientX);
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (cropEnabledRef.current) {
        const w = canvas.getBoundingClientRect().width;
        const hitPx = HANDLE_HIT_PX / w;

        if (Math.abs(frac - regionStartRef.current) < hitPx) {
          dragRef.current = "start";
          return;
        }
        if (Math.abs(frac - regionEndRef.current) < hitPx) {
          dragRef.current = "end";
          return;
        }
      }

      seekTo(frac);
    },
    [peaks, xToFrac, seekTo],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const frac = xToFrac(e.clientX);

      if (d === "start") {
        setRegionStart(
          Math.max(0, Math.min(frac, regionEndRef.current - MIN_REGION_FRAC)),
        );
      } else {
        setRegionEnd(
          Math.min(1, Math.max(frac, regionStartRef.current + MIN_REGION_FRAC)),
        );
      }
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [xToFrac]);

  // ── Cursor ──────────────────────────────────────────────────────────────────

  const [cursor, setCursor] = useState("pointer");

  const handleMouseMoveCanvas = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current) return;
      if (!peaks || !canvasRef.current) {
        setCursor("default");
        return;
      }
      if (cropEnabledRef.current) {
        const frac = xToFrac(e.clientX);
        const w = canvasRef.current.getBoundingClientRect().width;
        const hitPx = HANDLE_HIT_PX / w;
        if (
          Math.abs(frac - regionStartRef.current) < hitPx ||
          Math.abs(frac - regionEndRef.current) < hitPx
        ) {
          setCursor("col-resize");
          return;
        }
      }
      setCursor("pointer");
    },
    [peaks, xToFrac],
  );

  // ── Keyboard ────────────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const step = e.shiftKey ? 0.05 : 0.01;
        seekTo(Math.max(0, playheadFracRef.current - step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 0.05 : 0.01;
        seekTo(Math.min(1, playheadFracRef.current + step));
      }
    },
    [togglePlay, seekTo],
  );

  // ── Download ────────────────────────────────────────────────────────────────

  const downloadAudio = useCallback(() => {
    if (!audioBuffer) return;
    const dlStart = cropEnabled ? regionStart : 0;
    const dlEnd = cropEnabled ? regionEnd : 1;
    const startSample = Math.floor(dlStart * audioBuffer.length);
    const endSample = Math.ceil(dlEnd * audioBuffer.length);
    const wav = encodeWav(audioBuffer, startSample, endSample);

    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const baseName = defaultFilename.replace(/\.wav$/i, "");
    const isFull = dlStart < 0.001 && dlEnd > 0.999;
    a.download = isFull
      ? `${baseName}.wav`
      : `${baseName}-crop-${formatTime(dlStart * audioBuffer.duration).replace(":", "m")}s-${formatTime(dlEnd * audioBuffer.duration).replace(":", "m")}s.wav`;

    a.click();
    URL.revokeObjectURL(url);
  }, [audioBuffer, cropEnabled, regionStart, regionEnd, defaultFilename]);

  // ── Computed values ─────────────────────────────────────────────────────────

  const duration = audioBuffer?.duration ?? 0;
  const currentTime = playheadFrac * duration;
  const hasCrop = cropEnabled && (regionStart > 0.001 || regionEnd < 0.999);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => !next && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-[fade-in_220ms_ease-out] data-[state=closed]:animate-[fade-out_180ms_ease-in]" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center p-4 outline-none"
          onKeyDown={handleKeyDown}
        >
          <div className="flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border bg-background p-5 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between">
              <DialogPrimitive.Title className="text-sm font-medium tracking-wide uppercase text-foreground">
                {title}
              </DialogPrimitive.Title>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            <DialogPrimitive.Description className="sr-only">
              Play, crop and download audio
            </DialogPrimitive.Description>

            {loading && (
              <div className="flex h-40 items-center justify-center">
                <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {error && (
              <div className="flex h-40 items-center justify-center text-sm text-destructive">
                {error}
              </div>
            )}

            {audioBuffer && peaks && (
              <>
                {/* Waveform */}
                <div
                  ref={containerRef}
                  className="relative overflow-hidden rounded-lg border border-border/60 bg-black/40"
                >
                  <canvas
                    ref={canvasRef}
                    className="block h-36 w-full"
                    style={{ cursor }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMoveCanvas}
                  />
                </div>

                {/* Time */}
                <div className="flex items-center justify-between px-1 text-xs tabular-nums text-muted-foreground">
                  <span className="text-foreground">
                    {formatTime(currentTime)}
                  </span>
                  {hasCrop && (
                    <span>
                      crop {formatTime(regionStart * duration)} –{" "}
                      {formatTime(regionEnd * duration)}
                    </span>
                  )}
                  <span>{formatTime(duration)}</span>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={togglePlay}
                    className="gap-1.5"
                  >
                    {playing ? (
                      <PauseIcon className="size-3.5" />
                    ) : (
                      <PlayIcon className="size-3.5" />
                    )}
                    {playing ? "Pause" : "Play"}
                  </Button>

                  <div className="flex-1" />

                  <Button
                    variant={cropEnabled ? "outline" : "ghost"}
                    size="sm"
                    onClick={() => setCropEnabled((v) => !v)}
                    className={cn(
                      "gap-1.5",
                      cropEnabled && "border-primary/50 bg-primary/10",
                    )}
                  >
                    <ScissorsIcon className="size-3.5" />
                    Crop
                  </Button>

                  {hasCrop && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRegionStart(0);
                        setRegionEnd(1);
                      }}
                    >
                      Reset
                    </Button>
                  )}

                  <Button
                    variant="default"
                    size="sm"
                    onClick={downloadAudio}
                    className="gap-1.5"
                  >
                    <DownloadIcon className="size-3.5" />
                    {hasCrop ? "Download Crop" : "Download"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
