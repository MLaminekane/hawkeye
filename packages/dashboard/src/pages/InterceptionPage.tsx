import { useEffect, useState, useRef, useCallback } from 'react';
import { api, hawkeyeWs, type EventData, type ImpactPreviewData } from '../api';

// ── Types ──

type Risk = 'safe' | 'low' | 'medium' | 'high' | 'critical';

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
  llm_call: '\u2728',
  git_commit: '\u2714',
  git_push: '\u2B06',
  git_pull: '\u2B07',
  git_checkout: '\u2934',
  git_merge: '\u2A2F',
  error: '\u2717',
  guardrail_block: '\u26D4',
  guardrail_trigger: '\u26A0',
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

function parseEventToAction(event: EventData, risk: Risk, sessionId: string): ActionItem {
  let data: Record<string, unknown> = {};
  try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch {}

  const type = event.type;
  let summary = '';
  let toolName = type;
  const details: string[] = [];
  let status: ActionItem['status'] = 'allowed';

  if (type === 'command') {
    toolName = 'Bash';
    const cmd = String(data.command || '').slice(0, 150);
    summary = cmd;
    if (data.exitCode && data.exitCode !== 0) {
      details.push(`Exit code: ${data.exitCode}`);
      status = 'warned';
    }
  } else if (type === 'file_write') {
    toolName = data.action === 'write' ? 'Write' : 'Edit';
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
  const [filter, setFilter] = useState<'all' | 'risky' | 'blocked' | 'writes' | 'commands'>('all');
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
      cachedCounts = { total: items.length, blocked: items.filter(i => i.status === 'blocked').length, pending: items.filter(i => i.status === 'pending').length };
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
          return next;
        });
        setCounts((prev) => {
          const next = {
            total: prev.total + 1,
            blocked: prev.blocked + (item.status === 'blocked' ? 1 : 0),
            pending: prev.pending + (item.status === 'pending' ? 1 : 0),
          };
          cachedCounts = next;
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
      setActions((prev) => prev.filter((i) => i.id !== id));
    } catch {}
  }, []);

  const handleDeny = useCallback(async (id: string) => {
    try {
      await api.denyReview(id);
      setActions((prev) => prev.filter((i) => i.id !== id));
    } catch {}
  }, []);

  // Filter
  const filtered = actions.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'risky') return item.risk !== 'safe';
    if (filter === 'blocked') return item.status === 'blocked' || item.status === 'pending';
    if (filter === 'writes') return item.type === 'file_write' || item.type === 'command';
    if (filter === 'commands') return item.type === 'command';
    return true;
  });

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold text-hawk-text">Firewall</h1>
          <p className="mt-0.5 font-mono text-xs text-hawk-text3">
            Real-time agent action stream with impact analysis
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoscroll(!autoscroll)}
            className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] transition-all ${
              autoscroll
                ? 'border-hawk-border-subtle bg-hawk-surface2 text-hawk-text'
                : 'border-hawk-border-subtle bg-hawk-surface text-hawk-text3'
            }`}
          >
            Auto-scroll {autoscroll ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[10px] transition-all ${
              liveMode
                ? 'border-hawk-green/30 bg-hawk-green/10 text-hawk-green'
                : 'border-hawk-border-subtle bg-hawk-surface text-hawk-text3'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${liveMode ? 'bg-hawk-green animate-pulse' : 'bg-hawk-text3'}`} />
            {liveMode ? 'LIVE' : 'PAUSED'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-hawk-border-subtle bg-hawk-surface/50 px-3 py-2">
          <div className="font-mono text-lg font-bold text-hawk-text">{counts.total}</div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-hawk-text3">Actions</div>
        </div>
        <div className="rounded-lg border border-hawk-border-subtle bg-hawk-surface/50 px-3 py-2">
          <div className="font-mono text-lg font-bold text-red-400">{counts.blocked}</div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-hawk-text3">Blocked</div>
        </div>
        <div className="rounded-lg border border-hawk-border-subtle bg-hawk-surface/50 px-3 py-2">
          <div className="font-mono text-lg font-bold text-yellow-400">{counts.pending}</div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-hawk-text3">Pending</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-1">
        {(['all', 'risky', 'blocked', 'writes', 'commands'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-2.5 py-1 font-mono text-[10px] transition-all ${
              filter === f
                ? 'bg-hawk-surface2 text-hawk-orange'
                : 'text-hawk-text3 hover:bg-hawk-surface2 hover:text-hawk-text'
            }`}
          >
            {f === 'all' ? 'All' : f === 'risky' ? 'Risky Only' : f === 'blocked' ? 'Blocked' : f === 'writes' ? 'Writes' : 'Commands'}
          </button>
        ))}
      </div>

      {/* Action feed */}
      <div ref={listRef} className="space-y-px">
        {loading ? (
          <div className="py-16 text-center font-mono text-sm text-hawk-text3 animate-pulse">
            Loading...
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState filter={filter} />
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
    </div>
  );
}

// ── Sub-components ──

function EmptyState({ filter }: { filter: string }) {
  return (
    <div className="rounded-xl border border-dashed border-hawk-border-subtle py-16 text-center">
      <div className="mb-2 text-3xl opacity-30">
        {filter === 'all' ? '\u26A1' : '\u2714'}
      </div>
      <p className="font-mono text-xs text-hawk-text3">
        {filter === 'all'
          ? 'Waiting for agent actions... Start a recording to see the live stream.'
          : `No ${filter} actions yet.`}
      </p>
    </div>
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
  const statusInfo = STATUS_BADGE[item.status];
  const icon = TYPE_ICONS[item.type] || '\u2022';

  return (
    <div
      className={`group rounded-lg border transition-all ${
        isBlocked
          ? 'border-red-400/15 bg-red-400/[0.02]'
          : item.risk === 'high'
            ? 'border-orange-400/10 bg-orange-400/[0.01]'
            : 'border-transparent hover:border-hawk-border-subtle hover:bg-hawk-surface/30'
      }`}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {/* Risk dot */}
        <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${RISK_DOT[item.risk]} ${item.risk === 'critical' ? 'animate-pulse' : ''}`} />

        {/* Type icon */}
        <span className="w-4 shrink-0 text-center font-mono text-[10px] text-hawk-text3">
          {icon}
        </span>

        {/* Tool name */}
        <span className="w-12 shrink-0 font-mono text-[10px] text-hawk-text3">
          {item.toolName}
        </span>

        {/* Summary */}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-hawk-text">
          {item.summary}
        </span>

        {/* Badges */}
        <div className="flex shrink-0 items-center gap-1.5">
          {item.risk !== 'safe' && (
            <span className={`rounded border px-1 py-px font-mono text-[9px] uppercase ${RISK_BADGE[item.risk]}`}>
              {item.risk}
            </span>
          )}
          {item.status !== 'allowed' && (
            <span className={`rounded px-1 py-px font-mono text-[9px] ${statusInfo.cls}`}>
              {statusInfo.label}
            </span>
          )}
          {item.cost > 0.001 && (
            <span className="font-mono text-[9px] text-hawk-text3">
              ${item.cost.toFixed(3)}
            </span>
          )}
          <span className="font-mono text-[9px] text-hawk-text3/50">
            {timeAgo(item.timestamp)}
          </span>
        </div>
      </button>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-hawk-border-subtle/50 px-3 py-2.5">
          {item.details.length > 0 && (
            <div className="space-y-1 mb-2">
              {item.details.map((d, i) => (
                <div key={i} className="font-mono text-[11px] text-hawk-text2">
                  <span className="text-hawk-text3">&middot;</span> {d}
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-3 font-mono text-[9px] text-hawk-text3">
            <span>Type: {item.type}</span>
            <span>Session: {item.sessionId.slice(0, 8)}</span>
            <span>Time: {new Date(item.timestamp).toLocaleTimeString()}</span>
            {item.cost > 0 && <span>Cost: ${item.cost.toFixed(4)}</span>}
          </div>

          {/* Approve/Deny */}
          {item.status === 'pending' && (
            <div className="mt-2 flex gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); onApprove?.(); }}
                className="rounded-md border border-hawk-green/30 bg-hawk-green/10 px-3 py-1 font-mono text-[10px] text-hawk-green hover:bg-hawk-green/20"
              >
                Approve
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDeny?.(); }}
                className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-1 font-mono text-[10px] text-red-400 hover:bg-red-400/20"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
