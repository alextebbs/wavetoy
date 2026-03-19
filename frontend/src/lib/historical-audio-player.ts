import type { ChunkSource } from "./chunk-loader";

export interface ChunkInfo {
  startedAt: string;
  startRow: number;
  frameCount: number;
  complete: boolean;
  audioBytes: number;
}

export class HistoricalAudioPlayer {
  playing = false;
  tailing = false;

  onRowChange: ((row: number) => void) | null = null;
  onReachLive: (() => void) | null = null;
  onTailing: (() => void) | null = null;

  private audioCtx: AudioContext;
  private histGain: GainNode;
  private chunkSource: ChunkSource;

  private chunks: ReadonlyArray<ChunkInfo> = [];
  private currentChunkIdx = -1;
  private currentSource: AudioBufferSourceNode | null = null;
  private currentBuffer: AudioBuffer | null = null;
  private nextSource: AudioBufferSourceNode | null = null;
  private nextBuffer: AudioBuffer | null = null;

  private sourceStartedAt = 0;
  private startOffset = 0;
  private chunkEndTime = 0;
  private rafId = 0;
  private nextScheduled = false;
  private prefetchAbort: AbortController | null = null;

  private liveStash: Float32Array[] = [];
  private liveStashLen = 0;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private tailRetries = 0;
  private static readonly MAX_TAIL_RETRIES = 15;
  private static readonly TAIL_RETRY_MS = 200;

  constructor(
    audioCtx: AudioContext,
    histGain: GainNode,
    chunkSource: ChunkSource,
  ) {
    this.audioCtx = audioCtx;
    this.histGain = histGain;
    this.chunkSource = chunkSource;
  }

  async startPlayback(params: {
    chunks: ReadonlyArray<ChunkInfo>;
    targetRow: number;
  }): Promise<void> {
    this.stopPlayback();
    this.chunks = params.chunks;

    const chunkIdx = this.resolveChunk(params.targetRow);
    if (chunkIdx < 0) return;

    const chunk = this.chunks[chunkIdx];
    const progress =
      chunk.frameCount > 0
        ? Math.max(
            0,
            Math.min(
              1,
              (params.targetRow - chunk.startRow) / chunk.frameCount,
            ),
          )
        : 0;

    const buffer = await this.fetchAndDecode(chunk.startedAt);
    if (!buffer) return;

    this.currentChunkIdx = chunkIdx;
    this.currentBuffer = buffer;
    this.startOffset = progress * buffer.duration;
    this.playing = true;

    this.playCurrentSource();
    this.prefetchNext();
    this.startPositionTracking();
  }

  async seek(targetRow: number): Promise<void> {
    if (!this.playing) return;

    this.cancelPrefetch();
    this.stopSources();

    const chunkIdx = this.resolveChunk(targetRow);
    if (chunkIdx < 0) {
      this.stopPlayback();
      return;
    }

    const chunk = this.chunks[chunkIdx];
    const progress =
      chunk.frameCount > 0
        ? Math.max(
            0,
            Math.min(1, (targetRow - chunk.startRow) / chunk.frameCount),
          )
        : 0;

    const buffer = await this.fetchAndDecode(chunk.startedAt);
    if (!buffer || !this.playing) return;

    this.currentChunkIdx = chunkIdx;
    this.currentBuffer = buffer;
    this.startOffset = progress * buffer.duration;

    this.playCurrentSource();
    this.prefetchNext();
    this.startPositionTracking();
  }

  pushLiveSamples(samples: Float32Array): void {
    if (!this.playing) return;
    this.liveStash.push(new Float32Array(samples));
    this.liveStashLen += samples.length;
  }

  stopPlayback(): void {
    this.playing = false;
    this.tailing = false;
    this.cancelPrefetch();
    this.stopSources();
    this.clearTailTimer();
    this.liveStash.length = 0;
    this.liveStashLen = 0;
    this.tailRetries = 0;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  scrubPause(): void {
    this.cancelPrefetch();
    this.stopSources();
    this.clearTailTimer();
    this.tailing = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  destroy(): void {
    this.stopPlayback();
    this.onRowChange = null;
    this.onReachLive = null;
    this.onTailing = null;
  }

  // --- internals ---

  private playCurrentSource(): void {
    if (!this.currentBuffer) return;

    const source = this.audioCtx.createBufferSource();
    source.buffer = this.currentBuffer;
    source.connect(this.histGain);

    const now = this.audioCtx.currentTime;
    source.start(now, this.startOffset);
    this.sourceStartedAt = now;
    this.chunkEndTime = now + (this.currentBuffer.duration - this.startOffset);

    source.onended = () => this.handleSourceEnded();
    this.currentSource = source;
  }

  private handleSourceEnded(): void {
    if (!this.playing) return;

    const nextIdx = this.nextPlayableChunk(this.currentChunkIdx + 1);
    if (this.nextScheduled && this.nextBuffer && nextIdx >= 0) {
      this.currentChunkIdx = nextIdx;
      this.currentSource = this.nextSource;
      this.currentBuffer = this.nextBuffer;
      this.sourceStartedAt = this.chunkEndTime;
      this.startOffset = 0;
      this.chunkEndTime =
        this.sourceStartedAt + this.currentBuffer.duration;
      this.nextSource = null;
      this.nextBuffer = null;
      this.nextScheduled = false;
      this.prefetchNext();
    } else {
      this.advanceToNextChunk();
    }
  }

  private nextPlayableChunk(fromIdx: number): number {
    for (let i = fromIdx; i < this.chunks.length; i++) {
      if (this.chunks[i].audioBytes !== 0) return i;
    }
    return -1;
  }

  private async advanceToNextChunk(): Promise<void> {
    const nextIdx = this.nextPlayableChunk(this.currentChunkIdx + 1);
    if (nextIdx < 0) {
      this.enterTailing();
      return;
    }

    let buffer = this.nextBuffer;
    if (!buffer) {
      buffer = await this.fetchAndDecode(this.chunks[nextIdx].startedAt);
    }
    if (!buffer || !this.playing) {
      this.onReachLive?.();
      this.stopPlayback();
      return;
    }

    this.currentChunkIdx = nextIdx;
    this.currentBuffer = buffer;
    this.nextBuffer = null;
    this.nextSource = null;
    this.nextScheduled = false;
    this.startOffset = 0;

    this.playCurrentSource();
    this.prefetchNext();
  }

  private async prefetchNext(): Promise<void> {
    const nextIdx = this.nextPlayableChunk(this.currentChunkIdx + 1);
    if (nextIdx < 0) return;

    this.cancelPrefetch();
    const abort = new AbortController();
    this.prefetchAbort = abort;

    const chunk = this.chunks[nextIdx];
    const buffer = await this.fetchAndDecode(chunk.startedAt);
    if (!buffer || !this.playing || abort.signal.aborted) return;

    this.nextBuffer = buffer;

    const now = this.audioCtx.currentTime;
    if (this.chunkEndTime > now + 0.02) {
      const nextSrc = this.audioCtx.createBufferSource();
      nextSrc.buffer = buffer;
      nextSrc.connect(this.histGain);
      nextSrc.start(this.chunkEndTime);
      nextSrc.onended = () => {};
      this.nextSource = nextSrc;
      this.nextScheduled = true;
    }
  }

  private enterTailing(): void {
    if (!this.playing) return;

    if (this.liveStashLen > 0) {
      this.tailing = true;
      this.tailRetries = 0;
      this.onTailing?.();
      this.drainStash();
      return;
    }

    this.tailRetries++;
    if (this.tailRetries > HistoricalAudioPlayer.MAX_TAIL_RETRIES) {
      this.onReachLive?.();
      this.stopPlayback();
      return;
    }
    this.tailTimer = setTimeout(
      () => this.enterTailing(),
      HistoricalAudioPlayer.TAIL_RETRY_MS,
    );
  }

  private drainStash(): void {
    if (!this.playing || !this.tailing) return;

    if (this.liveStashLen === 0) {
      this.tailTimer = setTimeout(
        () => this.drainStash(),
        HistoricalAudioPlayer.TAIL_RETRY_MS,
      );
      return;
    }

    const combined = new Float32Array(this.liveStashLen);
    let offset = 0;
    for (const chunk of this.liveStash) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.liveStash.length = 0;
    this.liveStashLen = 0;

    const sampleRate = this.audioCtx.sampleRate;
    const audioBuffer = this.audioCtx.createBuffer(
      1,
      combined.length,
      sampleRate,
    );
    audioBuffer.getChannelData(0).set(combined);

    const now = this.audioCtx.currentTime;
    const startAt = this.chunkEndTime > now ? this.chunkEndTime : now;

    this.stopSources();

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.histGain);
    source.start(startAt);

    this.currentSource = source;
    this.currentBuffer = audioBuffer;
    this.sourceStartedAt = startAt;
    this.startOffset = 0;
    this.chunkEndTime = startAt + audioBuffer.duration;

    source.onended = () => {
      if (!this.playing || !this.tailing) return;
      this.drainStash();
    };
  }

  private clearTailTimer(): void {
    if (this.tailTimer !== null) {
      clearTimeout(this.tailTimer);
      this.tailTimer = null;
    }
  }

  private startPositionTracking(): void {
    const tick = () => {
      if (!this.playing) return;
      if (this.tailing) return;

      const chunk = this.chunks[this.currentChunkIdx];
      if (!chunk || !this.currentBuffer) return;

      const elapsed = this.audioCtx.currentTime - this.sourceStartedAt;
      const duration = this.currentBuffer.duration;
      const progress =
        duration > 0
          ? Math.min(1, (this.startOffset + elapsed) / duration)
          : 0;

      let currentRow: number;
      if (chunk.frameCount > 0) {
        currentRow = chunk.startRow + progress * chunk.frameCount;
      } else {
        const nextChunk = this.chunks[this.currentChunkIdx + 1];
        const endRow = nextChunk ? nextChunk.startRow : chunk.startRow;
        currentRow = chunk.startRow + progress * (endRow - chunk.startRow);
      }

      this.onRowChange?.(Math.round(currentRow));
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
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

  private async fetchAndDecode(
    startedAt: string,
  ): Promise<AudioBuffer | null> {
    try {
      const raw = await this.chunkSource.fetchAudio(startedAt);
      return await this.audioCtx.decodeAudioData(raw);
    } catch (err) {
      console.warn("[hist-audio] fetch/decode failed:", startedAt, err);
      return null;
    }
  }

  private stopSources(): void {
    for (const src of [this.currentSource, this.nextSource]) {
      if (src) {
        try {
          src.onended = null;
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
      }
    }
    this.currentSource = null;
    this.nextSource = null;
    this.currentBuffer = null;
    this.nextBuffer = null;
    this.nextScheduled = false;
  }

  private cancelPrefetch(): void {
    if (this.prefetchAbort) {
      this.prefetchAbort.abort();
      this.prefetchAbort = null;
    }
  }
}
