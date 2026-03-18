import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { colorMapToFilterTables, getColorMap } from "@/lib/display-colors";
import { useThemeStore } from "@/lib/theme";
import { WaterfallRenderer } from "./waterfall-renderer";
import { WaterfallOverlayLayer, type WaterfallOverlayHandle } from "./waterfall-overlay";
import type { WaterfallTimelineHandle } from "./waterfall-timeline";
import type { WaterfallHandle } from "./types";
import type { WaterfallMarker } from "./waterfall-overlay";

interface WaterfallDisplayProps {
  className?: string;
  timelineRef?: React.RefObject<WaterfallTimelineHandle | null>;
  onOverlayUpdate?: (state: import("./waterfall-renderer").OverlayState) => void;
}

const FILTER_ID = "wf-colormap";

export const WaterfallDisplay = forwardRef<
  WaterfallHandle,
  WaterfallDisplayProps
>(function WaterfallDisplay({ className, timelineRef, onOverlayUpdate: onOverlayUpdateProp }, ref) {
  const colorMapName = useThemeStore((s) => s.theme.display.defaultColorMap);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WaterfallRenderer | null>(null);
  const overlayRef = useRef<WaterfallOverlayHandle>(null);
  const markersListRef = useRef<WaterfallMarker[]>([]);
  const overlayUpdatePropRef = useRef(onOverlayUpdateProp);
  overlayUpdatePropRef.current = onOverlayUpdateProp;

  const filterTables = useMemo(
    () => colorMapToFilterTables(getColorMap(colorMapName)),
    [colorMapName],
  );

  useEffect(
    () =>
      useBandViewStore.subscribe((state) => {
        rendererRef.current?.setView(state.startKHz, state.endKHz);
      }),
    []
  );

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
      setMaxBandwidth(maxKHz: number) {
        rendererRef.current?.setMaxBandwidth(maxKHz);
      },
      setDataCoverage(startKHz: number, endKHz: number) {
        rendererRef.current?.setDataCoverage(startKHz, endKHz);
      },
      insertHistoricalTile(
        startRow: number,
        rawBins: Uint8Array[],
        dataStartKHz: number,
        dataEndKHz: number,
      ) {
        rendererRef.current?.insertHistoricalTile(
          startRow,
          rawBins,
          dataStartKHz,
          dataEndKHz,
        );
      },
      setHistoryExtent(lowestRow: number) {
        rendererRef.current?.setHistoryExtent(lowestRow);
      },
      removeTilesInRange(startRow: number, endRow: number) {
        rendererRef.current?.removeTilesInRange(startRow, endRow);
      },
      addMarker(marker: WaterfallMarker) {
        overlayRef.current?.addMarker(marker);
        const list = markersListRef.current;
        const idx = list.findIndex((m) => m.id === marker.id);
        if (idx >= 0) list[idx] = marker;
        else list.push(marker);
      },
      removeMarker(id: string) {
        overlayRef.current?.removeMarker(id);
        markersListRef.current = markersListRef.current.filter(
          (m) => m.id !== id
        );
      },
      rowCount() {
        return rendererRef.current?.rowCount ?? 0;
      },
      setScrollOffset(offset: number) {
        rendererRef.current?.setScrollOffset(offset);
      },
      scrollToLive() {
        rendererRef.current?.scrollToLive();
      },
    }),
    []
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const renderer = new WaterfallRenderer(canvas);
    rendererRef.current = renderer;

    const s = useBandViewStore.getState();
    renderer.setView(s.startKHz, s.endKHz);
    renderer.setMaxBandwidth(s.maxBandwidthKHz || 30000);
    renderer.setDataCoverage(0, s.maxBandwidthKHz || 30000);

    renderer.onOverlayUpdate = (state) => {
      overlayRef.current?.update(state);
      timelineRef?.current?.update(state, markersListRef.current);
      overlayUpdatePropRef.current?.(state);
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
      ro.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col bg-black overflow-hidden ${className ?? ""}`}
    >
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id={FILTER_ID} colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="table" tableValues={filterTables.r} />
            <feFuncG type="table" tableValues={filterTables.g} />
            <feFuncB type="table" tableValues={filterTables.b} />
          </feComponentTransfer>
        </filter>
      </svg>
      <canvas
        ref={canvasRef}
        className="block min-h-0 flex-1 pointer-events-none"
        style={{ filter: `url(#${FILTER_ID})` }}
      />
      <WaterfallOverlayLayer ref={overlayRef} />
    </div>
  );
});
