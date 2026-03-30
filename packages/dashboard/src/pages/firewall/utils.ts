import type {
  EventData,
  ImpactPreviewData,
  InterceptionRisk,
  PendingReviewData,
} from '../../api';

export type Risk = InterceptionRisk;
export type FilterKey = 'all' | 'risky' | 'blocked' | 'writes' | 'commands';
export type SortKey = 'latest' | 'risk' | 'type' | 'session';

export interface ActionItem {
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

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) return 'unknown';
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const visible = Math.max(6, maxLength - 3);
  const front = Math.ceil(visible / 2);
  const back = Math.floor(visible / 2);
  return `${value.slice(0, front)}...${value.slice(-back)}`;
}

export function formatCurrency(amount: number): string {
  if (amount <= 0) return '$0.0000';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function summarizeCounts(items: ActionItem[]) {
  return {
    total: items.length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    pending: items.filter((item) => item.status === 'pending').length,
  };
}

export function getFilterLabel(filter: FilterKey): string {
  if (filter === 'all') return 'All activity';
  if (filter === 'risky') return 'Risky only';
  if (filter === 'blocked') return 'Blocked / pending';
  if (filter === 'writes') return 'Mutations';
  return 'Commands';
}

export function getSortLabel(sort: SortKey): string {
  if (sort === 'latest') return 'Latest';
  if (sort === 'risk') return 'Highest risk';
  if (sort === 'type') return 'Type';
  return 'Session';
}

export function getActionHighlights(raw?: Record<string, unknown>) {
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

export function parseEventToAction(event: EventData, risk: Risk, sessionId: string): ActionItem {
  let data: Record<string, unknown> = {};
  try {
    data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch {}

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
  } else if (type === 'file_delete') {
    toolName = 'Delete';
    const path = String(data.path || '');
    summary = path.split('/').pop() || path;
  } else if (type === 'file_rename') {
    toolName = 'Rename';
    summary = `${String(data.oldPath || '').split('/').pop() || 'file'} → ${String(data.path || '').split('/').pop() || 'file'}`.slice(0, 150);
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
  } else if (type === 'api_call') {
    toolName = 'API';
    summary = `${String(data.method || 'GET')} ${String(data.url || 'unknown').slice(0, 100)}`;
    if (data.statusCode) details.push(`Status: ${data.statusCode}`);
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
      const impactPreview = data.impactPreview as Record<string, unknown>;
      if (Array.isArray(impactPreview.details)) {
        for (const detail of impactPreview.details) details.push(String(detail));
      }
    }
  } else {
    summary = type.replaceAll('_', ' ');
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

export function createPendingReviewAction(review: PendingReviewData): ActionItem {
  return {
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
  };
}

export function createImpactPreviewAction(preview: ImpactPreviewData): ActionItem {
  return {
    id: `impact-${preview.timestamp}`,
    timestamp: preview.timestamp,
    type: 'impact_preview',
    risk: preview.impact.risk,
    summary: preview.impact.summary,
    details: preview.impact.details,
    toolName: preview.toolName,
    sessionId: preview.sessionId,
    status:
      preview.impact.risk === 'critical'
        ? 'blocked'
        : preview.impact.risk === 'high'
          ? 'warned'
          : 'allowed',
    cost: 0,
    raw: preview.impact as unknown as Record<string, unknown>,
  };
}

export function buildInitialActionFeed(input: {
  recentActions: Array<EventData & { risk: Risk }>;
  blocks: EventData[];
  pendingReviews: PendingReviewData[];
}): ActionItem[] {
  const byId = new Map<string, ActionItem>();

  for (const event of input.recentActions) {
    byId.set(event.id, parseEventToAction(event, event.risk, event.session_id));
  }

  for (const block of input.blocks) {
    byId.set(block.id, {
      ...parseEventToAction(block, 'critical', block.session_id),
      status: 'blocked',
    });
  }

  for (const review of input.pendingReviews) {
    byId.set(review.id, createPendingReviewAction(review));
  }

  return Array.from(byId.values()).sort(compareActionsByLatest);
}

export function sortActions(items: ActionItem[], sort: SortKey): ActionItem[] {
  const sorted = [...items];

  if (sort === 'latest') return sorted.sort(compareActionsByLatest);
  if (sort === 'risk') return sorted.sort(compareActionsByRisk);
  if (sort === 'type') return sorted.sort((left, right) => left.type.localeCompare(right.type) || compareActionsByLatest(left, right));
  return sorted.sort((left, right) => left.sessionId.localeCompare(right.sessionId) || compareActionsByLatest(left, right));
}

function compareActionsByLatest(left: ActionItem, right: ActionItem): number {
  return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
}

function compareActionsByRisk(left: ActionItem, right: ActionItem): number {
  const riskDelta = getRiskPriority(right) - getRiskPriority(left);
  if (riskDelta !== 0) return riskDelta;
  return compareActionsByLatest(left, right);
}

function getRiskPriority(item: Pick<ActionItem, 'risk' | 'status'>): number {
  if (item.status === 'pending') return 6;
  if (item.status === 'blocked') return 5;
  if (item.risk === 'critical') return 4;
  if (item.risk === 'high') return 3;
  if (item.risk === 'medium') return 2;
  if (item.risk === 'low') return 1;
  return 0;
}
