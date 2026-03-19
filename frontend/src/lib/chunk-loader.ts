/**
 * Chunk loader: fetches rewind metadata and chunk data from the backend.
 * Provides a ChunkSource interface for future extensibility (S3Source for monitoring).
 */

import { getToken } from "./auth";

export interface ChunkMeta {
  index: number;
  started_at: string;
  ended_at: string | null;
  complete: boolean;
  audio_bytes: number;
  wf_frames: number;
  events: number;
  wf_zoom: number;
  wf_zoom_changed: boolean;
  source_id: string;
}

export interface RewindResponse {
  stream_id: string;
  sample_rate: number;
  chunk_duration_s: number;
  chunks: ChunkMeta[];
}

export interface ChunkSource {
  fetchRewind(): Promise<RewindResponse>;
  fetchWF(startedAt: string): Promise<ArrayBuffer>;
  fetchAudio(startedAt: string): Promise<ArrayBuffer>;
  fetchEvents(startedAt: string): Promise<string>;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetches chunk data from the in-memory ring buffer via the rewind HTTP endpoints.
 */
export class RingBufferSource implements ChunkSource {
  constructor(private streamId: string) {}

  async fetchRewind(): Promise<RewindResponse> {
    const res = await fetch(
      `/api/streams/${this.streamId}/rewind`,
      { headers: authHeaders() }
    );
    if (!res.ok) throw new Error(`rewind metadata: ${res.status}`);
    return res.json();
  }

  async fetchWF(startedAt: string): Promise<ArrayBuffer> {
    const url = `/api/streams/${this.streamId}/rewind/${encodeURIComponent(startedAt)}/wf`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`chunk wf ${startedAt}: ${res.status}`);
    return res.arrayBuffer();
  }

  async fetchAudio(startedAt: string): Promise<ArrayBuffer> {
    const url = `/api/streams/${this.streamId}/rewind/${encodeURIComponent(startedAt)}/audio`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`chunk audio ${startedAt}: ${res.status}`);
    return res.arrayBuffer();
  }

  async fetchEvents(startedAt: string): Promise<string> {
    const url = `/api/streams/${this.streamId}/rewind/${encodeURIComponent(startedAt)}/events`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`chunk events ${startedAt}: ${res.status}`);
    return res.text();
  }
}
