/**
 * Waterfall pre-fill: loads historical WF frames from the ChunkRing
 * rewind endpoint and inserts them into the virtualized waterfall renderer.
 *
 * Called once after the WebSocket connects. Historical tiles are inserted
 * with negative startRow values so they appear below (older than) live data.
 *
 * To avoid overlap with live frames already pushed via WebSocket, the caller
 * passes a ref that tracks the count of live WF frames received since connect.
 * We trim that many frames from the end of the current (in-progress) chunk,
 * since those frames are already in the live waterfall.
 */

import type { WaterfallHandle } from "@/components/waterfall/types";
import { parseWFChunk, type WFChunkFrame } from "./chunk-parser";
import { RingBufferSource, type ChunkMeta } from "./chunk-loader";

const TILE_HEIGHT = 256;
const MAX_ZOOM = 14;
const NUM_BINS = 1024;

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

export interface PrefillOptions {
  streamId: string;
  waterfallHandle: WaterfallHandle;
  maxBandwidthKHz: number;
  signal?: AbortSignal;
  /** Ref tracking the number of live WF frames pushed since WS connect. */
  liveWFCountRef?: { current: number };
}

/**
 * Fetch available chunks (including the in-progress one) and inject their
 * WF data into the waterfall renderer as historical tiles. Trims overlapping
 * frames from the current chunk using the live frame count.
 *
 * Returns the number of historical rows inserted.
 */
export async function prefillWaterfall(
  opts: PrefillOptions
): Promise<number> {
  const { streamId, waterfallHandle, maxBandwidthKHz, signal, liveWFCountRef } = opts;
  const source = new RingBufferSource(streamId);

  let rewind;
  try {
    rewind = await source.fetchRewind();
  } catch {
    return 0;
  }

  if (signal?.aborted) return 0;

  const chunks = rewind.chunks.filter(
    (c: ChunkMeta) => c.wf_frames > 0
  );

  if (chunks.length === 0) return 0;

  // Sort oldest first (current in-progress chunk has the highest index)
  chunks.sort((a, b) => a.index - b.index);

  // Fetch WF data for all chunks in parallel (including the in-progress one)
  const fetches = chunks.map(async (chunk: ChunkMeta) => {
    try {
      const buffer = await source.fetchWF(chunk.started_at);
      return { chunk, frames: parseWFChunk(buffer) };
    } catch {
      return { chunk, frames: [] as WFChunkFrame[] };
    }
  });

  const results = await Promise.all(fetches);
  if (signal?.aborted) return 0;

  // Trim the current (in-progress) chunk: its newest frames overlap with
  // live data already pushed via WebSocket. Read the counter NOW (after all
  // fetches complete) so it reflects the full overlap window.
  const liveCount = liveWFCountRef?.current ?? 0;
  const lastResult = results[results.length - 1];
  if (lastResult && !lastResult.chunk.complete && liveCount > 0) {
    const trimmed = lastResult.frames.length - liveCount;
    if (trimmed <= 0) {
      lastResult.frames = [];
    } else {
      lastResult.frames = lastResult.frames.slice(0, trimmed);
    }
  }

  // Calculate total historical rows
  let totalHistoricalRows = 0;
  for (const r of results) {
    totalHistoricalRows += r.frames.length;
  }

  if (totalHistoricalRows === 0) return 0;

  // Insert tiles: assign startRow values starting from -totalHistoricalRows
  let currentRow = -totalHistoricalRows;

  for (const { chunk, frames } of results) {
    if (frames.length === 0) continue;

    // Split frames into tiles, breaking on coverage changes AND at
    // TILE_HEIGHT so each tile only contains frames with identical
    // xBin/zoom (i.e. identical spatial coverage).
    let i = 0;
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
        maxBandwidthKHz
      );

      const rawBins = frames.slice(i, j).map((f) => f.bins);
      waterfallHandle.insertHistoricalTile(currentRow, rawBins, startKHz, endKHz);
      currentRow += j - i;
      i = j;
    }

    // Place the chunk border at the TOP (newest edge) of the chunk.
    // For the in-progress chunk this lands at row 0 (the historical/live
    // boundary) and later gets replaced by chunk_complete at the actual
    // minute-locked position.
    waterfallHandle.addMarker({
      id: `chunk-${chunk.started_at}`,
      row: currentRow,
      label: chunk.started_at,
      metadata: {
        started_at: chunk.started_at,
        source_id: chunk.source_id,
        complete: chunk.complete,
      },
    });
  }

  return totalHistoricalRows;
}
