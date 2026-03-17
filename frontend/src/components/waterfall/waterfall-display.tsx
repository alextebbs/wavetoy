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
import type { WaterfallHandle } from "./types";

interface WaterfallDisplayProps {
  className?: string;
}

const FILTER_ID = "wf-colormap";

export const WaterfallDisplay = forwardRef<
  WaterfallHandle,
  WaterfallDisplayProps
>(function WaterfallDisplay({ className }, ref) {
  const colorMapName = useThemeStore((s) => s.theme.display.defaultColorMap);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WaterfallRenderer | null>(null);

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
    </div>
  );
});
