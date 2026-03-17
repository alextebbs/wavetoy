import { Volume2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SnapshotPlayButtonProps {
  fetchAudio: () => Promise<ArrayBuffer>;
  audioCtxRef: React.RefObject<AudioContext | null>;
  gainNodeRef: React.RefObject<GainNode | null>;
  size?: number;
  className?: string;
  tooltip?: string;
}

export function SnapshotPlayButton({
  fetchAudio,
  audioCtxRef,
  gainNodeRef,
  size = 24,
  className = "",
  tooltip,
}: SnapshotPlayButtonProps) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const snapshotGainRef = useRef<GainNode | null>(null);
  const rafRef = useRef(0);

  const stopPlayback = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (snapshotGainRef.current) {
      snapshotGainRef.current.disconnect();
      snapshotGainRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setState("idle");
  }, []);

  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, [stopPlayback]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const midY = h / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const style = getComputedStyle(canvas);
    const color = style.color || "#fff";
    const windowSize = Math.min(32, bufferLength);
    const offset = Math.floor((bufferLength - windowSize) / 2);
    const samplesPerPx = windowSize / w;
    const amp = 4;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    for (let x = 0; x < w; x++) {
      const idx = offset + Math.min(Math.floor(x * samplesPerPx), windowSize - 1);
      const v = (dataArray[idx] - 128) / 128;
      ctx.lineTo(x, midY - v * midY * amp);
    }
    ctx.lineTo(w, midY);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const idx = offset + Math.min(Math.floor(x * samplesPerPx), windowSize - 1);
      const v = (dataArray[idx] - 128) / 128;
      const y = midY - v * midY * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    rafRef.current = requestAnimationFrame(drawWaveform);
  }, []);

  const handleClick = useCallback(async () => {
    if (state === "playing") {
      const g = gainNodeRef.current;
      if (g) {
        g.gain.cancelScheduledValues(g.context.currentTime);
        g.gain.setTargetAtTime(1, g.context.currentTime, 0.08);
      }
      stopPlayback();
      return;
    }

    if (state === "loading") return;

    setState("loading");

    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioContext({ latencyHint: "interactive" });
        (audioCtxRef as React.MutableRefObject<AudioContext | null>).current = ctx;
      }
      if (ctx.state !== "running") await ctx.resume();

      const arrayBuffer = await fetchAudio();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const streamGain = gainNodeRef.current;
      if (streamGain) {
        streamGain.gain.cancelScheduledValues(ctx.currentTime);
        streamGain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      }

      await new Promise((r) => setTimeout(r, 120));

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const snapGain = ctx.createGain();
      snapGain.gain.value = 1;
      snapshotGainRef.current = snapGain;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(snapGain);
      snapGain.connect(analyser);
      analyser.connect(ctx.destination);
      sourceRef.current = source;

      source.onended = () => {
        stopPlayback();
        if (streamGain) {
          streamGain.gain.cancelScheduledValues(streamGain.context.currentTime);
          streamGain.gain.setTargetAtTime(1, streamGain.context.currentTime, 0.15);
        }
      };

      source.start();
      setState("playing");
      rafRef.current = requestAnimationFrame(drawWaveform);
    } catch {
      setState("idle");
      const streamGain = gainNodeRef.current;
      if (streamGain) {
        streamGain.gain.cancelScheduledValues(streamGain.context.currentTime);
        streamGain.gain.setTargetAtTime(1, streamGain.context.currentTime, 0.08);
      }
    }
  }, [state, fetchAudio, audioCtxRef, gainNodeRef, stopPlayback, drawWaveform]);

  const iconSize = Math.round(size * 0.5);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className={`inline-flex shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground ${className}`}
      style={{ width: size, height: size }}
      title={tooltip}
    >
      {state === "playing" ? (
        <div
          className="relative overflow-hidden rounded-sm border border-current/30 text-foreground"
          style={{ width: size - 2, height: size - 2 }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: size - 2,
              height: size - 2,
              display: "block",
              color: "inherit",
            }}
            width={Math.round((size - 2) * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1))}
            height={Math.round((size - 2) * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1))}
          />
        </div>
      ) : state === "loading" ? (
        <div
          className="animate-spin rounded-full border-2 border-current border-t-transparent"
          style={{ width: iconSize, height: iconSize }}
        />
      ) : (
        <Volume2Icon style={{ width: iconSize, height: iconSize }} />
      )}
    </button>
  );
}
