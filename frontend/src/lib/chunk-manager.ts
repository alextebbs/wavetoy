import type { ChunkSource, ChunkMeta } from "./chunk-loader";
import { streamLog } from "./stream-logger";

export interface WaterfallMarker {
  id: string;
  row: number;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkEntry<T = any> {
  startedAt: number;
  sourceId: string;
  startRow: number;
  frameCount: number;
  complete: boolean;
  expectedWF: number;
  audioBytes: number;
  tiles: T[];
  loaded: boolean;
  loading: boolean;
  actualWF: number | null;
  failCount: number;
  nextRetryAt: number;
  abortController: AbortController | null;
  inBandSNRdB: number | null;
  hasActivity: boolean | null;
}

export interface GapEntry {
  startRow: number;
  rowCount: number;
}

const GAP_CSS_PX = 60;

function formatGapLabel(gapSeconds: number): string {
  if (gapSeconds < 120) return `NO DATA FOR ${Math.round(gapSeconds)}s`;
  if (gapSeconds < 7200) return `NO DATA FOR ${Math.round(gapSeconds / 60)}m`;
  if (gapSeconds < 172800) return `NO DATA FOR ${(gapSeconds / 3600).toFixed(1)}h`;
  return `NO DATA FOR ${(gapSeconds / 86400).toFixed(1)}d`;
}

export class ChunkManager<T = any> {
  chunks: ChunkEntry<T>[] = [];
  gaps: GapEntry[] = [];
  markers = new Map<string, WaterfallMarker>();
  totalRows = 0;
  scrollOffset = 0;
  lowestStartRow = 0;
  visibleRows = 0;

  liveChunkStartRow = 0;
  liveChunkStartedAt: number | null = null;
  liveFrameCount = 0;
  streamSampleRate = 12000;
  streamChunkDurationS = 60;

  playbackRow: number | null = null;

  /** Frames received but not yet rendered (queued in the renderer). */
  pendingRows = 0;

  source: ChunkSource | null = null;
  loadedWindow: { from: number; to: number } | null = null;

  private readonly rowScale: number;
  private extending = false;
  private edgeRequestCooldown = 0;

  onMarkerAdd: ((m: WaterfallMarker) => void) | null = null;
  onMarkerRemove: ((id: string) => void) | null = null;
  onChange: (() => void) | null = null;
  onTilesEvicted: ((entries: ChunkEntry<T>[]) => void) | null = null;
  /** Called when a "before" extension shifts the coordinate system. */
  onCoordinateShift: ((shift: number) => void) | null = null;

  constructor(rowScale: number) {
    this.rowScale = rowScale;
  }

  // ---------------------------------------------------------------------------
  // Coordinate getters
  // ---------------------------------------------------------------------------

  get maxScrollOffset(): number {
    const base = this.totalRows - this.lowestStartRow;
    if (base <= 0) return 0;

    const endMarker = this.markers.get("history-end");
    if (endMarker?.metadata) {
      const gapStart = endMarker.metadata.gapStartRow as number;
      const gapCount = endMarker.metadata.gapRowCount as number;
      const endTopFromLive = this.totalRows - gapStart - gapCount;
      const headLookahead = Math.ceil(this.visibleRows * 0.1);
      return Math.max(0, endTopFromLive - headLookahead);
    }

    return base;
  }

  get isLive(): boolean {
    return this.scrollOffset === 0;
  }

  // ---------------------------------------------------------------------------
  // Scroll
  // ---------------------------------------------------------------------------

  setScrollOffset(offset: number): void {
    const clamped = Math.max(0, Math.min(offset, this.maxScrollOffset));
    if (Math.abs(clamped - this.scrollOffset) < 0.01) return;
    this.scrollOffset = clamped;
    this.onChange?.();
  }

  scrollToLive(): void {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = 0;
    this.onChange?.();
  }

  // ---------------------------------------------------------------------------
  // Live data
  // ---------------------------------------------------------------------------

  advanceLive(): void {
    this.totalRows++;
    if (this.scrollOffset > 0) {
      this.scrollOffset++;
    }
  }

  resetLiveFrameCount(): void {
    this.liveFrameCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Chunk manifest view
  // ---------------------------------------------------------------------------

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

  getChunk(startedAt: number): ChunkEntry<T> | undefined {
    return this.chunks.find((c) => c.startedAt === startedAt);
  }

  // ---------------------------------------------------------------------------
  // Markers
  // ---------------------------------------------------------------------------

  addMarker(marker: WaterfallMarker): void {
    this.markers.set(marker.id, marker);
    this.onMarkerAdd?.(marker);
  }

  removeMarker(id: string): void {
    this.markers.delete(id);
    this.onMarkerRemove?.(id);
  }

  // ---------------------------------------------------------------------------
  // Manifest operations
  // ---------------------------------------------------------------------------

  loadManifest(
    chunkMetas: ChunkMeta[],
    streamInfo?: { sampleRate: number; chunkDurationS: number },
  ): number {
    streamLog.warn(
      "wf.loadManifest",
      `incoming=${chunkMetas.length} existingChunks=${this.chunks.length}`,
    );
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
    const gapSecsBefore: number[] = [];
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
        gapSecsBefore.push(elapsed > this.streamChunkDurationS * 1.5 ? elapsed : 0);
      } else {
        gapSecsBefore.push(0);
      }
    }

    if (totalFrames === 0) return 0;

    const dpr = window.devicePixelRatio || 1;
    const gapRowCount = Math.ceil(GAP_CSS_PX * dpr / this.rowScale);
    const numGaps = gapSecsBefore.filter((g) => g > 0).length;

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

      if (gapSecsBefore[i] > 0) {
        this.gaps.push({ startRow: currentRow, rowCount: gapRowCount });
        this.addMarker({
          id: `gap-${i}`,
          row: currentRow,
          label: formatGapLabel(gapSecsBefore[i]),
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
        tiles: [] as unknown as T[],
        expectedWF: c.wf_frames,
        audioBytes: c.audio_bytes,
        actualWF: null,
        failCount: 0,
        nextRetryAt: 0,
        abortController: null,
        inBandSNRdB: c.in_band_snr_db ?? null,
        hasActivity: c.has_activity ?? null,
      };
      this.chunks.push(entry);

      const expectedAudio =
        this.streamSampleRate * this.streamChunkDurationS * 2;
      this.addMarker({
        id: `chunk-${c.started_at}`,
        row: currentRow + count,
        label: String(c.started_at),
        metadata: {
          started_at: c.started_at,
          source_id: c.source_id,
          complete: c.complete,
          wf_frames: c.wf_frames,
          audio_bytes: c.audio_bytes,
          audio_expected: expectedAudio,
          in_band_snr_db: c.in_band_snr_db ?? null,
          has_activity: c.has_activity ?? null,
        },
      });

      currentRow += count;
    }

    if (this.chunks.length > 0) {
      this.lowestStartRow = -(totalFrames + numGaps * gapRowCount + endRowCount);
    }

    const last = this.chunks[this.chunks.length - 1];
    if (last && !last.complete) {
      this.liveChunkStartedAt = last.startedAt;
    }

    this.onChange?.();
    return totalFrames;
  }

  /**
   * Extend the loaded manifest window with additional chunks.
   * Returns { added, shift } where shift is the row shift applied for "before" direction.
   * The renderer must shift its live tile startRow values by `shift`.
   */
  extendManifest(
    chunkMetas: ChunkMeta[],
    direction: "before" | "after",
  ): { added: number; shift: number } {
    streamLog.warn(
      "wf.extendManifest",
      `dir=${direction} incoming=${chunkMetas.length} existingChunks=${this.chunks.length}`,
    );
    if (chunkMetas.length === 0) return { added: 0, shift: 0 };

    const sorted = [...chunkMetas].sort(
      (a, b) => a.started_at - b.started_at,
    );

    const existingTimes = new Set(this.chunks.map((c) => c.startedAt));
    const newMetas = sorted.filter((m) => !existingTimes.has(m.started_at));
    if (newMetas.length === 0) return { added: 0, shift: 0 };

    const dpr = window.devicePixelRatio || 1;
    const gapRowCount = Math.ceil(GAP_CSS_PX * dpr / this.rowScale);

    let totalNewFrames = 0;
    const newEntries: ChunkEntry<T>[] = [];
    const newGaps: GapEntry[] = [];
    const newMarkers: WaterfallMarker[] = [];

    for (let i = 0; i < newMetas.length; i++) {
      totalNewFrames += newMetas[i].wf_frames;
    }

    if (totalNewFrames === 0) return { added: 0, shift: 0 };

    let totalRowShift = 0;

    if (direction === "before") {
      const gapSecsBefore: number[] = [0];
      for (let i = 1; i < newMetas.length; i++) {
        const elapsed = newMetas[i].started_at - newMetas[i - 1].started_at;
        gapSecsBefore.push(elapsed > this.streamChunkDurationS * 1.5 ? elapsed : 0);
      }

      let bridgeGapSecs = 0;
      if (this.chunks.length > 0 && newMetas.length > 0) {
        const lastNew = newMetas[newMetas.length - 1];
        const firstExisting = this.chunks[0];
        const elapsed = firstExisting.startedAt - lastNew.started_at;
        bridgeGapSecs = elapsed > this.streamChunkDurationS * 1.5 ? elapsed : 0;
      }

      const numGaps = gapSecsBefore.filter((g) => g > 0).length + (bridgeGapSecs > 0 ? 1 : 0);
      totalRowShift = totalNewFrames + numGaps * gapRowCount;

      // Shift all existing chunks, gaps, markers, and totalRows
      for (const entry of this.chunks) {
        entry.startRow += totalRowShift;
      }
      for (const gap of this.gaps) {
        gap.startRow += totalRowShift;
      }
      for (const marker of this.markers.values()) {
        marker.row += totalRowShift;
      }
      this.liveChunkStartRow += totalRowShift;
      this.totalRows += totalRowShift;

      if (this.scrollOffset > 0) {
        this.scrollOffset += totalRowShift;
      }

      this.onCoordinateShift?.(totalRowShift);

      let currentRow = this.lowestStartRow;

      this.markers.delete("history-end");
      const endRowCount = gapRowCount;
      currentRow -= endRowCount;
      this.lowestStartRow = currentRow;

      newMarkers.push({
        id: "history-end",
        row: currentRow,
        label: "END",
        metadata: { type: "end", gapStartRow: currentRow, gapRowCount: endRowCount },
      });
      currentRow += endRowCount;

      for (let i = 0; i < newMetas.length; i++) {
        const c = newMetas[i];

        if (gapSecsBefore[i] > 0) {
          newGaps.push({ startRow: currentRow, rowCount: gapRowCount });
          newMarkers.push({
            id: `gap-ext-before-${c.started_at}`,
            row: currentRow,
            label: formatGapLabel(gapSecsBefore[i]),
            metadata: { type: "gap", gapStartRow: currentRow, gapRowCount },
          });
          currentRow += gapRowCount;
        }

        const entry: ChunkEntry<T> = {
          startedAt: c.started_at,
          sourceId: c.source_id,
          startRow: currentRow,
          frameCount: c.wf_frames,
          complete: c.complete,
          loaded: false,
          loading: false,
          tiles: [] as unknown as T[],
          expectedWF: c.wf_frames,
          audioBytes: c.audio_bytes,
          actualWF: null,
          failCount: 0,
          nextRetryAt: 0,
          abortController: null,
          inBandSNRdB: c.in_band_snr_db ?? null,
          hasActivity: c.has_activity ?? null,
        };
        newEntries.push(entry);

        const expectedAudio =
          this.streamSampleRate * this.streamChunkDurationS * 2;
        newMarkers.push({
          id: `chunk-${c.started_at}`,
          row: currentRow + c.wf_frames,
          label: String(c.started_at),
          metadata: {
            started_at: c.started_at,
            source_id: c.source_id,
            complete: c.complete,
            wf_frames: c.wf_frames,
            audio_bytes: c.audio_bytes,
            audio_expected: expectedAudio,
            in_band_snr_db: c.in_band_snr_db ?? null,
            has_activity: c.has_activity ?? null,
          },
        });
        currentRow += c.wf_frames;
      }

      if (bridgeGapSecs > 0) {
        newGaps.push({ startRow: currentRow, rowCount: gapRowCount });
        newMarkers.push({
          id: `gap-ext-bridge-${newMetas[newMetas.length - 1].started_at}`,
          row: currentRow,
          label: formatGapLabel(bridgeGapSecs),
          metadata: { type: "gap", gapStartRow: currentRow, gapRowCount },
        });
      }

      this.chunks = [...newEntries, ...this.chunks];
      this.gaps = [...newGaps, ...this.gaps];
      for (const m of newMarkers) {
        this.markers.set(m.id, m);
        this.onMarkerAdd?.(m);
      }
    } else {
      const gapSecsAfter: number[] = [];
      for (let i = 0; i < newMetas.length; i++) {
        if (i === 0 && this.chunks.length > 0) {
          const lastExisting = this.chunks[this.chunks.length - 1];
          const elapsed = newMetas[0].started_at - lastExisting.startedAt;
          gapSecsAfter.push(elapsed > this.streamChunkDurationS * 1.5 ? elapsed : 0);
        } else if (i > 0) {
          const elapsed = newMetas[i].started_at - newMetas[i - 1].started_at;
          gapSecsAfter.push(elapsed > this.streamChunkDurationS * 1.5 ? elapsed : 0);
        } else {
          gapSecsAfter.push(0);
        }
      }

      let currentRow: number;
      if (this.chunks.length > 0) {
        const last = this.chunks[this.chunks.length - 1];
        currentRow = last.startRow + last.frameCount;
      } else {
        currentRow = 0;
      }

      for (let i = 0; i < newMetas.length; i++) {
        const c = newMetas[i];

        if (gapSecsAfter[i] > 0) {
          newGaps.push({ startRow: currentRow, rowCount: gapRowCount });
          newMarkers.push({
            id: `gap-ext-after-${c.started_at}`,
            row: currentRow,
            label: formatGapLabel(gapSecsAfter[i]),
            metadata: { type: "gap", gapStartRow: currentRow, gapRowCount },
          });
          currentRow += gapRowCount;
        }

        const entry: ChunkEntry<T> = {
          startedAt: c.started_at,
          sourceId: c.source_id,
          startRow: currentRow,
          frameCount: c.wf_frames,
          complete: c.complete,
          loaded: false,
          loading: false,
          tiles: [] as unknown as T[],
          expectedWF: c.wf_frames,
          audioBytes: c.audio_bytes,
          actualWF: null,
          failCount: 0,
          nextRetryAt: 0,
          abortController: null,
          inBandSNRdB: c.in_band_snr_db ?? null,
          hasActivity: c.has_activity ?? null,
        };
        newEntries.push(entry);

        const expectedAudio =
          this.streamSampleRate * this.streamChunkDurationS * 2;
        newMarkers.push({
          id: `chunk-${c.started_at}`,
          row: currentRow + c.wf_frames,
          label: String(c.started_at),
          metadata: {
            started_at: c.started_at,
            source_id: c.source_id,
            complete: c.complete,
            wf_frames: c.wf_frames,
            audio_bytes: c.audio_bytes,
            audio_expected: expectedAudio,
            in_band_snr_db: c.in_band_snr_db ?? null,
            has_activity: c.has_activity ?? null,
          },
        });
        currentRow += c.wf_frames;
      }

      this.chunks.push(...newEntries);
      this.gaps.push(...newGaps);
      for (const m of newMarkers) {
        this.markers.set(m.id, m);
        this.onMarkerAdd?.(m);
      }
    }

    this.onChange?.();
    return { added: newEntries.length, shift: totalRowShift };
  }

  evictManifestWindow(keepFrom: number, keepTo: number): void {
    const toEvict: number[] = [];
    const evictedEntries: ChunkEntry<T>[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c.startedAt < keepFrom || c.startedAt >= keepTo) {
        evictedEntries.push(c);
        toEvict.push(i);
      }
    }

    streamLog.warn(
      "wf.evictWindow",
      `keepFrom=${keepFrom} keepTo=${keepTo} evicting=${toEvict.length}/${this.chunks.length}`,
    );

    if (toEvict.length === 0) return;

    if (evictedEntries.length > 0) {
      this.onTilesEvicted?.(evictedEntries);
    }

    for (let i = toEvict.length - 1; i >= 0; i--) {
      this.chunks.splice(toEvict[i], 1);
    }

    if (this.chunks.length > 0) {
      this.lowestStartRow = this.chunks[0].startRow;
      const endMarker = this.markers.get("history-end");
      if (endMarker) {
        const dpr = window.devicePixelRatio || 1;
        const gapRowCount = Math.ceil(GAP_CSS_PX * dpr / this.rowScale);
        endMarker.row = this.lowestStartRow - gapRowCount;
        this.lowestStartRow = endMarker.row;
      }
    }

    this.onChange?.();
  }

  /**
   * Handle a chunk_complete message from the server.
   * Returns the ChunkEntry that needs tile data fetched/refetched, or null.
   */
  onChunkComplete(msg: {
    started_at: number;
    ended_at?: number;
    source_id?: string;
    wf_frames?: number;
    audio_bytes?: number;
    in_band_snr_db?: number | null;
    has_activity?: boolean | null;
  }): ChunkEntry<T> | null {
    const existing = this.chunks.find((s) => s.startedAt === msg.started_at);
    if (existing) {
      existing.complete = true;
      if (msg.wf_frames != null) existing.expectedWF = msg.wf_frames;
      if (msg.audio_bytes != null) existing.audioBytes = msg.audio_bytes;
      existing.inBandSNRdB = msg.in_band_snr_db ?? null;
      existing.hasActivity = msg.has_activity ?? null;

      if (msg.wf_frames != null && msg.wf_frames > existing.frameCount) {
        existing.frameCount = msg.wf_frames;
      }

      this.updateChunkMarker(existing);

      this.liveChunkStartRow = existing.startRow + existing.frameCount;
      this.liveChunkStartedAt = msg.ended_at ?? null;

      if (!existing.loading) {
        existing.loaded = false;
        return existing;
      }
      return null;
    }

    const endRow = this.totalRows + this.pendingRows;
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
        tiles: [] as unknown as T[],
        expectedWF,
        audioBytes,
        actualWF: null,
        failCount: 0,
        nextRetryAt: 0,
        abortController: null,
        inBandSNRdB: msg.in_band_snr_db ?? null,
        hasActivity: msg.has_activity ?? null,
      };
      this.chunks.push(entry);

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
          in_band_snr_db: msg.in_band_snr_db ?? null,
          has_activity: msg.has_activity ?? null,
        },
      });

      this.liveChunkStartRow = endRow;
      this.liveChunkStartedAt = msg.ended_at ?? null;
      return entry;
    }

    this.liveChunkStartRow = endRow;
    this.liveChunkStartedAt = msg.ended_at ?? null;
    return null;
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
  // Edge detection & manifest window management
  // ---------------------------------------------------------------------------

  checkEdges(topFromLive: number, bottomFromLive: number): void {
    if (this.chunks.length === 0) return;

    const now = performance.now();
    if (now <= this.edgeRequestCooldown) return;

    const edgeThreshold = this.visibleRows * 2;

    const oldest = this.chunks[0];
    const oldestTopFromLive = this.totalRows - oldest.startRow - oldest.frameCount;
    if (bottomFromLive >= oldestTopFromLive - edgeThreshold) {
      this.edgeRequestCooldown = now + 3000;
      this.requestExtend("before");
    }

    const newest = this.chunks[this.chunks.length - 1];
    const newestBotFromLive = this.totalRows - newest.startRow - 1;
    if (topFromLive <= newestBotFromLive + edgeThreshold && newestBotFromLive > 0) {
      this.edgeRequestCooldown = now + 3000;
      this.requestExtend("after");
    }
  }

  requestExtend(direction: "before" | "after"): void {
    if (this.extending || !this.source || !this.loadedWindow) return;
    this.extending = true;

    const win = this.loadedWindow;
    const extendHours = 1;
    let fetchFrom: number, fetchTo: number;
    if (direction === "before") {
      fetchTo = win.from;
      fetchFrom = fetchTo - extendHours * 3600;
    } else {
      fetchFrom = win.to;
      fetchTo = fetchFrom + extendHours * 3600;
    }

    this.source.fetchManifest(fetchFrom, fetchTo).then((manifest) => {
      const chunks = manifest.chunks ?? [];
      if (chunks.length === 0) return;
      const { added } = this.extendManifest(chunks, direction);
      if (added === 0) return;
      if (direction === "before") {
        this.loadedWindow = { from: fetchFrom, to: win.to };
      } else {
        this.loadedWindow = { from: win.from, to: fetchTo };
      }

      const currentWin = this.loadedWindow;
      if (currentWin.to - currentWin.from > 6 * 3600) {
        const keepFrom = currentWin.to - 6 * 3600;
        const keepTo = currentWin.to;
        this.evictManifestWindow(keepFrom, keepTo);
        this.loadedWindow = { from: keepFrom, to: keepTo };
      }
    }).catch((err) => {
      console.error("[wf] extend manifest error:", err);
    }).finally(() => {
      this.extending = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.chunks = [];
    this.gaps = [];
    this.markers.clear();
    this.source = null;
    this.loadedWindow = null;
  }
}
