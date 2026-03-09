import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { Storage } from '@hawkeye/core';

export const statsCommand = new Command('stats')
  .description('Show statistics for a session, or global stats if no session given')
  .argument('[session-id]', 'Session ID (full or prefix). Omit for global stats')
  .action((sessionId: string | undefined) => {
    const dbPath = join(process.cwd(), '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      return;
    }

    const storage = new Storage(dbPath);

    if (!sessionId) {
      showGlobalStats(storage);
      storage.close();
      return;
    }

    // Support short IDs: find the matching session
    const resolved = resolveSessionId(storage, sessionId);
    if (!resolved) {
      console.error(chalk.red(`Session not found: ${sessionId}`));
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

    const driftSnapshots = driftResult.ok ? driftResult.value : [];

    const events = eventsResult.ok ? eventsResult.value : [];

    // Compute stats
    const typeCounts: Record<string, number> = {};
    for (const e of events) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }

    const startDate = new Date(s.started_at);
    const endDate = s.ended_at ? new Date(s.ended_at) : new Date();
    const durationMs = endDate.getTime() - startDate.getTime();
    const durationStr = formatDuration(durationMs);

    const statusIcon = s.status === 'completed'
      ? chalk.green('✓ completed')
      : s.status === 'recording'
        ? chalk.yellow('● recording')
        : chalk.red('✗ aborted');

    console.log('');
    console.log(chalk.bold('Session Details'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`  ID:        ${chalk.cyan(s.id)}`);
    console.log(`  Objective: ${chalk.white(s.objective)}`);
    console.log(`  Status:    ${statusIcon}`);
    console.log(`  Agent:     ${s.agent || chalk.dim('unknown')}`);
    console.log(`  Model:     ${s.model || chalk.dim('unknown')}`);
    console.log(`  Directory: ${chalk.dim(s.working_dir)}`);

    if (s.git_branch) {
      console.log(`  Branch:    ${chalk.dim(s.git_branch)}`);
    }
    if (s.git_commit_before) {
      const after = s.git_commit_after || chalk.dim('n/a');
      console.log(`  Commits:   ${chalk.dim(s.git_commit_before)} → ${after}`);
    }

    console.log('');
    console.log(chalk.bold('Statistics'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`  Duration:  ${durationStr}`);
    console.log(`  Actions:   ${s.total_actions}`);
    console.log(`  Tokens:    ${s.total_tokens.toLocaleString()}`);
    console.log(`  Cost:      $${s.total_cost_usd.toFixed(4)}`);

    if (s.final_drift_score != null) {
      const driftColor = s.final_drift_score >= 70
        ? chalk.green
        : s.final_drift_score >= 40
          ? chalk.yellow
          : chalk.red;
      console.log(`  Drift:     ${driftColor(s.final_drift_score.toFixed(0) + '/100')}`);
    }

    if (driftSnapshots.length > 0) {
      console.log('');
      console.log(chalk.bold('Drift History'));
      console.log(chalk.dim('─'.repeat(50)));
      for (const snap of driftSnapshots) {
        const color = snap.flag === 'ok'
          ? chalk.green
          : snap.flag === 'warning'
            ? chalk.yellow
            : chalk.red;
        const time = new Date(snap.created_at).toLocaleTimeString();
        console.log(`  ${chalk.dim(time)} ${color(`${snap.score.toFixed(0).padStart(3)}/100`)} ${chalk.dim(snap.reason)}`);
      }
    }

    if (Object.keys(typeCounts).length > 0) {
      console.log('');
      console.log(chalk.bold('Events by Type'));
      console.log(chalk.dim('─'.repeat(50)));
      for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(20)} ${count}`);
      }
    }

    // Files changed summary with cost per file
    const fileEvents = events.filter((e) => e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename');
    if (fileEvents.length > 0) {
      const fileMap: Record<string, { cost: number; edits: number; deleted: boolean }> = {};
      for (const e of fileEvents) {
        const data = JSON.parse(e.data);
        if (!data.path) continue;
        if (!fileMap[data.path]) fileMap[data.path] = { cost: 0, edits: 0, deleted: false };
        fileMap[data.path].cost += e.cost_usd || 0;
        fileMap[data.path].edits++;
        if (e.type === 'file_delete') fileMap[data.path].deleted = true;
      }

      const sorted = Object.entries(fileMap).sort((a, b) => b[1].cost - a[1].cost);
      console.log('');
      console.log(chalk.bold(`Files Changed (${sorted.length})`));
      console.log(chalk.dim('─'.repeat(50)));
      for (const [p, info] of sorted) {
        const icon = info.deleted ? chalk.red('−') : chalk.green('+');
        const cost = info.cost > 0 ? chalk.yellow(` $${info.cost.toFixed(4)}`) : '';
        const edits = info.edits > 1 ? chalk.dim(` (${info.edits} edits)`) : '';
        console.log(`  ${icon} ${p}${cost}${edits}`);
      }
    }

    console.log('');
  });

function showGlobalStats(storage: Storage): void {
  const result = storage.getGlobalStats();
  if (!result.ok) {
    console.error(chalk.red('Failed to compute global stats.'));
    return;
  }

  const g = result.value;
  const driftColor = g.avg_drift_score >= 70 ? chalk.green : g.avg_drift_score >= 40 ? chalk.yellow : chalk.red;

  console.log('');
  console.log(chalk.bold('Global Statistics'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log(`  Total Sessions:   ${chalk.white(String(g.total_sessions))}`);
  console.log(`    Completed:      ${chalk.green(String(g.completed_sessions))}`);
  console.log(`    Active:         ${chalk.yellow(String(g.active_sessions))}`);
  console.log(`    Aborted:        ${chalk.red(String(g.aborted_sessions))}`);
  console.log('');
  console.log(`  Total Actions:    ${chalk.white(String(g.total_actions))}`);
  console.log(`  Total Cost:       ${chalk.yellow('$' + g.total_cost_usd.toFixed(4))}`);
  console.log(`  Total Tokens:     ${chalk.white(g.total_tokens.toLocaleString())}`);
  console.log(`  Avg Drift Score:  ${driftColor(g.avg_drift_score.toFixed(0) + '/100')}`);

  if (g.first_session) {
    console.log('');
    console.log(`  First Session:    ${chalk.dim(new Date(g.first_session).toLocaleString())}`);
    console.log(`  Last Session:     ${chalk.dim(new Date(g.last_session!).toLocaleString())}`);
  }
  console.log('');
}

function resolveSessionId(storage: Storage, input: string): string | null {
  // Try exact match first
  const exact = storage.getSession(input);
  if (exact.ok && exact.value) return input;

  // Try prefix match
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
