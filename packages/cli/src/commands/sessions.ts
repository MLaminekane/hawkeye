import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { Storage } from '@mklamine/hawkeye-core';

export const sessionsCommand = new Command('sessions')
  .description('List recorded sessions')
  .option('-n, --last <count>', 'Show last N sessions', '10')
  .option('-s, --status <status>', 'Filter by status (recording, completed, aborted)')
  .option('--json', 'Output as JSON for machine-readable export')
  .action((options) => {
    const dbPath = join(process.cwd(), '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.log(chalk.yellow('No sessions found. Run `hawkeye init` first.'));
      return;
    }

    const storage = new Storage(dbPath);
    const result = storage.listSessions({
      limit: parseInt(options.last, 10),
      status: options.status,
    });
    storage.close();

    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error.message}`));
      return;
    }

    const sessions = result.value;

    if (sessions.length === 0) {
      if (options.json) {
        console.log('[]');
      } else {
        console.log(chalk.dim('No sessions found.'));
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }

    console.log(
      chalk.bold(`Sessions (${sessions.length}):`),
    );
    console.log('');

    for (const s of sessions) {
      const statusIcon = s.status === 'completed'
        ? chalk.green('✓')
        : s.status === 'recording'
          ? chalk.yellow('●')
          : chalk.red('✗');

      const date = new Date(s.started_at).toLocaleString();
      const cost = s.total_cost_usd > 0 ? chalk.dim(` $${s.total_cost_usd.toFixed(4)}`) : '';
      const tokens = s.total_tokens > 0 ? chalk.dim(` ${s.total_tokens.toLocaleString()} tok`) : '';
      const drift = s.final_drift_score != null
        ? chalk.dim(` drift:${s.final_drift_score.toFixed(0)}`)
        : '';

      console.log(
        `  ${statusIcon} ${chalk.cyan(s.id.slice(0, 8))}  ${chalk.dim(date)}  ${s.total_actions} actions${cost}${tokens}${drift}`,
      );
      console.log(
        `    ${chalk.white(s.objective)}${s.agent ? chalk.dim(` (${s.agent})`) : ''}`,
      );
      console.log('');
    }
  });
