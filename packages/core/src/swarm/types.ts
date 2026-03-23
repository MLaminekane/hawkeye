/**
 * Hawkeye Multi-agent Orchestration (Swarm) — Type definitions.
 *
 * A swarm coordinates multiple AI agents working on subtasks in parallel,
 * each in an isolated git worktree with enforced scope boundaries.
 */

// ─── Agent Personas ───────────────────────────────────────────

export interface AgentPersona {
  name: string;
  role: 'lead' | 'worker' | 'reviewer';
  description: string;
  /** CLI command template — e.g. "claude", "aider", "codex" */
  command: string;
  /** Extra CLI args (appended after task prompt) */
  args?: string[];
  /** Scope: files/dirs this agent is allowed to touch */
  scope: AgentScope;
  /** Max time in seconds (default 1800 = 30min) */
  timeout?: number;
  /** Max cost in USD (optional budget cap) */
  maxCostUsd?: number;
  /** Model override for this agent (e.g. "claude-sonnet-4-6") */
  model?: string;
  /** Color for dashboard display (hex) */
  color?: string;
}

export interface AgentScope {
  /** Glob patterns of files this agent CAN modify */
  include: string[];
  /** Glob patterns of files this agent CANNOT modify */
  exclude?: string[];
  /** If true, read access is also scoped (default: false = can read anything) */
  readRestricted?: boolean;
}

// ─── Swarm Configuration ──────────────────────────────────────

export interface SwarmConfig {
  name: string;
  description?: string;
  /** Overall objective shared by all agents */
  objective: string;
  /** Agent definitions */
  agents: AgentPersona[];
  /** Task assignments */
  tasks: SwarmTask[];
  /** Merge strategy: sequential (one by one) or octopus (all at once) */
  mergeStrategy: 'sequential' | 'octopus';
  /** Run test command after merge */
  testCommand?: string;
  /** Global timeout in seconds (default 3600 = 1h) */
  timeout?: number;
  /** Auto-merge when all agents finish, or wait for manual approval */
  autoMerge: boolean;
  /** Dependency resolution order */
  dependencyOrder?: string[];
}

export interface SwarmTask {
  id: string;
  /** Agent name this task is assigned to */
  agent: string;
  /** Task prompt / description */
  prompt: string;
  /** Task depends on these other task IDs completing first */
  dependsOn?: string[];
  /** Priority (lower = higher priority, default 0) */
  priority?: number;
  /** Extra context injected into the agent's prompt */
  context?: string;
}

// ─── Runtime State ────────────────────────────────────────────

export type SwarmStatus = 'pending' | 'running' | 'merging' | 'testing' | 'completed' | 'failed' | 'cancelled';
export type SwarmAgentStatus = 'waiting' | 'blocked' | 'running' | 'completed' | 'failed' | 'merged';

export interface SwarmAgent {
  name: string;
  persona: AgentPersona;
  task: SwarmTask;
  status: SwarmAgentStatus;
  /** Hawkeye session ID for this agent's recording */
  sessionId?: string;
  /** Git worktree path */
  worktreePath?: string;
  /** Git branch name */
  branch?: string;
  /** Process PID */
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  exitCode?: number;
  output?: string;
  /** Files changed by this agent */
  filesChanged?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  diffSummary?: string;
  /** Cost tracking */
  costUsd?: number;
  tokensUsed?: number;
  /** Drift score at completion */
  finalDriftScore?: number;
  /** Errors encountered */
  errorCount?: number;
  /** Merge result */
  mergeStatus?: 'pending' | 'merged' | 'conflict' | 'skipped';
  mergeConflicts?: FileConflict[];
}

export interface SwarmResult {
  id: string;
  config: SwarmConfig;
  status: SwarmStatus;
  agents: SwarmAgent[];
  /** Detected file conflicts between agents */
  conflicts: FileConflict[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Total cost across all agents */
  totalCostUsd: number;
  /** Total tokens across all agents */
  totalTokens: number;
  /** Did post-merge tests pass? */
  testsPassed?: boolean;
  testOutput?: string;
  /** Final merge commit hash */
  mergeCommit?: string;
  /** Summary of what each agent accomplished */
  summary?: string;
}

// ─── Conflict Detection ───────────────────────────────────────

export interface FileConflict {
  path: string;
  agents: string[];
  /** Type of conflict: both modified, one deleted + one modified, etc. */
  type: 'both_modified' | 'modify_delete' | 'add_add';
  /** Is the conflict resolved? */
  resolved: boolean;
  resolvedBy?: string;
  resolution?: string;
}

// ─── Swarm Events (WebSocket) ─────────────────────────────────

export type SwarmEventType =
  | 'swarm_created'
  | 'agent_started'
  | 'agent_progress'
  | 'agent_completed'
  | 'agent_failed'
  | 'conflict_detected'
  | 'merge_started'
  | 'merge_completed'
  | 'test_started'
  | 'test_completed'
  | 'swarm_completed'
  | 'swarm_failed';

export interface SwarmEvent {
  type: SwarmEventType;
  swarmId: string;
  agentName?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ─── Database Rows ────────────────────────────────────────────

export interface SwarmRow {
  id: string;
  name: string;
  objective: string;
  config: string; // JSON
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

export interface SwarmAgentRow {
  id: string;
  swarm_id: string;
  agent_name: string;
  persona: string; // JSON
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
  files_changed: string | null; // JSON array
  lines_added: number | null;
  lines_removed: number | null;
  cost_usd: number | null;
  tokens_used: number | null;
  final_drift_score: number | null;
  error_count: number | null;
  merge_status: string | null;
  merge_conflicts: string | null; // JSON array
}

export interface SwarmConflictRow {
  id: string;
  swarm_id: string;
  path: string;
  agents: string; // JSON array
  type: string;
  resolved: number;
  resolved_by: string | null;
  resolution: string | null;
}
