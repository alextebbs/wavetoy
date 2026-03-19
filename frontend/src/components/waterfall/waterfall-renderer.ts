import { buildLUT, WATERFALL_COLOR_MAPS } from "@/lib/display-colors";
import { parseWFChunk, type WFChunkFrame } from "@/lib/chunk-parser";
import type { ChunkSource, ChunkMeta } from "@/lib/chunk-loader";
import type { WaterfallMarker } from "./waterfall-overlay";
import { streamLog, PerfBucket } from "@/lib/stream-logger";

export interface RendererOptions {
  minLevel?: number;
  maxLevel?: number;
  rowScale?: number;
  tileHeight?: number;
}

export interface OverlayState {
  totalRows: number;
  scrollOffset: number;
  logicalScrollOffset: number;
  headShiftPx: number;
  rowScale: number;
  height: number;
  dpr: number;
  maxScrollOffset: number;
  isLive: boolean;
  playbackRow: number | null;
}

const DEFAULT_TILE_HEIGHT = 256;
const NUM_BINS = 1024;
const MAX_ZOOM = 14;
const EVICT_DISTANCE_ROWS = 4 * 480;

interface WFTile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  rawBins: (Uint8Array | null)[];
  rowCount: number;
  dataStartKHz: number;
  dataEndKHz: number;
  startRow: number;
}

interface ChunkEntry {
  startedAt: string;
  sourceId: string;
  startRow: number;
  frameCount: number;
  complete: boolean;
  loaded: boolean;
  loading: boolean;
  tiles: WFTile[];
  expectedWF: number;
  audioBytes: number;
  actualWF: number | null;
}

function coverageFromFrame(
  xBin: number,
  zoom: number,
  maxBandwidthKHz: number,
): { startKHz: number; endKHz: number } {
  const totalBins = NUM_BINS * (1 << MAX_ZOOM);
  const binScale = 1 << (MAX_ZOOM - zoom);
  const startKHz = (xBin / totalBins) * maxBandwidthKHz;
  const endKHz =
    ((xBin + NUM_BINS * binScale) / totalBins) * maxBandwidthKHz;
  return { startKHz, endKHz };
}

export class WaterfallRenderer {
  private visibleCanvas: HTMLCanvasElement;
  private visibleCtx: CanvasRenderingContext2D;

  private readonly numBins = NUM_BINS;
  private readonly tileHeight: number;
  private readonly rowScale: number;

  private liveTiles: WFTile[] = [];
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

  // --- Chunk management ---
  private chunks: ChunkEntry[] = [];
  private chunkSource: ChunkSource | null = null;
  private liveFrameCount = 0;
  private liveChunkStartRow = 0;
  private liveChunkStartedAt: string | null = null;
  private streamSampleRate = 12000;
  private streamChunkDurationS = 60;
  private markers = new Map<string, WaterfallMarker>();

  onOverlayUpdate: ((state: OverlayState, markers: WaterfallMarker[]) => void) | null = null;
  onMarkerAdd: ((marker: WaterfallMarker) => void) | null = null;
  onMarkerRemove: ((id: string) => void) | null = null;

  private perfFlush = new PerfBucket("perf.wf.flush");
  private perfFetch = new PerfBucket("perf.wf.fetchChunk");

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
    this.liveTiles.push(this.liveTile);
  }

  private createTile(
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
      rowCount: 0,
      dataStartKHz,
      dataEndKHz,
      startRow,
    };
  }

  // --- Public API ---

  setLevels(min: number, max: number): void {
    this.autoLevel = false;
    this.minLevel = min;
    this.maxLevel = max;
    for (const tile of this.liveTiles) {
      this.reRenderTile(tile);
    }
    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) {
        this.reRenderTile(tile);
      }
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
      this.liveTiles.push(this.liveTile);
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

    this.liveFrameCount++;
    this.queue.push(bins);
  }

  pushBins(bins: Uint8Array): void {
    this.liveFrameCount++;
    this.queue.push(bins);
  }

  startRenderLoop(): void {
    if (this.rafId !== null) return;
    this.perfFlush.start();
    this.perfFetch.start();
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
    this.perfFlush.stop();
    this.perfFetch.stop();
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
    this.liveTiles.length = 0;
    this.chunks.length = 0;
  }

  get currentLevels(): { min: number; max: number } {
    return { min: this.minLevel, max: this.maxLevel };
  }

  get rowCount(): number {
    return this.totalRows;
  }

  get visibleRows(): number {
    const h = this.visibleCanvas.height;
    return h > 0 ? Math.ceil(h / this.rowScale) : 0;
  }

  cssToRows(px: number): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.round((px * dpr) / this.rowScale);
  }

  get chunkManifest(): ReadonlyArray<{
    startedAt: string;
    startRow: number;
    frameCount: number;
    complete: boolean;
    audioBytes: number;
  }> {
    const result: Array<{
      startedAt: string;
      startRow: number;
      frameCount: number;
      complete: boolean;
      audioBytes: number;
    }> = this.chunks.map((c) => ({
      startedAt: c.startedAt,
      startRow: c.startRow,
      frameCount: c.frameCount,
      complete: c.complete,
      audioBytes: c.audioBytes,
    }));

    if (result.length > 0) {
      const last = result[result.length - 1];
      if (!last.complete) {
        const coveredEnd = last.startRow + last.frameCount;
        const liveEnd = this.totalRows;
        if (liveEnd > coveredEnd) {
          result[result.length - 1] = {
            ...last,
            frameCount: liveEnd - last.startRow,
          };
        }
        return result;
      }
    }

    if (this.liveChunkStartedAt && this.totalRows > this.liveChunkStartRow) {
      const lastEnd =
        result.length > 0
          ? result[result.length - 1].startRow +
            result[result.length - 1].frameCount
          : this.liveChunkStartRow;
      if (this.liveChunkStartRow >= lastEnd) {
        result.push({
          startedAt: this.liveChunkStartedAt,
          startRow: this.liveChunkStartRow,
          frameCount: this.totalRows - this.liveChunkStartRow,
          complete: false,
          audioBytes: -1,
        });
      }
    }

    return result;
  }

  get maxScrollOffset(): number {
    return this.totalRows - this.lowestStartRow;
  }

  get isLive(): boolean {
    return this.scrollOffset === 0;
  }

  private _playbackRow: number | null = null;

  get playbackRow(): number | null {
    return this._playbackRow;
  }

  set playbackRow(row: number | null) {
    if (row === this._playbackRow) return;
    this._playbackRow = row;
    this.needsRepaint = true;
  }

  private static readonly HEAD_PX = 40;

  get headShift(): number {
    return this.cssToRows(WaterfallRenderer.HEAD_PX);
  }

  get renderOffset(): number {
    return this.scrollOffset - this.headShift;
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

  // --- Chunk-aware public API ---

  resetLiveFrameCount(): void {
    this.liveFrameCount = 0;
  }

  setChunkSource(source: ChunkSource): void {
    this.chunkSource = source;
  }

  async loadManifest(
    chunkMetas: ChunkMeta[],
    streamInfo?: { sampleRate: number; chunkDurationS: number },
  ): Promise<number> {
    if (streamInfo) {
      this.streamSampleRate = streamInfo.sampleRate;
      this.streamChunkDurationS = streamInfo.chunkDurationS;
    }
    const sorted = [...chunkMetas].sort(
      (a, b) =>
        new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
    );

    if (sorted.length === 0) return 0;

    const liveCount = this.liveFrameCount;

    let totalFrames = 0;
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      let count = c.wf_frames;
      if (i === sorted.length - 1 && !c.complete && liveCount > 0) {
        count = Math.max(0, count - liveCount);
      }
      totalFrames += count;
    }

    if (totalFrames === 0) return 0;

    let currentRow = -totalFrames;
    this.chunks = [];

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      let count = c.wf_frames;
      if (i === sorted.length - 1 && !c.complete && liveCount > 0) {
        count = Math.max(0, count - liveCount);
      }

      const entry: ChunkEntry = {
        startedAt: c.started_at,
        sourceId: c.source_id,
        startRow: currentRow,
        frameCount: count,
        complete: c.complete,
        loaded: false,
        loading: false,
        tiles: [],
        expectedWF: c.wf_frames,
        audioBytes: c.audio_bytes,
        actualWF: null,
      };
      this.chunks.push(entry);

      const markerRow = currentRow + count;
      const expectedAudio =
        this.streamSampleRate * this.streamChunkDurationS * 2;
      this.addMarker({
        id: `chunk-${c.started_at}`,
        row: markerRow,
        label: c.started_at,
        metadata: {
          started_at: c.started_at,
          source_id: c.source_id,
          complete: c.complete,
          wf_frames: c.wf_frames,
          audio_bytes: c.audio_bytes,
          audio_expected: expectedAudio,
        },
      });

      currentRow += count;
    }

    if (this.chunks.length > 0) {
      this.lowestStartRow = this.chunks[0].startRow;
      this.needsRepaint = true;
    }

    const last = this.chunks[this.chunks.length - 1];
    if (last && !last.complete) {
      this.liveChunkStartedAt = last.startedAt;
    }

    await this.loadInitialChunks();
    return totalFrames;
  }

  onChunkComplete(msg: {
    started_at: string;
    ended_at?: string;
    source_id?: string;
    wf_frames?: number;
    audio_bytes?: number;
  }): void {
    const existing = this.chunks.find((s) => s.startedAt === msg.started_at);
    if (existing) {
      existing.complete = true;
      if (msg.wf_frames != null) existing.expectedWF = msg.wf_frames;
      if (msg.audio_bytes != null) existing.audioBytes = msg.audio_bytes;

      if (msg.wf_frames != null && msg.wf_frames > existing.frameCount) {
        existing.frameCount = msg.wf_frames;
      }

      const markerId = `chunk-${existing.startedAt}`;
      const marker = this.markers.get(markerId);
      if (marker) {
        marker.row = existing.startRow + existing.frameCount;
        this.addMarker(marker);
      }

      if (!existing.loading) {
        existing.loaded = false;
        this.fetchChunk(existing);
      }

      this.liveChunkStartRow = existing.startRow + existing.frameCount;
      this.liveChunkStartedAt = msg.ended_at ?? null;
      return;
    }

    const endRow = this.totalRows;
    const frameCount = endRow - this.liveChunkStartRow;
    const expectedWF = msg.wf_frames ?? frameCount;
    const audioBytes = msg.audio_bytes ?? 0;
    if (frameCount > 0) {
      const entry: ChunkEntry = {
        startedAt: msg.started_at,
        sourceId: msg.source_id ?? "",
        startRow: this.liveChunkStartRow,
        frameCount,
        complete: true,
        loaded: false,
        loading: false,
        tiles: [],
        expectedWF,
        audioBytes,
        actualWF: null,
      };
      this.chunks.push(entry);
      this.fetchChunk(entry);
    }

    const expectedAudio =
      this.streamSampleRate * this.streamChunkDurationS * 2;
    this.addMarker({
      id: `chunk-${msg.started_at}`,
      row: endRow,
      label: msg.started_at,
      metadata: {
        started_at: msg.started_at,
        ended_at: msg.ended_at,
        source_id: msg.source_id,
        complete: true,
        wf_frames: frameCount,
        audio_bytes: audioBytes,
        audio_expected: expectedAudio,
      },
    });

    this.liveChunkStartRow = endRow;
    this.liveChunkStartedAt = msg.ended_at ?? null;
  }

  // --- Private: markers ---

  private addMarker(marker: WaterfallMarker): void {
    this.markers.set(marker.id, marker);
    this.onMarkerAdd?.(marker);
  }

  private removeMarker(id: string): void {
    this.markers.delete(id);
    this.onMarkerRemove?.(id);
  }

  private updateChunkMarker(entry: ChunkEntry): void {
    const id = `chunk-${entry.startedAt}`;
    const existing = this.markers.get(id);
    if (!existing) return;
    const expectedAudio =
      this.streamSampleRate * this.streamChunkDurationS * 2;
    this.addMarker({
      ...existing,
      row: entry.startRow + entry.frameCount,
      metadata: {
        ...existing.metadata,
        complete: entry.complete,
        wf_frames: entry.actualWF ?? entry.expectedWF,
        audio_bytes: entry.audioBytes,
        audio_expected: expectedAudio,
      },
    });
  }

  // --- Private: render loop ---

  private flush(): void {
    const lines = this.queue.splice(0, this.queue.length);
    const hasNewData = lines.length > 0;

    if (!hasNewData && !this.needsRepaint) return;

    const t0 = performance.now();

    if (hasNewData) {
      for (const bins of lines) {
        if (this.autoLevel) this.updateAutoLevel(bins);
        this.appendToLiveTile(bins);
      }
    }

    this.pruneLiveTiles();
    this.checkViewport();
    this.blitToVisible();
    this.needsRepaint = false;
    const dpr = window.devicePixelRatio || 1;
    const state: OverlayState = {
      totalRows: this.totalRows,
      scrollOffset: this.renderOffset,
      logicalScrollOffset: this.scrollOffset,
      headShiftPx: (this.headShift * this.rowScale) / dpr,
      rowScale: this.rowScale,
      height: this.visibleCanvas.height,
      dpr,
      maxScrollOffset: this.maxScrollOffset,
      isLive: this.isLive,
      playbackRow: this.playbackRow,
    };
    this.onOverlayUpdate?.(state, [...this.markers.values()]);

    this.perfFlush.record(performance.now() - t0);
  }

  private appendToLiveTile(bins: Uint8Array): void {
    if (this.liveTile.rowCount >= this.tileHeight) {
      this.liveTile = this.createTile(
        this.totalRows,
        this.dataStartKHz,
        this.dataEndKHz,
      );
      this.liveTiles.push(this.liveTile);
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

    const effectiveOffset = this.renderOffset;
    const visibleRowsTop = effectiveOffset;
    const visibleRowsBottom =
      effectiveOffset + Math.ceil(height / this.rowScale);

    // Blit chunk tiles first (older data, drawn underneath)
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

    // Blit live tiles on top (newer data)
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
      (this.totalRows - tile.startRow - tile.rowCount - this.renderOffset) *
      this.rowScale;
    if (scaledOffset >= visibleHeight) return;

    const srcY = this.tileHeight - tile.rowCount;
    const srcH = Math.min(
      tile.rowCount,
      Math.ceil((visibleHeight - scaledOffset) / this.rowScale),
    );
    if (srcH <= 0) return;
    const dstH = srcH * this.rowScale;

    this.visibleCtx.imageSmoothingEnabled = srcW < dstW;
    this.visibleCtx.drawImage(
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

  private pruneLiveTiles(): void {
    const { height } = this.visibleCanvas;
    if (height === 0) return;

    this.liveTiles = this.liveTiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      const displayTopY =
        (this.totalRows - tile.startRow - tile.rowCount - this.renderOffset) *
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

  // --- Private: chunk loading / eviction ---

  private checkViewport(): void {
    if (this.chunks.length === 0 || !this.chunkSource) return;

    const visibleRows = Math.ceil(
      this.visibleCanvas.height / (this.rowScale * (window.devicePixelRatio || 1)),
    );
    const topFromLive = this.renderOffset;
    const bottomFromLive = this.renderOffset + visibleRows;

    for (let ci = 0; ci < this.chunks.length; ci++) {
      const slot = this.chunks[ci];
      const slotTopFromLive =
        this.totalRows - slot.startRow - slot.frameCount;
      const slotBottomFromLive = this.totalRows - slot.startRow - 1;

      const inView =
        slotBottomFromLive >= topFromLive &&
        slotTopFromLive <= bottomFromLive;

      const nearView = this.isNearViewport(
        ci,
        topFromLive,
        bottomFromLive,
      );

      if ((inView || nearView) && !slot.loaded && !slot.loading && slot.frameCount > 0) {
        this.fetchChunk(slot);
      }
    }

    this.evictDistant(topFromLive, bottomFromLive);
  }

  private isNearViewport(
    chunkIdx: number,
    topFromLive: number,
    bottomFromLive: number,
  ): boolean {
    for (const offset of [-1, 1]) {
      const ni = chunkIdx + offset;
      if (ni < 0 || ni >= this.chunks.length) continue;
      const neighbor = this.chunks[ni];
      const nTop = this.totalRows - neighbor.startRow - neighbor.frameCount;
      const nBot = this.totalRows - neighbor.startRow - 1;
      if (nBot >= topFromLive && nTop <= bottomFromLive) {
        return true;
      }
    }
    return false;
  }

  private async loadInitialChunks(): Promise<void> {
    const toLoad = this.chunks
      .slice(-3)
      .filter((s) => !s.loaded && !s.loading && s.frameCount > 0);
    await Promise.all(toLoad.map((s) => this.fetchChunk(s)));
  }

  private async fetchChunk(entry: ChunkEntry): Promise<void> {
    if (!this.chunkSource) return;
    entry.loading = true;
    const t0 = performance.now();
    try {
      const buffer = await this.chunkSource.fetchWF(entry.startedAt);
      let frames = parseWFChunk(buffer);
      const fetchedCount = frames.length;

      const isNewest =
        this.chunks.length > 0 &&
        this.chunks[this.chunks.length - 1] === entry;
      if (isNewest && !entry.complete) {
        const liveCount = this.liveFrameCount;
        if (liveCount > 0) {
          const trimmed = frames.length - liveCount;
          frames = trimmed > 0 ? frames.slice(0, trimmed) : [];
        }
      }

      if (frames.length > 0) {
        this.insertFramesAsChunkTiles(entry, frames);
      }

      entry.actualWF = fetchedCount;
      entry.loaded = true;
      this.retireLiveTiles(entry.startRow, entry.startRow + entry.frameCount);
      this.updateChunkMarker(entry);

      const elapsed = performance.now() - t0;
      this.perfFetch.record(elapsed);
      streamLog.debug(
        "perf.wf.fetchChunk",
        `frames=${fetchedCount} elapsed=${elapsed.toFixed(1)}ms`,
      );
    } catch (err) {
      console.error(`Failed to load chunk ${entry.startedAt}:`, err);
    } finally {
      entry.loading = false;
    }
  }

  /**
   * Remove live tiles fully contained within [startRow, endRow). Called after
   * a chunk loads so the server-authoritative data replaces the draft
   * in-browser tiles.
   */
  private retireLiveTiles(startRow: number, endRow: number): void {
    const before = this.liveTiles.length;
    this.liveTiles = this.liveTiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      const tileEnd = tile.startRow + tile.rowCount;
      if (tile.startRow >= startRow && tileEnd <= endRow) return false;
      return true;
    });
    if (this.liveTiles.length !== before) {
      this.needsRepaint = true;
    }
  }

  private insertFramesAsChunkTiles(
    entry: ChunkEntry,
    frames: WFChunkFrame[],
  ): void {
    let i = 0;
    let row = entry.startRow;
    entry.tiles = [];

    while (i < frames.length) {
      const anchor = frames[i];
      let j = i + 1;
      while (
        j < frames.length &&
        j - i < this.tileHeight &&
        frames[j].xBin === anchor.xBin &&
        frames[j].zoom === anchor.zoom
      ) {
        j++;
      }

      const { startKHz, endKHz } = coverageFromFrame(
        anchor.xBin,
        anchor.zoom,
        this.maxBandwidthKHz,
      );

      const tile = this.createTile(row, startKHz, endKHz);
      for (let k = i; k < j; k++) {
        tile.rawBins.push(new Uint8Array(frames[k].bins));
        this.colorMapLine(frames[k].bins);
        tile.ctx.putImageData(
          this.rowImageData,
          0,
          this.tileHeight - 1 - tile.rowCount,
        );
        tile.rowCount++;
      }
      entry.tiles.push(tile);

      row += j - i;
      i = j;
    }

    this.needsRepaint = true;
  }

  private evictDistant(topFromLive: number, bottomFromLive: number): void {
    for (const entry of this.chunks) {
      if (!entry.loaded) continue;

      const slotTopFromLive =
        this.totalRows - entry.startRow - entry.frameCount;
      const slotBottomFromLive = this.totalRows - entry.startRow - 1;

      const dist = Math.max(
        0,
        Math.max(
          slotTopFromLive - bottomFromLive,
          topFromLive - slotBottomFromLive,
        ),
      );

      if (dist > EVICT_DISTANCE_ROWS) {
        entry.tiles = [];
        entry.loaded = false;
      }
    }
  }
}
