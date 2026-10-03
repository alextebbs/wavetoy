import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { streamLog } from "@/lib/stream-logger";
import { useThemeStore } from "@/lib/theme";
import type { ChunkManager } from "@/lib/chunk-manager";
import { WaterfallRendererGL } from "./waterfall-renderer-gl";
import { WaterfallOverlayLayer, type WaterfallOverlayHandle } from "./waterfall-overlay";
import { PlaybackHead } from "./playback-head";
import type { OverlayState } from "./waterfall-renderer-base";
import type { WaterfallMinimapHandle } from "./waterfall-minimap";
import type { WaterfallHandle } from "./types";

interface WaterfallDisplayGLProps {
  className?: string;
  manager: ChunkManager;
  timelineRef?: React.RefObject<WaterfallMinimapHandle | null>;
  onPlay?: () => void;
  onStop?: () => void;
  isPlaying?: boolean;
  showTuningTrace?: boolean;
  onOverlayState?: (state: OverlayState) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export const WaterfallDisplayGL = forwardRef<
  WaterfallHandle,
  WaterfallDisplayGLProps
>(function WaterfallDisplayGL({ className, manager, timelineRef, onPlay, onStop, isPlaying, showTuningTrace = true, onOverlayState, onDragStart, onDragEnd }, ref) {
  const colorMapName = useThemeStore((s) => s.theme.display.defaultColorMap);
  const containerRef = useRef<HTMLDivElement>(null);
  const onOverlayStateRef = useRef(onOverlayState);
  onOverlayStateRef.current = onOverlayState;
  const [playbackHeadState, setPlaybackHeadState] = useState({ visible: false, isPlaying: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WaterfallRendererGL | null>(null);
  const overlayRef = useRef<WaterfallOverlayHandle>(null);

  useEffect(
    () =>
      useBandViewStore.subscribe((state) => {
        rendererRef.current?.setView(state.startKHz, state.endKHz);
      }),
    []
  );

  useEffect(() => {
    rendererRef.current?.setColorMap(colorMapName);
  }, [colorMapName]);

  useImperativeHandle(
    ref,
    () => ({
      pushBins(bins: Uint8Array) {
        rendererRef.current?.pushBins(bins);
      },
      pushFrame(bins: Uint8Array, xBin: number, zoom: number) {
        rendererRef.current?.pushFrame(bins, xBin, zoom);
      },
      setLevels(min: number, max: number) {
        rendererRef.current?.setLevels(min, max);
      },
      setCurrentTuning(freqKHz: number, passbandLo: number, passbandHi: number) {
        rendererRef.current?.setCurrentTuning(freqKHz, passbandLo, passbandHi);
      },
      setMaxBandwidth(maxKHz: number) {
        rendererRef.current?.setMaxBandwidth(maxKHz);
      },
      setDataCoverage(startKHz: number, endKHz: number) {
        rendererRef.current?.setDataCoverage(startKHz, endKHz);
      },
      async loadInitialChunks() {
        await rendererRef.current?.loadInitialChunks();
      },
      drainStaleQueue() {
        rendererRef.current?.drainStaleQueue();
      },
      visibleRows() {
        return rendererRef.current?.visibleRows ?? 0;
      },
      cssToRows(px: number) {
        return rendererRef.current?.cssToRows(px) ?? 0;
      },
      requestRepaint() {
        rendererRef.current?.requestRepaint();
      },
    }),
    []
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    streamLog.warn("wf.component", "WaterfallDisplayGL MOUNT");

    const renderer = new WaterfallRendererGL(canvas, manager);
    rendererRef.current = renderer;

    const s = useBandViewStore.getState();
    renderer.setView(s.startKHz, s.endKHz);
    renderer.setMaxBandwidth(s.maxBandwidthKHz || 30000);
    renderer.setDataCoverage(0, s.maxBandwidthKHz || 30000);

    manager.onMarkerAdd = (marker) => overlayRef.current?.addMarker(marker);
    manager.onMarkerRemove = (id) => overlayRef.current?.removeMarker(id);
    renderer.onOverlayUpdate = (state, markers) => {
      overlayRef.current?.update(state);
      timelineRef?.current?.update(state, markers);
      onOverlayStateRef.current?.(state);
    };
    renderer.onTuningTrace = (points) => {
      overlayRef.current?.updateTuningTrace(points);
    };

    renderer.startRenderLoop();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(width * dpr);
        const h = Math.round(height * dpr);
        if (w > 0 && h > 0) {
          renderer.resize(w, h);
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
        }
      }
    });
    ro.observe(container);

    return () => {
      streamLog.warn("wf.component", "WaterfallDisplayGL UNMOUNT");
      ro.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [manager]);

  const handleDragScroll = useCallback((deltaCssPx: number) => {
    const r = rendererRef.current;
    if (!r) return;
    const deltaRows = r.cssToRows(deltaCssPx);
    if (deltaRows === 0) return;
    const current = manager.scrollOffset;
    const max = manager.maxScrollOffset;
    const next = Math.max(0, Math.min(current + deltaRows, max));
    if (next !== current) {
      manager.setScrollOffset(next);
    }
  }, [manager]);

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col bg-black overflow-hidden ${className ?? ""}`}
    >
      <canvas
        ref={canvasRef}
        className="block min-h-0 flex-1 pointer-events-none"
      />
      <WaterfallOverlayLayer
        ref={overlayRef}
        isPlaying={isPlaying}
        showTuningTrace={showTuningTrace}
        onPlaybackHeadState={setPlaybackHeadState}
      />
      <PlaybackHead
        visible={playbackHeadState.visible}
        isPlaying={playbackHeadState.isPlaying}
        onPlayPause={() => (isPlaying ? onStop?.() : onPlay?.())}
        onDragScroll={handleDragScroll}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
    </div>
  );
});
