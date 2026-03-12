/**
 * Hawkeye Daemon — background task runner for remote prompt execution.
 *
 * Polls .hawkeye/tasks.json for pending tasks, executes them via
 * `claude -p "prompt"` (or a configurable agent command), and updates
 * task status. Works with Claude Code hooks to capture all events.
 *
 * Usage:
 *   hawkeye daemon                       # Default: uses `claude` CLI
 *   hawkeye daemon --agent "aider"       # Custom agent command
 *   hawkeye daemon --interval 15         # Poll every 15 seconds
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';

const o = chalk.hex('#ff5f1f');

// ─── Task types ──────────────────────────────────────────────

export interface Task {
  id: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  agent: string;
  exitCode?: number;
  output?: string;
  error?: string;
  sessionId?: string;
}

// ─── Task file helpers ───────────────────────────────────────

function getTasksFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'tasks.json');
}

export function loadTasks(cwd: string): Task[] {
  const file = getTasksFile(cwd);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveTasks(cwd: string, tasks: Task[]): void {
  const dir = join(cwd, '.hawkeye');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getTasksFile(cwd), JSON.stringify(tasks, null, 2));
}

export function createTask(cwd: string, prompt: string, agent: string): Task {
  const tasks = loadTasks(cwd);
  const task: Task = {
    id: randomUUID(),
    prompt,
    status: 'pending',
    createdAt: new Date().toISOString(),
    agent,
  };
  tasks.push(task);
  saveTasks(cwd, tasks);
  return task;
}

function updateTask(cwd: string, taskId: string, updates: Partial<Task>): void {
  const tasks = loadTasks(cwd);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx >= 0) {
    Object.assign(tasks[idx], updates);
    saveTasks(cwd, tasks);
  }
}

// ─── Task journal (persistent memory) ────────────────────────

export function getJournalFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'task-journal.md');
}

export function readJournal(cwd: string): string {
  const file = getJournalFile(cwd);
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function appendToJournal(cwd: string, task: Task, gitDiffStat: string): void {
  const file = getJournalFile(cwd);
  const dir = join(cwd, '.hawkeye');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const status = task.status === 'completed' ? 'OK' : 'FAILED';
  const time = new Date(task.completedAt || task.createdAt).toLocaleString();
  const outputSnippet = (task.output || task.error || '').trim().slice(0, 500);

  let entry = `\n## [${status}] ${time}\n`;
  entry += `**Prompt:** ${task.prompt}\n`;
  if (gitDiffStat) entry += `**Files changed:**\n\`\`\`\n${gitDiffStat}\n\`\`\`\n`;
  if (outputSnippet) entry += `**Agent output:** ${outputSnippet}\n`;
  entry += `---\n`;

  // Append to journal
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '# Hawkeye Task Journal\nPersistent memory of all tasks executed by the daemon.\n\n---\n';
  writeFileSync(file, existing + entry);

  // Trim journal if too large (keep last 30 entries)
  trimJournal(cwd);
}

export function clearJournal(cwd: string): void {
  const file = getJournalFile(cwd);
  if (existsSync(file)) writeFileSync(file, '# Hawkeye Task Journal\nPersistent memory of all tasks executed by the daemon.\n\n---\n');
}

function trimJournal(cwd: string): void {
  const file = getJournalFile(cwd);
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf-8');
  const entries = content.split(/\n## \[/);
  if (entries.length <= 31) return; // header + 30 entries
  const header = entries[0];
  const kept = entries.slice(-30).map((e, i) => i === 0 ? `## [${e}` : `\n## [${e}`);
  writeFileSync(file, header + kept.join(''));
}

function getGitDiffStat(cwd: string): string {
  try {
    return execSync('git diff --stat HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

// ─── Context builder ─────────────────────────────────────────

function gatherContext(cwd: string): string {
  const sections: string[] = [];

  // 1. Git status — what files are currently modified
  try {
    const status = execSync('git status --short', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
    if (status) {
      sections.push(`[Current git status]\n${status}`);
    }
  } catch {}

  // 2. Git branch
  try {
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 3000 }).trim();
    if (branch) {
      sections.push(`[Current branch] ${branch}`);
    }
  } catch {}

  // 3. Recent git commits
  try {
    const log = execSync('git log --oneline -5', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
    if (log) {
      sections.push(`[Recent commits]\n${log}`);
    }
  } catch {}

  // 4. Task journal — persistent memory of what was done before
  const journal = readJournal(cwd);
  if (journal) {
    // Include last ~2000 chars of journal to stay within prompt limits
    const trimmed = journal.length > 2000 ? '...\n' + journal.slice(-2000) : journal;
    sections.push(`[Task history — what was done before]\n${trimmed}`);
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

function buildPromptWithContext(task: Task, cwd: string): string {
  const context = gatherContext(cwd);
  if (!context) return task.prompt;
  return `${context}\n\n---\n\n[User request]\n${task.prompt}`;
}

// ─── Execute a task ──────────────────────────────────────────

function shouldContinueSession(agentCmd: string, allTasks: Task[]): boolean {
  // Only for claude agent — use --continue to resume the last conversation
  if (!agentCmd.startsWith('claude')) return false;

  const lastCompleted = allTasks
    .filter((t) => t.status === 'completed' && t.exitCode === 0)
    .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime())[0];

  if (!lastCompleted?.completedAt) return false;

  // Continue if last task completed within the last 30 minutes
  const elapsed = Date.now() - new Date(lastCompleted.completedAt).getTime();
  return elapsed < 30 * 60 * 1000;
}

function executeTask(task: Task, agentCmd: string, cwd: string, allTasks: Task[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    // Split agent command (e.g. "aider --model gpt-4" → ["aider", "--model", "gpt-4"])
    const parts = agentCmd.split(/\s+/);
    const cmd = parts[0];
    const baseArgs = parts.slice(1);

    // For claude: use --continue to resume the last conversation if recent
    const useContinue = shouldContinueSession(agentCmd, allTasks);
    const enrichedPrompt = useContinue ? task.prompt : buildPromptWithContext(task, cwd);
    const args = useContinue
      ? [...baseArgs, '--continue', '-p', enrichedPrompt]
      : [...baseArgs, '-p', enrichedPrompt];

    // Remove CLAUDECODE env var to avoid "nested session" error
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      // Print live output
      process.stdout.write(chalk.dim(text));
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        output: (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '')).slice(0, 50000),
      });
    });

    proc.on('error', (err) => {
      resolve({
        exitCode: 1,
        output: `Failed to start agent: ${err.message}`,
      });
    });
  });
}

// ─── Daemon loop ─────────────────────────────────────────────

async function runDaemon(agentCmd: string, intervalSec: number, cwd: string): Promise<void> {
  console.log('');
  console.log(`  ${o.bold('Hawkeye Daemon')}`);
  console.log(chalk.dim('  ─'.repeat(25)));
  console.log(`  ${chalk.dim('Agent:')}    ${chalk.cyan(agentCmd)}`);
  console.log(`  ${chalk.dim('Interval:')} ${chalk.cyan(`${intervalSec}s`)}`);
  console.log(`  ${chalk.dim('Tasks:')}    ${chalk.cyan(getTasksFile(cwd))}`);
  console.log('');
  console.log(chalk.dim('  Waiting for tasks... (submit via dashboard or POST /api/tasks)'));
  console.log(chalk.dim('  Press Ctrl+C to stop'));
  console.log('');

  let running = false;

  const poll = async () => {
    if (running) return;

    const tasks = loadTasks(cwd);
    const pending = tasks.find((t) => t.status === 'pending');
    if (!pending) return;

    running = true;
    const shortId = pending.id.slice(0, 8);

    console.log(`  ${o('▶')} Task ${o.bold(shortId)}: ${chalk.white(pending.prompt.slice(0, 80))}${pending.prompt.length > 80 ? '...' : ''}`);

    updateTask(cwd, pending.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    // Snapshot git state before task runs
    const diffBefore = getGitDiffStat(cwd);

    try {
      const result = await executeTask(pending, agentCmd, cwd, tasks);

      const status = result.exitCode === 0 ? 'completed' : 'failed';
      const completedAt = new Date().toISOString();
      updateTask(cwd, pending.id, {
        status,
        completedAt,
        exitCode: result.exitCode,
        output: result.output.slice(0, 10000),
        error: result.exitCode !== 0 ? result.output.slice(0, 2000) : undefined,
      });

      // Write to persistent journal — this is the agent's long-term memory
      const diffAfter = getGitDiffStat(cwd);
      const diffChanged = diffAfter !== diffBefore ? diffAfter : '';
      appendToJournal(cwd, { ...pending, status, completedAt, output: result.output.slice(0, 500), error: result.exitCode !== 0 ? result.output.slice(0, 500) : undefined }, diffChanged);

      if (status === 'completed') {
        console.log(`  ${chalk.green('✓')} Task ${o.bold(shortId)} completed`);
      } else {
        console.log(`  ${chalk.red('✗')} Task ${o.bold(shortId)} failed (exit code ${result.exitCode})`);
      }
    } catch (err) {
      updateTask(cwd, pending.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: String(err),
      });
      console.log(`  ${chalk.red('✗')} Task ${o.bold(shortId)} error: ${String(err)}`);
    }

    running = false;
    console.log('');
  };

  // Initial poll
  await poll();

  // Set up interval
  const timer = setInterval(poll, intervalSec * 1000);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(timer);
    console.log(chalk.dim('\n  Daemon stopped.'));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Command ─────────────────────────────────────────────────

export const daemonCommand = new Command('daemon')
  .description('Run the Hawkeye task daemon — executes remote prompts from the task queue')
  .option('--agent <command>', 'Agent CLI command to execute prompts', 'claude')
  .option('--interval <seconds>', 'Poll interval in seconds', '30')
  .action(async (options) => {
    const cwd = process.cwd();
    const agentCmd = options.agent;
    const interval = parseInt(options.interval, 10) || 30;

    await runDaemon(agentCmd, interval, cwd);
  });
