import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { Storage } from '@hawkeye/core';
import { getDeveloperName } from '../config.js';

export const restartCommand = new Command('restart')
  .description('Restart a session (re-open a completed session or end active ones and start fresh)')
  .argument('[session-id]', 'Session ID (or prefix) to restart')
  .option('-o, --objective <text>', 'Objective for the new session')
  .option('-a, --agent <name>', 'Agent name')
  .option('-m, --model <name>', 'Model name')
  .action((sessionIdArg: string | undefined, options) => {
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      process.exit(1);
    }

    const storage = new Storage(dbPath);

    // If a session ID is provided, look it up to inherit its properties
    let sourceSession: { objective: string; agent: string; model: string } | null = null;
    if (sessionIdArg) {
      const result = storage.getSession(sessionIdArg);
      if (!result.ok || !result.value) {
        console.error(chalk.red(`Session not found: ${sessionIdArg}`));
        storage.close();
        process.exit(1);
      }
      const s = result.value;
      const meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : (s.metadata || {});
      sourceSession = {
        objective: s.objective,
        agent: meta.agent || 'claude-code',
        model: meta.model || 'claude-sonnet-4-6',
      };
    }

    // 1. End all active sessions
    const recording = storage.listSessions({ status: 'recording' });
    const paused = storage.listSessions({ status: 'paused' });
    const active = [
      ...(recording.ok ? recording.value : []),
      ...(paused.ok ? paused.value : []),
    ];

    let ended = 0;
    for (const s of active) {
      storage.endSession(s.id, 'completed');
      console.log(chalk.dim(`  Ended: ${s.id.slice(0, 8)}… — ${s.objective.slice(0, 50)}`));
      ended++;
    }

    // 2. Resolve objective/agent/model — CLI flags > source session > active sessions > defaults
    const objective =
      options.objective ||
      sourceSession?.objective ||
      (active.length > 0 ? active[0].objective : 'New Session');
    const agent = options.agent || sourceSession?.agent || 'claude-code';
    const model = options.model || sourceSession?.model || 'claude-sonnet-4-6';

    // 3. Create new session
    const sessionId = randomUUID();

    storage.createSession({
      id: sessionId,
      objective,
      startedAt: new Date(),
      status: 'recording',
      metadata: {
        agent,
        model,
        workingDir: cwd,
        developer: getDeveloperName(),
      },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
    });

    // 4. Update hook-sessions.json so the hook handler uses this new session
    updateHookSessions(cwd, sessionId, objective);

    storage.close();

    console.log('');
    if (ended > 0) {
      console.log(chalk.dim(`  ${ended} session(s) ended`));
    }
    console.log(chalk.green(`  New session started: ${sessionId.slice(0, 8)}…`));
    console.log(chalk.dim(`  Objective: ${objective}`));
    console.log(chalk.dim(`  Agent: ${agent}  Model: ${model}`));
    console.log('');
  });

function updateHookSessions(cwd: string, sessionId: string, objective: string): void {
  const file = join(cwd, '.hawkeye', 'hook-sessions.json');
  // Clear old sessions — the next hook invocation will pick up
  // a fresh session via getOrCreateSession. But if there's an active
  // Claude Code session, map it to the new Hawkeye session.
  try {
    const existing: Record<string, unknown> = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf-8'))
      : {};

    // Find the most recent claude session key and remap it
    const keys = Object.keys(existing);
    const newSessions: Record<string, unknown> = {};

    if (keys.length > 0) {
      const lastKey = keys[keys.length - 1];
      newSessions[lastKey] = {
        hawkeyeSessionId: sessionId,
        claudeSessionId: lastKey,
        objective,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        eventCount: 0,
        totalCostUsd: 0,
        driftScores: [],
        model: 'claude-sonnet-4-6',
      };
    }

    writeFileSync(file, JSON.stringify(newSessions, null, 2));
  } catch {}
}
