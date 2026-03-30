import type { AgentEventData, LiveAgentData } from '../../api';
import { COMMAND_OPTIONS, FALLBACK_COMMAND, ROLE_OPTIONS } from './constants';
import type { AgentRole, CommandOption, RoleOption } from './types';

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.max(0, Math.floor(diff / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatDuration(start: string, end: string | null): string {
  const startTs = new Date(start).getTime();
  const endTs = end ? new Date(end).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((endTs - startTs) / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatClock(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatCount(value: number): string {
  return compactNumberFormatter.format(value);
}

export function formatMoney(value: number): string {
  return currencyFormatter.format(value);
}

export function agentColor(command: string): string {
  if (command === 'claude') return '#ff5f1f';
  if (command === 'cline' || command.startsWith('cline/')) return '#22c55e';
  if (command === 'codex') return '#38bdf8';
  return '#94a3b8';
}

export function driftColor(score: number | null): string {
  if (score === null) return 'text-hawk-text3';
  if (score >= 70) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 40) return 'text-amber-500 dark:text-amber-400';
  return 'text-red-500 dark:text-red-400';
}

export function parseEventSummary(event: AgentEventData): string {
  try {
    const data = JSON.parse(event.data);
    if (event.type === 'tool_use' || event.type === 'action') {
      const tool = data.tool || data.toolName || data.command || '';
      const file = data.file || data.filePath || data.path || '';
      if (tool === 'Write' || tool === 'Edit') return `${tool} ${file.split('/').pop() || file}`;
      if (tool === 'Read') return `Read ${file.split('/').pop() || file}`;
      if (tool === 'Bash') return `Bash: ${(data.command || data.input || '').slice(0, 64)}`;
      return `${tool} ${file ? file.split('/').pop() : ''}`.trim();
    }
    if (event.type === 'llm_call') return `LLM call (${formatMoney(event.cost_usd || 0)})`;
    if (event.type === 'file_change') return `Changed ${(data.path || '').split('/').pop()}`;
    if (event.type === 'error') return `Error: ${(data.message || '').slice(0, 72)}`;
    if (event.type === 'guardrail_trigger') return `Guardrail: ${data.rule || data.type || 'blocked'}`;
    return event.type;
  } catch {
    return event.type;
  }
}

export function eventIcon(type: string): string {
  if (type === 'tool_use' || type === 'action') return '>';
  if (type === 'llm_call') return '*';
  if (type === 'error') return 'x';
  if (type === 'guardrail_trigger') return '!';
  if (type === 'file_change') return '+';
  return '.';
}

export function eventColor(type: string): string {
  if (type === 'error') return 'text-red-500 dark:text-red-400';
  if (type === 'guardrail_trigger') return 'text-amber-500 dark:text-amber-400';
  if (type === 'llm_call') return 'text-hawk-orange';
  if (type === 'file_change') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-hawk-text3';
}

export function getCommandOption(command: string): CommandOption {
  return COMMAND_OPTIONS.find((option) => option.value === command) || FALLBACK_COMMAND;
}

export function getRoleOption(role: AgentRole): RoleOption {
  return ROLE_OPTIONS.find((option) => option.value === role) || ROLE_OPTIONS[1];
}

export function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

export function normalizeSessionId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value && typeof value === 'object' && 'id' in value) {
    return normalizeText((value as { id?: unknown }).id, '') || null;
  }
  return null;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeText(entry)).filter(Boolean);
}

export function normalizeAgentStatus(value: unknown): LiveAgentData['status'] {
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
  return 'running';
}

export function normalizeAgentRole(value: unknown): LiveAgentData['role'] {
  if (value === 'lead' || value === 'worker' || value === 'reviewer') return value;
  return 'worker';
}

export function normalizeLiveAgent(agent: Partial<LiveAgentData> & Record<string, unknown>): LiveAgentData {
  return {
    id: normalizeText(agent.id, ''),
    name: normalizeText(agent.name, 'Unnamed agent'),
    command: normalizeText(agent.command, 'agent'),
    prompt: normalizeText(agent.prompt),
    role: normalizeAgentRole(agent.role),
    personality: normalizeText(agent.personality),
    permissions: (
      ['default', 'full', 'supervised'].includes(agent.permissions as string) ? agent.permissions : 'full'
    ) as LiveAgentData['permissions'],
    status: normalizeAgentStatus(agent.status),
    output: normalizeText(agent.output),
    startedAt:
      typeof agent.startedAt === 'string' && agent.startedAt ? agent.startedAt : new Date().toISOString(),
    finishedAt: typeof agent.finishedAt === 'string' ? agent.finishedAt : null,
    exitCode: typeof agent.exitCode === 'number' ? agent.exitCode : null,
    pid: typeof agent.pid === 'number' ? agent.pid : null,
    filesChanged: normalizeStringArray(agent.filesChanged),
    linesAdded: typeof agent.linesAdded === 'number' ? agent.linesAdded : 0,
    linesRemoved: typeof agent.linesRemoved === 'number' ? agent.linesRemoved : 0,
    sessionId: normalizeSessionId(agent.sessionId),
    driftScore: typeof agent.driftScore === 'number' ? agent.driftScore : null,
    actionCount: typeof agent.actionCount === 'number' ? agent.actionCount : 0,
    costUsd: typeof agent.costUsd === 'number' ? agent.costUsd : 0,
  };
}

export function getOutputPreview(output: string): string {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-3)
    .join('\n')
    .slice(-280);
}

export function getStatusBadgeClass(status: LiveAgentData['status']): string {
  if (status === 'running') return 'text-cyan-600 dark:text-cyan-300 bg-cyan-500/10 border-cyan-500/20';
  if (status === 'completed') {
    return 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 border-emerald-500/20';
  }
  return 'text-red-500 dark:text-red-300 bg-red-500/10 border-red-500/20';
}

export function formatOutputLineClass(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('failed')) return 'text-red-600 dark:text-red-300';
  if (lower.includes('warning')) return 'text-amber-600 dark:text-amber-300';
  if (line.trim().startsWith('#')) return 'text-hawk-orange';
  if (line.trim().startsWith('-') || line.trim().startsWith('*')) {
    return 'text-cyan-600 dark:text-cyan-300';
  }
  return 'text-hawk-text2';
}
