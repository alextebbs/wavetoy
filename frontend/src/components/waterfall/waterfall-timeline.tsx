import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { PauseIcon, PlayIcon, RadioIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { OverlayState } from "./waterfall-renderer";
import type { WaterfallMarker } from "./waterfall-overlay";

const HEADER_HEIGHT = 54;
const BAR_WIDTH = HEADER_HEIGHT;
const FREQ_SCALE_HEIGHT = 42;
const ICON_BTN_HEIGHT = 28;
const TRACK_PADDING = 4;
const MIN_THUMB_HEIGHT = 12;

interface WaterfallTimelineProps {
  spectrumHeight: number;
  onScrollOffset: (offset: number) => void;
  onSnapToLive: () => void;
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
}

export interface WaterfallTimelineHandle {
  update(state: OverlayState, markers: WaterfallMarker[]): void;
}

export const WaterfallTimeline = forwardRef<
  WaterfallTimelineHandle,
  WaterfallTimelineProps
>(function WaterfallTimeline(
  { spectrumHeight, onScrollOffset, onSnapToLive, onPlay, onStop, isPlaying = false },
  ref,
) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const tickContainerRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<OverlayState | null>(null);
  const markersRef = useRef<WaterfallMarker[]>([]);
  const [isLive, setIsLive] = useState(true);
  const isDraggingRef = useRef(false);

  const computeThumbLayout = useCallback(
    (state: OverlayState, trackHeight: number) => {
      const { maxScrollOffset, logicalScrollOffset, height, rowScale } = state;
      if (maxScrollOffset <= 0) return { thumbTop: 0, thumbHeight: trackHeight, totalRange: 1 };

      const visibleRows = Math.ceil(height / rowScale);
      const totalRange = maxScrollOffset + visibleRows;
      const thumbHeight = Math.max(MIN_THUMB_HEIGHT, (visibleRows / totalRange) * trackHeight);
      const thumbTop = Math.max(0, (logicalScrollOffset / totalRange) * trackHeight);
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

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = stateRef.current;
      if (!state || state.maxScrollOffset <= 0) return;
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 30;
      const step = Math.round(dy * 1.5);
      const current = state.logicalScrollOffset;
      const next = Math.max(0, Math.min(current + step, state.maxScrollOffset));
      if (next !== current) onScrollOffset(next);
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
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
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [computeThumbLayout, onScrollOffset]
  );

  const spacerHeight = spectrumHeight + FREQ_SCALE_HEIGHT - ICON_BTN_HEIGHT;

  return (
    <div
      className="flex flex-col shrink-0 select-none border-r bg-background"
      style={{ width: BAR_WIDTH }}
    >
      {/* LIVE icon button — aligned with header */}
      <div
        className="flex shrink-0 items-center justify-center border-b"
        style={{ height: HEADER_HEIGHT }}
      >
        <Tooltip content="Snap to live">
          <Button
            variant={isLive ? "outline" : "ghost"}
            size="icon"
            onClick={onSnapToLive}
            className={isLive ? "text-green-400 border-green-400/40 bg-green-400/10" : ""}
          >
            <RadioIcon className="size-4" />
          </Button>
        </Tooltip>
      </div>

      {/* Play/Stop icon button */}
      <div
        className="flex shrink-0 items-center justify-center"
        style={{
          height: ICON_BTN_HEIGHT,
          opacity: isLive ? 0 : 1,
          pointerEvents: isLive ? "none" : "auto",
        }}
      >
        <Tooltip content={isPlaying ? "Stop playback" : "Play historical audio"}>
          <Button
            variant={isPlaying ? "outline" : "ghost"}
            size="icon-sm"
            onClick={() => isPlaying ? onStop?.() : onPlay?.()}
            className={isPlaying ? "text-blue-400 border-blue-400/40 bg-blue-400/10" : ""}
          >
            {isPlaying ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          </Button>
        </Tooltip>
      </div>

      {/* Spacer — covers spectrum + freq scale area */}
      <div className="shrink-0" style={{ height: Math.max(0, spacerHeight) }} />

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
          className="absolute cursor-grab border border-border bg-primary/25 active:cursor-grabbing"
          style={{
            left: 3,
            right: 3,
            borderRadius: 3,
            minHeight: MIN_THUMB_HEIGHT,
            display: "none",
          }}
          onPointerDown={handleThumbPointerDown}
        />
      </div>
    </div>
  );
});
