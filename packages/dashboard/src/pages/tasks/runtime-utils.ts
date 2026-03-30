import type { DaemonStatusData, TaskData } from '../../api';

const LOCAL_AGENT_PREFIXES = new Set(['ollama', 'lmstudio']);

export type ClineMode = 'configured' | 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'deepseek';

export function buildClineAgentCommand({
  mode,
  model,
}: {
  mode: ClineMode;
  model: string;
}): string {
  if (mode === 'configured') {
    return 'cline';
  }
  const provider = mode === 'openai' ? 'openai-native' : mode;
  return `cline/${provider}/${model}`;
}

export function describeClineMode(mode: ClineMode): string {
  if (mode === 'configured') {
    return 'Uses your existing Cline CLI login and settings exactly as-is. If your local Cline account is configured for Cline Credits, this mode will bill through Cline Credits.';
  }
  if (mode === 'ollama') {
    return 'Runs Cline against your local Ollama model with a dedicated per-project profile.';
  }
  if (mode === 'lmstudio') {
    return 'Runs Cline against your local LM Studio server with a dedicated per-project profile.';
  }
  if (mode === 'deepseek') {
    return 'Runs Cline through DeepSeek using the API key saved in Settings.';
  }
  if (mode === 'anthropic') {
    return 'Runs Cline through Anthropic with an explicit Claude model and no global config surprises.';
  }
  return 'Runs Cline through OpenAI with an explicit model and a dedicated per-project profile.';
}

export function getTaskAgentLabel(agent: string): string {
  const trimmed = agent.trim();
  if (!trimmed) return 'unknown';

  const claudeApiMatch = trimmed.match(/^claude-api\/(.+)$/);
  if (claudeApiMatch) {
    return `Claude API · ${claudeApiMatch[1]}`;
  }

  const clineProfileMatch = trimmed.match(/^cline\/([^/]+)\/(.+)$/);
  if (clineProfileMatch) {
    return `Cline · ${clineProfileMatch[2]}`;
  }
  if (trimmed === 'cline') {
    return 'Cline default';
  }

  const aiderModelMatch = trimmed.match(/^aider\b.*?--model\s+([^\s]+).*$/);
  if (aiderModelMatch) {
    return `Aider · ${aiderModelMatch[1]
      .replace(/^ollama_chat\//, '')
      .replace(/^openai\//, '')
      .replace(/^anthropic\//, '')
      .replace(/^deepseek\//, '')}`;
  }
  if (trimmed.startsWith('aider')) {
    return 'Aider default';
  }

  const [runtime, ...rest] = trimmed.split('/');
  if (LOCAL_AGENT_PREFIXES.has(runtime.toLowerCase()) && rest.length > 0) {
    return rest.join('/');
  }

  if (trimmed === 'claude') return 'Claude Code';
  if (trimmed === 'codex') return 'Codex';
  if (trimmed === 'cline') return 'Cline';
  if (trimmed === 'aider') return 'Aider';

  return trimmed;
}

export function getTaskDurationMs(task: Pick<TaskData, 'startedAt' | 'completedAt' | 'status'>, now = Date.now()): number | null {
  if (!task.startedAt) return null;
  const started = new Date(task.startedAt).getTime();
  if (Number.isNaN(started)) return null;

  const finished = task.completedAt ? new Date(task.completedAt).getTime() : now;
  if (Number.isNaN(finished)) return null;

  return Math.max(0, finished - started);
}

export function formatTaskDuration(task: Pick<TaskData, 'startedAt' | 'completedAt' | 'status'>, now = Date.now()): string | null {
  const durationMs = getTaskDurationMs(task, now);
  if (durationMs === null) return null;

  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes >= 10 || seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export function getTaskFailureSuggestion(task: Pick<TaskData, 'error' | 'output'>): string | null {
  const haystack = `${task.error ?? ''}\n${task.output ?? ''}`.toLowerCase();
  if (!haystack.trim()) return null;

  if (haystack.includes('credit balance is too low') || haystack.includes('out of extra usage')) {
    return 'Switch runtime or top up credits before retrying.';
  }

  if (haystack.includes('rate-limit') || haystack.includes('rate limit') || haystack.includes("hit your limit")) {
    return 'Retry later or switch to another runtime to avoid the current rate limit.';
  }

  if (haystack.includes('n_keep') || haystack.includes('n_ctx')) {
    return 'This local model context is too small for Cline. Pick a model with a much larger context window, or switch to DeepSeek, Claude, or OpenAI.';
  }

  if (haystack.includes('prompt too long') || haystack.includes('context length')) {
    return 'Tighten the brief or reduce extra context before retrying.';
  }

  if (haystack.includes('connection refused') || haystack.includes('econnrefused') || haystack.includes('ollama')) {
    return 'Check that the local runtime is online, then retry the task.';
  }

  if (haystack.includes('timeout')) {
    return 'Narrow the scope or retry with a faster runtime.';
  }

  return null;
}

export function describeDaemonStatus(status: DaemonStatusData | null): {
  tone: 'good' | 'warning';
  value: string;
  detail: string;
} {
  if (!status?.running) {
    return {
      tone: 'warning',
      value: 'stopped',
      detail: 'Start `hawkeye daemon` to execute queued tasks.',
    };
  }

  const runtime = status.agent ?? 'daemon';
  const currentTask = status.currentTaskId ? `Running ${status.currentTaskId.slice(0, 8)}` : 'Watching queue';
  return {
    tone: 'good',
    value: 'running',
    detail: `${runtime} · ${currentTask}`,
  };
}

export function isFinishedTask(status: TaskData['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
