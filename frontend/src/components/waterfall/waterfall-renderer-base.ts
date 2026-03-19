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
  rowScale: number;
  height: number;
  dpr: number;
  maxScrollOffset: number;
  isLive: boolean;
  playbackRow: number | null;
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
const EVICT_DISTANCE_ROWS = 4 * 480;

interface ChunkEntry<T extends BaseTile> {
  startedAt: number;
  sourceId: string;
  startRow: number;
  frameCount: number;
  complete: boolean;
  loaded: boolean;
  loading: boolean;
  tiles: T[];
  expectedWF: number;
  audioBytes: number;
  actualWF: number | null;
  failCount: number;
  nextRetryAt: number;
}

interface GapEntry {
  startRow: number;
  rowCount: number;
}

const GAP_CSS_PX = 60;

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

  protected liveTiles: T[] = [];
  protected liveTile!: T;
  protected totalRows = 0;
  protected chunks: ChunkEntry<T>[] = [];
  protected gaps: GapEntry[] = [];
  protected minLevel: number;
  protected maxLevel: number;
  protected viewStartKHz = 0;
  protected viewEndKHz = 30000;
  protected needsRepaint = false;

  protected scrollOffset = 0;
  private lowestStartRow = 0;
  private queue: Uint8Array[] = [];
  private rafId: number | null = null;

  private autoLevel = true;
  private smoothMin: number;
  private smoothMax: number;
  private samplesCount = 0;
  private readonly AUTO_ALPHA = 0.05;

  protected dataStartKHz = 0;
  protected dataEndKHz = 30000;
  private maxBandwidthKHz = 30000;

  private chunkSource: ChunkSource | null = null;
  private liveFrameCount = 0;
  private liveChunkStartRow = 0;
  private liveChunkStartedAt: number | null = null;
  private streamSampleRate = 12000;
  private streamChunkDurationS = 60;
  private markers = new Map<string, WaterfallMarker>();

  private currentTuning: TuningPoint | null = null;

  onOverlayUpdate: ((state: OverlayState, markers: WaterfallMarker[]) => void) | null = null;
  onTuningTrace: ((points: TuningTracePoint[]) => void) | null = null;
  onMarkerAdd: ((marker: WaterfallMarker) => void) | null = null;
  onMarkerRemove: ((id: string) => void) | null = null;

  private perfFlush = new PerfBucket("perf.wf.flush");
  private perfFetch = new PerfBucket("perf.wf.fetchChunk");

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.tileHeight = options.tileHeight ?? DEFAULT_TILE_HEIGHT;
    this.rowScale = options.rowScale ?? 1;
    this.minLevel = options.minLevel ?? -110;
    this.maxLevel = options.maxLevel ?? -10;
    this.smoothMin = this.minLevel;
    this.smoothMax = this.maxLevel;
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
    this.canvas.width = width;
    this.canvas.height = height;
    this.onResize(width, height);
    this.drawFrame();
  }

  destroy(): void {
    this.stopRenderLoop();
    this.queue.length = 0;
    for (const tile of this.liveTiles) this.destroyTile(tile);
    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) this.destroyTile(tile);
    }
    this.liveTiles.length = 0;
    this.chunks.length = 0;
    this.onDestroy();
  }

  get currentLevels(): { min: number; max: number } {
    return { min: this.minLevel, max: this.maxLevel };
  }

  get rowCount(): number {
    return this.totalRows;
  }

  get visibleRows(): number {
    const h = this.canvas.height;
    return h > 0 ? Math.ceil(h / this.rowScale) : 0;
  }

  cssToRows(px: number): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.round((px * dpr) / this.rowScale);
  }

  get chunkManifest(): ReadonlyArray<{
    startedAt: number;
    startRow: number;
    frameCount: number;
    complete: boolean;
    audioBytes: number;
  }> {
    const result: Array<{
      startedAt: number;
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

  requestRepaint(): void {
    this.needsRepaint = true;
  }

  // ---------------------------------------------------------------------------
  // Chunk-aware public API
  // ---------------------------------------------------------------------------

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
      (a, b) => a.started_at - b.started_at,
    );

    if (sorted.length === 0) return 0;

    const liveCount = this.liveFrameCount;

    const frameCounts: number[] = [];
    const hasGapBefore: boolean[] = [];
    let totalFrames = 0;

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      let count = c.wf_frames;
      if (i === sorted.length - 1 && !c.complete && liveCount > 0) {
        count = Math.max(0, count - liveCount);
      }
      frameCounts.push(count);
      totalFrames += count;

      if (i > 0) {
        const elapsed = c.started_at - sorted[i - 1].started_at;
        hasGapBefore.push(elapsed > this.streamChunkDurationS * 1.5);
      } else {
        hasGapBefore.push(false);
      }
    }

    if (totalFrames === 0) return 0;

    const dpr = window.devicePixelRatio || 1;
    const gapRowCount = Math.ceil(GAP_CSS_PX * dpr / this.rowScale);
    const numGaps = hasGapBefore.filter(Boolean).length;

    const endRowCount = gapRowCount;
    let currentRow = -(totalFrames + numGaps * gapRowCount + endRowCount);
    this.chunks = [];
    this.gaps = [];

    this.addMarker({
      id: "history-end",
      row: currentRow,
      label: "END",
      metadata: {
        type: "end",
        gapStartRow: currentRow,
        gapRowCount: endRowCount,
      },
    });
    currentRow += endRowCount;

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const count = frameCounts[i];

      if (hasGapBefore[i]) {
        this.gaps.push({ startRow: currentRow, rowCount: gapRowCount });
        this.addMarker({
          id: `gap-${i}`,
          row: currentRow,
          label: "NO DATA",
          metadata: {
            type: "gap",
            gapStartRow: currentRow,
            gapRowCount: gapRowCount,
          },
        });
        currentRow += gapRowCount;
      }

      const entry: ChunkEntry<T> = {
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
        failCount: 0,
        nextRetryAt: 0,
      };
      this.chunks.push(entry);

      const markerRow = currentRow + count;
      const expectedAudio =
        this.streamSampleRate * this.streamChunkDurationS * 2;
      this.addMarker({
        id: `chunk-${c.started_at}`,
        row: markerRow,
        label: String(c.started_at),
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
      this.lowestStartRow = -(totalFrames + numGaps * gapRowCount + endRowCount);
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
    started_at: number;
    ended_at?: number;
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
      const entry: ChunkEntry<T> = {
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
        failCount: 0,
        nextRetryAt: 0,
      };
      this.chunks.push(entry);
      this.fetchChunk(entry);
    }

    const expectedAudio =
      this.streamSampleRate * this.streamChunkDurationS * 2;
    this.addMarker({
      id: `chunk-${msg.started_at}`,
      row: endRow,
      label: String(msg.started_at),
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

  // ---------------------------------------------------------------------------
  // Markers
  // ---------------------------------------------------------------------------

  private addMarker(marker: WaterfallMarker): void {
    this.markers.set(marker.id, marker);
    this.onMarkerAdd?.(marker);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private removeMarker(id: string): void {
    this.markers.delete(id);
    this.onMarkerRemove?.(id);
  }

  private updateChunkMarker(entry: ChunkEntry<T>): void {
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

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

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
    this.drawFrame();
    this.needsRepaint = false;
    const state: OverlayState = {
      totalRows: this.totalRows,
      scrollOffset: this.scrollOffset,
      rowScale: this.rowScale,
      height: this.canvas.height,
      dpr: window.devicePixelRatio || 1,
      maxScrollOffset: this.maxScrollOffset,
      isLive: this.isLive,
      playbackRow: this.playbackRow,
    };
    this.onOverlayUpdate?.(state, [...this.markers.values()]);

    if (this.onTuningTrace) {
      this.onTuningTrace(this.computeTuningTrace());
    }

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
    tile.rawBins.push(new Uint8Array(bins));
    tile.tuning.push(this.currentTuning ? { ...this.currentTuning } : null);
    this.writeRow(tile, bins, tile.rowCount);
    tile.rowCount++;
    this.totalRows++;
    if (this.scrollOffset > 0) {
      this.scrollOffset++;
    }
  }

  private pruneLiveTiles(): void {
    const { height } = this.canvas;
    if (height === 0) return;

    this.liveTiles = this.liveTiles.filter((tile) => {
      if (tile === this.liveTile) return true;
      const displayTopY =
        (this.totalRows - tile.startRow - tile.rowCount - this.scrollOffset) *
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

  private checkViewport(): void {
    if (this.chunks.length === 0 || !this.chunkSource) return;

    const visibleRows = Math.ceil(
      this.canvas.height / (this.rowScale * (window.devicePixelRatio || 1)),
    );
    const topFromLive = this.scrollOffset;
    const bottomFromLive = this.scrollOffset + visibleRows;

    for (let ci = 0; ci < this.chunks.length; ci++) {
      const slot = this.chunks[ci];
      const slotTopFromLive =
        this.totalRows - slot.startRow - slot.frameCount;
      const slotBottomFromLive = this.totalRows - slot.startRow - 1;

      const inView =
        slotBottomFromLive >= topFromLive &&
        slotTopFromLive <= bottomFromLive;

      const nearView = this.isNearViewport(ci, topFromLive, bottomFromLive);

      if ((inView || nearView) && !slot.loaded && !slot.loading && slot.frameCount > 0) {
        if (slot.failCount === 0 || performance.now() >= slot.nextRetryAt) {
          this.fetchChunk(slot);
        }
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

  private async fetchChunk(entry: ChunkEntry<T>): Promise<void> {
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
    } finally {
      entry.loading = false;
    }
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

  private insertFramesAsChunkTiles(
    entry: ChunkEntry<T>,
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
        for (const tile of entry.tiles) this.destroyTile(tile);
        entry.tiles = [];
        entry.loaded = false;
      }
    }
  }

  private computeTuningTrace(): TuningTracePoint[] {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return [];
    const dpr = window.devicePixelRatio || 1;
    const cssHeight = height / dpr;
    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (viewSpan <= 0) return [];

    const visibleTop = this.scrollOffset;
    const visibleBot = this.scrollOffset + Math.ceil(height / this.rowScale);

    const points: TuningTracePoint[] = [];

    const collectTile = (tile: T) => {
      if (tile.rowCount === 0) return;
      const tileTopFromLive = this.totalRows - tile.startRow - tile.rowCount;
      const tileBotFromLive = this.totalRows - tile.startRow - 1;
      if (tileTopFromLive > visibleBot || tileBotFromLive < visibleTop) return;

      for (let i = 0; i < tile.rowCount; i++) {
        const tuning = tile.tuning[i];
        if (!tuning) continue;

        const rowFromLive = this.totalRows - (tile.startRow + i);
        if (rowFromLive < visibleTop || rowFromLive > visibleBot) continue;

        const canvasY = (rowFromLive - this.scrollOffset) * this.rowScale;
        const yCss = canvasY / dpr;

        const centerX = (tuning.freqKHz - this.viewStartKHz) / viewSpan;
        const loX = (tuning.freqKHz + tuning.passbandLo / 1000 - this.viewStartKHz) / viewSpan;
        const hiX = (tuning.freqKHz + tuning.passbandHi / 1000 - this.viewStartKHz) / viewSpan;

        points.push({ yCss, centerX, loX, hiX });
      }
    };

    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) collectTile(tile);
    }
    for (const tile of this.liveTiles) collectTile(tile);

    points.sort((a, b) => a.yCss - b.yCss);
    return points;
  }
}
