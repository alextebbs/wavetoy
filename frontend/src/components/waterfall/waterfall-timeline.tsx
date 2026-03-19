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
import type { OverlayState } from "./waterfall-renderer";
import type { WaterfallMarker } from "./waterfall-overlay";

const BAR_WIDTH = 54;
const TRACK_PADDING = 4;
const MIN_THUMB_HEIGHT = 12;

interface WaterfallTimelineProps {
  spectrumHeight: number;
  isPlayingHistory?: boolean;
  onScrollOffset: (offset: number) => void;
  onSnapToLive: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export interface WaterfallTimelineHandle {
  update(state: OverlayState, markers: WaterfallMarker[]): void;
}

export const WaterfallTimeline = forwardRef<
  WaterfallTimelineHandle,
  WaterfallTimelineProps
>(function WaterfallTimeline(
  { spectrumHeight, isPlayingHistory = false, onScrollOffset, onSnapToLive, onDragStart, onDragEnd },
  ref,
) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const tickContainerRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<OverlayState | null>(null);
  const markersRef = useRef<WaterfallMarker[]>([]);
  const isInScrollBack = useScrollBackStore((s) => s.isInScrollBack);
  const isDraggingRef = useRef(false);
  const wheelVelocityRef = useRef(0);
  const wheelMomentumRafRef = useRef<number | null>(null);

  const computeThumbLayout = useCallback(
    (state: OverlayState, trackHeight: number) => {
      const { maxScrollOffset, scrollOffset, height, rowScale } = state;
      if (maxScrollOffset <= 0) return { thumbTop: 0, thumbHeight: trackHeight, totalRange: 1 };

      const visibleRows = Math.ceil(height / rowScale);
      const totalRange = maxScrollOffset + visibleRows;
      const thumbHeight = Math.max(MIN_THUMB_HEIGHT, (visibleRows / totalRange) * trackHeight);
      const thumbTop = (scrollOffset / totalRange) * trackHeight;
      return { thumbTop, thumbHeight, totalRange };
    },
    []
  );

  const updateVisuals = useCallback(() => {
    const state = stateRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    const tickContainer = tickContainerRef.current;
    if (!state || !track || !thumb || !tickContainer) return;

    const trackHeight = track.clientHeight - TRACK_PADDING * 2;
    if (trackHeight <= 0) return;

    const { thumbTop, thumbHeight, totalRange } = computeThumbLayout(state, trackHeight);
    thumb.style.top = `${TRACK_PADDING + thumbTop}px`;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.display = state.maxScrollOffset > 0 ? "" : "none";

    const markers = markersRef.current;
    const { totalRows } = state;

    while (tickContainer.children.length > markers.length) {
      tickContainer.lastChild?.remove();
    }
    while (tickContainer.children.length < markers.length) {
      const tick = document.createElement("div");
      tick.style.position = "absolute";
      tick.style.left = "0";
      tick.style.right = "0";
      tick.style.height = "1px";
      tick.style.backgroundColor = "hsl(var(--foreground) / 0.2)";
      tick.style.pointerEvents = "none";
      tickContainer.appendChild(tick);
    }

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const tick = tickContainer.children[i] as HTMLElement;
      if (!tick) continue;

      const markerRowsFromLive = totalRows - marker.row;
      const tickY = TRACK_PADDING + (markerRowsFromLive / totalRange) * trackHeight;
      tick.style.top = `${tickY}px`;
      tick.style.display =
        tickY >= TRACK_PADDING && tickY <= TRACK_PADDING + trackHeight
          ? ""
          : "none";
    }
  }, [computeThumbLayout]);

  useImperativeHandle(
    ref,
    () => ({
      update(state: OverlayState, markers: WaterfallMarker[]) {
        stateRef.current = state;
        markersRef.current = markers;
        updateVisuals();
      },
    }),
    [updateVisuals]
  );

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const ro = new ResizeObserver(() => updateVisuals());
    ro.observe(track);
    return () => ro.disconnect();
  }, [updateVisuals]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    // macOS-like: 1:1 delta response, time-based decay
    const DECAY_PER_16MS = 0.92;
    const MIN_VELOCITY = 0.3;
    const MAX_VELOCITY = 40;

    let lastT = 0;
    const runMomentum = (now: number) => {
      const state = stateRef.current;
      if (!state || state.maxScrollOffset <= 0) {
        wheelVelocityRef.current = 0;
        wheelMomentumRafRef.current = null;
        return;
      }
      let vel = wheelVelocityRef.current;
      if (Math.abs(vel) < MIN_VELOCITY) {
        wheelVelocityRef.current = 0;
        wheelMomentumRafRef.current = null;
        return;
      }
      const dt = lastT > 0 ? now - lastT : 16;
      lastT = now;
      const current = state.scrollOffset;
      const next = Math.max(0, Math.min(current + Math.round(vel), state.maxScrollOffset));
      if (next !== current) onScrollOffset(next);
      wheelVelocityRef.current = vel * Math.pow(DECAY_PER_16MS, dt / 16);
      wheelMomentumRafRef.current = requestAnimationFrame(runMomentum);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = stateRef.current;
      if (!state || state.maxScrollOffset <= 0) return;
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 30;
      wheelVelocityRef.current = Math.max(
        -MAX_VELOCITY,
        Math.min(MAX_VELOCITY, wheelVelocityRef.current + dy)
      );
      if (wheelMomentumRafRef.current === null) {
        lastT = performance.now();
        wheelMomentumRafRef.current = requestAnimationFrame(runMomentum);
      }
    };

    track.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      track.removeEventListener("wheel", onWheel);
      if (wheelMomentumRafRef.current !== null) {
        cancelAnimationFrame(wheelMomentumRafRef.current);
        wheelMomentumRafRef.current = null;
      }
    };
  }, [onScrollOffset]);

  const offsetFromTrackY = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      const state = stateRef.current;
      if (!track || !state) return 0;

      const rect = track.getBoundingClientRect();
      const trackHeight = rect.height - TRACK_PADDING * 2;
      if (trackHeight <= 0) return 0;

      const { totalRange } = computeThumbLayout(state, trackHeight);
      const visibleRows = Math.ceil(state.height / state.rowScale);
      const relativeY = clientY - rect.top - TRACK_PADDING;
      const offset = (relativeY / trackHeight) * totalRange - visibleRows / 2;
      return Math.round(Math.max(0, Math.min(offset, state.maxScrollOffset)));
    },
    [computeThumbLayout]
  );

  const handleTrackClick = useCallback(
    (e: React.PointerEvent) => {
      if (isDraggingRef.current) return;
      onScrollOffset(offsetFromTrackY(e.clientY));
    },
    [offsetFromTrackY, onScrollOffset]
  );

  const handleThumbPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingRef.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      onDragStart?.();

      const track = trackRef.current;
      const thumb = thumbRef.current;
      const state = stateRef.current;
      if (!track || !thumb || !state) return;

      const grabOffsetY = e.clientY - thumb.getBoundingClientRect().top;

      const onMove = (me: PointerEvent) => {
        if (!track || !state) return;
        const rect = track.getBoundingClientRect();
        const trackHeight = rect.height - TRACK_PADDING * 2;
        if (trackHeight <= 0) return;

        const { totalRange } = computeThumbLayout(stateRef.current!, trackHeight);
        const thumbTopY = me.clientY - grabOffsetY - rect.top - TRACK_PADDING;
        const offset = (thumbTopY / trackHeight) * totalRange;
        onScrollOffset(Math.round(Math.max(0, Math.min(offset, stateRef.current!.maxScrollOffset))));
      };
      const onUp = () => {
        isDraggingRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onDragEnd?.();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [computeThumbLayout, onScrollOffset, onDragStart, onDragEnd]
  );

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
      {/* Status indicator — aligned with spectrum area */}
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

      {/* Snap-to-live / spacer — aligned with frequency scale */}
      <div
        className="flex shrink-0 items-center justify-center"
        style={{
          height: FREQ_SCALE_HEIGHT - 1,
          ...(isLive ? statusColor : { backgroundColor: `${d.displayStatusLive}18`, color: d.displayStatusLive }),
        }}
      >
        {isLive ? (
          <span
            className="size-2 rounded-full animate-pulse"
            style={{ backgroundColor: d.displayStatusLive }}
          />
        ) : (
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

      {/* Scrollbar track — aligned with waterfall */}
      <div
        ref={trackRef}
        className="relative flex-1 cursor-ns-resize border-t bg-muted/50"
        onPointerDown={(e) => {
          e.stopPropagation();
          handleTrackClick(e);
        }}
      >
        {/* Chunk boundary ticks */}
        <div
          ref={tickContainerRef}
          className="absolute inset-0"
          style={{ pointerEvents: "none" }}
        />

        {/* Thumb */}
        <div
          ref={thumbRef}
          className="absolute cursor-grab active:cursor-grabbing"
          style={{
            left: 3,
            right: 3,
            borderRadius: 3,
            minHeight: MIN_THUMB_HEIGHT,
            display: "none",
            backgroundColor: d.displayScrollbackAccentSoft,
          }}
          onPointerDown={handleThumbPointerDown}
        />
      </div>
    </div>
  );
});
