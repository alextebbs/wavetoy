import { buildLUT, getColorMap, type ColorMapName } from "@/lib/display-colors";
import { useThemeStore } from "@/lib/theme";

export interface RendererOptions {
  colorMap?: ColorMapName;
  minLevel?: number;
  maxLevel?: number;
  historySize?: number;
  rowScale?: number;
}

const DEFAULT_HISTORY = 4096;

interface WFLayer {
  canvas: HTMLCanvasElement;
  dataStartKHz: number;
  dataEndKHz: number;
  rowCount: number;
  yOffset: number;
  rawBins: (Uint8Array | null)[];
}

export class WaterfallRenderer {
  private visibleCanvas: HTMLCanvasElement;
  private visibleCtx: CanvasRenderingContext2D;

  private offscreen!: HTMLCanvasElement;
  private offCtx!: CanvasRenderingContext2D;
  private readonly numBins = 1024;
  private readonly historySize: number;
  private totalRows = 0;

  private lut: Uint8Array;
  private rowImageData!: ImageData;
  private queue: Uint8Array[] = [];
  private rafId: number | null = null;
  private needsRepaint = false;

  private minLevel: number;
  private maxLevel: number;

  private autoLevel = true;
  private smoothMin: number;
  private smoothMax: number;
  private samplesCount = 0;
  private readonly AUTO_ALPHA = 0.05;
  private readonly rowScale: number;

  private dataStartKHz = 0;
  private dataEndKHz = 30000;

  private viewStartKHz = 0;
  private viewEndKHz = 30000;

  private rawBins: (Uint8Array | null)[] = [];

  private backgroundLayers: WFLayer[] = [];

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.visibleCanvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.visibleCtx = ctx;

    this.historySize = options.historySize ?? DEFAULT_HISTORY;
    this.rowScale = options.rowScale ?? 3;
    this.initOffscreen();

    this.minLevel = options.minLevel ?? -110;
    this.maxLevel = options.maxLevel ?? -10;
    this.smoothMin = this.minLevel;
    this.smoothMax = this.maxLevel;

    this.lut = buildLUT(getColorMap(options.colorMap ?? "phosphor"));
  }

  private initOffscreen(): void {
    this.offscreen = document.createElement("canvas");
    this.offscreen.width = this.numBins;
    this.offscreen.height = this.historySize;
    const offCtx = this.offscreen.getContext("2d", { alpha: false });
    if (!offCtx) throw new Error("Failed to get offscreen 2D context");
    this.offCtx = offCtx;
    offCtx.fillStyle = useThemeStore.getState().theme.display.waterfallBg;
    offCtx.fillRect(0, 0, this.numBins, this.historySize);
    this.rowImageData = offCtx.createImageData(this.numBins, 1);
  }

  setColorMap(name: ColorMapName): void {
    this.lut = buildLUT(getColorMap(name));
    this.reRenderOffscreen();
    for (const layer of this.backgroundLayers) {
      this.reRenderLayer(layer);
    }
    this.needsRepaint = true;
  }

  setLevels(min: number, max: number): void {
    this.autoLevel = false;
    this.minLevel = min;
    this.maxLevel = max;
    this.reRenderOffscreen();
    for (const layer of this.backgroundLayers) {
      this.reRenderLayer(layer);
    }
    this.needsRepaint = true;
  }

  setAutoLevel(enabled: boolean): void {
    this.autoLevel = enabled;
    if (enabled) this.samplesCount = 0;
  }

  setView(startKHz: number, endKHz: number): void {
    if (startKHz === this.viewStartKHz && endKHz === this.viewEndKHz) return;
    this.viewStartKHz = startKHz;
    this.viewEndKHz = endKHz;
    this.needsRepaint = true;
  }

  setDataCoverage(startKHz: number, endKHz: number): void {
    if (startKHz === this.dataStartKHz && endKHz === this.dataEndKHz) return;

    // Freeze current offscreen as a trimmed background layer
    const rows = Math.min(this.totalRows, this.historySize);
    if (rows > 0) {
      const trimmed = document.createElement("canvas");
      trimmed.width = this.numBins;
      trimmed.height = rows;
      const tCtx = trimmed.getContext("2d", { alpha: false });
      if (tCtx) {
        tCtx.drawImage(
          this.offscreen,
          0, 0, this.numBins, rows,
          0, 0, this.numBins, rows
        );
      }
      this.backgroundLayers.push({
        canvas: trimmed,
        dataStartKHz: this.dataStartKHz,
        dataEndKHz: this.dataEndKHz,
        rowCount: rows,
        yOffset: 0,
        rawBins: this.rawBins.slice(0, rows),
      });
    }

    this.dataStartKHz = startKHz;
    this.dataEndKHz = endKHz;

    this.totalRows = 0;
    this.rawBins = [];
    this.initOffscreen();
    this.needsRepaint = true;
  }

  pushBins(bins: Uint8Array): void {
    this.queue.push(bins);
  }

  startRenderLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.flush();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resize(width: number, height: number): void {
    if (width < 1 || height < 1) return;
    this.visibleCanvas.width = width;
    this.visibleCanvas.height = height;
    this.blitToVisible();
  }

  destroy(): void {
    this.stopRenderLoop();
    this.queue.length = 0;
    this.backgroundLayers.length = 0;
  }

  get currentLevels(): { min: number; max: number } {
    return { min: this.minLevel, max: this.maxLevel };
  }

  private flush(): void {
    const lines = this.queue.splice(0, this.queue.length);
    const hasNewData = lines.length > 0;

    if (hasNewData) {
      for (const bins of lines) {
        if (this.autoLevel) this.updateAutoLevel(bins);
        this.renderToOffscreen(bins);
      }
      for (const layer of this.backgroundLayers) {
        layer.yOffset += lines.length;
      }
    }

    // Prune layers that have scrolled off the bottom of the visible canvas
    const visH = this.visibleCanvas.height;
    if (visH > 0) {
      const before = this.backgroundLayers.length;
      this.backgroundLayers = this.backgroundLayers.filter(
        (l) => l.yOffset * this.rowScale < visH
      );
      if (this.backgroundLayers.length < before) this.needsRepaint = true;
    }

    if (hasNewData || this.needsRepaint) {
      this.blitToVisible();
      this.needsRepaint = false;
    }
  }

  private renderToOffscreen(bins: Uint8Array): void {
    if (this.totalRows > 0) {
      this.offCtx.drawImage(
        this.offscreen,
        0, 0, this.numBins, this.historySize - 1,
        0, 1, this.numBins, this.historySize - 1
      );
    }

    if (this.rawBins.length >= this.historySize) {
      this.rawBins.pop();
    }
    this.rawBins.unshift(new Uint8Array(bins));

    this.colorMapLine(bins);
    this.offCtx.putImageData(this.rowImageData, 0, 0);
    this.totalRows++;
  }

  private colorMapLine(bins: Uint8Array): void {
    const pixels = this.rowImageData.data;
    const minDb = this.minLevel;
    const range = this.maxLevel - minDb;
    const invRange = range > 0 ? 255 / range : 0;
    const lut = this.lut;
    const numBins = Math.min(bins.length, this.numBins);

    for (let x = 0; x < numBins; x++) {
      const dBm = bins[x] - 255;
      const idx = Math.max(0, Math.min(255, ((dBm - minDb) * invRange) | 0));
      const base = idx << 2;
      const px = x << 2;
      pixels[px] = lut[base];
      pixels[px + 1] = lut[base + 1];
      pixels[px + 2] = lut[base + 2];
      pixels[px + 3] = 255;
    }
    for (let x = numBins; x < this.numBins; x++) {
      const px = x << 2;
      pixels[px] = 0;
      pixels[px + 1] = 0;
      pixels[px + 2] = 0;
      pixels[px + 3] = 255;
    }
  }

  private blitToVisible(): void {
    const { width, height } = this.visibleCanvas;
    if (width === 0 || height === 0) return;

    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (viewSpan <= 0) {
      this.visibleCtx.fillStyle = useThemeStore.getState().theme.display.waterfallBg;
      this.visibleCtx.fillRect(0, 0, width, height);
      return;
    }

    this.visibleCtx.fillStyle = useThemeStore.getState().theme.display.waterfallBg;
    this.visibleCtx.fillRect(0, 0, width, height);

    // Draw background layers first (oldest → newest), then foreground
    for (const layer of this.backgroundLayers) {
      this.blitLayer(
        layer.canvas,
        layer.dataStartKHz,
        layer.dataEndKHz,
        layer.rowCount,
        layer.yOffset,
        width,
        height,
        viewSpan
      );
    }

    // Draw current (foreground) layer
    const fgRows = Math.min(this.totalRows, this.historySize);
    if (fgRows > 0) {
      this.blitLayer(
        this.offscreen,
        this.dataStartKHz,
        this.dataEndKHz,
        fgRows,
        0,
        width,
        height,
        viewSpan
      );
    }
  }

  private blitLayer(
    canvas: HTMLCanvasElement,
    layerStartKHz: number,
    layerEndKHz: number,
    rowCount: number,
    yOffset: number,
    visibleWidth: number,
    visibleHeight: number,
    viewSpan: number
  ): void {
    const layerSpan = layerEndKHz - layerStartKHz;
    if (layerSpan <= 0 || rowCount <= 0) return;

    const scaledOffset = yOffset * this.rowScale;
    if (scaledOffset >= visibleHeight) return;

    const overlapStart = Math.max(layerStartKHz, this.viewStartKHz);
    const overlapEnd = Math.min(layerEndKHz, this.viewEndKHz);
    if (overlapStart >= overlapEnd) return;

    const srcX = ((overlapStart - layerStartKHz) / layerSpan) * this.numBins;
    const srcW = ((overlapEnd - overlapStart) / layerSpan) * this.numBins;

    const dstX = ((overlapStart - this.viewStartKHz) / viewSpan) * visibleWidth;
    const dstW = ((overlapEnd - overlapStart) / viewSpan) * visibleWidth;

    const srcH = Math.min(rowCount, Math.ceil((visibleHeight - scaledOffset) / this.rowScale));
    const dstH = srcH * this.rowScale;
    if (srcH <= 0 || srcW < 0.5 || dstW < 0.5) return;

    this.visibleCtx.imageSmoothingEnabled = srcW < dstW;
    this.visibleCtx.drawImage(
      canvas,
      srcX, 0, srcW, srcH,
      dstX, scaledOffset, dstW, dstH
    );
  }

  private reRenderOffscreen(): void {
    const count = Math.min(this.rawBins.length, this.historySize);
    for (let i = 0; i < count; i++) {
      const bins = this.rawBins[i];
      if (!bins) continue;
      this.colorMapLine(bins);
      this.offCtx.putImageData(this.rowImageData, 0, i);
    }
  }

  private reRenderLayer(layer: WFLayer): void {
    const layerCtx = layer.canvas.getContext("2d", { alpha: false });
    if (!layerCtx) return;
    const count = Math.min(layer.rawBins.length, layer.rowCount);
    for (let i = 0; i < count; i++) {
      const bins = layer.rawBins[i];
      if (!bins) continue;
      this.colorMapLine(bins);
      layerCtx.putImageData(this.rowImageData, 0, i);
    }
  }

  private updateAutoLevel(bins: Uint8Array): void {
    const sorted = new Uint8Array(bins).sort();
    const p50 = sorted[Math.floor(sorted.length * 0.5)] - 255;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] - 255;

    const targetMin = p50 - 10;
    const targetMax = p95 + 20;

    if (this.samplesCount === 0) {
      this.smoothMin = targetMin;
      this.smoothMax = targetMax;
    } else {
      this.smoothMin += this.AUTO_ALPHA * (targetMin - this.smoothMin);
      this.smoothMax += this.AUTO_ALPHA * (targetMax - this.smoothMax);
    }
    this.samplesCount++;

    const minRange = 30;
    if (this.smoothMax - this.smoothMin < minRange) {
      this.smoothMax = this.smoothMin + minRange;
    }

    this.minLevel = this.smoothMin;
    this.maxLevel = this.smoothMax;
  }
}
