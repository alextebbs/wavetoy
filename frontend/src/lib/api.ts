export type LowPassConfig = {
  enabled: boolean;
  cutoff_hz: number;
};

export type HighPassConfig = {
  enabled: boolean;
  cutoff_hz: number;
};

export type NoiseGateConfig = {
  enabled: boolean;
  threshold_db: number;
  hold_ms: number;
  attack_ms: number;
  release_ms: number;
};

export type SoftClipperConfig = {
  enabled: boolean;
  drive_db: number;
  ceiling_db: number;
};

export type NotchConfig = {
  enabled: boolean;
  center_hz: number;
  q: number;
};

export type NoiseReducerConfig = {
  enabled: boolean;
  strength: number;
  floor_db: number;
};

export type NoiseBlankerConfig = {
  enabled: boolean;
  threshold: number;
};

export type AutonotchConfig = {
  enabled: boolean;
  strength: number;
};

export type RingModulatorConfig = {
  enabled: boolean;
  carrier_hz: number;
  mix: number;
};

export type EchoConfig = {
  enabled: boolean;
  delay_ms: number;
  feedback: number;
  mix: number;
};

export type ReverbConfig = {
  enabled: boolean;
  room_size: number;
  damping: number;
  mix: number;
};

export type FilterConfig = {
  bypassed?: boolean;
  noise_blanker?: NoiseBlankerConfig;
  low_pass?: LowPassConfig;
  high_pass?: HighPassConfig;
  notch?: NotchConfig;
  autonotch?: AutonotchConfig;
  noise_gate?: NoiseGateConfig;
  soft_clipper?: SoftClipperConfig;
  noise_reducer?: NoiseReducerConfig;
  ring_modulator?: RingModulatorConfig;
  echo?: EchoConfig;
  reverb?: ReverbConfig;
};

export type InterpreterConfig = {
  type?: string;
  enabled?: boolean;
  sidetone_hz?: number;
  wpm?: number;
};

export type InterpreterOutput = {
  interpreter: string;
  text?: string;
  wpm?: number;
  sidetone_hz?: number;
  clear?: boolean;
  progress?: number;
};

export type Stream = {
  id: string;
  tenant_id: string;
  source_id: string;
  frequency_khz: number;
  bandwidth_low_hz: number;
  bandwidth_high_hz: number;
  mode: string;
  name: string;
  agc_on: boolean;
  agc_gain_db?: number;
  buffer_minutes: number;
  state: string;
  version: number;
  filters?: FilterConfig;
  interpreter?: InterpreterConfig;
  wf_view_start_khz: number;
  wf_view_end_khz: number;
  auto_probe: boolean;
  quality_fallback: boolean;
  offload_chunks: boolean;
  keep_alive: boolean;
  locked: boolean;
  view_locked: boolean;
  log_level: string;
  created_at: string;
  updated_at: string;
};

export type ProbeMetrics = {
  audio_rms_db: number;
  rms_similarity: number;
  silence_agreement: number;
  spectral_similarity: number;
  noise_floor_similarity: number;
  frame_rate: number;
  latency_ms: number;
};

export type FallbackSuggestion = {
  stream_id: string;
  source_id: string;
  source_name: string;
  source_host: string;
  source_port: number;
  rank: number;
  score: number;
  distance_km: number;
  bearing_deg: number;
  last_probed: string;
  probe_metrics: ProbeMetrics;
};

export type FallbacksResponse = {
  stream_id: string;
  auto_probe: boolean;
  suggestions: FallbackSuggestion[];
};

export type Peer = {
  session_id: string;
  color: string;
};

export const PEER_COLORS = [
  "#4f87e2",
  "#e24f87",
  "#4fe287",
  "#e2c94f",
  "#874fe2",
  "#e2874f",
  "#4fe2c9",
  "#c94fe2",
];

export function getSessionId(): string {
  let id = sessionStorage.getItem("sdr_session_id");
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    sessionStorage.setItem("sdr_session_id", id);
  }
  return id;
}

export function getSessionColor(): string {
  let color = sessionStorage.getItem("sdr_session_color");
  if (!color) {
    color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
    sessionStorage.setItem("sdr_session_color", color);
  }
  return color;
}

export type Source = {
  id: string;
  type: string;
  name: string;
  host: string;
  port: number;
  use_tls: boolean;
  latitude?: number;
  longitude?: number;
  available: boolean;
  users: number;
  max_listeners: number;
  snr_dbm?: number;
  antenna?: string;
  location?: string;
  grid?: string;
  status?: string;
  ant_connected: boolean;
  offline: boolean;
  last_health_check_at?: string;
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
};

export type MapSourceCounts = {
  total: number;
  included: number;
  omitted: number;
};

export type MapSourcesResponse = {
  included_sources: Source[];
  counts: MapSourceCounts;
};

import { getToken, clearToken, setToken } from "./auth";

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleUnauthorized(res: Response): void {
  if (res.status === 401) {
    clearToken();
    window.location.reload();
  }
}

export async function authenticate(passphrase: string): Promise<string> {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  if (!res.ok) throw new Error("Invalid passphrase");
  const { token } = (await res.json()) as { token: string };
  setToken(token);
  return token;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as T;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      throw new Error(json.error || text);
    } catch (e) {
      if (e instanceof Error && e.message !== text) throw e;
      throw new Error(text);
    }
  }
  return (await res.json()) as T;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error(await res.text());
  }
}

export async function listStreams(): Promise<Stream[]> {
  return asArray<Stream>(await apiGet<unknown>("/streams?limit=100&offset=0"));
}

export async function getStream(streamId: string): Promise<Stream> {
  return apiGet<Stream>(`/streams/${streamId}`);
}

export async function listSources(): Promise<Source[]> {
  return asArray<Source>(await apiGet<unknown>("/sources?limit=50&offset=0"));
}

export async function getSource(sourceId: string): Promise<Source> {
  return apiGet<Source>(`/sources/${sourceId}`);
}

export async function getMapSources(): Promise<MapSourcesResponse> {
  const response = await apiGet<Partial<MapSourcesResponse>>("/sources/map");
  return {
    included_sources: asArray<Source>(response.included_sources),
    counts: {
      total: response.counts?.total ?? 0,
      included: response.counts?.included ?? 0,
      omitted: response.counts?.omitted ?? 0,
    },
  };
}

export async function createStream(payload: {
  source_id: string;
  frequency_khz: number;
  mode: string;
  name: string;
  bandwidth_low_hz: number;
  bandwidth_high_hz: number;
}): Promise<Stream> {
  return apiPost<Stream>("/streams", payload);
}

export async function deleteStream(streamId: string): Promise<void> {
  await apiDelete(`/streams/${streamId}`);
}

export async function getFallbacks(streamId: string): Promise<FallbacksResponse> {
  return apiGet<FallbacksResponse>(`/streams/${streamId}/fallbacks`);
}

export async function reprobeStream(streamId: string): Promise<void> {
  await apiPost(`/streams/${streamId}/reprobe`, {});
}

export async function fetchFallbackRefAudio(streamId: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/streams/${streamId}/fallbacks/ref-audio`, {
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
  return res.arrayBuffer();
}

export async function fetchFallbackProbeAudio(streamId: string, rank: number): Promise<ArrayBuffer> {
  const res = await fetch(`/api/streams/${streamId}/fallbacks/${rank}/probe-audio`, {
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
  return res.arrayBuffer();
}

export type ProbeResult = {
  source_id: string;
  connected: boolean;
  snd_ok: boolean;
  wf_ok: boolean;
  latency_ms: number;
  error?: string;
};

export async function probeSource(
  sourceId: string,
  streamId: string,
): Promise<ProbeResult> {
  return apiPost<ProbeResult>(`/sources/${sourceId}/probe`, {
    stream_id: streamId,
  });
}

export async function listFavorites(): Promise<string[]> {
  return asArray<string>(await apiGet<unknown>("/favorites"));
}

export async function listFavoriteSources(): Promise<Source[]> {
  return asArray<Source>(await apiGet<unknown>("/favorites/sources"));
}

export async function addFavorite(sourceId: string): Promise<void> {
  const res = await fetch(`/api/favorites/${sourceId}`, {
    method: "PUT",
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
}

export async function removeFavorite(sourceId: string): Promise<void> {
  const res = await fetch(`/api/favorites/${sourceId}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
}

export type RecentSource = {
  source: Source;
  started_at: string;
};

export async function listRecentSources(
  streamId: string,
): Promise<RecentSource[]> {
  return asArray<RecentSource>(
    await apiGet<unknown>(`/streams/${streamId}/recent-sources`),
  );
}

export type SourceNote = {
  tenant_id: string;
  source_id: string;
  content: string;
  created_at: string;
  updated_at: string;
};

export async function listSourceNotes(): Promise<SourceNote[]> {
  return asArray<SourceNote>(await apiGet<unknown>("/source-notes"));
}

export async function getSourceNote(sourceId: string): Promise<SourceNote | null> {
  const res = await apiGet<SourceNote | { content: string }>(`/sources/${sourceId}/notes`);
  if (!("source_id" in res)) return null;
  return res as SourceNote;
}

export async function putSourceNote(sourceId: string, content: string): Promise<SourceNote | null> {
  const res = await fetch(`/api/sources/${sourceId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ content }),
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return (await res.json()) as SourceNote;
}

export async function deleteSourceNote(sourceId: string): Promise<void> {
  await apiDelete(`/sources/${sourceId}/notes`);
}

export async function getSourceStatus(sourceId: string): Promise<string> {
  const res = await fetch(`/api/sources/${sourceId}/status`, {
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

export async function setStreamDebug(
  streamId: string,
  level: "debug" | "info",
): Promise<void> {
  await apiPost(`/streams/${streamId}/debug`, { level });
}

export async function downloadStreamLogs(streamId: string): Promise<void> {
  const res = await fetch(`/api/streams/${streamId}/logs/download`, {
    headers: { ...authHeaders() },
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `logs-${streamId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
