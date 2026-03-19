import { buildLUT, WATERFALL_COLOR_MAPS } from "@/lib/display-colors";
import { WaterfallRendererBase, type BaseTile } from "./waterfall-renderer-base";

export type { OverlayState, RendererOptions } from "./waterfall-renderer-base";

interface WFTile extends BaseTile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export class WaterfallRenderer extends WaterfallRendererBase<WFTile> {
  private ctx!: CanvasRenderingContext2D;
  private lut!: Uint8Array;
  private rowImageData!: ImageData;

  protected initContext(): void {
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;

    this.lut = buildLUT(WATERFALL_COLOR_MAPS.muted);

    const scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = this.numBins;
    scratchCanvas.height = 1;
    const scratchCtx = scratchCanvas.getContext("2d", { alpha: false });
    if (!scratchCtx) throw new Error("Failed to create scratch context");
    this.rowImageData = scratchCtx.createImageData(this.numBins, 1);
  }

  protected createTile(
    startRow: number,
    dataStartKHz: number,
    dataEndKHz: number,
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
      tuning: [],
      rowCount: 0,
      dataStartKHz,
      dataEndKHz,
      startRow,
    };
  }

  protected writeRow(tile: WFTile, bins: Uint8Array, rowIndex: number): void {
    this.colorMapLine(bins);
    tile.ctx.putImageData(this.rowImageData, 0, this.tileHeight - 1 - rowIndex);
  }

  protected drawFrame(): void {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;

    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (viewSpan <= 0) {
      this.ctx.fillStyle = "#000000";
      this.ctx.fillRect(0, 0, width, height);
      return;
    }

    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, width, height);

    const visibleRowsTop = this.scrollOffset;
    const visibleRowsBottom =
      this.scrollOffset + Math.ceil(height / this.rowScale);

    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) {
        if (tile.rowCount === 0) continue;
        const tileTopRowsFromLive =
          this.totalRows - tile.startRow - tile.rowCount;
        const tileBotRowsFromLive = this.totalRows - tile.startRow - 1;
        if (tileTopRowsFromLive > visibleRowsBottom) continue;
        if (tileBotRowsFromLive < visibleRowsTop) continue;
        this.blitTile(tile, width, height, viewSpan);
      }
    }

    for (const tile of this.liveTiles) {
      if (tile.rowCount === 0) continue;
      const tileTopRowsFromLive =
        this.totalRows - tile.startRow - tile.rowCount;
      const tileBotRowsFromLive = this.totalRows - tile.startRow - 1;
      if (tileTopRowsFromLive > visibleRowsBottom) continue;
      if (tileBotRowsFromLive < visibleRowsTop) continue;
      this.blitTile(tile, width, height, viewSpan);
    }
  }

  protected onLevelsChanged(): void {
    for (const tile of this.liveTiles) this.reRenderTile(tile);
    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) this.reRenderTile(tile);
    }
  }

  protected onResize(): void {}
  protected destroyTile(): void {}
  protected onDestroy(): void {}

  // ---------------------------------------------------------------------------
  // Canvas 2D internals
  // ---------------------------------------------------------------------------

  private colorMapLine(bins: Uint8Array): void {
    const pixels = this.rowImageData.data;
    const minDb = this.minLevel;
    const range = this.maxLevel - minDb;
    const invRange = range > 0 ? 255 / range : 0;
    const lut = this.lut;
    const numBins = Math.min(bins.length, this.numBins);

    for (let x = 0; x < numBins; x++) {
      const dBm = bins[x] - 255;
      const raw = Math.max(0, Math.min(255, ((dBm - minDb) * invRange) | 0));
      const base = raw << 2;
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

  private blitTile(
    tile: WFTile,
    visibleWidth: number,
    visibleHeight: number,
    viewSpan: number,
  ): void {
    const layerSpan = tile.dataEndKHz - tile.dataStartKHz;
    if (layerSpan <= 0 || tile.rowCount <= 0) return;

    const overlapStart = Math.max(tile.dataStartKHz, this.viewStartKHz);
    const overlapEnd = Math.min(tile.dataEndKHz, this.viewEndKHz);
    if (overlapStart >= overlapEnd) return;

    const srcX =
      ((overlapStart - tile.dataStartKHz) / layerSpan) * this.numBins;
    const srcW =
      ((overlapEnd - overlapStart) / layerSpan) * this.numBins;
    const dstX =
      ((overlapStart - this.viewStartKHz) / viewSpan) * visibleWidth;
    const dstW = ((overlapEnd - overlapStart) / viewSpan) * visibleWidth;
    if (srcW < 0.5 || dstW < 0.5) return;

    const scaledOffset =
      (this.totalRows - tile.startRow - tile.rowCount - this.scrollOffset) *
      this.rowScale;
    if (scaledOffset >= visibleHeight) return;

    const srcY = this.tileHeight - tile.rowCount;
    const srcH = Math.min(
      tile.rowCount,
      Math.ceil((visibleHeight - scaledOffset) / this.rowScale),
    );
    if (srcH <= 0) return;
    const dstH = srcH * this.rowScale;

    this.ctx.imageSmoothingEnabled = srcW < dstW;
    this.ctx.drawImage(
      tile.canvas,
      srcX, srcY, srcW, srcH,
      dstX, scaledOffset, dstW, dstH,
    );
  }

  private reRenderTile(tile: WFTile): void {
    tile.ctx.fillStyle = "#000000";
    tile.ctx.fillRect(0, 0, this.numBins, this.tileHeight);
    for (let i = 0; i < tile.rowCount; i++) {
      const bins = tile.rawBins[i];
      if (!bins) continue;
      this.colorMapLine(bins);
      tile.ctx.putImageData(this.rowImageData, 0, this.tileHeight - 1 - i);
    }
  }
}
