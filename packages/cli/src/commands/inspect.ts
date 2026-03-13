import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { Storage } from '@mklamine/hawkeye-core';

const o = chalk.hex('#ff5f1f');

export const inspectCommand = new Command('inspect')
  .description('Inspect a session in detail: events, files, drift, costs')
  .argument('<session-id>', 'Session ID (full or prefix)')
  .option('--events', 'Show full event timeline')
  .option('--files', 'Show file changes only')
  .option('--drift', 'Show drift history only')
  .option('--llm', 'Show LLM calls only')
  .action((sessionIdInput: string, options) => {
    const dbPath = join(process.cwd(), '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      return;
    }

    const storage = new Storage(dbPath);

    // Resolve short IDs
    const resolved = resolveSessionId(storage, sessionIdInput);
    if (!resolved) {
      console.error(chalk.red(`Session not found: ${sessionIdInput}`));
      storage.close();
      return;
    }

    const sessionResult = storage.getSession(resolved);
    if (!sessionResult.ok || !sessionResult.value) {
      console.error(chalk.red('Failed to retrieve session.'));
      storage.close();
      return;
    }

    const s = sessionResult.value;
    const eventsResult = storage.getEvents(resolved);
    const driftResult = storage.getDriftSnapshots(resolved);
    storage.close();

    const events = eventsResult.ok ? eventsResult.value : [];
    const drifts = driftResult.ok ? driftResult.value : [];

    // Parsed events
    const parsed = events.map((e) => ({
      ...e,
      parsed: JSON.parse(e.data) as Record<string, unknown>,
    }));

    // ─── Session Header ───
    const startDate = new Date(s.started_at);
    const endDate = s.ended_at ? new Date(s.ended_at) : new Date();
    const durationMs = endDate.getTime() - startDate.getTime();
    const statusIcon =
      s.status === 'completed' ? chalk.green('✓ completed') :
      s.status === 'recording' ? chalk.yellow('● recording') :
      s.status === 'paused' ? chalk.blue('⏸ paused') :
      chalk.red('✗ aborted');

    console.log('');
    console.log(o('┌─ Hawkeye Session Inspect ───────────────────────────────'));
    console.log(o('│'));
    console.log(o('│ ') + chalk.bold(s.objective));
    console.log(o('│'));
    console.log(o('│ ') + `ID: ${chalk.cyan(s.id)}  Status: ${statusIcon}`);
    console.log(o('│ ') + `Agent: ${s.agent || chalk.dim('unknown')}  Model: ${s.model || chalk.dim('unknown')}`);
    console.log(o('│ ') + `Duration: ${formatDuration(durationMs)}  Started: ${startDate.toLocaleString()}`);
    console.log(o('│ ') + `Directory: ${chalk.dim(s.working_dir)}`);
    if (s.git_branch) {
      console.log(o('│ ') + `Branch: ${chalk.dim(s.git_branch)}`);
    }
    console.log(o('│'));

    // ─── Quick Stats ───
    const typeCounts: Record<string, number> = {};
    for (const e of events) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    const totalCost = events.reduce((sum, e) => sum + (e.cost_usd || 0), 0);

    console.log(o('│ ') + chalk.bold('Quick Stats'));
    console.log(o('│ ') + chalk.dim('─'.repeat(50)));
    console.log(
      o('│ ') +
      `Actions: ${chalk.white(String(events.length))}  ` +
      `Cost: ${chalk.yellow('$' + totalCost.toFixed(4))}  ` +
      `Drift: ${formatDriftScore(s.final_drift_score)}`
    );

    const typeStr = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}(${c})`)
      .join('  ');
    console.log(o('│ ') + chalk.dim(typeStr));
    console.log(o('│'));

    // ─── Flags: Which sections to show ───
    const showAll = !options.events && !options.files && !options.drift && !options.llm;

    // ─── File Changes + Cost per File ───
    if (showAll || options.files) {
      const fileEvents = parsed.filter((e) => e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename');
      const fileMap: Record<string, { action: string; cost: number; count: number }> = {};
      for (const e of fileEvents) {
        const path = String(e.parsed.path || '');
        const action = e.type === 'file_delete' ? 'deleted' : e.type === 'file_rename' ? 'renamed' : 'modified';
        if (!fileMap[path]) {
          fileMap[path] = { action, cost: 0, count: 0 };
        }
        fileMap[path].count++;
        fileMap[path].cost += e.cost_usd || 0;
        fileMap[path].action = action;
      }

      const sortedFiles = Object.entries(fileMap).sort((a, b) => b[1].cost - a[1].cost);
      console.log(o('│ ') + chalk.bold(`Files Changed (${sortedFiles.length})`));
      console.log(o('│ ') + chalk.dim('─'.repeat(50)));

      if (sortedFiles.length === 0) {
        console.log(o('│ ') + chalk.dim('  No file changes recorded'));
      } else {
        for (const [path, info] of sortedFiles) {
          const icon = info.action === 'deleted' ? chalk.red('−') : info.action === 'renamed' ? chalk.blue('→') : chalk.green('+');
          const edits = info.count > 1 ? chalk.dim(` (${info.count} edits)`) : '';
          const cost = info.cost > 0 ? chalk.yellow(` $${info.cost.toFixed(4)}`) : '';
          console.log(o('│ ') + `  ${icon} ${path}${cost}${edits}`);
        }
      }
      console.log(o('│'));
    }

    // ─── LLM Calls ───
    if (showAll || options.llm) {
      const llmEvents = parsed.filter((e) => e.type === 'llm_call');

      console.log(o('│ ') + chalk.bold(`LLM Calls (${llmEvents.length})`));
      console.log(o('│ ') + chalk.dim('─'.repeat(50)));

      if (llmEvents.length === 0) {
        console.log(o('│ ') + chalk.dim('  No LLM calls recorded'));
      } else {
        // Group by model
        const byModel: Record<string, { cost: number; tokens: number; calls: number }> = {};
        for (const e of llmEvents) {
          const key = `${e.parsed.provider}/${e.parsed.model}`;
          if (!byModel[key]) byModel[key] = { cost: 0, tokens: 0, calls: 0 };
          byModel[key].cost += e.cost_usd || 0;
          byModel[key].tokens += (e.parsed.totalTokens as number) || 0;
          byModel[key].calls++;
        }

        for (const [model, data] of Object.entries(byModel)) {
          console.log(o('│ ') + `  ${chalk.magenta('⚡')} ${model}`);
          console.log(o('│ ') + `    ${data.calls} calls  ${data.tokens.toLocaleString()} tokens  ${chalk.yellow('$' + data.cost.toFixed(4))}`);
        }
      }
      console.log(o('│'));
    }

    // ─── Drift History ───
    if (showAll || options.drift) {
      console.log(o('│ ') + chalk.bold(`Drift History (${drifts.length} checks)`));
      console.log(o('│ ') + chalk.dim('─'.repeat(50)));

      if (drifts.length === 0) {
        console.log(o('│ ') + chalk.dim('  No drift checks recorded'));
      } else {
        for (const snap of drifts) {
          const time = new Date(snap.created_at).toLocaleTimeString();
          const bar = renderDriftBar(snap.score);
          console.log(o('│ ') + `  ${chalk.dim(time)} ${bar} ${chalk.dim(snap.reason || '')}`);
        }
      }
      console.log(o('│'));
    }

    // ─── Event Timeline ───
    if (options.events) {
      console.log(o('│ ') + chalk.bold(`Event Timeline (${events.length} events)`));
      console.log(o('│ ') + chalk.dim('─'.repeat(50)));

      for (const e of parsed.slice(0, 100)) {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const summary = getEventSummary(e.type, e.parsed);
        const icon = getTypeIcon(e.type);
        const cost = e.cost_usd > 0 ? chalk.yellow(` $${e.cost_usd.toFixed(4)}`) : '';
        const drift = e.drift_score != null ? ` ${formatDriftScore(e.drift_score)}` : '';

        console.log(o('│ ') + `  ${chalk.dim(time)} ${icon} ${summary}${cost}${drift}`);
      }

      if (events.length > 100) {
        console.log(o('│ ') + chalk.dim(`  ... and ${events.length - 100} more events`));
      }
      console.log(o('│'));
    }

    console.log(o('└─────────────────────────────────────────────────────────'));
    console.log('');
  });

function resolveSessionId(storage: Storage, input: string): string | null {
  const exact = storage.getSession(input);
  if (exact.ok && exact.value) return input;

  const all = storage.listSessions();
  if (!all.ok) return null;

  const matches = all.value.filter((s) => s.id.startsWith(input));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    console.error(chalk.yellow(`Ambiguous session ID. Matches: ${matches.map((s) => s.id.slice(0, 8)).join(', ')}`));
    return null;
  }
  return null;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function formatDriftScore(score: number | null): string {
  if (score == null) return chalk.dim('—');
  if (score >= 70) return chalk.green(`${score.toFixed(0)}/100`);
  if (score >= 40) return chalk.yellow(`${score.toFixed(0)}/100`);
  return chalk.red(`${score.toFixed(0)}/100`);
}

function renderDriftBar(score: number): string {
  const width = 20;
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const color = score >= 70 ? chalk.green : score >= 40 ? chalk.yellow : chalk.red;
  return `${color('█'.repeat(filled))}${chalk.dim('░'.repeat(empty))} ${color(`${score.toFixed(0).padStart(3)}/100`)}`;
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'command': return chalk.blue('$');
    case 'file_write': return chalk.green('✎');
    case 'file_delete': return chalk.red('✗');
    case 'file_read': return chalk.dim('◉');
    case 'file_rename': return chalk.blue('→');
    case 'llm_call': return chalk.magenta('⚡');
    case 'api_call': return chalk.cyan('→');
    case 'git_commit': return chalk.green('●');
    case 'git_checkout': return chalk.blue('⎇');
    case 'git_push': return chalk.cyan('↑');
    case 'git_pull': return chalk.cyan('↓');
    case 'git_merge': return chalk.magenta('⑂');
    case 'guardrail_trigger': return chalk.red('⛔');
    case 'guardrail_block': return chalk.red('⛔');
    case 'drift_alert': return chalk.yellow('⚠');
    case 'error': return chalk.red('!');
    default: return chalk.dim('·');
  }
}

function getEventSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'command':
      return `${data.command} ${((data.args as string[]) || []).join(' ')}`.trim();
    case 'file_write':
    case 'file_delete':
    case 'file_read':
    case 'file_rename':
      return String(data.path || '');
    case 'llm_call':
      return `${data.provider}/${data.model} (${(data.totalTokens as number || 0).toLocaleString()} tok)`;
    case 'api_call':
      return `${data.method || 'GET'} ${data.url || ''}`;
    case 'guardrail_trigger':
    case 'guardrail_block':
      return `[${data.ruleName}] ${data.description || ''}`;
    case 'git_commit':
      return `commit ${data.commitHash || ''} ${data.message || ''}`.trim();
    case 'git_checkout':
      return `checkout ${data.branch || ''}`;
    case 'git_push':
      return `push ${data.branch || ''}`;
    case 'git_pull':
      return `pull ${data.filesChanged ? `(${data.filesChanged} files)` : ''}`.trim();
    case 'git_merge':
      return `merge ${data.targetBranch || ''}`;
    case 'drift_alert':
      return `Score: ${data.score}/100 — ${data.reason || ''}`;
    case 'error':
      return String(data.message || data.error || 'Unknown error');
    default:
      return type;
  }
}
