import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { Storage, type SessionRow } from '@hawkeye/core';
import {
  loadConfig,
  saveConfig,
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
  { name: 'sessions', desc: 'List & manage sessions' },
  { name: 'active', desc: 'Current recording' },
  { name: 'stats', desc: 'Session statistics' },
  { name: 'end', desc: 'End active sessions' },
  { name: 'restart', desc: 'Restart a session' },
  { name: 'delete', desc: 'Delete a session' },
  { name: 'settings', desc: 'Configure Hawkeye' },
  { name: 'serve', desc: 'Open dashboard :4242' },
  { name: 'init', desc: 'Initialize Hawkeye' },
  { name: 'clear', desc: 'Clear screen' },
  { name: 'quit', desc: 'Exit' },
];

const o = chalk.hex('#FF6B2B');

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
    `  ${o.bold(`${i})`)} ${badge(s.status)}  ${chalk.dim(s.id.slice(0, 8))}  ${chalk.white(s.objective.slice(0, 35).padEnd(35))}  ${chalk.dim(dur(s.started_at, s.ended_at).padEnd(7))}  ${chalk.dim(String(s.total_actions).padStart(4))}a  ${chalk.dim(timeAgo(s.started_at))}`,
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
    let prevLines = 0;

    const render = () => {
      const filtered = getFiltered(buf);

      // Clamp selection
      if (filtered.length > 0) {
        sel = Math.max(0, Math.min(sel, filtered.length - 1));
      } else {
        sel = 0;
      }

      // Redraw prompt line
      process.stdout.write(`\r\x1b[K${o('›')} ${buf}`);

      // Ghost text when empty
      if (buf.length === 0) {
        process.stdout.write(chalk.dim('/ for commands'));
      }

      // Draw picker lines
      const lines = filtered.length;
      for (let i = 0; i < lines; i++) {
        process.stdout.write('\n\x1b[K');
        const isSel = i === sel;
        const arrow = isSel ? o(' ❯') : '  ';
        const name = isSel
          ? o.bold(`/${filtered[i].name.padEnd(14)}`)
          : chalk.dim(`/${filtered[i].name.padEnd(14)}`);
        process.stdout.write(`${arrow} ${name} ${chalk.dim(filtered[i].desc)}`);
      }

      // Clear leftover lines from previous render
      const extra = Math.max(0, prevLines - lines);
      for (let i = 0; i < extra; i++) {
        process.stdout.write('\n\x1b[K');
      }

      // Move cursor back up to prompt line
      const total = lines + extra;
      if (total > 0) {
        process.stdout.write(`\x1b[${total}A`);
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
            break;

          case 'backspace':
            if (pos > 0) {
              buf = buf.slice(0, pos - 1) + buf.slice(pos);
              pos--;
              sel = 0;
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
  } else if (c === 'active') {
    cmdActive(dbPath);
  } else if (c === 'stats') {
    await cmdStats(dbPath, args);
  } else if (c === 'end') {
    cmdEnd(dbPath, args);
  } else if (c === 'restart') {
    await cmdRestart(dbPath, cwd, args);
  } else if (c === 'delete') {
    await cmdDelete(dbPath, args);
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
    console.log(chalk.dim(`  Unknown command: ${c}. Type / for help.`));
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

async function cmdStats(dbPath: string, sid: string): Promise<void> {
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
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  console.log(
    `  ${badge(sr.value.status)}  ${chalk.dim(sr.value.id.slice(0, 8))}  ${chalk.white(sr.value.objective)}`,
  );
  console.log(
    `  ${chalk.dim(`${dur(sr.value.started_at, sr.value.ended_at)} · ${sr.value.total_actions} actions`)}`,
  );
  if (Object.keys(counts).length > 0) {
    console.log('');
    for (const [t, ct] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${chalk.dim(t.padEnd(18))} ${o('█'.repeat(Math.min(ct, 30)))} ${ct}`);
    }
  }
}

function cmdEnd(dbPath: string, args: string): void {
  const db = getStorage(dbPath);
  if (!db) return;
  if (args) {
    const r = db.getSession(args);
    if (r.ok && r.value && (r.value.status === 'recording' || r.value.status === 'paused')) {
      db.endSession(r.value.id, 'completed');
      console.log(chalk.green(`  ✓ Ended ${r.value.id.slice(0, 8)}`));
    } else {
      console.log(chalk.dim('  Nothing to end.'));
    }
  } else {
    const rec = db.listSessions({ status: 'recording' });
    const active = rec.ok ? rec.value : [];
    if (active.length === 0) {
      console.log(chalk.dim('  No active sessions.'));
    } else {
      for (const s of active) {
        db.endSession(s.id, 'completed');
        console.log(chalk.green(`  ✓ Ended ${s.id.slice(0, 8)} — ${s.objective.slice(0, 40)}`));
      }
    }
  }
  db.close();
}

async function cmdRestart(dbPath: string, cwd: string, args: string): Promise<void> {
  const db = getStorage(dbPath);
  if (!db) return;

  let obj = '';
  let agent = 'claude-code';
  let model = 'claude-sonnet-4-6';

  if (args) {
    // Direct session ID provided
    const r = db.getSession(args);
    if (r.ok && r.value) {
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
      obj = s.objective;
      agent = s.agent || agent;
      model = s.model || model;
    }
  }

  // If new session or no objective, ask for a name
  if (!obj) {
    obj = await ask(`  ${chalk.dim('Session name:')} `);
    if (!obj) obj = 'New Session';
  }

  // End any active sessions
  const rec = db.listSessions({ status: 'recording' });
  const active = rec.ok ? rec.value : [];
  for (const s of active) db.endSession(s.id, 'completed');

  const id = randomUUID();
  db.createSession({
    id,
    objective: obj,
    startedAt: new Date(),
    status: 'recording',
    metadata: { agent, model, workingDir: cwd },
  });
  db.close();
  console.log(chalk.green(`  ✓ New session ${id.slice(0, 8)}`));
  console.log(chalk.dim(`    ${obj}`));
}

async function cmdDelete(dbPath: string, args: string): Promise<void> {
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
  const y = await ask(chalk.red(`  Delete ${r.value.id.slice(0, 8)}? (y/N) `));
  if (y.toLowerCase() === 'y') {
    db.deleteSession(r.value.id);
    console.log(chalk.green(`  ✓ Deleted`));
  }
  db.close();
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
    console.log(`  ${o.bold('4)')} ${chalk.dim('Back')}`);
    console.log('');

    const pick = await ask(`  ${o('›')} `);
    if (pick === '1') {
      await settingsDrift(config, cwd);
    } else if (pick === '2') {
      await settingsGuardrails(config, cwd);
    } else if (pick === '3') {
      await settingsApiKeys(config, cwd);
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
    console.log(`  ${o.bold('8)')} ${chalk.dim('Back')}`);
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

async function cmdServe(): Promise<void> {
  // Check if port is already in use before spawning
  const net = await import('node:net');
  const portFree = await new Promise<boolean>((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => { tester.close(); resolve(true); })
      .listen(4242);
  });
  if (!portFree) {
    console.log(chalk.yellow('  Dashboard already running on :4242'));
    console.log(chalk.dim('  http://localhost:4242'));
    return;
  }
  console.log(chalk.dim('  Starting dashboard on :4242...'));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [process.argv[1], 'serve'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  console.log(chalk.green('  ✓ Dashboard running'));
  console.log(chalk.dim('  http://localhost:4242'));
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
  const dbPath = join(cwd, '.hawkeye', 'traces.db');

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
