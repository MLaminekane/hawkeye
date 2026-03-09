import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { Storage, type SessionRow, type EventRow } from '@hawkeye/core';
import {
  loadConfig,
  saveConfig,
  getDefaultConfig,
  PROVIDER_MODELS,
  type HawkeyeConfig,
  type GuardrailRuleSetting,
} from './config.js';

const VERSION = '0.1.0';

// ─── Types ───────────────────────────────────────────────────

interface SlashCommand {
  name: string;
  desc: string;
}

type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'return'
  | 'backspace'
  | 'tab'
  | 'escape'
  | 'delete'
  | 'home'
  | 'end'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-l'
  | 'ctrl-u'
  | 'char';

interface Key {
  name: KeyName;
  ch?: string;
}

// ─── Constants ───────────────────────────────────────────────

const COMMANDS: SlashCommand[] = [
  { name: 'new', desc: 'New session (pick agent + objective)' },
  { name: 'attach', desc: 'Launch agent on active session' },
  { name: 'sessions', desc: 'List & manage sessions' },
  { name: 'active', desc: 'Current recording' },
  { name: 'watch', desc: 'Live event stream (tail -f style)' },
  { name: 'stats', desc: 'Session or global statistics' },
  { name: 'inspect', desc: 'Detailed session inspection' },
  { name: 'compare', desc: 'Compare sessions side by side' },
  { name: 'replay', desc: 'Replay a session (interactive)' },
  { name: 'export', desc: 'Export session as JSON' },
  { name: 'end', desc: 'End active sessions' },
  { name: 'restart', desc: 'Restart a session' },
  { name: 'approve', desc: 'Approve pending review gate actions' },
  { name: 'revert', desc: 'Revert file changes' },
  { name: 'delete', desc: 'Delete a session' },
  { name: 'purge', desc: 'Delete ALL sessions (including old)' },
  { name: 'kill', desc: 'Kill hawkeye background processes' },
  { name: 'settings', desc: 'Configure Hawkeye' },
  { name: 'serve', desc: 'Open dashboard :4242' },
  { name: 'init', desc: 'Initialize Hawkeye (auto-runs on /new)' },
  { name: 'clear', desc: 'Clear screen' },
  { name: 'quit', desc: 'Exit' },
];

const o = chalk.hex('#ff5f1f');

// Line queue for piped mode (serializes async sub-prompts)
const lineQueue: string[] = [];
let lineWaiter: ((line: string) => void) | null = null;
let pipedMode = false;

// Last displayed session list — allows picking by number from main prompt
let lastSessions: SessionRow[] = [];

function nextLine(prompt?: string): Promise<string> {
  if (prompt) process.stdout.write(prompt);
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
  return new Promise((resolve) => {
    lineWaiter = resolve;
  });
}

// ─── Helpers ─────────────────────────────────────────────────

function getStorage(dbPath: string): Storage | null {
  if (!existsSync(dbPath)) {
    console.log(chalk.yellow('  No .hawkeye/ directory. Run /init first.'));
    return null;
  }
  return new Storage(dbPath);
}

/** Build a refreshed PATH that includes common tool directories */
function getShellEnv(): Record<string, string> {
  const home = homedir();
  const extraPaths = [
    join(home, '.cargo', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.local', 'pipx', 'venvs'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ].filter((p) => existsSync(p));
  const currentPath = process.env.PATH || '';
  const newPath = [...extraPaths, ...currentPath.split(':')].filter((v, i, a) => a.indexOf(v) === i).join(':');
  return { ...process.env as Record<string, string>, PATH: newPath };
}

function dur(startedAt: string, endedAt: string | null): string {
  const ms = (endedAt ? new Date(endedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function badge(s: string): string {
  if (s === 'recording') return o('● REC');
  if (s === 'completed') return chalk.green('● END');
  return chalk.red('● ABR');
}

function ask(prompt: string): Promise<string> {
  if (pipedMode) return nextLine(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(prompt, (a) => {
      answered = true;
      rl.close();
      resolve(a.trim());
    });
    rl.on('close', () => {
      if (!answered) resolve('');
    });
  });
}

// ─── Display ─────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log(`   ${o('██╗  ██╗')}`);
  console.log(`   ${o('██║  ██║')}`);
  console.log(`   ${o('███████║')}  ${chalk.bold.white('Hawkeye')} ${chalk.dim(`v${VERSION}`)}`);
  console.log(`   ${o('██╔══██║')}  ${chalk.dim('The flight recorder for AI agents')}`);
  console.log(`   ${o('██║  ██║')}  ${chalk.dim(process.cwd())}`);
  console.log(`   ${o('╚═╝  ╚═╝')}`);
  console.log('');
}

function printActiveBar(dbPath: string): void {
  const storage = getStorage(dbPath);
  if (!storage) return;
  const r = storage.listSessions({ status: 'recording', limit: 1 });
  storage.close();
  if (!r.ok || r.value.length === 0) return;
  const s = r.value[0];
  const w = process.stdout.columns || 60;
  console.log(chalk.dim('━'.repeat(w)));
  console.log(
    `  ${o('●')} ${chalk.white(s.objective)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.dim(dur(s.started_at, null))}  ${chalk.dim(`${s.total_actions} actions`)}`,
  );
  console.log(chalk.dim('━'.repeat(w)));
}

function printSession(i: number, s: SessionRow): void {
  console.log(
    `  ${o.bold(`${i})`)} ${badge(s.status)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 35).padEnd(35))}  ${chalk.dim(dur(s.started_at, s.ended_at).padEnd(7))}  ${chalk.dim(String(s.total_actions).padStart(4))}a  ${s.total_cost_usd > 0 ? chalk.hex('#FFB443')('$' + s.total_cost_usd.toFixed(2)) + '  ' : ''}${chalk.dim(timeAgo(s.started_at))}`,
  );
}

function printCommands(): void {
  console.log('');
  for (const cmd of COMMANDS) {
    console.log(`    ${o(`/${cmd.name.padEnd(14)}`)} ${chalk.dim(cmd.desc)}`);
  }
  console.log('');
}

// ─── Key parsing ─────────────────────────────────────────────

function parseKeys(data: Buffer): Key[] {
  const str = data.toString('utf8');
  const keys: Key[] = [];
  let i = 0;

  while (i < str.length) {
    if (str[i] === '\x1b') {
      if (i + 2 < str.length && str[i + 1] === '[') {
        const s = str[i + 2];
        if (s === 'A') { keys.push({ name: 'up' }); i += 3; continue; }
        if (s === 'B') { keys.push({ name: 'down' }); i += 3; continue; }
        if (s === 'C') { keys.push({ name: 'right' }); i += 3; continue; }
        if (s === 'D') { keys.push({ name: 'left' }); i += 3; continue; }
        if (s === 'H') { keys.push({ name: 'home' }); i += 3; continue; }
        if (s === 'F') { keys.push({ name: 'end' }); i += 3; continue; }
        if (s === '3' && i + 3 < str.length && str[i + 3] === '~') {
          keys.push({ name: 'delete' });
          i += 4;
          continue;
        }
        i += 3;
        continue;
      }
      keys.push({ name: 'escape' });
      i++;
      continue;
    }

    const code = str.charCodeAt(i);
    if (code === 13) keys.push({ name: 'return' });
    else if (code === 127 || code === 8) keys.push({ name: 'backspace' });
    else if (code === 9) keys.push({ name: 'tab' });
    else if (code === 3) keys.push({ name: 'ctrl-c' });
    else if (code === 4) keys.push({ name: 'ctrl-d' });
    else if (code === 12) keys.push({ name: 'ctrl-l' });
    else if (code === 21) keys.push({ name: 'ctrl-u' });
    else if (code >= 32) keys.push({ name: 'char', ch: str[i] });
    i++;
  }

  return keys;
}

// ─── Raw prompt with command picker ──────────────────────────

function getFiltered(buffer: string): SlashCommand[] {
  if (!buffer.startsWith('/')) return [];
  const q = buffer.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
}

function rawPrompt(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    let pos = 0;
    let sel = 0;
    let scrollOff = 0;
    let prevLines = 0;
    const PAGE_SIZE = 5;

    const render = () => {
      const filtered = getFiltered(buf);

      // Clamp selection
      if (filtered.length > 0) {
        sel = Math.max(0, Math.min(sel, filtered.length - 1));
      } else {
        sel = 0;
        scrollOff = 0;
      }

      // Adjust scroll offset to keep selection visible
      if (sel < scrollOff) scrollOff = sel;
      if (sel >= scrollOff + PAGE_SIZE) scrollOff = sel - PAGE_SIZE + 1;
      scrollOff = Math.max(0, Math.min(scrollOff, Math.max(0, filtered.length - PAGE_SIZE)));

      // First: clear all previous picker lines (move down, erase, move back)
      if (prevLines > 0) {
        for (let i = 0; i < prevLines; i++) {
          process.stdout.write('\n\x1b[K');
        }
        process.stdout.write(`\x1b[${prevLines}A`);
      }

      // Redraw prompt line
      process.stdout.write(`\r\x1b[K${o('›')} ${buf}`);

      // Ghost text when empty
      if (buf.length === 0) {
        process.stdout.write(chalk.dim('/ for commands'));
      }

      // Draw visible picker lines (windowed)
      const visCount = Math.min(PAGE_SIZE, filtered.length);
      const hasAbove = scrollOff > 0;
      const hasBelow = scrollOff + PAGE_SIZE < filtered.length;
      let lines = 0;

      if (hasAbove) {
        process.stdout.write('\n\x1b[K');
        process.stdout.write(chalk.dim('    ↑ more'));
        lines++;
      }

      for (let i = 0; i < visCount; i++) {
        const idx = scrollOff + i;
        process.stdout.write('\n\x1b[K');
        const isSel = idx === sel;
        const arrow = isSel ? o(' ❯') : '  ';
        const name = isSel
          ? o.bold(`/${filtered[idx].name.padEnd(14)}`)
          : chalk.dim(`/${filtered[idx].name.padEnd(14)}`);
        process.stdout.write(`${arrow} ${name} ${chalk.dim(filtered[idx].desc)}`);
        lines++;
      }

      if (hasBelow) {
        process.stdout.write('\n\x1b[K');
        process.stdout.write(chalk.dim('    ↓ more'));
        lines++;
      }

      // Move cursor back up to prompt line
      if (lines > 0) {
        process.stdout.write(`\x1b[${lines}A`);
      }

      // Position cursor on prompt line (col = 3 + pos, 1-based)
      process.stdout.write(`\x1b[${3 + pos}G`);

      prevLines = lines;
    };

    const clearPicker = () => {
      for (let i = 0; i < prevLines; i++) {
        process.stdout.write('\n\x1b[K');
      }
      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A`);
      }
      prevLines = 0;
    };

    const finish = (result: string) => {
      clearPicker();
      process.stdout.write(`\r\x1b[K${o('›')} ${chalk.dim(result)}\n`);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(result);
    };

    const onData = (data: Buffer) => {
      const keys = parseKeys(data);

      for (const key of keys) {
        const filtered = getFiltered(buf);

        switch (key.name) {
          case 'char':
            buf = buf.slice(0, pos) + (key.ch || '') + buf.slice(pos);
            pos++;
            sel = 0;
            scrollOff = 0;
            break;

          case 'backspace':
            if (pos > 0) {
              buf = buf.slice(0, pos - 1) + buf.slice(pos);
              pos--;
              sel = 0;
              scrollOff = 0;
            }
            break;

          case 'delete':
            if (pos < buf.length) {
              buf = buf.slice(0, pos) + buf.slice(pos + 1);
            }
            break;

          case 'left':
            pos = Math.max(0, pos - 1);
            break;

          case 'right':
            pos = Math.min(buf.length, pos + 1);
            break;

          case 'home':
            pos = 0;
            break;

          case 'end':
            pos = buf.length;
            break;

          case 'up':
            if (filtered.length > 0) {
              sel = (sel - 1 + filtered.length) % filtered.length;
            }
            break;

          case 'down':
            if (filtered.length > 0) {
              sel = (sel + 1) % filtered.length;
            }
            break;

          case 'tab':
            if (filtered.length > 0 && sel < filtered.length) {
              buf = '/' + filtered[sel].name;
              pos = buf.length;
            }
            break;

          case 'return': {
            let result = buf;
            if (filtered.length > 0 && sel < filtered.length) {
              result = filtered[sel].name;
            } else if (buf.startsWith('/')) {
              result = buf.slice(1);
            }
            finish(result.trim());
            return;
          }

          case 'escape':
            if (buf.length > 0) {
              buf = '';
              pos = 0;
              sel = 0;
              scrollOff = 0;
            }
            break;

          case 'ctrl-c':
            clearPicker();
            process.stdout.write('\n');
            process.stdin.setRawMode(false);
            process.exit(0);
            break;

          case 'ctrl-d':
            if (buf.length === 0) {
              clearPicker();
              process.stdout.write('\n');
              process.stdin.setRawMode(false);
              process.exit(0);
            }
            break;

          case 'ctrl-u':
            buf = buf.slice(pos);
            pos = 0;
            sel = 0;
            scrollOff = 0;
            break;

          case 'ctrl-l':
            process.stdout.write('\x1b[2J\x1b[H');
            prevLines = 0;
            break;
        }
      }

      render();
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

// ─── Command execution ───────────────────────────────────────

async function executeCommand(cmd: string, dbPath: string, cwd: string): Promise<boolean> {
  const [name, ...rest] = cmd.split(' ');
  const args = rest.join(' ');
  const c = name.toLowerCase();

  // Handle numeric input → session selection
  const num = parseInt(c, 10);
  if (!isNaN(num) && num >= 1 && num <= lastSessions.length) {
    await sessionMenu(lastSessions[num - 1], dbPath, cwd);
    return false;
  }

  if (c === 'sessions') {
    cmdSessions(dbPath);
  } else if (c === 'new') {
    await cmdNew(cwd);
  } else if (c === 'attach') {
    await cmdAttach(dbPath, cwd);
  } else if (c === 'active') {
    cmdActive(dbPath);
  } else if (c === 'watch') {
    await cmdWatch(dbPath, args);
  } else if (c === 'stats') {
    await cmdStats(dbPath, args);
  } else if (c === 'replay') {
    await cmdReplay(dbPath, args);
  } else if (c === 'export') {
    await cmdExport(dbPath, args);
  } else if (c === 'end') {
    await cmdEnd(dbPath, args);
  } else if (c === 'restart') {
    await cmdRestart(dbPath, cwd, args);
  } else if (c === 'revert') {
    await cmdRevert(dbPath, cwd, args);
  } else if (c === 'approve') {
    await cmdApprove(cwd);
  } else if (c === 'delete') {
    await cmdDelete(dbPath, args);
  } else if (c === 'purge') {
    await cmdPurge(dbPath);
  } else if (c === 'kill') {
    await cmdKill();
  } else if (c === 'inspect') {
    await cmdInspect(dbPath, args);
  } else if (c === 'compare') {
    await cmdCompare(dbPath, args);
  } else if (c === 'settings') {
    await cmdSettings(cwd);
  } else if (c === 'serve') {
    await cmdServe();
  } else if (c === 'init') {
    await cmdInit();
  } else if (c === 'clear') {
    console.clear();
    return true;
  } else if (c === 'quit' || c === 'exit' || c === 'q') {
    console.log('');
    process.exit(0);
  } else if (c === 'help') {
    printCommands();
  } else {
    // Run as shell command
    await runShellCommand(cmd);
  }

  return false;
}

// ─── Individual commands ─────────────────────────────────────

function cmdSessions(dbPath: string): void {
  const db = getStorage(dbPath);
  if (!db) return;
  const r = db.listSessions({ limit: 15 });
  db.close();
  if (!r.ok || r.value.length === 0) {
    console.log(chalk.dim('  No sessions.'));
    lastSessions = [];
    return;
  }
  lastSessions = r.value;
  console.log('');
  for (let i = 0; i < r.value.length; i++) printSession(i + 1, r.value[i]);
  console.log(chalk.dim('  Type a number to select a session'));
}

function cmdActive(dbPath: string): void {
  const db = getStorage(dbPath);
  if (!db) return;
  const r = db.listSessions({ status: 'recording' });
  db.close();
  if (!r.ok || r.value.length === 0) {
    console.log(chalk.dim('  No active session.'));
    return;
  }
  for (const s of r.value) {
    console.log(
      `  ${o('●')} ${chalk.white(s.objective)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.dim(dur(s.started_at, null))}  ${chalk.dim(`${s.total_actions}a`)}`,
    );
  }
}

async function cmdWatch(dbPath: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  // Find recording or paused sessions
  let candidates: SessionRow[] = [];
  const recResult = db.listSessions({ status: 'recording' });
  if (recResult.ok) candidates.push(...recResult.value);
  if (candidates.length === 0) {
    const pausedResult = db.listSessions({ status: 'paused' });
    if (pausedResult.ok) candidates.push(...pausedResult.value);
  }
  if (candidates.length === 0) {
    console.log(chalk.dim('  No active or paused sessions to watch.'));
    db.close();
    return;
  }

  let session: SessionRow;

  if (args) {
    // Resolve session ID from args
    const match = candidates.find((s) => s.id === args || s.id.startsWith(args));
    if (!match) {
      console.log(chalk.red(`  Not found: ${args}`));
      db.close();
      return;
    }
    session = match;
  } else if (candidates.length === 1) {
    session = candidates[0];
  } else {
    // Multiple active sessions — let user pick
    console.log('');
    console.log(chalk.bold.white('  Active sessions:'));
    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i];
      console.log(
        `  ${o.bold(`${i + 1})`)} ${badge(s.status)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 40))}  ${chalk.dim(dur(s.started_at, null))}`,
      );
    }
    console.log('');
    db.close();
    const pick = await ask(chalk.dim('  # ') + o('› '));
    const idx = parseInt(pick, 10) - 1;
    if (idx < 0 || idx >= candidates.length) return;
    session = candidates[idx];
    // Re-open db for the watch loop
    const db2 = getStorage(dbPath);
    if (!db2) return;
    return runWatchLoop(db2, session);
  }

  return runWatchLoop(db, session);
}

async function runWatchLoop(db: Storage, session: SessionRow): Promise<void> {
  const POLL_MS = 1000;

  // Event type icons
  const watchIcons: Record<string, string> = {
    command: chalk.blue('$'),
    file_write: chalk.green('\u270e'),
    file_read: chalk.dim('\u25c9'),
    file_delete: chalk.red('\u2715'),
    llm_call: chalk.magenta('\u26a1'),
    api_call: chalk.cyan('\u2197'),
    guardrail_trigger: chalk.red('\u26d4'),
    guardrail_block: chalk.red('\u26d4'),
    error: chalk.red('\u2718'),
    git_commit: chalk.green('\u25cf'),
    git_push: chalk.cyan('\u2191'),
    git_checkout: chalk.yellow('\u21b7'),
    git_pull: chalk.cyan('\u2193'),
    git_merge: chalk.magenta('\u2934'),
    drift_alert: chalk.yellow('\u26a0'),
  };

  function driftColor(score: number | null): (s: string) => string {
    if (score == null) return chalk.dim;
    if (score >= 70) return chalk.green;
    if (score >= 40) return chalk.hex('#f0a830');
    return chalk.red;
  }

  function formatEventLine(e: EventRow): string {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const icon = watchIcons[e.type] || chalk.dim('\u00b7');
    const parsed = JSON.parse(e.data) as Record<string, unknown>;
    let summary = e.type;

    if (e.type === 'command') {
      const cmd = String(parsed.command || '');
      const cmdArgs = ((parsed.args as string[]) || []).join(' ');
      summary = `${cmd} ${cmdArgs}`.trim();
    } else if (e.type === 'file_write') {
      summary = String(parsed.path || '');
    } else if (e.type === 'file_read') {
      summary = String(parsed.path || '');
    } else if (e.type === 'file_delete') {
      summary = String(parsed.path || '');
    } else if (e.type === 'llm_call') {
      const model = `${parsed.provider || '?'}/${parsed.model || '?'}`;
      const tokens = (parsed.totalTokens as number) || 0;
      summary = `${model} ${tokens > 0 ? chalk.dim(`${tokens.toLocaleString()} tok`) : ''}`;
    } else if (e.type === 'api_call') {
      summary = String(parsed.url || parsed.hostname || '');
    } else if (e.type === 'error') {
      summary = String(parsed.message || parsed.error || 'error');
    } else if (e.type === 'guardrail_trigger' || e.type === 'guardrail_block') {
      summary = String(parsed.rule || parsed.message || 'guardrail');
    } else if (e.type.startsWith('git_')) {
      summary = String(parsed.message || parsed.branch || e.type);
    }

    const cost = e.cost_usd > 0 ? chalk.yellow(` $${e.cost_usd.toFixed(4)}`) : '';
    const drift =
      e.drift_score != null
        ? ' ' + driftColor(e.drift_score)(`[${e.drift_score.toFixed(0)}]`)
        : '';

    return `  ${chalk.dim(time)} ${icon} ${summary.slice(0, 60)}${cost}${drift}`;
  }

  // Get initial events to determine baseline
  const initEvents = db.getEvents(session.id);
  const allEvents = initEvents.ok ? initEvents.value : [];
  let lastSeenSeq = allEvents.length > 0 ? allEvents[allEvents.length - 1].sequence : -1;

  // Print initial header (blank lines that will be overwritten)
  const w = process.stdout.columns || 80;
  console.log('');
  console.log(chalk.dim('━'.repeat(w)));
  console.log(`  ${badge(session.status)}  ${chalk.bold.white(session.objective.slice(0, 40))}  ${chalk.dim(session.id.slice(0, 8))}  ${chalk.dim(dur(session.started_at, null))}`);
  console.log(`  ${chalk.dim(session.agent || '?')}  ${chalk.dim('drift:—')}  ${chalk.dim('$0.00')}  ${chalk.dim(`${allEvents.length} actions`)}`);
  console.log(`  ${chalk.dim('[q]uit  [p]ause/resume')}`);
  console.log(chalk.dim('━'.repeat(w)));

  // Show last 10 events as initial context
  const tail = allEvents.slice(-10);
  if (tail.length > 0) {
    if (allEvents.length > 10) {
      console.log(chalk.dim(`  ... ${allEvents.length - 10} earlier events`));
    }
    for (const e of tail) {
      console.log(formatEventLine(e));
    }
  } else {
    console.log(chalk.dim('  Waiting for events...'));
  }

  // Set up raw mode for keypress listening
  let watching = true;
  const wasRaw = process.stdin.isRaw;

  return new Promise<void>((resolve) => {
    const onData = (data: Buffer) => {
      const keys = parseKeys(data);
      for (const key of keys) {
        if (key.name === 'escape' || (key.name === 'char' && key.ch === 'q')) {
          watching = false;
          cleanup();
          return;
        }
        if (key.name === 'char' && key.ch === 'p') {
          // Toggle pause/resume
          const freshSession = db.getSession(session.id);
          if (!freshSession.ok || !freshSession.value) return;
          const current = freshSession.value;
          if (current.status === 'recording') {
            db.pauseSession(session.id);
            console.log(`  ${chalk.blue('\u23f8')} ${chalk.blue('Session paused')}`);
          } else if (current.status === 'paused') {
            db.resumeSession(session.id);
            console.log(`  ${o('\u25cf')} ${chalk.green('Session resumed')}`);
          }
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);

    const interval = setInterval(() => {
      if (!watching) return;

      // Refresh session data
      const sr = db.getSession(session.id);
      if (!sr.ok || !sr.value) return;
      session = sr.value;

      // Compute live stats from events (session table only updates on end)
      const evResult = db.getEvents(session.id);
      const events = evResult.ok ? evResult.value : [];
      const liveActions = events.length;
      const liveCost = events.reduce((sum, e) => sum + (e.cost_usd || 0), 0);
      const liveTokens = events.reduce((sum, e) => {
        try {
          const d = JSON.parse(e.data) as Record<string, unknown>;
          return sum + ((d.totalTokens as number) || 0);
        } catch {
          return sum;
        }
      }, 0);

      // Get latest drift score from drift_snapshots
      const driftSnaps = db.getDriftSnapshots(session.id);
      const drifts = driftSnaps.ok ? driftSnaps.value : [];
      const latestDrift = drifts.length > 0 ? drifts[drifts.length - 1].score : null;

      // Build live session object for header
      const liveSession: SessionRow = {
        ...session,
        total_cost_usd: liveCost,
        total_tokens: liveTokens,
        total_actions: liveActions,
        final_drift_score: latestDrift,
      };

      // Find new events
      const newEvents = events.filter((e) => e.sequence > lastSeenSeq);

      // Print new events
      for (const e of newEvents) {
        console.log(formatEventLine(e));

        // Inline drift alerts
        if (e.drift_score != null && e.drift_score < 40) {
          console.log(
            `  ${chalk.red('\u26a0 DRIFT CRITICAL')} ${chalk.red(`score: ${e.drift_score.toFixed(0)}/100`)}${e.drift_flag ? chalk.dim(` — ${e.drift_flag}`) : ''}`,
          );
        } else if (e.drift_score != null && e.drift_score < 70) {
          console.log(
            `  ${chalk.hex('#f0a830')('\u26a0 drift warning')} ${chalk.hex('#f0a830')(`score: ${e.drift_score.toFixed(0)}/100`)}`,
          );
        }
      }

      if (newEvents.length > 0) {
        lastSeenSeq = newEvents[newEvents.length - 1].sequence;
      }

      // Check for new drift snapshots with alerts
      if (drifts.length > 0) {
        const latest = drifts[drifts.length - 1];
        if (latest.score < 40 && latest.reason) {
          // Only show if it's recent (within last 2 poll cycles)
          const snapAge = Date.now() - new Date(latest.created_at).getTime();
          if (snapAge < POLL_MS * 2.5) {
            console.log(
              `  ${chalk.red('\u2501\u2501\u2501 DRIFT ALERT \u2501\u2501\u2501')} ${chalk.red(latest.score.toFixed(0) + '/100')} ${chalk.dim(latest.reason)}`,
            );
          }
        }
      }

      // Redraw header by moving cursor up past newly printed lines + header
      // We need a smarter approach: save cursor, move to top, redraw header, restore
      // Using ANSI save/restore cursor
      process.stdout.write('\x1b7'); // save cursor position
      // Move to the header location: we need to track how many lines have been printed
      // Simpler approach: just use the terminal title for live status
      process.stdout.write(
        `\x1b]0;Hawkeye Watch: ${liveSession.objective.slice(0, 30)} | ${liveSession.status} | ${liveActions}a | $${liveCost.toFixed(2)} | drift:${latestDrift != null ? latestDrift.toFixed(0) : '—'}\x07`,
      );
      process.stdout.write('\x1b8'); // restore cursor position

      // Check if session ended
      if (session.status === 'completed' || session.status === 'aborted') {
        console.log('');
        console.log(`  ${chalk.green('\u2713')} Session ${session.status} (${dur(session.started_at, session.ended_at)})`);
        watching = false;
        cleanup();
      }
    }, POLL_MS);

    function cleanup() {
      clearInterval(interval);
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      // Reset terminal title
      process.stdout.write('\x1b]0;\x07');
      db.close();
      console.log('');
      console.log(chalk.dim('  Watch ended.'));
      resolve();
    }
  });
}

async function cmdStats(dbPath: string, sid: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  if (!sid) {
    // Offer global stats or session pick
    console.log('');
    console.log(`  ${o.bold('0)')} ${o('Global stats (all sessions)')}`);
    const r = db.listSessions({ limit: 10 });
    const sessions = r.ok ? r.value : [];
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      console.log(
        `  ${o.bold(`${i + 1})`)} ${badge(s.status)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 40))}`,
      );
    }
    console.log('');
    const pick = await ask(`  ${o('›')} `);
    const idx = parseInt(pick, 10);

    if (idx === 0 || pick === '') {
      // Global stats
      const gs = db.getGlobalStats();
      db.close();
      if (!gs.ok) {
        console.log(chalk.red('  Could not load global stats'));
        return;
      }
      const g = gs.value;
      console.log('');
      console.log(chalk.bold.white('  Global Statistics'));
      console.log(chalk.dim('  ─'.repeat(20)));
      console.log(`  ${chalk.dim('Sessions:')}     ${o.bold(String(g.total_sessions))} ${chalk.dim(`(${g.active_sessions} active, ${g.completed_sessions} completed, ${g.aborted_sessions} aborted)`)}`);
      console.log(`  ${chalk.dim('Actions:')}      ${o.bold(String(g.total_actions))}`);
      console.log(`  ${chalk.dim('Total cost:')}   ${chalk.hex('#FFB443')('$' + g.total_cost_usd.toFixed(4))}`);
      console.log(`  ${chalk.dim('Total tokens:')} ${o.bold(g.total_tokens.toLocaleString())}`);
      if (g.avg_drift_score > 0) {
        const dColor = g.avg_drift_score >= 70 ? chalk.green : g.avg_drift_score >= 40 ? chalk.yellow : chalk.red;
        console.log(`  ${chalk.dim('Avg drift:')}    ${dColor(g.avg_drift_score.toFixed(0) + '/100')}`);
      }
      if (g.first_session) console.log(`  ${chalk.dim('First:')}        ${chalk.dim(g.first_session)}`);
      if (g.last_session) console.log(`  ${chalk.dim('Last:')}         ${chalk.dim(g.last_session)}`);
      return;
    }

    if (idx >= 1 && idx <= sessions.length) {
      sid = sessions[idx - 1].id;
    } else {
      db.close();
      return;
    }
  }

  const sr = db.getSession(sid);
  if (!sr.ok || !sr.value) {
    console.log(chalk.red(`  Not found: ${sid}`));
    db.close();
    return;
  }
  const ev = db.getEvents(sr.value.id);
  db.close();
  const events = ev.ok ? ev.value : [];
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  console.log(
    `  ${badge(sr.value.status)}  ${chalk.dim(sr.value.id.slice(0, 8))}  ${chalk.white(sr.value.objective)}`,
  );
  const costStr = sr.value.total_cost_usd > 0 ? ` · $${sr.value.total_cost_usd.toFixed(4)}` : '';
  const tokStr = sr.value.total_tokens > 0 ? ` · ${sr.value.total_tokens.toLocaleString()} tok` : '';
  console.log(
    `  ${chalk.dim(`${dur(sr.value.started_at, sr.value.ended_at)} · ${sr.value.total_actions} actions${tokStr}${costStr}`)}`,
  );
  if (Object.keys(counts).length > 0) {
    console.log('');
    for (const [t, ct] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${chalk.dim(t.padEnd(18))} ${o('█'.repeat(Math.min(ct, 30)))} ${ct}`);
    }
  }
}

async function cmdEnd(dbPath: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  // Direct end by ID
  if (args) {
    const r = db.getSession(args);
    if (r.ok && r.value && (r.value.status === 'recording' || r.value.status === 'paused')) {
      db.endSession(r.value.id, 'completed');
      console.log(chalk.green(`  ✓ Ended ${r.value.id.slice(0, 8)}`));
    } else {
      console.log(chalk.dim('  Nothing to end.'));
    }
    db.close();
    return;
  }

  // List active sessions (recording + paused)
  const rec = db.listSessions({ status: 'recording' });
  const paused = db.listSessions({ status: 'paused' as 'recording' });
  const active = [...(rec.ok ? rec.value : []), ...(paused.ok ? paused.value : [])];

  if (active.length === 0) {
    console.log(chalk.dim('  No active sessions.'));
    db.close();
    return;
  }

  console.log('');
  console.log(chalk.bold.white('  Active Sessions'));
  console.log(chalk.dim('  ─'.repeat(25)));
  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    const st = s.status === 'paused' ? chalk.blue('⏸') : o('●');
    console.log(
      `  ${o.bold(`${i + 1})`)} ${st}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 35))}  ${chalk.dim(dur(s.started_at, null))}  ${chalk.dim(`${s.total_actions}a`)}`,
    );
  }
  if (active.length > 1) {
    console.log(`  ${o.bold(`${active.length + 1})`)} ${chalk.white('End all')}`);
  }
  console.log('');

  const pick = await ask(`  ${o('›')} `);
  const idx = parseInt(pick, 10);

  if (active.length > 1 && (idx === active.length + 1 || pick.toLowerCase() === 'all')) {
    for (const s of active) {
      db.endSession(s.id, 'completed');
      console.log(chalk.green(`  ✓ Ended ${s.id.slice(0, 8)} — ${s.objective.slice(0, 40)}`));
    }
  } else if (idx >= 1 && idx <= active.length) {
    const s = active[idx - 1];
    db.endSession(s.id, 'completed');
    console.log(chalk.green(`  ✓ Ended ${s.id.slice(0, 8)} — ${s.objective.slice(0, 40)}`));
  } else if (pick) {
    console.log(chalk.dim('  Invalid selection.'));
  }

  db.close();
}

// ─── Agent definitions for /new ──────────────────────────────

interface AgentDef {
  name: string;
  command: string;
  description: string;
  needsInstall?: string;
  usesHooks?: boolean;
}

const AGENTS: AgentDef[] = [
  { name: 'Claude Code', command: 'claude', description: 'Anthropic Claude Code CLI', usesHooks: true },
  { name: 'Aider', command: 'aider', description: 'AI pair programming (supports DeepSeek, OpenAI, etc.)', needsInstall: 'brew install aider' },
  { name: 'Cursor', command: 'cursor', description: 'Cursor AI editor', needsInstall: 'Download from https://cursor.com' },
  { name: 'Open Interpreter', command: 'interpreter', description: 'Natural language → code execution', needsInstall: 'pipx install open-interpreter' },
  { name: 'Custom command', command: '', description: 'Enter any command manually' },
];

async function cmdNew(cwd: string): Promise<void> {
  console.log('');
  console.log(chalk.bold.white('  New Session'));
  console.log(chalk.dim('  ─'.repeat(25)));
  console.log('');

  // 1. Pick agent
  console.log(chalk.dim('  Choose an AI agent:'));
  console.log('');
  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i];
    console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(a.name)}  ${chalk.dim(a.description)}`);
  }
  console.log('');
  const pick = await ask(`  ${o('›')} `);
  const idx = parseInt(pick, 10);
  if (isNaN(idx) || idx < 1 || idx > AGENTS.length) return;
  const agent = AGENTS[idx - 1];

  // 2. Check if command is available (except custom)
  let cmd = agent.command;
  if (agent.name === 'Custom command') {
    cmd = await ask(`  ${chalk.dim('Command to run:')} `);
    if (!cmd) return;
  } else if (agent.usesHooks) {
    // Claude Code uses hooks, not record
    const obj = await ask(`  ${chalk.dim('Objective:')} `);
    if (!obj) return;

    console.log('');
    console.log(chalk.dim('  Claude Code uses hooks for full event capture.'));

    // Check if hooks are installed
    const { existsSync: ex, readFileSync: rf } = await import('node:fs');
    const settingsPath = join(cwd, '.claude', 'settings.json');
    let hooksInstalled = false;
    if (ex(settingsPath)) {
      try {
        const s = JSON.parse(rf(settingsPath, 'utf-8'));
        hooksInstalled = !!(s.hooks?.PreToolUse || s.hooks?.PostToolUse);
      } catch {}
    }

    if (!hooksInstalled) {
      console.log(chalk.yellow('  ⚠ Hooks not installed. Installing...'));
      const { spawn: sp } = await import('node:child_process');
      const child = sp(process.execPath, [process.argv[1], 'hooks', 'install'], { stdio: 'inherit' });
      await new Promise<void>((res) => child.on('close', () => res()));
    } else {
      console.log(chalk.green('  ✓ Hooks already installed'));
    }

    // Ensure .hawkeye directory exists (auto-init)
    const hawkDir = join(cwd, '.hawkeye');
    if (!ex(hawkDir)) {
      const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
      mk(hawkDir, { recursive: true });
      wf(join(hawkDir, 'config.json'), JSON.stringify(getDefaultConfig(), null, 2), 'utf-8');
    }
    const dbPath = join(hawkDir, 'traces.db');
    const db = new Storage(dbPath);
    // End any active sessions
    const rec = db.listSessions({ status: 'recording' });
    const active = rec.ok ? rec.value : [];
    for (const s of active) db.endSession(s.id, 'completed');

    // Pre-create session in DB so it's immediately visible in dashboard
    const sessionId = randomUUID();
    db.createSession({
      id: sessionId,
      objective: obj,
      startedAt: new Date(),
      status: 'recording',
      metadata: { agent: 'claude-code', workingDir: cwd },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
    });
    db.close();

    // Write pending session so hook-handler links Claude's session_id to ours
    const { writeFileSync: wfs } = await import('node:fs');
    wfs(join(hawkDir, 'pending-session.json'), JSON.stringify({ sessionId, objective: obj }), 'utf-8');

    console.log('');
    console.log(chalk.green('  ✓ Ready!'));
    console.log(chalk.dim(`    Objective: ${obj}`));
    console.log('');
    console.log(`  Now run ${o('claude')} in your terminal.`);
    console.log(chalk.dim('  Hawkeye hooks will automatically record all actions.'));
    console.log('');
    return;
  }

  // 3. For non-hooks agents: ask objective, then launch
  const obj = await ask(`  ${chalk.dim('Objective:')} `);
  if (!obj) return;

  // Check if agent command exists
  const { execSync } = await import('node:child_process');
  const { existsSync: exs } = await import('node:fs');
  const shellEnv = getShellEnv();
  let cmdExists = false;
  try {
    execSync(`which ${cmd.split(' ')[0]}`, { stdio: 'ignore', env: shellEnv });
    cmdExists = true;
  } catch {}

  // Fallback: Cursor macOS app path
  if (!cmdExists && agent.name === 'Cursor') {
    const cursorAppCli = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
    if (exs(cursorAppCli)) {
      cmd = cursorAppCli;
      cmdExists = true;
    }
  }

  if (!cmdExists) {
    console.log('');
    console.log(chalk.red(`  ✗ "${cmd.split(' ')[0]}" not found in PATH`));
    if (agent.needsInstall && !agent.needsInstall.startsWith('Download')) {
      console.log(chalk.dim(`  Install: ${o(agent.needsInstall)}`));
      const yn = await ask(`  ${chalk.dim('Install now? (Y/n)')} `);
      if (!yn || yn.toLowerCase() === 'y' || yn.toLowerCase() === 'yes') {
        console.log('');
        console.log(chalk.dim(`  Running: ${agent.needsInstall}`));
        console.log('');
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(agent.needsInstall, { stdio: 'inherit', shell: true, env: shellEnv });
        if (result.status === 0) {
          console.log('');
          console.log(chalk.green(`  ✓ Installed! Continuing...`));
          console.log('');
          // Re-check with refreshed env
          const freshEnv = getShellEnv();
          try { execSync(`which ${cmd.split(' ')[0]}`, { stdio: 'ignore', env: freshEnv }); cmdExists = true; } catch {}
          if (!cmdExists) {
            console.log(chalk.red(`  ✗ Still not found after install. Check your PATH.`));
            console.log('');
            return;
          }
        } else {
          console.log('');
          console.log(chalk.red(`  ✗ Installation failed`));
          console.log('');
          return;
        }
      } else {
        console.log('');
        return;
      }
    } else {
      if (agent.needsInstall) {
        console.log(chalk.dim(`  ${o(agent.needsInstall)}`));
      }
      console.log('');
      return;
    }
  }

  // 4. For Aider: ask which model to use
  let fullCmd = cmd;
  if (agent.name === 'Aider') {
    console.log('');
    console.log(chalk.dim('  Pick a model for Aider:'));
    console.log('');
    const models = [
      { label: 'DeepSeek Chat', value: 'deepseek/deepseek-chat' },
      { label: 'DeepSeek Reasoner', value: 'deepseek/deepseek-reasoner' },
      { label: 'Claude Sonnet', value: 'anthropic/claude-sonnet-4-6' },
      { label: 'Claude Opus', value: 'anthropic/claude-opus-4-6' },
      { label: 'GPT-4o', value: 'openai/gpt-4o' },
      { label: 'GPT-4.1', value: 'openai/gpt-4.1' },
      { label: 'Ollama (local)', value: 'ollama/llama3.2' },
      { label: 'Custom', value: '' },
    ];
    for (let i = 0; i < models.length; i++) {
      console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(models[i].label)}`);
    }
    console.log('');
    const mPick = await ask(`  ${o('›')} `);
    const mIdx = parseInt(mPick, 10);
    if (mIdx >= 1 && mIdx <= models.length) {
      let model = models[mIdx - 1].value;
      if (!model) {
        model = await ask(`  ${chalk.dim('Model name:')} `);
      }
      if (model) {
        fullCmd = `aider --model ${model}`;
      }
    }
  }

  // 5. Launch hawkeye record
  // Extract model from command (e.g. "aider --model deepseek/deepseek-chat" → "deepseek/deepseek-chat")
  const modelMatch = fullCmd.match(/--model\s+(\S+)/);
  const modelArg = modelMatch ? modelMatch[1] : null;
  console.log('');
  console.log(chalk.dim(`  Launching: hawkeye record -o "${obj}"${modelArg ? ` -m ${modelArg}` : ''} -- ${fullCmd}`));
  console.log('');

  const { spawn: sp } = await import('node:child_process');
  const args = ['record', '-o', obj, ...(modelArg ? ['-m', modelArg] : []), '--', ...fullCmd.split(' ')];
  const child = sp(process.execPath, [process.argv[1], ...args], {
    stdio: 'inherit',
    cwd,
  });
  await new Promise<void>((res) => child.on('close', () => res()));
}

async function cmdAttach(dbPath: string, cwd: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  // Find active (recording) sessions
  const rec = db.listSessions({ status: 'recording' });
  const active = rec.ok ? rec.value : [];
  if (active.length === 0) {
    console.log(chalk.dim('  No active sessions to attach to.'));
    db.close();
    return;
  }

  // Pick session
  let session = active[0];
  if (active.length > 1) {
    console.log('');
    console.log(chalk.bold.white('  Active Sessions'));
    console.log(chalk.dim('  ─'.repeat(25)));
    for (let i = 0; i < active.length; i++) {
      console.log(
        `  ${o.bold(`${i + 1})`)} ${chalk.dim(active[i].id.slice(0, 8))}  ${chalk.white(active[i].objective.slice(0, 40))}  ${chalk.dim(dur(active[i].started_at, null))}`,
      );
    }
    console.log('');
    const pick = await ask(`  ${o('›')} `);
    const idx = parseInt(pick, 10);
    if (idx >= 1 && idx <= active.length) {
      session = active[idx - 1];
    } else {
      db.close();
      return;
    }
  }
  db.close();

  console.log('');
  console.log(chalk.bold.white('  Attach Agent'));
  console.log(chalk.dim('  ─'.repeat(25)));
  console.log(`  ${chalk.dim('Session:')} ${o(session.id.slice(0, 8))} — ${chalk.white(session.objective)}`);
  console.log('');

  // Pick agent (full list including Claude Code)
  console.log(chalk.dim('  Choose an AI agent:'));
  console.log('');
  for (let i = 0; i < AGENTS.length; i++) {
    console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(AGENTS[i].name)}  ${chalk.dim(AGENTS[i].description)}`);
  }
  console.log(`  ${chalk.dim('0)')} ${chalk.dim('Back')}`);
  console.log('');
  const aPick = await ask(`  ${o('›')} `);
  const aIdx = parseInt(aPick, 10);
  if (isNaN(aIdx) || aIdx === 0 || aIdx < 0 || aIdx > AGENTS.length) return;
  const agent = AGENTS[aIdx - 1];

  // Claude Code uses hooks — write pending-session so hooks link to this session
  if (agent.usesHooks) {
    const hawkDir = join(cwd, '.hawkeye');
    const { writeFileSync: wfs } = await import('node:fs');
    wfs(join(hawkDir, 'pending-session.json'), JSON.stringify({ sessionId: session.id, objective: session.objective }), 'utf-8');
    console.log(chalk.dim(`  Hooks will attach to session ${o(session.id.slice(0, 8))}`));
    console.log(chalk.dim(`  Launch Claude Code manually, then start working.`));
    console.log('');
    return;
  }

  let cmd = agent.command;

  // Custom command
  if (!cmd) {
    cmd = await ask(`  ${chalk.dim('Command:')} `);
    if (!cmd) return;
  }

  // Check if command exists
  const { execSync } = await import('node:child_process');
  const shellEnv = getShellEnv();
  let cmdExists = false;
  try {
    execSync(`which ${cmd.split(' ')[0]}`, { stdio: 'ignore', env: shellEnv });
    cmdExists = true;
  } catch {}

  if (!cmdExists && agent.needsInstall) {
    console.log(chalk.yellow(`  ⚠ ${agent.name} not found.`));
    const installAns = await ask(`  Install now? ${chalk.dim('(Y/n)')} `);
    if (!installAns || installAns.toLowerCase() !== 'n') {
      console.log(chalk.dim(`  Running: ${agent.needsInstall}`));
      const { spawn: sp } = await import('node:child_process');
      const inst = sp(agent.needsInstall, { stdio: 'inherit', shell: true, env: shellEnv });
      await new Promise<void>((r) => inst.on('close', () => r()));
      const freshEnv = getShellEnv();
      try {
        execSync(`which ${cmd.split(' ')[0]}`, { stdio: 'ignore', env: freshEnv });
        cmdExists = true;
      } catch {}
    }
    if (!cmdExists) {
      console.log(chalk.red('  Agent not available. Cancelled.'));
      return;
    }
  } else if (!cmdExists) {
    console.log(chalk.red(`  Command not found: ${cmd}`));
    return;
  }

  let fullCmd = cmd;

  // Aider model picker
  if (agent.name === 'Aider') {
    const models = [
      { label: 'DeepSeek V3 (deepseek/deepseek-chat)', value: 'deepseek/deepseek-chat' },
      { label: 'DeepSeek R1 (deepseek/deepseek-reasoner)', value: 'deepseek/deepseek-reasoner' },
      { label: 'GPT-4o (openai/gpt-4o)', value: 'openai/gpt-4o' },
      { label: 'Claude Sonnet (anthropic/claude-sonnet-4-6)', value: 'anthropic/claude-sonnet-4-6' },
      { label: 'Custom model', value: '' },
    ];
    console.log('');
    console.log(chalk.dim('  Choose a model:'));
    for (let i = 0; i < models.length; i++) {
      console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(models[i].label)}`);
    }
    console.log('');
    const mPick = await ask(`  ${o('›')} `);
    const mIdx = parseInt(mPick, 10);
    if (mIdx >= 1 && mIdx <= models.length) {
      let model = models[mIdx - 1].value;
      if (!model) {
        model = await ask(`  ${chalk.dim('Model name:')} `);
      }
      if (model) {
        fullCmd = `aider --model ${model}`;
      }
    }
  }

  // Launch hawkeye record with --session to attach to existing session
  // Extract model from command (e.g. "aider --model deepseek/deepseek-chat" → "deepseek/deepseek-chat")
  const modelMatch = fullCmd.match(/--model\s+(\S+)/);
  const modelArg = modelMatch ? modelMatch[1] : null;
  console.log('');
  console.log(chalk.dim(`  Attaching to session ${session.id.slice(0, 8)}...`));
  console.log(chalk.dim(`  Launching: hawkeye record -s ${session.id}${modelArg ? ` -m ${modelArg}` : ''} -o "${session.objective}" -- ${fullCmd}`));
  console.log('');

  const { spawn: sp } = await import('node:child_process');
  const args = ['record', '-s', session.id, ...(modelArg ? ['-m', modelArg] : []), '-o', session.objective, '--', ...fullCmd.split(' ')];
  const child = sp(process.execPath, [process.argv[1], ...args], {
    stdio: 'inherit',
    cwd,
  });
  await new Promise<void>((res) => child.on('close', () => res()));
}

async function runShellCommand(line: string): Promise<void> {
  const { spawn: sp } = await import('node:child_process');
  console.log('');
  const child = sp(line, { stdio: 'inherit', shell: true, env: getShellEnv() });
  await new Promise<void>((res) => child.on('close', () => { console.log(''); res(); }));
}

async function cmdRestart(dbPath: string, cwd: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  let sessionId = '';
  let obj = '';
  let agent = 'claude-code';
  let model = 'claude-sonnet-4-6';

  if (args) {
    // Direct session ID provided
    const r = db.getSession(args);
    if (r.ok && r.value) {
      sessionId = r.value.id;
      obj = r.value.objective;
      agent = r.value.agent || agent;
      model = r.value.model || model;
    }
  } else {
    // Show picker: existing sessions + new session option
    const r = db.listSessions({ limit: 10 });
    const sessions = r.ok ? r.value : [];
    console.log('');
    console.log(`  ${o.bold('0)')} ${o('+ New session')}`);  
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      console.log(
        `  ${o.bold(`${i + 1})`)} ${badge(s.status)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 40))}`,
      );
    }
    console.log('');
    const pick = await ask(`  ${o('›')} `);
    const idx = parseInt(pick, 10);
    if (isNaN(idx) || idx < 0 || idx > sessions.length) {
      db.close();
      return;
    }
    if (idx > 0) {
      const s = sessions[idx - 1];
      sessionId = s.id;
      obj = s.objective;
      agent = s.agent || agent;
      model = s.model || model;
    }
  }

  // End any OTHER active sessions
  const rec = db.listSessions({ status: 'recording' });
  const active = rec.ok ? rec.value : [];
  for (const s of active) {
    if (s.id !== sessionId) db.endSession(s.id, 'completed');
  }

  if (sessionId) {
    // Reopen existing session (keep same ID and all events)
    db.reopenSession(sessionId);
  } else {
    // New session: ask for name, create fresh
    obj = await ask(`  ${chalk.dim('Session name:')} `);
    if (!obj) obj = 'New Session';
    sessionId = randomUUID();
    db.createSession({
      id: sessionId,
      objective: obj,
      startedAt: new Date(),
      status: 'recording',
      metadata: { agent, model, workingDir: cwd },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
    });
  }

  db.close();

  // Write pending-session so Claude Code hooks attach to this session
  const hawkDir = join(cwd, '.hawkeye');
  const { writeFileSync: wfs } = await import('node:fs');
  wfs(join(hawkDir, 'pending-session.json'), JSON.stringify({ sessionId, objective: obj }), 'utf-8');

  console.log(chalk.green(`  ✓ Session ${sessionId.slice(0, 8)} — ${obj}`));
  console.log(chalk.dim(`    Launch Claude Code to start recording.`));
}

async function cmdRevert(dbPath: string, cwd: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  // Pick a session
  let sessionId = args;
  if (!sessionId) {
    const r = db.listSessions({ limit: 10 });
    const sessions = r.ok ? r.value : [];
    if (sessions.length === 0) {
      console.log(chalk.dim('  No sessions.'));
      db.close();
      return;
    }
    console.log('');
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      console.log(
        `  ${o.bold(`${i + 1})`)} ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 40))}  ${chalk.dim(`${s.total_actions}a`)}`,
      );
    }
    console.log('');
    const pick = await ask(`  ${o('›')} `);
    const idx = parseInt(pick, 10);
    if (isNaN(idx) || idx < 1 || idx > sessions.length) {
      db.close();
      return;
    }
    sessionId = sessions[idx - 1].id;
  }

  // Get session
  const sess = db.getSession(sessionId);
  if (!sess.ok || !sess.value) {
    console.log(chalk.red(`  Not found: ${sessionId}`));
    db.close();
    return;
  }

  // Get file_write events
  const evts = db.getEvents(sess.value.id, { type: 'file_write' });
  if (!evts.ok || evts.value.length === 0) {
    console.log(chalk.dim('  No file changes in this session.'));
    db.close();
    return;
  }

  // Collect files
  const fileEvents: { id: string; path: string; seq: number }[] = [];
  for (const ev of evts.value) {
    const data = JSON.parse(ev.data);
    if (data.path) {
      fileEvents.push({ id: ev.id, path: data.path, seq: ev.sequence });
    }
  }

  if (fileEvents.length === 0) {
    console.log(chalk.dim('  No file paths in events.'));
    db.close();
    return;
  }

  // Show file list
  const shortPath = (p: string) => p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
  console.log('');
  console.log(`  ${o.bold('0)')} ${o('Revert ALL files')}`);
  for (let i = 0; i < fileEvents.length; i++) {
    const fe = fileEvents[i];
    console.log(`  ${o.bold(`${i + 1})`)} ${chalk.dim(`#${fe.seq}`)} ${shortPath(fe.path)}`);
  }
  console.log('');
  const pick = await ask(`  ${o('›')} `);
  const idx = parseInt(pick, 10);
  if (isNaN(idx) || idx < 0 || idx > fileEvents.length) {
    db.close();
    return;
  }

  if (idx === 0) {
    // Revert all — reverse order, deduplicate by path
    const reversed = [...fileEvents].reverse();
    const seen = new Set<string>();
    let ok = 0;
    let fail = 0;
    for (const fe of reversed) {
      if (seen.has(fe.path)) continue;
      seen.add(fe.path);
      const result = revertSingleEvent(db, fe.id, cwd);
      if (result.ok) {
        console.log(chalk.green(`  ✓ ${shortPath(fe.path)} (${result.method})`));
        ok++;
      } else {
        console.log(chalk.red(`  ✗ ${shortPath(fe.path)} — ${result.error}`));
        fail++;
      }
    }
    console.log(chalk.dim(`\n  ${ok} reverted, ${fail} failed`));
  } else {
    // Revert single
    const fe = fileEvents[idx - 1];
    const result = revertSingleEvent(db, fe.id, cwd);
    if (result.ok) {
      console.log(chalk.green(`  ✓ Reverted ${shortPath(fe.path)} (${result.method})`));
    } else {
      console.log(chalk.red(`  ✗ ${result.error}`));
    }
  }

  db.close();
}

function revertSingleEvent(
  db: Storage,
  eventId: string,
  cwd: string,
): { ok: true; path: string; method: string } | { ok: false; error: string } {
  const ev = db.getEventById(eventId);
  if (!ev.ok || !ev.value) return { ok: false, error: 'Event not found' };

  const data = JSON.parse(ev.value.data);
  const filePath = data.path;
  if (!filePath) return { ok: false, error: 'No file path' };

  // Strategy 1: Reverse string replacement
  if (data.contentBefore != null && data.contentAfter != null && existsSync(filePath)) {
    try {
      const current = readFileSync(filePath, 'utf-8');
      if (current.includes(data.contentAfter)) {
        writeFileSync(filePath, current.replace(data.contentAfter, data.contentBefore), 'utf-8');
        return { ok: true, path: filePath, method: 'reverse-edit' };
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: git checkout
  try {
    execSync(`git checkout HEAD -- "${filePath}"`, { cwd, stdio: 'pipe' });
    return { ok: true, path: filePath, method: 'git-checkout' };
  } catch (err) {
    return { ok: false, error: `git checkout failed: ${String(err)}` };
  }
}

async function cmdApprove(cwd: string): Promise<void> {
  const hawkDir = join(cwd, '.hawkeye');
  const pendingFile = join(hawkDir, 'pending-reviews.json');
  const approvalsFile = join(hawkDir, 'review-approvals.json');

  // Load pending reviews
  let pending: Array<{
    id: string;
    timestamp: string;
    sessionId: string;
    claudeSessionId: string;
    command: string;
    matchedPattern: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }> = [];
  try {
    if (existsSync(pendingFile)) {
      pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
    }
  } catch {}

  if (pending.length === 0) {
    console.log(chalk.dim('  No pending review gate actions.'));
    return;
  }

  console.log('');
  console.log(o('  Pending Review Gate Actions'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log('');

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const ts = new Date(p.timestamp);
    const timeStr = ts.toLocaleTimeString();
    console.log(`  ${chalk.bold(String(i + 1))}. ${chalk.yellow(p.command.slice(0, 80))}`);
    console.log(chalk.dim(`     Pattern: "${p.matchedPattern}"  |  ${timeStr}  |  Session: ${p.claudeSessionId.slice(0, 8)}`));
  }
  console.log('');

  const choice = await nextLine(chalk.dim('  Select # (or "all"), then [A]pprove/[P]ermanent/[D]eny/[S]kip: '));
  const trimmed = choice.trim().toLowerCase();
  if (!trimmed || trimmed === 'skip' || trimmed === 's') {
    console.log(chalk.dim('  Skipped.'));
    return;
  }

  // Determine which items to process
  let indices: number[];
  if (trimmed.startsWith('all')) {
    indices = pending.map((_, i) => i);
  } else {
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || num > pending.length) {
      console.log(chalk.dim('  Invalid selection.'));
      return;
    }
    indices = [num - 1];
  }

  // Ask for action
  let action = '';
  if (trimmed.includes(' ')) {
    // e.g., "1 a" or "all p"
    action = trimmed.split(/\s+/).pop() || '';
  }

  if (!action) {
    const actionInput = await nextLine(chalk.dim('  [A]pprove (session) / [P]ermanent / [D]eny: '));
    action = actionInput.trim().toLowerCase();
  }

  // Load current approvals
  let approvals: Array<{
    pattern: string;
    scope: 'session' | 'always';
    sessionId?: string;
    approvedAt: string;
    approvedCommand: string;
  }> = [];
  try {
    if (existsSync(approvalsFile)) {
      approvals = JSON.parse(readFileSync(approvalsFile, 'utf-8'));
    }
  } catch {}

  const removedIds = new Set<string>();

  for (const idx of indices) {
    const p = pending[idx];
    if (action === 'a' || action === 'approve') {
      approvals.push({
        pattern: p.matchedPattern,
        scope: 'session',
        sessionId: p.claudeSessionId,
        approvedAt: new Date().toISOString(),
        approvedCommand: p.command,
      });
      removedIds.add(p.id);
      console.log(chalk.green(`  Approved (session): "${p.matchedPattern}"`));
    } else if (action === 'p' || action === 'permanent') {
      approvals.push({
        pattern: p.matchedPattern,
        scope: 'always',
        approvedAt: new Date().toISOString(),
        approvedCommand: p.command,
      });
      removedIds.add(p.id);
      console.log(chalk.green(`  Approved (permanent): "${p.matchedPattern}"`));
    } else if (action === 'd' || action === 'deny') {
      removedIds.add(p.id);
      console.log(chalk.red(`  Denied: "${p.matchedPattern}"`));
    } else {
      console.log(chalk.dim(`  Skipped: "${p.matchedPattern}"`));
    }
  }

  // Save updated approvals and remove processed pending reviews
  if (removedIds.size > 0) {
    const remaining = pending.filter((p) => !removedIds.has(p.id));
    writeFileSync(pendingFile, JSON.stringify(remaining, null, 2));
    writeFileSync(approvalsFile, JSON.stringify(approvals, null, 2));
  }

  console.log('');
}

async function cmdDelete(dbPath: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  // If args provided, delete that specific session
  if (args) {
    const r = db.getSession(args);
    if (!r.ok || !r.value) {
      console.log(chalk.red(`  Not found: ${args}`));
      db.close();
      return;
    }
    const y = await ask(chalk.red(`  Delete ${r.value.id.slice(0, 8)}? (y/N) `));
    if (y.toLowerCase() === 'y') {
      const del = db.deleteSession(r.value.id);
      if (del.ok) console.log(chalk.green(`  ✓ Deleted ${r.value.id.slice(0, 8)}`));
      else console.log(chalk.red(`  ✗ Failed to delete: ${del.error.message}`));
    }
    db.close();
    return;
  }

  // Show session picker with multi-select support
  const r = db.listSessions({ limit: 15 });
  if (!r.ok || r.value.length === 0) {
    console.log(chalk.dim('  No sessions.'));
    db.close();
    return;
  }
  lastSessions = r.value;
  console.log('');
  for (let i = 0; i < r.value.length; i++) printSession(i + 1, r.value[i]);
  console.log('');
  console.log(chalk.dim('  Enter numbers to delete (e.g. 1 2 3 or 1-5 or all)'));
  const pick = await ask(chalk.dim('  # ') + o('› '));
  if (!pick) { db.close(); return; }

  // Parse selection: support "1 2 3", "1-5", "all"
  let indices: number[] = [];
  let deleteAll = false;
  if (pick.toLowerCase() === 'all') {
    deleteAll = true;
    indices = r.value.map((_, i) => i);
  } else {
    for (const part of pick.split(/[\s,]+/)) {
      const rangeMatch = part.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let n = start; n <= end; n++) indices.push(n - 1);
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n)) indices.push(n - 1);
      }
    }
  }

  // Filter valid indices
  let sessions = indices
    .filter((i) => i >= 0 && i < r.value.length)
    .map((i) => r.value[i]);

  // When "all" is selected, fetch every session (not just the displayed 15)
  if (deleteAll) {
    const all = db.listSessions({ limit: 10000 });
    sessions = all.ok ? all.value : sessions;
  }

  if (sessions.length === 0) { db.close(); return; }

  const label = sessions.length === 1
    ? `Delete ${sessions[0].id.slice(0, 8)}?`
    : `Delete ${sessions.length} sessions?`;
  const y = await ask(chalk.red(`  ${label} (y/N) `));
  if (y.toLowerCase() !== 'y') { db.close(); return; }

  let deleted = 0;
  for (const s of sessions) {
    const del = db.deleteSession(s.id);
    if (del.ok) deleted++;
  }
  console.log(chalk.green(`  ✓ Deleted ${deleted} session${deleted > 1 ? 's' : ''}`));
  db.close();
}

async function cmdInspect(dbPath: string, args: string): Promise<void> {
  let sid = args;
  if (!sid) {
    sid = await pickSession(dbPath);
    if (!sid) return;
  }
  const db = getStorage(dbPath);
  if (!db) return;

  // Resolve short ID
  let sessionId = sid;
  const exact = db.getSession(sid);
  if (!exact.ok || !exact.value) {
    const all = db.listSessions({ limit: 1000 });
    const rows = all.ok ? all.value : [];
    const matches = rows.filter((s) => s.id.startsWith(sid));
    if (matches.length === 1) {
      sessionId = matches[0].id;
    } else if (matches.length > 1) {
      console.log(chalk.yellow(`  Ambiguous ID: ${matches.map((s) => s.id.slice(0, 8)).join(', ')}`));
      db.close();
      return;
    } else {
      console.log(chalk.red(`  Not found: ${sid}`));
      db.close();
      return;
    }
  }

  const sr = db.getSession(sessionId);
  if (!sr.ok || !sr.value) {
    console.log(chalk.red(`  Not found: ${sessionId}`));
    db.close();
    return;
  }

  const s = sr.value;
  const ev = db.getEvents(sessionId);
  const dr = db.getDriftSnapshots(sessionId);
  db.close();

  const events = ev.ok ? ev.value : [];
  const drifts = dr.ok ? dr.value : [];

  // Parsed events
  const parsed = events.map((e) => ({
    ...e,
    parsed: JSON.parse(e.data) as Record<string, unknown>,
  }));

  // ─── Header ───
  const statusIcon =
    s.status === 'completed' ? chalk.green('✓') :
    s.status === 'recording' ? chalk.yellow('●') :
    s.status === 'paused' ? chalk.blue('⏸') :
    chalk.red('✗');

  console.log('');
  console.log(o('  ┌─ Session Inspect ───────────────────────────────'));
  console.log(o('  │'));
  console.log(o('  │ ') + chalk.bold(s.objective));
  console.log(o('  │'));
  console.log(o('  │ ') + `${statusIcon} ${s.id.slice(0, 8)}  ${s.agent || chalk.dim('unknown')}  ${dur(s.started_at, s.ended_at)}`);
  console.log(o('  │'));

  // ─── Quick Stats ───
  const typeCounts: Record<string, number> = {};
  for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const totalCost = events.reduce((sum, e) => sum + (e.cost_usd || 0), 0);

  console.log(o('  │ ') + chalk.bold('Stats'));
  console.log(o('  │ ') + chalk.dim('─'.repeat(45)));
  const driftStr = s.final_drift_score != null
    ? (s.final_drift_score >= 70 ? chalk.green : s.final_drift_score >= 40 ? chalk.yellow : chalk.red)(`${s.final_drift_score.toFixed(0)}/100`)
    : chalk.dim('—');
  console.log(o('  │ ') + `Actions: ${chalk.white(String(events.length))}  Cost: ${chalk.yellow('$' + totalCost.toFixed(4))}  Tokens: ${s.total_tokens.toLocaleString()}  Drift: ${driftStr}`);
  const typeStr = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}(${c})`)
    .join('  ');
  console.log(o('  │ ') + chalk.dim(typeStr));
  console.log(o('  │'));

  // ─── Files Changed ───
  const fileEvents = parsed.filter((e) => e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename');
  const fileMap: Record<string, { action: string; cost: number; count: number }> = {};
  for (const e of fileEvents) {
    const path = String(e.parsed.path || '');
    const action = e.type === 'file_delete' ? 'deleted' : e.type === 'file_rename' ? 'renamed' : 'modified';
    if (!fileMap[path]) fileMap[path] = { action, cost: 0, count: 0 };
    fileMap[path].count++;
    fileMap[path].cost += e.cost_usd || 0;
    fileMap[path].action = action;
  }
  const sortedFiles = Object.entries(fileMap).sort((a, b) => b[1].cost - a[1].cost);
  console.log(o('  │ ') + chalk.bold(`Files (${sortedFiles.length})`));
  console.log(o('  │ ') + chalk.dim('─'.repeat(45)));
  if (sortedFiles.length === 0) {
    console.log(o('  │ ') + chalk.dim('  No file changes'));
  } else {
    for (const [path, info] of sortedFiles.slice(0, 20)) {
      const icon = info.action === 'deleted' ? chalk.red('−') : info.action === 'renamed' ? chalk.blue('→') : chalk.green('+');
      const edits = info.count > 1 ? chalk.dim(` (${info.count}x)`) : '';
      const cost = info.cost > 0 ? chalk.yellow(` $${info.cost.toFixed(4)}`) : '';
      console.log(o('  │ ') + `  ${icon} ${path}${cost}${edits}`);
    }
    if (sortedFiles.length > 20) console.log(o('  │ ') + chalk.dim(`  ... +${sortedFiles.length - 20} more`));
  }
  console.log(o('  │'));

  // ─── LLM Calls ───
  const llmEvents = parsed.filter((e) => e.type === 'llm_call');
  if (llmEvents.length > 0) {
    const byModel: Record<string, { cost: number; tokens: number; calls: number }> = {};
    for (const e of llmEvents) {
      const key = `${e.parsed.provider || '?'}/${e.parsed.model || '?'}`;
      if (!byModel[key]) byModel[key] = { cost: 0, tokens: 0, calls: 0 };
      byModel[key].cost += e.cost_usd || 0;
      byModel[key].tokens += (e.parsed.totalTokens as number) || 0;
      byModel[key].calls++;
    }
    console.log(o('  │ ') + chalk.bold(`LLM Calls (${llmEvents.length})`));
    console.log(o('  │ ') + chalk.dim('─'.repeat(45)));
    for (const [model, data] of Object.entries(byModel)) {
      console.log(o('  │ ') + `  ${chalk.magenta('⚡')} ${model}  ${data.calls} calls  ${data.tokens.toLocaleString()} tok  ${chalk.yellow('$' + data.cost.toFixed(4))}`);
    }
    console.log(o('  │'));
  }

  // ─── Drift History ───
  if (drifts.length > 0) {
    console.log(o('  │ ') + chalk.bold(`Drift (${drifts.length} checks)`));
    console.log(o('  │ ') + chalk.dim('─'.repeat(45)));
    for (const snap of drifts.slice(-10)) {
      const time = new Date(snap.created_at).toLocaleTimeString();
      const score = snap.score;
      const color = score >= 70 ? chalk.green : score >= 40 ? chalk.yellow : chalk.red;
      const bar = color('█'.repeat(Math.round(score / 5))) + chalk.dim('░'.repeat(20 - Math.round(score / 5)));
      console.log(o('  │ ') + `  ${chalk.dim(time)} ${bar} ${color(score.toFixed(0).padStart(3) + '/100')} ${chalk.dim(snap.reason || '')}`);
    }
    if (drifts.length > 10) console.log(o('  │ ') + chalk.dim(`  ... ${drifts.length - 10} earlier checks`));
    console.log(o('  │'));
  }

  // ─── Recent Events ───
  console.log(o('  │ ') + chalk.bold(`Timeline (last 15)`));
  console.log(o('  │ ') + chalk.dim('─'.repeat(45)));
  const typeIcons: Record<string, string> = {
    command: chalk.blue('$'), file_write: chalk.green('✎'), file_delete: chalk.red('✗'),
    file_read: chalk.dim('◉'), llm_call: chalk.magenta('⚡'), api_call: chalk.cyan('→'),
    git_commit: chalk.green('●'), git_push: chalk.cyan('↑'), guardrail_trigger: chalk.red('⛔'),
    guardrail_block: chalk.red('⛔'), drift_alert: chalk.yellow('⚠'), error: chalk.red('!'),
  };
  for (const e of parsed.slice(-15)) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const icon = typeIcons[e.type] || chalk.dim('·');
    let summary = e.type;
    if (e.type === 'command') summary = `${e.parsed.command} ${((e.parsed.args as string[]) || []).join(' ')}`.trim();
    else if (e.type.startsWith('file_')) summary = String(e.parsed.path || '');
    else if (e.type === 'llm_call') summary = `${e.parsed.provider}/${e.parsed.model}`;
    else if (e.type === 'error') summary = String(e.parsed.message || e.parsed.error || 'error');
    const cost = e.cost_usd > 0 ? chalk.yellow(` $${e.cost_usd.toFixed(4)}`) : '';
    console.log(o('  │ ') + `  ${chalk.dim(time)} ${icon} ${summary.slice(0, 50)}${cost}`);
  }
  if (events.length > 15) console.log(o('  │ ') + chalk.dim(`  ... ${events.length - 15} earlier events`));

  console.log(o('  │'));
  console.log(o('  └──────────────────────────────────────────────────'));
  console.log('');
}

async function cmdCompare(dbPath: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  const r = db.listSessions({ limit: 15 });
  if (!r.ok || r.value.length < 2) {
    console.log(chalk.dim('  Need at least 2 sessions to compare.'));
    db.close();
    return;
  }

  let resolvedIds: string[] = [];

  if (args) {
    // Parse IDs from args
    const ids = args.split(/[\s,]+/);
    const allRows = r.value;
    for (const input of ids) {
      const exact = allRows.find((s) => s.id === input);
      if (exact) { resolvedIds.push(exact.id); continue; }
      const matches = allRows.filter((s) => s.id.startsWith(input));
      if (matches.length === 1) resolvedIds.push(matches[0].id);
      else if (matches.length > 1) {
        console.log(chalk.yellow(`  Ambiguous ID "${input}": ${matches.map((s) => s.id.slice(0, 8)).join(', ')}`));
        db.close();
        return;
      } else {
        console.log(chalk.red(`  Not found: ${input}`));
        db.close();
        return;
      }
    }
  } else {
    // Interactive picker: select 2+ sessions
    console.log('');
    for (let i = 0; i < r.value.length; i++) printSession(i + 1, r.value[i]);
    console.log('');
    console.log(chalk.dim('  Pick 2+ sessions (e.g. 1 3 or 1-3)'));
    const pick = await ask(chalk.dim('  # ') + o('› '));
    if (!pick) { db.close(); return; }

    const indices: number[] = [];
    for (const part of pick.split(/[\s,]+/)) {
      const rangeMatch = part.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let n = start; n <= end; n++) indices.push(n - 1);
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n)) indices.push(n - 1);
      }
    }

    resolvedIds = indices
      .filter((i) => i >= 0 && i < r.value.length)
      .map((i) => r.value[i].id);
  }

  if (resolvedIds.length < 2) {
    console.log(chalk.dim('  Need at least 2 sessions.'));
    db.close();
    return;
  }

  const result = db.compareSessions(resolvedIds);
  db.close();

  if (!result.ok || result.value.length < 2) {
    console.log(chalk.red('  Could not load sessions for comparison.'));
    return;
  }

  const comparisons = result.value;
  const colWidth = 22;
  const labelWidth = 18;

  console.log('');
  console.log(o.bold('  Session Comparison'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log('');

  // Header
  console.log(
    ''.padEnd(labelWidth) +
    comparisons.map((c) => chalk.cyan(c.session.id.slice(0, 8).padEnd(colWidth))).join(''),
  );
  console.log(chalk.dim('  ' + '─'.repeat(labelWidth + colWidth * comparisons.length)));

  // Rows
  const rows: Array<{ label: string; values: string[]; winner?: 'low' | 'high' }> = [
    { label: 'Agent', values: comparisons.map((c) => c.session.agent || 'unknown') },
    { label: 'Objective', values: comparisons.map((c) => c.session.objective.slice(0, colWidth - 2)) },
    { label: 'Status', values: comparisons.map((c) => c.session.status) },
    { label: 'Duration', values: comparisons.map((c) => dur(c.session.started_at, c.session.ended_at)), winner: 'low' },
    { label: 'Actions', values: comparisons.map((c) => String(c.session.total_actions)), winner: 'low' },
    { label: 'Cost', values: comparisons.map((c) => '$' + c.session.total_cost_usd.toFixed(4)), winner: 'low' },
    { label: 'Tokens', values: comparisons.map((c) => c.session.total_tokens.toLocaleString()), winner: 'low' },
    { label: 'LLM Calls', values: comparisons.map((c) => String(c.stats.llm_count)), winner: 'low' },
    { label: 'Commands', values: comparisons.map((c) => String(c.stats.command_count)) },
    { label: 'Files', values: comparisons.map((c) => String(c.filesChanged.length)) },
    { label: 'Errors', values: comparisons.map((c) => String(c.stats.error_count)), winner: 'low' },
    { label: 'Guardrails', values: comparisons.map((c) => String(c.stats.guardrail_count)), winner: 'low' },
    {
      label: 'Drift',
      values: comparisons.map((c) =>
        c.session.final_drift_score != null ? c.session.final_drift_score.toFixed(0) + '/100' : 'n/a',
      ),
      winner: 'high',
    },
  ];

  for (const row of rows) {
    let winnerIdx = -1;
    if (row.winner) {
      const nums = row.values.map((v) => {
        const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? null : n;
      });
      const valid = nums.filter((n) => n !== null) as number[];
      if (valid.length >= 2) {
        const best = row.winner === 'low' ? Math.min(...valid) : Math.max(...valid);
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

  // Efficiency
  console.log('');
  console.log(chalk.dim('  ' + '─'.repeat(labelWidth + colWidth * comparisons.length)));
  const effs = comparisons.map((c) => ({
    cpa: c.session.total_actions > 0 ? c.session.total_cost_usd / c.session.total_actions : 0,
    tpa: c.session.total_actions > 0 ? c.session.total_tokens / c.session.total_actions : 0,
  }));
  const bestCpa = effs.reduce((b, e, i) => (e.cpa > 0 && e.cpa < effs[b].cpa ? i : b), 0);
  console.log(
    `  ${chalk.dim('$/action'.padEnd(labelWidth))}${effs
      .map((e, i) => {
        const v = ('$' + e.cpa.toFixed(4)).padEnd(colWidth);
        return i === bestCpa ? chalk.green(v) : v;
      })
      .join('')}`,
  );
  console.log(
    `  ${chalk.dim('tok/action'.padEnd(labelWidth))}${effs
      .map((e) => String(Math.round(e.tpa)).padEnd(colWidth))
      .join('')}`,
  );
  console.log('');
}

async function cmdReplay(dbPath: string, args: string): Promise<void> {
  let sid = args;
  if (!sid) {
    sid = await pickSession(dbPath);
    if (!sid) return;
  }
  const db = getStorage(dbPath);
  if (!db) return;
  const r = db.getSession(sid);
  if (!r.ok || !r.value) {
    console.log(chalk.red(`  Not found: ${sid}`));
    db.close();
    return;
  }
  db.close();

  console.log(chalk.dim(`  Launching interactive replay for ${r.value.id.slice(0, 8)}...`));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [process.argv[1], 'replay', r.value.id, '--interactive'], {
    stdio: 'inherit',
  });
  await new Promise<void>((res) => child.on('close', () => res()));
}

async function cmdExport(dbPath: string, args: string): Promise<void> {
  let sid = args;
  if (!sid) {
    sid = await pickSession(dbPath);
    if (!sid) return;
  }
  const db = getStorage(dbPath);
  if (!db) return;
  const sr = db.getSession(sid);
  if (!sr.ok || !sr.value) {
    console.log(chalk.red(`  Not found: ${sid}`));
    db.close();
    return;
  }
  const ev = db.getEvents(sr.value.id);
  db.close();
  const events = ev.ok ? ev.value : [];

  const output = {
    session: sr.value,
    events,
  };
  console.log(JSON.stringify(output, null, 2));
}

// ─── Settings command ────────────────────────────────────────

async function cmdSettings(cwd: string): Promise<void> {
  const config = loadConfig(cwd);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log('');
    console.log(chalk.bold.white('  Settings'));
    console.log(chalk.dim('  ─'.repeat(20)));
    console.log('');
    console.log(`  ${o.bold('1)')} DriftDetect     ${config.drift.enabled ? chalk.green('ON') : chalk.red('OFF')}  ${chalk.dim(`${config.drift.provider}/${config.drift.model}`)}`);
    console.log(`  ${o.bold('2)')} Guardrails      ${chalk.dim(`${config.guardrails.filter((r) => r.enabled).length}/${config.guardrails.length} active`)}`);
    console.log(`  ${o.bold('3)')} API Keys        ${chalk.dim(countKeys(config) + ' configured')}`);
    console.log(`  ${o.bold('4)')} Webhooks        ${chalk.dim(`${(config.webhooks || []).filter((w) => w.enabled).length} active`)}`);
    console.log(`  ${o.bold('5)')} ${chalk.dim('Back')}`);
    console.log('');

    const pick = await ask(`  ${o('›')} `);
    if (pick === '1') {
      await settingsDrift(config, cwd);
    } else if (pick === '2') {
      await settingsGuardrails(config, cwd);
    } else if (pick === '3') {
      await settingsApiKeys(config, cwd);
    } else if (pick === '4') {
      await settingsWebhooks(config, cwd);
    } else {
      break;
    }
  }
}

function countKeys(config: HawkeyeConfig): number {
  if (!config.apiKeys) return 0;
  return Object.values(config.apiKeys).filter((v) => v && v.length > 0).length;
}

function maskKey(key: string | undefined): string {
  if (!key || key.length < 8) return chalk.dim('not set');
  return chalk.dim(`${key.slice(0, 4)}${'•'.repeat(12)}${key.slice(-4)}`);
}

// ─── DriftDetect settings ────────────────────────────────────

async function settingsDrift(config: HawkeyeConfig, cwd: string): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const d = config.drift;
    console.log('');
    console.log(chalk.bold.white('  DriftDetect'));
    console.log(chalk.dim('  ─'.repeat(20)));
    console.log('');
    console.log(`  ${o.bold('1)')} Status          ${d.enabled ? chalk.green('ON') : chalk.red('OFF')}`);
    console.log(`  ${o.bold('2)')} Provider        ${chalk.white(d.provider)}`);
    console.log(`  ${o.bold('3)')} Model           ${chalk.white(d.model)}`);
    console.log(`  ${o.bold('4)')} Check every     ${chalk.white(String(d.checkEvery))} actions`);
    console.log(`  ${o.bold('5)')} Context window  ${chalk.white(String(d.contextWindow))} events`);
    console.log(`  ${o.bold('6)')} Warning at      ${chalk.yellow(`≤ ${d.warningThreshold}`)}`);
    console.log(`  ${o.bold('7)')} Critical at     ${chalk.red(`≤ ${d.criticalThreshold}`)}`);
    console.log(`  ${o.bold('8)')} Auto-pause      ${d.autoPause ? chalk.green('ON') : chalk.red('OFF')}`);
    console.log(`  ${o.bold('9)')} ${chalk.dim('Back')}`);
    console.log('');

    const pick = await ask(`  ${o('›')} `);

    if (pick === '1') {
      d.enabled = !d.enabled;
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ DriftDetect ${d.enabled ? 'enabled' : 'disabled'}`));
    } else if (pick === '2') {
      const providers = Object.keys(PROVIDER_MODELS);
      console.log('');
      for (let i = 0; i < providers.length; i++) {
        const cur = providers[i] === d.provider ? o(' ●') : '  ';
        console.log(`  ${o.bold(`${i + 1})`)}${cur} ${chalk.white(providers[i])}`);
      }
      const pi = await ask(`\n  ${o('›')} `);
      const idx = parseInt(pi, 10) - 1;
      if (idx >= 0 && idx < providers.length) {
        d.provider = providers[idx];
        d.model = PROVIDER_MODELS[d.provider][0];
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Provider: ${d.provider}, model: ${d.model}`));
      }
    } else if (pick === '3') {
      const models = PROVIDER_MODELS[d.provider] || [];
      console.log('');
      for (let i = 0; i < models.length; i++) {
        const cur = models[i] === d.model ? o(' ●') : '  ';
        console.log(`  ${o.bold(`${i + 1})`)}${cur} ${chalk.white(models[i])}`);
      }
      const mi = await ask(`\n  ${o('›')} `);
      const idx = parseInt(mi, 10) - 1;
      if (idx >= 0 && idx < models.length) {
        d.model = models[idx];
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Model: ${d.model}`));
      }
    } else if (pick === '4') {
      const v = await ask(`  ${chalk.dim('Check every (actions):')} `);
      const n = parseInt(v, 10);
      if (n > 0) {
        d.checkEvery = n;
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Check every ${n} actions`));
      }
    } else if (pick === '5') {
      const v = await ask(`  ${chalk.dim('Context window (events):')} `);
      const n = parseInt(v, 10);
      if (n > 0) {
        d.contextWindow = n;
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Context window: ${n}`));
      }
    } else if (pick === '6') {
      const v = await ask(`  ${chalk.dim('Warning threshold (0-100):')} `);
      const n = parseInt(v, 10);
      if (n >= 0 && n <= 100) {
        d.warningThreshold = n;
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Warning at ≤ ${n}`));
      }
    } else if (pick === '7') {
      const v = await ask(`  ${chalk.dim('Critical threshold (0-100):')} `);
      const n = parseInt(v, 10);
      if (n >= 0 && n <= 100) {
        d.criticalThreshold = n;
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Critical at ≤ ${n}`));
      }
    } else if (pick === '8') {
      d.autoPause = !d.autoPause;
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Auto-pause ${d.autoPause ? 'enabled' : 'disabled'}`));
    } else {
      break;
    }
  }
}

// ─── Guardrails settings ─────────────────────────────────────

function ruleLabel(r: GuardrailRuleSetting): string {
  const status = r.enabled ? chalk.green('ON') : chalk.red('OFF');
  const action = r.action === 'block' ? chalk.red('block') : chalk.yellow('warn');
  return `${status}  ${action}`;
}

function ruleDetail(r: GuardrailRuleSetting): string {
  if (r.type === 'file_protect') {
    return chalk.dim((r.config.paths as string[])?.join(', ') || '');
  }
  if (r.type === 'command_block') {
    return chalk.dim((r.config.patterns as string[])?.join(', ') || '');
  }
  if (r.type === 'cost_limit') {
    return chalk.dim(`$${r.config.maxUsdPerSession}/session, $${r.config.maxUsdPerHour}/hr`);
  }
  if (r.type === 'token_limit') {
    return chalk.dim(`${r.config.maxTokensPerSession} tokens/session`);
  }
  if (r.type === 'directory_scope') {
    return chalk.dim((r.config.blockedDirs as string[])?.join(', ') || '');
  }
  return '';
}

async function settingsGuardrails(config: HawkeyeConfig, cwd: string): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log('');
    console.log(chalk.bold.white('  Guardrails'));
    console.log(chalk.dim('  ─'.repeat(20)));
    console.log('');
    for (let i = 0; i < config.guardrails.length; i++) {
      const r = config.guardrails[i];
      console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(r.name.padEnd(22))} ${ruleLabel(r)}`);
      console.log(`     ${ruleDetail(r)}`);
    }
    console.log(`  ${o.bold(`${config.guardrails.length + 1})`)} ${o('+ Add rule')}`);
    console.log(`  ${o.bold(`${config.guardrails.length + 2})`)} ${chalk.dim('Back')}`);
    console.log('');

    const pick = await ask(`  ${o('›')} `);
    const idx = parseInt(pick, 10) - 1;

    if (idx === config.guardrails.length) {
      // Add new rule
      await addGuardrailRule(config, cwd);
    } else if (idx === config.guardrails.length + 1 || pick === '' || pick === 'b') {
      break;
    } else if (idx >= 0 && idx < config.guardrails.length) {
      await editGuardrailRule(config, idx, cwd);
    }
  }
}

async function editGuardrailRule(config: HawkeyeConfig, idx: number, cwd: string): Promise<void> {
  const r = config.guardrails[idx];
  console.log('');
  console.log(`  ${chalk.bold.white(r.name)} ${chalk.dim(`(${r.type})`)}`);
  console.log('');
  console.log(`  ${o.bold('1)')} ${r.enabled ? 'Disable' : 'Enable'}`);
  console.log(`  ${o.bold('2)')} Toggle action ${chalk.dim(`(currently: ${r.action})`)}`);
  console.log(`  ${o.bold('3)')} Edit config`);
  console.log(`  ${o.bold('4)')} ${chalk.red('Delete')}`);
  console.log(`  ${o.bold('5)')} ${chalk.dim('Back')}`);
  console.log('');

  const pick = await ask(`  ${o('›')} `);
  if (pick === '1') {
    r.enabled = !r.enabled;
    saveConfig(cwd, config);
    console.log(chalk.green(`  ✓ ${r.name} ${r.enabled ? 'enabled' : 'disabled'}`));
  } else if (pick === '2') {
    r.action = r.action === 'block' ? 'warn' : 'block';
    saveConfig(cwd, config);
    console.log(chalk.green(`  ✓ ${r.name} action: ${r.action}`));
  } else if (pick === '3') {
    await editRuleConfig(config, r, cwd);
  } else if (pick === '4') {
    const y = await ask(chalk.red(`  Delete ${r.name}? (y/N) `));
    if (y.toLowerCase() === 'y') {
      config.guardrails.splice(idx, 1);
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Deleted ${r.name}`));
    }
  }
}

async function editRuleConfig(
  config: HawkeyeConfig,
  r: GuardrailRuleSetting,
  cwd: string,
): Promise<void> {
  if (r.type === 'file_protect') {
    const paths = (r.config.paths as string[]) || [];
    console.log(chalk.dim(`  Current: ${paths.join(', ')}`));
    const v = await ask(`  ${chalk.dim('Paths (comma-sep):')} `);
    if (v) {
      r.config.paths = v.split(',').map((s) => s.trim()).filter(Boolean);
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Updated paths`));
    }
  } else if (r.type === 'command_block') {
    const patterns = (r.config.patterns as string[]) || [];
    console.log(chalk.dim(`  Current: ${patterns.join(', ')}`));
    const v = await ask(`  ${chalk.dim('Patterns (comma-sep):')} `);
    if (v) {
      r.config.patterns = v.split(',').map((s) => s.trim()).filter(Boolean);
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Updated patterns`));
    }
  } else if (r.type === 'cost_limit') {
    const v1 = await ask(`  ${chalk.dim(`Max $/session (${r.config.maxUsdPerSession}):`)} `);
    if (v1) r.config.maxUsdPerSession = parseFloat(v1);
    const v2 = await ask(`  ${chalk.dim(`Max $/hour (${r.config.maxUsdPerHour}):`)} `);
    if (v2) r.config.maxUsdPerHour = parseFloat(v2);
    saveConfig(cwd, config);
    console.log(chalk.green(`  ✓ Updated cost limits`));
  } else if (r.type === 'token_limit') {
    const v = await ask(`  ${chalk.dim(`Max tokens/session (${r.config.maxTokensPerSession}):`)} `);
    if (v) {
      r.config.maxTokensPerSession = parseInt(v, 10);
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Updated token limit`));
    }
  } else if (r.type === 'directory_scope') {
    const dirs = (r.config.blockedDirs as string[]) || [];
    console.log(chalk.dim(`  Current blocked: ${dirs.join(', ')}`));
    const v = await ask(`  ${chalk.dim('Blocked dirs (comma-sep):')} `);
    if (v) {
      r.config.blockedDirs = v.split(',').map((s) => s.trim()).filter(Boolean);
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Updated blocked dirs`));
    }
  }
}

async function addGuardrailRule(config: HawkeyeConfig, cwd: string): Promise<void> {
  const types = ['file_protect', 'command_block', 'cost_limit', 'token_limit', 'directory_scope'];
  console.log('');
  for (let i = 0; i < types.length; i++) {
    console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(types[i])}`);
  }
  console.log('');
  const ti = await ask(`  ${o('›')} `);
  const idx = parseInt(ti, 10) - 1;
  if (idx < 0 || idx >= types.length) return;

  const type = types[idx];
  const name = await ask(`  ${chalk.dim('Rule name:')} `);
  if (!name) return;

  const rule: GuardrailRuleSetting = {
    name,
    type,
    enabled: true,
    action: 'block',
    config: {},
  };

  // Set defaults per type
  if (type === 'file_protect') rule.config = { paths: [] };
  else if (type === 'command_block') rule.config = { patterns: [] };
  else if (type === 'cost_limit') rule.config = { maxUsdPerSession: 5.0, maxUsdPerHour: 2.0 };
  else if (type === 'token_limit') rule.config = { maxTokensPerSession: 500000 };
  else if (type === 'directory_scope') rule.config = { blockedDirs: [] };

  config.guardrails.push(rule);
  saveConfig(cwd, config);
  console.log(chalk.green(`  ✓ Added ${name} (${type})`));
  console.log(chalk.dim(`  Edit it to configure paths/patterns`));
}

// ─── API Keys settings ──────────────────────────────────────

async function settingsApiKeys(config: HawkeyeConfig, cwd: string): Promise<void> {
  if (!config.apiKeys) config.apiKeys = {};
  const keys = config.apiKeys;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log('');
    console.log(chalk.bold.white('  API Keys'));
    console.log(chalk.dim('  ─'.repeat(20)));
    console.log('');
    console.log(`  ${o.bold('1)')} Anthropic       ${maskKey(keys.anthropic)}`);
    console.log(`  ${o.bold('2)')} OpenAI          ${maskKey(keys.openai)}`);
    console.log(`  ${o.bold('3)')} DeepSeek        ${maskKey(keys.deepseek)}`);
    console.log(`  ${o.bold('4)')} Mistral         ${maskKey(keys.mistral)}`);
    console.log(`  ${o.bold('5)')} Google          ${maskKey(keys.google)}`);
    console.log(`  ${o.bold('6)')} ${chalk.dim('Back')}`);
    console.log('');

    const pick = await ask(`  ${o('›')} `);
    const providers: (keyof typeof keys)[] = ['anthropic', 'openai', 'deepseek', 'mistral', 'google'];
    const idx = parseInt(pick, 10) - 1;

    if (idx >= 0 && idx < providers.length) {
      const name = providers[idx];
      const v = await ask(`  ${chalk.dim(`${name} API key:`)} `);
      if (v) {
        keys[name] = v;
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ ${name} key saved`));
      } else {
        const del = await ask(chalk.dim(`  Clear ${name} key? (y/N) `));
        if (del.toLowerCase() === 'y') {
          keys[name] = undefined;
          saveConfig(cwd, config);
          console.log(chalk.green(`  ✓ ${name} key cleared`));
        }
      }
    } else {
      break;
    }
  }
}

async function settingsWebhooks(config: HawkeyeConfig, cwd: string): Promise<void> {
  if (!config.webhooks) config.webhooks = [];
  const EVENTS = ['drift_critical', 'guardrail_block'];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log('');
    console.log(chalk.bold.white('  Webhooks'));
    console.log(chalk.dim('  ─'.repeat(20)));
    console.log('');

    if (config.webhooks.length === 0) {
      console.log(chalk.dim('  No webhooks configured.'));
    } else {
      for (let i = 0; i < config.webhooks.length; i++) {
        const wh = config.webhooks[i];
        const status = wh.enabled ? chalk.green('ON') : chalk.red('OFF');
        const url = wh.url ? chalk.dim(wh.url.length > 40 ? wh.url.slice(0, 40) + '…' : wh.url) : chalk.red('no URL');
        const events = chalk.dim(wh.events.join(', ') || 'all events');
        console.log(`  ${o.bold(`${i + 1})`)} ${status}  ${url}`);
        console.log(`     ${events}`);
      }
    }

    console.log('');
    console.log(`  ${o.bold(`${config.webhooks.length + 1})`)} ${o('+ Add webhook')}`);
    console.log(`  ${o.bold(`${config.webhooks.length + 2})`)} ${chalk.dim('Back')}`);
    console.log('');

    const pick = await ask(`  ${o('›')} `);
    const idx = parseInt(pick, 10) - 1;

    if (idx === config.webhooks.length) {
      // Add new webhook
      const url = await ask(`  ${chalk.dim('Webhook URL:')} `);
      if (!url) continue;

      console.log('');
      console.log(chalk.dim('  Select events (comma-separated numbers, or Enter for all):'));
      for (let i = 0; i < EVENTS.length; i++) {
        console.log(`  ${o.bold(`${i + 1})`)} ${chalk.white(EVENTS[i])}`);
      }
      const evPick = await ask(`  ${o('›')} `);
      let events: string[] = [];
      if (evPick.trim()) {
        events = evPick.split(/[\s,]+/).map((n) => {
          const i = parseInt(n, 10) - 1;
          return i >= 0 && i < EVENTS.length ? EVENTS[i] : '';
        }).filter(Boolean);
      } else {
        events = [...EVENTS];
      }

      config.webhooks.push({ enabled: true, url, events });
      saveConfig(cwd, config);
      console.log(chalk.green(`  ✓ Webhook added`));
    } else if (idx === config.webhooks.length + 1 || pick === '' || pick === 'b') {
      break;
    } else if (idx >= 0 && idx < config.webhooks.length) {
      // Edit existing webhook
      const wh = config.webhooks[idx];
      console.log('');
      console.log(`  ${o.bold('1)')} Toggle ${wh.enabled ? chalk.green('ON') : chalk.red('OFF')}`);
      console.log(`  ${o.bold('2)')} Edit URL`);
      console.log(`  ${o.bold('3)')} Edit events`);
      console.log(`  ${o.bold('4)')} ${chalk.red('Delete')}`);
      console.log(`  ${o.bold('5)')} ${chalk.dim('Back')}`);
      const sub = await ask(`  ${o('›')} `);

      if (sub === '1') {
        wh.enabled = !wh.enabled;
        saveConfig(cwd, config);
        console.log(chalk.green(`  ✓ Webhook ${wh.enabled ? 'enabled' : 'disabled'}`));
      } else if (sub === '2') {
        const url = await ask(`  ${chalk.dim('New URL:')} `);
        if (url) {
          wh.url = url;
          saveConfig(cwd, config);
          console.log(chalk.green(`  ✓ URL updated`));
        }
      } else if (sub === '3') {
        console.log(chalk.dim('  Select events (comma-separated numbers):'));
        for (let i = 0; i < EVENTS.length; i++) {
          const cur = wh.events.includes(EVENTS[i]) ? o(' ●') : '  ';
          console.log(`  ${o.bold(`${i + 1})`)}${cur} ${chalk.white(EVENTS[i])}`);
        }
        const evPick = await ask(`  ${o('›')} `);
        if (evPick.trim()) {
          wh.events = evPick.split(/[\s,]+/).map((n) => {
            const i = parseInt(n, 10) - 1;
            return i >= 0 && i < EVENTS.length ? EVENTS[i] : '';
          }).filter(Boolean);
          saveConfig(cwd, config);
          console.log(chalk.green(`  ✓ Events updated: ${wh.events.join(', ')}`));
        }
      } else if (sub === '4') {
        const y = await ask(chalk.red(`  Delete this webhook? (y/N) `));
        if (y.toLowerCase() === 'y') {
          config.webhooks.splice(idx, 1);
          saveConfig(cwd, config);
          console.log(chalk.green(`  ✓ Webhook deleted`));
        }
      }
    }
  }
}

async function cmdKill(): Promise<void> {
  const http = await import('node:http');
  let killed = 0;

  for (let p = 4242; p <= 4252; p++) {
    const info = await new Promise<{ cwd?: string } | null>((resolve) => {
      const req = http.get(`http://localhost:${p}/api/info`, { timeout: 500 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    if (info) {
      try {
        execSync(`lsof -ti :${p} | xargs kill 2>/dev/null`, { stdio: 'ignore' });
        console.log(chalk.green(`  ✓ Killed hawkeye on :${p}`));
        killed++;
      } catch {
        // process already dead or permission denied
      }
    }
  }

  if (killed === 0) {
    console.log(chalk.dim('  No hawkeye background processes found.'));
  }
}

async function cmdPurge(dbPath: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  const r = db.listSessions({ limit: 10000 });
  if (!r.ok || r.value.length === 0) {
    console.log(chalk.dim('  No sessions to purge.'));
    db.close();
    return;
  }

  const y = await ask(chalk.red(`  Purge ALL ${r.value.length} sessions? (y/N) `));
  if (y.toLowerCase() !== 'y') { db.close(); return; }

  let deleted = 0;
  for (const s of r.value) {
    const del = db.deleteSession(s.id);
    if (del.ok) deleted++;
  }
  console.log(chalk.green(`  ✓ Purged ${deleted} session${deleted > 1 ? 's' : ''}`));
  db.close();
}

async function cmdServe(): Promise<void> {
  const net = await import('node:net');
  const http = await import('node:http');
  const cwd = process.cwd();

  // Check ports 4242-4252 for an existing dashboard serving THIS project
  for (let p = 4242; p <= 4252; p++) {
    const info = await new Promise<{ cwd?: string } | null>((resolve) => {
      const req = http.get(`http://localhost:${p}/api/info`, { timeout: 500 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    if (info?.cwd === cwd) {
      console.log(chalk.green(`  ✓ Dashboard already running for this project`));
      console.log(chalk.dim(`  http://localhost:${p}`));
      return;
    }
  }

  // Find first free port
  for (let p = 4242; p <= 4252; p++) {
    const portFree = await new Promise<boolean>((resolve) => {
      const tester = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => { tester.close(); resolve(true); })
        .listen(p);
    });

    if (portFree) {
      console.log(chalk.dim(`  Starting dashboard on :${p}...`));
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [process.argv[1], 'serve', '-p', String(p)], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      console.log(chalk.green('  ✓ Dashboard running'));
      console.log(chalk.dim(`  http://localhost:${p}`));
      return;
    }
  }

  console.log(chalk.red('  No available port found (tried 4242-4252).'));
}

async function cmdInit(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [process.argv[1], 'init'], { stdio: 'inherit' });
  await new Promise<void>((res) => child.on('close', () => res()));
}

// ─── Session detail menu & picker ────────────────────────────

async function sessionMenu(s: SessionRow, dbPath: string, cwd: string): Promise<void> {
  console.log('');
  console.log(`  ${badge(s.status)}  ${chalk.dim(s.id.slice(0, 8))}`);
  console.log(`  ${chalk.bold.white(s.objective)}`);
  console.log(
    `  ${chalk.dim(`${s.agent || '?'} · ${dur(s.started_at, s.ended_at)} · ${s.total_actions} actions`)}`,
  );
  console.log('');

  const opts: string[] = [];
  if (s.status === 'recording') opts.push(`${o('e')}nd`);
  opts.push(`${o('r')}estart`, `${o('s')}tats`, `${o('d')}elete`, `${o('b')}ack`);
  console.log(`  ${opts.join('  ')}`);

  const a = (await ask(`  ${o('›')} `)).toLowerCase();

  if ((a === 'e' || a === 'end') && s.status === 'recording') {
    const db = getStorage(dbPath);
    if (!db) return;
    db.endSession(s.id, 'completed');
    db.close();
    console.log(chalk.green(`  ✓ Ended ${s.id.slice(0, 8)}`));
  } else if (a === 'r' || a === 'restart') {
    const db = getStorage(dbPath);
    if (!db) return;
    const rec = db.listSessions({ status: 'recording' });
    for (const x of rec.ok ? rec.value : []) db.endSession(x.id, 'completed');
    const id = randomUUID();
    db.createSession({
      id,
      objective: s.objective,
      startedAt: new Date(),
      status: 'recording',
      metadata: {
        agent: s.agent || 'claude-code',
        model: s.model || 'claude-sonnet-4-6',
        workingDir: cwd,
      },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
    });
    db.close();
    console.log(chalk.green(`  ✓ New session ${id.slice(0, 8)}`));
  } else if (a === 's' || a === 'stats') {
    const db = getStorage(dbPath);
    if (!db) return;
    const ev = db.getEvents(s.id);
    db.close();
    const events = ev.ok ? ev.value : [];
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
    if (Object.keys(counts).length > 0) {
      console.log('');
      for (const [t, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${chalk.dim(t.padEnd(18))} ${o('█'.repeat(Math.min(c, 30)))} ${c}`);
      }
    } else {
      console.log(chalk.dim('  No events.'));
    }
  } else if (a === 'd' || a === 'delete') {
    const y = await ask(chalk.red(`  Delete ${s.id.slice(0, 8)}? (y/N) `));
    if (y.toLowerCase() === 'y') {
      const db = getStorage(dbPath);
      if (!db) return;
      db.deleteSession(s.id);
      db.close();
      console.log(chalk.green(`  ✓ Deleted`));
    }
  }
}

async function pickSession(dbPath: string): Promise<string> {
  const db = getStorage(dbPath);
  if (!db) return '';
  const r = db.listSessions({ limit: 15 });
  db.close();
  if (!r.ok || r.value.length === 0) {
    console.log(chalk.dim('  No sessions.'));
    return '';
  }
  lastSessions = r.value;
  console.log('');
  for (let i = 0; i < r.value.length; i++) printSession(i + 1, r.value[i]);
  console.log('');
  const pick = await ask(chalk.dim('  # ') + o('› '));
  const idx = parseInt(pick, 10) - 1;
  if (idx >= 0 && idx < r.value.length) return r.value[idx].id;
  return '';
}

// ─── Entry point ─────────────────────────────────────────────

export async function startInteractive(): Promise<void> {
  const cwd = process.cwd();
  const hawkDir = join(cwd, '.hawkeye');
  const dbPath = join(hawkDir, 'traces.db');

  // Auto-init if .hawkeye doesn't exist (zero-config)
  if (!existsSync(hawkDir)) {
    mkdirSync(hawkDir, { recursive: true });
    const cfgPath = join(hawkDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify(getDefaultConfig(), null, 2), 'utf-8');
    // Trigger DB creation via Storage constructor
    const { Storage } = await import('@hawkeye/core');
    const s = new Storage(dbPath);
    s.close();
  }

  printBanner();
  printActiveBar(dbPath);

  // Non-TTY fallback (piped input) — uses line queue for proper serialization
  if (!process.stdin.isTTY) {
    pipedMode = true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (lineWaiter) {
        const resolve = lineWaiter;
        lineWaiter = null;
        resolve(trimmed);
      } else {
        lineQueue.push(trimmed);
      }
    });
    rl.on('close', () => {
      if (lineWaiter) lineWaiter('quit');
    });
    console.log(chalk.dim('    / for commands'));
    console.log('');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await nextLine(`${o('›')} `);
      if (!raw) continue;
      if (raw === '/' || raw === 'help') {
        printCommands();
        continue;
      }
      const input = raw.startsWith('/') ? raw.slice(1) : raw;
      await executeCommand(input, dbPath, cwd);
      console.log('');
    }
  }

  // TTY interactive loop with raw mode picker
  console.log('');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = await rawPrompt();
    if (!input) continue;
    const skipBlank = await executeCommand(input, dbPath, cwd);
    if (!skipBlank) console.log('');
  }
}
