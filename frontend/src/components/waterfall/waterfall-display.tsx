import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { useThemeStore } from "@/lib/theme";
import { WaterfallRenderer } from "./waterfall-renderer";
import type { ColorMapName, WaterfallHandle } from "./types";

interface WaterfallDisplayProps {
  className?: string;
  colorMap?: ColorMapName;
}

export const WaterfallDisplay = forwardRef<
  WaterfallHandle,
  WaterfallDisplayProps
>(function WaterfallDisplay({ className, colorMap }, ref) {
  const defaultColorMap = useThemeStore((s) => s.theme.display.defaultColorMap);
  const effectiveColorMap = colorMap ?? defaultColorMap;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WaterfallRenderer | null>(null);

  // Sync view from store → renderer
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
      setColorMap(name: ColorMapName) {
        rendererRef.current?.setColorMap(name);
      },
      setLevels(min: number, max: number) {
        rendererRef.current?.setLevels(min, max);
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

    const renderer = new WaterfallRenderer(canvas, { colorMap: effectiveColorMap });
    rendererRef.current = renderer;

    const s = useBandViewStore.getState();
    renderer.setView(s.startKHz, s.endKHz);
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
  }, [effectiveColorMap]);

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col bg-black overflow-hidden ${className ?? ""}`}
    >
      <canvas
        ref={canvasRef}
        className="block min-h-0 flex-1 pointer-events-none"
      />
    </div>
  );
});
