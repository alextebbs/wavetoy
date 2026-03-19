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
  fetchWF(startedAt: number): Promise<ArrayBuffer>;
  fetchAudio(startedAt: number): Promise<ArrayBuffer>;
  fetchEvents(startedAt: number): Promise<string>;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetches chunk data via the rewind HTTP endpoints.
 * The backend handles ring vs S3 lookup transparently.
 */
export class RemoteChunkSource implements ChunkSource {
  constructor(private streamId: string) {}

  async fetchManifest(from: number, to: number): Promise<ManifestResponse> {
    const res = await fetch(
      `/api/streams/${this.streamId}/manifest/${from}/${to}`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(`manifest ${from}/${to}: ${res.status}`);
    return res.json();
  }

  async fetchWF(startedAt: number): Promise<ArrayBuffer> {
    const url = `/api/streams/${this.streamId}/rewind/${startedAt}/wf`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`chunk wf ${startedAt}: ${res.status}`);
    return res.arrayBuffer();
  }

  async fetchAudio(startedAt: number): Promise<ArrayBuffer> {
    const url = `/api/streams/${this.streamId}/rewind/${startedAt}/audio`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`chunk audio ${startedAt}: ${res.status}`);
    return res.arrayBuffer();
  }

  async fetchEvents(startedAt: number): Promise<string> {
    const url = `/api/streams/${this.streamId}/rewind/${startedAt}/events`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`chunk events ${startedAt}: ${res.status}`);
    return res.text();
  }
}
