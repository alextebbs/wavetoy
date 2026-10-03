import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { ArrowUpIcon } from "lucide-react";
import { useScrollBackStore } from "@/lib/scroll-back-store";
import { useThemeStore } from "@/lib/theme";
import { Tooltip } from "@/components/ui/tooltip";
import { FREQ_SCALE_HEIGHT } from "./frequency-scale";
import type { ChunkManager } from "@/lib/chunk-manager";
import type { OverlayState } from "./waterfall-renderer-base";
import type { WaterfallMarker } from "@/lib/chunk-manager";

// See MINIMAP.md for the full spatial model and alignment proof.

const BAR_WIDTH = 54;
const PLAYBACK_HEAD_FRACTION = 0.10;
const MIN_VIEWPORT_PX = 20;
// Fixed compression: 1 minimap CSS pixel = this many waterfall rows.
const MINIMAP_COMPRESSION = 15;

interface WaterfallMinimapProps {
  spectrumHeight: number;
  manager: ChunkManager;
  isPlayingHistory?: boolean;
  onSnapToLive: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onRequestRepaint?: () => void;
}

export interface WaterfallMinimapHandle {
  update(state: OverlayState, markers: WaterfallMarker[]): void;
}

interface MinimapLayout {
  visibleRows: number;
  totalRange: number;
  scale: number;
  viewportPx: number;
  viewportTop: number;
  contentHeight: number;
}

function computeLayout(state: OverlayState, trackHeight: number): MinimapLayout {
  const visibleRows = Math.ceil(state.height / state.rowScale);
  const totalRange = state.maxScrollOffset + visibleRows;

  if (totalRange <= 0 || visibleRows <= 0) {
    return {
      visibleRows: Math.max(visibleRows, 1),
      totalRange: 1,
      scale: 1,
      viewportPx: trackHeight,
      viewportTop: 0,
      contentHeight: trackHeight,
    };
  }

  const scale = 1 / MINIMAP_COMPRESSION;

  const viewportPx = Math.max(
    MIN_VIEWPORT_PX,
    Math.min(trackHeight, visibleRows * scale),
  );
  const viewportTop = PLAYBACK_HEAD_FRACTION * (trackHeight - viewportPx);
  const tailPx = Math.max(0, (1 - PLAYBACK_HEAD_FRACTION) * (trackHeight - viewportPx));
  const contentHeight = viewportTop + totalRange * scale + tailPx;

  return { visibleRows, totalRange, scale, viewportPx, viewportTop, contentHeight };
}

// ── Tick element pool ──────────────────────────────────────────────────────────

const TICK_COLOR = "hsl(var(--foreground) / 0.3)";
const GAP_BG = "hsl(var(--destructive) / 0.12)";
const GAP_BORDER = "hsl(var(--destructive) / 0.35)";
const DATA_END_COLOR = "hsl(var(--foreground) / 0.4)";
const ACTIVITY_COLOR = "hsl(142 71% 45% / 0.5)";    // green — signal present
const NOISE_COLOR = "hsl(var(--foreground) / 0.06)";  // dim — noise only

function createTick(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.right = "0";
  el.style.height = "1px";
  el.style.pointerEvents = "none";
  el.style.backgroundColor = TICK_COLOR;
  return el;
}

function createGapBand(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.right = "0";
  el.style.pointerEvents = "none";
  el.style.backgroundColor = GAP_BG;
  el.style.borderTop = `1px solid ${GAP_BORDER}`;
  el.style.borderBottom = `1px solid ${GAP_BORDER}`;
  el.style.boxSizing = "border-box";
  return el;
}

function createActivityBand(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.right = "0";
  el.style.width = "5px";
  el.style.pointerEvents = "none";
  el.style.borderRadius = "1px";
  return el;
}

function createDataBoundaryLine(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.left = "4px";
  el.style.right = "4px";
  el.style.height = "1px";
  el.style.pointerEvents = "none";
  el.style.backgroundColor = DATA_END_COLOR;
  return el;
}

export const WaterfallMinimap = forwardRef<
  WaterfallMinimapHandle,
  WaterfallMinimapProps
>(function WaterfallMinimap(
  { spectrumHeight, manager, isPlayingHistory = false, onSnapToLive, onDragStart, onDragEnd, onRequestRepaint },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const headLineRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<OverlayState | null>(null);
  const markersRef = useRef<WaterfallMarker[]>([]);
  const isInScrollBack = useScrollBackStore((s) => s.isInScrollBack);
  const scrollingRef = useRef(false);
  const suppressScrollRef = useRef(false);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Managed DOM pools
  const tickPoolRef = useRef<HTMLDivElement[]>([]);
  const gapPoolRef = useRef<HTMLDivElement[]>([]);
  const activityPoolRef = useRef<HTMLDivElement[]>([]);
  const dataStartLineRef = useRef<HTMLDivElement | null>(null);
  const dataEndLineRef = useRef<HTMLDivElement | null>(null);
  const liveDotRef = useRef<HTMLDivElement | null>(null);

  const updateVisuals = useCallback(() => {
    const state = stateRef.current;
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    const viewport = viewportRef.current;
    const headLine = headLineRef.current;
    if (!state || !scroll || !inner || !viewport || !headLine) return;

    const trackHeight = scroll.clientHeight;
    if (trackHeight <= 0) return;

    const layout = computeLayout(state, trackHeight);
    const { scale, viewportPx, viewportTop, contentHeight, visibleRows } = layout;
    const { totalRows, scrollOffset, maxScrollOffset } = state;

    let effectiveContentHeight = contentHeight;

    // Position the viewport box
    viewport.style.top = `${viewportTop}px`;
    viewport.style.height = `${viewportPx}px`;
    viewport.style.display = maxScrollOffset > 0 ? "" : "none";

    const headColor = useThemeStore.getState().theme.display.displayStatusPlaybackHead;
    const headVisible = state.playbackRow !== null || scrollOffset > 0;
    headLine.style.top = `${PLAYBACK_HEAD_FRACTION * viewportPx}px`;
    headLine.style.backgroundColor = headColor;
    headLine.style.opacity = headVisible ? "1" : "0";
    headLine.style.display = maxScrollOffset > 0 ? "" : "none";

    // Sync native scroll (only when not user-scrolling)
    if (!scrollingRef.current) {
      const targetScrollTop = scrollOffset * scale;
      if (Math.abs(scroll.scrollTop - targetScrollTop) > 0.5) {
        suppressScrollRef.current = true;
        scroll.scrollTop = targetScrollTop;
      }
    }

    // ── Partition markers ──
    const markers = markersRef.current;
    const chunkMarkers: WaterfallMarker[] = [];
    const gapMarkers: WaterfallMarker[] = [];
    let hasHistoryEnd = false;
    let dataEndGapStart = 0;
    let dataEndGapCount = 0;

    for (const m of markers) {
      const mtype = m.metadata?.type;
      if (mtype === "gap") {
        gapMarkers.push(m);
      } else if (mtype === "end") {
        hasHistoryEnd = true;
        dataEndGapStart = (m.metadata?.gapStartRow as number) ?? 0;
        dataEndGapCount = (m.metadata?.gapRowCount as number) ?? 0;
      } else {
        chunkMarkers.push(m);
      }
    }

    inner.style.height = `${effectiveContentHeight}px`;

    // ── Chunk boundary ticks ──
    const tickPool = tickPoolRef.current;
    while (tickPool.length > chunkMarkers.length) {
      const el = tickPool.pop()!;
      el.remove();
    }
    while (tickPool.length < chunkMarkers.length) {
      const el = createTick();
      inner.appendChild(el);
      tickPool.push(el);
    }
    for (let i = 0; i < chunkMarkers.length; i++) {
      const rowsFromLive = totalRows - chunkMarkers[i].row;
      tickPool[i].style.top = `${viewportTop + rowsFromLive * scale}px`;
    }

    // ── Activity bands (SNR indicator per chunk) ──
    const activityPool = activityPoolRef.current;
    const chunks = manager.chunks;
    // Count chunks that have SNR data
    let activityCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].inBandSNRdB !== null) activityCount++;
    }
    while (activityPool.length > activityCount) {
      const el = activityPool.pop()!;
      el.remove();
    }
    while (activityPool.length < activityCount) {
      const el = createActivityBand();
      inner.appendChild(el);
      activityPool.push(el);
    }
    let aIdx = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.inBandSNRdB === null) continue;
      const topRowsFromLive = totalRows - c.startRow - c.frameCount;
      const y = viewportTop + topRowsFromLive * scale;
      const h = Math.max(2, c.frameCount * scale);
      const el = activityPool[aIdx++];
      el.style.top = `${y}px`;
      el.style.height = `${h}px`;
      el.style.backgroundColor = c.hasActivity ? ACTIVITY_COLOR : NOISE_COLOR;
    }

    // ── Gap bands ──
    const gapPool = gapPoolRef.current;
    while (gapPool.length > gapMarkers.length) {
      const el = gapPool.pop()!;
      el.remove();
    }
    while (gapPool.length < gapMarkers.length) {
      const el = createGapBand();
      inner.appendChild(el);
      gapPool.push(el);
    }
    for (let i = 0; i < gapMarkers.length; i++) {
      const gm = gapMarkers[i];
      const startRow = (gm.metadata?.gapStartRow as number) ?? 0;
      const rowCount = (gm.metadata?.gapRowCount as number) ?? 0;
      const rowsFromLive = totalRows - startRow;
      const y = viewportTop + rowsFromLive * scale;
      const h = Math.max(2, rowCount * scale);
      gapPool[i].style.top = `${y}px`;
      gapPool[i].style.height = `${h}px`;
    }

    // ── Data boundary lines ──

    const liveColor = useThemeStore.getState().theme.display.displayStatusLive;
    if (!dataStartLineRef.current) {
      dataStartLineRef.current = createDataBoundaryLine();
      dataStartLineRef.current.style.left = "9px";
      dataStartLineRef.current.style.right = "9px";
      inner.appendChild(dataStartLineRef.current);
    }
    dataStartLineRef.current.style.backgroundColor = liveColor;
    dataStartLineRef.current.style.top = `${viewportTop}px`;
    dataStartLineRef.current.style.display = maxScrollOffset > 0 ? "" : "none";

    const dotSize = 8;
    if (!liveDotRef.current) {
      const dot = document.createElement("div");
      dot.style.position = "absolute";
      dot.style.width = `${dotSize}px`;
      dot.style.height = `${dotSize}px`;
      dot.style.borderRadius = "50%";
      dot.style.left = "50%";
      dot.style.transform = "translateX(-50%)";
      dot.style.pointerEvents = "none";
      dot.style.animation = "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite";
      inner.appendChild(dot);
      liveDotRef.current = dot;
    }
    liveDotRef.current.style.backgroundColor = liveColor;
    liveDotRef.current.style.top = `${viewportTop / 2 - dotSize / 2}px`;
    liveDotRef.current.style.display = maxScrollOffset > 0 ? "" : "none";

    if (!dataEndLineRef.current) {
      dataEndLineRef.current = createDataBoundaryLine();
      inner.appendChild(dataEndLineRef.current);
    }
    if (hasHistoryEnd) {
      const endRowsFromLive = totalRows - dataEndGapStart - dataEndGapCount;
      dataEndLineRef.current.style.top = `${viewportTop + endRowsFromLive * scale}px`;
      dataEndLineRef.current.style.display = "";
    } else {
      const totalDataRows = maxScrollOffset + visibleRows;
      dataEndLineRef.current.style.top = `${viewportTop + totalDataRows * scale}px`;
      dataEndLineRef.current.style.display = maxScrollOffset > 0 ? "" : "none";
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      update(state: OverlayState, markers: WaterfallMarker[]) {
        stateRef.current = state;
        markersRef.current = markers;
        updateVisuals();
      },
    }),
    [updateVisuals],
  );

  // ── Native scroll → manager scroll offset ──
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;

    const onScroll = () => {
      if (suppressScrollRef.current) {
        suppressScrollRef.current = false;
        return;
      }
      scrollingRef.current = true;
      if (onDragStart && !scrollEndTimerRef.current) {
        onDragStart();
      }
      if (scrollEndTimerRef.current) clearTimeout(scrollEndTimerRef.current);
      scrollEndTimerRef.current = setTimeout(() => {
        scrollingRef.current = false;
        scrollEndTimerRef.current = null;
        onDragEnd?.();
      }, 150);

      const state = stateRef.current;
      if (!state) return;
      const trackHeight = scroll.clientHeight;
      if (trackHeight <= 0) return;
      const { scale } = computeLayout(state, trackHeight);
      const newOffset = scroll.scrollTop / scale;
      manager.setScrollOffset(newOffset);
      onRequestRepaint?.();
    };

    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      if (scrollEndTimerRef.current) {
        clearTimeout(scrollEndTimerRef.current);
        scrollEndTimerRef.current = null;
      }
    };
  }, [manager, onDragStart, onDragEnd, onRequestRepaint]);

  // Re-layout on resize
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const ro = new ResizeObserver(() => updateVisuals());
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [updateVisuals]);

  // ── Click-to-jump ──
  const handleClick = useCallback((e: React.MouseEvent) => {
    const scroll = scrollRef.current;
    const state = stateRef.current;
    if (!scroll || !state || state.maxScrollOffset <= 0) return;

    const trackHeight = scroll.clientHeight;
    if (trackHeight <= 0) return;
    const { scale, visibleRows, viewportTop } = computeLayout(state, trackHeight);

    const rect = scroll.getBoundingClientRect();
    const clickY = e.clientY - rect.top + scroll.scrollTop;
    const rowsFromLive = (clickY - viewportTop) / scale;
    const offset = rowsFromLive - visibleRows / 2;
    manager.setScrollOffset(offset);
    onRequestRepaint?.();
  }, [manager, onRequestRepaint]);

  const d = useThemeStore((s) => s.theme.display);
  const isLive = !isInScrollBack && !isPlayingHistory;

  const statusColor = isPlayingHistory
    ? { backgroundColor: d.displayStatusPlayback, color: "black" }
    : isInScrollBack
      ? { backgroundColor: d.displayScrollbackAccentSoft, color: d.displayScrollbackAccent }
      : { backgroundColor: "black", color: d.displayStatusLive };

  return (
    <div
      className="flex flex-col shrink-0 select-none border-r bg-background"
      style={{ width: BAR_WIDTH }}
    >
      {spectrumHeight > 0 && (
        <div
          className="flex shrink-0 items-center justify-center overflow-hidden font-semibold text-[10px] uppercase tracking-[0.2em]"
          style={{
            height: spectrumHeight,
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            transform: "rotate(180deg)",
            ...statusColor,
          }}
        >
          {isPlayingHistory ? "playback" : isInScrollBack ? "scrollback" : "Live"}
        </div>
      )}

      <div
        className="flex shrink-0 items-center justify-center"
        style={{
          height: FREQ_SCALE_HEIGHT - 1,
          ...(isLive ? statusColor : { backgroundColor: `${d.displayStatusLive}18`, color: d.displayStatusLive }),
        }}
      >
        {!isLive && (
          <Tooltip content="Snap to live">
            <button
              type="button"
              onClick={onSnapToLive}
              className="flex h-full w-full items-center justify-center transition-opacity hover:opacity-70"
            >
              <ArrowUpIcon className="size-3.5" strokeWidth={2.5} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Minimap track */}
      <div className="relative flex-1 border-t bg-muted/50">
        <div
          ref={viewportRef}
          className="absolute z-20 pointer-events-none"
          style={{
            left: 0,
            right: 0,
            display: "none",
            backgroundColor: d.displayScrollbackAccentSoft,
            boxShadow: `inset 0 1px 0 0 ${d.displayScrollbackAccent}, inset 0 -1px 0 0 ${d.displayScrollbackAccent}`,
          }}
        >
          <div
            ref={headLineRef}
            className="absolute left-0"
            style={{
              right: -1,
              height: 1,
              display: "none",
              transition: "opacity 200ms ease-out",
            }}
          />
        </div>

        <div
          ref={scrollRef}
          className="absolute inset-0 z-10 overflow-y-auto"
          style={{ scrollbarWidth: "none" }}
          onClick={handleClick}
        >
          <div ref={innerRef} className="relative" />
        </div>
      </div>
    </div>
  );
});
