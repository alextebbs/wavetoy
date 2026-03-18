/**
 * ChunkTileManager: manages on-demand loading and eviction of historical
 * waterfall chunk data. Maintains a manifest of all known chunks with their
 * row ranges. On each viewport update, determines which chunks are visible,
 * loads unloaded ones, and evicts distant ones to manage memory.
 *
 * Chunks are addressed by started_at timestamp, not integer index.
 */

import type { WaterfallHandle } from "@/components/waterfall/types";
import type { OverlayState } from "@/components/waterfall/waterfall-renderer";
import { parseWFChunk, type WFChunkFrame } from "./chunk-parser";
import type { ChunkMeta, ChunkSource } from "./chunk-loader";

const TILE_HEIGHT = 256;
const MAX_ZOOM = 14;
const NUM_BINS = 1024;

const EVICT_DISTANCE_CHUNKS = 4;

export interface ChunkSlot {
  startedAt: string;
  sourceId: string;
  startRow: number;
  frameCount: number;
  complete: boolean;
  loaded: boolean;
  loading: boolean;
}

function coverageFromFrame(
  xBin: number,
  zoom: number,
  maxBandwidthKHz: number
): { startKHz: number; endKHz: number } {
  const totalBins = NUM_BINS * (1 << MAX_ZOOM);
  const binScale = 1 << (MAX_ZOOM - zoom);
  const startKHz = (xBin / totalBins) * maxBandwidthKHz;
  const endKHz =
    ((xBin + NUM_BINS * binScale) / totalBins) * maxBandwidthKHz;
  return { startKHz, endKHz };
}

export class ChunkTileManager {
  private manifest: ChunkSlot[] = [];
  private source: ChunkSource;
  private wf: WaterfallHandle;
  private maxBandwidthKHz: number;
  private liveWFCountRef: { current: number };
  /** Row at which the current in-progress live chunk started. */
  private liveChunkStartRow = 0;

  constructor(
    source: ChunkSource,
    waterfallHandle: WaterfallHandle,
    maxBandwidthKHz: number,
    liveWFCountRef: { current: number },
  ) {
    this.source = source;
    this.wf = waterfallHandle;
    this.maxBandwidthKHz = maxBandwidthKHz;
    this.liveWFCountRef = liveWFCountRef;
  }

  /**
   * Build the manifest from rewind metadata. Computes row ranges for all
   * chunks, sets history extent on the renderer, and registers chunk
   * boundary markers. Immediately loads chunks near the viewport.
   */
  async buildManifest(chunks: ChunkMeta[]): Promise<number> {
    const withFrames = chunks
      .filter((c) => c.wf_frames > 0)
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

    if (withFrames.length === 0) {
      console.log("[tile-mgr] no chunks with WF frames");
      return 0;
    }

    // Compute total historical frame count, trimming the in-progress chunk
    const liveCount = this.liveWFCountRef.current;
    console.log("[tile-mgr] buildManifest: chunks=%d, liveCount=%d", withFrames.length, liveCount);
    let totalFrames = 0;
    for (let i = 0; i < withFrames.length; i++) {
      const c = withFrames[i];
      let count = c.wf_frames;
      if (i === withFrames.length - 1 && !c.complete && liveCount > 0) {
        count = Math.max(0, count - liveCount);
      }
      totalFrames += count;
    }

    if (totalFrames === 0) {
      console.log("[tile-mgr] totalFrames is 0 after trimming");
      return 0;
    }
    console.log("[tile-mgr] totalFrames:", totalFrames);

    // Assign row ranges (negative, oldest first, ending at 0)
    let currentRow = -totalFrames;
    this.manifest = [];

    for (let i = 0; i < withFrames.length; i++) {
      const c = withFrames[i];
      let count = c.wf_frames;
      if (i === withFrames.length - 1 && !c.complete && liveCount > 0) {
        count = Math.max(0, count - liveCount);
      }
      if (count === 0) continue;

      this.manifest.push({
        startedAt: c.started_at,
        sourceId: c.source_id,
        startRow: currentRow,
        frameCount: count,
        complete: c.complete,
        loaded: false,
        loading: false,
      });

      // Register chunk boundary marker at the top (newest edge)
      const markerRow = currentRow + count;
      this.wf.addMarker({
        id: `chunk-${c.started_at}`,
        row: markerRow,
        label: c.started_at,
        metadata: {
          started_at: c.started_at,
          source_id: c.source_id,
          complete: c.complete,
        },
      });

      currentRow += count;
    }

    // Inform the renderer of the full historical extent
    if (this.manifest.length > 0) {
      this.wf.setHistoryExtent(this.manifest[0].startRow);
    }

    // Immediately load the chunks nearest the viewport (the most recent ones)
    await this.loadInitialChunks();

    return totalFrames;
  }

  /**
   * Called on each renderer overlay update. Checks which chunks intersect
   * the viewport and triggers loading/eviction.
   */
  checkViewport(state: OverlayState): void {
    if (this.manifest.length === 0) return;

    const rendererTotalRows = state.totalRows;
    const visibleRows = Math.ceil(state.height / (state.rowScale * state.dpr));
    // "rowsFromLive" range that is visible
    const topRowsFromLive = state.scrollOffset;
    const bottomRowsFromLive = state.scrollOffset + visibleRows;

    // Convert to absolute row space: a chunk at startRow S has
    // rowsFromLive = rendererTotalRows - S - frameCount (for its top)
    // and rendererTotalRows - S - 1 (for its bottom/newest).
    for (let ci = 0; ci < this.manifest.length; ci++) {
      const slot = this.manifest[ci];
      const slotTopFromLive = rendererTotalRows - slot.startRow - slot.frameCount;
      const slotBottomFromLive = rendererTotalRows - slot.startRow - 1;

      const inView =
        slotBottomFromLive >= topRowsFromLive &&
        slotTopFromLive <= bottomRowsFromLive;

      // Buffer: also consider 1 chunk on each side
      const nearView = this.isNearViewport(ci, topRowsFromLive, bottomRowsFromLive, rendererTotalRows);

      if ((inView || nearView) && !slot.loaded && !slot.loading) {
        this.fetchChunk(slot);
      }
    }

    this.evictDistant(state);
  }

  /**
   * Handle a chunk_complete WebSocket event. Computes the row range from
   * tracked live data, adds the chunk to the manifest, places a boundary
   * marker, and fetches the chunk data so it persists for scrollback.
   */
  onChunkComplete(msg: {
    started_at: string;
    ended_at?: string;
    source_id?: string;
  }): void {
    // If this chunk is already in the manifest (from buildManifest),
    // just mark it complete and fetch if not loaded.
    const existing = this.manifest.find((s) => s.startedAt === msg.started_at);
    if (existing) {
      existing.complete = true;
      if (!existing.loaded && !existing.loading) {
        this.fetchChunk(existing);
      }
      return;
    }

    // New chunk that completed during the live session.
    // Its data was rendered as live tiles from liveChunkStartRow to now.
    const endRow = this.wf.rowCount();
    const frameCount = endRow - this.liveChunkStartRow;
    console.log("[tile-mgr] chunk_complete: %s, startRow=%d, frameCount=%d", msg.started_at, this.liveChunkStartRow, frameCount);

    if (frameCount > 0) {
      const slot: ChunkSlot = {
        startedAt: msg.started_at,
        sourceId: msg.source_id ?? "",
        startRow: this.liveChunkStartRow,
        frameCount,
        complete: true,
        loaded: false,
        loading: false,
      };
      this.manifest.push(slot);

      // Fetch the chunk data so it persists as historical tiles
      // (live tiles will eventually be pruned on scroll)
      this.fetchChunk(slot);
    }

    // Place boundary marker at the top (newest edge) of the chunk
    this.wf.addMarker({
      id: `chunk-${msg.started_at}`,
      row: endRow,
      label: msg.started_at,
      metadata: {
        started_at: msg.started_at,
        ended_at: msg.ended_at,
        source_id: msg.source_id,
        complete: true,
      },
    });

    // Next live chunk starts at the current row count
    this.liveChunkStartRow = endRow;
  }

  getManifest(): readonly ChunkSlot[] {
    return this.manifest;
  }

  // --- Private ---

  private isNearViewport(
    chunkIdx: number,
    topFromLive: number,
    bottomFromLive: number,
    totalRows: number,
  ): boolean {
    // Check the chunks immediately adjacent
    for (const offset of [-1, 1]) {
      const ni = chunkIdx + offset;
      if (ni < 0 || ni >= this.manifest.length) continue;
      const neighbor = this.manifest[ni];
      const nTop = totalRows - neighbor.startRow - neighbor.frameCount;
      const nBot = totalRows - neighbor.startRow - 1;
      if (nBot >= topFromLive && nTop <= bottomFromLive) {
        return true; // our neighbor is visible, so we're "near"
      }
    }
    return false;
  }

  private async loadInitialChunks(): Promise<void> {
    // Load the most recent chunks (those closest to live) first.
    // Typically just the last 2-3 are visible on screen.
    const toLoad = this.manifest.slice(-3).filter((s) => !s.loaded && !s.loading);
    await Promise.all(toLoad.map((s) => this.fetchChunk(s)));
  }

  private async fetchChunk(slot: ChunkSlot): Promise<void> {
    slot.loading = true;
    console.log("[tile-mgr] fetchChunk:", slot.startedAt, "startRow:", slot.startRow);
    try {
      const buffer = await this.source.fetchWF(slot.startedAt);
      let frames = parseWFChunk(buffer);
      console.log("[tile-mgr] fetched %d frames for %s", frames.length, slot.startedAt);

      // For the in-progress chunk, trim frames that overlap with live data
      const isNewest =
        this.manifest.length > 0 &&
        this.manifest[this.manifest.length - 1] === slot;
      if (isNewest && !slot.complete) {
        const liveCount = this.liveWFCountRef.current;
        if (liveCount > 0) {
          const trimmed = frames.length - liveCount;
          frames = trimmed > 0 ? frames.slice(0, trimmed) : [];
        }
      }

      // Actual frame count may differ from metadata's wf_frames
      // (e.g. after trimming). Use it as-is for tile insertion.
      if (frames.length > 0) {
        this.insertFramesAsTiles(slot.startRow, frames);
      }

      slot.loaded = true;
    } catch (err) {
      console.error(`Failed to load chunk ${slot.startedAt}:`, err);
    } finally {
      slot.loading = false;
    }
  }

  private insertFramesAsTiles(
    startRow: number,
    frames: WFChunkFrame[],
  ): void {
    let i = 0;
    let row = startRow;

    while (i < frames.length) {
      const anchor = frames[i];
      let j = i + 1;
      while (
        j < frames.length &&
        j - i < TILE_HEIGHT &&
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

      const rawBins = frames.slice(i, j).map((f) => f.bins);
      this.wf.insertHistoricalTile(row, rawBins, startKHz, endKHz);
      row += j - i;
      i = j;
    }
  }

  private evictDistant(state: OverlayState): void {
    const rendererTotalRows = state.totalRows;
    const visibleRows = Math.ceil(state.height / (state.rowScale * state.dpr));
    const topFromLive = state.scrollOffset;
    const bottomFromLive = state.scrollOffset + visibleRows;

    for (const slot of this.manifest) {
      if (!slot.loaded) continue;

      const slotTopFromLive = rendererTotalRows - slot.startRow - slot.frameCount;
      const slotBottomFromLive = rendererTotalRows - slot.startRow - 1;

      // Distance from viewport in "rows from live" space
      const dist = Math.max(
        0,
        Math.max(slotTopFromLive - bottomFromLive, topFromLive - slotBottomFromLive),
      );

      // Evict if farther than EVICT_DISTANCE_CHUNKS worth of rows
      // (~480 rows at 8fps * 60s per chunk)
      if (dist > EVICT_DISTANCE_CHUNKS * 480) {
        this.wf.removeTilesInRange(slot.startRow, slot.startRow + slot.frameCount);
        slot.loaded = false;
      }
    }
  }
}
