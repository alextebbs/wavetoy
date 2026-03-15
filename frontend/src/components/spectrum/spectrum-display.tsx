import {
  type CSSProperties,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useBandViewStore } from "@/lib/band-view-store";
import { SpectrumRenderer } from "./spectrum-renderer";

export interface SpectrumHandle {
  pushBins(bins: Uint8Array): void;
  pushFrame(bins: Uint8Array, xBin: number, zoom: number): void;
  setMaxBandwidth(maxKHz: number): void;
  setDataCoverage(startKHz: number, endKHz: number): void;
}

interface SpectrumDisplayProps {
  className?: string;
  style?: CSSProperties;
}

export const SpectrumDisplay = forwardRef<SpectrumHandle, SpectrumDisplayProps>(
  function SpectrumDisplay({ className, style }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<SpectrumRenderer | null>(null);

    // Sync view from store
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

      const renderer = new SpectrumRenderer(canvas);
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        ref={containerRef}
        className={`relative bg-background ${className ?? ""}`}
        style={style}
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full pointer-events-none"
        />
      </div>
    );
  }
);
