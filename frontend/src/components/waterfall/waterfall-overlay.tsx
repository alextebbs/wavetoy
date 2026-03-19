import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useThemeStore } from "@/lib/theme";
import type { OverlayState } from "./waterfall-renderer";
import type { TuningTracePoint } from "./waterfall-renderer-base";

export interface WaterfallMarker {
  id: string;
  row: number;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface WaterfallOverlayHandle {
  addMarker(marker: WaterfallMarker): void;
  removeMarker(id: string): void;
  update(state: OverlayState): void;
  updateTuningTrace(points: TuningTracePoint[]): void;
}

const MONO_FONT = '"Iosevka Charon Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const EXPECTED_WF_PER_CHUNK = 1360;
const FULLNESS_THRESHOLD = 0.8;

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toISOString();
  } catch {
    return iso;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

interface DiagInfo {
  time: string;
  wfLabel: string;
  wfTooltip: string;
  wfColor: string;
  sndLabel: string;
  sndTooltip: string;
  sndColor: string;
  inProgress: boolean;
}

function buildDiagInfo(
  marker: WaterfallMarker,
  colors: { ok: string; warn: string; pending: string },
): DiagInfo {
  const meta = marker.metadata;
  const complete = meta?.complete as boolean | undefined;
  const inProgress = complete === false;

  const time = meta?.started_at
    ? formatTimestamp(meta.started_at as string)
    : marker.label;

  const wfFrames = (meta?.wf_frames as number | undefined) ?? 0;
  const wfPct = EXPECTED_WF_PER_CHUNK > 0
    ? wfFrames / EXPECTED_WF_PER_CHUNK
    : 1;
  const wfColor = inProgress
    ? colors.pending
    : wfPct < FULLNESS_THRESHOLD ? colors.warn : colors.ok;
  const wfTooltip = `WF: ${wfFrames} / ${EXPECTED_WF_PER_CHUNK} frames (${Math.round(wfPct * 100)}%)`;

  const audioBytes = (meta?.audio_bytes as number | undefined) ?? 0;
  const audioExpected = (meta?.audio_expected as number | undefined) ?? 0;
  const sndPct = audioExpected > 0 ? audioBytes / audioExpected : 1;
  const sndPctRounded = Math.round(sndPct * 100);
  const sndColor = inProgress
    ? colors.pending
    : sndPct < FULLNESS_THRESHOLD ? colors.warn : colors.ok;
  const sndTooltip = audioExpected > 0
    ? `SND: ${formatBytes(audioBytes)} / ${formatBytes(audioExpected)} (${sndPctRounded}%)`
    : `SND: ${formatBytes(audioBytes)}`;

  const wfWarn = !inProgress && wfPct < FULLNESS_THRESHOLD;
  const sndWarn = !inProgress && sndPct < FULLNESS_THRESHOLD;

  return {
    time,
    wfLabel: wfWarn ? `WF ${wfFrames}` : "WF",
    wfTooltip,
    wfColor,
    sndLabel: sndWarn ? `SND ${sndPctRounded}%` : "SND",
    sndTooltip,
    sndColor,
    inProgress,
  };
}

let spinnerStyleInjected = false;
function ensureSpinnerStyle() {
  if (spinnerStyleInjected) return;
  spinnerStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = "@keyframes wf-spin{to{transform:rotate(360deg)}}";
  document.head.appendChild(style);
}

interface WaterfallOverlayProps {
  isPlaying?: boolean;
  showTuningTrace?: boolean;
  onPlaybackHeadState?: (state: { visible: boolean; isPlaying: boolean }) => void;
}

export const WaterfallOverlayLayer = forwardRef<WaterfallOverlayHandle, WaterfallOverlayProps>(
  function WaterfallOverlayLayer({ isPlaying = false, showTuningTrace = true, onPlaybackHeadState }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const traceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const markersRef = useRef<Map<string, WaterfallMarker>>(new Map());
    const nodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
    const onPlaybackHeadStateRef = useRef(onPlaybackHeadState);
    const isPlayingRef = useRef(isPlaying);
    const showTuningTraceRef = useRef(showTuningTrace);
    onPlaybackHeadStateRef.current = onPlaybackHeadState;
    isPlayingRef.current = isPlaying;
    showTuningTraceRef.current = showTuningTrace;

    const themeRef = useRef(useThemeStore.getState().theme.display);
    useEffect(
      () => useThemeStore.subscribe(() => {
        themeRef.current = useThemeStore.getState().theme.display;
      }),
      [],
    );

    function createMarkerNode(marker: WaterfallMarker): HTMLDivElement {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.top = "0";
      el.style.left = "0";
      el.style.width = "100%";
      el.style.display = "none";
      el.style.pointerEvents = "none";
      el.style.willChange = "transform";

      const line = document.createElement("div");
      line.style.position = "absolute";
      line.style.top = "0";
      line.style.left = "0";
      line.style.right = "0";
      line.style.height = "1px";
      line.style.backgroundColor = "rgba(255, 255, 255, 0.25)";
      line.style.mixBlendMode = "screen";
      line.style.opacity = "0";
      line.style.transition = "opacity 0.15s ease";
      el.appendChild(line);

      const pill = document.createElement("div");
      pill.style.position = "absolute";
      pill.style.bottom = "0";
      pill.style.right = "0";
      pill.style.fontSize = "10px";
      pill.style.lineHeight = "14px";
      pill.style.padding = "1px 5px";
      pill.style.borderRadius = "3px 0 0 0";
      pill.style.backgroundColor = "rgba(0, 0, 0, 0.55)";
      pill.style.whiteSpace = "nowrap";
      pill.style.pointerEvents = "auto";
      pill.style.fontFamily = MONO_FONT;
      pill.style.letterSpacing = "0.01em";
      pill.style.textTransform = "uppercase";
      pill.style.display = "flex";
      pill.style.alignItems = "center";
      pill.style.gap = "6px";
      pill.style.transition = "border-radius 0.15s ease";

      const d = themeRef.current;
      const info = buildDiagInfo(marker, {
        ok: d.displayMarkerOk,
        warn: d.displayMarkerWarn,
        pending: d.displayMarkerPending,
      });

      const timeSpan = document.createElement("span");
      timeSpan.style.color = "rgba(255, 255, 255, 0.7)";
      timeSpan.textContent = info.time;
      pill.appendChild(timeSpan);

      const wfSpan = document.createElement("span");
      wfSpan.style.color = info.wfColor;
      wfSpan.style.cursor = "default";
      wfSpan.textContent = info.wfLabel;
      wfSpan.title = info.wfTooltip;
      pill.appendChild(wfSpan);

      const sndSpan = document.createElement("span");
      sndSpan.style.color = info.sndColor;
      sndSpan.style.cursor = "default";
      sndSpan.textContent = info.sndLabel;
      sndSpan.title = info.sndTooltip;
      pill.appendChild(sndSpan);

      if (info.inProgress) {
        ensureSpinnerStyle();
        const spinner = document.createElement("span");
        spinner.style.display = "inline-block";
        spinner.style.width = "8px";
        spinner.style.height = "8px";
        spinner.style.borderRadius = "50%";
        spinner.style.border = "1.5px solid rgba(160, 160, 160, 0.3)";
        spinner.style.borderTopColor = "rgba(160, 160, 160, 0.8)";
        spinner.style.animation = "wf-spin 0.8s linear infinite";
        spinner.style.flexShrink = "0";
        pill.appendChild(spinner);
      }

      pill.addEventListener("mouseenter", () => {
        line.style.opacity = "1";
        pill.style.borderRadius = "0";
      });
      pill.addEventListener("mouseleave", () => {
        line.style.opacity = "0";
        pill.style.borderRadius = "3px 0 0 0";
      });

      el.appendChild(pill);

      return el;
    }

    useImperativeHandle(ref, () => ({
      addMarker(marker: WaterfallMarker) {
        const existing = nodesRef.current.get(marker.id);
        if (existing) existing.remove();
        markersRef.current.set(marker.id, marker);
        const node = createMarkerNode(marker);
        nodesRef.current.set(marker.id, node);
        containerRef.current?.appendChild(node);
      },

      removeMarker(id: string) {
        markersRef.current.delete(id);
        const node = nodesRef.current.get(id);
        if (node) {
          node.remove();
          nodesRef.current.delete(id);
        }
      },

      update(state: OverlayState) {
        const { totalRows, scrollOffset, rowScale, height, dpr, playbackRow } = state;
        const cssHeight = height / dpr;
        const traceVisible = showTuningTraceRef.current;

        for (const [id, marker] of markersRef.current) {
          const node = nodesRef.current.get(id);
          if (!node) continue;

          if (!traceVisible) {
            node.style.display = "none";
            continue;
          }

          const canvasY = (totalRows - marker.row - scrollOffset) * rowScale;
          const cssY = canvasY / dpr;

          if (cssY < -20 || cssY > cssHeight + 20) {
            node.style.display = "none";
          } else {
            node.style.display = "";
            node.style.transform = `translateY(${cssY}px)`;
          }
        }

        const showHead = playbackRow !== null || scrollOffset > 0;
        onPlaybackHeadStateRef.current?.({ visible: showHead, isPlaying: isPlayingRef.current });
      },

      updateTuningTrace(points: TuningTracePoint[]) {
        const container = containerRef.current;
        if (!container) return;

        if (!showTuningTraceRef.current) {
          const existing = traceCanvasRef.current;
          if (existing) {
            const ctx = existing.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, existing.width, existing.height);
          }
          return;
        }

        const d = themeRef.current;
        let canvas = traceCanvasRef.current;
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.style.position = "absolute";
          canvas.style.inset = "0";
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.pointerEvents = "none";
          container.insertBefore(canvas, container.firstChild);
          traceCanvasRef.current = canvas;
        }

        const rect = container.getBoundingClientRect();
        const cssW = rect.width;
        const cssH = rect.height;
        const dpr = window.devicePixelRatio || 1;
        const pxW = Math.round(cssW * dpr);
        const pxH = Math.round(cssH * dpr);

        if (canvas.width !== pxW || canvas.height !== pxH) {
          canvas.width = pxW;
          canvas.height = pxH;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, pxW, pxH);

        if (points.length < 2) return;

        ctx.save();
        ctx.scale(dpr, dpr);

        // Passband fill
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const x = p.loX * cssW;
          if (i === 0) ctx.moveTo(x, p.yCss);
          else ctx.lineTo(x, p.yCss);
        }
        for (let i = points.length - 1; i >= 0; i--) {
          const p = points[i];
          ctx.lineTo(p.hiX * cssW, p.yCss);
        }
        ctx.closePath();
        ctx.fillStyle = d.displayScrollbackAccentSoft;
        ctx.fill();

        // Passband edges
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = d.displayStatusPlaybackMuted;
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const x = p.loX * cssW;
          if (i === 0) ctx.moveTo(x, p.yCss);
          else ctx.lineTo(x, p.yCss);
        }
        ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const x = p.hiX * cssW;
          if (i === 0) ctx.moveTo(x, p.yCss);
          else ctx.lineTo(x, p.yCss);
        }
        ctx.stroke();

        // Center frequency line
        ctx.lineWidth = 1;
        ctx.strokeStyle = d.displayStatusPlaybackLine;
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const x = p.centerX * cssW;
          if (i === 0) ctx.moveTo(x, p.yCss);
          else ctx.lineTo(x, p.yCss);
        }
        ctx.stroke();

        ctx.restore();
      },
    }));

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 z-[25] pointer-events-none overflow-hidden"
      />
    );
  }
);
