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
  activity_detection_enabled: boolean;
  activity_sensitivity: number;
  state: string;
  created_at: string;
  updated_at: string;
};

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

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as T;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "DELETE",
  });
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
