import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { OverlayState } from "./waterfall-renderer";
import type { WaterfallMarker } from "./waterfall-overlay";

const BAR_WIDTH = 28;
const LIVE_BUTTON_HEIGHT = 22;
const TRACK_PADDING = 4;
const MIN_THUMB_HEIGHT = 12;

interface WaterfallTimelineProps {
  onScrollOffset: (offset: number) => void;
  onSnapToLive: () => void;
}

export interface WaterfallTimelineHandle {
  update(state: OverlayState, markers: WaterfallMarker[]): void;
}

export const WaterfallTimeline = forwardRef<
  WaterfallTimelineHandle,
  WaterfallTimelineProps
>(function WaterfallTimeline({ onScrollOffset, onSnapToLive }, ref) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const tickContainerRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<OverlayState | null>(null);
  const markersRef = useRef<WaterfallMarker[]>([]);
  const [isLive, setIsLive] = useState(true);
  const isDraggingRef = useRef(false);

  const computeThumbLayout = useCallback(
    (state: OverlayState, trackHeight: number) => {
      const { maxScrollOffset, scrollOffset, height, dpr, rowScale } = state;
      if (maxScrollOffset <= 0) return { thumbTop: 0, thumbHeight: trackHeight };

      const visibleRows = Math.ceil(height / (rowScale * dpr));
      const thumbRatio = Math.min(1, visibleRows / maxScrollOffset);
      const thumbHeight = Math.max(MIN_THUMB_HEIGHT, thumbRatio * trackHeight);
      const scrollableTrack = trackHeight - thumbHeight;
      const scrollRatio = scrollOffset / maxScrollOffset;
      const thumbTop = scrollRatio * scrollableTrack;
      return { thumbTop, thumbHeight };
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

    const { thumbTop, thumbHeight } = computeThumbLayout(state, trackHeight);
    thumb.style.top = `${TRACK_PADDING + thumbTop}px`;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.display = state.maxScrollOffset > 0 ? "" : "none";

    const markers = markersRef.current;
    const { maxScrollOffset, totalRows } = state;

    while (tickContainer.children.length > markers.length) {
      tickContainer.lastChild?.remove();
    }
    while (tickContainer.children.length < markers.length) {
      const tick = document.createElement("div");
      tick.style.position = "absolute";
      tick.style.left = "2px";
      tick.style.right = "2px";
      tick.style.height = "1px";
      tick.style.backgroundColor = "rgba(255, 255, 255, 0.2)";
      tick.style.pointerEvents = "none";
      tickContainer.appendChild(tick);
    }

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const tick = tickContainer.children[i] as HTMLElement;
      if (!tick) continue;

      const markerRowsFromLive = totalRows - marker.row;
      const tickRatio =
        maxScrollOffset > 0 ? markerRowsFromLive / maxScrollOffset : 0;
      const tickY = TRACK_PADDING + tickRatio * trackHeight;
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
        setIsLive(state.isLive);
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

  const offsetFromTrackY = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      const state = stateRef.current;
      if (!track || !state) return 0;

      const rect = track.getBoundingClientRect();
      const trackHeight = rect.height - TRACK_PADDING * 2;
      if (trackHeight <= 0) return 0;

      const { thumbHeight } = computeThumbLayout(state, trackHeight);
      const scrollableTrack = trackHeight - thumbHeight;
      if (scrollableTrack <= 0) return 0;

      const relativeY = clientY - rect.top - TRACK_PADDING - thumbHeight / 2;
      const ratio = Math.max(0, Math.min(1, relativeY / scrollableTrack));
      return Math.round(ratio * state.maxScrollOffset);
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

      const onMove = (me: PointerEvent) => {
        onScrollOffset(offsetFromTrackY(me.clientY));
      };
      const onUp = () => {
        isDraggingRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [offsetFromTrackY, onScrollOffset]
  );

  return (
    <div
      className="flex flex-col shrink-0 select-none bg-black/50"
      style={{ width: BAR_WIDTH }}
    >
      {/* LIVE button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSnapToLive();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="relative flex items-center justify-center shrink-0 cursor-pointer border-none outline-none"
        style={{
          height: LIVE_BUTTON_HEIGHT,
          backgroundColor: isLive
            ? "rgba(34, 197, 94, 0.25)"
            : "rgba(255, 255, 255, 0.08)",
          borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.05em",
            color: isLive
              ? "rgb(74, 222, 128)"
              : "rgba(255, 255, 255, 0.4)",
            textShadow: isLive ? "0 0 6px rgba(74, 222, 128, 0.5)" : "none",
          }}
        >
          LIVE
        </span>
        {isLive && (
          <span
            style={{
              position: "absolute",
              top: 3,
              right: 3,
              width: 4,
              height: 4,
              borderRadius: "50%",
              backgroundColor: "rgb(74, 222, 128)",
              boxShadow: "0 0 4px rgba(74, 222, 128, 0.8)",
            }}
          />
        )}
      </button>

      {/* Scrollbar track */}
      <div
        ref={trackRef}
        className="relative flex-1 cursor-pointer"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
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
            backgroundColor: "rgba(255, 255, 255, 0.2)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            minHeight: MIN_THUMB_HEIGHT,
            display: "none",
          }}
          onPointerDown={handleThumbPointerDown}
        />
      </div>
    </div>
  );
});
