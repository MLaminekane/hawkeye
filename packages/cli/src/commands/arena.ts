/**
 * Hawkeye Agent Arena — pit multiple AI agents against each other on the same task.
 *
 * Creates isolated git worktrees for each agent, runs them in parallel,
 * optionally runs tests, scores results, and prints a leaderboard.
 *
 * Usage:
 *   hawkeye arena --task "Add user auth with JWT" --agents claude,aider
 *   hawkeye arena -t "Fix lint errors" -a claude,codex --test "npm test"
 *   hawkeye arena -t "Build REST API" -a claude,aider,codex --timeout 1800
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { fireWebhooks } from '../webhooks.js';

const o = chalk.hex('#ff5f1f');

// ─── Types ──────────────────────────────────────────────────

export interface ArenaContestant {
  agent: string;
  worktreePath: string;
  branch: string;
  status: 'waiting' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  durationSeconds?: number;
  exitCode?: number;
  output?: string;
  testsPassed?: boolean;
  testOutput?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  diffSummary?: string;
  score?: number;
  rank?: number;
}

export interface ArenaResult {
  id: string;
  task: string;
  testCommand: string | null;
  createdAt: string;
  completedAt: string | null;
  status: 'running' | 'completed';
  contestants: ArenaContestant[];
  winner: string | null;
}

// ─── Known agents ───────────────────────────────────────────

const KNOWN_AGENTS: Record<string, (task: string) => { cmd: string; args: string[] }> = {
  claude: (task) => ({ cmd: 'claude', args: ['-p', task] }),
  aider: (task) => ({ cmd: 'aider', args: ['--message', task, '--yes'] }),
  codex: (task) => ({ cmd: 'codex', args: ['-q', task] }),
};

// ─── Arena file helpers ─────────────────────────────────────

function getArenasFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'arenas.json');
}

export function loadArenas(cwd: string): ArenaResult[] {
  const file = getArenasFile(cwd);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveArenas(cwd: string, arenas: ArenaResult[]): void {
  const dir = join(cwd, '.hawkeye');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getArenasFile(cwd), JSON.stringify(arenas, null, 2));
}

// ─── Git worktree helpers ───────────────────────────────────

function createWorktree(cwd: string, path: string, branch: string): boolean {
  try {
    execSync(`git worktree add "${path}" -b "${branch}"`, {
      cwd,
      stdio: 'pipe',
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

function removeWorktree(cwd: string, path: string, branch: string): void {
  try {
    execSync(`git worktree remove "${path}" --force`, { cwd, stdio: 'pipe', timeout: 10000 });
  } catch {}
  try {
    execSync(`git branch -D "${branch}"`, { cwd, stdio: 'pipe', timeout: 5000 });
  } catch {}
}

function getInitialHash(worktreePath: string): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

// ─── Diff + test helpers ────────────────────────────────────

function getDiffStats(
  worktreePath: string,
  initialHash: string,
): { filesChanged: number; linesAdded: number; linesRemoved: number; summary: string } {
  try {
    const numstat = execSync(`git diff --numstat ${initialHash}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    const summary = execSync(`git diff --stat ${initialHash}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    let filesChanged = 0;
    let linesAdded = 0;
    let linesRemoved = 0;

    if (numstat) {
      const lines = numstat.split('\n');
      filesChanged = lines.length;
      for (const line of lines) {
        const [added, removed] = line.split('\t');
        linesAdded += parseInt(added) || 0;
        linesRemoved += parseInt(removed) || 0;
      }
    }

    return { filesChanged, linesAdded, linesRemoved, summary };
  } catch {
    return { filesChanged: 0, linesAdded: 0, linesRemoved: 0, summary: '' };
  }
}

function runTests(
  worktreePath: string,
  testCmd: string,
): { passed: boolean; output: string } {
  try {
    const output = execSync(testCmd, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: 'pipe',
    });
    return { passed: true, output: output.slice(0, 5000) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      passed: false,
      output: (e.stdout || e.stderr || String(err)).slice(0, 5000),
    };
  }
}

// ─── Agent execution ────────────────────────────────────────

function runAgent(
  agent: string,
  task: string,
  worktreePath: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const known = KNOWN_AGENTS[agent];
    let cmd: string;
    let args: string[];

    if (known) {
      const built = known(task);
      cmd = built.cmd;
      args = built.args;
    } else {
      // Treat agent name as command, assume -p flag for prompt
      const parts = agent.split(/\s+/);
      cmd = parts[0];
      args = [...parts.slice(1), '-p', task];
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn(cmd, args, {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        output: (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).slice(0, 50000),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        output: `Failed to start ${agent}: ${err.message}`,
      });
    });
  });
}

// ─── Scoring ────────────────────────────────────────────────

function scoreContestants(contestants: ArenaContestant[], hasTestCmd: boolean): void {
  const completed = contestants.filter(
    (c) => c.status === 'completed' && c.exitCode === 0,
  );

  for (const c of contestants) {
    if (c.status !== 'completed' || c.exitCode !== 0) {
      c.score = 0;
      continue;
    }

    // Tests failed = disqualified
    if (hasTestCmd && c.testsPassed === false) {
      c.score = 0;
      continue;
    }

    let score = 0;

    // Tests pass: 50 points (or 50 if no test command)
    score += hasTestCmd && c.testsPassed ? 50 : !hasTestCmd ? 50 : 0;

    // Speed: up to 20 points
    const durations = completed.map((x) => x.durationSeconds || 0).filter((d) => d > 0);
    if (durations.length > 0 && c.durationSeconds) {
      const fastest = Math.min(...durations);
      const slowest = Math.max(...durations);
      if (slowest > fastest) {
        score += Math.round(20 * (1 - (c.durationSeconds - fastest) / (slowest - fastest)));
      } else {
        score += 20;
      }
    }

    // Code efficiency (fewer total lines changed = more focused): up to 15 points
    const lineTotals = completed.map((x) => (x.linesAdded || 0) + (x.linesRemoved || 0)).filter((t) => t > 0);
    const myTotal = (c.linesAdded || 0) + (c.linesRemoved || 0);
    if (lineTotals.length > 0 && myTotal > 0) {
      const minLines = Math.min(...lineTotals);
      const maxLines = Math.max(...lineTotals);
      if (maxLines > minLines) {
        score += Math.round(15 * (1 - (myTotal - minLines) / (maxLines - minLines)));
      } else {
        score += 15;
      }
    }

    // File count (fewer = more targeted): up to 10 points
    const fileCounts = completed.map((x) => x.filesChanged || 0).filter((f) => f > 0);
    if (fileCounts.length > 0 && (c.filesChanged || 0) > 0) {
      const minFiles = Math.min(...fileCounts);
      const maxFiles = Math.max(...fileCounts);
      if (maxFiles > minFiles) {
        score += Math.round(10 * (1 - ((c.filesChanged || 0) - minFiles) / (maxFiles - minFiles)));
      } else {
        score += 10;
      }
    }

    // Completion bonus
    score += 5;

    c.score = score;
  }

  // Assign ranks
  const sorted = [...contestants].sort((a, b) => (b.score || 0) - (a.score || 0));
  sorted.forEach((c, i) => {
    c.rank = i + 1;
  });
}

// ─── Terminal display ───────────────────────────────────────

function pad(str: string, width: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  const padding = Math.max(0, width - stripped.length);
  return str + ' '.repeat(padding);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function printBanner(task: string, agents: string[], testCmd: string | null): number {
  const w = Math.min(process.stdout.columns || 80, 120);
  const hr = (ch: string) => ch.repeat(Math.max(w - 4, 20));

  console.log('');
  console.log(chalk.dim(`  ${hr('═')}`));
  console.log(`  ${o.bold('⚔  HAWKEYE ARENA')}`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log(`  ${chalk.dim('Task:')}    ${chalk.white(task.length > 80 ? task.slice(0, 77) + '...' : task)}`);
  console.log(`  ${chalk.dim('Agents:')}  ${agents.map((a) => o.bold(a)).join(chalk.dim(' vs '))}`);
  if (testCmd) {
    console.log(`  ${chalk.dim('Test:')}    ${chalk.cyan(testCmd)}`);
  }
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log('');

  // Print initial status lines (will be overwritten by progress)
  let lines = 0;
  for (const a of agents) {
    console.log(`  ${chalk.dim('○')} ${pad(chalk.dim(a), 18)} ${chalk.dim('waiting...')}`);
    lines++;
  }
  console.log('');
  lines++;
  console.log(chalk.dim(`  Elapsed: 0m 0s`));
  lines++;

  return lines;
}

function updateProgress(contestants: ArenaContestant[], lineCount: number): void {
  // Move cursor up
  process.stdout.write(`\x1b[${lineCount}A`);

  for (const c of contestants) {
    const icon =
      c.status === 'running'
        ? chalk.cyan('●')
        : c.status === 'completed'
          ? c.exitCode === 0
            ? chalk.green('✓')
            : chalk.red('✗')
          : c.status === 'failed'
            ? chalk.red('✗')
            : chalk.dim('○');

    let detail = '';
    if (c.status === 'running' && c.startedAt) {
      const sec = Math.round((Date.now() - new Date(c.startedAt).getTime()) / 1000);
      detail = chalk.cyan(formatDuration(sec));
    } else if (c.status === 'completed') {
      detail = c.exitCode === 0
        ? chalk.green(formatDuration(c.durationSeconds || 0))
        : chalk.red(`failed (exit ${c.exitCode})`);
      if (c.testsPassed !== undefined) {
        detail += c.testsPassed
          ? chalk.green('  tests ✓')
          : chalk.red('  tests ✗');
      }
      if (c.filesChanged) {
        detail += chalk.dim(`  ${c.filesChanged} files +${c.linesAdded || 0}/-${c.linesRemoved || 0}`);
      }
    } else if (c.status === 'failed') {
      detail = chalk.red(`failed (exit ${c.exitCode ?? '?'})`);
    } else {
      detail = chalk.dim('waiting...');
    }

    process.stdout.write(`\x1b[2K  ${icon} ${pad(o.bold(c.agent), 18)} ${detail}\n`);
  }

  const elapsed = contestants
    .filter((c) => c.startedAt)
    .reduce((max, c) => {
      const t = Date.now() - new Date(c.startedAt!).getTime();
      return t > max ? t : max;
    }, 0);
  const sec = Math.round(elapsed / 1000);
  process.stdout.write(`\x1b[2K\n`);
  process.stdout.write(`\x1b[2K  ${chalk.dim('Elapsed:')} ${formatDuration(sec)}\n`);
}

function printLeaderboard(arena: ArenaResult): void {
  const w = Math.min(process.stdout.columns || 80, 120);
  const hr = (ch: string) => ch.repeat(Math.max(w - 4, 20));

  console.log('');
  console.log(chalk.dim(`  ${hr('═')}`));
  console.log(`  ${o.bold('⚔  ARENA RESULTS')}`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log(`  ${chalk.dim('Task:')} ${chalk.white(arena.task)}`);
  if (arena.testCommand) {
    console.log(`  ${chalk.dim('Test:')} ${chalk.cyan(arena.testCommand)}`);
  }
  console.log('');

  // Column header
  console.log(
    `  ${pad(chalk.dim('#'), 5)}${pad(chalk.dim('Agent'), 14)}${pad(chalk.dim('Score'), 8)}${pad(chalk.dim('Time'), 10)}${pad(chalk.dim('Tests'), 8)}${pad(chalk.dim('Files'), 8)}${pad(chalk.dim('Diff'), 14)}`,
  );
  console.log(chalk.dim(`  ${hr('─')}`));

  const ranked = [...arena.contestants].sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const c of ranked) {
    const isWinner = c.rank === 1 && (c.score || 0) > 0;
    const rankStr = isWinner ? '🏆' : ` ${c.rank || '-'}.`;
    const agentStr = isWinner ? chalk.yellow.bold(c.agent) : chalk.white(c.agent);
    const scoreStr = (c.score || 0) > 0 ? chalk.cyan.bold(String(c.score)) : chalk.red('0');
    const timeStr = c.durationSeconds ? formatDuration(c.durationSeconds) : '-';
    const testsStr =
      c.testsPassed === true
        ? chalk.green('pass')
        : c.testsPassed === false
          ? chalk.red('fail')
          : chalk.dim('n/a');
    const filesStr = c.filesChanged ? String(c.filesChanged) : '0';
    const diffStr =
      c.linesAdded !== undefined
        ? `${chalk.green('+' + c.linesAdded)}/${chalk.red('-' + (c.linesRemoved || 0))}`
        : '-';

    console.log(
      `  ${pad(rankStr, 5)}${pad(agentStr, 14)}${pad(scoreStr, 8)}${pad(timeStr, 10)}${pad(testsStr, 8)}${pad(filesStr, 8)}${pad(diffStr, 14)}`,
    );
  }

  console.log('');

  if (arena.winner) {
    console.log(`  🏆 ${o.bold('Winner:')} ${chalk.yellow.bold(arena.winner)}`);
  } else {
    console.log(`  ${chalk.red('No winner — all agents failed or tests didn\'t pass.')}`);
  }

  console.log(chalk.dim(`  ${hr('═')}`));
  console.log('');
}

// ─── Main orchestrator ──────────────────────────────────────

async function runArena(
  task: string,
  agents: string[],
  testCmd: string | null,
  timeoutMs: number,
  cwd: string,
): Promise<ArenaResult> {
  const arenaId = randomUUID().slice(0, 8);
  const arenaDir = join(cwd, '.hawkeye', `arena-${arenaId}`);
  mkdirSync(arenaDir, { recursive: true });

  const arena: ArenaResult = {
    id: arenaId,
    task,
    testCommand: testCmd,
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    contestants: [],
    winner: null,
  };

  // 1. Validate agents exist
  for (const agent of agents) {
    const cmdName = KNOWN_AGENTS[agent] ? agent : agent.split(/\s+/)[0];
    try {
      execSync(`command -v ${cmdName}`, { stdio: 'pipe', timeout: 3000, shell: '/bin/sh' });
    } catch {
      console.log(`  ${chalk.red('✗')} Agent ${chalk.bold(cmdName)} not found in PATH`);
      console.log(chalk.dim(`    Install it or provide the full path.`));
      return arena;
    }
  }

  // 2. Create worktrees + contestants
  console.log(chalk.dim('  Setting up worktrees...'));

  for (const agent of agents) {
    const branch = `arena-${arenaId}-${agent}`;
    const worktreePath = join(arenaDir, agent);

    if (!createWorktree(cwd, worktreePath, branch)) {
      console.log(`  ${chalk.red('✗')} Failed to create worktree for ${agent}`);
      // Clean up
      for (const c of arena.contestants) {
        removeWorktree(cwd, c.worktreePath, c.branch);
      }
      try {
        rmSync(arenaDir, { recursive: true });
      } catch {}
      return arena;
    }

    arena.contestants.push({
      agent,
      worktreePath,
      branch,
      status: 'waiting',
    });
  }

  // Save initial state
  const arenas = loadArenas(cwd);
  arenas.push(arena);
  saveArenas(cwd, arenas);

  // 3. Print banner + initial progress
  const lineCount = printBanner(task, agents, testCmd);

  // 4. Start all agents in parallel
  const initialHashes = new Map<string, string>();
  const promises: Promise<void>[] = [];

  for (const contestant of arena.contestants) {
    const hash = getInitialHash(contestant.worktreePath);
    initialHashes.set(contestant.agent, hash);

    contestant.status = 'running';
    contestant.startedAt = new Date().toISOString();

    const promise = (async () => {
      const result = await runAgent(contestant.agent, task, contestant.worktreePath, timeoutMs);

      contestant.finishedAt = new Date().toISOString();
      contestant.exitCode = result.exitCode;
      contestant.output = result.output.slice(0, 10000);
      contestant.status = result.exitCode === 0 ? 'completed' : 'failed';
      contestant.durationSeconds = Math.round(
        (new Date(contestant.finishedAt).getTime() - new Date(contestant.startedAt!).getTime()) / 1000,
      );

      // Get diff stats
      const hash = initialHashes.get(contestant.agent) || '';
      if (hash) {
        const diff = getDiffStats(contestant.worktreePath, hash);
        contestant.filesChanged = diff.filesChanged;
        contestant.linesAdded = diff.linesAdded;
        contestant.linesRemoved = diff.linesRemoved;
        contestant.diffSummary = diff.summary;
      }

      // Run tests if applicable
      if (testCmd && contestant.exitCode === 0) {
        const testResult = runTests(contestant.worktreePath, testCmd);
        contestant.testsPassed = testResult.passed;
        contestant.testOutput = testResult.output;
      }
    })();

    promises.push(promise);
  }

  // 5. Live progress updates
  const progressInterval = setInterval(() => {
    updateProgress(arena.contestants, lineCount);
  }, 1000);

  // Wait for all agents to finish
  await Promise.all(promises);

  clearInterval(progressInterval);
  updateProgress(arena.contestants, lineCount);

  // 6. Score and rank
  scoreContestants(arena.contestants, !!testCmd);

  const best = [...arena.contestants]
    .filter((c) => (c.score || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  arena.winner = best?.agent || null;
  arena.status = 'completed';
  arena.completedAt = new Date().toISOString();

  // 7. Print leaderboard
  printLeaderboard(arena);

  // 8. Save results
  const updatedArenas = loadArenas(cwd);
  const idx = updatedArenas.findIndex((a) => a.id === arenaId);
  if (idx >= 0) {
    updatedArenas[idx] = arena;
  } else {
    updatedArenas.push(arena);
  }
  saveArenas(cwd, updatedArenas);

  // 8b. Fire arena_complete webhook
  try {
    const config = loadConfig(cwd);
    if (config.webhooks?.length) {
      fireWebhooks(config.webhooks, 'arena_complete', {
        arena_id: arena.id,
        task: arena.task,
        winner: arena.winner,
        contestants: arena.contestants.map((c) => ({
          agent: c.agent,
          score: c.score,
          rank: c.rank,
          durationSeconds: c.durationSeconds,
          testsPassed: c.testsPassed,
          filesChanged: c.filesChanged,
        })),
      });
    }
  } catch {}

  // 9. Clean up worktrees (keep branches for review)
  console.log(chalk.dim('  Cleaning up worktrees...'));
  for (const c of arena.contestants) {
    removeWorktree(cwd, c.worktreePath, c.branch);
  }
  try {
    rmSync(arenaDir, { recursive: true });
  } catch {}

  console.log(chalk.dim(`  Results saved. Run ${o('hawkeye arena --list')} to see past arenas.`));
  console.log('');

  return arena;
}

// ─── List arenas ────────────────────────────────────────────

function listArenas(cwd: string): void {
  const arenas = loadArenas(cwd);
  const w = Math.min(process.stdout.columns || 80, 120);
  const hr = (ch: string) => ch.repeat(Math.max(w - 4, 20));

  console.log('');

  if (arenas.length === 0) {
    console.log(chalk.dim('  No arenas yet. Run: hawkeye arena --task "..." --agents claude,aider'));
    console.log('');
    return;
  }

  console.log(`  ${o.bold('Past Arenas')}`);
  console.log(chalk.dim(`  ${hr('─')}`));

  for (const arena of arenas.slice(-20).reverse()) {
    const winner = arena.winner ? chalk.yellow(`🏆 ${arena.winner}`) : chalk.red('no winner');
    const agents = arena.contestants.map((c) => c.agent).join(', ');
    const date = new Date(arena.createdAt).toLocaleDateString();

    console.log(`  ${o.bold(arena.id)}  ${chalk.white(arena.task.slice(0, 50))}${arena.task.length > 50 ? '...' : ''}`);
    console.log(`    ${chalk.dim(date)}  ${chalk.dim('agents:')} ${agents}  ${winner}`);
    console.log('');
  }
}

// ─── Interactive wizard ──────────────────────────────────────

const WIZARD_AGENTS = [
  { name: 'claude', desc: 'Claude Code (Anthropic)' },
  { name: 'aider', desc: 'Aider (AI pair programming)' },
  { name: 'codex', desc: 'Codex CLI (OpenAI)' },
];

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function interactiveArena(cwd: string): Promise<void> {
  const w = Math.min(process.stdout.columns || 80, 120);
  const hr = (ch: string) => ch.repeat(Math.max(w - 4, 20));

  console.log('');
  console.log(chalk.dim(`  ${hr('═')}`));
  console.log(`  ${o.bold('⚔  ARENA SETUP')}`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log('');

  // Step 1: Task
  const task = await prompt(`  ${o('Task')} ${chalk.dim('(what should agents do?):')} `);
  if (!task.trim()) { console.log(chalk.dim('  Cancelled.')); return; }

  // Step 2: Agent selection
  console.log('');
  console.log(chalk.dim('  Available agents:'));
  console.log('');
  for (let i = 0; i < WIZARD_AGENTS.length; i++) {
    const a = WIZARD_AGENTS[i];
    // Check if installed
    let installed = false;
    try {
      execSync(`command -v ${a.name}`, { stdio: 'pipe', timeout: 3000, shell: '/bin/sh' });
      installed = true;
    } catch {}
    const status = installed ? chalk.green('installed') : chalk.dim('not found');
    console.log(`    ${o.bold(`${i + 1})`)} ${chalk.white(a.name)} ${chalk.dim('—')} ${a.desc} ${chalk.dim('[')}${status}${chalk.dim(']')}`);
  }
  console.log(`    ${o.bold(`${WIZARD_AGENTS.length + 1})`)} ${chalk.white('Custom')} ${chalk.dim('— enter a command manually')}`);
  console.log('');

  const agentInput = await prompt(`  ${o('Agents')} ${chalk.dim('(numbers or names, comma-separated, e.g. 1,2):')} `);
  if (!agentInput.trim()) { console.log(chalk.dim('  Cancelled.')); return; }

  const selectedAgents: string[] = [];
  for (const part of agentInput.split(',').map((s) => s.trim()).filter(Boolean)) {
    const num = parseInt(part, 10);
    if (num >= 1 && num <= WIZARD_AGENTS.length) {
      selectedAgents.push(WIZARD_AGENTS[num - 1].name);
    } else if (num === WIZARD_AGENTS.length + 1) {
      const custom = await prompt(`  ${chalk.dim('Custom agent command:')} `);
      if (custom.trim()) selectedAgents.push(custom.trim());
    } else {
      // Treat as agent name
      selectedAgents.push(part);
    }
  }

  if (selectedAgents.length < 2) {
    console.log(`  ${chalk.red('Need at least 2 agents.')} Got: ${selectedAgents.join(', ') || 'none'}`);
    return;
  }

  // Step 3: Test command
  console.log('');
  const testCmd = await prompt(`  ${o('Test command')} ${chalk.dim('(optional, e.g. npm test — press Enter to skip):')} `);

  // Step 4: Timeout
  const timeoutStr = await prompt(`  ${o('Timeout')} ${chalk.dim('per agent in minutes (default 30):')} `);
  const timeoutMin = parseInt(timeoutStr, 10) || 30;
  const timeoutMs = timeoutMin * 60 * 1000;

  // Summary
  console.log('');
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log(`  ${chalk.dim('Task:')}    ${chalk.white(task.trim())}`);
  console.log(`  ${chalk.dim('Agents:')}  ${selectedAgents.map((a) => o.bold(a)).join(chalk.dim(' vs '))}`);
  if (testCmd.trim()) console.log(`  ${chalk.dim('Test:')}    ${chalk.cyan(testCmd.trim())}`);
  console.log(`  ${chalk.dim('Timeout:')} ${timeoutMin}min per agent`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log('');

  const confirm = await prompt(`  ${o('Start arena?')} ${chalk.dim('(Y/n):')} `);
  if (confirm.trim().toLowerCase() === 'n') { console.log(chalk.dim('  Cancelled.')); return; }

  await runArena(task.trim(), selectedAgents, testCmd.trim() || null, timeoutMs, cwd);
}

// ─── Command ────────────────────────────────────────────────

export const arenaCommand = new Command('arena')
  .description('Agent Arena — pit AI agents against each other on the same task')
  .option('-t, --task <prompt>', 'The task for agents to complete')
  .option('-a, --agents <list>', 'Comma-separated list of agents (e.g. claude,aider,codex)')
  .option('--test <command>', 'Test command to validate results (e.g. "npm test")')
  .option('--timeout <seconds>', 'Timeout per agent in seconds', '1800')
  .option('--list', 'List past arena results')
  .action(async (options) => {
    const cwd = process.cwd();

    if (options.list) {
      listArenas(cwd);
      return;
    }

    // No flags → interactive wizard
    if (!options.task && !options.agents) {
      // Check git repo first
      try {
        execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
      } catch {
        console.log(`  ${chalk.red('Not a git repository.')} Arena requires git for isolated worktrees.`);
        return;
      }
      await interactiveArena(cwd);
      return;
    }

    if (!options.task) {
      console.log(`  ${chalk.red('Missing --task.')} Usage: hawkeye arena --task "Build X" --agents claude,aider`);
      return;
    }

    if (!options.agents) {
      console.log(`  ${chalk.red('Missing --agents.')} Example: --agents claude,aider,codex`);
      return;
    }

    const agents = (options.agents as string).split(',').map((a: string) => a.trim()).filter(Boolean);
    if (agents.length < 2) {
      console.log(`  ${chalk.red('Need at least 2 agents.')} Example: --agents claude,aider`);
      return;
    }

    // Check git repo
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
    } catch {
      console.log(`  ${chalk.red('Not a git repository.')} Arena requires git for isolated worktrees.`);
      return;
    }

    // Check for uncommitted changes warning
    try {
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
      if (status) {
        console.log(`  ${chalk.yellow('⚠')} Uncommitted changes detected. Agents will start from the last commit.`);
        console.log(chalk.dim('    Commit your changes first for a fair comparison.'));
        console.log('');
      }
    } catch {}

    const timeoutMs = (parseInt(options.timeout, 10) || 1800) * 1000;
    const testCmd = options.test || null;

    await runArena(options.task, agents, testCmd, timeoutMs, cwd);
  });
