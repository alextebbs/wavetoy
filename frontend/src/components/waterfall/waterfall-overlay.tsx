import { forwardRef, useImperativeHandle, useRef } from "react";
import type { OverlayState } from "./waterfall-renderer";

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
}

const MONO_FONT = '"Iosevka Charon Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const EXPECTED_WF_PER_CHUNK = 1360;
const FULLNESS_THRESHOLD = 0.8;
const COLOR_OK = "rgba(94, 234, 212, 0.85)";
const COLOR_WARN = "rgba(239, 68, 68, 0.9)";
const COLOR_PENDING = "rgba(160, 160, 160, 0.7)";

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

function buildDiagInfo(marker: WaterfallMarker): DiagInfo {
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
    ? COLOR_PENDING
    : wfPct < FULLNESS_THRESHOLD ? COLOR_WARN : COLOR_OK;
  const wfTooltip = `WF: ${wfFrames} / ${EXPECTED_WF_PER_CHUNK} frames (${Math.round(wfPct * 100)}%)`;

  const audioBytes = (meta?.audio_bytes as number | undefined) ?? 0;
  const audioExpected = (meta?.audio_expected as number | undefined) ?? 0;
  const sndPct = audioExpected > 0 ? audioBytes / audioExpected : 1;
  const sndColor = inProgress
    ? COLOR_PENDING
    : sndPct < FULLNESS_THRESHOLD ? COLOR_WARN : COLOR_OK;
  const sndTooltip = audioExpected > 0
    ? `SND: ${formatBytes(audioBytes)} / ${formatBytes(audioExpected)} (${Math.round(sndPct * 100)}%)`
    : `SND: ${formatBytes(audioBytes)}`;

  return {
    time,
    wfLabel: "WF",
    wfTooltip,
    wfColor,
    sndLabel: "SND",
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

function createPlaybackHeadEl(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.left = "0";
  el.style.width = "100%";
  el.style.display = "none";
  el.style.pointerEvents = "none";
  el.style.willChange = "transform";
  el.style.zIndex = "10";

  const line = document.createElement("div");
  line.style.position = "absolute";
  line.style.top = "0";
  line.style.left = "0";
  line.style.right = "0";
  line.style.height = "1px";
  line.style.backgroundColor = "rgba(94, 234, 212, 0.8)";
  line.style.boxShadow = "0 0 4px rgba(94, 234, 212, 0.5), 0 0 8px rgba(94, 234, 212, 0.2)";
  el.appendChild(line);

  return el;
}

export const WaterfallOverlayLayer = forwardRef<WaterfallOverlayHandle>(
  function WaterfallOverlayLayer(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const markersRef = useRef<Map<string, WaterfallMarker>>(new Map());
    const nodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
    const headRef = useRef<HTMLDivElement | null>(null);

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
      el.appendChild(line);

      const pill = document.createElement("div");
      pill.style.position = "absolute";
      pill.style.top = "2px";
      pill.style.left = "4px";
      pill.style.fontSize = "10px";
      pill.style.lineHeight = "14px";
      pill.style.padding = "1px 5px";
      pill.style.borderRadius = "3px";
      pill.style.backgroundColor = "rgba(0, 0, 0, 0.55)";
      pill.style.whiteSpace = "nowrap";
      pill.style.pointerEvents = "auto";
      pill.style.fontFamily = MONO_FONT;
      pill.style.letterSpacing = "0.01em";
      pill.style.textTransform = "uppercase";
      pill.style.display = "flex";
      pill.style.alignItems = "center";
      pill.style.gap = "6px";

      const info = buildDiagInfo(marker);

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

        for (const [id, marker] of markersRef.current) {
          const node = nodesRef.current.get(id);
          if (!node) continue;

          const canvasY = (totalRows - marker.row - scrollOffset) * rowScale;
          const cssY = canvasY / dpr;

          if (cssY < -20 || cssY > cssHeight + 20) {
            node.style.display = "none";
          } else {
            node.style.display = "";
            node.style.transform = `translateY(${cssY}px)`;
          }
        }

        const showHead = state.headShiftPx > 0;
        let head = headRef.current;
        if (showHead) {
          if (!head) {
            head = createPlaybackHeadEl();
            headRef.current = head;
            containerRef.current?.appendChild(head);
          }
          const headY = playbackRow !== null
            ? (totalRows - playbackRow - scrollOffset) * rowScale / dpr
            : state.headShiftPx;
          if (headY < -2 || headY > cssHeight + 2) {
            head.style.display = "none";
          } else {
            head.style.display = "";
            head.style.transform = `translateY(${headY}px)`;
          }
        } else if (head) {
          head.style.display = "none";
        }
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
