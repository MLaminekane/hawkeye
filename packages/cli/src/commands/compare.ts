import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { Storage } from '@hawkeye/core';

const o = chalk.hex('#ff5f1f');

export const compareCommand = new Command('compare')
  .description('Compare two or more sessions side by side')
  .argument('<sessions...>', 'Session IDs (full or prefix, at least 2)')
  .option('--json', 'Output as JSON')
  .action((sessionArgs: string[], options) => {
    const dbPath = join(process.cwd(), '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      return;
    }

    if (sessionArgs.length < 2) {
      console.error(chalk.red('Need at least 2 session IDs to compare.'));
      return;
    }

    const storage = new Storage(dbPath);

    // Resolve short IDs
    const allSessions = storage.listSessions({ limit: 1000 });
    const allRows = allSessions.ok ? allSessions.value : [];

    const resolvedIds: string[] = [];
    for (const input of sessionArgs) {
      const exact = allRows.find((s) => s.id === input);
      if (exact) {
        resolvedIds.push(exact.id);
        continue;
      }
      const matches = allRows.filter((s) => s.id.startsWith(input));
      if (matches.length === 1) {
        resolvedIds.push(matches[0].id);
      } else if (matches.length > 1) {
        console.error(chalk.yellow(`Ambiguous ID "${input}": ${matches.map((s) => s.id.slice(0, 8)).join(', ')}`));
        storage.close();
        return;
      } else {
        console.error(chalk.red(`Session not found: ${input}`));
        storage.close();
        return;
      }
    }

    const result = storage.compareSessions(resolvedIds);
    storage.close();

    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error.message}`));
      return;
    }

    const comparisons = result.value;
    if (comparisons.length < 2) {
      console.error(chalk.red('Could not load enough sessions for comparison.'));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(comparisons, null, 2));
      return;
    }

    // ─── Visual comparison ───
    console.log('');
    console.log(o.bold('  Session Comparison'));
    console.log(chalk.dim('  ─'.repeat(30)));
    console.log('');

    // Header row
    const colWidth = 22;
    const labelWidth = 18;
    const header =
      ''.padEnd(labelWidth) +
      comparisons.map((c) => chalk.cyan(c.session.id.slice(0, 8).padEnd(colWidth))).join('');
    console.log(header);
    console.log(chalk.dim('  ' + '─'.repeat(labelWidth + colWidth * comparisons.length)));

    // Rows
    const rows: Array<{ label: string; values: string[]; winner?: 'low' | 'high' }> = [
      {
        label: 'Agent',
        values: comparisons.map((c) => c.session.agent || 'unknown'),
      },
      {
        label: 'Objective',
        values: comparisons.map((c) => c.session.objective.slice(0, colWidth - 2)),
      },
      {
        label: 'Status',
        values: comparisons.map((c) => c.session.status),
      },
      {
        label: 'Duration',
        values: comparisons.map((c) => formatDuration(c.durationMs)),
        winner: 'low',
      },
      {
        label: 'Actions',
        values: comparisons.map((c) => String(c.session.total_actions)),
        winner: 'low',
      },
      {
        label: 'Cost',
        values: comparisons.map((c) => '$' + c.session.total_cost_usd.toFixed(4)),
        winner: 'low',
      },
      {
        label: 'Tokens',
        values: comparisons.map((c) => c.session.total_tokens.toLocaleString()),
        winner: 'low',
      },
      {
        label: 'LLM Calls',
        values: comparisons.map((c) => String(c.stats.llm_count)),
        winner: 'low',
      },
      {
        label: 'Commands',
        values: comparisons.map((c) => String(c.stats.command_count)),
      },
      {
        label: 'Files Changed',
        values: comparisons.map((c) => String(c.filesChanged.length)),
      },
      {
        label: 'Errors',
        values: comparisons.map((c) => String(c.stats.error_count)),
        winner: 'low',
      },
      {
        label: 'Guardrail Hits',
        values: comparisons.map((c) => String(c.stats.guardrail_count)),
        winner: 'low',
      },
      {
        label: 'Drift Score',
        values: comparisons.map((c) =>
          c.session.final_drift_score != null ? c.session.final_drift_score.toFixed(0) + '/100' : 'n/a',
        ),
        winner: 'high',
      },
    ];

    for (const row of rows) {
      // Find winner
      let winnerIdx = -1;
      if (row.winner) {
        const nums = row.values.map((v) => {
          const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
          return isNaN(n) ? null : n;
        });
        const validNums = nums.filter((n) => n !== null) as number[];
        if (validNums.length >= 2) {
          const best = row.winner === 'low' ? Math.min(...validNums) : Math.max(...validNums);
          winnerIdx = nums.indexOf(best);
        }
      }

      const formatted = row.values
        .map((v, i) => {
          const padded = v.slice(0, colWidth - 2).padEnd(colWidth);
          return i === winnerIdx ? chalk.green(padded) : padded;
        })
        .join('');

      console.log(`  ${chalk.dim(row.label.padEnd(labelWidth))}${formatted}`);
    }

    // ─── Efficiency comparison ───
    console.log('');
    console.log(chalk.dim('  ' + '─'.repeat(labelWidth + colWidth * comparisons.length)));

    // Cost efficiency = cost / action
    const efficiencies = comparisons.map((c) => ({
      costPerAction: c.session.total_actions > 0 ? c.session.total_cost_usd / c.session.total_actions : 0,
      tokensPerAction: c.session.total_actions > 0 ? c.session.total_tokens / c.session.total_actions : 0,
    }));

    const bestCostIdx = efficiencies.reduce((best, e, i) =>
      e.costPerAction > 0 && e.costPerAction < efficiencies[best].costPerAction ? i : best, 0);

    console.log(
      `  ${chalk.dim('$/action'.padEnd(labelWidth))}${efficiencies
        .map((e, i) => {
          const v = ('$' + e.costPerAction.toFixed(4)).padEnd(colWidth);
          return i === bestCostIdx ? chalk.green(v) : v;
        })
        .join('')}`,
    );

    console.log(
      `  ${chalk.dim('tok/action'.padEnd(labelWidth))}${efficiencies
        .map((e) => String(Math.round(e.tokensPerAction)).padEnd(colWidth))
        .join('')}`,
    );

    console.log('');
  });

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
