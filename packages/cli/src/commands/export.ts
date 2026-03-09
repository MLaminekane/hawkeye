import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { Storage, type SessionRow, type EventRow } from '@hawkeye/core';

export const exportCommand = new Command('export')
  .description('Export a session report')
  .argument('<session-id>', 'Session ID (or prefix)')
  .option('-f, --format <type>', 'Output format: json or html', 'html')
  .option('-o, --output <file>', 'Output file path')
  .action((sessionIdPrefix: string, options) => {
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      return;
    }

    const storage = new Storage(dbPath);

    // Find session by prefix
    const result = storage.listSessions({});
    if (!result.ok) {
      console.error(chalk.red('Failed to list sessions.'));
      storage.close();
      return;
    }

    const session = result.value.find((s) => s.id.startsWith(sessionIdPrefix));
    if (!session) {
      console.error(chalk.red(`No session found matching "${sessionIdPrefix}"`));
      storage.close();
      return;
    }

    const eventsResult = storage.getEvents(session.id);
    const driftResult = storage.getDriftSnapshots(session.id);
    storage.close();

    if (!eventsResult.ok) {
      console.error(chalk.red('Failed to get events.'));
      return;
    }

    const events = eventsResult.value;
    const drifts = driftResult.ok ? driftResult.value : [];
    const format = options.format || 'html';
    const defaultExt = format === 'json' ? '.json' : '.html';
    const outputPath = options.output || `hawkeye-${session.id.slice(0, 8)}${defaultExt}`;

    if (format === 'json') {
      const data = {
        session,
        events: events.map((e) => ({
          ...e,
          data: JSON.parse(e.data),
        })),
        driftSnapshots: drifts,
        exportedAt: new Date().toISOString(),
        generator: 'hawkeye-cli',
      };
      writeFileSync(outputPath, JSON.stringify(data, null, 2));
    } else {
      const html = generateHtmlReport(
        session as unknown as Record<string, unknown>,
        events as unknown as Array<Record<string, unknown>>,
        drifts as unknown as Array<Record<string, unknown>>,
      );
      writeFileSync(outputPath, html);
    }

    console.log(chalk.green(`✓ Exported to ${chalk.bold(outputPath)}`));
    console.log(chalk.dim(`  Format: ${format}`));
    console.log(chalk.dim(`  Session: ${session.id.slice(0, 8)} — ${session.objective}`));
    console.log(chalk.dim(`  Events: ${events.length}`));
  });

function generateHtmlReport(
  session: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
  drifts: Array<Record<string, unknown>>,
): string {
  const startTime = new Date(session.started_at as string).getTime();

  const eventRows = events.map((e, i) => {
    const data = JSON.parse(e.data as string);
    const elapsed = formatElapsed(new Date(e.timestamp as string).getTime() - startTime);
    const type = e.type as string;
    const { label, color } = getTypeStyle(type);
    const summary = getEventSummary(type, data, e);
    const cost = (e.cost_usd as number) > 0 ? `$${(e.cost_usd as number).toFixed(4)}` : '';
    const drift = e.drift_score != null ? `${e.drift_score}/100` : '';

    return `<tr>
      <td class="time">${elapsed}</td>
      <td><span class="badge" style="background:${color}20;color:${color}">${label}</span></td>
      <td class="summary">${escapeHtml(summary)}</td>
      <td class="cost">${cost}</td>
      <td class="drift">${drift}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hawkeye Report — ${escapeHtml(session.objective as string)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: #09090B; color: #E0E0EA; padding: 2rem; }
  .header { background: #16161D; border: 1px solid #2A2A3A; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .header h1 { font-family: system-ui; font-size: 1.25rem; margin-bottom: 0.5rem; }
  .stats { display: flex; gap: 1.5rem; margin-top: 1rem; font-size: 0.75rem; }
  .stats span { color: #9898A8; }
  .stats strong { color: #E0E0EA; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; }
  .status.completed { background: #22c55e20; color: #22c55e; }
  .status.aborted { background: #ef444420; color: #ef4444; }
  .status.recording { background: #ff5f1f20; color: #ff5f1f; }
  table { width: 100%; border-collapse: collapse; background: #111117; border: 1px solid #242430; border-radius: 8px; overflow: hidden; }
  th { text-align: left; padding: 0.5rem 0.75rem; background: #18181f; font-size: 0.65rem; text-transform: uppercase; color: #555568; letter-spacing: 0.05em; }
  td { padding: 0.4rem 0.75rem; border-top: 1px solid #1E1E2A; font-size: 0.75rem; }
  .time { color: #5A5A6E; white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary { max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cost { color: #FFB443; text-align: right; }
  .drift { color: #9898A8; text-align: right; }
  .footer { margin-top: 1.5rem; text-align: center; font-size: 0.6rem; color: #5A5A6E; }
  @media print { body { background: white; color: black; } .header, table { border-color: #ddd; background: #fafafa; } }
</style>
</head>
<body>
  <div class="header">
    <span class="status ${session.status}">${session.status}</span>
    <h1>${escapeHtml(session.objective as string)}</h1>
    <div class="stats">
      <div><span>Agent:</span> <strong>${escapeHtml(String(session.agent || 'unknown'))}</strong></div>
      <div><span>Duration:</span> <strong>${formatDuration(session.started_at as string, session.ended_at as string | null)}</strong></div>
      <div><span>Actions:</span> <strong>${events.length}</strong></div>
      <div><span>Cost:</span> <strong>$${((session.total_cost_usd as number) || 0).toFixed(4)}</strong></div>
      ${session.final_drift_score != null ? `<div><span>Drift:</span> <strong>${session.final_drift_score}/100</strong></div>` : ''}
      <div><span>Session:</span> <strong>${(session.id as string).slice(0, 8)}</strong></div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Time</th><th>Type</th><th>Event</th><th>Cost</th><th>Drift</th></tr>
    </thead>
    <tbody>
      ${eventRows}
    </tbody>
  </table>

  <div class="footer">
    Exported by Hawkeye on ${new Date().toLocaleString()} — ${events.length} events
  </div>
</body>
</html>`;
}

function getTypeStyle(type: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    command:           { label: 'CMD',   color: '#3B82F6' },
    file_write:        { label: 'FILE',  color: '#2ECC71' },
    file_delete:       { label: 'DEL',   color: '#FF4757' },
    file_read:         { label: 'READ',  color: '#6B7280' },
    llm_call:          { label: 'LLM',   color: '#A78BFA' },
    api_call:          { label: 'API',   color: '#06B6D4' },
    git_commit:        { label: 'GIT',   color: '#22c55e' },
    git_checkout:      { label: 'GIT',   color: '#3B82F6' },
    git_push:          { label: 'GIT',   color: '#06B6D4' },
    git_pull:          { label: 'GIT',   color: '#06B6D4' },
    git_merge:         { label: 'GIT',   color: '#A78BFA' },
    guardrail_trigger: { label: 'BLOCK', color: '#FF4757' },
    guardrail_block:   { label: 'BLOCK', color: '#FF4757' },
    error:             { label: 'ERR',   color: '#FF4757' },
  };
  return map[type] || { label: type.toUpperCase(), color: '#5A5A6E' };
}

function getEventSummary(type: string, data: Record<string, unknown>, event: Record<string, unknown>): string {
  switch (type) {
    case 'command': return `${data.command || ''} ${((data.args as string[]) || []).join(' ')}`.trim();
    case 'file_write': return `Modified ${data.path || ''}`;
    case 'file_delete': return `Deleted ${data.path || ''}`;
    case 'file_read': return `Read ${data.path || ''}`;
    case 'llm_call': return `${data.provider}/${data.model} → ${data.totalTokens} tokens`;
    case 'git_commit': return `commit ${data.commitHash || ''} ${data.message || ''}`.trim();
    case 'git_checkout': return `checkout ${data.branch || ''}`;
    case 'git_push': return `push ${data.branch || ''}`;
    case 'git_pull': return `pull`;
    case 'git_merge': return `merge ${data.targetBranch || ''}`;
    case 'error': return String(data.message || 'Error');
    case 'guardrail_trigger': return `${data.ruleName ? '[' + data.ruleName + '] ' : ''}${data.description || ''}`;
    default: return type;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
}

function formatDuration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
