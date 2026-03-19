import type { ChunkSource } from "./chunk-loader";
import type { ChunkInfo } from "./historical-audio-player";
import { decodeAndResampleWav } from "./resample";

// ---------------------------------------------------------------------------
// AudioWorklet processor code (runs on the audio render thread)
// ---------------------------------------------------------------------------
// Varispeed scrub engine: holds a decoded audio buffer, receives target
// position updates from the main thread, and smoothly chases the target
// with rate-clamped interpolation to produce the classic "tape scrub" sound.
// ---------------------------------------------------------------------------

const SCRUB_PROCESSOR_CODE = `
class ScrubProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = null;
    this.bufLen = 0;
    this.pos = 0.0;
    this.targetPos = 0.0;
    this.mode = 0; // 0 = idle, 1 = scrub, 2 = play-through
    this.env = 0.0;
    this.sinceUpdate = 0;

    // Tuning constants (48 kHz assumed)
    this.alpha = 0.006;
    this.maxSpeed = 2.0;
    this.deadzone = 0.05;
    this.jumpThreshold = 48000;
    this.idleTimeout = 14400;  // ~300 ms
    this.fadeRate = 1.0 / 480; // ~10 ms fade
    this.jumpFadeRate = 1.0 / 120; // ~2.5 ms fast fade

    this.port.onmessage = (ev) => {
      const d = ev.data;
      switch (d.type) {
        case 'buffer':
          this.buf = d.samples;
          this.bufLen = d.samples.length;
          break;
        case 'scrub':
          if (this.mode !== 1) this.pos = d.pos;
          this.targetPos = d.pos;
          this.sinceUpdate = 0;
          this.mode = 1;
          break;
        case 'play':
          this.mode = 2;
          break;
        case 'stop':
          this.mode = 0;
          break;
      }
    };
  }

  process(_, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    const buf = this.buf;
    const len = this.bufLen;
    const alpha = this.alpha;
    const maxSpd = this.maxSpeed;
    const dz = this.deadzone;
    const jt = this.jumpThreshold;
    const fr = this.fadeRate;
    const jfr = this.jumpFadeRate;

    for (let i = 0; i < out.length; i++) {
      // ── Position advance ──
      if (this.mode === 1) {
        var diff = this.targetPos - this.pos;
        var absDiff = diff < 0 ? -diff : diff;

        if (absDiff > jt) {
          // Large jump: fast-fade out then snap
          this.env = this.env - jfr;
          if (this.env < 0) this.env = 0;
          if (this.env < 0.001) this.pos = this.targetPos;
        } else if (absDiff > 0.5) {
          var speed = diff * alpha;
          var absSpd = speed < 0 ? -speed : speed;
          if (absSpd > maxSpd) speed = speed > 0 ? maxSpd : -maxSpd;
          else if (absSpd < dz) speed = diff > 0 ? dz : -dz;
          this.pos += speed;
        }
        this.sinceUpdate++;
      } else if (this.mode === 2) {
        this.pos += 1.0;
        if (buf && this.pos >= len - 1) {
          this.mode = 0;
          this.port.postMessage({ type: 'ended' });
        }
      }

      // ── Envelope ──
      var audible = this.mode === 1
        ? this.sinceUpdate < this.idleTimeout
        : this.mode === 2;

      if (audible) {
        this.env += fr;
        if (this.env > 1) this.env = 1;
      } else {
        this.env -= fr;
        if (this.env < 0) this.env = 0;
      }

      // ── Sample read with cubic Hermite interpolation ──
      var s = 0;
      if (this.env > 0.001 && buf && len > 0) {
        var p = this.pos;
        var idx = p | 0; // floor
        if (p < 0) { idx = 0; p = 0; }
        if (idx >= 0 && idx < len) {
          var frac = p - idx;
          var s0 = idx > 0 ? buf[idx - 1] : buf[0];
          var s1 = buf[idx];
          var s2 = idx + 1 < len ? buf[idx + 1] : s1;
          var s3 = idx + 2 < len ? buf[idx + 2] : s2;
          var c1 = 0.5 * (s2 - s0);
          var c2 = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
          var c3 = 0.5 * (s3 - s0) + 1.5 * (s1 - s2);
          s = ((c3 * frac + c2) * frac + c1) * frac + s1;
        }
      }

      out[i] = s * this.env;
    }

    return true;
  }
}
registerProcessor('scrub-processor', ScrubProcessor);
`;

// ---------------------------------------------------------------------------
// Main-thread controller
// ---------------------------------------------------------------------------

interface DecodedChunk {
  samples: Float32Array;
  info: ChunkInfo;
}

const MAX_CACHE_SIZE = 5;
const SETTLE_MS = 200;

export class ScrubController {
  private audioCtx: AudioContext;
  private outputNode: GainNode;
  private chunkSource: ChunkSource;
  private node: AudioWorkletNode;

  private decoded = new Map<number, DecodedChunk>();
  private fetchPromises = new Map<number, Promise<void>>();

  private windowStartRow = 0;
  private windowEndRow = 0;
  private windowSamplesPerRow = 0;

  private chunks: ReadonlyArray<ChunkInfo> = [];

  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTargetRow = 0;
  private scrubGeneration = 0;

  onSettled: ((targetRow: number) => void) | null = null;

  /** Register the worklet module once per AudioContext. */
  static async registerProcessor(ctx: AudioContext): Promise<void> {
    const blob = new Blob([SCRUB_PROCESSOR_CODE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  }

  constructor(ctx: AudioContext, output: GainNode, source: ChunkSource) {
    this.audioCtx = ctx;
    this.outputNode = output;
    this.chunkSource = source;

    this.node = new AudioWorkletNode(ctx, "scrub-processor");
    this.node.connect(output);
  }

  setChunks(chunks: ReadonlyArray<ChunkInfo>): void {
    this.chunks = chunks;
  }

  /**
   * Feed a new scrub target. Loads the required chunk buffer on first call
   * (async, non-blocking). Position updates are sent to the worklet as
   * soon as the buffer covers the target row.
   *
   * @param settle  If true (default), a settle timer restarts on each call.
   *                Pass false during thumb-drag (caller will call settle()
   *                explicitly via onDragEnd).
   */
  scrub(targetRow: number, settle = true): void {
    this.lastTargetRow = targetRow;
    this.scrubGeneration++;

    const chunkIdx = this.resolveChunk(targetRow);
    if (chunkIdx < 0) return;

    if (this.coversRow(targetRow)) {
      this.sendPosition(targetRow);
    } else {
      const gen = this.scrubGeneration;
      void this.loadAndSendPosition(chunkIdx, gen);
    }

    if (settle) this.resetSettleTimer();
    this.prefetchAdjacent(chunkIdx);
  }

  /** Immediately settle (e.g. on drag-end). */
  settle(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.doSettle();
  }

  /** Silence the worklet without triggering onSettled. */
  stop(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.node.port.postMessage({ type: "stop" });
  }

  destroy(): void {
    this.stop();
    this.node.disconnect();
    this.decoded.clear();
    this.fetchPromises.clear();
    this.onSettled = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private coversRow(row: number): boolean {
    return (
      row >= this.windowStartRow &&
      row < this.windowEndRow &&
      this.windowSamplesPerRow > 0
    );
  }

  private sendPosition(targetRow: number): void {
    const samplePos =
      (targetRow - this.windowStartRow) * this.windowSamplesPerRow;
    const maxPos =
      (this.windowEndRow - this.windowStartRow) * this.windowSamplesPerRow - 1;
    this.node.port.postMessage({
      type: "scrub",
      pos: Math.max(0, Math.min(samplePos, maxPos)),
    });
  }

  private async loadAndSendPosition(
    chunkIdx: number,
    generation: number,
  ): Promise<void> {
    await this.loadBufferAround(chunkIdx);
    if (generation !== this.scrubGeneration) return;
    const row = this.lastTargetRow;
    if (this.coversRow(row)) {
      this.sendPosition(row);
    }
  }

  private resetSettleTimer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.doSettle();
    }, SETTLE_MS);
  }

  private doSettle(): void {
    this.node.port.postMessage({ type: "stop" });
    this.onSettled?.(this.lastTargetRow);
  }

  // ── Buffer management ────────────────────────────────────────────────────

  private async loadBufferAround(centerIdx: number): Promise<void> {
    const chunk = this.chunks[centerIdx];
    if (!chunk || chunk.audioBytes === 0) return;
    await this.fetchAndDecode(chunk);
    this.buildWindow(centerIdx);
  }

  private buildWindow(centerIdx: number): void {
    const startIdx = Math.max(0, centerIdx - 1);
    const endIdx = Math.min(this.chunks.length - 1, centerIdx + 1);

    const parts: DecodedChunk[] = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const c = this.chunks[i];
      if (c.audioBytes === 0 || c.frameCount === 0) continue;
      const dec = this.decoded.get(c.startedAt);
      if (dec) parts.push(dec);
    }

    if (parts.length === 0) return;

    let totalLen = 0;
    for (const p of parts) totalLen += p.samples.length;

    const stitched = new Float32Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      stitched.set(p.samples, offset);
      offset += p.samples.length;
    }

    this.windowStartRow = parts[0].info.startRow;
    const last = parts[parts.length - 1];
    this.windowEndRow = last.info.startRow + last.info.frameCount;
    const totalRows = this.windowEndRow - this.windowStartRow;
    this.windowSamplesPerRow = totalRows > 0 ? totalLen / totalRows : 0;

    this.node.port.postMessage({ type: "buffer", samples: stitched });
  }

  private async fetchAndDecode(chunkInfo: ChunkInfo): Promise<void> {
    if (this.decoded.has(chunkInfo.startedAt)) return;
    if (chunkInfo.audioBytes === 0) return;

    const existing = this.fetchPromises.get(chunkInfo.startedAt);
    if (existing) return existing;

    const promise = this.doFetchAndDecode(chunkInfo);
    this.fetchPromises.set(chunkInfo.startedAt, promise);
    try {
      await promise;
    } finally {
      this.fetchPromises.delete(chunkInfo.startedAt);
    }
  }

  private async doFetchAndDecode(chunkInfo: ChunkInfo): Promise<void> {
    try {
      const raw = await this.chunkSource.fetchAudio(chunkInfo.startedAt);
      const ab = decodeAndResampleWav(raw, this.audioCtx);
      const samples = new Float32Array(ab.getChannelData(0));
      this.decoded.set(chunkInfo.startedAt, { samples, info: chunkInfo });

      if (this.decoded.size > MAX_CACHE_SIZE) {
        const oldest = this.decoded.keys().next().value;
        if (oldest) this.decoded.delete(oldest);
      }
    } catch (err) {
      console.warn("[scrub] fetch/decode failed:", chunkInfo.startedAt, err);
    }
  }

  private prefetchAdjacent(chunkIdx: number): void {
    for (const off of [-1, 1]) {
      const idx = chunkIdx + off;
      if (idx < 0 || idx >= this.chunks.length) continue;
      const c = this.chunks[idx];
      if (
        c.audioBytes > 0 &&
        !this.decoded.has(c.startedAt) &&
        !this.fetchPromises.has(c.startedAt)
      ) {
        void this.fetchAndDecode(c);
      }
    }
  }

  private resolveChunk(targetRow: number): number {
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (
        c.audioBytes !== 0 &&
        c.frameCount > 0 &&
        targetRow >= c.startRow &&
        targetRow < c.startRow + c.frameCount
      ) {
        return i;
      }
    }
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c.audioBytes === 0) continue;
      const end = c.startRow + Math.max(c.frameCount, 1);
      const mid = c.startRow + (end - c.startRow) / 2;
      const dist = Math.abs(targetRow - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}
