import { buildLUT, WATERFALL_COLOR_MAPS } from "@/lib/display-colors";

export interface RendererOptions {
  minLevel?: number;
  maxLevel?: number;
  rowScale?: number;
  tileHeight?: number;
}

export interface OverlayState {
  totalRows: number;
  scrollOffset: number;
  rowScale: number;
  height: number;
  dpr: number;
  maxScrollOffset: number;
  isLive: boolean;
}

const DEFAULT_TILE_HEIGHT = 256;
const NUM_BINS = 1024;
const MAX_ZOOM = 14;

interface WFTile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  rawBins: (Uint8Array | null)[];
  rowCount: number;
  dataStartKHz: number;
  dataEndKHz: number;
  startRow: number;
  historical: boolean;
}

export class WaterfallRenderer {
  private visibleCanvas: HTMLCanvasElement;
  private visibleCtx: CanvasRenderingContext2D;

  private readonly numBins = NUM_BINS;
  private readonly tileHeight: number;
  private readonly rowScale: number;

  private tiles: WFTile[] = [];
  private liveTile!: WFTile;
  private totalRows = 0;
  private scrollOffset = 0;
  private lowestStartRow = 0;

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

  private dataStartKHz = 0;
  private dataEndKHz = 30000;
  private maxBandwidthKHz = 30000;
  private viewStartKHz = 0;
  private viewEndKHz = 30000;

  onOverlayUpdate: ((state: OverlayState) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.visibleCanvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.visibleCtx = ctx;

    this.tileHeight = options.tileHeight ?? DEFAULT_TILE_HEIGHT;
    this.rowScale = options.rowScale ?? 1;

    this.minLevel = options.minLevel ?? -110;
    this.maxLevel = options.maxLevel ?? -10;
    this.smoothMin = this.minLevel;
    this.smoothMax = this.maxLevel;

    this.lut = buildLUT(WATERFALL_COLOR_MAPS.muted);

    const scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = this.numBins;
    scratchCanvas.height = 1;
    const scratchCtx = scratchCanvas.getContext("2d", { alpha: false });
    if (!scratchCtx) throw new Error("Failed to create scratch context");
    this.rowImageData = scratchCtx.createImageData(this.numBins, 1);

    this.liveTile = this.createTile(0, this.dataStartKHz, this.dataEndKHz);
    this.tiles.push(this.liveTile);
  }

  private createTile(
    startRow: number,
    dataStartKHz: number,
    dataEndKHz: number
  ): WFTile {
    const canvas = document.createElement("canvas");
    canvas.width = this.numBins;
    canvas.height = this.tileHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to create tile context");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, this.numBins, this.tileHeight);
    return {
      canvas,
      ctx,
      rawBins: [],
      rowCount: 0,
      dataStartKHz,
      dataEndKHz,
      startRow,
      historical: false,
    };
  }

  // --- Public API (preserved from old renderer) ---

  setLevels(min: number, max: number): void {
    this.autoLevel = false;
    this.minLevel = min;
    this.maxLevel = max;
    for (const tile of this.tiles) {
      this.reRenderTile(tile);
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

    if (this.liveTile.rowCount > 0) {
      this.liveTile = this.createTile(this.totalRows, startKHz, endKHz);
      this.tiles.push(this.liveTile);
    } else {
      this.liveTile.dataStartKHz = startKHz;
      this.liveTile.dataEndKHz = endKHz;
    }

    this.dataStartKHz = startKHz;
    this.dataEndKHz = endKHz;
    this.needsRepaint = true;
  }

  setMaxBandwidth(maxKHz: number): void {
    this.maxBandwidthKHz = maxKHz;
  }

  pushFrame(bins: Uint8Array, xBin: number, zoom: number): void {
    const totalBins = this.numBins * (1 << MAX_ZOOM);
    const binScale = 1 << (MAX_ZOOM - zoom);
    const frameStart = (xBin / totalBins) * this.maxBandwidthKHz;
    const frameEnd =
      ((xBin + this.numBins * binScale) / totalBins) * this.maxBandwidthKHz;

    if (
      Math.abs(frameStart - this.dataStartKHz) > 0.5 ||
      Math.abs(frameEnd - this.dataEndKHz) > 0.5
    ) {
      this.setDataCoverage(frameStart, frameEnd);
    }

    this.queue.push(bins);
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
    this.tiles.length = 0;
  }

  get currentLevels(): { min: number; max: number } {
    return { min: this.minLevel, max: this.maxLevel };
  }

  // --- Phase 3 hooks ---

  get rowCount(): number {
    return this.totalRows;
  }

  get maxScrollOffset(): number {
    return this.totalRows - this.lowestStartRow;
  }

  get isLive(): boolean {
    return this.scrollOffset === 0;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  setScrollOffset(offset: number): void {
    const clamped = Math.max(0, Math.min(offset, this.maxScrollOffset));
    if (clamped === this.scrollOffset) return;
    this.scrollOffset = clamped;
    this.needsRepaint = true;
  }

  scrollToLive(): void {
    this.setScrollOffset(0);
  }

  /**
   * Inform the renderer of the full extent of historical data (including
   * chunks not yet loaded). This ensures maxScrollOffset and the timeline
   * scrollbar are correct even before tiles exist.
   */
  setHistoryExtent(lowestRow: number): void {
    if (lowestRow < this.lowestStartRow) {
      this.lowestStartRow = lowestRow;
      this.needsRepaint = true;
    }
  }

  /**
   * Remove all tiles whose startRow falls within [startRow, endRow).
   * Used by the tile manager to evict distant historical data.
   */
  removeTilesInRange(startRow: number, endRow: number): void {
    this.tiles = this.tiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      return tile.startRow < startRow || tile.startRow >= endRow;
    });
    this.needsRepaint = true;
  }

  /**
   * Insert a pre-built historical tile into the tile list. Used by the chunk
   * loader to inject parsed WF data from rewind chunks.
   */
  insertHistoricalTile(
    startRow: number,
    rawBinsArray: Uint8Array[],
    dataStartKHz: number,
    dataEndKHz: number
  ): void {
    const tile = this.createTile(startRow, dataStartKHz, dataEndKHz);
    tile.historical = true;
    for (const bins of rawBinsArray) {
      tile.rawBins.push(new Uint8Array(bins));
      this.colorMapLine(bins);
      tile.ctx.putImageData(
        this.rowImageData,
        0,
        this.tileHeight - 1 - tile.rowCount
      );
      tile.rowCount++;
    }

    if (startRow < this.lowestStartRow) {
      this.lowestStartRow = startRow;
    }

    const insertIdx = this.tiles.findIndex((t) => t.startRow > startRow);
    if (insertIdx === -1) {
      this.tiles.splice(this.tiles.length - 1, 0, tile);
    } else {
      this.tiles.splice(insertIdx, 0, tile);
    }
    this.needsRepaint = true;
  }

  // --- Private methods ---

  private flush(): void {
    const lines = this.queue.splice(0, this.queue.length);
    const hasNewData = lines.length > 0;

    if (hasNewData) {
      for (const bins of lines) {
        if (this.autoLevel) this.updateAutoLevel(bins);
        this.appendToLiveTile(bins);
      }
    }

    if (hasNewData || this.needsRepaint) {
      this.pruneTiles();
      this.blitToVisible();
      this.needsRepaint = false;
      this.onOverlayUpdate?.({
        totalRows: this.totalRows,
        scrollOffset: this.scrollOffset,
        rowScale: this.rowScale,
        height: this.visibleCanvas.height,
        dpr: window.devicePixelRatio || 1,
        maxScrollOffset: this.maxScrollOffset,
        isLive: this.isLive,
      });
    }
  }

  private appendToLiveTile(bins: Uint8Array): void {
    if (this.liveTile.rowCount >= this.tileHeight) {
      this.liveTile = this.createTile(
        this.totalRows,
        this.dataStartKHz,
        this.dataEndKHz
      );
      this.tiles.push(this.liveTile);
    }

    const tile = this.liveTile;
    const canvasY = this.tileHeight - 1 - tile.rowCount;

    tile.rawBins.push(new Uint8Array(bins));
    this.colorMapLine(bins);
    tile.ctx.putImageData(this.rowImageData, 0, canvasY);
    tile.rowCount++;
    this.totalRows++;
    if (this.scrollOffset > 0) {
      this.scrollOffset++;
    }
  }

  private colorMapLine(bins: Uint8Array, invert = false): void {
    const pixels = this.rowImageData.data;
    const minDb = this.minLevel;
    const range = this.maxLevel - minDb;
    const invRange = range > 0 ? 255 / range : 0;
    const lut = this.lut;
    const numBins = Math.min(bins.length, this.numBins);

    for (let x = 0; x < numBins; x++) {
      const dBm = bins[x] - 255;
      const raw = Math.max(0, Math.min(255, ((dBm - minDb) * invRange) | 0));
      const idx = invert ? 255 - raw : raw;
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
      this.visibleCtx.fillStyle = "#000000";
      this.visibleCtx.fillRect(0, 0, width, height);
      return;
    }

    this.visibleCtx.fillStyle = "#000000";
    this.visibleCtx.fillRect(0, 0, width, height);

    const visibleRowsTop = this.scrollOffset;
    const visibleRowsBottom =
      this.scrollOffset + Math.ceil(height / this.rowScale);

    for (const tile of this.tiles) {
      if (tile.rowCount === 0) continue;

      // Tile occupies global rows [startRow, startRow + rowCount - 1]
      // "Rows from live" for the newest row = totalRows - 1 - (startRow + rowCount - 1)
      //                                    = totalRows - startRow - rowCount
      const tileTopRowsFromLive = this.totalRows - tile.startRow - tile.rowCount;
      const tileBotRowsFromLive = this.totalRows - tile.startRow - 1;

      if (tileTopRowsFromLive > visibleRowsBottom) continue;
      if (tileBotRowsFromLive < visibleRowsTop) continue;

      this.blitTile(tile, width, height, viewSpan);
    }

  }

  private blitTile(
    tile: WFTile,
    visibleWidth: number,
    visibleHeight: number,
    viewSpan: number
  ): void {
    const layerSpan = tile.dataEndKHz - tile.dataStartKHz;
    if (layerSpan <= 0 || tile.rowCount <= 0) return;

    const overlapStart = Math.max(tile.dataStartKHz, this.viewStartKHz);
    const overlapEnd = Math.min(tile.dataEndKHz, this.viewEndKHz);
    if (overlapStart >= overlapEnd) return;

    const srcX = ((overlapStart - tile.dataStartKHz) / layerSpan) * this.numBins;
    const srcW = ((overlapEnd - overlapStart) / layerSpan) * this.numBins;
    const dstX = ((overlapStart - this.viewStartKHz) / viewSpan) * visibleWidth;
    const dstW = ((overlapEnd - overlapStart) / viewSpan) * visibleWidth;
    if (srcW < 0.5 || dstW < 0.5) return;

    const scaledOffset =
      (this.totalRows - tile.startRow - tile.rowCount - this.scrollOffset) *
      this.rowScale;
    if (scaledOffset >= visibleHeight) return;

    const srcY = this.tileHeight - tile.rowCount;
    const srcH = Math.min(
      tile.rowCount,
      Math.ceil((visibleHeight - scaledOffset) / this.rowScale)
    );
    if (srcH <= 0) return;
    const dstH = srcH * this.rowScale;

    this.visibleCtx.imageSmoothingEnabled = srcW < dstW;
    this.visibleCtx.drawImage(
      tile.canvas,
      srcX, srcY, srcW, srcH,
      dstX, scaledOffset, dstW, dstH
    );
  }

  private reRenderTile(tile: WFTile): void {
    tile.ctx.fillStyle = "#000000";
    tile.ctx.fillRect(0, 0, this.numBins, this.tileHeight);
    for (let i = 0; i < tile.rowCount; i++) {
      const bins = tile.rawBins[i];
      if (!bins) continue;
      this.colorMapLine(bins, tile.historical);
      tile.ctx.putImageData(
        this.rowImageData,
        0,
        this.tileHeight - 1 - i
      );
    }
  }

  private pruneTiles(): void {
    const { height } = this.visibleCanvas;
    if (height === 0) return;

    this.tiles = this.tiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      // Historical tiles are managed by ChunkTileManager; don't auto-prune.
      if (tile.historical) return true;
      const displayTopY =
        (this.totalRows - tile.startRow - tile.rowCount - this.scrollOffset) *
        this.rowScale;
      return displayTopY < height;
    });
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
