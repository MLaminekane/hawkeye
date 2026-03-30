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
  developer: string | null;
}

export interface SessionStatsData {
  total_events: number;
  command_count: number;
  file_count: number;
  llm_count: number;
  api_count: number;
  git_count: number;
  error_count: number;
  guardrail_count: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

export interface SessionComparisonData {
  session: SessionData;
  stats: SessionStatsData;
  durationMs: number;
  filesChanged: string[];
  topCostFiles: Array<{ path: string; cost: number }>;
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

export type InterceptionRisk = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface PendingReviewData {
  id: string;
  timestamp: string;
  sessionId: string;
  command: string;
  matchedPattern: string;
}

export interface InterceptionEventData extends EventData {
  risk: InterceptionRisk;
}

export interface InterceptionsData {
  blocks: EventData[];
  recentActions: InterceptionEventData[];
  pendingReviews: PendingReviewData[];
  impactPreviewsEnabled: boolean;
}

export interface DriftSnapshot {
  id: string;
  score: number;
  flag: string;
  reason: string;
  created_at: string;
}

export interface TaskData {
  id: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  agent: string;
  exitCode?: number;
  output?: string;
  error?: string;
  sessionId?: string;
  attachments?: string[];
}

export interface DaemonStatusData {
  running: boolean;
  agent: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  intervalSec: number | null;
  currentTaskId: string | null;
  currentTaskPid: number | null;
}

export interface RcaCausalStep {
  sequence: number;
  type: string;
  description: string;
  timestamp: string;
  relevance: 'root_cause' | 'contributing' | 'effect' | 'context';
  explanation: string;
}

export interface RcaErrorPattern {
  pattern: string;
  count: number;
  sequences: number[];
}

export interface RcaResult {
  summary: string;
  outcome: 'success' | 'failure' | 'partial' | 'unknown';
  primaryError: {
    sequence: number;
    type: string;
    description: string;
    timestamp: string;
  } | null;
  causalChain: RcaCausalStep[];
  driftAnalysis: {
    trend: 'stable' | 'declining' | 'volatile' | 'improving';
    lowestScore: number;
    highestScore: number;
    inflectionPoint: {
      sequence: number;
      scoreBefore: number;
      scoreAfter: number;
      triggerDescription: string;
    } | null;
  } | null;
  errorPatterns: RcaErrorPattern[];
  suggestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

// ─── Memory Diff types ───

export interface MemoryItemData {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  category: string;
  key: string;
  content: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  supersedes?: string;
  contradicts?: string;
}

export interface MemoryDiffItemData {
  status: 'learned' | 'forgotten' | 'retained' | 'evolved' | 'contradicted';
  category: string;
  key: string;
  before?: MemoryItemData;
  after?: MemoryItemData;
  explanation: string;
}

export interface HallucinationItemData {
  key: string;
  category: string;
  claim: string;
  evidence: string;
  type: 'nonexistent_file' | 'contradicted_fact' | 'recurring_error' | 'phantom_api';
  occurrences: Array<{ sessionId: string; sequence: number; timestamp: string }>;
}

export interface MemoryDiffResultData {
  sessionA: { id: string; objective: string; startedAt: string };
  sessionB: { id: string; objective: string; startedAt: string };
  learned: MemoryDiffItemData[];
  forgotten: MemoryDiffItemData[];
  retained: MemoryDiffItemData[];
  evolved: MemoryDiffItemData[];
  contradicted: MemoryDiffItemData[];
  hallucinations: HallucinationItemData[];
  summary: string;
}

export interface CumulativeMemoryData {
  items: MemoryItemData[];
  totalSessions: number;
  firstSeen: string;
  lastUpdated: string;
  hallucinations: HallucinationItemData[];
  stats: {
    byCategory: Record<string, number>;
    totalItems: number;
    contradictions: number;
    corrections: number;
  };
}

// ─── Incident / Intelligence types ───

export interface IncidentData {
  id: string;
  sessionId: string;
  triggeredAt: string;
  trigger: string;
  severity: 'warning' | 'critical';
  driftScore: number | null;
  driftFlag: string | null;
  summary: string;
  recentEvents: Array<{ sequence: number; type: string; timestamp: string; summary: string }>;
  errorPatterns: Array<{ pattern: string; count: number }>;
  filesChanged: string[];
}

export interface SelfAssessmentData {
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  drift: { score: number | null; flag: string; trend: string };
  cost: { spent: number; budget: number | null; percentUsed: number | null };
  errors: { total: number; recurring: number; unresolvedPatterns: string[] };
  velocity: { actionsPerMinute: number; filesChanged: number };
  recommendations: string[];
}

export interface AutoCorrectionData {
  shouldCorrect: boolean;
  urgency: string;
  diagnosis: string;
  corrections: Array<{ type: string; description: string; reasoning: string }>;
}

// ─── Autocorrect types ───

export interface CorrectionRecordData {
  id: string;
  sessionId: string;
  timestamp: string;
  trigger: string;
  assessment: {
    driftScore: number | null;
    driftFlag: string;
    errorCount: number;
    recurringErrors: number;
    costPercent: number | null;
  };
  corrections: Array<{
    type: string;
    target: string;
    description: string;
    reasoning: string;
    executed: boolean;
    result: string;
    error?: string;
  }>;
  dryRun: boolean;
}

export interface CorrectionHintData {
  sessionId: string;
  timestamp: string;
  trigger: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  diagnosis: string;
  corrections: Array<{
    type: string;
    description: string;
    reasoning: string;
    executed: boolean;
  }>;
  agentInstructions: string;
}

export interface GitCommitData {
  sessionId: string;
  agent: string | null;
  sequence: number;
  timestamp: string;
  commitHash: string;
  message: string;
  branch: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

// ─── Live Agent types ───

export type PermissionLevel = 'default' | 'full' | 'supervised';

export interface LiveAgentData {
  id: string;
  name: string;
  command: string;
  prompt: string;
  role: 'lead' | 'worker' | 'reviewer';
  personality: string;
  permissions: PermissionLevel;
  status: 'running' | 'completed' | 'failed';
  output: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  sessionId: string | null;
  driftScore: number | null;
  actionCount: number;
  costUsd: number;
}

export interface AgentMessageData {
  id: string;
  from: string;
  fromName: string;
  to: string | null;
  toRole: string | null;
  content: string;
  type: 'direct' | 'broadcast' | 'decision' | 'request' | 'response';
  timestamp: string;
  read: boolean;
}

export interface AgentEventData {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: string;
  drift_score: number | null;
  cost_usd: number;
}

// ─── Swarm types ───

export interface SwarmData {
  id: string;
  name: string;
  objective: string;
  config: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total_cost_usd: number;
  total_tokens: number;
  tests_passed: number | null;
  test_output: string | null;
  merge_commit: string | null;
  summary: string | null;
}

export interface SwarmAgentData {
  id: string;
  swarm_id: string;
  agent_name: string;
  persona: string;
  task_prompt: string;
  task_id: string;
  status: string;
  session_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  pid: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_seconds: number | null;
  exit_code: number | null;
  output: string | null;
  files_changed: string | null;
  lines_added: number | null;
  lines_removed: number | null;
  cost_usd: number | null;
  tokens_used: number | null;
  final_drift_score: number | null;
  error_count: number | null;
  merge_status: string | null;
  merge_conflicts: string | null;
}

export interface SwarmConflictData {
  id: string;
  swarm_id: string;
  path: string;
  agents: string;
  type: string;
  resolved: number;
  resolved_by: string | null;
  resolution: string | null;
}

export interface SwarmFullData {
  swarm: SwarmData;
  agents: SwarmAgentData[];
  conflicts: SwarmConflictData[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
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
    lmstudioUrl?: string;
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
  apiKeys?: Record<string, string>;
  recording?: {
    ignorePatterns: string[];
    maxStdoutBytes: number;
    captureLlmContent: boolean;
  };
  dashboard?: {
    openBrowser: boolean;
  };
  autocorrect?: {
    enabled: boolean;
    dryRun: boolean;
    triggers: { driftCritical: boolean; errorRepeat: number; costThreshold: number };
    actions: {
      rollbackFiles: boolean;
      pauseSession: boolean;
      injectHint: boolean;
      blockPattern: boolean;
    };
  };
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ImpactPreviewData {
  timestamp: string;
  sessionId: string;
  toolName: string;
  toolInput: { command?: string; file_path?: string };
  impact: {
    risk: 'low' | 'medium' | 'high' | 'critical';
    summary: string;
    details: string[];
    affectedFiles: number;
    affectedLines: number;
    gitTracked: boolean;
    uncommittedChanges: boolean;
    category: string;
  };
}

export interface PolicyRule {
  name: string;
  description?: string;
  type: string;
  enabled: boolean;
  action: 'warn' | 'block';
  config: Record<string, unknown>;
}

export interface PolicyData {
  version: '1';
  name: string;
  description?: string;
  rules: PolicyRule[];
}

export interface PolicyValidationError {
  rule: string;
  field: string;
  message: string;
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
  listSessions: (limit = 50) => fetchJson<SessionData[]>(`${API_BASE}/sessions?limit=${limit}`),

  getSession: (id: string) => fetchJson<SessionData>(`${API_BASE}/sessions/${id}`),

  getEvents: (sessionId: string) =>
    fetchJson<EventData[]>(`${API_BASE}/sessions/${sessionId}/events`),

  getDriftSnapshots: (sessionId: string) =>
    fetchJson<DriftSnapshot[]>(`${API_BASE}/sessions/${sessionId}/drift`),

  getSettings: () => fetchJson<SettingsData>(`${API_BASE}/settings`),

  saveSettings: (settings: SettingsData) =>
    postJson<{ ok: boolean }>(`${API_BASE}/settings`, settings),

  getProviders: () => fetchJson<Record<string, string[]>>(`${API_BASE}/providers`),

  getLocalProviders: () =>
    fetchJson<Record<string, { available: boolean; models: string[]; url: string }>>(`${API_BASE}/providers/local`),

  getStats: () => fetchJson<GlobalStatsData>(`${API_BASE}/stats`),

  pauseSession: (id: string) => postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/pause`, {}),

  resumeSession: (id: string) => postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/resume`, {}),

  endSession: (id: string, status: 'completed' | 'aborted' = 'completed') =>
    postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/end`, { status }),

  deleteSession: (id: string) =>
    postJson<{ ok: boolean }>(`${API_BASE}/sessions/${id}/delete`, {}),

  forkSession: (sessionId: string, upToSequence: number) =>
    postJson<{ ok: boolean; forkedSessionId: string }>(`${API_BASE}/sessions/${sessionId}/fork`, {
      upToSequence,
    }),

  revertFile: (eventId: string) =>
    postJson<{ ok: boolean; path?: string; error?: string }>(`${API_BASE}/revert`, {
      event_id: eventId,
    }),

  compareSessions: (ids: string[]) =>
    fetchJson<SessionComparisonData[]>(`${API_BASE}/compare?ids=${ids.join(',')}`),

  getPendingReviews: () =>
    fetchJson<
      Array<{
        id: string;
        timestamp: string;
        sessionId: string;
        command: string;
        matchedPattern: string;
      }>
    >(`${API_BASE}/pending-reviews`),

  approveReview: (id: string, scope: 'session' | 'always' = 'session') =>
    postJson<{ ok: boolean }>(`${API_BASE}/review-approve`, { id, scope }),

  denyReview: (id: string) => postJson<{ ok: boolean }>(`${API_BASE}/review-deny`, { id }),

  listTasks: () => fetchJson<TaskData[]>(`${API_BASE}/tasks`),

  getDaemonStatus: () => fetchJson<DaemonStatusData>(`${API_BASE}/daemon/status`),

  createTask: (
    prompt: string,
    agent = 'claude',
    attachments?: Array<{ name: string; data: string }>,
  ) => postJson<TaskData>(`${API_BASE}/tasks`, { prompt, agent, attachments }),

  retryTask: (id: string) => postJson<TaskData>(`${API_BASE}/tasks/${id}/retry`, {}),

  cancelTask: (id: string) => postJson<{ ok: boolean }>(`${API_BASE}/tasks/${id}/cancel`, {}),

  clearFinishedTasks: () => postJson<{ ok: boolean; removed: number }>(`${API_BASE}/tasks/clear-finished`, {}),

  getTaskJournal: async (): Promise<string> => {
    const res = await fetch(`${API_BASE}/tasks/journal`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.text();
  },

  clearTaskJournal: () => postJson<{ ok: boolean }>(`${API_BASE}/tasks/journal/clear`, {}),

  getMcpServers: () => fetchJson<Record<string, McpServerEntry>>(`${API_BASE}/mcp-servers`),

  saveMcpServers: (payload: Record<string, McpServerEntry | null>) =>
    postJson<{ ok: boolean; servers: string[] }>(`${API_BASE}/mcp-servers`, payload),

  getLastImpact: () => fetchJson<ImpactPreviewData | null>(`${API_BASE}/impact`),

  getInterceptions: () =>
    fetchJson<InterceptionsData>(`${API_BASE}/interceptions`),

  getPolicies: () => fetchJson<PolicyData | null>(`${API_BASE}/policies`),

  savePolicies: (policy: PolicyData) =>
    postJson<{ ok: boolean; errors?: PolicyValidationError[] }>(`${API_BASE}/policies`, policy),

  analyzeSession: (sessionId: string) =>
    fetchJson<RcaResult>(`${API_BASE}/sessions/${sessionId}/analyze`),

  getSessionMemory: (sessionId: string) =>
    fetchJson<MemoryItemData[]>(`${API_BASE}/sessions/${sessionId}/memory`),

  getMemoryDiff: (sessionA: string, sessionB: string) =>
    fetchJson<MemoryDiffResultData>(`${API_BASE}/memory/diff?a=${sessionA}&b=${sessionB}`),

  getCumulativeMemory: (limit = 20) =>
    fetchJson<CumulativeMemoryData>(`${API_BASE}/memory/cumulative?limit=${limit}`),

  getHallucinations: () => fetchJson<HallucinationItemData[]>(`${API_BASE}/memory/hallucinations`),

  triggerIncident: (sessionId: string) =>
    postJson<IncidentData>(`${API_BASE}/sessions/${sessionId}/incident`, {}),

  getIncidents: (sessionId: string) =>
    fetchJson<IncidentData[]>(`${API_BASE}/sessions/${sessionId}/incidents`),

  getSelfAssessment: (sessionId: string) =>
    fetchJson<SelfAssessmentData>(`${API_BASE}/sessions/${sessionId}/self-assess`),

  getAutoCorrection: (sessionId: string) =>
    fetchJson<AutoCorrectionData>(`${API_BASE}/sessions/${sessionId}/auto-correct`),

  getCommits: (sessionId?: string) =>
    fetchJson<GitCommitData[]>(`${API_BASE}/commits${sessionId ? `?session=${sessionId}` : ''}`),

  // ─── Autocorrect ───

  getCorrections: (sessionId: string) =>
    fetchJson<CorrectionRecordData[]>(`${API_BASE}/sessions/${sessionId}/corrections`),

  getAllCorrections: (limit = 50) =>
    fetchJson<CorrectionRecordData[]>(`${API_BASE}/corrections?limit=${limit}`),

  getActiveCorrection: () => fetchJson<CorrectionHintData | null>(`${API_BASE}/active-correction`),

  saveAutocorrect: (config: {
    enabled: boolean;
    dryRun: boolean;
    triggers: Record<string, unknown>;
    actions: Record<string, unknown>;
  }) => postJson<{ ok: boolean }>(`${API_BASE}/autocorrect`, config),

  clearActiveCorrection: () => postJson<{ ok: boolean }>(`${API_BASE}/autocorrect/clear`, {}),

  // ─── CI Report ───

  getCIReport: (sessionId: string) =>
    fetchJson<{
      markdown: string;
      risk: string;
      passed: boolean;
      flags: string[];
      sensitiveFiles: string[];
      dangerousCommands: string[];
      failedCommands: string[];
    }>(`${API_BASE}/sessions/${sessionId}/ci-report`),

  // ─── Swarm ───

  listSwarms: (limit = 20) => fetchJson<SwarmData[]>(`${API_BASE}/swarms?limit=${limit}`),

  getSwarm: (id: string) => fetchJson<SwarmData>(`${API_BASE}/swarms/${id}`),

  getSwarmAgents: (swarmId: string) =>
    fetchJson<SwarmAgentData[]>(`${API_BASE}/swarms/${swarmId}/agents`),

  getSwarmConflicts: (swarmId: string) =>
    fetchJson<SwarmConflictData[]>(`${API_BASE}/swarms/${swarmId}/conflicts`),

  getSwarmFull: (swarmId: string) => fetchJson<SwarmFullData>(`${API_BASE}/swarms/${swarmId}/full`),

  cancelSwarm: (swarmId: string) =>
    postJson<{ ok: boolean }>(`${API_BASE}/swarms/${swarmId}/cancel`, {}),

  deleteSwarm: (swarmId: string) =>
    postJson<{ ok: boolean }>(`${API_BASE}/swarms/${swarmId}/delete`, {}),

  createSwarm: (config: Record<string, unknown>) =>
    postJson<{ ok: boolean; message: string }>(`${API_BASE}/swarms`, config),

  getSwarmTemplate: async (): Promise<string> => {
    const res = await fetch(`${API_BASE}/swarms/template`, { method: 'POST' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.text();
  },

  // ─── Live Agents ───

  listAgents: () => fetchJson<LiveAgentData[]>(`${API_BASE}/agents`),

  getAgent: (id: string) => fetchJson<LiveAgentData>(`${API_BASE}/agents/${id}`),

  spawnAgent: (
    name: string,
    command: string,
    prompt: string,
    role: string = 'worker',
    personality: string = '',
    permissions: string = 'full',
  ) =>
    postJson<{ ok: boolean; agent: LiveAgentData }>(`${API_BASE}/agents/spawn`, {
      name,
      command,
      prompt,
      role,
      personality,
      permissions,
    }),

  getAgentEvents: (id: string, limit: number = 20) =>
    fetchJson<AgentEventData[]>(`${API_BASE}/agents/${id}/events?limit=${limit}`),

  stopAgent: (id: string) => postJson<{ ok: boolean }>(`${API_BASE}/agents/${id}/stop`, {}),

  removeAgent: (id: string) => postJson<{ ok: boolean }>(`${API_BASE}/agents/${id}/remove`, {}),

  sendAgentMessage: (id: string, message: string) =>
    postJson<{ ok: boolean; agent: LiveAgentData }>(`${API_BASE}/agents/${id}/message`, {
      message,
    }),

  updateAgentPermissions: (id: string, permissions: PermissionLevel) =>
    postJson<{ ok: boolean; agent: LiveAgentData }>(`${API_BASE}/agents/${id}/permissions`, {
      permissions,
    }),

  // ─── Inter-Agent Comms ───

  getAgentMessages: () => fetchJson<AgentMessageData[]>(`${API_BASE}/agents/messages`),

  getAgentInbox: (agentId: string) =>
    fetchJson<AgentMessageData[]>(`${API_BASE}/agents/${agentId}/inbox`),

  sendAgentComm: (msg: {
    from?: string;
    fromName?: string;
    to?: string;
    toRole?: string;
    content: string;
    type?: string;
  }) =>
    postJson<{ ok: boolean; message: AgentMessageData; delivered: string[] }>(
      `${API_BASE}/agents/comms`,
      msg,
    ),

  clearAgentMessages: () =>
    fetch(`${API_BASE}/agents/messages`, { method: 'DELETE' }).then(
      (r) => r.json() as Promise<{ ok: boolean }>,
    ),
};

// ─── WebSocket client ────────────────────────────────────────

export type WsMessage =
  | { type: 'event'; sessionId: string; event: EventData }
  | { type: 'drift_update'; sessionId: string; score: number; flag: string; reason: string }
  | { type: 'session_end'; session: { id: string; status: string } }
  | { type: 'session_pause'; sessionId: string }
  | { type: 'session_resume'; sessionId: string }
  | { type: 'review_approved'; reviewId: string; pattern: string; scope: string }
  | { type: 'review_denied'; reviewId: string; pattern: string }
  | { type: 'task_created'; task: TaskData }
  | { type: 'task_cancelled'; task: TaskData }
  | { type: 'task_running'; task: TaskData }
  | { type: 'task_completed'; task: TaskData }
  | { type: 'task_failed'; task: TaskData }
  | { type: 'daemon_status'; status: DaemonStatusData }
  | {
      type: 'impact_preview';
      timestamp: string;
      sessionId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      impact: ImpactPreviewData['impact'];
    }
  | {
      type: 'action_stream';
      sessionId: string;
      event: EventData;
      risk: 'safe' | 'low' | 'medium' | 'high' | 'critical';
    }
  | { type: 'incident'; sessionId: string; incident: IncidentData }
  | { type: 'autocorrect'; sessionId: string; correction: CorrectionRecordData }
  | { type: 'swarm'; event: string; swarmId: string; [key: string]: unknown }
  | { type: 'agent_spawned'; agent: LiveAgentData }
  | { type: 'agent_output'; agentId: string; chunk: string }
  | {
      type: 'agent_complete';
      agentId: string;
      status: string;
      exitCode?: number;
      filesChanged?: string[];
    }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'agent_session_linked'; agentId: string; sessionId: string }
  | { type: 'agent_stats'; agentId: string; drift: number | null; cost: number; actions: number }
  | { type: 'agent_message'; message: AgentMessageData }
  | { type: 'agent_permissions'; agentId: string; permissions: PermissionLevel };

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
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WsMessage;
          if (
            msg.type === 'session_end' &&
            msg.session.id === '__reload__' &&
            msg.session.status === 'reload'
          ) {
            window.location.reload();
            return;
          }
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
