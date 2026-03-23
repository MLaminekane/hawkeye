/**
 * CI Report Generator
 *
 * Generates a markdown report from a Hawkeye session for posting
 * to GitHub PRs as a Check Run and/or comment.
 */

import type { SessionRow, EventRow, SessionStats, GuardrailViolationRow } from '@mklamine/hawkeye-core';
import { isSensitiveFile } from '../impact.js';

// ── Types ────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CIReportInput {
  session: SessionRow;
  events: EventRow[];
  stats: SessionStats;
  driftSnapshots: Array<{ score: number; flag: string; reason: string; created_at: string }>;
  violations: GuardrailViolationRow[];
  costByFile: Array<{ path: string; cost: number; edits: number }>;
  dashboardUrl?: string;
}

export interface CIReportResult {
  markdown: string;
  overallRisk: RiskLevel;
  passed: boolean;
  sensitiveFiles: string[];
  dangerousCommands: string[];
  failedCommands: number;
  flags: string[];
}

// ── Dangerous command patterns ───────────────────────────────────

const DANGEROUS_CMD_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~/,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /DELETE\s+FROM\s+\w+\s*$/i,
  /curl.*\|\s*(ba)?sh/,
  /chmod\s+777/,
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /npm\s+publish/,
  /pkill|killall/,
  />(\/dev\/sd|\/dev\/disk)/,
  /mkfs\./,
];

// ── Helpers ──────────────────────────────────────────────────────

function driftEmoji(score: number | null): string {
  if (score === null) return '⚪';
  if (score >= 70) return '🟢';
  if (score >= 40) return '🟡';
  return '🔴';
}

function riskEmoji(risk: RiskLevel): string {
  switch (risk) {
    case 'low': return '🟢 Low';
    case 'medium': return '🟡 Medium';
    case 'high': return '🟠 High';
    case 'critical': return '🔴 Critical';
  }
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const diffMs = end - start;
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ── Main generator ───────────────────────────────────────────────

export function generateCIReport(input: CIReportInput): CIReportResult {
  const { session, events, stats, driftSnapshots, violations, costByFile, dashboardUrl } = input;

  // ── Extract data from events ───────────────────────────────
  const sensitiveFiles: string[] = [];
  const dangerousCommands: string[] = [];
  let failedCommands = 0;
  const filesChanged = new Set<string>();

  for (const ev of events) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(ev.data); } catch {}

    // File events
    if (ev.type.startsWith('file_')) {
      const path = (data.path ?? data.filePath ?? '') as string;
      if (path) {
        filesChanged.add(path);
        if (isSensitiveFile(path) && !sensitiveFiles.includes(path)) {
          sensitiveFiles.push(path);
        }
      }
    }

    // Command events — check for dangerous patterns and failures
    if (ev.type === 'command') {
      const cmd = (data.command ?? data.cmd ?? '') as string;
      for (const pattern of DANGEROUS_CMD_PATTERNS) {
        if (pattern.test(cmd) && !dangerousCommands.includes(cmd)) {
          dangerousCommands.push(cmd);
          break;
        }
      }
    }

    // Error events
    if (ev.type === 'error') {
      failedCommands++;
    }
  }

  // ── Compute risk level ─────────────────────────────────────
  const drift = session.final_drift_score;
  const hasBlocks = violations.some((v) => v.action_taken === 'block');
  let overallRisk: RiskLevel = 'low';

  if (drift !== null && drift < 30 || hasBlocks || dangerousCommands.length > 2) {
    overallRisk = 'critical';
  } else if (drift !== null && drift < 50 || stats.error_count > 5 || sensitiveFiles.length > 3) {
    overallRisk = 'high';
  } else if (drift !== null && drift < 70 || stats.error_count > 0 || sensitiveFiles.length > 0) {
    overallRisk = 'medium';
  }

  const passed = overallRisk !== 'critical';

  // ── Build flags ────────────────────────────────────────────
  const flags: string[] = [];
  if (sensitiveFiles.length > 0) {
    flags.push(`⚠️ ${sensitiveFiles.length} sensitive file(s) modified: \`${sensitiveFiles.slice(0, 5).join('`, `')}\``);
  }
  if (dangerousCommands.length > 0) {
    flags.push(`🚨 ${dangerousCommands.length} dangerous command(s) executed`);
  }
  if (failedCommands > 0) {
    flags.push(`❌ ${failedCommands} failed command(s)`);
  }
  if (violations.length > 0) {
    const blocks = violations.filter((v) => v.action_taken === 'block').length;
    const warns = violations.length - blocks;
    const parts: string[] = [];
    if (blocks > 0) parts.push(`${blocks} blocked`);
    if (warns > 0) parts.push(`${warns} warned`);
    flags.push(`🛡️ ${violations.length} guardrail violation(s) (${parts.join(', ')})`);
  }
  if (drift !== null && drift < 40) {
    flags.push(`🔴 Critical drift score: ${drift}/100`);
  }

  // ── Build markdown ─────────────────────────────────────────
  const lines: string[] = [];

  lines.push('<!-- hawkeye-ci-report -->');
  lines.push('## 🦅 Hawkeye Session Report');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| **Objective** | ${session.objective || 'N/A'} |`);

  const agentLabel = [session.agent, session.model].filter(Boolean).join(' / ') || 'Unknown';
  lines.push(`| **Agent** | ${agentLabel} |`);

  const driftLabel = drift !== null ? `${driftEmoji(drift)} ${drift}/100` : '⚪ N/A';
  lines.push(`| **Drift Score** | ${driftLabel} |`);
  lines.push(`| **Risk Level** | ${riskEmoji(overallRisk)} |`);
  lines.push(`| **Cost** | ${formatCost(session.total_cost_usd)} |`);
  lines.push(`| **Duration** | ${formatDuration(session.started_at, session.ended_at)} |`);

  const actionBreakdown = [
    stats.command_count > 0 ? `${stats.command_count} cmd` : '',
    stats.file_count > 0 ? `${stats.file_count} file` : '',
    stats.llm_count > 0 ? `${stats.llm_count} llm` : '',
  ].filter(Boolean).join(', ');
  lines.push(`| **Actions** | ${session.total_actions} ${actionBreakdown ? `(${actionBreakdown})` : ''} |`);
  lines.push(`| **Status** | ${session.status} |`);
  lines.push('');

  // Flags section
  if (flags.length > 0) {
    lines.push('### Flags');
    lines.push('');
    for (const flag of flags) {
      lines.push(`- ${flag}`);
    }
    lines.push('');
  }

  // Drift trajectory
  if (driftSnapshots.length > 0) {
    const scores = driftSnapshots.map((s) => s.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const final = scores[scores.length - 1];
    const criticalEpisodes = scores.filter((s) => s < 40).length;

    lines.push('### Drift Trajectory');
    lines.push('');
    lines.push(`Score range: **${min}** – **${max}** | Final: **${final}** ${driftEmoji(final)}`);
    if (criticalEpisodes > 0) {
      lines.push(`> 🔴 ${criticalEpisodes} critical drift episode(s) detected`);
    }
    lines.push('');
  }

  // Cost by file (top 10)
  if (costByFile.length > 0) {
    const top = costByFile.slice(0, 10);
    lines.push('### Cost by File');
    lines.push('');
    lines.push('| File | Cost | Edits |');
    lines.push('|------|------|-------|');
    for (const f of top) {
      const sensitive = isSensitiveFile(f.path) ? ' ⚠️' : '';
      lines.push(`| \`${f.path}\`${sensitive} | ${formatCost(f.cost)} | ${f.edits} |`);
    }
    if (costByFile.length > 10) {
      lines.push(`| *...and ${costByFile.length - 10} more* | | |`);
    }
    lines.push('');
  }

  // Files changed summary
  if (filesChanged.size > 0) {
    lines.push(`### Files Changed (${filesChanged.size})`);
    lines.push('');
    const fileList = Array.from(filesChanged).slice(0, 20).map((f) => `\`${f}\``).join(', ');
    lines.push(fileList);
    if (filesChanged.size > 20) {
      lines.push(`*...and ${filesChanged.size - 20} more*`);
    }
    lines.push('');
  }

  // Replay link
  if (dashboardUrl) {
    lines.push(`[▶️ Replay Session](${dashboardUrl}/sessions/${session.id})`);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('<sub>🦅 Recorded by <a href="https://github.com/MLaminekane/hawkeye">Hawkeye</a> — AI Agent Observability</sub>');

  return {
    markdown: lines.join('\n'),
    overallRisk,
    passed,
    sensitiveFiles,
    dangerousCommands,
    failedCommands,
    flags,
  };
}
