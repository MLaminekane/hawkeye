import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { Storage } from '@mklamine/hawkeye-core';

export const endCommand = new Command('end')
  .description('End active recording sessions')
  .option('-s, --session <id>', 'End a specific session by ID')
  .option('--all', 'End all active sessions')
  .option('--status <status>', 'End status (completed or aborted)', 'completed')
  .action((options) => {
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      process.exit(1);
    }

    const storage = new Storage(dbPath);
    const status = options.status === 'aborted' ? 'aborted' : 'completed';

    if (options.session) {
      // End a specific session (supports prefix match, e.g. "3dd4398b")
      const result = storage.getSession(options.session);
      if (!result.ok || !result.value) {
        console.error(chalk.red(`Session not found: ${options.session}`));
        storage.close();
        process.exit(1);
      }

      const fullId = result.value.id;

      if (result.value.status !== 'recording' && result.value.status !== 'paused') {
        console.log(chalk.dim(`  Session ${fullId.slice(0, 8)} is already ${result.value.status}`));
        storage.close();
        return;
      }

      storage.endSession(fullId, status as 'completed' | 'aborted');
      console.log(chalk.green(`  Session ended: ${fullId.slice(0, 8)}… (${status})`));
    } else {
      // End all active sessions
      const listResult = storage.listSessions({ status: 'recording' });
      const pausedResult = storage.listSessions({ status: 'paused' });

      const active = [
        ...(listResult.ok ? listResult.value : []),
        ...(pausedResult.ok ? pausedResult.value : []),
      ];

      if (active.length === 0) {
        console.log(chalk.dim('  No active sessions to end.'));
        storage.close();
        return;
      }

      if (!options.all && active.length > 1) {
        console.log(chalk.yellow(`  ${active.length} active sessions found. Use --all to end all, or -s <id> for one:`));
        console.log('');
        for (const s of active) {
          const age = getDuration(s.started_at);
          console.log(`  ${chalk.dim(s.id.slice(0, 8))}  ${s.objective.slice(0, 50)}  ${chalk.dim(age)}  ${chalk.dim(s.status)}`);
        }
        console.log('');
        console.log(chalk.dim('  hawkeye end --all'));
        console.log(chalk.dim('  hawkeye end -s <session-id>'));
        storage.close();
        return;
      }

      let ended = 0;
      for (const s of active) {
        storage.endSession(s.id, status as 'completed' | 'aborted');
        console.log(chalk.green(`  Ended: ${s.id.slice(0, 8)}… — ${s.objective.slice(0, 50)}`));
        ended++;
      }
      console.log(chalk.dim(`  ${ended} session(s) marked as ${status}`));
    }

    // Also clean up hook-sessions.json
    cleanupHookSessions(cwd);

    storage.close();
  });

function cleanupHookSessions(cwd: string): void {
  const file = join(cwd, '.hawkeye', 'hook-sessions.json');
  if (!existsSync(file)) return;
  try {
    // Clear all tracked hook sessions (they've been ended in DB)
    writeFileSync(file, '{}');
  } catch {}
}

function getDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}
