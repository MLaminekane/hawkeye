import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api, hawkeyeWs, type EventData } from '../api';

// ── Types ──

type Risk = 'safe' | 'low' | 'medium' | 'high' | 'critical';
type FilterKey = 'all' | 'risky' | 'blocked' | 'writes' | 'commands';

interface ActionItem {
  id: string;
  timestamp: string;
  type: string;
  risk: Risk;
  summary: string;
  details: string[];
  toolName: string;
  sessionId: string;
  status: 'allowed' | 'warned' | 'blocked' | 'pending';
  cost: number;
  raw?: Record<string, unknown>;
}

// ── Constants ──

const RISK_DOT: Record<Risk, string> = {
  safe: 'bg-hawk-green',
  low: 'bg-hawk-green',
  medium: 'bg-yellow-400',
  high: 'bg-orange-400',
  critical: 'bg-red-400',
};

const RISK_BADGE: Record<Risk, string> = {
  safe: 'text-hawk-green/70 bg-hawk-green/5 border-hawk-green/20',
  low: 'text-hawk-green bg-hawk-green/10 border-hawk-green/20',
  medium: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  high: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  critical: 'text-red-400 bg-red-400/10 border-red-400/20',
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  allowed: { label: 'OK', cls: 'text-hawk-green/70 bg-hawk-green/5' },
  warned: { label: 'WARN', cls: 'text-orange-400 bg-orange-400/10' },
  blocked: { label: 'BLOCKED', cls: 'text-red-400 bg-red-400/10 font-bold' },
  pending: { label: 'PENDING', cls: 'text-yellow-400 bg-yellow-400/10 animate-pulse' },
};

const TYPE_ICONS: Record<string, string> = {
  command: '$',
  file_write: '\u270E',
  file_read: '\u2630',
  file_delete: '\u2212',
  file_rename: '\u21C4',
  llm_call: '\u2728',
  git_commit: '\u2714',
  git_push: '\u2B06',
  git_pull: '\u2B07',
  git_checkout: '\u2934',
  git_merge: '\u2A2F',
  error: '\u2717',
  guardrail_block: '\u26D4',
  guardrail_trigger: '\u26A0',
  impact_preview: '\u25C8',
  review_gate: '\u231B',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) return 'unknown';
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const visible = Math.max(6, maxLength - 3);
  const front = Math.ceil(visible / 2);
  const back = Math.floor(visible / 2);
  return `${value.slice(0, front)}...${value.slice(-back)}`;
}

function formatCurrency(amount: number): string {
  if (amount <= 0) return '$0.0000';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function summarizeCounts(items: ActionItem[]) {
  return {
    total: items.length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    pending: items.filter((item) => item.status === 'pending').length,
  };
}

function getFilterLabel(filter: FilterKey): string {
  if (filter === 'all') return 'All activity';
  if (filter === 'risky') return 'Risky only';
  if (filter === 'blocked') return 'Blocked / pending';
  if (filter === 'writes') return 'Mutations';
  return 'Commands';
}

function getActionHighlights(raw?: Record<string, unknown>) {
  if (!raw) return [];

  const candidates: Array<[string, unknown]> = [
    ['Path', raw.path],
    ['Rule', raw.ruleName],
    ['Model', raw.model],
    ['Branch', raw.branch],
    ['Action', raw.actionTaken || raw.action],
    ['Exit', raw.exitCode],
  ];

  return candidates
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .slice(0, 4)
    .map(([label, value]) => ({
      label,
      value: label === 'Path' ? truncateMiddle(String(value), 42) : String(value).slice(0, 48),
    }));
}

function parseEventToAction(event: EventData, risk: Risk, sessionId: string): ActionItem {
  let data: Record<string, unknown> = {};
  try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch {}

  const type = event.type;
  let summary: string;
  let toolName = type;
  const details: string[] = [];
  let status: ActionItem['status'] = 'allowed';

  if (type === 'command') {
    toolName = 'Bash';
    const command = String(data.command || '');
    const args = Array.isArray(data.args) ? data.args.map(String).join(' ') : '';
    summary = `${command}${args ? ` ${args}` : ''}`.slice(0, 150);
    if (data.exitCode && data.exitCode !== 0) {
      details.push(`Exit code: ${data.exitCode}`);
      status = 'warned';
    }
  } else if (type === 'file_write') {
    toolName = data.action === 'write' ? 'Write' : data.action === 'append' ? 'Append' : 'Edit';
    const path = String(data.path || '');
    const name = path.split('/').pop() || path;
    if (data.linesAdded || data.linesRemoved) {
      summary = `${name} (+${data.linesAdded || 0}/-${data.linesRemoved || 0})`;
    } else {
      summary = name;
    }
    if (data.diff) details.push(String(data.diff).slice(0, 300));
  } else if (type === 'file_read') {
    toolName = 'Read';
    const path = String(data.path || '');
    summary = path.split('/').pop() || path;
  } else if (type === 'llm_call') {
    toolName = 'LLM';
    const tokens = Number(data.totalTokens || 0);
    const cost = Number(data.costUsd || event.cost_usd || 0);
    summary = `${String(data.model || 'unknown').split('/').pop()} — ${tokens.toLocaleString()} tokens`;
    if (cost > 0) details.push(`Cost: $${cost.toFixed(4)}`);
  } else if (type.startsWith('git_')) {
    toolName = 'Git';
    summary = `${String(data.operation || type.replace('git_', ''))}`;
    if (data.branch) summary += ` ${data.branch}`;
    if (data.message) summary += `: ${String(data.message).slice(0, 60)}`;
    if (data.commitHash) details.push(`Hash: ${String(data.commitHash).slice(0, 8)}`);
  } else if (type === 'error') {
    toolName = 'Error';
    summary = String(data.message || 'Unknown error').slice(0, 150);
    status = 'warned';
  } else if (type === 'guardrail_block' || type === 'guardrail_trigger') {
    toolName = 'Guardrail';
    summary = String(data.description || 'Action blocked').slice(0, 150);
    status = 'blocked';
    if (data.ruleName) details.push(`Rule: ${String(data.ruleName)}`);
    if (data.path) details.push(`Path: ${truncateMiddle(String(data.path), 72)}`);
    if (data.blockedAction) details.push(`Blocked action: ${String(data.blockedAction).slice(0, 120)}`);
    if (data.impactPreview) {
      const ip = data.impactPreview as Record<string, unknown>;
      if (Array.isArray(ip.details)) {
        for (const d of ip.details) details.push(String(d));
      }
    }
  } else {
    summary = type;
  }

  return {
    id: event.id,
    timestamp: event.timestamp,
    type,
    risk,
    summary,
    details,
    toolName,
    sessionId,
    status,
    cost: event.cost_usd || 0,
    raw: data,
  };
}

// ── Notification helper ──

let notifPermission: NotificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'denied';

function requestNotifPermission() {
  if (typeof Notification === 'undefined') return;
  if (notifPermission === 'default') {
    Notification.requestPermission().then((p) => { notifPermission = p; });
  }
}

function sendNotification(title: string, body: string) {
  if (notifPermission !== 'granted') return;
  try {
    new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: 'hawkeye-firewall',
      requireInteraction: true,
    });
  } catch {}
}

// ── Page Component ──

// Module-level state so navigating away and back preserves the feed
let cachedActions: ActionItem[] = [];
let cachedCounts = { total: 0, blocked: 0, pending: 0 };

export function InterceptionPage() {
  const [actions, setActions] = useState<ActionItem[]>(cachedActions);
  const [loading, setLoading] = useState(cachedActions.length === 0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [liveMode, setLiveMode] = useState(true);
  const [autoscroll, setAutoscroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const [counts, setCounts] = useState(cachedCounts);

  // Request notification permission on mount
  useEffect(() => { requestNotifPermission(); }, []);

  // Load initial blocks
  useEffect(() => {
    if (cachedActions.length > 0) { setLoading(false); return; }
    api.getInterceptions().then((data) => {
      const items: ActionItem[] = [];
      for (const block of data.blocks) {
        const parsed = parseEventToAction(block, 'critical', block.session_id);
        parsed.status = 'blocked';
        items.push(parsed);
      }
      for (const review of data.pendingReviews) {
        items.push({
          id: review.id,
          timestamp: review.timestamp,
          type: 'review_gate',
          risk: 'high',
          summary: `Review required: ${review.command.slice(0, 100)}`,
          details: [`Pattern: ${review.matchedPattern}`],
          toolName: 'Bash',
          sessionId: review.sessionId,
          status: 'pending',
          cost: 0,
        });
      }
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      cachedActions = items;
      cachedCounts = summarizeCounts(items);
      setActions(items);
      setCounts(cachedCounts);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // WebSocket: stream all actions
  useEffect(() => {
    if (!liveMode) return;

    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'action_stream') {
        const item = parseEventToAction(msg.event, msg.risk, msg.sessionId);
        setActions((prev) => {
          const next = [item, ...prev].slice(0, 500);
          cachedActions = next;
          const nextCounts = summarizeCounts(next);
          cachedCounts = nextCounts;
          setCounts(nextCounts);
          return next;
        });

        // Browser notification for blocked actions
        if (item.status === 'blocked' || item.risk === 'critical') {
          sendNotification(
            `Hawkeye: Action Blocked`,
            item.summary.slice(0, 100),
          );
        }

        // Auto-scroll
        if (autoscroll && listRef.current) {
          listRef.current.scrollTop = 0;
        }
      }

      if (msg.type === 'impact_preview') {
        const item: ActionItem = {
          id: `impact-${msg.timestamp}`,
          timestamp: msg.timestamp,
          type: 'impact_preview',
          risk: msg.impact.risk,
          summary: msg.impact.summary,
          details: msg.impact.details,
          toolName: msg.toolName,
          sessionId: msg.sessionId,
          status: msg.impact.risk === 'critical' ? 'blocked' : msg.impact.risk === 'high' ? 'warned' : 'allowed',
          cost: 0,
        };
        setActions((prev) => {
          const next = [item, ...prev].slice(0, 500);
          cachedActions = next;
          const nextCounts = summarizeCounts(next);
          cachedCounts = nextCounts;
          setCounts(nextCounts);
          return next;
        });

        if (msg.impact.risk === 'critical') {
          sendNotification('Hawkeye: Critical Risk Detected', msg.impact.summary.slice(0, 100));
        }
      }
    });

    return unsub;
  }, [liveMode, autoscroll]);

  const handleApprove = useCallback(async (id: string) => {
    try {
      await api.approveReview(id, 'session');
      setActions((prev) => {
        const next = prev.filter((i) => i.id !== id);
        cachedActions = next;
        const nextCounts = summarizeCounts(next);
        cachedCounts = nextCounts;
        setCounts(nextCounts);
        return next;
      });
    } catch {}
  }, []);

  const handleDeny = useCallback(async (id: string) => {
    try {
      await api.denyReview(id);
      setActions((prev) => {
        const next = prev.filter((i) => i.id !== id);
        cachedActions = next;
        const nextCounts = summarizeCounts(next);
        cachedCounts = nextCounts;
        setCounts(nextCounts);
        return next;
      });
    } catch {}
  }, []);

  const riskyCount = useMemo(
    () => actions.filter((item) => item.risk === 'high' || item.risk === 'critical' || item.status === 'pending').length,
    [actions],
  );
  const totalCost = useMemo(() => actions.reduce((sum, item) => sum + item.cost, 0), [actions]);
  const newestPriorityAction = useMemo(
    () => actions.find((item) => item.status === 'pending')
      || actions.find((item) => item.status === 'blocked')
      || actions.find((item) => item.risk === 'critical')
      || actions.find((item) => item.risk === 'high'),
    [actions],
  );
  const filterCounts = useMemo(
    () => ({
      all: actions.length,
      risky: actions.filter((item) => item.risk !== 'safe').length,
      blocked: actions.filter((item) => item.status === 'blocked' || item.status === 'pending').length,
      writes: actions.filter((item) => item.type === 'file_write' || item.type === 'file_delete' || item.type === 'file_rename' || item.type === 'command').length,
      commands: actions.filter((item) => item.type === 'command').length,
    }),
    [actions],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    return actions.filter((item) => {
      const matchesFilter =
        filter === 'all'
          ? true
          : filter === 'risky'
            ? item.risk !== 'safe'
            : filter === 'blocked'
              ? item.status === 'blocked' || item.status === 'pending'
              : filter === 'writes'
                ? item.type === 'file_write' || item.type === 'file_delete' || item.type === 'file_rename' || item.type === 'command'
                : item.type === 'command';

      if (!matchesFilter) return false;
      if (!query) return true;

      const searchable = [
        item.summary,
        item.toolName,
        item.type,
        item.sessionId,
        ...item.details,
      ].join(' ').toLowerCase();

      return searchable.includes(query);
    });
  }, [actions, filter, search]);

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-52 w-52 rounded-full bg-red-500/8 blur-3xl" />
          <div className="absolute right-[-30px] top-8 h-56 w-56 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute bottom-[-60px] left-1/3 h-52 w-52 rounded-full bg-yellow-400/8 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.04fr_0.96fr]">
          <div className="space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              <span className={`inline-block h-2 w-2 rounded-full ${liveMode ? 'bg-hawk-green' : 'bg-hawk-text3'}`} />
              Firewall
            </span>

            <div className="space-y-2">
              <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
                Agent Firewall
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-hawk-text2">
                Monitor agent actions in real time, flag risky operations, and manage review gates without leaving the dashboard.
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em]">
              <span className={`rounded-full border px-2.5 py-1 font-mono ${liveMode ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green' : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3'}`}>
                {liveMode ? 'Live monitoring' : 'Feed paused'}
              </span>
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-hawk-text2">
                Retention 500 events
              </span>
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-hawk-text2">
                Impact previews enabled
              </span>
            </div>

            {newestPriorityAction && (
              <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
                      Current hotspot
                    </div>
                    <p className="mt-2 text-sm text-hawk-text">
                      {newestPriorityAction.summary}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                      <span>{newestPriorityAction.toolName}</span>
                      <span>{shortSessionId(newestPriorityAction.sessionId)}</span>
                      <span>{formatTimestamp(newestPriorityAction.timestamp)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setFilter(newestPriorityAction.status === 'pending' || newestPriorityAction.status === 'blocked' ? 'blocked' : 'risky')}
                    className="shrink-0 rounded-[16px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-2 font-mono text-[11px] text-hawk-orange transition-colors hover:bg-hawk-orange/20"
                  >
                    Focus signal
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
              <button
                onClick={() => setAutoscroll(!autoscroll)}
                className={`rounded-[18px] border px-3 py-2 font-mono text-[11px] transition-all ${
                  autoscroll
                    ? 'border-hawk-orange/25 bg-hawk-orange/10 text-hawk-orange'
                    : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3'
                }`}
              >
                Auto-scroll {autoscroll ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => setLiveMode(!liveMode)}
                className={`flex items-center gap-1.5 rounded-[18px] border px-3 py-2 font-mono text-[11px] transition-all ${
                  liveMode
                    ? 'border-hawk-green/30 bg-hawk-green/10 text-hawk-green'
                    : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${liveMode ? 'bg-hawk-green animate-pulse' : 'bg-hawk-text3'}`} />
                {liveMode ? 'LIVE' : 'PAUSED'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <MetricCard label="Tracked actions" value={String(counts.total)} meta={`${filtered.length} shown`} />
              <MetricCard label="Blocked" value={String(counts.blocked)} meta="Hard stops" tone="danger" />
              <MetricCard label="Pending review" value={String(counts.pending)} meta="Needs decision" tone="warning" />
              <MetricCard label="Risky signals" value={String(riskyCount)} meta={formatCurrency(totalCost)} tone="accent" />
            </div>

            <div className="flex flex-wrap gap-2">
              <SignalPill label="Search" value={search ? `"${search}"` : 'off'} />
              <SignalPill label="Filter" value={getFilterLabel(filter)} />
              <SignalPill label="Latest" value={actions[0] ? timeAgo(actions[0].timestamp) : 'idle'} />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/70 p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-hawk-text">Threat feed controls</h2>
            <p className="mt-1 text-xs text-hawk-text2">
              Filter sensitive actions, inspect live sessions, and quickly isolate mutations or shell commands.
            </p>
          </div>

          <div className="w-full lg:max-w-md">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search command, file, rule, session..."
              className="w-full rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-2.5 font-mono text-xs text-hawk-text placeholder-hawk-text3 outline-none transition-colors focus:border-hawk-orange/40"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {(['all', 'risky', 'blocked', 'writes', 'commands'] as const).map((item) => (
            <FilterChip
              key={item}
              active={filter === item}
              label={getFilterLabel(item)}
              count={filterCounts[item]}
              onClick={() => setFilter(item)}
            />
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
        <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-base font-semibold text-hawk-text">Threat feed</h2>
              <p className="text-xs text-hawk-text2">
                Stream of actions observed by the firewall, with risk context and review gate decisions.
              </p>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
              {filtered.length} shown / {counts.total} tracked
            </span>
          </div>
        </div>

        <div ref={listRef} className="max-h-[68vh] space-y-2 overflow-auto p-2.5">
          {loading ? (
            <div className="py-16 text-center font-mono text-sm text-hawk-text3 animate-pulse">
              Loading firewall stream...
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState filter={filter} search={search} />
          ) : (
            filtered.map((item) => (
              <ActionRow
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onApprove={item.status === 'pending' ? () => handleApprove(item.id) : undefined}
                onDeny={item.status === 'pending' ? () => handleDeny(item.id) : undefined}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ──

function EmptyState({ filter, search }: { filter: FilterKey; search: string }) {
  return (
    <div className="rounded-[18px] border border-dashed border-hawk-border-subtle bg-hawk-bg/35 py-12 text-center">
      <div className="mb-3 text-3xl opacity-40">
        {search ? '\u2315' : filter === 'all' ? '\u26A1' : '\u2714'}
      </div>
      <p className="font-display text-base font-semibold text-hawk-text">
        {search ? 'No matching signals' : filter === 'all' ? 'Firewall standing by' : `No ${getFilterLabel(filter).toLowerCase()} yet`}
      </p>
      <p className="mt-2 font-mono text-xs text-hawk-text3">
        {search
          ? 'Try a broader query or switch filters to reopen the feed.'
          : filter === 'all'
            ? 'Start or resume a recording to populate the live action stream.'
            : 'The current filter is clean for now.'}
      </p>
    </div>
  );
}

function MetricCard({
  label,
  value,
  meta,
  tone = 'default',
}: {
  label: string;
  value: string;
  meta: string;
  tone?: 'default' | 'danger' | 'warning' | 'accent';
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-red-400'
      : tone === 'warning'
        ? 'text-yellow-400'
        : tone === 'accent'
          ? 'text-hawk-orange'
          : 'text-hawk-text';

  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/50 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text3">{meta}</div>
    </div>
  );
}

function SignalPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
      <span className="text-hawk-text3">{label}</span>
      <span className="text-hawk-text">{value}</span>
    </span>
  );
}

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-all ${
        active
          ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
          : 'border-hawk-border-subtle bg-hawk-bg/45 text-hawk-text3 hover:border-hawk-orange/20 hover:text-hawk-text'
      }`}
    >
      <span>{label}</span>
      <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${active ? 'bg-hawk-orange/10 text-hawk-orange' : 'bg-hawk-surface2 text-hawk-text2'}`}>
        {count}
      </span>
    </button>
  );
}

function ActionRow({
  item,
  expanded,
  onToggle,
  onApprove,
  onDeny,
}: {
  item: ActionItem;
  expanded: boolean;
  onToggle: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const isBlocked = item.status === 'blocked' || item.status === 'pending';
  const isElevated = isBlocked || item.risk === 'high' || item.risk === 'critical' || item.status === 'warned';
  const statusInfo = STATUS_BADGE[item.status];
  const icon = TYPE_ICONS[item.type] || '\u2022';
  const highlights = getActionHighlights(item.raw);

  const shellTone = isBlocked
    ? 'border-red-400/20 bg-red-400/[0.03]'
    : isElevated
      ? 'border-orange-400/20 bg-orange-400/[0.025]'
      : 'border-hawk-border-subtle bg-hawk-surface/58 hover:border-hawk-orange/20 hover:bg-hawk-surface/78';

  const iconTone = isBlocked
    ? 'border-red-400/20 bg-red-400/10 text-red-300'
    : isElevated
      ? 'border-orange-400/20 bg-orange-400/10 text-orange-300'
      : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3';

  return (
    <div className={`overflow-hidden rounded-[16px] border transition-all ${shellTone}`}>
      <button onClick={onToggle} className="w-full px-3 py-2.5 text-left">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex items-center pt-1">
              <span className={`inline-block h-2 w-2 rounded-full ${RISK_DOT[item.risk]} ${item.risk === 'critical' ? 'animate-pulse' : ''}`} />
            </div>

            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border ${iconTone}`}>
              <span className="font-mono text-[11px]">{icon}</span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                  {item.toolName}
                </span>
                {item.risk !== 'safe' && (
                  <span className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${RISK_BADGE[item.risk]}`}>
                    {item.risk}
                  </span>
                )}
                {item.status !== 'allowed' && (
                  <span className={`rounded-full px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${statusInfo.cls}`}>
                    {statusInfo.label}
                  </span>
                )}
              </div>

              <div className="mt-1.5 text-sm leading-5 text-hawk-text">
                {item.summary}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                <span>{item.type.replaceAll('_', ' ')}</span>
                <span>{shortSessionId(item.sessionId)}</span>
                <span>{formatTimestamp(item.timestamp)}</span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 self-end lg:self-start">
            {item.cost > 0 && (
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                {formatCurrency(item.cost)}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
              {timeAgo(item.timestamp)}
            </span>
            <span className="text-hawk-text3">{expanded ? '▾' : '▸'}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-hawk-border-subtle/60 px-3 py-2.5">
          <div className="grid gap-2.5 xl:grid-cols-[1.12fr_0.88fr]">
            <div className="space-y-2.5">
              <div className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Impact notes</div>
                {item.details.length > 0 ? (
                  <div className="mt-2 space-y-1.5">
                    {item.details.map((detail, index) => (
                      <div key={index} className="font-mono text-[11px] leading-5 text-hawk-text2">
                        <span className="text-hawk-text3">•</span> {detail}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 font-mono text-[11px] text-hawk-text3">
                    No extra impact notes were attached to this action.
                  </p>
                )}
              </div>

              {highlights.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {highlights.map((highlight) => (
                    <span
                      key={`${highlight.label}-${highlight.value}`}
                      className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2"
                    >
                      <span className="text-hawk-text3">{highlight.label}</span> {highlight.value}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Session context</div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-hawk-text">
                    {truncateMiddle(item.sessionId || 'unknown', 28)}
                  </span>
                  {item.sessionId && (
                    <Link
                      to={`/session/${item.sessionId}`}
                      className="rounded-[14px] border border-hawk-orange/30 bg-hawk-orange/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-orange transition-colors hover:bg-hawk-orange/20"
                    >
                      Open session
                    </Link>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                    Time {formatTimestamp(item.timestamp)}
                  </span>
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                    Type {item.type.replaceAll('_', ' ')}
                  </span>
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                    Status {statusInfo.label}
                  </span>
                </div>
              </div>

              {item.status === 'pending' && (
                <div className="rounded-[14px] border border-yellow-400/20 bg-yellow-400/5 p-2.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-yellow-400">Review gate</div>
                  <p className="mt-2 text-xs text-hawk-text2">
                    This action is waiting for an explicit decision before the session can continue.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={(event) => { event.stopPropagation(); onApprove?.(); }}
                      className="rounded-[14px] border border-hawk-green/30 bg-hawk-green/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-green hover:bg-hawk-green/20"
                    >
                      Approve
                    </button>
                    <button
                      onClick={(event) => { event.stopPropagation(); onDeny?.(); }}
                      className="rounded-[14px] border border-red-400/30 bg-red-400/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400 hover:bg-red-400/20"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
