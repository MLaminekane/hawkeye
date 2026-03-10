import { Command } from 'commander';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, openSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import chalk from 'chalk';
import { createRecorder, type DriftCheckResult, type GuardrailViolation, type GuardrailRuleConfig } from '@hawkeye/core';
import { RecordOverlay } from './record-overlay.js';
import { loadConfig, getDefaultConfig, type WebhookSettings } from '../config.js';

function fireWebhooks(
  webhooks: WebhookSettings[],
  eventType: string,
  payload: Record<string, unknown>,
): void {
  for (const wh of webhooks) {
    if (!wh.enabled) continue;
    if (wh.events.length > 0 && !wh.events.includes(eventType)) continue;
    fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    }).catch(() => {});
  }
}

export const recordCommand = new Command('record')
  .alias('watch')
  .description('Record an AI agent session')
  .requiredOption('-o, --objective <text>', 'The objective for this session')
  .option('-a, --agent <name>', 'Agent name (auto-detected from command)', 'unknown')
  .option('-m, --model <name>', 'Model name')
  .option('-s, --session <id>', 'Attach to an existing session instead of creating a new one')
  .option('--no-drift', 'Disable drift detection')
  .option('--no-guardrails', 'Disable guardrails')
  .argument('[command...]', 'The command to run (after --)')
  .action(async (commandArgs: string[], options) => {
    if (commandArgs.length === 0) {
      console.error(chalk.red('Error: No command specified.'));
      console.error(
        chalk.dim('Usage: hawkeye record -o "objective" -- <command>'),
      );
      process.exit(1);
    }

    const cwd = process.cwd();
    const hawkDir = join(cwd, '.hawkeye');
    const dbPath = join(hawkDir, 'traces.db');

    // Auto-create .hawkeye + config + DB if they don't exist (zero-config)
    if (!existsSync(hawkDir)) {
      mkdirSync(hawkDir, { recursive: true });
    }
    const cfgPath = join(hawkDir, 'config.json');
    if (!existsSync(cfgPath)) {
      writeFileSync(cfgPath, JSON.stringify(getDefaultConfig(), null, 2), 'utf-8');
    }

    // Detect agent from command
    const agentCommand = commandArgs[0];
    const agent = options.agent !== 'unknown' ? options.agent : detectAgent(agentCommand);

    // For Claude Code, recommend hooks instead of record (preload doesn't work with bundled runtime)
    if (agent === 'claude-code') {
      console.log(chalk.yellow('  Note: Claude Code uses a bundled Node.js runtime.'));
      console.log(chalk.yellow('  For full event capture (LLM costs, drift, guardrails), use hooks:'));
      console.log('');
      console.log(chalk.cyan('    hawkeye hooks install'));
      console.log(chalk.dim('    Then use Claude Code normally — events are captured automatically.'));
      console.log('');
      console.log(chalk.dim('  Continuing with record mode (file events + partial network capture)...'));
      console.log('');
    }

    const config = loadConfig(cwd);
    const webhooks = config.webhooks || [];

    // Inject saved API keys into current process env (for drift engine)
    // and they will also be inherited by the child process via ...process.env
    const keyMap: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      google: 'GOOGLE_API_KEY',
    };
    if (config.apiKeys) {
      for (const [provider, envVar] of Object.entries(keyMap)) {
        const key = config.apiKeys[provider as keyof typeof config.apiKeys];
        if (key && !process.env[envVar]) {
          process.env[envVar] = key;
        }
      }
    }

    // Auto-detect drift provider from model (e.g. "deepseek/deepseek-chat" → deepseek)
    let driftProvider = config.drift.provider as 'ollama' | 'anthropic' | 'openai' | 'deepseek' | 'mistral' | 'google';
    let driftModel = config.drift.model;
    if (options.model && options.model.includes('/')) {
      const detectedProvider = options.model.split('/')[0].toLowerCase();
      const validProviders = ['ollama', 'anthropic', 'openai', 'deepseek', 'mistral', 'google'];
      if (validProviders.includes(detectedProvider)) {
        driftProvider = detectedProvider as typeof driftProvider;
        // Use a sensible default drift model for the detected provider
        const driftModelMap: Record<string, string> = {
          deepseek: 'deepseek-chat',
          openai: 'gpt-4o',
          anthropic: 'claude-sonnet-4-6',
          mistral: 'mistral-large-latest',
          google: 'gemini-2.0-flash',
          ollama: 'llama3.2',
        };
        driftModel = driftModelMap[detectedProvider] || driftModel;
      }
    }

    const recorder = createRecorder({
      objective: options.objective,
      agent,
      model: options.model,
      workingDir: cwd,
      dbPath,
      sessionId: options.session,
      ignoredPaths: config.recording?.ignorePatterns,
      maxStdoutBytes: config.recording?.maxStdoutBytes,
      capturePrompts: config.recording?.captureLlmContent,
      drift: options.drift !== false
        ? {
            enabled: config.drift.enabled,
            checkEvery: config.drift.checkEvery,
            provider: driftProvider,
            model: driftModel,
            thresholds: { warning: config.drift.warningThreshold, critical: config.drift.criticalThreshold },
            contextWindow: config.drift.contextWindow,
            autoPause: config.drift.autoPause ?? false,
            ollamaUrl: config.drift.ollamaUrl,
          }
        : { enabled: false, checkEvery: 5, provider: 'ollama' as const, model: '', thresholds: { warning: 60, critical: 30 }, contextWindow: 10, autoPause: false },
      guardrails: options.guardrails !== false
        ? {
            enabled: true,
            rules: config.guardrails
              .filter((r) => r.enabled)
              .map((r) => ({ name: r.name, type: r.type, action: r.action, ...r.config }) as GuardrailRuleConfig),
          }
        : { enabled: false, rules: [] },
    });

    // Live terminal overlay
    const overlay = new RecordOverlay({
      sessionId: recorder.sessionId,
      objective: options.objective,
      agent,
    });

    let eventCount = 0;
    let totalCostUsd = 0;
    let childProcess: ChildProcess | null = null;
    let promptingDrift = false;
    let cleaned = false;

    const cleanup = (status: 'completed' | 'aborted') => {
      if (cleaned) return;
      cleaned = true;
      overlay.stop();
      recorder.stop(status);
      console.log('');
      console.log(
        chalk.green(`● Session ${status}: ${chalk.bold(recorder.sessionId)}`),
      );
      console.log(
        chalk.dim(`  View: hawkeye stats ${recorder.sessionId}`),
      );
    };

    // Read a single keypress from /dev/tty (works even when stdin is inherited by child)
    function promptDriftAction(): Promise<'continue' | 'pause' | 'abort'> {
      return new Promise((resolve) => {
        try {
          const fd = openSync('/dev/tty', 'r');
          const ttyIn = new ReadStream(fd);
          ttyIn.setRawMode(true);
          ttyIn.resume();
          ttyIn.once('data', (data: Buffer) => {
            const key = data.toString().toLowerCase();
            ttyIn.setRawMode(false);
            ttyIn.destroy();
            if (key === 'a') resolve('abort');
            else if (key === 'p') resolve('pause');
            else resolve('continue');
          });
        } catch {
          // /dev/tty not available (CI, piped mode) — auto-continue
          resolve('continue');
        }
      });
    }

    // Read a single keypress from /dev/tty for review gate approval
    function promptReviewAction(): Promise<'approve' | 'deny' | 'skip'> {
      return new Promise((resolve) => {
        try {
          const fd = openSync('/dev/tty', 'r');
          const ttyIn = new ReadStream(fd);
          ttyIn.setRawMode(true);
          ttyIn.resume();
          ttyIn.once('data', (data: Buffer) => {
            const key = data.toString().toLowerCase();
            ttyIn.setRawMode(false);
            ttyIn.destroy();
            if (key === 'a') resolve('approve');
            else if (key === 'd') resolve('deny');
            else resolve('skip');
          });
        } catch {
          // /dev/tty not available (CI, piped mode) — auto-deny for safety
          resolve('deny');
        }
      });
    }

    // Wire up drift alerts with interactive prompt for critical
    recorder.onDriftAlert((result: DriftCheckResult) => {
      overlay.update({ driftScore: result.score, driftFlag: result.flag });

      if (result.flag === 'critical' && !promptingDrift) {
        promptingDrift = true;
        recorder.pause();
        overlay.stop();

        fireWebhooks(webhooks, 'drift_critical', {
          sessionId: recorder.sessionId,
          score: result.score,
          reason: result.reason,
          suggestion: result.suggestion,
        });

        console.error('');
        console.error(chalk.red('  ┌─ DRIFT CRITICAL ──────────────────────────────────────────┐'));
        console.error(chalk.red(`  │  Score: ${result.score}/100`));
        console.error(chalk.dim(`  │  ${result.reason}`));
        if (result.suggestion) {
          console.error(chalk.dim(`  │  Suggestion: ${result.suggestion}`));
        }
        console.error('  │');
        console.error(`  │  ${chalk.green('[C]')}ontinue   ${chalk.yellow('[P]')}ause   ${chalk.red('[A]')}bort`);
        console.error(chalk.red('  └────────────────────────────────────────────────────────────┘'));

        promptDriftAction().then((action) => {
          promptingDrift = false;
          if (action === 'abort') {
            console.error(chalk.red('  Aborting session...'));
            if (childProcess) childProcess.kill('SIGTERM');
            cleanup('aborted');
            process.exit(1);
          } else if (action === 'pause') {
            console.error(chalk.yellow('  Session paused. Recording suspended.'));
            overlay.update({ paused: true });
            overlay.start();
          } else {
            recorder.resume();
            console.error(chalk.green('  Continuing...'));
            overlay.update({ paused: false });
            overlay.start();
          }
        });
      } else if (result.flag === 'warning') {
        overlay.stop();
        console.error('');
        console.error(chalk.yellow(`  ⚠ DRIFT WARNING — Score: ${result.score}/100`));
        console.error(chalk.dim(`    ${result.reason}`));
        if (result.suggestion) {
          console.error(chalk.dim(`    Suggestion: ${result.suggestion}`));
        }
        console.error('');
        overlay.start();
      }
    });

    // Wire up guardrail violations
    recorder.onGuardrailViolation((violation: GuardrailViolation) => {
      overlay.stop();
      console.error('');
      if (violation.severity === 'block') {
        fireWebhooks(webhooks, 'guardrail_block', {
          sessionId: recorder.sessionId,
          ruleName: violation.ruleName,
          description: violation.description,
        });
        console.error(chalk.red(`  ⛔ GUARDRAIL BLOCKED [${violation.ruleName}]`));
      } else {
        console.error(chalk.yellow(`  ⚠ GUARDRAIL WARNING [${violation.ruleName}]`));
      }
      console.error(chalk.dim(`    ${violation.description}`));
      console.error('');
      overlay.start();
    });

    // Wire up review gate interactive prompt
    recorder.onReviewGate(async (violation, _event) => {
      overlay.stop();
      console.error('');
      console.error(chalk.yellow('  ┌─ REVIEW GATE ─────────────────────────────────────────────┐'));
      console.error(chalk.yellow(`  │  ${violation.description}`));
      if (violation.matchedPattern) {
        console.error(chalk.dim(`  │  Pattern: "${violation.matchedPattern}"`));
      }
      console.error('  │');
      console.error(`  │  ${chalk.green('[A]')}pprove   ${chalk.red('[D]')}eny   ${chalk.yellow('[S]')}kip (once)`);
      console.error(chalk.yellow('  └────────────────────────────────────────────────────────────┘'));

      const action = await promptReviewAction();
      if (action === 'approve') {
        console.error(chalk.green('  Approved (pattern allowlisted for this session)'));
      } else if (action === 'deny') {
        console.error(chalk.red('  Denied'));
      } else {
        console.error(chalk.yellow('  Skipped (allowed once)'));
      }
      console.error('');
      overlay.start();
      return action;
    });

    // Track events for overlay
    recorder.onEvent((event) => {
      eventCount++;
      if (event.costUsd) totalCostUsd += event.costUsd;
      const summary = getEventSummary(event);
      overlay.update({ eventCount, costUsd: totalCostUsd, lastEventType: event.type, lastEventSummary: summary });
    });

    recorder.start();

    const driftStatus = options.drift !== false ? chalk.green('on') : chalk.dim('off');
    const guardStatus = options.guardrails !== false ? chalk.green('on') : chalk.dim('off');

    console.log(chalk.green('● Recording started'));
    console.log(chalk.dim(`  Session:    ${recorder.sessionId}`));
    console.log(chalk.dim(`  Objective:  ${options.objective}`));
    console.log(chalk.dim(`  Agent:      ${agent}`));
    console.log(chalk.dim(`  Drift:      ${driftStatus}  Guardrails: ${guardStatus}`));
    console.log('');

    overlay.start();

    // Write the network preload script for child process interception
    const preloadPath = join(hawkDir, '_preload.mjs');
    writeFileSync(preloadPath, generatePreloadScript());

    // Build network lock env var for the preload script
    const networkLockRule = config.guardrails.find(
      (r) => r.type === 'network_lock' && r.enabled,
    );
    const networkLockEnv: Record<string, string> = {};
    if (networkLockRule && options.guardrails !== false) {
      networkLockEnv.HAWKEYE_NETWORK_LOCK = JSON.stringify({
        enabled: true,
        action: networkLockRule.action,
        allowedHosts: (networkLockRule.config as Record<string, unknown>).allowedHosts || [],
        blockedHosts: (networkLockRule.config as Record<string, unknown>).blockedHosts || [],
      });
    }

    // Build guardrails env var for proactive file/command blocking in the preload script
    const guardrailEnv: Record<string, string> = {};
    if (options.guardrails !== false) {
      const activeRules = config.guardrails.filter((r) => r.enabled);
      const fileProtect = activeRules.find((r) => r.type === 'file_protect');
      const commandBlock = activeRules.find((r) => r.type === 'command_block');
      const directoryScope = activeRules.find((r) => r.type === 'directory_scope');

      if (fileProtect || commandBlock || directoryScope) {
        guardrailEnv.HAWKEYE_GUARDRAILS = JSON.stringify({
          fileProtect: fileProtect
            ? { paths: (fileProtect.config as Record<string, unknown>).paths, action: fileProtect.action }
            : null,
          commandBlock: commandBlock
            ? { patterns: (commandBlock.config as Record<string, unknown>).patterns, action: commandBlock.action }
            : null,
          directoryScope: directoryScope
            ? { blockedDirs: (directoryScope.config as Record<string, unknown>).blockedDirs, action: directoryScope.action }
            : null,
          workingDir: cwd,
        });
      }
    }

    // Spawn the wrapped command with IPC channel + network preload
    const [cmd, ...args] = commandArgs;
    const existingNodeOpts = process.env.NODE_OPTIONS || '';
    childProcess = spawn(cmd, args, {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        ...networkLockEnv,
        ...guardrailEnv,
        NODE_OPTIONS: `${existingNodeOpts} --import file://${preloadPath}`.trim(),
      },
    });

    // Listen for LLM events, network block events, and guardrail block events from child process via IPC
    childProcess.on('message', (msg: unknown) => {
      const m = msg as { type?: string; event?: Record<string, unknown>; hostname?: string; url?: string; reason?: string; guardType?: string; detail?: string };
      if (m?.type === 'hawkeye:llm' && m.event) {
        recorder.recordLlmEvent(m.event as unknown as import('@hawkeye/core').LlmEvent);
      } else if (m?.type === 'hawkeye:network_block' && m.hostname && m.reason) {
        // Network block happened in child process — log it in the parent
        overlay.stop();
        console.error('');
        console.error(chalk.red(`  ⛔ NETWORK BLOCKED [network_lock]`));
        console.error(chalk.dim(`    ${m.reason}`));
        console.error('');
        overlay.start();
      } else if (m?.type === 'hawkeye:guardrail_block' && m.reason) {
        // Proactive guardrail block happened in child process (fs/command interception)
        overlay.stop();
        console.error('');
        console.error(chalk.red(`  ⛔ GUARDRAIL BLOCKED [${m.guardType || 'unknown'}]`));
        console.error(chalk.dim(`    ${m.reason}`));
        if (m.detail) console.error(chalk.dim(`    Target: ${m.detail}`));
        console.error('');
        overlay.start();
      }
    });

    // Ignore IPC disconnect errors (child may not be Node.js)
    childProcess.on('error', () => {});

    childProcess.on('close', (code) => {
      cleanup(code === 0 ? 'completed' : 'aborted');
      process.exit(code ?? 1);
    });

    process.on('SIGINT', () => {
      cleanup('aborted');
      try { childProcess?.kill('SIGINT'); } catch {}
      process.exit(130);
    });

    process.on('SIGTERM', () => {
      cleanup('aborted');
      try { childProcess?.kill('SIGTERM'); } catch {}
      process.exit(143);
    });
  });

function getEventSummary(event: import('@hawkeye/core').TraceEvent): string {
  const d = event.data as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'command': return `${d.command || ''} ${((d.args as string[]) || []).join(' ')}`.trim();
    case 'file_write': return `Modified ${d.path || ''}`;
    case 'file_delete': return `Deleted ${d.path || ''}`;
    case 'file_read': return `Read ${d.path || ''}`;
    case 'llm_call': return `${d.provider}/${d.model} (${d.totalTokens || 0} tokens)`;
    case 'api_call': return `${d.method || 'GET'} ${d.url || ''}`;
    case 'guardrail_trigger': return String(d.description || d.ruleName || '');
    case 'error': return String(d.message || d.error || 'Error');
    default: return event.type;
  }
}

function detectAgent(command: string): string {
  const lower = command.toLowerCase();
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('copilot')) return 'copilot';
  if (lower.includes('autogpt') || lower.includes('auto-gpt')) return 'autogpt';
  if (lower.includes('crewai')) return 'crewai';
  if (lower.includes('aider')) return 'aider';
  return command;
}

/**
 * Generates a self-contained ESM preload script that monkey-patches
 * http/https.request AND globalThis.fetch in the child process to capture
 * LLM API calls and send them back to the parent process via IPC.
 *
 * fetch() patching is critical because modern SDKs (Anthropic SDK, OpenAI SDK)
 * use Node.js native fetch (undici) which bypasses http.request entirely.
 */
function generatePreloadScript(): string {
  return `
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import childProc from 'node:child_process';
import { EventEmitter } from 'node:events';

const LLM_HOSTS = new Set([
  'api.anthropic.com', 'api.openai.com',
  'api.deepseek.com', 'api.mistral.ai',
  'generativelanguage.googleapis.com',
  'localhost:11434', '127.0.0.1:11434',
]);

// ── Network Lock (blocking) ──
const LOCALHOST_SET = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
let _networkLock = null;
try {
  const raw = process.env.HAWKEYE_NETWORK_LOCK;
  if (raw) _networkLock = JSON.parse(raw);
} catch {}

function isNetworkBlocked(hostname, port) {
  if (!_networkLock || !_networkLock.enabled || _networkLock.action !== 'block') return null;
  // Always allow localhost / internal
  if (LOCALHOST_SET.has(hostname)) return null;
  // Always allow known LLM hosts (Hawkeye uses these for drift detection)
  const hostPort = port ? hostname + ':' + port : hostname;
  if (LLM_HOSTS.has(hostPort) || LLM_HOSTS.has(hostname)) return null;

  // Check blocked hosts
  const blockedHosts = _networkLock.blockedHosts || [];
  for (const pattern of blockedHosts) {
    if (hostname === pattern || hostname.endsWith('.' + pattern)) {
      return 'Network request blocked by Hawkeye guardrail: hostname "' + hostname + '" is in the blocklist (matched: "' + pattern + '")';
    }
  }

  // Check allowlist
  const allowedHosts = _networkLock.allowedHosts || [];
  if (allowedHosts.length > 0) {
    let allowed = false;
    for (const pattern of allowedHosts) {
      if (hostname === pattern || hostname.endsWith('.' + pattern)) { allowed = true; break; }
    }
    if (!allowed) {
      return 'Network request blocked by Hawkeye guardrail: hostname "' + hostname + '" is not in the allowlist';
    }
  }

  return null;
}

function sendBlockEvent(hostname, url, reason) {
  try {
    if (typeof process.send === 'function') {
      process.send({ type: 'hawkeye:network_block', hostname, url, reason });
    }
  } catch {}
}

// ── Guardrails (proactive file + command blocking) ──
let _guardrails = null;
try {
  const rawG = process.env.HAWKEYE_GUARDRAILS;
  if (rawG) _guardrails = JSON.parse(rawG);
} catch {}

function sendGuardrailBlock(type, detail, reason) {
  try {
    if (typeof process.send === 'function') {
      process.send({ type: 'hawkeye:guardrail_block', guardType: type, detail, reason });
    }
  } catch {}
}

function matchesSimpleGlob(str, pattern) {
  // Simple glob: *.ext, .env.*, .env, **/*.key
  const regex = pattern
    .replace(/\\./g, '\\\\.')
    .replace(/\\*\\*/g, '{{GLOBSTAR}}')
    .replace(/\\*/g, '[^/]*')
    .replace(/\\{\\{GLOBSTAR\\}\\}/g, '.*');
  return new RegExp('(^|/)' + regex + '$').test(str);
}

function isFileBlocked(filePath) {
  if (!_guardrails) return null;
  const resolved = typeof filePath === 'string' ? filePath : String(filePath);

  // Check directory scope
  if (_guardrails.directoryScope && _guardrails.directoryScope.action === 'block') {
    const home = process.env.HOME || '/root';
    for (const dir of _guardrails.directoryScope.blockedDirs) {
      const expanded = dir.replace('~', home);
      if (resolved.startsWith(expanded + '/') || resolved === expanded) {
        return 'Hawkeye guardrail: file operation in blocked directory "' + dir + '"';
      }
    }
  }

  // Check file protect
  if (_guardrails.fileProtect && _guardrails.fileProtect.action === 'block') {
    const relativePath = _guardrails.workingDir ? resolved.replace(_guardrails.workingDir + '/', '') : resolved;
    const basename = resolved.split('/').pop() || '';
    for (const pattern of _guardrails.fileProtect.paths) {
      if (matchesSimpleGlob(relativePath, pattern) || matchesSimpleGlob(basename, pattern)) {
        return 'Hawkeye guardrail: protected file blocked "' + basename + '" (matches "' + pattern + '")';
      }
    }
  }

  return null;
}

function isCommandBlocked(command) {
  if (!_guardrails || !_guardrails.commandBlock || _guardrails.commandBlock.action !== 'block') return null;

  for (const pattern of _guardrails.commandBlock.patterns) {
    if (pattern.includes('*')) {
      // Split on *, escape each part for regex, join with .*
      const parts = pattern.split('*');
      // Escape regex special chars in each literal part
      const escaped = parts.map(function(p) {
        var result = '';
        for (var i = 0; i < p.length; i++) {
          var c = p.charAt(i);
          var specials = '.+^' + String.fromCharCode(36) + '{}()|/';
          if (specials.indexOf(c) !== -1 || c === String.fromCharCode(92) || c === String.fromCharCode(91) || c === String.fromCharCode(93)) {
            result += String.fromCharCode(92) + c;
          } else {
            result += c;
          }
        }
        return result;
      });
      if (new RegExp(escaped.join('.*'), 'i').test(command)) {
        return 'Hawkeye guardrail: dangerous command blocked (matches "' + pattern + '")';
      }
    } else if (command.toLowerCase().includes(pattern.toLowerCase())) {
      return 'Hawkeye guardrail: dangerous command blocked (matches "' + pattern + '")';
    }
  }
  return null;
}

// ── Proactive fs + child_process patching ──
if (_guardrails) {
  // -- fs.writeFileSync --
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function(path, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      throw new Error(reason);
    }
    return origWriteFileSync.call(this, path, ...args);
  };

  // -- fs.writeFile (callback) --
  const origWriteFile = fs.writeFile;
  fs.writeFile = function(path, data, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error(reason));
      return;
    }
    return origWriteFile.call(this, path, data, ...args);
  };

  // -- fs.unlinkSync --
  const origUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function(path) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      throw new Error(reason);
    }
    return origUnlinkSync.call(this, path);
  };

  // -- fs.unlink (callback) --
  const origUnlink = fs.unlink;
  fs.unlink = function(path, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error(reason));
      return;
    }
    return origUnlink.call(this, path, ...args);
  };

  // -- fs.renameSync --
  const origRenameSync = fs.renameSync;
  fs.renameSync = function(oldPath, newPath) {
    const reason = isFileBlocked(String(newPath)) || isFileBlocked(String(oldPath));
    if (reason) {
      sendGuardrailBlock('file_protect', String(newPath || oldPath), reason);
      throw new Error(reason);
    }
    return origRenameSync.call(this, oldPath, newPath);
  };

  // -- fs.rename (callback) --
  const origRename = fs.rename;
  fs.rename = function(oldPath, newPath, ...args) {
    const reason = isFileBlocked(String(newPath)) || isFileBlocked(String(oldPath));
    if (reason) {
      sendGuardrailBlock('file_protect', String(newPath || oldPath), reason);
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error(reason));
      return;
    }
    return origRename.call(this, oldPath, newPath, ...args);
  };

  // -- fs.appendFileSync --
  const origAppendFileSync = fs.appendFileSync;
  fs.appendFileSync = function(path, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      throw new Error(reason);
    }
    return origAppendFileSync.call(this, path, ...args);
  };

  // -- fs.appendFile (callback) --
  const origAppendFile = fs.appendFile;
  fs.appendFile = function(path, data, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error(reason));
      return;
    }
    return origAppendFile.call(this, path, data, ...args);
  };

  // -- fs.promises.writeFile --
  const origPromisesWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async function(path, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      throw new Error(reason);
    }
    return origPromisesWriteFile.call(this, path, ...args);
  };

  // -- fs.promises.unlink --
  const origPromisesUnlink = fs.promises.unlink;
  fs.promises.unlink = async function(path) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      throw new Error(reason);
    }
    return origPromisesUnlink.call(this, path);
  };

  // -- fs.promises.rename --
  const origPromisesRename = fs.promises.rename;
  fs.promises.rename = async function(oldPath, newPath) {
    const reason = isFileBlocked(String(newPath)) || isFileBlocked(String(oldPath));
    if (reason) {
      sendGuardrailBlock('file_protect', String(newPath || oldPath), reason);
      throw new Error(reason);
    }
    return origPromisesRename.call(this, oldPath, newPath);
  };

  // -- fs.promises.appendFile --
  const origPromisesAppendFile = fs.promises.appendFile;
  fs.promises.appendFile = async function(path, ...args) {
    const reason = isFileBlocked(String(path));
    if (reason) {
      sendGuardrailBlock('file_protect', String(path), reason);
      throw new Error(reason);
    }
    return origPromisesAppendFile.call(this, path, ...args);
  };

  // -- child_process.execSync --
  const origExecSync = childProc.execSync;
  childProc.execSync = function(command, ...args) {
    const reason = isCommandBlocked(String(command));
    if (reason) {
      sendGuardrailBlock('command_block', String(command), reason);
      throw new Error(reason);
    }
    return origExecSync.call(this, command, ...args);
  };

  // -- child_process.exec --
  const origExec = childProc.exec;
  childProc.exec = function(command, ...args) {
    const reason = isCommandBlocked(String(command));
    if (reason) {
      sendGuardrailBlock('command_block', String(command), reason);
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error(reason));
      return;
    }
    return origExec.call(this, command, ...args);
  };

  // -- child_process.execFileSync --
  const origExecFileSync = childProc.execFileSync;
  childProc.execFileSync = function(file, execArgs, ...rest) {
    const fullCmd = execArgs ? file + ' ' + (Array.isArray(execArgs) ? execArgs.join(' ') : '') : String(file);
    const reason = isCommandBlocked(fullCmd);
    if (reason) {
      sendGuardrailBlock('command_block', fullCmd, reason);
      throw new Error(reason);
    }
    return origExecFileSync.call(this, file, execArgs, ...rest);
  };

  // -- child_process.execFile --
  const origExecFile = childProc.execFile;
  childProc.execFile = function(file, execArgs, ...rest) {
    const fullCmd = execArgs ? file + ' ' + (Array.isArray(execArgs) ? execArgs.join(' ') : '') : String(file);
    const reason = isCommandBlocked(fullCmd);
    if (reason) {
      sendGuardrailBlock('command_block', fullCmd, reason);
      const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
      if (cb) cb(new Error(reason));
      return;
    }
    return origExecFile.call(this, file, execArgs, ...rest);
  };

  // -- child_process.spawn --
  const origSpawn = childProc.spawn;
  childProc.spawn = function(command, spawnArgs, ...rest) {
    const fullCmd = spawnArgs && Array.isArray(spawnArgs) ? command + ' ' + spawnArgs.join(' ') : String(command);
    const reason = isCommandBlocked(fullCmd);
    if (reason) {
      sendGuardrailBlock('command_block', fullCmd, reason);
      // Return a fake child process that immediately errors
      const fake = new EventEmitter();
      fake.pid = -1;
      fake.stdin = null;
      fake.stdout = null;
      fake.stderr = null;
      fake.kill = () => {};
      fake.ref = () => fake;
      fake.unref = () => fake;
      process.nextTick(() => {
        fake.emit('error', new Error(reason));
        fake.emit('close', 1);
      });
      return fake;
    }
    return origSpawn.call(this, command, spawnArgs, ...rest);
  };

  // -- child_process.spawnSync --
  const origSpawnSync = childProc.spawnSync;
  childProc.spawnSync = function(command, spawnArgs, ...rest) {
    const fullCmd = spawnArgs && Array.isArray(spawnArgs) ? command + ' ' + spawnArgs.join(' ') : String(command);
    const reason = isCommandBlocked(fullCmd);
    if (reason) {
      sendGuardrailBlock('command_block', fullCmd, reason);
      return { pid: -1, output: [null, null, Buffer.from(reason)], stdout: Buffer.alloc(0), stderr: Buffer.from(reason), status: 1, signal: null, error: new Error(reason) };
    }
    return origSpawnSync.call(this, command, spawnArgs, ...rest);
  };
}

const LLM_PATHS = {
  '/v1/messages': 'anthropic',
  '/v1/chat/completions': 'openai',
  '/api/generate': 'ollama',
  '/api/chat': 'ollama',
};

const COST_TABLE = {
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'o3': { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek-reasoner': { input: 0.28, output: 0.42 },
  'mistral-large-latest': { input: 0.5, output: 1.5 },
  'mistral-small-latest': { input: 0.1, output: 0.3 },
  'codestral-latest': { input: 0.3, output: 0.9 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
};

function sendEvent(event) {
  try {
    if (typeof process.send === 'function') {
      process.send({ type: 'hawkeye:llm', event });
    }
  } catch {}
}

function detectProvider(hostname, port, path, headers) {
  const hostPort = port ? hostname + ':' + port : hostname;
  if (LLM_HOSTS.has(hostPort) || LLM_HOSTS.has(hostname)) {
    if (hostname.includes('anthropic')) return 'anthropic';
    if (hostname.includes('openai')) return 'openai';
    if (hostname.includes('deepseek')) return 'deepseek';
    if (hostname.includes('mistral')) return 'mistral';
    if (hostname.includes('googleapis')) return 'google';
    return 'ollama';
  }
  if (LLM_HOSTS.has(hostname)) {
    if (hostname.includes('anthropic')) return 'anthropic';
    if (hostname.includes('openai')) return 'openai';
    if (hostname.includes('deepseek')) return 'deepseek';
    if (hostname.includes('mistral')) return 'mistral';
    if (hostname.includes('googleapis')) return 'google';
    return 'ollama';
  }
  const basePath = (path || '/').split('?')[0];
  if (LLM_PATHS[basePath]) {
    const lp = LLM_PATHS[basePath];
    if (lp === 'anthropic') {
      if (headers && (headers['anthropic-version'] || headers['x-api-key'])) return 'anthropic';
      return null;
    }
    return lp;
  }
  return null;
}

function extractTokens(provider, body) {
  const u = body.usage || {};
  if (provider === 'anthropic') {
    return { model: body.model || 'unknown', input: u.input_tokens || 0, output: u.output_tokens || 0 };
  }
  if (provider === 'openai') {
    return { model: body.model || 'unknown', input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
  }
  return { model: body.model || 'unknown', input: body.prompt_eval_count || 0, output: body.eval_count || 0 };
}

function estimateCost(model, input, output) {
  const c = COST_TABLE[model] || Object.entries(COST_TABLE).find(([k]) => model.startsWith(k))?.[1];
  if (!c) return 0;
  return (input * c.input + output * c.output) / 1000000;
}

// ── Patch fetch() (used by Anthropic SDK, OpenAI SDK, and modern Node.js apps) ──
const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = async function patchedFetch(input, init) {
    const startTime = Date.now();
    let url;
    try {
      if (typeof input === 'string') {
        url = new URL(input);
      } else if (input instanceof URL) {
        url = input;
      } else if (input && typeof input === 'object' && input.url) {
        url = new URL(input.url);
      }
    } catch {}

    if (!url) return originalFetch.call(this, input, init);

    // ── Network lock check (BEFORE making the request) ──
    const blockReason = isNetworkBlocked(url.hostname, url.port);
    if (blockReason) {
      const fullUrl = url.href;
      sendBlockEvent(url.hostname, fullUrl, blockReason);
      throw new Error(blockReason);
    }

    const headers = {};
    const rawHeaders = init?.headers || (input && typeof input === 'object' ? input.headers : null);
    if (rawHeaders) {
      if (typeof rawHeaders.forEach === 'function') {
        rawHeaders.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      } else if (typeof rawHeaders === 'object') {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    const provider = detectProvider(url.hostname, url.port, url.pathname, headers);
    if (!provider) return originalFetch.call(this, input, init);

    const response = await originalFetch.call(this, input, init);
    if (!response.ok) return response;

    // Clone so we can read the body without consuming the original
    const cloned = response.clone();
    const contentType = response.headers.get('content-type') || '';

    cloned.text().then((text) => {
      try {
        const latencyMs = Date.now() - startTime;

        if (contentType.includes('text/event-stream')) {
          // SSE streaming response (Anthropic/OpenAI streaming mode)
          // Parse SSE events to extract usage from message_start + message_delta
          let model = 'unknown';
          let inputTokens = 0;
          let outputTokens = 0;
          for (const line of text.split('\\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const evt = JSON.parse(data);
              // Anthropic streaming: message_start has model + input_tokens
              if (evt.type === 'message_start' && evt.message) {
                model = evt.message.model || model;
                inputTokens = evt.message.usage?.input_tokens || 0;
              }
              // Anthropic streaming: message_delta has output_tokens
              if (evt.type === 'message_delta' && evt.usage) {
                outputTokens = evt.usage.output_tokens || 0;
              }
              // OpenAI streaming: last chunk may have usage
              if (evt.usage) {
                if (evt.usage.prompt_tokens) inputTokens = evt.usage.prompt_tokens;
                if (evt.usage.completion_tokens) outputTokens = evt.usage.completion_tokens;
              }
              if (evt.model) model = evt.model;
            } catch {}
          }
          if (inputTokens > 0 || outputTokens > 0) {
            const costUsd = estimateCost(model, inputTokens, outputTokens);
            sendEvent({
              provider, model, promptTokens: inputTokens, completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens, costUsd, latencyMs,
            });
          }
        } else {
          // Regular JSON response (non-streaming)
          const json = JSON.parse(text);
          const tokens = extractTokens(provider, json);
          const costUsd = estimateCost(tokens.model, tokens.input, tokens.output);
          sendEvent({
            provider, model: tokens.model,
            promptTokens: tokens.input, completionTokens: tokens.output,
            totalTokens: tokens.input + tokens.output, costUsd, latencyMs,
          });
        }
      } catch {}
    }).catch(() => {});

    return response;
  };
}

// ── Patch http/https.request (used by older Node.js apps and libraries) ──
function patchModule(mod) {
  const origRequest = mod.request;
  mod.request = function(...args) {
    const first = args[0];
    let hostname, port, path, method;
    if (typeof first === 'string') {
      try { const u = new URL(first); hostname = u.hostname; port = u.port; path = u.pathname; method = 'GET'; } catch { return origRequest.apply(this, args); }
    } else if (first instanceof URL) {
      hostname = first.hostname; port = first.port; path = first.pathname; method = 'GET';
    } else if (first && typeof first === 'object') {
      hostname = (first.hostname || first.host || '').split(':')[0];
      port = first.port ? String(first.port) : (first.hostname || first.host || '').split(':')[1];
      path = first.path || '/';
      method = first.method || 'GET';
    } else { return origRequest.apply(this, args); }

    // ── Network lock check (BEFORE making the request) ──
    const blockReason = isNetworkBlocked(hostname, port);
    if (blockReason) {
      const proto = mod === https ? 'https:' : 'http:';
      const fullUrl = proto + '//' + hostname + (port ? ':' + port : '') + (path || '/');
      sendBlockEvent(hostname, fullUrl, blockReason);
      // Return a fake request that immediately errors
      const fakeReq = origRequest.call(this, { hostname: 'localhost', port: 1, path: '/__hawkeye_blocked' });
      process.nextTick(() => {
        fakeReq.destroy(new Error(blockReason));
      });
      return fakeReq;
    }

    const req = origRequest.apply(this, args);
    const headers = (first && typeof first === 'object' && !(first instanceof URL)) ? (first.headers || {}) : {};
    const provider = detectProvider(hostname, port, path, headers);
    if (!provider) return req;

    const startTime = Date.now();
    let requestBody = '';
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);

    req.write = function(chunk, ...rest) {
      if (chunk) requestBody += typeof chunk === 'string' ? chunk : chunk.toString();
      return origWrite(chunk, ...rest);
    };
    req.end = function(chunk, ...rest) {
      if (chunk && typeof chunk !== 'function') requestBody += typeof chunk === 'string' ? chunk : chunk.toString();
      return origEnd(chunk, ...rest);
    };

    req.on('response', (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk.toString(); });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return;
        try {
          const json = JSON.parse(responseBody);
          const tokens = extractTokens(provider, json);
          const costUsd = estimateCost(tokens.model, tokens.input, tokens.output);
          sendEvent({
            provider,
            model: tokens.model,
            promptTokens: tokens.input,
            completionTokens: tokens.output,
            totalTokens: tokens.input + tokens.output,
            costUsd,
            latencyMs: Date.now() - startTime,
          });
        } catch {}
      });
    });

    return req;
  };
}

patchModule(http);
patchModule(https);
`;
}
