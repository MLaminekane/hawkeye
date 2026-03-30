import type { EventData } from '../../api';

export type DiffLine = { type: 'add' | 'remove' | 'same'; content: string; lineNum?: number };

export const EVENT_TYPE_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  command: { label: 'CMD', bg: 'bg-blue-500/15', text: 'text-blue-400' },
  file_write: { label: 'FILE', bg: 'bg-hawk-green/15', text: 'text-hawk-green' },
  file_delete: { label: 'DEL', bg: 'bg-hawk-red/15', text: 'text-hawk-red' },
  file_read: { label: 'READ', bg: 'bg-hawk-text3/15', text: 'text-hawk-text3' },
  file_rename: { label: 'REN', bg: 'bg-hawk-amber/15', text: 'text-hawk-amber' },
  llm_call: { label: 'LLM', bg: 'bg-purple-500/15', text: 'text-purple-400' },
  api_call: { label: 'API', bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
  decision: { label: 'DEC', bg: 'bg-indigo-500/15', text: 'text-indigo-400' },
  git_commit: { label: 'GIT', bg: 'bg-hawk-green/15', text: 'text-hawk-green' },
  git_checkout: { label: 'GIT', bg: 'bg-blue-500/15', text: 'text-blue-400' },
  git_push: { label: 'GIT', bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
  git_pull: { label: 'GIT', bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
  git_merge: { label: 'GIT', bg: 'bg-purple-500/15', text: 'text-purple-400' },
  guardrail_trigger: { label: 'GUARD', bg: 'bg-hawk-red/15', text: 'text-hawk-red' },
  guardrail_block: { label: 'BLOCK', bg: 'bg-hawk-red/15', text: 'text-hawk-red' },
  drift_alert: { label: 'DRIFT', bg: 'bg-hawk-amber/15', text: 'text-hawk-amber' },
  session_start: { label: 'START', bg: 'bg-hawk-green/15', text: 'text-hawk-green' },
  session_end: { label: 'END', bg: 'bg-hawk-text3/15', text: 'text-hawk-text3' },
  error: { label: 'ERR', bg: 'bg-hawk-red/15', text: 'text-hawk-red' },
};

export function parseDiffText(text: string): DiffLine[] {
  if (!text) return [];
  let lineNum = 0;
  return text.split('\n').map((line) => {
    if (line.startsWith('+ ') || line.startsWith('+\t')) {
      lineNum++;
      return { type: 'add', content: line.slice(2), lineNum };
    }
    if (line.startsWith('- ') || line.startsWith('-\t')) {
      return { type: 'remove', content: line.slice(2) };
    }
    if (line === '+' || line === '-') {
      if (line === '+') {
        lineNum++;
        return { type: 'add', content: '', lineNum };
      }
      return { type: 'remove', content: '' };
    }
    lineNum++;
    return { type: 'same', content: line, lineNum };
  });
}

export function computeSimpleDiff(before: string[], after: string[]): DiffLine[] {
  const result: DiffLine[] = [];

  if (before.length === 0 || (before.length === 1 && before[0] === '')) {
    after.forEach((line, i) => result.push({ type: 'add', content: line, lineNum: i + 1 }));
    return result;
  }

  if (after.length === 0 || (after.length === 1 && after[0] === '')) {
    before.forEach((line) => result.push({ type: 'remove', content: line }));
    return result;
  }

  const a = before.slice(0, 500);
  const b = after.slice(0, 500);
  const aSet = new Set(a);
  const bSet = new Set(b);

  let ai = 0;
  let bi = 0;
  let lineNum = 0;
  while (ai < a.length || bi < b.length) {
    if (ai < a.length && bi < b.length && a[ai] === b[bi]) {
      lineNum++;
      result.push({ type: 'same', content: a[ai], lineNum });
      ai++;
      bi++;
    } else if (bi < b.length && !aSet.has(b[bi])) {
      lineNum++;
      result.push({ type: 'add', content: b[bi], lineNum });
      bi++;
    } else if (ai < a.length && !bSet.has(a[ai])) {
      result.push({ type: 'remove', content: a[ai] });
      ai++;
    } else if (ai < a.length) {
      result.push({ type: 'remove', content: a[ai] });
      ai++;
    } else {
      lineNum++;
      result.push({ type: 'add', content: b[bi], lineNum });
      bi++;
    }
  }

  return result;
}

export function getEventInfo(
  type: string,
  parsed: Record<string, unknown>,
  event: EventData,
): { summary: string; detail?: string } {
  switch (type) {
    case 'command': {
      const cmd = `${parsed.command || ''} ${((parsed.args as string[]) || []).join(' ')}`.trim();
      const exit = parsed.exitCode != null && parsed.exitCode !== 0 ? ` → exit ${parsed.exitCode}` : '';
      const detail = parsed.stdout || parsed.stderr
        ? `${parsed.stdout ? String(parsed.stdout).slice(0, 1000) : ''}${parsed.stderr ? '\n' + String(parsed.stderr).slice(0, 1000) : ''}`.trim()
        : undefined;
      return { summary: cmd + exit, detail };
    }
    case 'file_write': {
      const path = String(parsed.path || '');
      const size = parsed.sizeAfter ? ` (${formatBytes(parsed.sizeAfter as number)})` : '';
      let detail: string | undefined;
      if (parsed.linesAdded || parsed.linesRemoved) {
        detail = `+${parsed.linesAdded || 0} / -${parsed.linesRemoved || 0} lines`;
      }
      return { summary: `Modified ${shortenPath(path)}${size}`, detail };
    }
    case 'file_delete':
      return { summary: `Deleted ${shortenPath(String(parsed.path || ''))}` };
    case 'file_read':
      return { summary: `Read ${shortenPath(String(parsed.path || ''))}` };
    case 'llm_call': {
      const model = String(parsed.model || 'unknown');
      const tokens = Number(parsed.totalTokens || 0);
      const cost = event.cost_usd > 0 ? ` ($${event.cost_usd.toFixed(4)})` : '';
      const provider = String(parsed.provider || '');
      const detail = parsed.prompt
        ? `Prompt: ${String(parsed.prompt).slice(0, 800)}${parsed.response ? '\n\nResponse: ' + String(parsed.response).slice(0, 800) : ''}`
        : `${provider}/${model} — ${tokens.toLocaleString()} tokens`;
      return { summary: `${provider}/${model} → ${tokens.toLocaleString()} tokens${cost}`, detail };
    }
    case 'api_call': {
      const method = String(parsed.method || 'GET');
      const url = String(parsed.url || '');
      const status = parsed.statusCode ? ` → ${parsed.statusCode}` : '';
      return { summary: `${method} ${url}${status}` };
    }
    case 'guardrail_trigger':
    case 'guardrail_block': {
      const desc = String(parsed.description || parsed.blockedAction || 'Guardrail triggered');
      const rule = parsed.ruleName ? `[${parsed.ruleName}] ` : '';
      return { summary: `${rule}${desc}`, detail: parsed.blockedAction ? String(parsed.blockedAction) : undefined };
    }
    case 'drift_alert': {
      const score = parsed.score != null ? `Score: ${parsed.score}` : '';
      const reason = String(parsed.reason || '');
      return { summary: `${score} — ${reason}`, detail: parsed.suggestion ? String(parsed.suggestion) : undefined };
    }
    case 'decision': {
      const desc = String(parsed.description || '');
      const detail = parsed.reasoning ? String(parsed.reasoning) : undefined;
      return { summary: desc, detail };
    }
    case 'session_start':
      return { summary: 'Session started' };
    case 'session_end': {
      const desc = String(parsed.description || 'Session ended');
      return { summary: desc, detail: parsed.reasoning ? String(parsed.reasoning) : undefined };
    }
    case 'file_rename':
      return { summary: `Renamed ${shortenPath(String(parsed.oldPath || ''))} → ${shortenPath(String(parsed.path || ''))}` };
    case 'git_commit': {
      const hash = parsed.commitHash ? String(parsed.commitHash).slice(0, 7) : '';
      const msg = String(parsed.message || '');
      const stats = parsed.filesChanged ? ` (${parsed.filesChanged} files, +${parsed.linesAdded || 0} -${parsed.linesRemoved || 0})` : '';
      return { summary: `commit ${hash} ${msg}`.trim(), detail: stats || undefined };
    }
    case 'git_checkout':
      return { summary: `checkout ${String(parsed.branch || '')}` };
    case 'git_push':
      return { summary: `push ${String(parsed.branch || '')}`.trim() };
    case 'git_pull': {
      const files = parsed.filesChanged ? ` (${parsed.filesChanged} files changed)` : '';
      return { summary: `pull${files}` };
    }
    case 'git_merge':
      return { summary: `merge ${String(parsed.targetBranch || '')}` };
    case 'error': {
      const msg = String(parsed.message || parsed.description || 'Error');
      const code = parsed.code ? ` (code: ${parsed.code})` : '';
      const detail = parsed.stderr ? String(parsed.stderr).slice(0, 1000) : undefined;
      return { summary: `${msg}${code}`, detail };
    }
    default:
      return { summary: type };
  }
}

export function getDriftColor(score: number | null): string {
  if (score == null) return 'text-hawk-text3';
  if (score >= 70) return 'text-hawk-green';
  if (score >= 40) return 'text-hawk-amber';
  return 'text-hawk-red';
}

export function getDriftLabel(score: number | null): string {
  if (score == null) return 'Unknown';
  if (score >= 85) return 'On track';
  if (score >= 70) return 'Stable';
  if (score >= 40) return 'Needs attention';
  return 'Critical drift';
}

export function getDuration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatRelativeTimestamp(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;

  const diffMs = Date.now() - time;
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatFullTimestamp(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return time.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortenPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-3).join('/');
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const visibleChars = Math.max(6, maxLength - 3);
  const front = Math.ceil(visibleChars / 2);
  const back = Math.floor(visibleChars / 2);
  return `${value.slice(0, front)}...${value.slice(-back)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
