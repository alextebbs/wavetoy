import { useThemeStore } from "@/lib/theme";
import { PerfBucket } from "@/lib/stream-logger";

function getDisplay() {
  return useThemeStore.getState().theme.display;
}

export interface SpectrumRendererOptions {
  minLevel?: number;
  maxLevel?: number;
  lerpSpeed?: number;
}

// Per-frame lerp factor: how fast the display chases the target.
// At 60fps with 0.18, ~90% converged in ~12 frames (~200ms) — smooth but responsive.
const DEFAULT_LERP_SPEED = 0.18;
const CONVERGE_THRESHOLD = 0.15; // dB — stop animating when close enough

export class SpectrumRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private minLevel: number;
  private maxLevel: number;

  // Target: where data says we should be (set on pushBins)
  private targetBins: Float32Array | null = null;
  // Display: what's actually drawn, lerps toward target every frame
  private displayBins: Float32Array | null = null;
  private animating = false;
  private lerpSpeed: number;

  private peakBins: Float32Array | null = null;
  private peakHold = false;

  private dataStartKHz = 0;
  private dataEndKHz = 30000;
  private maxBandwidthKHz = 30000;
  private viewStartKHz = 0;
  private viewEndKHz = 30000;

  private static readonly MAX_ZOOM = 14;
  private static readonly NUM_BINS = 1024;

  private passbandCenterKHz = 0;
  private passbandLowHz = 0;
  private passbandHighHz = 0;
  private historicalMode = false;

  private gradient: CanvasGradient | null = null;
  private dirty = false;
  private rafId: number | null = null;
  private themeUnsub: (() => void) | null = null;
  private perfRender = new PerfBucket("perf.spectrum.render");

  constructor(canvas: HTMLCanvasElement, options: SpectrumRendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;

    this.minLevel = options.minLevel ?? -110;
    this.maxLevel = options.maxLevel ?? -10;
    this.lerpSpeed = options.lerpSpeed ?? DEFAULT_LERP_SPEED;

    this.rebuildGradient();

    this.themeUnsub = useThemeStore.subscribe(() => {
      this.rebuildGradient();
      this.dirty = true;
    });
  }

  setLevels(min: number, max: number): void {
    this.minLevel = min;
    this.maxLevel = max;
    this.rebuildGradient();
    this.dirty = true;
  }

  setPeakHold(enabled: boolean): void {
    this.peakHold = enabled;
    if (!enabled) this.peakBins = null;
    this.dirty = true;
  }

  resetPeak(): void {
    this.peakBins = null;
    this.dirty = true;
  }

  setView(startKHz: number, endKHz: number): void {
    if (startKHz === this.viewStartKHz && endKHz === this.viewEndKHz) return;
    this.viewStartKHz = startKHz;
    this.viewEndKHz = endKHz;
    this.dirty = true;
  }

  setMaxBandwidth(maxKHz: number): void {
    this.maxBandwidthKHz = maxKHz;
  }

  setDataCoverage(startKHz: number, endKHz: number): void {
    if (startKHz === this.dataStartKHz && endKHz === this.dataEndKHz) return;
    this.dataStartKHz = startKHz;
    this.dataEndKHz = endKHz;
    this.dirty = true;
  }

  pushFrame(bins: Uint8Array, xBin: number, zoom: number): void {
    const totalBins = SpectrumRenderer.NUM_BINS * (1 << SpectrumRenderer.MAX_ZOOM);
    const binScale = 1 << (SpectrumRenderer.MAX_ZOOM - zoom);
    const frameStart = (xBin / totalBins) * this.maxBandwidthKHz;
    const frameEnd = ((xBin + SpectrumRenderer.NUM_BINS * binScale) / totalBins) * this.maxBandwidthKHz;

    if (
      Math.abs(frameStart - this.dataStartKHz) > 0.5 ||
      Math.abs(frameEnd - this.dataEndKHz) > 0.5
    ) {
      this.setDataCoverage(frameStart, frameEnd);
    }

    this.pushBins(bins);
  }

  setPassband(centerKHz: number, lowHz: number, highHz: number): void {
    this.passbandCenterKHz = centerKHz;
    this.passbandLowHz = lowHz;
    this.passbandHighHz = highHz;
    this.dirty = true;
  }

  setHistoricalMode(enabled: boolean): void {
    if (this.historicalMode === enabled) return;
    this.historicalMode = enabled;
    this.dirty = true;
  }

  pushBins(bins: Uint8Array): void {
    const len = bins.length;

    if (!this.targetBins || this.targetBins.length !== len) {
      this.targetBins = new Float32Array(len);
      this.displayBins = new Float32Array(len);
      // First frame: snap display to target immediately
      for (let i = 0; i < len; i++) {
        const v = bins[i] - 255;
        this.targetBins[i] = v;
        this.displayBins[i] = v;
      }
    } else {
      for (let i = 0; i < len; i++) {
        this.targetBins[i] = bins[i] - 255;
      }
    }

    if (this.peakHold) {
      if (!this.peakBins || this.peakBins.length !== len) {
        this.peakBins = new Float32Array(this.targetBins);
      } else {
        for (let i = 0; i < len; i++) {
          if (this.targetBins[i] > this.peakBins[i]) {
            this.peakBins[i] = this.targetBins[i];
          }
        }
      }
    }

    this.animating = true;
    this.dirty = true;
  }

  resize(width: number, height: number): void {
    if (width < 1 || height < 1) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.rebuildGradient();
    this.render();
  }

  startRenderLoop(): void {
    if (this.rafId !== null) return;
    this.perfRender.start();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);

      if (this.animating) {
        this.stepLerp();
      }

      if (this.dirty) {
        const t0 = performance.now();
        this.render();
        this.dirty = false;
        this.perfRender.record(performance.now() - t0);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.perfRender.stop();
  }

  destroy(): void {
    this.stopRenderLoop();
    this.themeUnsub?.();
    this.targetBins = null;
    this.displayBins = null;
    this.peakBins = null;
  }

  private stepLerp(): void {
    const target = this.targetBins;
    const display = this.displayBins;
    if (!target || !display) return;

    const alpha = this.lerpSpeed;
    let maxDelta = 0;

    for (let i = 0; i < display.length; i++) {
      const diff = target[i] - display[i];
      display[i] += alpha * diff;
      const absDiff = diff < 0 ? -diff : diff;
      if (absDiff > maxDelta) maxDelta = absDiff;
    }

    this.dirty = true;

    if (maxDelta < CONVERGE_THRESHOLD) {
      display.set(target);
      this.animating = false;
    }
  }

  private rebuildGradient(): void {
    const { height } = this.canvas;
    if (height <= 0) return;
    const g = this.ctx.createLinearGradient(0, 0, 0, height);
    for (const [pos, color] of getDisplay().spectrumGradientStops) {
      g.addColorStop(pos, color);
    }
    this.gradient = g;
  }

  private render(): void {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;
    const ctx = this.ctx;

    ctx.fillStyle = getDisplay().spectrumBg;
    ctx.fillRect(0, 0, width, height);

    if (!this.displayBins) return;

    this.drawPassband(width, height);
    this.drawSpectrum(this.displayBins, width, height);
  }

  private drawGrid(w: number, h: number): void {
    const ctx = this.ctx;
    const range = this.maxLevel - this.minLevel;
    if (range <= 0) return;

    const step = range > 60 ? 20 : 10;
    const firstDb = Math.ceil(this.minLevel / step) * step;

    const d = getDisplay();
    ctx.strokeStyle = d.spectrumGridLine;
    ctx.lineWidth = 1;
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = d.spectrumGridLabel;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let db = firstDb; db <= this.maxLevel; db += step) {
      const norm = (db - this.minLevel) / range;
      const y = Math.round((1 - norm) * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${db}`, w - 4, y);
    }
  }

  private drawPassband(w: number, h: number): void {
    if (this.passbandLowHz === 0 && this.passbandHighHz === 0) return;

    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (viewSpan <= 0) return;

    const pbLowKHz = this.passbandCenterKHz + this.passbandLowHz / 1000;
    const pbHighKHz = this.passbandCenterKHz + this.passbandHighHz / 1000;

    const x1 = ((pbLowKHz - this.viewStartKHz) / viewSpan) * w;
    const x2 = ((pbHighKHz - this.viewStartKHz) / viewSpan) * w;

    if (x2 < 0 || x1 > w) return;

    const d = getDisplay();
    this.ctx.fillStyle = this.historicalMode
      ? `${d.displayStatusPlaybackHead}2e` // same blue as playback head, ~18% opacity
      : d.spectrumPassbandFill;
    this.ctx.fillRect(x1, 0, x2 - x1, h);
  }

  private drawSpectrum(bins: Float32Array, w: number, h: number): void {
    const ctx = this.ctx;
    const numBins = bins.length;
    const dataSpan = this.dataEndKHz - this.dataStartKHz;
    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (dataSpan <= 0 || viewSpan <= 0) return;

    const range = this.maxLevel - this.minLevel;
    if (range <= 0) return;

    const binWidthPx = (dataSpan / numBins / viewSpan) * w;
    const barW = Math.max(1, Math.ceil(binWidthPx));

    ctx.fillStyle = this.gradient ?? "rgba(0, 200, 255, 0.3)";
    ctx.globalAlpha = getDisplay().spectrumFillOpacity;

    for (let i = 0; i < numBins; i++) {
      const freqKHz = this.dataStartKHz + (i / numBins) * dataSpan;
      const x = ((freqKHz - this.viewStartKHz) / viewSpan) * w;

      if (x + barW < 0 || x > w) continue;

      const norm = Math.max(0, Math.min(1, (bins[i] - this.minLevel) / range));
      const barH = norm * h;
      if (barH < 0.5) continue;
      ctx.fillRect(x, h - barH, barW, barH);
    }

    ctx.globalAlpha = 1;
  }

  private drawPeakTrace(peaks: Float32Array, w: number, h: number): void {
    const ctx = this.ctx;
    const numBins = peaks.length;
    const dataSpan = this.dataEndKHz - this.dataStartKHz;
    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (dataSpan <= 0 || viewSpan <= 0) return;

    const range = this.maxLevel - this.minLevel;
    if (range <= 0) return;

    ctx.beginPath();
    let started = false;

    for (let i = 0; i < numBins; i++) {
      const freqKHz = this.dataStartKHz + (i / numBins) * dataSpan;
      const canvasX = ((freqKHz - this.viewStartKHz) / viewSpan) * w;

      if (canvasX < -2 || canvasX > w + 2) continue;

      const norm = Math.max(0, Math.min(1, (peaks[i] - this.minLevel) / range));
      const y = (1 - norm) * h;

      if (!started) {
        ctx.moveTo(canvasX, y);
        started = true;
      } else {
        ctx.lineTo(canvasX, y);
      }
    }

    if (started) {
      ctx.strokeStyle = getDisplay().spectrumPeakTrace;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
