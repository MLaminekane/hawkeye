import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { Storage } from '@hawkeye/core';

export const revertCommand = new Command('revert')
  .description('Revert file changes from a session')
  .argument('[session-id]', 'Session ID (or prefix)')
  .option('-e, --event <id>', 'Revert a specific event by ID')
  .option('-a, --all', 'Revert all file changes in the session')
  .action((sessionId, options) => {
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      process.exit(1);
    }

    const storage = new Storage(dbPath);

    // Revert a single event by ID
    if (options.event) {
      const result = revertEvent(storage, options.event, cwd);
      storage.close();
      if (!result.ok) {
        console.error(chalk.red(`  ✗ ${result.error}`));
        process.exit(1);
      }
      console.log(chalk.green(`  ✓ Reverted ${result.path} (${result.method})`));
      return;
    }

    // Need a session ID
    if (!sessionId) {
      // Show recent sessions with file changes
      const sessions = storage.listSessions({ limit: 10 });
      if (!sessions.ok || sessions.value.length === 0) {
        console.log(chalk.dim('  No sessions found.'));
        storage.close();
        return;
      }
      console.log(chalk.dim('\n  Usage: hawkeye revert <session-id> [--all]'));
      console.log(chalk.dim('         hawkeye revert --event <event-id>\n'));
      console.log('  Recent sessions:');
      for (const s of sessions.value) {
        console.log(`    ${chalk.dim(s.id.slice(0, 8))}  ${s.objective.slice(0, 50)}  ${chalk.dim(`${s.total_actions}a`)}`);
      }
      console.log('');
      storage.close();
      return;
    }

    // Get the session
    const sess = storage.getSession(sessionId);
    if (!sess.ok || !sess.value) {
      console.error(chalk.red(`  Session not found: ${sessionId}`));
      storage.close();
      process.exit(1);
    }

    // Get file_write events
    const evts = storage.getEvents(sess.value.id, { type: 'file_write' });
    if (!evts.ok || evts.value.length === 0) {
      console.log(chalk.dim('  No file changes in this session.'));
      storage.close();
      return;
    }

    // Collect unique files
    const fileEvents: { id: string; path: string; action: string; seq: number }[] = [];
    for (const ev of evts.value) {
      const data = JSON.parse(ev.data);
      if (data.path) {
        fileEvents.push({ id: ev.id, path: data.path, action: data.action || 'write', seq: ev.sequence });
      }
    }

    if (fileEvents.length === 0) {
      console.log(chalk.dim('  No file paths found in events.'));
      storage.close();
      return;
    }

    if (options.all) {
      // Revert all — process in reverse order (newest first)
      const reversed = [...fileEvents].reverse();
      // Deduplicate by path (only revert each file once)
      const seen = new Set<string>();
      let ok = 0;
      let fail = 0;
      for (const fe of reversed) {
        if (seen.has(fe.path)) continue;
        seen.add(fe.path);
        const result = revertEvent(storage, fe.id, cwd);
        if (result.ok) {
          console.log(chalk.green(`  ✓ ${shortenPath(fe.path)} (${result.method})`));
          ok++;
        } else {
          console.log(chalk.red(`  ✗ ${shortenPath(fe.path)} — ${result.error}`));
          fail++;
        }
      }
      console.log(chalk.dim(`\n  ${ok} reverted, ${fail} failed`));
    } else {
      // Show list for user to pick
      console.log('');
      for (let i = 0; i < fileEvents.length; i++) {
        const fe = fileEvents[i];
        console.log(`  ${chalk.hex('#ff5f1f').bold(`${i + 1})`)} ${chalk.dim(`#${fe.seq}`)} ${shortenPath(fe.path)}`);
      }
      console.log(chalk.dim(`\n  Use --event <id> to revert a specific change, or --all to revert all.`));
    }

    storage.close();
  });

function shortenPath(p: string): string {
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

function revertEvent(
  storage: Storage,
  eventId: string,
  cwd: string,
): { ok: true; path: string; method: string } | { ok: false; error: string } {
  const ev = storage.getEventById(eventId);
  if (!ev.ok || !ev.value) {
    return { ok: false, error: 'Event not found' };
  }

  const data = JSON.parse(ev.value.data);
  const filePath = data.path;
  if (!filePath) {
    return { ok: false, error: 'Event has no file path' };
  }

  // Strategy 1: Reverse string replacement
  const contentBefore = data.contentBefore;
  const contentAfter = data.contentAfter;
  if (contentBefore != null && contentAfter != null && existsSync(filePath)) {
    try {
      const current = readFileSync(filePath, 'utf-8');
      if (current.includes(contentAfter)) {
        writeFileSync(filePath, current.replace(contentAfter, contentBefore), 'utf-8');
        return { ok: true, path: filePath, method: 'reverse-edit' };
      }
    } catch { /* fall through to git */ }
  }

  // Strategy 2: git checkout
  try {
    execSync(`git checkout HEAD -- "${filePath}"`, { cwd, stdio: 'pipe' });
    return { ok: true, path: filePath, method: 'git-checkout' };
  } catch (err) {
    return { ok: false, error: `git checkout failed: ${String(err)}` };
  }
}
