/**
 * Chunk loader: fetches rewind metadata and chunk data from the backend.
 * The backend transparently proxies S3 chunks when they're not in the ring
 * buffer, so the frontend uses a single RemoteChunkSource for everything.
 */

import { getToken } from "./auth";

export interface ChunkMeta {
  index: number;
  started_at: number;
  ended_at: number | null;
  complete: boolean;
  audio_bytes: number;
  wf_frames: number;
  events: number;
  wf_zoom: number;
  wf_zoom_changed: boolean;
  source_id: string;
  stream_state: number;
  health_flags: number;
  in_band_snr_db?: number | null;
  has_activity?: boolean | null;
}

export interface S3History {
  count: number;
  oldest: number;
  newest: number;
}

export interface ManifestResponse {
  stream_id: string;
  sample_rate: number;
  chunk_duration_s: number;
  chunks: ChunkMeta[];
  s3_history?: S3History | null;
}

export interface ChunkSource {
  fetchManifest(from: number, to: number): Promise<ManifestResponse>;
  fetchWF(startedAt: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  fetchAudio(startedAt: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  fetchEvents(startedAt: number, signal?: AbortSignal): Promise<string>;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch a rewind chunk endpoint. The backend either returns the data directly
 * (from the ring buffer) or returns JSON `{ "url": "..." }` with a presigned
 * S3 URL. In the latter case we fetch the data from S3 directly — this avoids
 * cross-origin redirect issues with the Authorization header.
 */
async function fetchChunkData(
  endpoint: string,
  mode: "binary" | "text",
  signal?: AbortSignal,
): Promise<ArrayBuffer | string> {
  const res = await fetch(endpoint, {
    headers: authHeaders(),
    redirect: "manual",
    signal,
  });

  if (res.type === "opaqueredirect") {
    throw new Error(`unexpected redirect from ${endpoint}`);
  }
  if (!res.ok) throw new Error(`${endpoint}: ${res.status}`);

  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) {
    const body: { url: string } = await res.json();
    const s3Res = await fetch(body.url, { signal });
    if (!s3Res.ok) throw new Error(`s3 fetch ${s3Res.status}`);
    return mode === "text" ? s3Res.text() : s3Res.arrayBuffer();
  }

  return mode === "text" ? res.text() : res.arrayBuffer();
}

export class RemoteChunkSource implements ChunkSource {
  private inflight = new Map<string, Promise<ArrayBuffer | string>>();

  constructor(private streamId: string) {}

  async fetchManifest(from: number, to: number): Promise<ManifestResponse> {
    const res = await fetch(
      `/api/streams/${this.streamId}/manifest/${from}/${to}`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(`manifest ${from}/${to}: ${res.status}`);
    return res.json();
  }

  fetchWF(startedAt: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.dedup(
      `wf:${startedAt}`,
      `/api/streams/${this.streamId}/rewind/${startedAt}/wf`,
      "binary",
      signal,
    ) as Promise<ArrayBuffer>;
  }

  fetchAudio(startedAt: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.dedup(
      `audio:${startedAt}`,
      `/api/streams/${this.streamId}/rewind/${startedAt}/audio`,
      "binary",
      signal,
    ) as Promise<ArrayBuffer>;
  }

  fetchEvents(startedAt: number, signal?: AbortSignal): Promise<string> {
    return this.dedup(
      `events:${startedAt}`,
      `/api/streams/${this.streamId}/rewind/${startedAt}/events`,
      "text",
      signal,
    ) as Promise<string>;
  }

  private dedup(
    key: string,
    endpoint: string,
    mode: "binary" | "text",
    signal?: AbortSignal,
  ): Promise<ArrayBuffer | string> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = fetchChunkData(endpoint, mode, signal).finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }
}
