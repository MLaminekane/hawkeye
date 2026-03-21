/**
 * Hawkeye Morning Report — generates a consolidated report of overnight sessions.
 *
 * Usage:
 *   hawkeye report                           # Sessions since overnight.json startedAt, or 8h ago
 *   hawkeye report --since 2026-03-19T00:00  # Sessions since a specific time
 *   hawkeye report --json                    # Output as JSON
 *   hawkeye report --llm                     # Include LLM post-mortem per session
 *   hawkeye report --webhook                 # Fire overnight_report webhook
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import chalk from 'chalk';
import {
  Storage,
  createLlmProvider,
  buildPostMortemPrompt,
  parsePostMortemResponse,
} from '@mklamine/hawkeye-core';
import type { PostMortemInput, PostMortemResult, SessionRow, EventRow } from '@mklamine/hawkeye-core';
import { loadConfig } from '../config.js';
import { fireWebhooks } from '../webhooks.js';
import { loadTasks, type Task } from './daemon.js';

const o = chalk.hex('#ff5f1f');

// ─── Data structures ────────────────────────────────────────

export interface OvernightSessionReport {
  sessionId: string;
  objective: string;
  status: string;
  durationMinutes: number;
  stats: {
    totalActions: number;
    totalCostUsd: number;
    totalTokens: number;
    commands: number;
    fileWrites: number;
    errors: number;
    guardrailBlocks: number;
  };
  driftSummary: {
    finalScore: number | null;
    minScore: number | null;
    maxScore: number | null;
    criticalEpisodes: number;
  };
  filesChanged: string[];
  topErrors: Array<{ message: string; count: number }>;
  postMortem: PostMortemResult | null;
}

export interface MorningReport {
  overnightStartedAt: string;
  overnightEndedAt: string;
  totalDurationMinutes: number;
  totalCostUsd: number;
  totalSessions: number;
  sessions: OvernightSessionReport[];
  tasksCompleted: number;
  tasksFailed: number;
  tasksPending: number;
}

// ─── Report generation ──────────────────────────────────────

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function generateMorningReport(
  cwd: string,
  sinceTimestamp: string,
  options?: { runPostMortem?: boolean },
): Promise<MorningReport> {
  const dbPath = join(cwd, '.hawkeye', 'hawkeye.db');
  const storage = new Storage(dbPath);
  const config = loadConfig(cwd);

  const sinceMs = new Date(sinceTimestamp).getTime();
  const nowIso = new Date().toISOString();

  // Get all sessions, filter by start time
  const allResult = storage.listSessions({ limit: 500 });
  const allSessions = allResult.ok ? allResult.value : [];
  const relevantSessions = allSessions.filter(
    (s) => new Date(s.started_at).getTime() >= sinceMs,
  );

  // Set up LLM if post-mortem requested
  let llm: { complete: (prompt: string, opts?: { maxTokens?: number }) => Promise<string> } | null = null;
  if (options?.runPostMortem) {
    const { provider, model, ollamaUrl } = config.drift;
    if (config.apiKeys) {
      const keyMap: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        google: 'GOOGLE_API_KEY',
      };
      for (const [p, envVar] of Object.entries(keyMap)) {
        const key = (config.apiKeys as Record<string, string | undefined>)[p];
        if (key && !process.env[envVar]) {
          process.env[envVar] = key;
        }
      }
    }
    try {
      llm = createLlmProvider(provider, model, ollamaUrl);
    } catch {
      // LLM not available — skip post-mortem
    }
  }

  // Build per-session reports
  const sessionReports: OvernightSessionReport[] = [];
  let totalCostUsd = 0;

  for (const session of relevantSessions) {
    const eventsResult = storage.getEvents(session.id);
    const events = eventsResult.ok ? eventsResult.value : [];
    const statsResult = storage.getSessionStats(session.id);
    const stats = statsResult.ok ? statsResult.value : null;
    const driftResult = storage.getDriftSnapshots(session.id);
    const driftSnapshots = driftResult.ok ? driftResult.value : [];
    const violationsResult = storage.getViolations(session.id);
    const violations = violationsResult.ok ? violationsResult.value : [];
    const costResult = storage.getCostByFile(session.id);
    const costByFile = costResult.ok ? costResult.value : [];

    // Compute cost — use live sum for active sessions
    const sessionCost =
      session.status === 'recording' || session.status === 'paused'
        ? events.reduce((sum, e) => sum + e.cost_usd, 0)
        : session.total_cost_usd;
    totalCostUsd += sessionCost;

    // Compute tokens
    const sessionTokens =
      session.status === 'recording' || session.status === 'paused'
        ? events.reduce((sum, e) => {
            const d = tryParseJson(e.data);
            return (
              sum +
              (d && typeof d === 'object' && 'totalTokens' in d
                ? (d as { totalTokens: number }).totalTokens
                : 0)
            );
          }, 0)
        : session.total_tokens;

    // Duration
    const startMs = new Date(session.started_at).getTime();
    const endMs = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
    const durationMinutes = Math.round((endMs - startMs) / 60000);

    // Drift summary
    const scores = driftSnapshots.map((d) => d.score);
    const criticalEpisodes = driftSnapshots.filter((d) => d.flag === 'critical').length;

    // Files changed
    const fileEvents = events.filter(
      (e) => e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename',
    );
    const fileSet = new Set<string>();
    for (const e of fileEvents) {
      const data = tryParseJson(e.data) as Record<string, unknown> | null;
      if (data?.path) fileSet.add(data.path as string);
    }

    // Top errors
    const errorEvents = events.filter((e) => e.type === 'error');
    const errorCounts = new Map<string, number>();
    for (const e of errorEvents) {
      const data = tryParseJson(e.data) as Record<string, unknown> | null;
      const msg = ((data?.message || data?.description || 'Unknown error') as string).slice(0, 200);
      errorCounts.set(msg, (errorCounts.get(msg) || 0) + 1);
    }
    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([message, count]) => ({ message, count }));

    // Post-mortem (optional)
    let postMortem: PostMortemResult | null = null;
    if (llm && (session.status === 'completed' || session.status === 'aborted')) {
      try {
        // Build event summary
        const typeCounts = new Map<string, number>();
        for (const e of events) {
          typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
        }
        const eventSummary = [...typeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `- ${type}: ${count}`)
          .join('\n');

        const fileMap = new Map<string, number>();
        for (const e of fileEvents) {
          const data = tryParseJson(e.data) as Record<string, unknown> | null;
          if (!data) continue;
          const path = (data.path || 'unknown') as string;
          fileMap.set(path, (fileMap.get(path) || 0) + 1);
        }
        const filesSummary = [...fileMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([path, count]) => {
            const cost = costByFile.find((c) => c.path === path);
            return `- ${path} (${count} edits${cost ? `, $${cost.cost.toFixed(4)}` : ''})`;
          })
          .join('\n');

        const driftHistory = driftSnapshots
          .map((d) => `- Score: ${d.score}, Flag: ${d.flag}${d.reason ? ` — ${d.reason}` : ''}`)
          .join('\n');

        const violationsSummary = violations
          .map((v) => `- [${v.severity}] ${v.rule_name}: ${v.description}`)
          .join('\n');

        const errorsSummary = errorEvents
          .slice(-10)
          .map((e) => {
            const data = tryParseJson(e.data) as Record<string, unknown> | null;
            return `- ${data?.message || data?.description || 'Unknown error'}`;
          })
          .join('\n');

        const input: PostMortemInput = {
          objective: session.objective || 'No objective specified',
          agent: session.agent || 'unknown',
          status: session.status,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          durationMinutes,
          totalActions: events.length,
          totalCostUsd: sessionCost,
          totalTokens: sessionTokens,
          finalDriftScore: session.final_drift_score,
          eventSummary,
          filesSummary,
          driftHistory,
          violations: violationsSummary,
          errors: errorsSummary,
        };

        const prompt = buildPostMortemPrompt(input);
        const rawResponse = await llm.complete(prompt, { maxTokens: 1500 });
        postMortem = parsePostMortemResponse(rawResponse);
      } catch {
        // Skip post-mortem for this session
      }
    }

    sessionReports.push({
      sessionId: session.id,
      objective: session.objective || 'No objective',
      status: session.status,
      durationMinutes,
      stats: {
        totalActions: stats?.total_events || events.length,
        totalCostUsd: sessionCost,
        totalTokens: sessionTokens,
        commands: stats?.command_count || 0,
        fileWrites: stats?.file_count || 0,
        errors: stats?.error_count || 0,
        guardrailBlocks: stats?.guardrail_count || 0,
      },
      driftSummary: {
        finalScore: session.final_drift_score,
        minScore: scores.length > 0 ? Math.min(...scores) : null,
        maxScore: scores.length > 0 ? Math.max(...scores) : null,
        criticalEpisodes,
      },
      filesChanged: [...fileSet],
      topErrors,
      postMortem,
    });
  }

  // Task summary
  const tasks = loadTasks(cwd);
  const sinceTasks = tasks.filter((t) => new Date(t.createdAt).getTime() >= sinceMs);
  const tasksCompleted = sinceTasks.filter((t) => t.status === 'completed').length;
  const tasksFailed = sinceTasks.filter((t) => t.status === 'failed').length;
  const tasksPending = sinceTasks.filter((t) => t.status === 'pending').length;

  const totalDurationMinutes = Math.round((Date.now() - sinceMs) / 60000);

  return {
    overnightStartedAt: sinceTimestamp,
    overnightEndedAt: nowIso,
    totalDurationMinutes,
    totalCostUsd,
    totalSessions: relevantSessions.length,
    sessions: sessionReports,
    tasksCompleted,
    tasksFailed,
    tasksPending,
  };
}

// ─── Terminal rendering ─────────────────────────────────────

function driftColor(score: number | null): string {
  if (score === null) return chalk.dim('N/A');
  if (score >= 70) return chalk.green(String(score));
  if (score >= 40) return chalk.yellow(String(score));
  return chalk.red(String(score));
}

export function renderTerminalReport(report: MorningReport): void {
  const w = Math.min(process.stdout.columns || 80, 120);
  const hr = (ch: string) => ch.repeat(Math.max(w - 4, 20));

  console.log('');
  console.log(`  ${o.bold('Hawkeye Morning Report')}`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log('');

  // Summary
  console.log(`  ${chalk.dim('Period:')}      ${report.overnightStartedAt} → ${report.overnightEndedAt}`);
  console.log(`  ${chalk.dim('Duration:')}    ${report.totalDurationMinutes} minutes`);
  console.log(`  ${chalk.dim('Sessions:')}    ${report.totalSessions}`);
  console.log(`  ${chalk.dim('Total cost:')}  ${chalk.cyan('$' + report.totalCostUsd.toFixed(4))}`);
  if (report.tasksCompleted + report.tasksFailed + report.tasksPending > 0) {
    console.log(
      `  ${chalk.dim('Tasks:')}       ${chalk.green(String(report.tasksCompleted) + ' done')} / ${chalk.red(String(report.tasksFailed) + ' failed')} / ${chalk.yellow(String(report.tasksPending) + ' pending')}`,
    );
  }
  console.log('');

  if (report.sessions.length === 0) {
    console.log(chalk.dim('  No sessions found in this period.'));
    console.log('');
    return;
  }

  // Per-session
  for (const s of report.sessions) {
    const shortId = s.sessionId.slice(0, 8);
    const statusIcon =
      s.status === 'completed'
        ? chalk.green('✓')
        : s.status === 'recording'
          ? chalk.cyan('●')
          : s.status === 'paused'
            ? chalk.yellow('⏸')
            : chalk.red('✗');

    console.log(chalk.dim(`  ${hr('─')}`));
    console.log(`  ${statusIcon} ${o.bold(shortId)}  ${chalk.white(s.objective.slice(0, 80))}`);
    console.log(
      `    ${chalk.dim('Duration:')} ${s.durationMinutes}m  ${chalk.dim('Actions:')} ${s.stats.totalActions}  ${chalk.dim('Cost:')} $${s.stats.totalCostUsd.toFixed(4)}  ${chalk.dim('Drift:')} ${driftColor(s.driftSummary.finalScore)}`,
    );

    if (s.stats.errors > 0) {
      console.log(`    ${chalk.red(`${s.stats.errors} errors`)}${s.stats.guardrailBlocks > 0 ? `  ${chalk.yellow(`${s.stats.guardrailBlocks} guardrail blocks`)}` : ''}`);
    }

    if (s.driftSummary.criticalEpisodes > 0) {
      console.log(
        `    ${chalk.red(`${s.driftSummary.criticalEpisodes} critical drift episode(s)`)}  min=${driftColor(s.driftSummary.minScore)}`,
      );
    }

    if (s.filesChanged.length > 0) {
      const shown = s.filesChanged.slice(0, 5);
      console.log(`    ${chalk.dim('Files:')} ${shown.join(', ')}${s.filesChanged.length > 5 ? ` (+${s.filesChanged.length - 5} more)` : ''}`);
    }

    if (s.topErrors.length > 0) {
      for (const err of s.topErrors.slice(0, 3)) {
        console.log(`    ${chalk.red('•')} ${err.message.slice(0, 80)} ${chalk.dim(`(×${err.count})`)}`);
      }
    }

    if (s.postMortem) {
      const pm = s.postMortem;
      const outcomeColor =
        pm.outcome === 'success'
          ? chalk.green
          : pm.outcome === 'partial'
            ? chalk.yellow
            : chalk.red;
      console.log(`    ${chalk.dim('Outcome:')} ${outcomeColor(pm.outcome)}  ${pm.summary.slice(0, 100)}`);
      if (pm.recommendations.length > 0) {
        console.log(`    ${chalk.dim('Recommendations:')}`);
        for (const rec of pm.recommendations.slice(0, 3)) {
          console.log(`      ${chalk.dim('→')} ${rec.slice(0, 100)}`);
        }
      }
    }
    console.log('');
  }

  console.log(chalk.dim(`  ${hr('─')}`));
  console.log('');
}

// ─── Command ────────────────────────────────────────────────

export const reportCommand = new Command('report')
  .description('Generate a morning report of recent sessions')
  .option('--since <iso>', 'Report on sessions since this ISO timestamp')
  .option('--json', 'Output as JSON')
  .option('--llm', 'Include LLM-powered post-mortem per session')
  .option('--webhook', 'Fire overnight_report webhook with the report')
  .action(async (options) => {
    const cwd = process.cwd();

    // Determine "since" timestamp
    let since = options.since;
    if (!since) {
      // Try reading from overnight.json
      const overnightFile = join(cwd, '.hawkeye', 'overnight.json');
      if (existsSync(overnightFile)) {
        try {
          const data = JSON.parse(readFileSync(overnightFile, 'utf-8'));
          if (data.startedAt) since = data.startedAt;
        } catch {}
      }
      // Fallback: 8 hours ago
      if (!since) {
        since = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
      }
    }

    const report = await generateMorningReport(cwd, since, { runPostMortem: options.llm });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      renderTerminalReport(report);
    }

    if (options.webhook) {
      const config = loadConfig(cwd);
      if (config.webhooks && config.webhooks.length > 0) {
        fireWebhooks(config.webhooks, 'overnight_report', {
          totalSessions: report.totalSessions,
          totalCostUsd: report.totalCostUsd,
          totalDurationMinutes: report.totalDurationMinutes,
          tasksCompleted: report.tasksCompleted,
          tasksFailed: report.tasksFailed,
          sessionSummaries: report.sessions.map((s) => ({
            sessionId: s.sessionId,
            objective: s.objective,
            status: s.status,
            costUsd: s.stats.totalCostUsd,
            driftScore: s.driftSummary.finalScore,
            errors: s.stats.errors,
            outcome: s.postMortem?.outcome || null,
          })),
        });
        console.log(chalk.dim('  Webhook fired.'));
      } else {
        console.log(chalk.dim('  No webhooks configured — skipped.'));
      }
    }
  });
