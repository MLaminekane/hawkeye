import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, hawkeyeWs } from '../api';
import type { LiveAgentData, AgentEventData } from '../api';

type AgentRole = LiveAgentData['role'];
type AgentStatusFilter = 'all' | LiveAgentData['status'];
type Notice = { type: 'success' | 'error'; text: string } | null;

interface CommandOption {
  value: string;
  label: string;
  kicker: string;
  summary: string;
  detail: string;
  badgeClass: string;
  borderClass: string;
  surfaceClass: string;
}

interface RoleOption {
  value: AgentRole;
  label: string;
  summary: string;
  badgeClass: string;
  borderClass: string;
  surfaceClass: string;
}

interface QuickStart {
  id: string;
  label: string;
  kicker: string;
  summary: string;
  command: string;
  role: AgentRole;
  prompt: string;
  personality: string;
  namePrefix: string;
}

const COMMAND_OPTIONS: CommandOption[] = [
  {
    value: 'claude',
    label: 'Claude',
    kicker: 'Strategic',
    summary: 'Great for planning, debugging, and narrative reasoning.',
    detail: 'Use when you want deliberate investigation, structured decisions, and strong follow-up guidance.',
    badgeClass: 'text-hawk-orange',
    borderClass: 'border-orange-500/30',
    surfaceClass: 'from-orange-500/20 via-orange-500/7 to-transparent',
  },
  {
    value: 'aider',
    label: 'Aider',
    kicker: 'Tactile',
    summary: 'Comfortable for quick iterations and patch-oriented work.',
    detail: 'Use when you want a hands-on coding rhythm and direct implementation loops.',
    badgeClass: 'text-emerald-600 dark:text-emerald-400',
    borderClass: 'border-emerald-500/30',
    surfaceClass: 'from-emerald-500/20 via-emerald-500/7 to-transparent',
  },
  {
    value: 'codex',
    label: 'Codex',
    kicker: 'Builder',
    summary: 'Strong fit for implementation-heavy tasks and test-backed changes.',
    detail: 'Use when the mission is to ship code, fix bugs, and verify outcomes fast.',
    badgeClass: 'text-sky-600 dark:text-sky-400',
    borderClass: 'border-sky-500/30',
    surfaceClass: 'from-sky-500/20 via-sky-500/7 to-transparent',
  },
];

const FALLBACK_COMMAND: CommandOption = {
  value: 'agent',
  label: 'Agent',
  kicker: 'Runtime',
  summary: 'Connected runtime',
  detail: 'Attached via Hawkeye',
  badgeClass: 'text-hawk-text',
  borderClass: 'border-hawk-border',
  surfaceClass: 'from-hawk-surface2 via-hawk-surface2 to-transparent',
};

const ROLE_OPTIONS: RoleOption[] = [
  {
    value: 'lead',
    label: 'Lead',
    summary: 'Frames the plan, keeps the task on track, and coordinates the next move.',
    badgeClass: 'text-amber-600 dark:text-amber-300 bg-amber-500/10 border-amber-500/20',
    borderClass: 'border-amber-500/30',
    surfaceClass: 'from-amber-500/18 via-amber-500/6 to-transparent',
  },
  {
    value: 'worker',
    label: 'Worker',
    summary: 'Executes the task directly and turns intent into concrete code or output.',
    badgeClass: 'text-cyan-600 dark:text-cyan-300 bg-cyan-500/10 border-cyan-500/20',
    borderClass: 'border-cyan-500/30',
    surfaceClass: 'from-cyan-500/18 via-cyan-500/6 to-transparent',
  },
  {
    value: 'reviewer',
    label: 'Reviewer',
    summary: 'Looks for regressions, weak assumptions, and missing validation before merge.',
    badgeClass: 'text-violet-600 dark:text-violet-300 bg-violet-500/10 border-violet-500/20',
    borderClass: 'border-violet-500/30',
    surfaceClass: 'from-violet-500/18 via-violet-500/6 to-transparent',
  },
];

const QUICK_STARTS: QuickStart[] = [
  {
    id: 'fix-regression',
    label: 'Fix a regression',
    kicker: 'Repair',
    summary: 'Trace the failure, patch it safely, and prove the fix.',
    command: 'codex',
    role: 'worker',
    prompt:
      'Investigate the regression, identify the root cause, implement the smallest safe fix, and verify the result with targeted checks.',
    personality:
      'Work in small safe diffs. Prefer the minimum change that restores correct behavior. Add or update tests when they make the fix safer.',
    namePrefix: 'regression-fix',
  },
  {
    id: 'review-changes',
    label: 'Review a change',
    kicker: 'Audit',
    summary: 'Hunt for bugs, regressions, and blind spots before shipping.',
    command: 'claude',
    role: 'reviewer',
    prompt:
      'Review the current changes for bugs, behavioral regressions, risky assumptions, and missing tests. Prioritize findings by severity and include exact file references.',
    personality:
      'Be skeptical, concise, and evidence-driven. Lead with findings, not summary. Prefer high-signal issues over stylistic comments.',
    namePrefix: 'review-pass',
  },
  {
    id: 'ship-feature',
    label: 'Ship a feature',
    kicker: 'Build',
    summary: 'Implement a scoped feature with tests and a clean closeout.',
    command: 'codex',
    role: 'worker',
    prompt:
      'Implement the requested feature end-to-end, keep the UX polished, add the right validation, and verify the result with tests or targeted checks.',
    personality:
      'Optimize for readable code, polished UX, and confidence in the final result. Prefer direct implementation over long speculation.',
    namePrefix: 'feature-build',
  },
  {
    id: 'stabilize-flow',
    label: 'Stabilize a flow',
    kicker: 'Triage',
    summary: 'Observe the system, narrow the problem, and recommend the next safest step.',
    command: 'aider',
    role: 'lead',
    prompt:
      'Map the failing flow, identify the highest-risk points, and propose the safest next step before making broad changes. If a fix is obvious, apply it carefully.',
    personality:
      'Move deliberately. Clarify tradeoffs, keep a short feedback loop, and avoid risky changes until the path is clear.',
    namePrefix: 'stability-lead',
  },
];

const STATUS_FILTERS: Array<{ id: AgentStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Live' },
  { id: 'failed', label: 'Needs attention' },
  { id: 'completed', label: 'Finished' },
];

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

function timeAgo(dateStr: string): string {
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

function formatDuration(start: string, end: string | null): string {
  const startTs = new Date(start).getTime();
  const endTs = end ? new Date(end).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((endTs - startTs) / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatClock(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCount(value: number): string {
  return compactNumberFormatter.format(value);
}

function formatMoney(value: number): string {
  return currencyFormatter.format(value);
}

function agentColor(command: string): string {
  if (command === 'claude') return '#ff5f1f';
  if (command === 'aider') return '#22c55e';
  if (command === 'codex') return '#38bdf8';
  return '#94a3b8';
}

function driftColor(score: number | null): string {
  if (score === null) return 'text-hawk-text3';
  if (score >= 70) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 40) return 'text-amber-500 dark:text-amber-400';
  return 'text-red-500 dark:text-red-400';
}

function parseEventSummary(event: AgentEventData): string {
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

function eventIcon(type: string): string {
  if (type === 'tool_use' || type === 'action') return '>';
  if (type === 'llm_call') return '*';
  if (type === 'error') return 'x';
  if (type === 'guardrail_trigger') return '!';
  if (type === 'file_change') return '+';
  return '.';
}

function eventColor(type: string): string {
  if (type === 'error') return 'text-red-500 dark:text-red-400';
  if (type === 'guardrail_trigger') return 'text-amber-500 dark:text-amber-400';
  if (type === 'llm_call') return 'text-hawk-orange';
  if (type === 'file_change') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-hawk-text3';
}

function getCommandOption(command: string): CommandOption {
  return COMMAND_OPTIONS.find((option) => option.value === command) || FALLBACK_COMMAND;
}

function getRoleOption(role: AgentRole): RoleOption {
  return ROLE_OPTIONS.find((option) => option.value === role) || ROLE_OPTIONS[1];
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value && typeof value === 'object' && 'id' in value) {
    return normalizeText((value as { id?: unknown }).id, '') || null;
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeText(entry)).filter(Boolean);
}

function normalizeAgentStatus(value: unknown): LiveAgentData['status'] {
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
  return 'running';
}

function normalizeAgentRole(value: unknown): LiveAgentData['role'] {
  if (value === 'lead' || value === 'worker' || value === 'reviewer') return value;
  return 'worker';
}

function normalizeLiveAgent(agent: Partial<LiveAgentData> & Record<string, unknown>): LiveAgentData {
  return {
    id: normalizeText(agent.id, `agent-${Math.random().toString(36).slice(2, 8)}`),
    name: normalizeText(agent.name, 'Unnamed agent'),
    command: normalizeText(agent.command, 'agent'),
    prompt: normalizeText(agent.prompt),
    role: normalizeAgentRole(agent.role),
    personality: normalizeText(agent.personality),
    permissions: (['default', 'full', 'supervised'].includes(agent.permissions as string) ? agent.permissions : 'full') as LiveAgentData['permissions'],
    status: normalizeAgentStatus(agent.status),
    output: normalizeText(agent.output),
    startedAt:
      typeof agent.startedAt === 'string' && agent.startedAt
        ? agent.startedAt
        : new Date().toISOString(),
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

function getOutputPreview(output: string): string {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-3)
    .join('\n')
    .slice(-280);
}

function SummaryCard({
  label,
  value,
  hint,
  toneClass = 'text-hawk-text',
}: {
  label: string;
  value: string;
  hint: string;
  toneClass?: string;
}) {
  return (
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/55 p-3 shadow-[0_16px_40px_-30px_rgba(0,0,0,0.9)]">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-display text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-hawk-text2">{hint}</div>
    </div>
  );
}

function AgentMetric({
  label,
  value,
  hint,
  toneClass = 'text-hawk-text',
}: {
  label: string;
  value: string;
  hint: string;
  toneClass?: string;
}) {
  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text2">{hint}</div>
    </div>
  );
}

export default function SwarmPage() {
  const [agents, setAgents] = useState<LiveAgentData[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [command, setCommand] = useState('claude');
  const [role, setRole] = useState<AgentRole>('worker');
  const [permissions, setPermissions] = useState<'default' | 'full' | 'supervised'>('full');
  const [prompt, setPrompt] = useState('');
  const [personality, setPersonality] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedStarterId, setSelectedStarterId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [filter, setFilter] = useState<AgentStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showOutputId, setShowOutputId] = useState<string | null>(null);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [sendingMessageId, setSendingMessageId] = useState<string | null>(null);
  const [actingAgentId, setActingAgentId] = useState<string | null>(null);

  const [agentEvents, setAgentEvents] = useState<Record<string, AgentEventData[]>>({});

  const outputRefs = useRef<Map<string, HTMLPreElement>>(new Map());
  const pollingTargetsRef = useRef<Array<{ id: string; sessionId: string }>>([]);
  const [, setClockTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await api.listAgents();
      setAgents(data.map((agent) => normalizeLiveAgent(agent as Partial<LiveAgentData> & Record<string, unknown>)));
    } catch {
      setNotice({ type: 'error', text: 'Unable to load agents right now.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    pollingTargetsRef.current = agents
      .map((agent) => ({ id: agent.id, sessionId: normalizeSessionId(agent.sessionId) }))
      .filter((agent): agent is { id: string; sessionId: string } => Boolean(agent.sessionId));
  }, [agents]);

  useEffect(() => {
    return hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'agent_spawned') {
        const normalizedAgent = normalizeLiveAgent(msg.agent as Partial<LiveAgentData> & Record<string, unknown>);
        setAgents((prev) => [normalizedAgent, ...prev.filter((agent) => agent.id !== normalizedAgent.id)]);
      } else if (msg.type === 'agent_output') {
        setAgents((prev) =>
          prev.map((agent) =>
            agent.id === msg.agentId
              ? { ...agent, output: ((agent.output || '') + msg.chunk).slice(-50000) }
              : agent,
          ),
        );
        const el = outputRefs.current.get(msg.agentId);
        if (el) el.scrollTop = el.scrollHeight;
      } else if (msg.type === 'agent_complete') {
        void load();
      } else if (msg.type === 'agent_removed') {
        setAgents((prev) => prev.filter((agent) => agent.id !== msg.agentId));
        setExpandedId((prev) => (prev === msg.agentId ? null : prev));
        setShowOutputId((prev) => (prev === msg.agentId ? null : prev));
        setMessageDrafts((prev) => {
          if (!(msg.agentId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.agentId];
          return next;
        });
        setAgentEvents((prev) => {
          if (!(msg.agentId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.agentId];
          return next;
        });
      } else if (msg.type === 'agent_session_linked') {
        setAgents((prev) =>
          prev.map((agent) =>
            agent.id === msg.agentId ? { ...agent, sessionId: normalizeSessionId(msg.sessionId) } : agent,
          ),
        );
      } else if (msg.type === 'agent_stats') {
        setAgents((prev) =>
          prev.map((agent) =>
            agent.id === msg.agentId
              ? {
                  ...agent,
                  driftScore: msg.drift,
                  costUsd: msg.cost,
                  actionCount: msg.actions,
                }
              : agent,
          ),
        );
      }
    });
  }, [load]);

  const pollingKey = useMemo(
    () =>
      agents
        .map((agent) => {
          const sessionId = normalizeSessionId(agent.sessionId);
          return sessionId ? `${agent.id}:${sessionId}` : null;
        })
        .filter((value): value is string => Boolean(value))
        .sort()
        .join('|'),
    [agents],
  );

  useEffect(() => {
    const trackedAgents = pollingTargetsRef.current;
    if (trackedAgents.length === 0) return;

    let cancelled = false;

    const fetchEvents = async () => {
      for (const agent of trackedAgents) {
        try {
          const events = await api.getAgentEvents(agent.id, 10);
          if (cancelled) return;
          setAgentEvents((prev) => ({ ...prev, [agent.id]: events }));
        } catch {
          // Ignore intermittent poll failures for the live feed.
        }
      }
    };

    void fetchEvents();
    const interval = window.setInterval(() => {
      void fetchEvents();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pollingKey]);

  useEffect(() => {
    if (!agents.some((agent) => agent.status === 'running')) return;
    const interval = window.setInterval(() => {
      setClockTick((tick) => tick + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [agents]);

  useEffect(() => {
    if (!showOutputId) return;
    const el = outputRefs.current.get(showOutputId);
    if (el) el.scrollTop = el.scrollHeight;
  }, [showOutputId, agents]);

  const selectedCommand = getCommandOption(command);
  const selectedRole = getRoleOption(role);

  const suggestedName = useMemo(() => {
    const starter = QUICK_STARTS.find((option) => option.id === selectedStarterId);
    const prefix = starter?.namePrefix || `${role}-${command}`;
    return `${prefix}-${agents.length + 1}`;
  }, [selectedStarterId, role, command, agents.length]);

  const searchValue = searchQuery.trim().toLowerCase();

  const sortedAgents = useMemo(() => {
    const statusOrder: Record<LiveAgentData['status'], number> = {
      running: 0,
      failed: 1,
      completed: 2,
    };

    return [...agents].sort((left, right) => {
      const leftOrder = statusOrder[left.status];
      const rightOrder = statusOrder[right.status];
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;

      const leftTime = new Date(left.finishedAt || left.startedAt).getTime();
      const rightTime = new Date(right.finishedAt || right.startedAt).getTime();
      return rightTime - leftTime;
    });
  }, [agents]);

  const visibleAgents = useMemo(() => {
    return sortedAgents.filter((agent) => {
      if (filter !== 'all' && agent.status !== filter) return false;
      if (!searchValue) return true;

      const haystack = [
        agent.name,
        agent.command,
        agent.role,
        agent.prompt,
        agent.personality,
        normalizeSessionId(agent.sessionId) || '',
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(searchValue);
    });
  }, [sortedAgents, filter, searchValue]);

  const runningCount = agents.filter((agent) => agent.status === 'running').length;
  const completedCount = agents.filter((agent) => agent.status === 'completed').length;
  const failedCount = agents.filter((agent) => agent.status === 'failed').length;
  const linkedSessionCount = new Set(
    agents
      .map((agent) => normalizeSessionId(agent.sessionId))
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  ).size;
  const totalActions = agents.reduce((total, agent) => total + (agent.actionCount || 0), 0);
  const totalCost = agents.reduce((total, agent) => total + (agent.costUsd || 0), 0);
  const lowDriftCount = agents.filter(
    (agent) => agent.driftScore !== null && agent.driftScore < 40,
  ).length;

  const filterCounts: Record<AgentStatusFilter, number> = {
    all: agents.length,
    running: runningCount,
    failed: failedCount,
    completed: completedCount,
  };

  const launchAgent = useCallback(async () => {
    if (!prompt.trim() || submitting) return;

    const resolvedName = name.trim() || suggestedName;

    setSubmitting(true);
    try {
      await api.spawnAgent(
        resolvedName,
        command,
        prompt.trim(),
        role,
        personality.trim(),
        permissions,
      );
      setNotice({
        type: 'success',
        text: `${resolvedName} is launching. Live telemetry will appear here as soon as the runtime attaches.`,
      });
      setName('');
      setPrompt('');
      setPersonality('');
      setSelectedStarterId(null);
      setShowAdvanced(false);
    } catch (err) {
      console.error('Spawn failed:', err);
      setNotice({
        type: 'error',
        text: 'Unable to launch the agent. Check the runtime command and try again.',
      });
    } finally {
      setSubmitting(false);
    }
  }, [command, name, permissions, personality, prompt, role, submitting, suggestedName]);

  const handleSpawnSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void launchAgent();
    },
    [launchAgent],
  );

  const applyQuickStart = useCallback(
    (starter: QuickStart) => {
      setSelectedStarterId(starter.id);
      setCommand(starter.command);
      setRole(starter.role);
      setPrompt(starter.prompt);
      setPersonality(starter.personality);
      setShowAdvanced(Boolean(starter.personality));
      if (!name.trim()) {
        setName(`${starter.namePrefix}-${agents.length + 1}`);
      }
    },
    [agents.length, name],
  );

  const handleStop = useCallback(
    async (id: string) => {
      setActingAgentId(id);
      try {
        await api.stopAgent(id);
        setNotice({ type: 'success', text: 'Stop signal sent to the agent.' });
        await load();
      } catch {
        setNotice({ type: 'error', text: 'Unable to stop that agent right now.' });
      } finally {
        setActingAgentId(null);
      }
    },
    [load],
  );

  const handleRemove = useCallback(async (id: string) => {
    setActingAgentId(id);
    try {
      await api.removeAgent(id);
      setNotice({ type: 'success', text: 'Agent removed from the board.' });
    } catch {
      setNotice({ type: 'error', text: 'Unable to remove that agent right now.' });
    } finally {
      setActingAgentId(null);
    }
  }, []);

  const handleSendMessage = useCallback(
    async (id: string) => {
      const message = messageDrafts[id]?.trim();
      if (!message || sendingMessageId) return;

      setSendingMessageId(id);
      try {
        await api.sendAgentMessage(id, message);
        setMessageDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setExpandedId(null);
        setNotice({ type: 'success', text: 'Follow-up instruction sent.' });
        await load();
      } catch (err) {
        console.error('Send message failed:', err);
        setNotice({ type: 'error', text: 'Unable to send that follow-up right now.' });
      } finally {
        setSendingMessageId(null);
      }
    },
    [load, messageDrafts, sendingMessageId],
  );

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/70 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-16 top-0 h-56 w-56 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute right-[-40px] top-10 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="absolute bottom-[-70px] left-1/3 h-56 w-56 rounded-full bg-emerald-400/10 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
                Agents Control Room
              </div>
              <div className="max-w-2xl">
                <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
                  Launch specialists, steer them live, and keep the whole room legible.
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-hawk-text2">
                  The page now treats agent creation as a real workflow: choose a runtime, frame the mission,
                  apply a starter kit if you want one, then watch the roster without losing the thread.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
              <SummaryCard
                label="Live Now"
                value={String(runningCount)}
                hint={`${linkedSessionCount} linked session${linkedSessionCount === 1 ? '' : 's'}`}
                toneClass="text-cyan-600 dark:text-cyan-400"
              />
              <SummaryCard
                label="Needs Attention"
                value={String(Math.max(failedCount, lowDriftCount))}
                hint={`${failedCount} failed, ${lowDriftCount} low-drift`}
                toneClass={
                  failedCount > 0 || lowDriftCount > 0
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-hawk-text'
                }
              />
              <SummaryCard
                label="Action Volume"
                value={formatCount(totalActions)}
                hint={`${agents.length} tracked agent${agents.length === 1 ? '' : 's'}`}
                toneClass="text-hawk-text"
              />
              <SummaryCard
                label="Spend"
                value={formatMoney(totalCost)}
                hint={`${completedCount} finished so far`}
                toneClass="text-hawk-orange"
              />
            </div>

            <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    What Changed
                  </div>
                  <div className="mt-2 text-sm text-hawk-text2">
                    Agent creation is guided now. The roster is also easier to scan, filter, and control when several runs are happening in parallel.
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-hawk-text2">
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-3 py-1">
                    Guardrails active
                  </span>
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-3 py-1">
                    DriftDetect streaming
                  </span>
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-3 py-1">
                    Follow-ups preserved
                  </span>
                </div>
              </div>
            </div>
          </div>

          <form
            onSubmit={handleSpawnSubmit}
            className="relative overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface via-hawk-surface2/92 to-hawk-bg/82 p-3 shadow-[0_24px_60px_-40px_rgba(0,0,0,0.72)]"
          >
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute -right-12 top-0 h-36 w-36 rounded-full bg-hawk-orange/10 blur-3xl" />
              <div className="absolute -left-8 bottom-0 h-28 w-28 rounded-full bg-cyan-500/10 blur-3xl" />
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-hawk-border to-transparent" />
            </div>

            <div className="relative flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Launch Studio
                </div>
                <h2 className="mt-1.5 font-display text-lg font-semibold text-hawk-text">Add an agent with intent</h2>
              </div>
              <div className="rounded-full border border-hawk-border-subtle bg-hawk-surface/70 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                Cmd/Ctrl + Enter
              </div>
            </div>

            <div className="relative mt-4 space-y-4">
              <div>
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Starter Kits
                </div>
                <div className="grid gap-2 grid-cols-2">
                  {QUICK_STARTS.map((starter) => {
                    const isSelected = selectedStarterId === starter.id;
                    return (
                      <button
                        key={starter.id}
                        type="button"
                        onClick={() => applyQuickStart(starter)}
                        className={`rounded-[16px] border p-2 text-left transition-all ${
                          isSelected
                            ? 'border-hawk-orange/30 bg-hawk-orange/10 shadow-[0_18px_40px_-30px_rgba(255,95,31,0.9)]'
                            : 'border-hawk-border-subtle bg-hawk-bg/50 hover:border-hawk-border hover:bg-hawk-bg/80'
                        }`}
                      >
                        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                          {starter.kicker}
                        </div>
                        <div className="mt-1 text-xs font-semibold text-hawk-text sm:text-sm">{starter.label}</div>
                        <div className="mt-1 text-[11px] leading-4 text-hawk-text2 sm:text-xs sm:leading-5">{starter.summary}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Mission
                </div>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Describe exactly what this agent should own, what good looks like, and what constraints it should respect."
                  rows={4}
                  className="w-full resize-none rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/60 px-3.5 py-2.5 text-sm leading-6 text-hawk-text placeholder:text-hawk-text3/45 focus:border-hawk-orange/50 focus:outline-none focus:ring-1 focus:ring-hawk-orange/20"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void launchAgent();
                    }
                  }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-hawk-text2">
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1">
                    Be explicit about success criteria
                  </span>
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1">
                    Keep the scope narrow when possible
                  </span>
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1">
                    Mention tests or checks if you want verification
                  </span>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[1fr_0.95fr]">
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Runtime
                  </div>
                  <div className="space-y-2">
                    {COMMAND_OPTIONS.map((option) => {
                      const isSelected = command === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setCommand(option.value)}
                          className={`w-full rounded-[16px] border bg-gradient-to-br p-2 text-left transition-all ${
                            isSelected
                              ? `${option.borderClass} ${option.surfaceClass} shadow-[0_18px_40px_-30px_rgba(0,0,0,0.95)]`
                              : 'border-hawk-border-subtle from-hawk-bg/40 via-hawk-bg/25 to-transparent hover:border-hawk-border'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className={`font-mono text-[10px] uppercase tracking-[0.16em] ${option.badgeClass}`}>
                                {option.kicker}
                              </div>
                              <div className="mt-1 text-sm font-semibold text-hawk-text">{option.label}</div>
                            </div>
                            {isSelected && (
                              <span className="rounded-full border border-hawk-orange/25 bg-hawk-orange/10 px-2 py-0.5 font-mono text-[10px] text-hawk-orange">
                                active
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 text-[11px] leading-4 text-hawk-text2 sm:text-xs sm:leading-5">{option.summary}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Role
                  </div>
                  <div className="space-y-2">
                    {ROLE_OPTIONS.map((option) => {
                      const isSelected = role === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setRole(option.value)}
                          className={`w-full rounded-[16px] border bg-gradient-to-br p-2 text-left transition-all ${
                            isSelected
                              ? `${option.borderClass} ${option.surfaceClass} shadow-[0_18px_40px_-30px_rgba(0,0,0,0.95)]`
                              : 'border-hawk-border-subtle from-hawk-bg/40 via-hawk-bg/25 to-transparent hover:border-hawk-border'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${option.badgeClass}`}>
                              {option.label}
                            </div>
                            {isSelected && (
                              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                                selected
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 text-[11px] leading-4 text-hawk-text2 sm:text-xs sm:leading-5">{option.summary}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Permissions
                  </div>
                  <div className="space-y-2">
                    {([
                      { value: 'full' as const, label: 'Full Access', summary: 'Agent can read and write any file without asking. Best for trusted tasks.', badgeClass: 'text-green-500', borderClass: 'border-green-500/30', surfaceClass: 'from-green-500/20 via-green-500/7 to-transparent' },
                      { value: 'supervised' as const, label: 'Supervised', summary: 'Hawkeye guardrails control dangerous actions. Agent works within policy rules.', badgeClass: 'text-amber-500', borderClass: 'border-amber-500/30', surfaceClass: 'from-amber-500/20 via-amber-500/7 to-transparent' },
                      { value: 'default' as const, label: 'Restricted', summary: 'Agent uses default runtime permissions. May fail on writes if not pre-approved.', badgeClass: 'text-red-400', borderClass: 'border-red-500/30', surfaceClass: 'from-red-500/20 via-red-500/7 to-transparent' },
                    ]).map((option) => {
                      const isSelected = permissions === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setPermissions(option.value)}
                          className={`w-full rounded-[16px] border bg-gradient-to-br p-2 text-left transition-all ${
                            isSelected
                              ? `${option.borderClass} ${option.surfaceClass} shadow-[0_18px_40px_-30px_rgba(0,0,0,0.95)]`
                              : 'border-hawk-border-subtle from-hawk-bg/40 via-hawk-bg/25 to-transparent hover:border-hawk-border'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${option.badgeClass}`}>
                              {option.label}
                            </div>
                            {isSelected && (
                              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                                selected
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 text-[11px] leading-4 text-hawk-text2 sm:text-xs sm:leading-5">{option.summary}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Name
                  </div>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={suggestedName}
                    className="w-full rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/60 px-3.5 py-2.5 text-sm text-hawk-text placeholder:text-hawk-text3/45 focus:border-hawk-orange/50 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((current) => !current)}
                  className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
                >
                  {showAdvanced ? 'Hide Briefing' : 'Add Briefing'}
                </button>
              </div>

              {showAdvanced && (
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Operating Brief
                  </div>
                  <textarea
                    value={personality}
                    onChange={(event) => setPersonality(event.target.value)}
                    placeholder="Optional: tone, coding style, verification level, or constraints you want this agent to keep in mind."
                    rows={3}
                    className="w-full resize-none rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/60 px-3.5 py-2.5 text-sm leading-6 text-hawk-text placeholder:text-hawk-text3/45 focus:border-hawk-orange/50 focus:outline-none"
                  />
                </div>
              )}

              {notice && (
                <div
                  className={`rounded-[18px] border px-3 py-2.5 text-sm ${
                    notice.type === 'success'
                      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                      : 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300'
                  }`}
                >
                  {notice.text}
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/60 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Launch Preview
                  </div>
                  <div className="mt-1 text-sm font-semibold text-hawk-text">
                    {(name.trim() || suggestedName)} with {selectedCommand.label} as {selectedRole.label}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-hawk-text2">
                    {selectedCommand.detail}
                    {permissions === 'full' && ' · Full file access granted.'}
                    {permissions === 'supervised' && ' · Guardrails will control dangerous actions.'}
                    {permissions === 'default' && ' · Default permissions — may need manual approval.'}
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={!prompt.trim() || submitting}
                  className="inline-flex shrink-0 items-center justify-center rounded-[18px] bg-hawk-orange px-4 py-2.5 text-sm font-semibold text-black transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? 'Launching...' : 'Launch Agent'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>

      <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/60 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative min-w-[240px] flex-1 sm:max-w-md">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by name, runtime, mission, or session id"
                className="w-full rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/55 px-4 py-2.5 pl-11 text-sm text-hawk-text placeholder:text-hawk-text3/45 focus:border-hawk-orange/50 focus:outline-none"
              />
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-hawk-text3"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>

            <div className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map((option) => {
                const isSelected = filter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setFilter(option.id)}
                    className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                      isSelected
                        ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                        : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                    }`}
                  >
                    {option.label} <span className="ml-1 text-hawk-text2">{filterCounts[option.id]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {(filter !== 'all' || searchQuery.trim()) && (
            <button
              type="button"
              onClick={() => {
                setFilter('all');
                setSearchQuery('');
              }}
              className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-hawk-text2">
          <span>
            Showing <span className="font-semibold text-hawk-text">{visibleAgents.length}</span> of{' '}
            <span className="font-semibold text-hawk-text">{agents.length}</span> agents
          </span>
          <span className="hidden h-1 w-1 rounded-full bg-hawk-border sm:inline-block" />
          <span>{runningCount > 0 ? `${runningCount} still live` : 'No live runs right now'}</span>
        </div>
      </section>

      {loading ? (
        <div className="rounded-[24px] border border-hawk-border-subtle bg-hawk-surface/60 py-20 text-center font-mono text-sm text-hawk-text3">
          Loading agents...
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-[24px] border border-dashed border-hawk-border-subtle bg-hawk-surface/50 px-6 py-20 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[20px] border border-hawk-border-subtle bg-hawk-bg/55 font-display text-2xl text-hawk-orange">
            A
          </div>
          <h3 className="mt-4 font-display text-2xl font-semibold text-hawk-text">No agents on the board yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-hawk-text2">
            Start from the launch studio above. Pick a starter kit if you want a clean first prompt, then launch your first specialist.
          </p>
        </div>
      ) : visibleAgents.length === 0 ? (
        <div className="rounded-[24px] border border-hawk-border-subtle bg-hawk-surface/50 px-6 py-16 text-center">
          <h3 className="font-display text-xl font-semibold text-hawk-text">Nothing matches the current view</h3>
          <p className="mt-2 text-sm text-hawk-text2">
            Try a broader search or reset the status filter to bring more agents back into view.
          </p>
        </div>
      ) : (
        <div className="grid gap-3.5 xl:grid-cols-2">
      {visibleAgents.map((agent) => {
            const commandOption = getCommandOption(agent.command);
            const roleOption = getRoleOption(agent.role);
            const sessionId = normalizeSessionId(agent.sessionId);
            const isRunning = agent.status === 'running';
            const isExpanded = expandedId === agent.id;
            const showingOutput = showOutputId === agent.id;
            const color = agentColor(agent.command);
            const events = agentEvents[agent.id] || [];
            const output = agent.output || '';
            const outputPreview = getOutputPreview(output);
            const messageDraft = messageDrafts[agent.id] || '';
            const durationLabel = isRunning
              ? `Live for ${timeAgo(agent.startedAt)}`
              : `Ran for ${formatDuration(agent.startedAt, agent.finishedAt)}`;
            const statusBadgeClass =
              agent.status === 'running'
                ? 'text-cyan-600 dark:text-cyan-300 bg-cyan-500/10 border-cyan-500/20'
                : agent.status === 'completed'
                  ? 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
                  : 'text-red-500 dark:text-red-300 bg-red-500/10 border-red-500/20';

            return (
              <article
                key={agent.id}
                className={`relative overflow-hidden rounded-[20px] border bg-hawk-surface/75 shadow-[0_20px_48px_-38px_rgba(0,0,0,1)] transition-all max-h-[540px] flex flex-col ${
                  isRunning
                    ? 'border-cyan-500/25'
                    : agent.status === 'failed'
                      ? 'border-red-500/25'
                      : 'border-hawk-border-subtle'
                }`}
              >
                <div className="pointer-events-none absolute inset-0">
                  <div
                    className="absolute -right-12 top-0 h-44 w-44 rounded-full blur-3xl"
                    style={{ backgroundColor: `${color}16` }}
                  />
                  <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
                </div>

                <div className="relative p-3 overflow-y-auto flex-1 min-h-0">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 gap-3">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] text-sm font-bold text-black ${
                          isRunning ? 'animate-pulse' : ''
                        }`}
                        style={{
                          backgroundColor: color,
                          boxShadow: isRunning ? `0 0 22px ${color}35` : 'none',
                        }}
                      >
                        {agent.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-base font-semibold text-hawk-text sm:text-lg">{agent.name}</h3>
                          <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${statusBadgeClass}`}>
                            {agent.status}
                          </span>
                          <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${roleOption.badgeClass}`}>
                            {roleOption.label}
                          </span>
                          <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${commandOption.borderClass} ${commandOption.badgeClass}`}>
                            {commandOption.label}
                          </span>
                          {agent.permissions === 'full' && (
                            <span className="rounded-full border border-green-500/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-green-500">
                              Full Access
                            </span>
                          )}
                          {agent.permissions === 'supervised' && (
                            <span className="rounded-full border border-amber-500/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-500">
                              Supervised
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 max-w-2xl text-sm leading-5 text-hawk-text2 line-clamp-3">
                          {agent.prompt.length > 200 ? agent.prompt.slice(0, 200) + '...' : agent.prompt}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-hawk-text2">
                          <span>Started {formatClock(agent.startedAt)}</span>
                          <span className="h-1 w-1 rounded-full bg-hawk-border" />
                          <span>{durationLabel}</span>
                          {agent.pid && (
                            <>
                              <span className="h-1 w-1 rounded-full bg-hawk-border" />
                              <span>PID {agent.pid}</span>
                            </>
                          )}
                          {agent.exitCode !== null && !isRunning && (
                            <>
                              <span className="h-1 w-1 rounded-full bg-hawk-border" />
                              <span>Exit {agent.exitCode}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {isRunning ? (
                        <button
                          type="button"
                          onClick={() => void handleStop(agent.id)}
                          disabled={actingAgentId === agent.id}
                          className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-red-600 transition-colors hover:bg-red-500/15 dark:text-red-300 disabled:opacity-50"
                        >
                          {actingAgentId === agent.id ? 'Stopping...' : 'Stop'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleRemove(agent.id)}
                          disabled={actingAgentId === agent.id}
                          className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-red-500/25 hover:text-red-500 dark:hover:text-red-300 disabled:opacity-50"
                        >
                          {actingAgentId === agent.id ? 'Removing...' : 'Remove'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
                    <AgentMetric
                      label="Drift"
                      value={agent.driftScore !== null ? String(agent.driftScore) : '--'}
                      hint={agent.driftScore !== null ? 'Current score' : 'No signal yet'}
                      toneClass={driftColor(agent.driftScore)}
                    />
                    <AgentMetric
                      label="Cost"
                      value={formatMoney(agent.costUsd || 0)}
                      hint="Accumulated spend"
                    />
                    <AgentMetric
                      label="Actions"
                      value={String(agent.actionCount || 0)}
                      hint="Tracked operations"
                    />
                    <AgentMetric
                      label="Session"
                      value={sessionId ? 'Linked' : 'Pending'}
                      hint={sessionId ? sessionId.slice(0, 8) : 'Waiting for session link'}
                      toneClass={sessionId ? 'text-hawk-orange' : 'text-hawk-text'}
                    />
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-[1.05fr_0.95fr]">
                    <div className="space-y-3">
                      {agent.personality && (
                        <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                            Operating Brief
                          </div>
                          <p className="mt-2 text-sm leading-5 text-hawk-text2">{agent.personality}</p>
                        </section>
                      )}

                      {agent.filesChanged?.length > 0 && (
                        <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                              Files Touched
                            </div>
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-emerald-600 dark:text-emerald-400">+{agent.linesAdded}</span>
                              <span className="text-red-500 dark:text-red-400">-{agent.linesRemoved}</span>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {agent.filesChanged.slice(0, 6).map((filePath) => (
                              <span
                                key={filePath}
                                className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-2.5 py-1 text-[10px] text-hawk-text2"
                              >
                                {filePath.split('/').pop()}
                              </span>
                            ))}
                            {agent.filesChanged.length > 6 && (
                              <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-2.5 py-1 text-[10px] text-hawk-text3">
                                +{agent.filesChanged.length - 6} more
                              </span>
                            )}
                          </div>
                        </section>
                      )}

                      {outputPreview && !showingOutput && (
                        <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/72 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                            Terminal Tail
                          </div>
                          <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-5 text-hawk-text2">
                            {outputPreview}
                          </pre>
                        </section>
                      )}
                    </div>

                    <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                          Recent Activity
                        </div>
                        {sessionId && (
                          <Link
                            to={`/session/${sessionId}`}
                            className="font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-orange transition-colors hover:text-hawk-text"
                          >
                            Open session
                          </Link>
                        )}
                      </div>

                      {events.length === 0 ? (
                        <div className="mt-3 rounded-[16px] border border-dashed border-hawk-border-subtle bg-hawk-surface/40 px-3 py-5 text-sm text-hawk-text3">
                          {isRunning
                            ? 'Waiting for the first traced action to land.'
                            : 'No recent traced activity was recorded for this agent.'}
                        </div>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {events.slice(-8).map((event, index) => (
                            <div
                              key={event.id || index}
                              className="flex items-start gap-2.5 rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/35 px-2.5 py-2"
                            >
                              <div className={`mt-0.5 font-mono text-xs ${eventColor(event.type)}`}>
                                {eventIcon(event.type)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs text-hawk-text2 sm:text-sm">
                                  {parseEventSummary(event)}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                                  <span>{event.type}</span>
                                  <span>{timeAgo(event.timestamp)} ago</span>
                                </div>
                              </div>
                              {event.drift_score !== null && (
                                <div className={`font-mono text-[11px] ${driftColor(event.drift_score)}`}>
                                  {event.drift_score}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hawk-border-subtle pt-3">
                    {output && (
                      <button
                        type="button"
                        onClick={() => setShowOutputId(showingOutput ? null : agent.id)}
                        className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                          showingOutput
                            ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                            : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                        }`}
                      >
                        {showingOutput ? 'Hide tail' : 'Show tail'}
                      </button>
                    )}

                    {!isRunning && (
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedId(isExpanded ? null : agent.id);
                        }}
                        className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                          isExpanded
                            ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                            : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                        }`}
                      >
                        {isExpanded ? 'Close follow-up' : 'Send follow-up'}
                      </button>
                    )}

                    {sessionId && (
                      <Link
                        to={`/session/${sessionId}`}
                        className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
                      >
                        Full session
                      </Link>
                    )}
                  </div>

                  {showingOutput && output && (
                    <section className="mt-3 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/72 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                        Raw Output
                      </div>
                      <pre
                        ref={(element) => {
                          if (element) outputRefs.current.set(agent.id, element);
                        }}
                        className="max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-hawk-text2"
                      >
                        {output.slice(-9000)}
                      </pre>
                    </section>
                  )}

                  {isExpanded && !isRunning && (
                    <section className="mt-3 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                        Follow-up Instruction
                      </div>
                      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                        <input
                          value={messageDraft}
                          onChange={(event) =>
                            setMessageDrafts((prev) => ({
                              ...prev,
                              [agent.id]: event.target.value,
                            }))
                          }
                          placeholder="Ask for a refinement, redirect the task, or request a tighter review pass."
                          className="flex-1 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/60 px-3.5 py-2.5 text-sm text-hawk-text placeholder:text-hawk-text3/45 focus:border-hawk-orange/50 focus:outline-none"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void handleSendMessage(agent.id);
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void handleSendMessage(agent.id)}
                          disabled={!messageDraft.trim() || sendingMessageId === agent.id}
                          className="rounded-[18px] bg-hawk-orange px-4 py-2.5 text-sm font-semibold text-black transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {sendingMessageId === agent.id ? 'Sending...' : 'Send'}
                        </button>
                      </div>
                    </section>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
