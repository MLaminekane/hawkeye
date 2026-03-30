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
import { basename, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { loadConfig, normalizeLmStudioUrl } from '../config.js';
import { fireWebhooks } from '../webhooks.js';
import { buildAgentInvocation, inferAgentName } from './agent-command.js';

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
  attachments?: string[];
}

export interface DaemonStatus {
  pid: number;
  agent: string;
  intervalSec: number;
  startedAt: string;
  lastHeartbeatAt: string;
  currentTaskId: string | null;
  currentTaskPid: number | null;
}

// ─── Task file helpers ───────────────────────────────────────

function ensureHawkeyeDir(cwd: string): string {
  const dir = join(cwd, '.hawkeye');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getTasksFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'tasks.json');
}

export function getDaemonStatusFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'daemon-status.json');
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
  ensureHawkeyeDir(cwd);
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

export function updateTask(cwd: string, taskId: string, updates: Partial<Task>): void {
  const tasks = loadTasks(cwd);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx >= 0) {
    Object.assign(tasks[idx], updates);
    saveTasks(cwd, tasks);
  }
}

export function readDaemonStatus(cwd: string): DaemonStatus | null {
  const file = getDaemonStatusFile(cwd);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as DaemonStatus;
  } catch {
    return null;
  }
}

export function writeDaemonStatus(cwd: string, status: DaemonStatus): void {
  ensureHawkeyeDir(cwd);
  writeFileSync(getDaemonStatusFile(cwd), JSON.stringify(status, null, 2));
}

export function clearDaemonStatus(cwd: string): void {
  const file = getDaemonStatusFile(cwd);
  if (existsSync(file)) unlinkSync(file);
}

export function isDaemonStatusFresh(status: DaemonStatus | null, now = Date.now()): boolean {
  if (!status) return false;
  const heartbeat = new Date(status.lastHeartbeatAt).getTime();
  if (Number.isNaN(heartbeat)) return false;
  const freshnessWindow = Math.max(5000, status.intervalSec * 2500);
  return now - heartbeat <= freshnessWindow;
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
    return execSync('git diff --stat HEAD', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

function getAiderMapTokens(agentCmd: string): number {
  const match = agentCmd.match(/--map-tokens\s+(\d+)/);
  if (!match) return 0;
  return Number.parseInt(match[1] || '0', 10) || 0;
}

interface ClineProfile {
  provider: string;
  model: string;
}

function parseClineProfile(agentCmd: string): ClineProfile | null {
  const match = agentCmd.trim().match(/^cline\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    provider: match[1] || '',
    model: match[2] || '',
  };
}

type ContextMode = 'standard' | 'off' | 'project' | 'deep';

function getContextMode(agentCmd: string): ContextMode {
  const normalized = agentCmd.trim();
  if (!normalized) return 'standard';

  if (inferAgentName(agentCmd) === 'codex') {
    return 'off';
  }

  if (parseClineProfile(agentCmd) || inferAgentName(agentCmd) === 'cline') {
    return 'off';
  }

  if (inferAgentName(agentCmd) === 'aider') {
    const mapTokens = getAiderMapTokens(agentCmd);
    if (mapTokens <= 0) return 'off';
    if (mapTokens >= 4096) return 'deep';
    return 'project';
  }

  return /^(ollama|lmstudio)(?:\/|$)/.test(normalized) ? 'off' : 'standard';
}

function readExcerpt(filePath: string, maxChars: number): string {
  if (!existsSync(filePath)) return '';
  try {
    const text = readFileSync(filePath, 'utf-8').trim();
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
  } catch {
    return '';
  }
}

function readPackageSummary(cwd: string): string {
  const filePath = join(cwd, 'package.json');
  if (!existsSync(filePath)) return '';
  try {
    const pkg = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      name?: string;
      description?: string;
      packageManager?: string;
      workspaces?: string[];
      scripts?: Record<string, string>;
    };
    const sections: string[] = [];
    if (pkg.name) sections.push(`name: ${pkg.name}`);
    if (pkg.description) sections.push(`description: ${pkg.description}`);
    if (pkg.packageManager) sections.push(`package manager: ${pkg.packageManager}`);
    if (Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0) {
      sections.push(`workspaces: ${pkg.workspaces.slice(0, 8).join(', ')}`);
    }
    const scriptNames = Object.keys(pkg.scripts || {});
    if (scriptNames.length > 0) {
      sections.push(`scripts: ${scriptNames.slice(0, 10).join(', ')}`);
    }
    return sections.join('\n');
  } catch {
    return '';
  }
}

function readTopLevelStructure(cwd: string): string {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !['.git', '.hawkeye', 'node_modules', 'dist', 'coverage'].includes(entry.name))
      .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`)
      .slice(0, 20);
    return entries.join('\n');
  } catch {
    return '';
  }
}

// ─── Context builder ─────────────────────────────────────────

export function gatherContext(cwd: string, mode: ContextMode = 'standard'): string {
  const sections: string[] = [];

  if (mode === 'project' || mode === 'deep') {
    sections.push(`[Repository]\nname: ${basename(cwd)}\nroot: ${cwd}`);

    const structure = readTopLevelStructure(cwd);
    if (structure) {
      sections.push(`[Top-level structure]\n${structure}`);
    }

    const packageSummary = readPackageSummary(cwd);
    if (packageSummary) {
      sections.push(`[package.json summary]\n${packageSummary}`);
    }

    const readme = readExcerpt(join(cwd, 'README.md'), mode === 'deep' ? 2200 : 1400)
      || readExcerpt(join(cwd, 'README'), mode === 'deep' ? 2200 : 1400);
    if (readme) {
      sections.push(`[README excerpt]\n${readme}`);
    }

    if (mode === 'deep') {
      const claudeGuide = readExcerpt(join(cwd, 'CLAUDE.md'), 1800);
      if (claudeGuide) {
        sections.push(`[CLAUDE.md excerpt]\n${claudeGuide}`);
      }
    }
  }

  // 1. Git status — what files are currently modified
  try {
    const status = execSync('git status --short', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    if (status) {
      sections.push(`[Current git status]\n${status}`);
    }
  } catch {}

  // 2. Git branch
  try {
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();
    if (branch) {
      sections.push(`[Current branch] ${branch}`);
    }
  } catch {}

  // 3. Recent git commits
  try {
    const log = execSync('git log --oneline -5', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
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

export function shouldInjectTaskContext(agentCmd: string): boolean {
  return getContextMode(agentCmd) !== 'off';
}

export function isLightweightPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return true;

  const genericPrompts = [
    'salut',
    'hello',
    'hi',
    'hey',
    'bonjour',
    'yo',
    'test',
    'ping',
  ];

  if (genericPrompts.includes(normalized)) {
    return true;
  }

  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  const mentionsPath = /[/.\\]/.test(normalized);
  const actionableIntent = /\b(fix|corrige|correct|change|edit|refactor|implement|add|remove|delete|rename|review|analyze|inspect|debug|investigate|look at|ouvre|ouvre-moi|regarde|analyse|modifie|ajoute|supprime|renomme|compare|export|stream|retry|cancel|clear|load|open)\b/.test(normalized);
  const opinionIntent = /\b(que penses[- ]?tu|what do you think|your opinion|avis|opinion|c.?est quoi|c'est quoi|what is|explique|explain|describe|describe me|tell me about|parle[- ]?moi|who are you|tu es dans quel projet)\b/.test(normalized);

  if (opinionIntent && !mentionsPath && !actionableIntent) {
    return true;
  }

  if (tokenCount <= 10 && !mentionsPath && !actionableIntent) {
    return true;
  }

  return false;
}

function buildConciseResponsePrompt(prompt: string): string {
  return [
    'Answer directly and concisely in the same language as the user.',
    'Do not describe your process, do not narrate what you inspected, and do not ask a follow-up question unless required.',
    '',
    prompt,
  ].join('\n');
}

function buildPromptWithContext(task: Task, cwd: string, agentCmd: string): string {
  const mode = getContextMode(agentCmd);
  if (isLightweightPrompt(task.prompt)) {
    return buildConciseResponsePrompt(task.prompt);
  }

  if (mode === 'off') {
    return task.prompt;
  }

  const context = gatherContext(cwd, mode);
  if (!context) return task.prompt;
  return `${context}\n\n---\n\n[User request]\n${task.prompt}`;
}

function summarizeTaskFailure(output: string, agentCmd: string): string {
  const cleaned = output.trim();
  if (!cleaned) return 'Task failed with no output.';

  if (/You've hit your limit/i.test(cleaned) || /You're out of extra usage/i.test(cleaned)) {
    const line =
      cleaned
        .split('\n')
        .find((entry) => /hit your limit|out of extra usage/i.test(entry))
        ?.trim() || cleaned.slice(0, 200);
    return `${inferAgentName(agentCmd)} is currently rate-limited: ${line}`;
  }

  if (/prompt too long|exceeded max context length/i.test(cleaned)) {
    return `${inferAgentName(agentCmd)} exceeded the model context window. Try the Fast repo awareness mode or shorten the brief before retrying.`;
  }

  return cleaned.slice(0, 2000);
}

function hasAgentFailureSignature(output: string): boolean {
  return /litellm\.authenticationerror/i.test(output)
    || /incorrect api key provided/i.test(output)
    || /the api provider is not able to authenticate you/i.test(output)
    || /authentication fails/i.test(output);
}

function sanitizeCodexStderr(stderr: string): string {
  if (!stderr) return '';

  const kept = stderr
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^mcp startup:\s+no servers$/i.test(trimmed)) return false;
      if (/codex_state::runtime: failed to open state db/i.test(trimmed)) return false;
      if (/codex_core::state_db: failed to initialize state runtime/i.test(trimmed)) return false;
      if (/codex_core::rollout::list: state db discrepancy/i.test(trimmed)) return false;
      if (/codex_core::shell_snapshot: failed to delete shell snapshot/i.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return kept;
}

export function extractCodexFinalResponse(stdout: string): string {
  if (!stdout.trim()) return '';

  const lines = stdout.split('\n');
  let currentSpeaker: 'codex' | 'other' | null = null;
  let currentLines: string[] = [];
  const codexSegments: string[] = [];

  const flushSegment = () => {
    if (currentSpeaker === 'codex') {
      const segment = currentLines.join('\n').trim();
      if (segment) codexSegments.push(segment);
    }
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'codex' || trimmed === 'user' || trimmed === 'exec') {
      flushSegment();
      currentSpeaker = trimmed === 'codex' ? 'codex' : 'other';
      continue;
    }
    if (/^tokens used$/i.test(trimmed)) {
      flushSegment();
      currentSpeaker = 'other';
      continue;
    }
    currentLines.push(line);
  }
  flushSegment();

  if (codexSegments.length > 0) {
    return codexSegments[codexSegments.length - 1] || '';
  }

  return stdout
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^OpenAI Codex v/i.test(trimmed)) return false;
      if (/^--------$/.test(trimmed)) return false;
      if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(trimmed)) return false;
      if (/^tokens used$/i.test(trimmed)) return false;
      if (/^\d[\d,]*$/.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function formatTaskOutput(stdout: string, stderr: string, agentCmd: string, exitCode?: number | null): string {
  const agentName = inferAgentName(agentCmd);
  const cleanedStdout = agentName === 'codex' ? extractCodexFinalResponse(stdout) : stdout.trim();
  const cleanedStderr = agentName === 'codex' ? sanitizeCodexStderr(stderr) : stderr.trim();

  if (exitCode === 0 && cleanedStdout) {
    return cleanedStdout;
  }

  if (cleanedStdout && cleanedStderr) {
    return `${cleanedStdout}\n\n--- stderr ---\n${cleanedStderr}`;
  }

  return cleanedStdout || cleanedStderr;
}

export function injectConfiguredApiKeys(env: NodeJS.ProcessEnv, cwd: string, agentCmd?: string): NodeJS.ProcessEnv {
  const merged = { ...env };
  const config = loadConfig(cwd);
  const keyMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    google: 'GOOGLE_API_KEY',
  };

  // When the agent is plain "claude" (subscription mode), skip injecting
  // ANTHROPIC_API_KEY — it would override the user's subscription auth and
  // cause "Credit balance is too low" errors if the API key has no credits.
  const isClaudeSubscription = agentCmd !== undefined
    && inferAgentName(agentCmd) === 'claude'
    && !/^(claude-api|anthropic)\//.test(agentCmd.trim());

  if (isClaudeSubscription) {
    delete merged.ANTHROPIC_API_KEY;
  }

  if (config.apiKeys) {
    for (const [provider, envVar] of Object.entries(keyMap)) {
      if (isClaudeSubscription && provider === 'anthropic') continue;
      const key = config.apiKeys[provider as keyof typeof config.apiKeys];
      if (key && !merged[envVar]) {
        merged[envVar] = key;
      }
    }
  }

  return merged;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function getClineConfigDir(cwd: string, provider: string, model: string): string {
  return join(cwd, '.hawkeye', 'cline', `${sanitizePathSegment(provider)}-${sanitizePathSegment(model)}`);
}

export function ensureClineProfile(agentCmd: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const profile = parseClineProfile(agentCmd);
  if (!profile) {
    return agentCmd === 'cline' ? 'cline -y -a' : agentCmd;
  }

  const configDir = getClineConfigDir(cwd, profile.provider, profile.model);
  mkdirSync(configDir, { recursive: true });

  const providerEnvKey: Record<string, string | null> = {
    anthropic: 'ANTHROPIC_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    'openai-native': 'OPENAI_API_KEY',
    openai: 'OPENAI_API_KEY',
    ollama: null,
    lmstudio: null,
  };

  const config = loadConfig(cwd);
  const authArgs = ['auth', '--config', configDir];

  if (profile.provider === 'lmstudio') {
    authArgs.push(
      '-p',
      'openai',
      '-k',
      'local',
      '-m',
      profile.model,
      '-b',
      normalizeLmStudioUrl(config.drift?.lmstudioUrl || 'http://127.0.0.1:1234/v1'),
    );
  } else if (profile.provider === 'ollama') {
    const ollamaBase = `${(config.drift?.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '')}/v1`;
    authArgs.push(
      '-p',
      'openai',
      '-k',
      'local',
      '-m',
      profile.model,
      '-b',
      ollamaBase,
    );
  } else {
    const keyEnv = providerEnvKey[profile.provider] ?? null;
    const key = keyEnv ? env[keyEnv] : null;
    authArgs.push('-p', profile.provider, '-m', profile.model);
    if (key) {
      authArgs.push('-k', key);
    }
  }

  const auth = spawnSync('cline', authArgs, {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (auth.status !== 0) {
    const details = `${auth.stdout || ''}${auth.stderr || ''}`.trim() || 'Unknown Cline auth error.';
    throw new Error(`Cline setup failed for ${profile.provider}/${profile.model}: ${details}`);
  }

  return `cline --config ${configDir} -c ${cwd} -y -a`;
}

// ─── Execute a task ──────────────────────────────────────────

export function shouldContinueSession(agentCmd: string, allTasks: Task[]): boolean {
  const agentName = inferAgentName(agentCmd);
  // Only for claude agent — use --continue to resume the last conversation
  if (agentName !== 'claude') return false;

  const lastCompleted = allTasks
    .filter(
      (t) =>
        t.status === 'completed'
        && t.exitCode === 0
        && inferAgentName(t.agent) === 'claude'
        && t.agent.trim() === agentCmd.trim(),
    )
    .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime())[0];

  if (!lastCompleted?.completedAt) return false;

  // Continue if last task completed within the last 30 minutes
  const elapsed = Date.now() - new Date(lastCompleted.completedAt).getTime();
  return elapsed < 30 * 60 * 1000;
}

interface ExecuteTaskHooks {
  onSpawn?: (pid: number | null) => void;
  onProgress?: (output: string) => void;
}

function executeTask(
  task: Task,
  agentCmd: string,
  cwd: string,
  allTasks: Task[],
  hooks: ExecuteTaskHooks = {},
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    // For Claude, use --continue to resume the last conversation if recent.
    // Other supported CLIs get the prompt in the form they expect.
    const env = injectConfiguredApiKeys(process.env, cwd, agentCmd);
    delete env.CLAUDECODE;

    let resolvedAgentCmd = agentCmd;
    try {
      resolvedAgentCmd = ensureClineProfile(agentCmd, cwd, env);
    } catch (err) {
      resolve({
        exitCode: 1,
        output: err instanceof Error ? err.message : 'Failed to prepare Cline.',
      });
      return;
    }

    const useContinue = shouldContinueSession(resolvedAgentCmd, allTasks);
    const enrichedPrompt = useContinue ? task.prompt : buildPromptWithContext(task, cwd, resolvedAgentCmd);
    const { cmd, args } = buildAgentInvocation(resolvedAgentCmd, enrichedPrompt, {
      continueConversation: useContinue,
    });

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    hooks.onSpawn?.(proc.pid ?? null);

    let stdout = '';
    let stderr = '';
    let flushTimer: NodeJS.Timeout | null = null;

    const flushProgress = () => {
      flushTimer = null;
      hooks.onProgress?.(formatTaskOutput(stdout, stderr, resolvedAgentCmd, null).slice(0, 10000));
    };

    const scheduleProgressFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flushProgress, 400);
    };

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      // Print live output
      process.stdout.write(chalk.dim(text));
      scheduleProgressFlush();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      scheduleProgressFlush();
    });

    proc.on('close', (code) => {
      if (flushTimer) clearTimeout(flushTimer);
      flushProgress();
      resolve({
        exitCode: code ?? 1,
        output: formatTaskOutput(stdout, stderr, resolvedAgentCmd, code ?? 1).slice(0, 50000),
      });
    });

    proc.on('error', (err) => {
      if (flushTimer) clearTimeout(flushTimer);
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
  const daemonState: DaemonStatus = {
    pid: process.pid,
    agent: agentCmd,
    intervalSec,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    currentTaskId: null,
    currentTaskPid: null,
  };

  const syncDaemonState = (updates: Partial<DaemonStatus> = {}) => {
    Object.assign(daemonState, updates, { lastHeartbeatAt: new Date().toISOString() });
    writeDaemonStatus(cwd, daemonState);
  };

  syncDaemonState();
  const heartbeat = setInterval(() => {
    syncDaemonState();
  }, Math.max(2000, Math.min(intervalSec * 1000, 5000))).unref();

  const poll = async () => {
    if (running) return;

    const tasks = loadTasks(cwd);
    const pending = tasks.find((t) => t.status === 'pending');
    if (!pending) return;

    running = true;
    const shortId = pending.id.slice(0, 8);
    const startedAt = new Date().toISOString();

    console.log(`  ${o('▶')} Task ${o.bold(shortId)}: ${chalk.white(pending.prompt.slice(0, 80))}${pending.prompt.length > 80 ? '...' : ''}`);

    updateTask(cwd, pending.id, {
      status: 'running',
      startedAt,
      completedAt: undefined,
      exitCode: undefined,
      error: undefined,
      output: '',
    });
    syncDaemonState({ currentTaskId: pending.id, currentTaskPid: null });

    // Snapshot git state before task runs
    const diffBefore = getGitDiffStat(cwd);

    try {
      // Use per-task agent if set (from dashboard), otherwise daemon default
      const taskAgent = pending.agent ? pending.agent : agentCmd;
      const result = await executeTask(pending, taskAgent, cwd, tasks, {
        onSpawn: (pid) => {
          syncDaemonState({ currentTaskId: pending.id, currentTaskPid: pid });
        },
        onProgress: (output) => {
          const latestTask = loadTasks(cwd).find((task) => task.id === pending.id);
          if (latestTask?.status === 'cancelled') return;
          updateTask(cwd, pending.id, { output });
          syncDaemonState({ currentTaskId: pending.id, currentTaskPid: daemonState.currentTaskPid });
        },
      });

      const latestTask = loadTasks(cwd).find((task) => task.id === pending.id);
      if (latestTask?.status === 'cancelled') {
        console.log(`  ${chalk.yellow('■')} Task ${o.bold(shortId)} cancelled`);
        syncDaemonState({ currentTaskId: null, currentTaskPid: null });
        running = false;
        console.log('');
        return;
      }

      const status = result.exitCode === 0 && !hasAgentFailureSignature(result.output) ? 'completed' : 'failed';
      const completedAt = new Date().toISOString();
      updateTask(cwd, pending.id, {
        status,
        completedAt,
        exitCode: result.exitCode,
        output: result.output.slice(0, 10000),
        error: result.exitCode !== 0 ? summarizeTaskFailure(result.output, taskAgent) : undefined,
      });

      // Write to persistent journal — this is the agent's long-term memory
      const diffAfter = getGitDiffStat(cwd);
      const diffChanged = diffAfter !== diffBefore ? diffAfter : '';
      appendToJournal(cwd, { ...pending, status, completedAt, output: result.output.slice(0, 500), error: result.exitCode !== 0 ? result.output.slice(0, 500) : undefined }, diffChanged);

      // Fire task_complete webhook
      const cfg = loadConfig(cwd);
      if (cfg.webhooks && cfg.webhooks.length > 0) {
        const durationSeconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
        fireWebhooks(cfg.webhooks, 'task_complete', {
          taskId: pending.id,
          prompt: pending.prompt,
          status,
          exitCode: result.exitCode,
          durationSeconds,
          outputSummary: result.output.slice(0, 500),
        });
      }

      if (status === 'completed') {
        console.log(`  ${chalk.green('✓')} Task ${o.bold(shortId)} completed`);
      } else {
        console.log(`  ${chalk.red('✗')} Task ${o.bold(shortId)} failed (exit code ${result.exitCode})`);
      }
    } catch (err) {
      const latestTask = loadTasks(cwd).find((task) => task.id === pending.id);
      if (latestTask?.status === 'cancelled') {
        console.log(`  ${chalk.yellow('■')} Task ${o.bold(shortId)} cancelled`);
      } else {
        updateTask(cwd, pending.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: String(err),
        });
        console.log(`  ${chalk.red('✗')} Task ${o.bold(shortId)} error: ${String(err)}`);
      }
    }

    syncDaemonState({ currentTaskId: null, currentTaskPid: null });
    running = false;
    console.log('');
  };

  // Initial poll
  await poll();

  // Set up interval
  const timer = setInterval(poll, intervalSec * 1000);

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(heartbeat);
    clearInterval(timer);
    clearDaemonStatus(cwd);
    console.log(chalk.dim('\n  Daemon stopped.'));
    process.exit(0);
  };

  process.on('exit', () => {
    clearInterval(heartbeat);
    clearDaemonStatus(cwd);
  });
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
