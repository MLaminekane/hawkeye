const API_BASE = '/api';

export interface SessionData {
  id: string;
  objective: string;
  agent: string | null;
  model: string | null;
  working_dir: string;
  git_branch: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  total_cost_usd: number;
  total_tokens: number;
  total_actions: number;
  final_drift_score: number | null;
}

export interface EventData {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: string;
  drift_score: number | null;
  drift_flag: string | null;
  cost_usd: number;
  duration_ms: number;
}

export interface DriftSnapshot {
  id: string;
  score: number;
  flag: string;
  reason: string;
  created_at: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface SettingsData {
  drift: {
    enabled: boolean;
    checkEvery: number;
    provider: string;
    model: string;
    warningThreshold: number;
    criticalThreshold: number;
    contextWindow: number;
    autoPause?: boolean;
    ollamaUrl?: string;
  };
  guardrails: Array<{
    name: string;
    type: string;
    enabled: boolean;
    action: string;
    config: Record<string, unknown>;
  }>;
  webhooks?: Array<{
    enabled: boolean;
    url: string;
    events: string[];
  }>;
}

export interface GlobalStatsData {
  total_sessions: number;
  active_sessions: number;
  completed_sessions: number;
  aborted_sessions: number;
  total_actions: number;
  total_cost_usd: number;
  avg_drift_score: number;
  total_tokens: number;
  first_session: string | null;
  last_session: string | null;
}

export const api = {
  listSessions: (limit = 50) =>
    fetchJson<SessionData[]>(`${API_BASE}/sessions?limit=${limit}`),

  getSession: (id: string) =>
    fetchJson<SessionData>(`${API_BASE}/sessions/${id}`),

  getEvents: (sessionId: string) =>
    fetchJson<EventData[]>(`${API_BASE}/sessions/${sessionId}/events`),

  getDriftSnapshots: (sessionId: string) =>
    fetchJson<DriftSnapshot[]>(`${API_BASE}/sessions/${sessionId}/drift`),

  getSettings: () =>
    fetchJson<SettingsData>(`${API_BASE}/settings`),

  saveSettings: (settings: SettingsData) =>
    postJson<{ ok: boolean }>(`${API_BASE}/settings`, settings),

  getProviders: () =>
    fetchJson<Record<string, string[]>>(`${API_BASE}/providers`),

  getStats: () =>
    fetchJson<GlobalStatsData>(`${API_BASE}/stats`),

  pauseSession: (id: string) =>
    postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/pause`, {}),

  resumeSession: (id: string) =>
    postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/resume`, {}),

  endSession: (id: string, status: 'completed' | 'aborted' = 'completed') =>
    postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/end`, { status }),

  revertFile: (eventId: string) =>
    postJson<{ ok: boolean; path?: string; error?: string }>(`${API_BASE}/revert`, { event_id: eventId }),
};

// ─── WebSocket client ────────────────────────────────────────

export type WsMessage =
  | { type: 'event'; sessionId: string; event: EventData }
  | { type: 'drift_update'; sessionId: string; score: number; flag: string; reason: string }
  | { type: 'session_start'; session: SessionData }
  | { type: 'session_end'; session: SessionData }
  | { type: 'session_pause'; sessionId: string }
  | { type: 'session_resume'; sessionId: string }
  | { type: 'guardrail_violation'; sessionId: string; violation: Record<string, unknown> };

type WsListener = (msg: WsMessage) => void;

class HawkeyeWs {
  private ws: WebSocket | null = null;
  private listeners = new Set<WsListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${proto}//${window.location.host}/ws`;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WsMessage;
          for (const fn of this.listeners) {
            fn(msg);
          }
        } catch {}
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  subscribe(fn: WsListener): () => void {
    this.listeners.add(fn);
    this.connect();
    return () => {
      this.listeners.delete(fn);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export const hawkeyeWs = new HawkeyeWs();
