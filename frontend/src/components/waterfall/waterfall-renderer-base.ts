import { parseWFChunk, type WFChunkFrame } from "@/lib/chunk-parser";
import { type ChunkManager, type ChunkEntry, type WaterfallMarker } from "@/lib/chunk-manager";
import { streamLog, PerfBucket } from "@/lib/stream-logger";

export type { ChunkManager, ChunkEntry, WaterfallMarker };

export interface RendererOptions {
  minLevel?: number;
  maxLevel?: number;
  rowScale?: number;
  tileHeight?: number;
}

export interface LoadingChunkRegion {
  startRow: number;
  frameCount: number;
}

export interface OverlayState {
  totalRows: number;
  scrollOffset: number;
  rowScale: number;
  height: number;
  dpr: number;
  maxScrollOffset: number;
  isLive: boolean;
  playbackRow: number | null;
  loadingChunks: LoadingChunkRegion[];
}

export interface TuningPoint {
  freqKHz: number;
  passbandLo: number;
  passbandHi: number;
}

export interface TuningTracePoint {
  yCss: number;
  centerX: number;
  loX: number;
  hiX: number;
}

export interface BaseTile {
  rawBins: (Uint8Array | null)[];
  tuning: (TuningPoint | null)[];
  rowCount: number;
  dataStartKHz: number;
  dataEndKHz: number;
  startRow: number;
}

const DEFAULT_TILE_HEIGHT = 256;
const NUM_BINS = 1024;
const MAX_ZOOM = 14;
const EVICT_DISTANCE_ROWS = 8 * 480;

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

export abstract class WaterfallRendererBase<T extends BaseTile> {
  protected readonly canvas: HTMLCanvasElement;
  protected readonly numBins = NUM_BINS;
  protected readonly tileHeight: number;
  protected readonly rowScale: number;

  readonly manager: ChunkManager;

  protected liveTiles: T[] = [];
  protected liveTile!: T;
  protected minLevel: number;
  protected maxLevel: number;
  protected viewStartKHz = 0;
  protected viewEndKHz = 30000;
  protected needsRepaint = false;

  private queue: Uint8Array[] = [];
  private lastXBin = -1;
  private lastZoom = -1;
  private rafId: number | null = null;

  private autoLevel = true;
  private smoothMin: number;
  private smoothMax: number;
  private samplesCount = 0;
  private readonly AUTO_ALPHA = 0.05;

  protected dataStartKHz = 0;
  protected dataEndKHz = 30000;
  private maxBandwidthKHz = 30000;

  private currentTuning: TuningPoint | null = null;

  onOverlayUpdate: ((state: OverlayState, markers: WaterfallMarker[]) => void) | null = null;
  onTuningTrace: ((points: TuningTracePoint[]) => void) | null = null;

  private perfFlush = new PerfBucket("perf.wf.flush");
  private perfFetch = new PerfBucket("perf.wf.fetchChunk");

  constructor(canvas: HTMLCanvasElement, manager: ChunkManager, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.manager = manager;
    this.tileHeight = options.tileHeight ?? DEFAULT_TILE_HEIGHT;
    this.rowScale = options.rowScale ?? 1;
    this.minLevel = options.minLevel ?? -110;
    this.maxLevel = options.maxLevel ?? -10;
    this.smoothMin = this.minLevel;
    this.smoothMax = this.maxLevel;

    manager.onTilesEvicted = (entries) => {
      for (const entry of entries) {
        for (const tile of entry.tiles as T[]) this.destroyTile(tile);
        entry.tiles = [];
      }
    };

    manager.onCoordinateShift = (shift) => {
      for (const tile of this.liveTiles) {
        tile.startRow += shift;
      }
    };

    this.initContext();
    this.liveTile = this.createTile(0, this.dataStartKHz, this.dataEndKHz);
    this.liveTiles.push(this.liveTile);
  }

  // ---------------------------------------------------------------------------
  // Abstract methods — each renderer backend implements these
  // ---------------------------------------------------------------------------

  protected abstract initContext(): void;

  protected abstract createTile(
    startRow: number,
    dataStartKHz: number,
    dataEndKHz: number,
  ): T;

  protected abstract writeRow(tile: T, bins: Uint8Array, rowIndex: number): void;

  protected abstract drawFrame(): void;

  protected abstract onLevelsChanged(): void;

  protected abstract onResize(width: number, height: number): void;

  protected abstract destroyTile(tile: T): void;

  protected abstract onDestroy(): void;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setLevels(min: number, max: number): void {
    this.autoLevel = false;
    this.minLevel = min;
    this.maxLevel = max;
    this.onLevelsChanged();
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

  setCurrentTuning(freqKHz: number, passbandLo: number, passbandHi: number): void {
    this.currentTuning = { freqKHz, passbandLo, passbandHi };
  }

  setDataCoverage(startKHz: number, endKHz: number): void {
    if (startKHz === this.dataStartKHz && endKHz === this.dataEndKHz) return;

    if (this.liveTile.rowCount > 0) {
      this.liveTile = this.createTile(this.manager.totalRows, startKHz, endKHz);
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
    if (xBin !== this.lastXBin || zoom !== this.lastZoom) {
      this.lastXBin = xBin;
      this.lastZoom = zoom;

      const totalBins = this.numBins * (1 << MAX_ZOOM);
      const binScale = 1 << (MAX_ZOOM - zoom);
      const frameStart = (xBin / totalBins) * this.maxBandwidthKHz;
      const frameEnd =
        ((xBin + this.numBins * binScale) / totalBins) * this.maxBandwidthKHz;
      this.setDataCoverage(frameStart, frameEnd);
    }

    this.manager.liveFrameCount++;
    this.manager.pendingRows++;
    this.queue.push(bins);
  }

  pushBins(bins: Uint8Array): void {
    this.manager.liveFrameCount++;
    this.manager.pendingRows++;
    this.queue.push(bins);
  }

  /**
   * Drop all queued frames and advance totalRows to keep the coordinate system
   * consistent. Used on tab wake-up to avoid rendering thousands of stale frames.
   */
  drainStaleQueue(): void {
    const count = this.queue.length;
    if (count === 0) return;
    this.queue.length = 0;
    this.manager.pendingRows = 0;
    this.manager.totalRows += count;
    if (this.manager.scrollOffset > 0) {
      this.manager.scrollOffset += count;
    }
    // Reset the live tile so new frames start at the correct position
    if (this.liveTile) {
      this.destroyTile(this.liveTile);
    }
    this.liveTiles = this.liveTiles.filter((t) => t !== this.liveTile);
    this.liveTile = this.createTile(
      this.manager.totalRows,
      this.dataStartKHz,
      this.dataEndKHz,
    );
    this.liveTiles.push(this.liveTile);
    this.needsRepaint = true;
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
    this.canvas.width = width;
    this.canvas.height = height;
    this.onResize(width, height);
    this.drawFrame();
  }

  destroy(): void {
    streamLog.warn(
      "wf.destroy",
      `chunks=${this.manager.chunks.length} liveTiles=${this.liveTiles.length}`,
    );
    this.stopRenderLoop();
    this.queue.length = 0;
    for (const tile of this.liveTiles) this.destroyTile(tile);
    for (const chunk of this.manager.chunks) {
      for (const tile of chunk.tiles as T[]) this.destroyTile(tile);
    }
    this.liveTiles.length = 0;
    this.onDestroy();
  }

  get currentLevels(): { min: number; max: number } {
    return { min: this.minLevel, max: this.maxLevel };
  }

  get rowCount(): number {
    return this.manager.totalRows;
  }

  get visibleRows(): number {
    const h = this.canvas.height;
    const v = h > 0 ? Math.ceil(h / this.rowScale) : 0;
    this.manager.visibleRows = v;
    return v;
  }

  cssToRows(px: number): number {
    const dpr = window.devicePixelRatio || 1;
    return (px * dpr) / this.rowScale;
  }

  get maxScrollOffset(): number {
    return this.manager.maxScrollOffset;
  }

  get isLive(): boolean {
    return this.manager.isLive;
  }

  get playbackRow(): number | null {
    return this.manager.playbackRow;
  }

  set playbackRow(row: number | null) {
    if (row === this.manager.playbackRow) return;
    this.manager.playbackRow = row;
    this.needsRepaint = true;
  }

  getScrollOffset(): number {
    return this.manager.scrollOffset;
  }

  setScrollOffset(offset: number): void {
    this.manager.setScrollOffset(offset);
    this.needsRepaint = true;
  }

  scrollToLive(): void {
    this.manager.scrollToLive();
    this.needsRepaint = true;
  }

  requestRepaint(): void {
    this.needsRepaint = true;
  }

  get chunkManifest() {
    return this.manager.chunkManifest;
  }

  resetLiveFrameCount(): void {
    this.manager.resetLiveFrameCount();
  }

  /**
   * Kick off loading the initial visible set of chunk tiles after the manager
   * has populated its chunk list (e.g. after loadManifest).
   */
  async loadInitialChunks(): Promise<void> {
    const visibleRows = Math.ceil(
      this.canvas.height / (this.rowScale * (window.devicePixelRatio || 1)),
    );
    const topFromLive = this.manager.scrollOffset;
    const bottomFromLive = this.manager.scrollOffset + visibleRows;

    const toLoad = this.manager.chunks.filter((s) => {
      if (s.loaded || s.loading || s.frameCount === 0) return false;
      const slotTop = this.manager.totalRows - s.startRow - s.frameCount;
      const slotBot = this.manager.totalRows - s.startRow - 1;
      return slotBot >= topFromLive && slotTop <= bottomFromLive;
    });

    if (toLoad.length === 0) {
      const fallback = this.manager.chunks
        .slice(-3)
        .filter((s) => !s.loaded && !s.loading && s.frameCount > 0);
      await Promise.all(fallback.map((s) => this.fetchChunk(s)));
      return;
    }

    const firstIdx = this.manager.chunks.indexOf(toLoad[0]);
    const lastIdx = this.manager.chunks.indexOf(toLoad[toLoad.length - 1]);
    if (firstIdx > 0) {
      const prev = this.manager.chunks[firstIdx - 1];
      if (!prev.loaded && !prev.loading && prev.frameCount > 0) toLoad.unshift(prev);
    }
    if (lastIdx < this.manager.chunks.length - 1) {
      const next = this.manager.chunks[lastIdx + 1];
      if (!next.loaded && !next.loading && next.frameCount > 0) toLoad.push(next);
    }

    await Promise.all(toLoad.map((s) => this.fetchChunk(s)));
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  private flush(): void {
    const MAX_BATCH = 500;
    const batchSize = Math.min(this.queue.length, MAX_BATCH);
    const lines = this.queue.splice(0, batchSize);
    this.manager.pendingRows -= lines.length;
    const hasNewData = lines.length > 0;
    const hasBacklog = this.queue.length > 0;

    if (!hasNewData && !this.needsRepaint) return;
    if (hasBacklog) this.needsRepaint = true;

    const t0 = performance.now();

    if (hasNewData) {
      for (const bins of lines) {
        if (this.autoLevel) this.updateAutoLevel(bins);
        this.appendToLiveTile(bins);
      }
    }

    this.pruneLiveTiles();
    this.checkViewport();
    this.drawFrame();
    this.needsRepaint = false;
    const loadingChunks: LoadingChunkRegion[] = [];
    for (const c of this.manager.chunks) {
      if (c.loading && c.frameCount > 0) {
        loadingChunks.push({ startRow: c.startRow, frameCount: c.frameCount });
      }
    }

    const state: OverlayState = {
      totalRows: this.manager.totalRows,
      scrollOffset: this.manager.scrollOffset,
      rowScale: this.rowScale,
      height: this.canvas.height,
      dpr: window.devicePixelRatio || 1,
      maxScrollOffset: this.manager.maxScrollOffset,
      isLive: this.manager.isLive,
      playbackRow: this.manager.playbackRow,
      loadingChunks,
    };
    this.onOverlayUpdate?.(state, [...this.manager.markers.values()]);

    if (this.onTuningTrace) {
      this.onTuningTrace(this.computeTuningTrace());
    }

    this.perfFlush.record(performance.now() - t0);
  }

  private appendToLiveTile(bins: Uint8Array): void {
    if (this.liveTile.rowCount >= this.tileHeight) {
      this.liveTile = this.createTile(
        this.manager.totalRows,
        this.dataStartKHz,
        this.dataEndKHz,
      );
      this.liveTiles.push(this.liveTile);
    }

    const tile = this.liveTile;
    tile.rawBins.push(new Uint8Array(bins));
    tile.tuning.push(this.currentTuning ? { ...this.currentTuning } : null);
    this.writeRow(tile, bins, tile.rowCount);
    tile.rowCount++;
    this.manager.advanceLive();
  }

  private pruneLiveTiles(): void {
    const { height } = this.canvas;
    if (height === 0) return;

    this.liveTiles = this.liveTiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      const displayTopY =
        (this.manager.totalRows - tile.startRow - tile.rowCount - this.manager.scrollOffset) *
        this.rowScale;
      if (displayTopY >= height) {
        this.destroyTile(tile);
        return false;
      }
      return true;
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

  // ---------------------------------------------------------------------------
  // Chunk loading / eviction
  // ---------------------------------------------------------------------------

  private lastChunkDiagAt = 0;

  private checkViewport(): void {
    const visibleRows = Math.ceil(
      this.canvas.height / (this.rowScale * (window.devicePixelRatio || 1)),
    );
    this.manager.visibleRows = visibleRows;
    const topFromLive = this.manager.scrollOffset;
    const bottomFromLive = this.manager.scrollOffset + visibleRows;

    this.emitChunkDiag(topFromLive, bottomFromLive);

    if (this.manager.chunks.length === 0 || !this.manager.source) return;

    const prefetchTop = Math.max(0, topFromLive - visibleRows);
    const prefetchBottom = bottomFromLive + visibleRows;

    for (let ci = 0; ci < this.manager.chunks.length; ci++) {
      const slot = this.manager.chunks[ci];
      const slotTopFromLive =
        this.manager.totalRows - slot.startRow - slot.frameCount;
      const slotBottomFromLive = this.manager.totalRows - slot.startRow - 1;

      const inPrefetchZone =
        slotBottomFromLive >= prefetchTop &&
        slotTopFromLive <= prefetchBottom;

      if (inPrefetchZone && !slot.loaded && !slot.loading && slot.frameCount > 0) {
        if (slot.failCount === 0 || performance.now() >= slot.nextRetryAt) {
          this.fetchChunk(slot);
        }
      }

      if (!inPrefetchZone && slot.loading && slot.abortController) {
        streamLog.debug("wf.chunk.abort", `chunk=${slot.startedAt} scrolled out of view`);
        slot.abortController.abort();
      }
    }

    this.evictDistant(topFromLive, bottomFromLive);
    this.manager.checkEdges(topFromLive, bottomFromLive);
  }

  private async fetchChunk(entry: ChunkEntry): Promise<void> {
    if (!this.manager.source) return;
    entry.loading = true;
    const ac = new AbortController();
    entry.abortController = ac;
    const t0 = performance.now();
    try {
      const buffer = await this.manager.source.fetchWF(entry.startedAt, ac.signal);
      let frames = parseWFChunk(buffer);
      const fetchedCount = frames.length;

      const isNewest =
        this.manager.chunks.length > 0 &&
        this.manager.chunks[this.manager.chunks.length - 1] === entry;
      if (isNewest && !entry.complete) {
        const liveCount = this.manager.liveFrameCount;
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
      this.manager.addMarker(this.buildChunkMarker(entry));

      const elapsed = performance.now() - t0;
      this.perfFetch.record(elapsed);
      streamLog.debug(
        "perf.wf.fetchChunk",
        `chunk=${entry.startedAt} frames=${fetchedCount} tiles=${entry.tiles.length} elapsed=${elapsed.toFixed(1)}ms`,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        streamLog.debug("wf.chunk.aborted", `chunk=${entry.startedAt}`);
      } else {
        entry.failCount++;
        const MAX_RETRIES = 5;
        if (entry.failCount >= MAX_RETRIES) {
          entry.loaded = true;
          streamLog.warn("wf.chunk.failed", `chunk=${entry.startedAt} giving up after ${MAX_RETRIES} failures`);
        } else {
          const backoffMs = Math.min(2000 * Math.pow(2, entry.failCount - 1), 30000);
          entry.nextRetryAt = performance.now() + backoffMs;
          streamLog.warn("wf.chunk.retry", `chunk=${entry.startedAt} attempt=${entry.failCount}/${MAX_RETRIES} backoff=${backoffMs}ms err=${err}`);
        }
      }
    } finally {
      entry.loading = false;
      entry.abortController = null;
    }
  }

  private buildChunkMarker(entry: ChunkEntry): WaterfallMarker {
    const id = `chunk-${entry.startedAt}`;
    const existing = this.manager.markers.get(id);
    const expectedAudio =
      this.manager.streamSampleRate * this.manager.streamChunkDurationS * 2;
    return {
      id,
      row: entry.startRow + entry.frameCount,
      label: existing?.label ?? String(entry.startedAt),
      metadata: {
        ...(existing?.metadata ?? {}),
        complete: entry.complete,
        wf_frames: entry.actualWF ?? entry.expectedWF,
        audio_bytes: entry.audioBytes,
        audio_expected: expectedAudio,
      },
    };
  }

  private retireLiveTiles(startRow: number, endRow: number): void {
    const before = this.liveTiles.length;
    this.liveTiles = this.liveTiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      const tileEnd = tile.startRow + tile.rowCount;
      if (tile.startRow >= startRow && tileEnd <= endRow) {
        this.destroyTile(tile);
        return false;
      }
      return true;
    });
    if (this.liveTiles.length !== before) {
      this.needsRepaint = true;
    }
  }

  private computeChunkLevels(frames: WFChunkFrame[]): {
    min: number;
    max: number;
  } {
    const sampleBins: number[] = [];
    const step = Math.max(1, Math.floor(frames.length / 20));
    for (let i = 0; i < frames.length; i += step) {
      const bins = frames[i].bins;
      for (let j = 0; j < bins.length; j++) {
        sampleBins.push(bins[j] - 255);
      }
    }
    sampleBins.sort((a, b) => a - b);
    const p50 = sampleBins[Math.floor(sampleBins.length * 0.5)];
    const p95 = sampleBins[Math.floor(sampleBins.length * 0.95)];
    const min = p50 - 10;
    const max = Math.max(p95 + 20, min + 30);
    return { min, max };
  }

  private insertFramesAsChunkTiles(
    entry: ChunkEntry,
    frames: WFChunkFrame[],
  ): void {
    const savedMin = this.minLevel;
    const savedMax = this.maxLevel;

    const levels = this.computeChunkLevels(frames);
    this.minLevel = levels.min;
    this.maxLevel = levels.max;

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
        tile.tuning.push({
          freqKHz: frames[k].freqKHz,
          passbandLo: frames[k].passbandLo,
          passbandHi: frames[k].passbandHi,
        });
        this.writeRow(tile, frames[k].bins, tile.rowCount);
        tile.rowCount++;
      }
      entry.tiles.push(tile);

      row += j - i;
      i = j;
    }

    this.minLevel = savedMin;
    this.maxLevel = savedMax;
    this.needsRepaint = true;
  }

  private emitChunkDiag(topFromLive: number, bottomFromLive: number): void {
    const now = performance.now();
    if (now - this.lastChunkDiagAt < 5000) return;
    this.lastChunkDiagAt = now;

    let loaded = 0;
    let withTiles = 0;
    let loading = 0;
    let failed = 0;
    let inView = 0;

    for (const c of this.manager.chunks) {
      if (c.loaded) loaded++;
      if (c.tiles.length > 0) withTiles++;
      if (c.loading) loading++;
      if (c.failCount > 0) failed++;
      const top = this.manager.totalRows - c.startRow - c.frameCount;
      const bot = this.manager.totalRows - c.startRow - 1;
      if (bot >= topFromLive && top <= bottomFromLive) inView++;
    }

    streamLog.debug(
      "wf.chunk.diag",
      `chunks=${this.manager.chunks.length} loaded=${loaded} withTiles=${withTiles} ` +
      `loading=${loading} failed=${failed} inView=${inView} ` +
      `liveTiles=${this.liveTiles.length} totalRows=${this.manager.totalRows} ` +
      `scroll=${this.manager.scrollOffset} view=${topFromLive}-${bottomFromLive} ` +
      `chunkSrc=${this.manager.source ? "yes" : "NO"}`,
    );
  }

  private evictDistant(topFromLive: number, bottomFromLive: number): void {
    for (const entry of this.manager.chunks) {
      if (!entry.loaded) continue;

      const slotTopFromLive =
        this.manager.totalRows - entry.startRow - entry.frameCount;
      const slotBottomFromLive = this.manager.totalRows - entry.startRow - 1;

      const dist = Math.max(
        0,
        Math.max(
          slotTopFromLive - bottomFromLive,
          topFromLive - slotBottomFromLive,
        ),
      );

      if (dist > EVICT_DISTANCE_ROWS) {
        streamLog.debug(
          "wf.chunk.evict",
          `chunk=${entry.startedAt} tiles=${entry.tiles.length} dist=${dist} failCount=${entry.failCount}`,
        );
        for (const tile of entry.tiles as T[]) this.destroyTile(tile);
        entry.tiles = [];
        entry.loaded = false;
        entry.failCount = 0;
        entry.nextRetryAt = 0;
      }
    }
  }

  private computeTuningTrace(): TuningTracePoint[] {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return [];
    const dpr = window.devicePixelRatio || 1;
    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (viewSpan <= 0) return [];

    const visibleTop = this.manager.scrollOffset;
    const visibleBot = this.manager.scrollOffset + Math.ceil(height / this.rowScale);

    const points: TuningTracePoint[] = [];

    const collectTile = (tile: T) => {
      if (tile.rowCount === 0) return;
      const tileTopFromLive = this.manager.totalRows - tile.startRow - tile.rowCount;
      const tileBotFromLive = this.manager.totalRows - tile.startRow - 1;
      if (tileTopFromLive > visibleBot || tileBotFromLive < visibleTop) return;

      for (let i = 0; i < tile.rowCount; i++) {
        const tuning = tile.tuning[i];
        if (!tuning) continue;

        const rowFromLive = this.manager.totalRows - (tile.startRow + i);
        if (rowFromLive < visibleTop || rowFromLive > visibleBot) continue;

        const canvasY = (rowFromLive - this.manager.scrollOffset) * this.rowScale;
        const yCss = canvasY / dpr;

        const centerX = (tuning.freqKHz - this.viewStartKHz) / viewSpan;
        const loX = (tuning.freqKHz + tuning.passbandLo / 1000 - this.viewStartKHz) / viewSpan;
        const hiX = (tuning.freqKHz + tuning.passbandHi / 1000 - this.viewStartKHz) / viewSpan;

        points.push({ yCss, centerX, loX, hiX });
      }
    };

    for (const chunk of this.manager.chunks) {
      for (const tile of chunk.tiles as T[]) collectTile(tile);
    }
    for (const tile of this.liveTiles) collectTile(tile);

    points.sort((a, b) => a.yCss - b.yCss);
    return points;
  }
}
