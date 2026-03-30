import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, extname, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync, mkdirSync, watch, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec, execFile, execFileSync, execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { Storage, analyzeRootCause, extractMemories, diffMemories, detectHallucinations, buildCumulativeMemory, createIncidentSnapshot, selfAssess, generateAutoCorrection, extractGitCommits, type RcaEvent, type RcaSession, type RcaDriftSnapshot, type MemoryItem } from '@mklamine/hawkeye-core';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, getDefaultConfig, PROVIDER_MODELS, getDeveloperName, normalizeLmStudioUrl } from '../config.js';
import { fireWebhooks } from '../webhooks.js';
import { loadPolicy, savePolicy, validatePolicy, generateTemplate, configToPolicy, type PolicyFile } from '../policy.js';
import { generatePdfBuffer } from './export.js';
import { generateCIReport } from './ci-report.js';
import {
  loadTasks,
  saveTasks,
  createTask,
  readJournal,
  clearJournal,
  readDaemonStatus,
  isDaemonStatusFresh,
  injectConfiguredApiKeys,
  ensureClineProfile,
  type Task,
} from './daemon.js';
import { runSwarm, setSwarmBroadcast } from './swarm.js';
import { validateSwarmConfig, generateSwarmTemplate } from '@mklamine/hawkeye-core';
import type { ChildProcess } from 'node:child_process';
import { buildAgentInvocation, getAgentFullAccessArgs, inferAgentName } from './agent-command.js';

// ─── Live Agent Tracking ──────────────────────────────────────

type PermissionLevel = 'default' | 'full' | 'supervised';

interface LiveAgent {
  id: string;
  name: string;
  command: string;
  prompt: string;
  role: 'lead' | 'worker' | 'reviewer';
  personality: string;
  permissions: PermissionLevel;
  status: 'running' | 'completed' | 'failed';
  output: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  initialHash: string;
  sessionId: string | null;
  driftScore: number | null;
  actionCount: number;
  costUsd: number;
}

const liveAgents = new Map<string, LiveAgent>();
const agentProcesses = new Map<string, ChildProcess>();

function buildLiveAgentEnv(cwd: string, command: string): NodeJS.ProcessEnv {
  const env = injectConfiguredApiKeys(process.env, cwd, command);
  delete env.CLAUDECODE;
  return env;
}

function resolveAgentCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    return ensureClineProfile(command, cwd, env);
  } catch {
    return command;
  }
}

function safeParseRecord(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function syncAgentStatsFromSession(agent: LiveAgent, storage: InstanceType<typeof Storage>): boolean {
  if (!agent.sessionId) return false;

  const eventsResult = storage.getEvents(agent.sessionId);
  if (!eventsResult.ok) return false;

  const events = eventsResult.value;
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let totalCost = 0;

  for (const event of events) {
    totalCost += event.cost_usd || 0;
    const data = safeParseRecord(event.data);

    if (event.type === 'file_write' || event.type === 'file_delete') {
      if (typeof data.path === 'string' && data.path) files.add(data.path);
    }

    if (event.type === 'file_rename') {
      if (typeof data.from === 'string' && data.from) files.add(data.from);
      if (typeof data.to === 'string' && data.to) files.add(data.to);
    }

    if (typeof data.linesAdded === 'number') linesAdded += data.linesAdded;
    if (typeof data.linesRemoved === 'number') linesRemoved += data.linesRemoved;
  }

  agent.actionCount = events.length;
  agent.costUsd = totalCost;
  agent.filesChanged = [...files];
  agent.linesAdded = linesAdded;
  agent.linesRemoved = linesRemoved;

  const driftResult = storage.getDriftSnapshots(agent.sessionId);
  if (driftResult.ok && driftResult.value.length > 0) {
    agent.driftScore = driftResult.value[driftResult.value.length - 1].score;
  }

  return true;
}

function syncAgentStatsFromGit(agent: LiveAgent, cwd: string): void {
  if (!agent.initialHash) return;

  try {
    const diff = execSync(`git diff --name-only ${agent.initialHash}`, { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
    agent.filesChanged = diff ? diff.split('\n') : [];
    const stat = execSync(`git diff --stat ${agent.initialHash}`, { cwd, encoding: 'utf-8', timeout: 10000 });
    const addMatch = stat.match(/(\d+) insertions?\(\+\)/);
    const delMatch = stat.match(/(\d+) deletions?\(-\)/);
    agent.linesAdded = addMatch ? parseInt(addMatch[1], 10) : 0;
    agent.linesRemoved = delMatch ? parseInt(delMatch[1], 10) : 0;
  } catch {}
}

function isAllowedWebSocketOrigin(req: IncomingMessage): boolean {
  const wsOrigin = req.headers.origin || '';
  if (!wsOrigin) return true;

  try {
    const origin = new URL(wsOrigin);
    const requestHost = req.headers.host || '';
    const originHost = origin.host;
    const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(wsOrigin);
    return isLocalOrigin || (requestHost.length > 0 && originHost === requestHost);
  } catch {
    return false;
  }
}

const AGENTS_FILE = '.hawkeye/agents.json';

function taskChanged(previous: Task | undefined, next: Task): boolean {
  if (!previous) return true;
  return previous.status !== next.status
    || previous.output !== next.output
    || previous.error !== next.error
    || previous.startedAt !== next.startedAt
    || previous.completedAt !== next.completedAt
    || previous.exitCode !== next.exitCode;
}

function broadcastTaskUpdates(previous: Task[], next: Task[], broadcast: (msg: Record<string, unknown>) => void): void {
  const previousById = new Map(previous.map((task) => [task.id, task]));

  for (const task of next) {
    const prev = previousById.get(task.id);
    if (!prev) {
      broadcast({ type: 'task_created', task });
      continue;
    }

    if (!taskChanged(prev, task)) continue;

    if (task.status === 'running') {
      broadcast({ type: 'task_running', task });
      continue;
    }

    if (task.status === 'completed') {
      broadcast({ type: 'task_completed', task });
      continue;
    }

    if (task.status === 'failed') {
      broadcast({ type: 'task_failed', task });
      continue;
    }

    if (task.status === 'cancelled') {
      broadcast({ type: 'task_cancelled', task });
    }
  }
}

function buildDaemonStatusPayload(cwd: string): {
  running: boolean;
  agent: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  intervalSec: number | null;
  currentTaskId: string | null;
  currentTaskPid: number | null;
} {
  const status = readDaemonStatus(cwd);
  if (!status) {
    return {
      running: false,
      agent: null,
      startedAt: null,
      lastHeartbeatAt: null,
      intervalSec: null,
      currentTaskId: null,
      currentTaskPid: null,
    };
  }

  return {
    running: isDaemonStatusFresh(status),
    agent: status.agent,
    startedAt: status.startedAt,
    lastHeartbeatAt: status.lastHeartbeatAt,
    intervalSec: status.intervalSec,
    currentTaskId: status.currentTaskId ?? null,
    currentTaskPid: status.currentTaskPid ?? null,
  };
}

// ─── Inter-Agent Communication ────────────────────────────────

interface AgentMessage {
  id: string;
  from: string;         // agent id or 'dashboard'
  fromName: string;     // human-readable sender name
  to: string | null;    // agent id (null = broadcast)
  toRole: string | null; // target role ('lead', 'worker', 'reviewer') or null
  content: string;
  type: 'direct' | 'broadcast' | 'decision' | 'request' | 'response';
  timestamp: string;
  read: boolean;
}

const agentMessages: AgentMessage[] = [];
const MESSAGES_FILE = '.hawkeye/agent-messages.json';

function persistMessages(cwd: string): void {
  try {
    // Keep last 500 messages
    const toSave = agentMessages.slice(-500);
    writeFileSync(join(cwd, MESSAGES_FILE), JSON.stringify(toSave, null, 2));
  } catch {}
}

function loadPersistedMessages(cwd: string): void {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, MESSAGES_FILE), 'utf-8'));
    if (Array.isArray(raw)) {
      agentMessages.length = 0;
      agentMessages.push(...raw);
    }
  } catch {}
}

function getInboxForAgent(agentId: string): AgentMessage[] {
  const agent = liveAgents.get(agentId);
  if (!agent) return [];
  return agentMessages.filter((m) => {
    if (m.from === agentId) return false; // not your own messages
    if (m.to === agentId) return true;    // direct to you
    if (m.toRole && m.toRole === agent.role) return true; // to your role
    if (!m.to && !m.toRole) return true;  // broadcast
    return false;
  });
}

function persistAgents(cwd: string): void {
  try {
    const data = Array.from(liveAgents.values()).map((a) => ({
      ...a,
      output: a.output.slice(-2000), // keep only tail for persistence
    }));
    writeFileSync(join(cwd, AGENTS_FILE), JSON.stringify(data, null, 2));
  } catch {}
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function loadPersistedAgents(cwd: string): void {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, AGENTS_FILE), 'utf-8'));
    if (!Array.isArray(raw)) return;
    for (const a of raw) {
      if (!a.id) continue;
      // Running agents: check if their PID is still alive
      if (a.status === 'running') {
        if (a.pid && isProcessAlive(a.pid)) {
          // Process is still running — keep status as running (orphaned but alive)
          // We can't re-attach stdio but the agent continues working
        } else {
          a.status = 'failed';
          a.finishedAt = a.finishedAt || new Date().toISOString();
          a.output = (a.output || '') + '\n[Server restarted — agent process lost]';
        }
      }
      liveAgents.set(a.id, a);
    }
  } catch {}
}

function buildAgentContext(currentId: string): string {
  const others = Array.from(liveAgents.values()).filter((a) => a.id !== currentId);
  if (others.length === 0) return '';
  let ctx = '\n\nCONTEXT — You are working alongside other agents on this codebase:\n';
  for (const a of others) {
    ctx += `- "${a.name}" (${a.role}, ${a.command}, ${a.status})`;
    if (a.status === 'completed' && a.filesChanged.length > 0) {
      ctx += ` — changed: ${a.filesChanged.slice(0, 10).join(', ')}`;
    }
    ctx += `: ${a.prompt.slice(0, 150)}\n`;
  }
  ctx += '\nCoordinate with them — avoid modifying the same files if possible.\n';
  return ctx;
}

function buildRolePrompt(role: string, personality: string, prompt: string): string {
  let prefix = '';
  if (role === 'lead') {
    prefix += 'You are the LEAD agent. You make architectural decisions, delegate subtasks, and ensure overall quality. ';
  } else if (role === 'reviewer') {
    prefix += 'You are a CODE REVIEWER agent. Review changes for bugs, security issues, and code quality. Suggest improvements. Do NOT write new features — only review and fix. ';
  } else {
    prefix += 'You are a WORKER agent. Focus on your assigned task efficiently. ';
  }
  if (personality) {
    prefix += `\nPERSONALITY: ${personality}\n\n`;
  } else {
    prefix += '\n\n';
  }
  return prefix + prompt;
}

/** Returns a Set of all known hawkeye session IDs from hook-sessions.json */
function readHookSessionIds(cwd: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, '.hawkeye', 'hook-sessions.json'), 'utf-8'));
    const ids = new Set<string>();
    for (const val of Object.values(raw)) {
      if (typeof val === 'string') {
        ids.add(val);
      } else if (val && typeof val === 'object' && 'hawkeyeSessionId' in (val as Record<string, unknown>)) {
        ids.add((val as Record<string, string>).hawkeyeSessionId);
      }
    }
    return ids;
  } catch { return new Set(); }
}

function spawnLiveAgent(
  name: string, command: string, prompt: string, cwd: string,
  broadcast: (msg: Record<string, unknown>) => void,
  role: 'lead' | 'worker' | 'reviewer' = 'worker',
  personality: string = '',
  storage?: InstanceType<typeof Storage>,
  permissions: PermissionLevel = 'default',
): LiveAgent {
  const id = randomUUID().slice(0, 12);

  // Capture initial git state
  let initialHash = '';
  try { initialHash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim(); } catch {}

  // Build prompt with role, personality, and agent context
  const rolePrompt = buildRolePrompt(role, personality, prompt);
  const fullPrompt = rolePrompt + buildAgentContext(id);

  // Snapshot hook-sessions before spawn to detect new session
  const hookSessionsBefore = readHookSessionIds(cwd);

  const agent: LiveAgent = {
    id, name, command, prompt, role, personality, permissions, status: 'running',
    output: '', startedAt: new Date().toISOString(),
    finishedAt: null, exitCode: null, pid: null,
    filesChanged: [], linesAdded: 0, linesRemoved: 0, initialHash,
    sessionId: null, driftScore: null, actionCount: 0, costUsd: 0,
  };
  liveAgents.set(id, agent);

  const agentName = inferAgentName(command);
  if (storage && agentName !== 'claude') {
    const syntheticSessionId = randomUUID();
    const sessionResult = storage.createSession({
      id: syntheticSessionId,
      objective: `[${role.toUpperCase()}] ${name}: ${prompt.slice(0, 200)}`,
      startedAt: new Date(agent.startedAt),
      status: 'recording',
      metadata: {
        agent: agentName,
        workingDir: cwd,
        gitCommitBefore: initialHash || undefined,
        developer: 'hawkeye-live-agent',
      },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
    });
    if (sessionResult.ok) {
      agent.sessionId = sessionResult.value;
      broadcast({ type: 'agent_session_linked', agentId: id, sessionId: sessionResult.value });
      persistAgents(cwd);
    }
  }

  const agentEnv = buildLiveAgentEnv(cwd, command);
  const resolvedCommand = resolveAgentCommand(command, cwd, agentEnv);

  const extraArgs = permissions === 'full' ? getAgentFullAccessArgs(resolvedCommand) : [];
  const { cmd, args } = buildAgentInvocation(resolvedCommand, fullPrompt, { extraArgs });

  try {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv });
    agent.pid = child.pid || null;
    agentProcesses.set(id, child);

    broadcast({ type: 'agent_spawned', agent: { id, name, command, prompt, status: 'running' } });
    persistAgents(cwd);

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      agent.output += chunk;
      // Limit output buffer
      if (agent.output.length > 50000) agent.output = agent.output.slice(-40000);
      broadcast({ type: 'agent_output', agentId: id, chunk: chunk.slice(0, 2000) });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      agent.output += chunk;
      if (agent.output.length > 50000) agent.output = agent.output.slice(-40000);
    });

    child.on('error', (err) => {
      agent.status = 'failed';
      agent.finishedAt = new Date().toISOString();
      agent.output += `\nError: ${err.message}`;
      agentProcesses.delete(id);
      if (storage && agent.sessionId && agentName !== 'claude') {
        storage.endSession(agent.sessionId, 'aborted');
      }
      broadcast({ type: 'agent_complete', agentId: id, status: 'failed', error: err.message });
      persistAgents(cwd);
    });

    child.on('close', (code) => {
      agent.status = code === 0 ? 'completed' : 'failed';
      agent.exitCode = code;
      agent.finishedAt = new Date().toISOString();
      agentProcesses.delete(id);
      if (storage && agent.sessionId && agentName !== 'claude') {
        storage.endSession(agent.sessionId, code === 0 ? 'completed' : 'aborted');
      }

      if (!(storage && syncAgentStatsFromSession(agent, storage))) {
        syncAgentStatsFromGit(agent, cwd);
      }

      broadcast({ type: 'agent_complete', agentId: id, status: agent.status, exitCode: code, filesChanged: agent.filesChanged });
      persistAgents(cwd);
    });
  } catch (err: unknown) {
    agent.status = 'failed';
    agent.finishedAt = new Date().toISOString();
    agent.output = `Failed to spawn: ${(err as Error).message}`;
    broadcast({ type: 'agent_complete', agentId: id, status: 'failed', error: (err as Error).message });
    persistAgents(cwd);
  }

  // Session linking: detect the Hawkeye session created by hooks for this agent
  if (storage) {
    const spawnTime = agent.startedAt;
    const linkSession = () => {
      // Method 1: check hook-sessions.json for new entries
      const hookSessionsAfter = readHookSessionIds(cwd);
      for (const hawkId of hookSessionsAfter) {
        if (!hookSessionsBefore.has(hawkId)) {
          agent.sessionId = hawkId;
          try {
            storage!.updateSessionObjective(hawkId, `[${role.toUpperCase()}] ${name}: ${prompt.slice(0, 200)}`);
          } catch {}
          broadcast({ type: 'agent_session_linked', agentId: id, sessionId: hawkId });
          persistAgents(cwd);
          return true;
        }
      }
      // Method 2: query DB for sessions started after spawn time
      try {
        const sessResult = storage!.listSessions({ limit: 20 });
        if (sessResult.ok) {
          const candidates = sessResult.value
            .filter((s) => new Date(s.started_at).getTime() >= new Date(spawnTime).getTime() - 5000)
            .filter((s) => !hookSessionsBefore.has(s.id));
          if (candidates.length > 0) {
            const match = candidates.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
            agent.sessionId = match.id;
            try {
              storage!.updateSessionObjective(match.id, `[${role.toUpperCase()}] ${name}: ${prompt.slice(0, 200)}`);
            } catch {}
            broadcast({ type: 'agent_session_linked', agentId: id, sessionId: match.id });
            persistAgents(cwd);
            return true;
          }
        }
      } catch {}
      return false;
    };
    // Try after 3s, retry at 6s, 10s, and 15s
    setTimeout(() => { if (!linkSession()) setTimeout(() => { if (!linkSession()) setTimeout(() => { if (!linkSession()) setTimeout(linkSession, 5000); }, 4000); }, 3000); }, 3000);

    // Poll live stats from linked session every 5s while running
    const statsInterval = setInterval(() => {
      if (agent.status !== 'running') { clearInterval(statsInterval); return; }
      // Try to link session if not yet linked
      if (!agent.sessionId) { linkSession(); return; }
      try {
        syncAgentStatsFromSession(agent, storage);
        broadcast({ type: 'agent_stats', agentId: id, drift: agent.driftScore, cost: agent.costUsd, actions: agent.actionCount });
        persistAgents(cwd);
      } catch {}
    }, 5000);
  }

  return agent;
}

// ─── Request Validation ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateIngest(payload: any): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'Payload must be a JSON object';
  }
  if (payload.cost_usd !== undefined && typeof payload.cost_usd !== 'number') {
    return 'cost_usd must be a number';
  }
  if (payload.duration_ms !== undefined && typeof payload.duration_ms !== 'number') {
    return 'duration_ms must be a number';
  }
  if (payload.session_id !== undefined && typeof payload.session_id !== 'string') {
    return 'session_id must be a string';
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateSettings(payload: any): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'Settings must be a JSON object';
  }
  
  // Validate drift settings if present
  if (payload.drift !== undefined) {
    if (typeof payload.drift !== 'object' || payload.drift === null) {
      return 'drift must be an object';
    }
    if (payload.drift.enabled !== undefined && typeof payload.drift.enabled !== 'boolean') {
      return 'drift.enabled must be a boolean';
    }
    if (payload.drift.checkEvery !== undefined && (typeof payload.drift.checkEvery !== 'number' || payload.drift.checkEvery < 1)) {
      return 'drift.checkEvery must be a positive number';
    }
    if (payload.drift.provider !== undefined && typeof payload.drift.provider !== 'string') {
      return 'drift.provider must be a string';
    }
    if (payload.drift.model !== undefined && typeof payload.drift.model !== 'string') {
      return 'drift.model must be a string';
    }
    if (payload.drift.warningThreshold !== undefined && (typeof payload.drift.warningThreshold !== 'number' || payload.drift.warningThreshold < 0 || payload.drift.warningThreshold > 100)) {
      return 'drift.warningThreshold must be a number between 0 and 100';
    }
    if (payload.drift.criticalThreshold !== undefined && (typeof payload.drift.criticalThreshold !== 'number' || payload.drift.criticalThreshold < 0 || payload.drift.criticalThreshold > 100)) {
      return 'drift.criticalThreshold must be a number between 0 and 100';
    }
    if (payload.drift.warningThreshold !== undefined && payload.drift.criticalThreshold !== undefined && payload.drift.warningThreshold <= payload.drift.criticalThreshold) {
      return 'drift.warningThreshold must be greater than criticalThreshold';
    }
  }
  
  // Validate guardrails
  if (payload.guardrails !== undefined) {
    if (!Array.isArray(payload.guardrails)) {
      return 'guardrails must be an array';
    }
    // Basic validation for each guardrail
    for (let i = 0; i < payload.guardrails.length; i++) {
      const rule = payload.guardrails[i];
      if (typeof rule !== 'object' || rule === null) {
        return `guardrails[${i}] must be an object`;
      }
      if (rule.name !== undefined && typeof rule.name !== 'string') {
        return `guardrails[${i}].name must be a string`;
      }
      if (rule.type !== undefined && typeof rule.type !== 'string') {
        return `guardrails[${i}].type must be a string`;
      }
      if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
        return `guardrails[${i}].enabled must be a boolean`;
      }
      if (rule.action !== undefined && !['warn', 'block'].includes(rule.action)) {
        return `guardrails[${i}].action must be either 'warn' or 'block'`;
      }
    }
  }
  
  // Validate webhooks
  if (payload.webhooks !== undefined) {
    if (!Array.isArray(payload.webhooks)) {
      return 'webhooks must be an array';
    }
    for (let i = 0; i < payload.webhooks.length; i++) {
      const webhook = payload.webhooks[i];
      if (typeof webhook !== 'object' || webhook === null) {
        return `webhooks[${i}] must be an object`;
      }
      if (webhook.url !== undefined && typeof webhook.url !== 'string') {
        return `webhooks[${i}].url must be a string`;
      }
      if (webhook.events !== undefined && !Array.isArray(webhook.events)) {
        return `webhooks[${i}].events must be an array`;
      }
    }
  }
  
  // Validate apiKeys
  if (payload.apiKeys !== undefined) {
    if (typeof payload.apiKeys !== 'object' || payload.apiKeys === null) {
      return 'apiKeys must be an object';
    }
    // Check that all values are strings
    for (const [key, value] of Object.entries(payload.apiKeys)) {
      if (typeof value !== 'string') {
        return `apiKeys.${key} must be a string`;
      }
    }
  }
  
  return null;
}

/**
 * Kill any existing process listening on the given port.
 * Uses lsof on macOS/Linux to find the PID, then sends SIGTERM.
 */
function killProcessOnPort(port: number): boolean {
  try {
    const cmd = process.platform === 'win32'
      ? `netstat -ano | findstr :${port} | findstr LISTENING`
      : `lsof -ti tcp:${port}`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!output) return false;

    const pids = output.split('\n').map((p) => p.trim()).filter(Boolean);
    const selfPid = String(process.pid);
    for (const pid of pids) {
      if (pid === selfPid) continue;
      try {
        process.kill(parseInt(pid, 10), 'SIGTERM');
      } catch {}
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const serveCommand = new Command('serve')
  .description('Launch the Hawkeye dashboard')
  .option('-p, --port <number>', 'Port number', '4242')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` and record a session first.'));
      return;
    }

    // Resolve dashboard dist directory
    // Try two locations: (1) monorepo sibling (dev — always freshest), (2) bundled inside CLI package (npm install)
    const currentDir = fileURLToPath(new URL('.', import.meta.url));
    // currentDir = dist/commands/ → go up 2 levels for package root
    const bundledDashboard = join(currentDir, '..', '..', 'dashboard');
    const monorepoDashboardRoot = join(currentDir, '..', '..', '..', 'dashboard');
    const monorepoSibling = join(monorepoDashboardRoot, 'dist');
    const dashboardSourceDir = join(monorepoDashboardRoot, 'src');
    const canAutoBuildDashboard = existsSync(join(monorepoDashboardRoot, 'package.json')) && existsSync(dashboardSourceDir);

    if (canAutoBuildDashboard && dashboardBuildIsStale(monorepoDashboardRoot, monorepoSibling)) {
      console.log(chalk.dim('  Dashboard source is newer than dist, rebuilding UI...'));
      try {
        execFileSync('pnpm', ['--dir', monorepoDashboardRoot, 'build'], {
          cwd,
          stdio: 'inherit',
          env: { ...process.env },
        });
      } catch {
        console.error(chalk.yellow('  Dashboard rebuild failed. Serving the existing dist bundle.'));
      }
    }

    const dashboardDist = existsSync(monorepoSibling) ? monorepoSibling : bundledDashboard;

    if (!existsSync(dashboardDist)) {
      console.error(chalk.red('Dashboard not found. Run `pnpm build` first.'));
      return;
    }

    const storage = new Storage(dbPath);

    // Restore agents and messages from previous server run
    loadPersistedAgents(cwd);
    loadPersistedMessages(cwd);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/';
      const clientIp = req.socket.remoteAddress || '127.0.0.1';

      // CORS — restrict to localhost origins
      const origin = req.headers.origin || '';
      const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : '';
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Rate limiting disabled — this is a local dev tool, not a public API.
      // Browser polling + hooks + dashboard + CLI can easily exceed any limit.

      // API routes
      if (url.startsWith('/api/')) {
        if (req.method === 'POST') {
          handlePostApi(url, req, storage, res, broadcast, cwd);
        } else {
          await handleApi(url, storage, res, dbPath, cwd);
        }
        return;
      }

      // Static files
      serveStatic(url, dashboardDist, res);
    });

    // ─── WebSocket Server ─────────────────────────────────────
    const wss = new WebSocketServer({ noServer: true });
    const wsClients = new Set<WebSocket>();

    wss.on('connection', (ws) => {
      wsClients.add(ws);
      ws.on('close', () => wsClients.delete(ws));
      ws.on('error', () => wsClients.delete(ws));
    });

    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws' && isAllowedWebSocketOrigin(req)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    function broadcast(msg: Record<string, unknown>): void {
      const data = JSON.stringify(msg);
      for (const ws of wsClients) {
        if (ws.readyState === 1) {
          ws.send(data);
        }
      }
    }

    const hawkeyeMetaDir = join(cwd, '.hawkeye');
    if (!existsSync(hawkeyeMetaDir)) {
      mkdirSync(hawkeyeMetaDir, { recursive: true });
    }

    let knownTasks = loadTasks(cwd);
    let lastDaemonStatusSnapshot = JSON.stringify(buildDaemonStatusPayload(cwd));
    let tasksWatchTimer: NodeJS.Timeout | null = null;
    let daemonWatchTimer: NodeJS.Timeout | null = null;

    const flushTaskUpdates = () => {
      tasksWatchTimer = null;
      const nextTasks = loadTasks(cwd);
      broadcastTaskUpdates(knownTasks, nextTasks, broadcast);
      knownTasks = nextTasks;
    };

    const flushDaemonStatus = () => {
      daemonWatchTimer = null;
      const payload = buildDaemonStatusPayload(cwd);
      const serialized = JSON.stringify(payload);
      if (serialized === lastDaemonStatusSnapshot) return;
      lastDaemonStatusSnapshot = serialized;
      broadcast({ type: 'daemon_status', status: payload });
    };

    const scheduleTaskUpdates = () => {
      if (tasksWatchTimer) clearTimeout(tasksWatchTimer);
      tasksWatchTimer = setTimeout(flushTaskUpdates, 60);
    };

    const scheduleDaemonStatus = () => {
      if (daemonWatchTimer) clearTimeout(daemonWatchTimer);
      daemonWatchTimer = setTimeout(flushDaemonStatus, 60);
    };

    const hawkeyeMetaWatcher = watch(hawkeyeMetaDir, { recursive: false }, (_event, filename) => {
      const changed = filename?.toString();
      if (changed === 'tasks.json') scheduleTaskUpdates();
      if (changed === 'daemon-status.json') scheduleDaemonStatus();
    });

    // Auto-close sessions inactive for 30+ minutes
    const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
    let lastAutoCloseCheck = Date.now();
    const autoCloseInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastAutoCloseCheck < 60_000) return; // Check once per minute max
      lastAutoCloseCheck = now;
      try {
        const result = storage.listSessions({ status: 'recording', limit: 100 });
        if (!result.ok) return;
        for (const s of result.value) {
          // Get the latest event timestamp via direct query
          const lastEventTime = (() => {
            try {
              const evts = storage.getEvents(s.id);
              if (evts.ok && evts.value.length > 0) {
                return new Date(evts.value[evts.value.length - 1].timestamp).getTime();
              }
            } catch {}
            return new Date(s.started_at).getTime();
          })();
          if (now - lastEventTime > INACTIVITY_TIMEOUT_MS) {
            storage.endSession(s.id, 'completed');
            broadcast({ type: 'session_end', session: { id: s.id, status: 'completed', reason: 'inactivity' } });
            console.log(chalk.dim(`  Auto-closed inactive session ${s.id.slice(0, 8)}`));

            // Fire session_complete webhook
            const cfg = loadConfig(cwd);
            if (cfg.webhooks && cfg.webhooks.length > 0) {
              const startMs = new Date(s.started_at).getTime();
              const durationMinutes = Math.round((now - startMs) / 60000);
              fireWebhooks(cfg.webhooks, 'session_complete', {
                sessionId: s.id,
                objective: s.objective,
                status: 'completed',
                durationMinutes,
                totalCostUsd: s.total_cost_usd,
                totalActions: s.total_actions,
                finalDriftScore: s.final_drift_score,
                reason: 'inactivity',
              });
            }
          }
        }
      } catch {}
    }, 30_000).unref();

    // Poll for new events and broadcast to WebSocket clients
    const sessionEventCounts = new Map<string, number>();
    const pollInterval = setInterval(() => {
      if (wsClients.size === 0) return;
      try {
        const sessionsResult = storage.listSessions({ status: 'recording', limit: 20 });
        if (!sessionsResult.ok) return;
        for (const s of sessionsResult.value) {
          const eventsResult = storage.getEvents(s.id);
          if (!eventsResult.ok) continue;
          const prevCount = sessionEventCounts.get(s.id) || 0;
          const newEvents = eventsResult.value.slice(prevCount);
          sessionEventCounts.set(s.id, eventsResult.value.length);
          for (const e of newEvents) {
            broadcast({ type: 'event', sessionId: s.id, event: e });
            // Also broadcast to the Firewall live stream with risk classification
            broadcast({
              type: 'action_stream',
              sessionId: s.id,
              event: e,
              risk: classifyEventRisk(e as any),
            });
          }
          // Broadcast drift updates
          const driftResult = storage.getDriftSnapshots(s.id);
          if (driftResult.ok && driftResult.value.length > 0) {
            const latest = driftResult.value[driftResult.value.length - 1];
            broadcast({
              type: 'drift_update',
              sessionId: s.id,
              score: latest.score,
              flag: latest.flag,
              reason: latest.reason,
            });
          }
        }
      } catch (e) {
        process.stderr.write(`hawkeye serve: poll error: ${String(e)}\n`);
      }
    }, 1000);

    // Kill any stale hawkeye serve process on the target port
    const killed = killProcessOnPort(port);
    if (killed) {
      console.log(chalk.dim(`  Killed previous process on port ${port}`));
      // Give the OS a moment to release the port
      await new Promise((r) => setTimeout(r, 500));
    }

    const MAX_PORT_RETRIES = 10;
    let currentPort = port;

    function tryListen() {
      server.listen(currentPort, () => {
        console.log('');
        console.log(chalk.green('  Hawkeye Dashboard'));
        console.log(chalk.dim('  ' + '─'.repeat(Math.min(50, (process.stdout.columns || 60) - 4))));
        if (currentPort !== port) {
          console.log(`  ${chalk.yellow('⚠')} Port ${port} was in use, using ${currentPort} instead`);
        }
        console.log(`  ${chalk.dim('Local:')}   ${chalk.cyan(`http://localhost:${currentPort}`)}`);
        console.log(`  ${chalk.dim('WS:')}      ${chalk.cyan(`ws://localhost:${currentPort}/ws`)}`);
        console.log(`  ${chalk.dim('DB:')}      ${chalk.dim(dbPath)}`);
        console.log('');
        console.log(chalk.dim('  Press Ctrl+C to stop'));
        console.log('');

        // Auto-open browser if configured (skip on auto-reload restarts)
        const isReload = process.env.HAWKEYE_RELOAD === '1';
        if (!isReload) {
          const cfg = loadConfig(cwd);
          if (cfg.dashboard?.openBrowser !== false) {
            const url = `http://localhost:${currentPort}`;
            const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            exec(`${cmd} ${url}`, () => {});
          }
        }
      });

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          if (currentPort - port < MAX_PORT_RETRIES) {
            currentPort++;
            console.log(chalk.dim(`  Port ${currentPort - 1} in use, trying ${currentPort}...`));
            server.close(() => {
              server.listen(currentPort);
            });
          } else {
            console.error(chalk.red(`\n  Could not find an available port (tried ${port}-${currentPort}).`));
            storage.close();
            process.exit(1);
          }
          return;
        }
        throw err;
      });
    }

    tryListen();

    // ─── Auto-reload on build ──────────────────────────────────
    // Watch CLI dist/ for changes (triggers on `pnpm build`)
    // When detected, gracefully restart the server process
    const cliDistDir = join(currentDir, '..');
    let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
    let isRestarting = false;

    function hasRunningAgents(): boolean {
      for (const a of liveAgents.values()) {
        if (a.status === 'running') return true;
      }
      return false;
    }

    function scheduleReload(changedFile: string) {
      if (isRestarting) return;
      // Don't restart while agents are running — it would kill their processes
      if (hasRunningAgents()) {
        console.log(chalk.yellow(`  ⚠ Build detected (${changedFile}) but agents are running — skipping auto-reload`));
        return;
      }
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        isRestarting = true;
        console.log('');
        console.log(chalk.cyan(`  ↻ Build detected (${changedFile}), restarting server...`));

        // Restart: spawn a new serve process and exit current
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          stdio: 'inherit',
          detached: true,
          env: { ...process.env, HAWKEYE_RELOAD: '1' },
        });
        child.unref();

        // Give the new process a moment to bind, then exit
        if (tasksWatchTimer) clearTimeout(tasksWatchTimer);
        if (daemonWatchTimer) clearTimeout(daemonWatchTimer);
        hawkeyeMetaWatcher.close();
        clearInterval(pollInterval);
        clearInterval(autoCloseInterval);
        wss.close();
        storage.close();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      }, 1500); // 1.5s debounce — build writes multiple files
    }

    // Watch CLI dist (API code changes)
    try {
      watch(cliDistDir, { recursive: false }, (_event, filename) => {
        if (filename && filename.endsWith('.js')) {
          scheduleReload(filename);
        }
      });
    } catch {}

    // Watch dashboard dist (UI changes) — just for the WebSocket reload signal
    try {
      watch(dashboardDist, { recursive: false }, (_event, filename) => {
        if (filename && (filename.endsWith('.js') || filename.endsWith('.css'))) {
          // Dashboard files are read from disk per-request, so no restart needed
          // But broadcast a reload signal to connected dashboard clients
          broadcast({ type: 'session_end' as any, session: { id: '__reload__', status: 'reload' } });
        }
      });
    } catch {}

    // Watch dashboard source in monorepo mode — rebuild dist, then the dist watcher tells clients to reload.
    let dashboardBuildDebounce: ReturnType<typeof setTimeout> | null = null;
    let dashboardBuildRunning = false;
    let dashboardBuildPendingReason: string | null = null;

    function scheduleDashboardBuild(changedFile: string) {
      if (!canAutoBuildDashboard) return;
      dashboardBuildPendingReason = changedFile;
      if (dashboardBuildDebounce) clearTimeout(dashboardBuildDebounce);
      dashboardBuildDebounce = setTimeout(() => {
        if (dashboardBuildRunning) return;
        const reason = dashboardBuildPendingReason || 'src';
        dashboardBuildPendingReason = null;
        dashboardBuildRunning = true;

        console.log('');
        console.log(chalk.cyan(`  ↻ Dashboard source changed (${reason}), rebuilding UI...`));

        const buildChild = spawn('pnpm', ['--dir', monorepoDashboardRoot, 'build'], {
          cwd,
          stdio: 'inherit',
          env: { ...process.env },
        });

        buildChild.on('close', (code) => {
          dashboardBuildRunning = false;
          if (code === 0) {
            console.log(chalk.green('  ✓ Dashboard rebuilt'));
          } else {
            console.error(chalk.red(`  ✗ Dashboard rebuild failed (exit ${code ?? 1})`));
          }
          if (dashboardBuildPendingReason) {
            const nextReason = dashboardBuildPendingReason;
            dashboardBuildPendingReason = null;
            scheduleDashboardBuild(nextReason);
          }
        });

        buildChild.on('error', (err) => {
          dashboardBuildRunning = false;
          console.error(chalk.red(`  ✗ Dashboard rebuild failed: ${err.message}`));
        });
      }, 1200);
    }

    if (canAutoBuildDashboard) {
      try {
        watch(dashboardSourceDir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          if (!/\.(css|html|js|jsx|ts|tsx)$/.test(filename)) return;
          scheduleDashboardBuild(filename);
        });
      } catch {}
    }

    // Watch for impact preview updates from hook-handler
    const impactDir = join(cwd, '.hawkeye');
    const impactPath = join(impactDir, 'last-impact.json');
    let lastImpactMtime = 0;
    try {
      const hawkDirWatcher = watch(impactDir, { recursive: false }, (_event, filename) => {
        if (filename === 'last-impact.json') {
          try {
            const stat = statSync(impactPath);
            if (stat.mtimeMs <= lastImpactMtime) return; // Already processed
            lastImpactMtime = stat.mtimeMs;
            const impactData = JSON.parse(readFileSync(impactPath, 'utf-8'));
            broadcast({ type: 'impact_preview', ...impactData });
          } catch {}
        }
      });
      hawkDirWatcher.unref?.();
    } catch {}

    // Graceful shutdown
    function shutdown(signal: string) {
      console.log(chalk.dim(`\n  Received ${signal}, shutting down...`));
      if (tasksWatchTimer) clearTimeout(tasksWatchTimer);
      if (daemonWatchTimer) clearTimeout(daemonWatchTimer);
      hawkeyeMetaWatcher.close();
      clearInterval(pollInterval);
      clearInterval(autoCloseInterval);
      wss.close();
      storage.close();
      server.close(() => process.exit(0));
      // Force exit after 5s if server doesn't close
      setTimeout(() => process.exit(0), 5000).unref();
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      process.stderr.write(`hawkeye serve: uncaught exception: ${err.message}\n`);
      shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`hawkeye serve: unhandled rejection: ${String(reason)}\n`);
    });
  });

// ── Risk classification for the live action stream ──

function classifyEventRisk(event: { type: string; data: string; cost_usd: number; [k: string]: unknown }): 'safe' | 'low' | 'medium' | 'high' | 'critical' {
  // Guardrail blocks are always critical/high
  if (event.type === 'guardrail_block' || event.type === 'guardrail_trigger') {
    try {
      const d = JSON.parse(event.data);
      if (d.impactPreview?.risk) return d.impactPreview.risk;
    } catch {}
    return 'critical';
  }

  // Errors are medium
  if (event.type === 'error') return 'medium';

  // Read operations are safe
  if (event.type === 'file_read') return 'safe';

  // File writes — check for sensitive patterns
  if (event.type === 'file_write') {
    try {
      const d = JSON.parse(event.data);
      const path = String(d.path || '');
      if (/\.env|\.pem|\.key|\.secret|config\.(json|ya?ml)|migrations?\/|\.github\/workflows/.test(path)) {
        return 'medium';
      }
    } catch {}
    return 'low';
  }

  // Commands — check for risky patterns
  if (event.type === 'command') {
    try {
      const d = JSON.parse(event.data);
      const cmd = String(d.command || '');
      if (/\brm\b.*-r|git\s+push.*--force|git\s+reset\s+--hard|git\s+clean\s+-f/.test(cmd)) return 'high';
      if (/\bgit\s+push\b/.test(cmd)) return 'low';
      if (/\bnpm\s+publish\b/.test(cmd)) return 'high';
      if (d.exitCode && d.exitCode !== 0) return 'medium';
    } catch {}
    return 'safe';
  }

  // Git operations
  if (event.type === 'git_push') return 'low';
  if (event.type === 'git_commit') return 'safe';

  // LLM calls — cost-based
  if (event.type === 'llm_call') {
    if (event.cost_usd > 0.5) return 'medium';
    return 'safe';
  }

  return 'safe';
}

function dashboardBuildIsStale(dashboardRoot: string, dashboardDist: string): boolean {
  if (!existsSync(join(dashboardRoot, 'src'))) return false;
  if (!existsSync(join(dashboardDist, 'index.html'))) return true;
  try {
    const distMtime = statSync(join(dashboardDist, 'index.html')).mtimeMs;
    return latestMtime(join(dashboardRoot, 'src')) > distMtime;
  } catch {
    return false;
  }
}

function latestMtime(rootDir: string): number {
  if (!existsSync(rootDir)) return 0;
  const stack = [rootDir];
  let latest = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        const mtimeMs = statSync(fullPath).mtimeMs;
        if (mtimeMs > latest) latest = mtimeMs;
      }
    } catch {
      continue;
    }
  }

  return latest;
}

async function handleApi(url: string, storage: Storage, res: ServerResponse, dbPath?: string, cwd?: string): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // GET /api/info — returns which project this dashboard serves
    if (url === '/api/info') {
      res.writeHead(200);
      res.end(JSON.stringify({ dbPath: dbPath || '', cwd: cwd || '' }));
      return;
    }

    // GET /api/sessions?limit=N
    const sessionsMatch = url.match(/^\/api\/sessions(?:\?(.*))?$/);
    if (sessionsMatch && !url.includes('/api/sessions/')) {
      const params = new URLSearchParams(sessionsMatch[1] || '');
      const limit = parseInt(params.get('limit') || '50', 10);
      const result = storage.listSessions({ limit });
      if (result.ok) {
        // Compute live stats for recording sessions
        const sessions = result.value.map((s) => {
          if (s.status === 'recording' && (s.total_actions === 0 || s.total_cost_usd === 0)) {
            const eventsResult = storage.getEvents(s.id);
            if (eventsResult.ok) {
              s.total_actions = eventsResult.value.length;
              s.total_cost_usd = eventsResult.value.reduce((sum: number, e: { cost_usd?: number }) => sum + (e.cost_usd || 0), 0);
            }
          }
          return s;
        });
        res.writeHead(200);
        res.end(JSON.stringify(sessions));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: result.error.message }));
      }
      return;
    }

    // GET /api/sessions/:id
    const sessionMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const result = storage.getSession(sessionMatch[1]);
      if (result.ok && result.value) {
        const s = result.value;
        // For active sessions, compute live stats from events
        if (s.status === 'recording' && (s.total_actions === 0 || s.total_cost_usd === 0)) {
          const eventsResult = storage.getEvents(sessionMatch[1]);
          if (eventsResult.ok) {
            s.total_actions = eventsResult.value.length;
            s.total_cost_usd = eventsResult.value.reduce((sum: number, e: { cost_usd?: number }) => sum + (e.cost_usd || 0), 0);
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify(s));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    // GET /api/sessions/:id/events
    const eventsMatch = url.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (eventsMatch) {
      const result = storage.getEvents(eventsMatch[1]);
      if (result.ok) {
        res.writeHead(200);
        res.end(JSON.stringify(result.value));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: result.error.message }));
      }
      return;
    }

    // GET /api/sessions/:id/drift
    const driftMatch = url.match(/^\/api\/sessions\/([^/]+)\/drift$/);
    if (driftMatch) {
      const result = storage.getDriftSnapshots(driftMatch[1]);
      if (result.ok) {
        res.writeHead(200);
        res.end(JSON.stringify(result.value));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: result.error.message }));
      }
      return;
    }

    // GET /api/sessions/:id/cost-by-file
    const costFileMatch = url.match(/^\/api\/sessions\/([^/]+)\/cost-by-file$/);
    if (costFileMatch) {
      const result = storage.getCostByFile(costFileMatch[1]);
      if (result.ok) {
        res.writeHead(200);
        res.end(JSON.stringify(result.value));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: result.error.message }));
      }
      return;
    }

    // GET /api/sessions/:id/analyze
    const analyzeMatch = url.match(/^\/api\/sessions\/([^/]+)\/analyze$/);
    if (analyzeMatch) {
      const sResult = storage.getSession(analyzeMatch[1]);
      if (!sResult.ok || !sResult.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const sess = sResult.value;
      const evtsResult = storage.getEvents(sess.id);
      const driftsResult = storage.getDriftSnapshots(sess.id);
      const evts = evtsResult.ok ? evtsResult.value : [];
      const drifts = driftsResult.ok ? driftsResult.value : [];

      const rcaEvents: RcaEvent[] = evts.map((e) => ({
        id: e.id,
        sequence: e.sequence,
        timestamp: e.timestamp,
        type: e.type,
        data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
        drift_score: e.drift_score ?? null,
        drift_flag: e.drift_flag ?? null,
        cost_usd: e.cost_usd ?? 0,
      }));

      const rcaSession: RcaSession = {
        id: sess.id,
        objective: sess.objective ?? '',
        agent: sess.agent ?? 'unknown',
        status: sess.status,
        started_at: sess.started_at,
        ended_at: sess.ended_at ?? null,
        total_cost_usd: sess.total_cost_usd ?? 0,
        final_drift_score: sess.final_drift_score ?? null,
      };

      const rcaDriftSnapshots: RcaDriftSnapshot[] = drifts.map((d) => ({
        score: d.score,
        flag: d.flag,
        reason: d.reason,
        created_at: d.created_at,
      }));

      try {
        const result = analyzeRootCause(rcaSession, rcaEvents, rcaDriftSnapshots);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Analysis failed' }));
      }
      return;
    }

    // GET /api/sessions/:id/ci-report
    const ciMatch = url.match(/^\/api\/sessions\/([^/]+)\/ci-report$/);
    if (ciMatch) {
      const sResult = storage.getSession(ciMatch[1]);
      if (!sResult.ok || !sResult.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const sess = sResult.value;
      try {
        const evResult = storage.getEvents(sess.id);
        const statsResult = storage.getSessionStats(sess.id);
        const driftResult = storage.getDriftSnapshots(sess.id);
        const violResult = storage.getViolations(sess.id);
        const costResult = storage.getCostByFile(sess.id);

        const report = generateCIReport({
          session: sess,
          events: evResult.ok ? evResult.value : [],
          stats: statsResult.ok ? statsResult.value : { total_events: 0, command_count: 0, file_count: 0, llm_count: 0, api_count: 0, git_count: 0, error_count: 0, guardrail_count: 0, total_cost_usd: 0, total_duration_ms: 0 },
          driftSnapshots: driftResult.ok ? driftResult.value : [],
          violations: violResult.ok ? violResult.value : [],
          costByFile: costResult.ok ? costResult.value : [],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          markdown: report.markdown,
          risk: report.overallRisk,
          passed: report.passed,
          flags: report.flags,
          sensitiveFiles: report.sensitiveFiles,
          dangerousCommands: report.dangerousCommands,
          failedCommands: report.failedCommands,
        }));
      } catch (err: unknown) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Report generation failed' }));
      }
      return;
    }

    // GET /api/sessions/:id/memory
    const memMatch = url.match(/^\/api\/sessions\/([^/]+)\/memory$/);
    if (memMatch) {
      const sResult = storage.getSession(memMatch[1]);
      if (!sResult.ok || !sResult.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const sess = sResult.value;
      // Check cache first
      const cached = storage.getMemoryItems(sess.id);
      if (cached.ok && cached.value && cached.value.length > 0) {
        res.writeHead(200);
        res.end(JSON.stringify(cached.value));
        return;
      }
      // Extract from events
      const evts = storage.getEvents(sess.id);
      const events = (evts.ok ? evts.value : []).map((e) => ({
        id: e.id, sequence: e.sequence, timestamp: e.timestamp, type: e.type,
        data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
        drift_score: e.drift_score ?? null, cost_usd: e.cost_usd ?? 0,
      }));
      const memSession = { id: sess.id, objective: sess.objective ?? '', agent: sess.agent, status: sess.status, started_at: sess.started_at, ended_at: sess.ended_at };
      const memories = extractMemories(memSession, events);
      // Cache
      storage.upsertMemoryItems(sess.id, memories.map((m) => ({
        id: m.id, session_id: m.sessionId, sequence: m.sequence, timestamp: m.timestamp,
        category: m.category, key: m.key, content: m.content, evidence: m.evidence,
        confidence: m.confidence, supersedes: m.supersedes ?? null, contradicts: m.contradicts ?? null,
      })));
      res.writeHead(200);
      res.end(JSON.stringify(memories));
      return;
    }

    // GET /api/memory/diff?a=<id>&b=<id>
    if (url.startsWith('/api/memory/diff')) {
      const params = new URL(`http://localhost${url}`).searchParams;
      const idA = params.get('a') || '';
      const idB = params.get('b') || '';
      if (!idA || !idB) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing a or b query params' }));
        return;
      }
      const sA = storage.getSession(idA);
      const sB = storage.getSession(idB);
      if (!sA.ok || !sA.value || !sB.ok || !sB.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      // Helper to load or extract memories for a session
      const loadMem = (sess: typeof sA.value): MemoryItem[] => {
        const cached = storage.getMemoryItems(sess.id);
        if (cached.ok && cached.value && cached.value.length > 0) {
          return cached.value.map((r) => ({
            id: r.id, sessionId: r.session_id, sequence: r.sequence, timestamp: r.timestamp,
            category: r.category as MemoryItem['category'], key: r.key, content: r.content,
            evidence: r.evidence, confidence: r.confidence as MemoryItem['confidence'],
            supersedes: r.supersedes ?? undefined, contradicts: r.contradicts ?? undefined,
          }));
        }
        const evts = storage.getEvents(sess.id);
        const events = (evts.ok ? evts.value : []).map((e) => ({
          id: e.id, sequence: e.sequence, timestamp: e.timestamp, type: e.type,
          data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
          drift_score: e.drift_score ?? null, cost_usd: e.cost_usd ?? 0,
        }));
        const memSession = { id: sess.id, objective: sess.objective ?? '', agent: sess.agent, status: sess.status, started_at: sess.started_at, ended_at: sess.ended_at };
        const mems = extractMemories(memSession, events);
        storage.upsertMemoryItems(sess.id, mems.map((m) => ({
          id: m.id, session_id: m.sessionId, sequence: m.sequence, timestamp: m.timestamp,
          category: m.category, key: m.key, content: m.content, evidence: m.evidence,
          confidence: m.confidence, supersedes: m.supersedes ?? null, contradicts: m.contradicts ?? null,
        })));
        return mems;
      };

      const memA = loadMem(sA.value);
      const memB = loadMem(sB.value);
      const msA = { id: sA.value.id, objective: sA.value.objective ?? '', agent: sA.value.agent, status: sA.value.status, started_at: sA.value.started_at, ended_at: sA.value.ended_at };
      const msB = { id: sB.value.id, objective: sB.value.objective ?? '', agent: sB.value.agent, status: sB.value.status, started_at: sB.value.started_at, ended_at: sB.value.ended_at };
      const result = diffMemories(memA, memB, msA, msB);
      const memBySession = new Map<string, MemoryItem[]>();
      memBySession.set(sA.value.id, memA);
      memBySession.set(sB.value.id, memB);
      result.hallucinations = detectHallucinations(memBySession);

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/memory/cumulative?limit=20
    if (url.startsWith('/api/memory/cumulative')) {
      const params = new URL(`http://localhost${url}`).searchParams;
      const limit = parseInt(params.get('limit') || '20', 10);
      const sessionsResult = storage.listSessions({ limit });
      const sessions = sessionsResult.ok ? sessionsResult.value : [];

      const loadMem = (sess: typeof sessions[0]): MemoryItem[] => {
        const cached = storage.getMemoryItems(sess.id);
        if (cached.ok && cached.value && cached.value.length > 0) {
          return cached.value.map((r) => ({
            id: r.id, sessionId: r.session_id, sequence: r.sequence, timestamp: r.timestamp,
            category: r.category as MemoryItem['category'], key: r.key, content: r.content,
            evidence: r.evidence, confidence: r.confidence as MemoryItem['confidence'],
            supersedes: r.supersedes ?? undefined, contradicts: r.contradicts ?? undefined,
          }));
        }
        const evts = storage.getEvents(sess.id);
        const events = (evts.ok ? evts.value : []).map((e) => ({
          id: e.id, sequence: e.sequence, timestamp: e.timestamp, type: e.type,
          data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
          drift_score: e.drift_score ?? null, cost_usd: e.cost_usd ?? 0,
        }));
        const memSession = { id: sess.id, objective: sess.objective ?? '', agent: sess.agent, status: sess.status, started_at: sess.started_at, ended_at: sess.ended_at };
        const mems = extractMemories(memSession, events);
        storage.upsertMemoryItems(sess.id, mems.map((m) => ({
          id: m.id, session_id: m.sessionId, sequence: m.sequence, timestamp: m.timestamp,
          category: m.category, key: m.key, content: m.content, evidence: m.evidence,
          confidence: m.confidence, supersedes: m.supersedes ?? null, contradicts: m.contradicts ?? null,
        })));
        return mems;
      };

      const sessionMemories = sessions.map((s) => ({
        session: { id: s.id, objective: s.objective ?? '', agent: s.agent, status: s.status, started_at: s.started_at, ended_at: s.ended_at },
        memories: loadMem(s),
      }));

      const cumulative = buildCumulativeMemory(sessionMemories);
      res.writeHead(200);
      res.end(JSON.stringify(cumulative));
      return;
    }

    // GET /api/memory/hallucinations
    if (url === '/api/memory/hallucinations') {
      const sessionsResult = storage.listSessions({ limit: 30 });
      const sessions = sessionsResult.ok ? sessionsResult.value : [];
      const memBySession = new Map<string, MemoryItem[]>();

      for (const sess of sessions) {
        const cached = storage.getMemoryItems(sess.id);
        if (cached.ok && cached.value && cached.value.length > 0) {
          memBySession.set(sess.id, cached.value.map((r) => ({
            id: r.id, sessionId: r.session_id, sequence: r.sequence, timestamp: r.timestamp,
            category: r.category as MemoryItem['category'], key: r.key, content: r.content,
            evidence: r.evidence, confidence: r.confidence as MemoryItem['confidence'],
            supersedes: r.supersedes ?? undefined, contradicts: r.contradicts ?? undefined,
          })));
        } else {
          const evts = storage.getEvents(sess.id);
          const events = (evts.ok ? evts.value : []).map((e) => ({
            id: e.id, sequence: e.sequence, timestamp: e.timestamp, type: e.type,
            data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
            drift_score: e.drift_score ?? null, cost_usd: e.cost_usd ?? 0,
          }));
          const memSession = { id: sess.id, objective: sess.objective ?? '', agent: sess.agent, status: sess.status, started_at: sess.started_at, ended_at: sess.ended_at };
          const mems = extractMemories(memSession, events);
          storage.upsertMemoryItems(sess.id, mems.map((m) => ({
            id: m.id, session_id: m.sessionId, sequence: m.sequence, timestamp: m.timestamp,
            category: m.category, key: m.key, content: m.content, evidence: m.evidence,
            confidence: m.confidence, supersedes: m.supersedes ?? null, contradicts: m.contradicts ?? null,
          })));
          memBySession.set(sess.id, mems);
        }
      }

      const hallu = detectHallucinations(memBySession);
      res.writeHead(200);
      res.end(JSON.stringify(hallu));
      return;
    }

    // GET /api/sessions/:id/incidents
    const incidentsMatch = url.match(/^\/api\/sessions\/([^/]+)\/incidents$/);
    if (incidentsMatch) {
      const result = storage.getIncidents(incidentsMatch[1]);
      const incidents = (result.ok ? result.value : []).map((r) => {
        try { return JSON.parse(r.snapshot); } catch { return r; }
      });
      res.writeHead(200);
      res.end(JSON.stringify(incidents));
      return;
    }

    // GET /api/sessions/:id/self-assess
    const assessMatch = url.match(/^\/api\/sessions\/([^/]+)\/self-assess$/);
    if (assessMatch) {
      const sResult = storage.getSession(assessMatch[1]);
      if (!sResult.ok || !sResult.value) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return;
      }
      const sess = sResult.value;
      const evtsResult = storage.getEvents(sess.id);
      const events = (evtsResult.ok ? evtsResult.value : []).map((e) => ({
        sequence: e.sequence, type: e.type, timestamp: e.timestamp,
        data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
        cost_usd: e.cost_usd ?? 0,
      }));
      const driftResult = storage.getDriftSnapshots(sess.id);
      const drifts = driftResult.ok ? driftResult.value : [];
      const latestDrift = drifts[drifts.length - 1];

      const assessment = selfAssess({
        driftScore: latestDrift?.score ?? sess.final_drift_score ?? null,
        driftFlag: latestDrift?.flag ?? 'unknown',
        driftSnapshots: drifts.map((d) => ({ score: d.score, flag: d.flag })),
        totalCost: sess.total_cost_usd ?? 0,
        costLimit: null, // Could load from config
        events,
        startedAt: sess.started_at,
        objective: sess.objective ?? '',
      });

      res.writeHead(200);
      res.end(JSON.stringify(assessment));
      return;
    }

    // GET /api/sessions/:id/auto-correct
    const correctMatch = url.match(/^\/api\/sessions\/([^/]+)\/auto-correct$/);
    if (correctMatch) {
      const sResult = storage.getSession(correctMatch[1]);
      if (!sResult.ok || !sResult.value) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return;
      }
      const sess = sResult.value;
      const evtsResult = storage.getEvents(sess.id);
      const events = (evtsResult.ok ? evtsResult.value : []).map((e) => ({
        sequence: e.sequence, type: e.type, timestamp: e.timestamp,
        data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
        cost_usd: e.cost_usd ?? 0,
      }));
      const driftResult = storage.getDriftSnapshots(sess.id);
      const drifts = driftResult.ok ? driftResult.value : [];
      const latestDrift = drifts[drifts.length - 1];

      const assessment = selfAssess({
        driftScore: latestDrift?.score ?? sess.final_drift_score ?? null,
        driftFlag: latestDrift?.flag ?? 'unknown',
        driftSnapshots: drifts.map((d) => ({ score: d.score, flag: d.flag })),
        totalCost: sess.total_cost_usd ?? 0,
        costLimit: null,
        events,
        startedAt: sess.started_at,
        objective: sess.objective ?? '',
      });

      const correction = generateAutoCorrection(assessment, sess.objective ?? '');
      res.writeHead(200);
      res.end(JSON.stringify(correction));
      return;
    }

    // GET /api/commits?session=<id>
    if (url.startsWith('/api/commits')) {
      const params = new URL(`http://localhost${url}`).searchParams;
      const sessionId = params.get('session') || undefined;
      const result = storage.getGitCommits(sessionId);
      const rows = result.ok ? result.value : [];
      const commits = rows.map((r) => {
        const data = (() => { try { return JSON.parse(r.data); } catch { return {}; } })();
        return {
          sessionId: r.session_id,
          agent: r.agent,
          sequence: r.sequence,
          timestamp: r.timestamp,
          commitHash: data.commitHash || data.hash || '',
          message: data.message || '',
          branch: data.branch || null,
          filesChanged: data.filesChanged || 0,
          linesAdded: data.linesAdded || 0,
          linesRemoved: data.linesRemoved || 0,
        };
      });
      res.writeHead(200);
      res.end(JSON.stringify(commits));
      return;
    }

    // GET /api/sessions/:id/corrections
    const correctionsMatch = url.match(/^\/api\/sessions\/([^/]+)\/corrections$/);
    if (correctionsMatch) {
      const result = storage.getCorrections(correctionsMatch[1]);
      const rows = result.ok ? result.value : [];
      const corrections = rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        timestamp: r.timestamp,
        trigger: r.trigger,
        assessment: (() => { try { return JSON.parse(r.assessment); } catch { return {}; } })(),
        corrections: (() => { try { return JSON.parse(r.corrections); } catch { return []; } })(),
        dryRun: r.dry_run === 1,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(corrections));
      return;
    }

    // GET /api/corrections (all corrections across sessions)
    if (url.startsWith('/api/corrections')) {
      const params = new URL(`http://localhost${url}`).searchParams;
      const limit = parseInt(params.get('limit') || '50');
      const result = storage.getAllCorrections(limit);
      const rows = result.ok ? result.value : [];
      const corrections = rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        timestamp: r.timestamp,
        trigger: r.trigger,
        assessment: (() => { try { return JSON.parse(r.assessment); } catch { return {}; } })(),
        corrections: (() => { try { return JSON.parse(r.corrections); } catch { return []; } })(),
        dryRun: r.dry_run === 1,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(corrections));
      return;
    }

    // GET /api/active-correction
    if (url === '/api/active-correction') {
      try {
        const hintPath = join(cwd || process.cwd(), '.hawkeye', 'active-correction.json');
        if (existsSync(hintPath)) {
          const hint = readFileSync(hintPath, 'utf-8');
          res.writeHead(200);
          res.end(hint);
        } else {
          res.writeHead(200);
          res.end('null');
        }
      } catch {
        res.writeHead(200);
        res.end('null');
      }
      return;
    }

    // GET /api/sessions/:id/export-pdf
    const pdfMatch = url.match(/^\/api\/sessions\/([^/]+)\/export-pdf$/);
    if (pdfMatch) {
      const sResult = storage.getSession(pdfMatch[1]);
      if (!sResult.ok || !sResult.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const sess = sResult.value;
      const evts = storage.getEvents(sess.id);
      const drifts = storage.getDriftSnapshots(sess.id);
      const costByFile = storage.getCostByFile(sess.id);
      generatePdfBuffer(
        sess,
        evts.ok ? evts.value : [],
        drifts.ok ? drifts.value : [],
        costByFile.ok ? costByFile.value : [],
      ).then((buf) => {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="hawkeye-${sess.id.slice(0, 8)}.pdf"`);
        res.writeHead(200);
        res.end(buf);
      }).catch((err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: `PDF generation failed: ${String(err)}` }));
      });
      return;
    }

    // GET /api/settings
    if (url === '/api/settings') {
      try {
        const config = loadConfig(cwd || process.cwd());
        res.writeHead(200);
        res.end(JSON.stringify(config));
      } catch (error) {
        // If config doesn't exist, return default config
        const defaultConfig = getDefaultConfig();
        res.writeHead(200);
        res.end(JSON.stringify(defaultConfig));
      }
      return;
    }

    // GET /api/providers
    if (url === '/api/providers') {
      res.writeHead(200);
      res.end(JSON.stringify(PROVIDER_MODELS));
      return;
    }

    // GET /api/providers/local — Fetch actual installed models from Ollama + LM Studio
    if (url === '/api/providers/local') {
      const localCfg = loadConfig(cwd || process.cwd());
      const result: Record<string, { available: boolean; models: string[]; url: string }> = {};

      // Ollama
      const ollamaUrl = localCfg?.drift?.ollamaUrl || 'http://localhost:11434';
      try {
        const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = (await resp.json()) as { models?: Array<{ name: string; size?: number }> };
          // Cloud models first, then local sorted by size desc
          const all = data.models || [];
          const cloud = all.filter((m) => m.name.includes(':cloud'));
          const local = all.filter((m) => !m.name.includes(':cloud')).sort((a, b) => (b.size || 0) - (a.size || 0));
          result.ollama = {
            available: true,
            models: [...cloud, ...local].map((m) => m.name),
            url: ollamaUrl,
          };
        } else {
          result.ollama = { available: false, models: [], url: ollamaUrl };
        }
      } catch {
        result.ollama = { available: false, models: [], url: ollamaUrl };
      }

      // LM Studio
      const lmUrl = normalizeLmStudioUrl(localCfg?.drift?.lmstudioUrl || 'http://localhost:1234');
      try {
        const resp = await fetch(`${lmUrl}/models`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = (await resp.json()) as { data?: Array<{ id: string }> };
          result.lmstudio = {
            available: true,
            models: (data.data || []).map((m) => m.id),
            url: lmUrl,
          };
        } else {
          result.lmstudio = { available: false, models: [], url: lmUrl };
        }
      } catch {
        result.lmstudio = { available: false, models: [], url: lmUrl };
      }

      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/policies — Load policies.yml
    if (url === '/api/policies') {
      const policy = loadPolicy(cwd || process.cwd());
      res.writeHead(200);
      res.end(JSON.stringify(policy || null));
      return;
    }

    // GET /api/compare?ids=id1,id2,id3
    const compareMatch = url.match(/^\/api\/compare\?(.*)$/);
    if (compareMatch) {
      const params = new URLSearchParams(compareMatch[1]);
      const ids = (params.get('ids') || '').split(',').filter(Boolean);
      if (ids.length < 2) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Need at least 2 session IDs (ids=id1,id2)' }));
        return;
      }
      const result = storage.compareSessions(ids);
      if (result.ok) {
        res.writeHead(200);
        res.end(JSON.stringify(result.value));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: result.error.message }));
      }
      return;
    }

    // GET /api/stats — Global statistics
    if (url === '/api/stats') {
      const result = storage.getGlobalStats();
      if (result.ok) {
        res.writeHead(200);
        res.end(JSON.stringify(result.value));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: result.error.message }));
      }
      return;
    }

    // GET /api/daemon/status — Check whether the task daemon is alive
    if (url === '/api/daemon/status') {
      res.writeHead(200);
      res.end(JSON.stringify(buildDaemonStatusPayload(cwd || process.cwd())));
      return;
    }

    // GET /api/tasks — List all tasks from the task queue
    if (url === '/api/tasks') {
      const tasks = loadTasks(cwd || process.cwd());
      res.writeHead(200);
      res.end(JSON.stringify(tasks));
      return;
    }

    // GET /api/tasks/journal — Read the persistent task journal (agent memory)
    if (url === '/api/tasks/journal') {
      const journal = readJournal(cwd || process.cwd());
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(journal);
      return;
    }

    // GET /api/mcp-servers — List all MCP servers from .mcp.json
    if (url === '/api/mcp-servers') {
      const mcpPath = join(cwd || process.cwd(), '.mcp.json');
      let servers: Record<string, unknown> = {};
      try {
        if (existsSync(mcpPath)) {
          const raw = JSON.parse(readFileSync(mcpPath, 'utf-8'));
          servers = (raw.mcpServers || {}) as Record<string, unknown>;
        }
      } catch { /* ignore */ }
      res.writeHead(200);
      res.end(JSON.stringify(servers));
      return;
    }

    // GET /api/tasks/attachments/:filename — Serve task attachment images
    const attachMatch = url.match(/^\/api\/tasks\/attachments\/(.+)$/);
    if (attachMatch) {
      const filename = decodeURIComponent(attachMatch[1]);
      const attachDir = resolve(cwd || process.cwd(), '.hawkeye', 'task-attachments');
      const filePath = resolve(attachDir, filename);
      if (!filePath.startsWith(attachDir + '/')) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Attachment not found' }));
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      res.writeHead(200);
      res.end(readFileSync(filePath));
      return;
    }

    // GET /api/pending-reviews — List pending review gate items
    if (url === '/api/pending-reviews') {
      const pendingFile = join(cwd || process.cwd(), '.hawkeye', 'pending-reviews.json');
      let pending: unknown[] = [];
      try {
        if (existsSync(pendingFile)) {
          pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
        }
      } catch {}
      res.writeHead(200);
      res.end(JSON.stringify(pending));
      return;
    }

    // GET /api/impact — Get last impact preview
    if (url === '/api/impact') {
      const impFile = join(cwd || process.cwd(), '.hawkeye', 'last-impact.json');
      let impact = null;
      try {
        if (existsSync(impFile)) {
          impact = JSON.parse(readFileSync(impFile, 'utf-8'));
        }
      } catch {}
      res.writeHead(200);
      res.end(JSON.stringify(impact));
      return;
    }

    // GET /api/interceptions — Get recent guardrail blocks + impact blocks (last 50)
    if (url === '/api/interceptions') {
      const blocks = storage.getRecentBlocks(50);
      const recentEvents = storage.getRecentEvents(120);
      // Also append any pending reviews
      const pendingFile = join(cwd || process.cwd(), '.hawkeye', 'pending-reviews.json');
      let pending: unknown[] = [];
      try {
        if (existsSync(pendingFile)) pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
      } catch {}

      let impactPreviewsEnabled = false;
      try {
        const policy = loadPolicy(cwd || process.cwd());
        impactPreviewsEnabled = !!policy?.rules?.some((rule) => rule.enabled && rule.type === 'impact_threshold');
      } catch {}

      const recentActions = recentEvents.ok
        ? recentEvents.value.map((event: { type: string; data: string; cost_usd: number }) => ({
            ...event,
            risk: classifyEventRisk(event),
          }))
        : [];

      res.writeHead(200);
      res.end(JSON.stringify({
        blocks,
        recentActions,
        pendingReviews: pending,
        impactPreviewsEnabled,
      }));
      return;
    }

    // ─── Swarm API ───────────────────────────────────────────

    // GET /api/swarms — List all swarm runs
    if (url.startsWith('/api/swarms') && !url.includes('/api/swarms/')) {
      const params = new URL(`http://localhost${url}`).searchParams;
      const limit = parseInt(params.get('limit') || '20');
      const status = params.get('status') || undefined;
      const result = storage.listSwarms({ limit, status });
      res.writeHead(200);
      res.end(JSON.stringify(result.ok ? result.value : []));
      return;
    }

    // GET /api/swarms/:id — Get swarm detail
    const swarmMatch = url.match(/^\/api\/swarms\/([^/]+)$/);
    if (swarmMatch) {
      const swarm = storage.getSwarm(swarmMatch[1]);
      if (!swarm.ok || !swarm.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Swarm not found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(swarm.value));
      return;
    }

    // GET /api/swarms/:id/agents — Get swarm agents
    const swarmAgentsMatch = url.match(/^\/api\/swarms\/([^/]+)\/agents$/);
    if (swarmAgentsMatch) {
      const swarm = storage.getSwarm(swarmAgentsMatch[1]);
      if (!swarm.ok || !swarm.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Swarm not found' }));
        return;
      }
      const agents = storage.getSwarmAgents(swarm.value.id);
      res.writeHead(200);
      res.end(JSON.stringify(agents.ok ? agents.value : []));
      return;
    }

    // GET /api/swarms/:id/conflicts — Get swarm conflicts
    const swarmConflictsMatch = url.match(/^\/api\/swarms\/([^/]+)\/conflicts$/);
    if (swarmConflictsMatch) {
      const swarm = storage.getSwarm(swarmConflictsMatch[1]);
      if (!swarm.ok || !swarm.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Swarm not found' }));
        return;
      }
      const conflicts = storage.getSwarmConflicts(swarm.value.id);
      res.writeHead(200);
      res.end(JSON.stringify(conflicts.ok ? conflicts.value : []));
      return;
    }

    // GET /api/swarms/:id/full — Get complete swarm data (swarm + agents + conflicts)
    const swarmFullMatch = url.match(/^\/api\/swarms\/([^/]+)\/full$/);
    if (swarmFullMatch) {
      const swarm = storage.getSwarm(swarmFullMatch[1]);
      if (!swarm.ok || !swarm.value) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Swarm not found' }));
        return;
      }
      const agents = storage.getSwarmAgents(swarm.value.id);
      const conflicts = storage.getSwarmConflicts(swarm.value.id);
      res.writeHead(200);
      res.end(JSON.stringify({
        swarm: swarm.value,
        agents: agents.ok ? agents.value : [],
        conflicts: conflicts.ok ? conflicts.value : [],
      }));
      return;
    }

    // GET /api/agents — List all live agents
    if (url === '/api/agents' || url.startsWith('/api/agents?')) {
      res.writeHead(200);
      res.end(JSON.stringify(Array.from(liveAgents.values())));
      return;
    }

    // GET /api/agents/:id — Get single agent
    const agentMatch = url.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch) {
      const agent = liveAgents.get(agentMatch[1]);
      if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
      res.writeHead(200);
      res.end(JSON.stringify(agent));
      return;
    }

    // GET /api/agents/:id/events — Get events from linked Hawkeye session
    const agentEventsMatch = url.match(/^\/api\/agents\/([^/]+)\/events/);
    if (agentEventsMatch) {
      const agent = liveAgents.get(agentEventsMatch[1]);
      if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
      if (!agent.sessionId) { res.writeHead(200); res.end(JSON.stringify([])); return; }
      const limit = parseInt(new URL(url, 'http://x').searchParams.get('limit') || '20');
      const evResult = storage.getEvents(agent.sessionId);
      const events = evResult.ok ? evResult.value.slice(-limit) : [];
      res.writeHead(200);
      res.end(JSON.stringify(events));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * Universal Ingestion API — POST endpoints
 *
 * POST /api/ingest — Accept events from any source (Claude Code hooks, MCP servers, custom agents)
 *   Body: { session_id?, event_type, data, cost_usd?, duration_ms?, metadata? }
 *   If session_id is omitted, auto-creates a session.
 *
 * POST /api/sessions/:id/end — End a session
 *   Body: { status: "completed" | "aborted" }
 */
function handlePostApi(url: string, req: IncomingMessage, storage: Storage, res: ServerResponse, broadcast: (msg: Record<string, unknown>) => void, cwd: string): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
  let body = '';
  let exceeded = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      exceeded = true;
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (exceeded) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: 'Payload too large (max 5 MB)' }));
      return;
    }
    try {
      // POST /api/ingest
      if (url === '/api/ingest') {
        const payload = JSON.parse(body);
        const validationErr = validateIngest(payload);
        if (validationErr) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: validationErr }));
          return;
        }
        const eventType = payload.event_type || payload.type || 'api_call';
        const data = payload.data || {};
        const costUsd = payload.cost_usd || 0;
        const durationMs = payload.duration_ms || 0;

        let sessionId = payload.session_id;

        // Auto-create session if not provided
        if (!sessionId) {
          sessionId = randomUUID();
          const sessionResult = storage.createSession({
            id: sessionId,
            objective: payload.objective || 'External Agent Session',
            startedAt: new Date(),
            status: 'recording',
            metadata: {
              agent: payload.agent || 'external',
              model: payload.model,
              workingDir: payload.working_dir || process.cwd(),
              developer: payload.developer || getDeveloperName(),
            },
            totalCostUsd: 0,
            totalTokens: 0,
            totalActions: 0,
          });
          if (!sessionResult.ok) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to create session' }));
            return;
          }
        }

        const sequence = storage.getNextSequence(sessionId);
        const eventId = randomUUID();

        const insertResult = storage.insertEvent({
          id: eventId,
          sessionId,
          timestamp: new Date(),
          sequence,
          type: eventType,
          data,
          durationMs,
          costUsd,
        });

        if (insertResult.ok) {
          // Broadcast immediately to WebSocket clients
          broadcast({
            type: 'event',
            sessionId,
            event: { id: eventId, session_id: sessionId, type: eventType, data: JSON.stringify(data), cost_usd: costUsd, duration_ms: durationMs, sequence, created_at: new Date().toISOString() },
          });

          res.writeHead(200);
          res.end(JSON.stringify({
            ok: true,
            session_id: sessionId,
            event_id: eventId,
            sequence,
          }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to insert event' }));
        }
        return;
      }

      // POST /api/sessions/:id/end
      const endMatch = url.match(/^\/api\/sessions\/([^/]+)\/end$/);
      if (endMatch) {
        const payload = JSON.parse(body);
        const status = payload.status || 'completed';
        const result = storage.endSession(endMatch[1], status);
        if (result.ok) {
          broadcast({ type: 'session_end', session: { id: endMatch[1], status } });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to end session' }));
        }
        return;
      }

      // POST /api/sessions/:id/incident
      const incidentMatch = url.match(/^\/api\/sessions\/([^/]+)\/incident$/);
      if (incidentMatch) {
        const sResult = storage.getSession(incidentMatch[1]);
        if (!sResult.ok || !sResult.value) {
          res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return;
        }
        const sess = sResult.value;
        const evtsResult = storage.getEvents(sess.id);
        const events = (evtsResult.ok ? evtsResult.value : []).map((e) => ({
          sequence: e.sequence, type: e.type, timestamp: e.timestamp,
          data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
          cost_usd: e.cost_usd ?? 0,
        }));
        const driftResult = storage.getDriftSnapshots(sess.id);
        const drifts = driftResult.ok ? driftResult.value : [];
        const latestDrift = drifts[drifts.length - 1];

        const liveStats = storage.getSessionStats(sess.id);
        const stats = liveStats.ok ? liveStats.value : null;

        const incidentId = `inc_${Date.now().toString(36)}`;
        const incident = createIncidentSnapshot(incidentId, {
          sessionId: sess.id, objective: sess.objective ?? '',
          status: sess.status, driftScore: latestDrift?.score ?? sess.final_drift_score ?? null,
          driftFlag: latestDrift?.flag ?? null, driftReason: latestDrift?.reason ?? null,
          totalCost: stats?.total_cost_usd ?? sess.total_cost_usd ?? 0,
          totalActions: stats?.total_events ?? sess.total_actions ?? 0,
        }, events, 'manual');

        storage.insertIncident({
          id: incident.id, sessionId: sess.id, triggeredAt: incident.triggeredAt,
          trigger: incident.trigger, severity: incident.severity,
          driftScore: incident.driftScore, driftFlag: incident.driftFlag,
          summary: incident.summary, snapshot: JSON.stringify(incident),
        });

        storage.pauseSession(sess.id);
        broadcast({ type: 'incident', sessionId: sess.id, incident });
        broadcast({ type: 'session_pause', sessionId: sess.id });

        res.writeHead(200);
        res.end(JSON.stringify(incident));
        return;
      }

      // POST /api/sessions/:id/pause
      const pauseMatch = url.match(/^\/api\/sessions\/([^/]+)\/pause$/);
      if (pauseMatch) {
        const result = storage.pauseSession(pauseMatch[1]);
        if (result.ok) {
          broadcast({ type: 'session_pause', sessionId: pauseMatch[1] });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to pause session' }));
        }
        return;
      }

      // POST /api/sessions/:id/resume
      const resumeMatch = url.match(/^\/api\/sessions\/([^/]+)\/resume$/);
      if (resumeMatch) {
        const result = storage.resumeSession(resumeMatch[1]);
        if (result.ok) {
          broadcast({ type: 'session_resume', sessionId: resumeMatch[1] });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to resume session' }));
        }
        return;
      }

      // POST /api/sessions/:id/fork
      const forkMatch = url.match(/^\/api\/sessions\/([^/]+)\/fork$/);
      if (forkMatch) {
        const payload = JSON.parse(body);
        const upToSequence = payload.upToSequence;
        if (typeof upToSequence !== 'number') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'upToSequence (number) required' }));
          return;
        }
        const result = storage.forkSession(forkMatch[1], upToSequence);
        if (result.ok) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, forkedSessionId: result.value }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: result.error?.message || 'Failed to fork session' }));
        }
        return;
      }

      // POST /api/sessions/:id/delete
      const deleteMatch = url.match(/^\/api\/sessions\/([^/]+)\/delete$/);
      if (deleteMatch) {
        const result = storage.deleteSession(deleteMatch[1]);
        if (result.ok) {
          broadcast({ type: 'session_end', session: { id: deleteMatch[1], status: 'deleted' } });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: result.error?.message || 'Failed to delete session' }));
        }
        return;
      }

      // POST /api/revert — Revert a file change
      if (url === '/api/revert') {
        const payload = JSON.parse(body);
        const eventId = payload.event_id;
        if (!eventId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'event_id required' }));
          return;
        }
        // Find the event
        const allSessions = storage.listSessions({ limit: 1000 });
        let found: Record<string, unknown> | null = null;
        if (allSessions.ok) {
          for (const sess of allSessions.value) {
            const evts = storage.getEvents(sess.id);
            if (evts.ok) {
              const ev = evts.value.find((e) => e.id === eventId);
              if (ev) { found = ev as unknown as Record<string, unknown>; break; }
            }
          }
        }
        if (!found) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Event not found' }));
          return;
        }
        const data = JSON.parse(String(found.data || '{}'));
        const filePath = data.path;
        if (!filePath) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Event has no file path' }));
          return;
        }

        // Strategy 1: For Edit events with contentBefore/contentAfter (old_string/new_string),
        // do a reverse string replacement in the current file
        const contentBefore = data.contentBefore;
        const contentAfter = data.contentAfter;
        if (contentBefore != null && contentAfter != null && existsSync(filePath)) {
          try {
            const current = readFileSync(filePath, 'utf-8');
            if (current.includes(contentAfter)) {
              writeFileSync(filePath, current.replace(contentAfter, contentBefore), 'utf-8');
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, path: filePath, method: 'reverse-edit' }));
              return;
            }
          } catch { /* fall through to git */ }
        }

        // Strategy 2: Use git checkout to restore the file
        execFile(
          'git',
          ['checkout', 'HEAD', '--', filePath],
          { cwd },
          (err) => {
            if (err) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: `Failed to revert: ${err.message}` }));
            } else {
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, path: filePath, method: 'git-checkout' }));
            }
          },
        );
        return;
      }

      // POST /api/settings — Save configuration
      if (url === '/api/settings') {
        const config = JSON.parse(body);
        const settingsErr = validateSettings(config);
        if (settingsErr) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: settingsErr }));
          return;
        }
        const cfgPath = join(cwd, '.hawkeye', 'config.json');
        // Ensure directory exists
        const cfgDir = dirname(cfgPath);
        if (!existsSync(cfgDir)) {
          mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
        }
        // Write with restricted permissions
        writeFileSync(cfgPath, JSON.stringify(config, null, 2), { mode: 0o600 });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/mcp-servers — Save MCP servers to .mcp.json
      if (url === '/api/mcp-servers') {
        const payload = JSON.parse(body);
        if (typeof payload !== 'object' || payload === null) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Payload must be a JSON object' }));
          return;
        }
        const mcpPath = join(cwd, '.mcp.json');
        let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
        try {
          if (existsSync(mcpPath)) {
            mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8'));
            if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
          }
        } catch { /* ignore */ }
        // Merge: payload keys overwrite, null values delete
        for (const [name, config] of Object.entries(payload)) {
          if (config === null) {
            delete mcpConfig.mcpServers[name];
          } else {
            mcpConfig.mcpServers[name] = config;
          }
        }
        writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', { mode: 0o600 });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, servers: Object.keys(mcpConfig.mcpServers) }));
        return;
      }

      // POST /api/autocorrect — Toggle autocorrect or update config
      if (url === '/api/autocorrect') {
        const payload = JSON.parse(body);
        // Validate payload
        if (typeof payload !== 'object' || payload === null) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Payload must be a JSON object' }));
          return;
        }
        
        const cfgPath = join(cwd, '.hawkeye', 'config.json');
        let existing: Record<string, unknown> = {};
        try { 
          existing = JSON.parse(readFileSync(cfgPath, 'utf-8')); 
        } catch {
          // If config doesn't exist, start with empty object
          existing = {};
        }
        
        // Build autocorrect config with validation
        const autocorrectConfig: {
          enabled?: boolean;
          dryRun?: boolean;
          triggers?: { driftCritical: boolean; errorRepeat: number; costThreshold: number };
          actions?: { rollbackFiles: boolean; pauseSession: boolean; injectHint: boolean; blockPattern: boolean };
        } = {};
        
        if (payload.enabled !== undefined) {
          if (typeof payload.enabled !== 'boolean') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'enabled must be a boolean' }));
            return;
          }
          autocorrectConfig.enabled = payload.enabled;
        } else {
          autocorrectConfig.enabled = (existing.autocorrect as Record<string, unknown>)?.enabled as boolean ?? false;
        }

        if (payload.dryRun !== undefined) {
          if (typeof payload.dryRun !== 'boolean') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'dryRun must be a boolean' }));
            return;
          }
          autocorrectConfig.dryRun = payload.dryRun;
        } else {
          autocorrectConfig.dryRun = (existing.autocorrect as Record<string, unknown>)?.dryRun as boolean ?? false;
        }

        const existingAc = (existing.autocorrect ?? {}) as Record<string, unknown>;

        // Validate triggers
        if (payload.triggers !== undefined) {
          if (typeof payload.triggers !== 'object' || payload.triggers === null) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'triggers must be an object' }));
            return;
          }
          autocorrectConfig.triggers = {
            driftCritical: payload.triggers.driftCritical ?? true,
            errorRepeat: payload.triggers.errorRepeat ?? 3,
            costThreshold: payload.triggers.costThreshold ?? 85,
          };
          // Additional validation
          if (autocorrectConfig.triggers.errorRepeat < 1) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'triggers.errorRepeat must be at least 1' }));
            return;
          }
          if (autocorrectConfig.triggers.costThreshold < 0 || autocorrectConfig.triggers.costThreshold > 100) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'triggers.costThreshold must be between 0 and 100' }));
            return;
          }
        } else {
          autocorrectConfig.triggers = (existingAc.triggers as typeof autocorrectConfig.triggers) ?? { driftCritical: true, errorRepeat: 3, costThreshold: 85 };
        }

        // Validate actions
        if (payload.actions !== undefined) {
          if (typeof payload.actions !== 'object' || payload.actions === null) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'actions must be an object' }));
            return;
          }
          autocorrectConfig.actions = {
            rollbackFiles: payload.actions.rollbackFiles ?? true,
            pauseSession: payload.actions.pauseSession ?? true,
            injectHint: payload.actions.injectHint ?? true,
            blockPattern: payload.actions.blockPattern ?? true,
          };
        } else {
          autocorrectConfig.actions = (existingAc.actions as typeof autocorrectConfig.actions) ?? { rollbackFiles: true, pauseSession: true, injectHint: true, blockPattern: true };
        }
        
        existing.autocorrect = autocorrectConfig;
        
        // Ensure directory exists
        const cfgDir = dirname(cfgPath);
        if (!existsSync(cfgDir)) {
          mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
        }
        writeFileSync(cfgPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/autocorrect/clear — Clear the active correction hint
      if (url === '/api/autocorrect/clear') {
        try {
          const hintPath = join(cwd, '.hawkeye', 'active-correction.json');
          if (existsSync(hintPath)) unlinkSync(hintPath);
        } catch {}
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/policies — Save policies.yml
      if (url === '/api/policies') {
        const policy = JSON.parse(body) as PolicyFile;
        const errors = validatePolicy(policy);
        if (errors.length > 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Validation failed', errors }));
          return;
        }
        savePolicy(cwd, policy);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/tasks — Create a new task in the queue
      if (url === '/api/tasks') {
        const payload = JSON.parse(body);
        if (!payload.prompt || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'prompt is required' }));
          return;
        }
        const agent = payload.agent || 'claude';
        const task = createTask(cwd, payload.prompt.trim(), agent);
        // Handle image attachments
        if (payload.attachments && Array.isArray(payload.attachments)) {
          const attachDir = join(cwd, '.hawkeye', 'task-attachments');
          if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });
          const savedPaths: string[] = [];
          for (const att of payload.attachments) {
            if (att.data && att.name) {
              const safeName = `${task.id.slice(0, 8)}-${att.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
              const filePath = join(attachDir, safeName);
              const base64Data = att.data.replace(/^data:image\/\w+;base64,/, '');
              writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
              savedPaths.push(safeName);
            }
          }
          if (savedPaths.length > 0) {
            // Persist the enriched prompt so the daemon receives the attachment paths.
            const attachmentNote = `\n\n[Attached images: ${savedPaths.map((p) => join(cwd, '.hawkeye', 'task-attachments', p)).join(', ')}]`;
            task.prompt += attachmentNote;
            const tasks = loadTasks(cwd);
            const idx = tasks.findIndex((t) => t.id === task.id);
            if (idx >= 0) {
              tasks[idx] = {
                ...tasks[idx],
                prompt: task.prompt,
                attachments: savedPaths,
              };
              saveTasks(cwd, tasks);
            }
          }
        }
        res.writeHead(201);
        res.end(JSON.stringify(task));
        return;
      }

      // POST /api/tasks/clear-finished — Remove completed/failed/cancelled tasks from the queue
      if (url === '/api/tasks/clear-finished') {
        const tasks = loadTasks(cwd);
        const nextTasks = tasks.filter((task) => task.status === 'pending' || task.status === 'running');
        const removed = tasks.length - nextTasks.length;
        saveTasks(cwd, nextTasks);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, removed }));
        return;
      }

      // POST /api/tasks/:id/retry — Clone a finished task back into the queue
      const retryMatch = url.match(/^\/api\/tasks\/([^/]+)\/retry$/);
      if (retryMatch) {
        const sourceId = retryMatch[1];
        const tasks = loadTasks(cwd);
        const source = tasks.find((task) => task.id === sourceId);
        if (!source) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Task not found' }));
          return;
        }

        const retryTask = createTask(cwd, source.prompt, source.agent);
        if (source.attachments && source.attachments.length > 0) {
          const nextTasks = loadTasks(cwd);
          const idx = nextTasks.findIndex((task) => task.id === retryTask.id);
          if (idx >= 0) {
            nextTasks[idx] = {
              ...nextTasks[idx],
              attachments: [...source.attachments],
            };
            saveTasks(cwd, nextTasks);
          }
        }

        res.writeHead(201);
        res.end(JSON.stringify(retryTask));
        return;
      }

      // POST /api/tasks/:id/cancel — Cancel a pending or running task
      const cancelMatch = url.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      if (cancelMatch) {
        const taskId = cancelMatch[1];
        const tasks = loadTasks(cwd);
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Task not found' }));
          return;
        }

        if (task.status === 'running') {
          const daemonStatus = readDaemonStatus(cwd);
          const canKillRunningTask = daemonStatus
            && isDaemonStatusFresh(daemonStatus)
            && daemonStatus.currentTaskId === task.id
            && typeof daemonStatus.currentTaskPid === 'number';

          if (!canKillRunningTask || !daemonStatus?.currentTaskPid) {
            task.status = 'cancelled';
            task.completedAt = new Date().toISOString();
            task.error = 'Cancelled after the daemon heartbeat was missing. Hawkeye treated the task as orphaned.';
            saveTasks(cwd, tasks);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, orphaned: true }));
            return;
          }

          try {
            process.kill(daemonStatus.currentTaskPid, 'SIGTERM');
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Failed to stop running task: ${(err as Error).message}` }));
            return;
          }

          task.status = 'cancelled';
          task.completedAt = new Date().toISOString();
          task.error = 'Cancelled from dashboard.';
          saveTasks(cwd, tasks);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (task.status !== 'pending') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Cannot cancel task with status '${task.status}'` }));
          return;
        }
        task.status = 'cancelled';
        task.completedAt = new Date().toISOString();
        saveTasks(cwd, tasks);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/tasks/journal/clear — Clear the task journal
      if (url === '/api/tasks/journal/clear') {
        clearJournal(cwd);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/review-approve — Approve a pending review gate item
      if (url === '/api/review-approve') {
        const payload = JSON.parse(body);
        const reviewId = payload.id;
        const scope: 'session' | 'always' = payload.scope || 'session';
        if (!reviewId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'id required' }));
          return;
        }

        const hawkDir = join(cwd, '.hawkeye');
        if (!existsSync(hawkDir)) mkdirSync(hawkDir, { recursive: true });
        const pendingFile = join(hawkDir, 'pending-reviews.json');
        const approvalsFile = join(hawkDir, 'review-approvals.json');

        // Load pending reviews
        let pending: Array<{ id: string; matchedPattern: string; claudeSessionId: string; command: string }> = [];
        try {
          if (existsSync(pendingFile)) {
            pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
          }
        } catch {}

        const item = pending.find((p) => p.id === reviewId);
        if (!item) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Pending review not found' }));
          return;
        }

        // Load approvals and add the new one
        let approvals: Array<{ pattern: string; scope: string; sessionId?: string; approvedAt: string; approvedCommand: string }> = [];
        try {
          if (existsSync(approvalsFile)) {
            approvals = JSON.parse(readFileSync(approvalsFile, 'utf-8'));
          }
        } catch {}

        approvals.push({
          pattern: item.matchedPattern,
          scope,
          sessionId: scope === 'session' ? item.claudeSessionId : undefined,
          approvedAt: new Date().toISOString(),
          approvedCommand: item.command,
        });

        // Remove from pending
        const remaining = pending.filter((p) => p.id !== reviewId);
        writeFileSync(pendingFile, JSON.stringify(remaining, null, 2));
        writeFileSync(approvalsFile, JSON.stringify(approvals, null, 2));

        broadcast({ type: 'review_approved', reviewId, pattern: item.matchedPattern, scope });

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, pattern: item.matchedPattern, scope }));
        return;
      }

      // POST /api/review-deny — Deny/dismiss a pending review gate item
      if (url === '/api/review-deny') {
        const payload = JSON.parse(body);
        const reviewId = payload.id;
        if (!reviewId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'id required' }));
          return;
        }

        const hawkDir = join(cwd, '.hawkeye');
        const pendingFile = join(hawkDir, 'pending-reviews.json');

        let pending: Array<{ id: string; matchedPattern: string }> = [];
        try {
          if (existsSync(pendingFile)) {
            pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
          }
        } catch {}

        const item = pending.find((p) => p.id === reviewId);
        if (!item) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Pending review not found' }));
          return;
        }

        const remaining = pending.filter((p) => p.id !== reviewId);
        writeFileSync(pendingFile, JSON.stringify(remaining, null, 2));

        broadcast({ type: 'review_denied', reviewId, pattern: item.matchedPattern });

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/swarms — Create and run a new swarm
      if (url === '/api/swarms') {
        try {
          const swarmPayload = JSON.parse(body);
          const config = validateSwarmConfig(swarmPayload);
          // Wire up broadcast for WebSocket updates
          setSwarmBroadcast((msg) => broadcast(msg));
          // Run swarm in background (don't block the response)
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, message: 'Swarm started' }));
          // Execute after responding
          runSwarm(config, cwd).catch((err) => {
            console.error('Swarm error:', err);
          });
        } catch (e: unknown) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Invalid swarm config: ${(e as Error).message}` }));
        }
        return;
      }

      // POST /api/swarms/template — Generate swarm template
      if (url === '/api/swarms/template') {
        res.writeHead(200);
        res.end(generateSwarmTemplate());
        return;
      }

      // POST /api/swarms/:id/cancel — Cancel a running swarm
      const cancelSwarmMatch = url.match(/^\/api\/swarms\/([^/]+)\/cancel$/);
      if (cancelSwarmMatch) {
        storage.updateSwarm(cancelSwarmMatch[1], { status: 'cancelled', completed_at: new Date().toISOString() });
        broadcast({ type: 'swarm', event: 'swarm_cancelled', swarmId: cancelSwarmMatch[1] });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/swarms/:id/delete — Delete a swarm
      const deleteSwarmMatch = url.match(/^\/api\/swarms\/([^/]+)\/delete$/);
      if (deleteSwarmMatch) {
        storage.deleteSwarm(deleteSwarmMatch[1]);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/agents/spawn — Spawn a new live agent
      if (url === '/api/agents/spawn') {
        const p = JSON.parse(body);
        if (!p.name || !p.prompt) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name and prompt are required' }));
          return;
        }
        const role = (['lead', 'worker', 'reviewer'].includes(p.role) ? p.role : 'worker') as 'lead' | 'worker' | 'reviewer';
        const perms = (['default', 'full', 'supervised'].includes(p.permissions) ? p.permissions : 'default') as PermissionLevel;
        const agent = spawnLiveAgent(p.name, p.command || 'claude', p.prompt, cwd, broadcast, role, p.personality || '', storage, perms);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, agent }));
        return;
      }

      // POST /api/agents/:id/stop — Kill a running agent
      const stopAgentMatch = url.match(/^\/api\/agents\/([^/]+)\/stop$/);
      if (stopAgentMatch) {
        const agent = liveAgents.get(stopAgentMatch[1]);
        if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
        const proc = agentProcesses.get(agent.id);
        if (proc) { proc.kill('SIGTERM'); }
        agent.status = 'failed';
        agent.finishedAt = new Date().toISOString();
        broadcast({ type: 'agent_complete', agentId: agent.id, status: 'failed' });
        persistAgents(cwd);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/agents/:id/remove — Remove an agent from the list
      const removeAgentMatch = url.match(/^\/api\/agents\/([^/]+)\/remove$/);
      if (removeAgentMatch) {
        const proc = agentProcesses.get(removeAgentMatch[1]);
        if (proc) proc.kill('SIGTERM');
        liveAgents.delete(removeAgentMatch[1]);
        agentProcesses.delete(removeAgentMatch[1]);
        broadcast({ type: 'agent_removed', agentId: removeAgentMatch[1] });
        persistAgents(cwd);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/agents/:id/permissions — Change agent permission level
      const permAgentMatch = url.match(/^\/api\/agents\/([^/]+)\/permissions$/);
      if (permAgentMatch) {
        const agent = liveAgents.get(permAgentMatch[1]);
        if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
        const p = JSON.parse(body);
        const valid: PermissionLevel[] = ['default', 'full', 'supervised'];
        if (!p.permissions || !valid.includes(p.permissions)) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'permissions must be one of: default, full, supervised' })); return;
        }
        agent.permissions = p.permissions;
        persistAgents(cwd);
        broadcast({ type: 'agent_permissions', agentId: agent.id, permissions: agent.permissions });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, agent }));
        return;
      }

      // ─── Inter-Agent Communication Endpoints ──────────────────

      // GET /api/agents/messages — Get all inter-agent messages
      if (url === '/api/agents/messages' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(agentMessages.slice(-200)));
        return;
      }

      // GET /api/agents/:id/inbox — Get unread messages for an agent
      const inboxMatch = url.match(/^\/api\/agents\/([^/]+)\/inbox$/);
      if (inboxMatch && req.method === 'GET') {
        const agent = liveAgents.get(inboxMatch[1]);
        if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
        const inbox = getInboxForAgent(agent.id);
        res.writeHead(200);
        res.end(JSON.stringify(inbox));
        return;
      }

      // POST /api/agents/comms — Send an inter-agent message
      if (url === '/api/agents/comms' && req.method === 'POST') {
        const p = JSON.parse(body);
        if (!p.content) { res.writeHead(400); res.end(JSON.stringify({ error: 'content required' })); return; }

        const fromAgent = p.from ? liveAgents.get(p.from) : null;
        const msg: AgentMessage = {
          id: randomUUID().slice(0, 12),
          from: p.from || 'dashboard',
          fromName: fromAgent?.name || p.fromName || 'Dashboard',
          to: p.to || null,
          toRole: p.toRole || null,
          content: p.content,
          type: p.type || 'direct',
          timestamp: new Date().toISOString(),
          read: false,
        };

        agentMessages.push(msg);
        persistMessages(cwd);
        broadcast({ type: 'agent_message', message: msg });

        // Auto-deliver to target agents that are completed — trigger follow-up
        const targets: LiveAgent[] = [];
        if (msg.to) {
          const t = liveAgents.get(msg.to);
          if (t) targets.push(t);
        } else if (msg.toRole) {
          for (const a of liveAgents.values()) {
            if (a.role === msg.toRole && a.id !== msg.from) targets.push(a);
          }
        } else {
          // broadcast — deliver to all non-sender agents
          for (const a of liveAgents.values()) {
            if (a.id !== msg.from) targets.push(a);
          }
        }

        const delivered: string[] = [];
        for (const target of targets) {
          if (target.status !== 'running') {
            // Auto-deliver via follow-up for completed agents
            const deliveryPrompt = `[INTER-AGENT MESSAGE from ${msg.fromName} (${fromAgent?.role || 'dashboard'})]\n${msg.content}\n\nRespond to this message while staying in your role as ${target.role}. If you need to communicate back, describe what you'd tell them.`;

            const commsEnv = buildLiveAgentEnv(cwd, target.command);
            const resolvedTargetCmd = resolveAgentCommand(target.command, cwd, commsEnv);
            const isClaude = inferAgentName(target.command) === 'claude';
            const extraArgs =
              target.permissions === 'full' ? getAgentFullAccessArgs(resolvedTargetCmd) : [];

            const { cmd, args } = buildAgentInvocation(resolvedTargetCmd, deliveryPrompt, {
              continueConversation: isClaude,
              extraArgs,
            });

            try {
              target.status = 'running';
              target.finishedAt = null;
              target.exitCode = null;

              const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: commsEnv });
              target.pid = child.pid || null;
              agentProcesses.set(target.id, child);
              broadcast({ type: 'agent_spawned', agent: { id: target.id, name: target.name, command: target.command, prompt: deliveryPrompt, status: 'running' } });
              persistAgents(cwd);

              child.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                target.output += chunk;
                if (target.output.length > 50000) target.output = target.output.slice(-40000);
                broadcast({ type: 'agent_output', agentId: target.id, chunk: chunk.slice(0, 2000) });
              });
              child.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                target.output += chunk;
                if (target.output.length > 50000) target.output = target.output.slice(-40000);
              });
              child.on('error', (err) => {
                target.status = 'failed';
                target.finishedAt = new Date().toISOString();
                target.output += `\nError: ${err.message}`;
                agentProcesses.delete(target.id);
                broadcast({ type: 'agent_complete', agentId: target.id, status: 'failed', error: err.message });
                persistAgents(cwd);
              });
              child.on('close', (code) => {
                target.status = code === 0 ? 'completed' : 'failed';
                target.exitCode = code;
                target.finishedAt = new Date().toISOString();
                agentProcesses.delete(target.id);
                if (!(storage && syncAgentStatsFromSession(target, storage))) {
                  syncAgentStatsFromGit(target, cwd);
                }
                broadcast({ type: 'agent_complete', agentId: target.id, status: target.status, exitCode: code ?? undefined, filesChanged: target.filesChanged });
                persistAgents(cwd);
              });

              delivered.push(target.id);
            } catch { /* spawn failed, skip */ }
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: msg, delivered }));
        return;
      }

      // DELETE /api/agents/messages — Clear message history
      if (url === '/api/agents/messages' && req.method === 'DELETE') {
        agentMessages.length = 0;
        persistMessages(cwd);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/agents/:id/message — Send a follow-up to an agent (continues same session)
      const msgAgentMatch = url.match(/^\/api\/agents\/([^/]+)\/message$/);
      if (msgAgentMatch) {
        const agent = liveAgents.get(msgAgentMatch[1]);
        if (!agent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
        const p = JSON.parse(body);
        if (!p.message) { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return; }

        // If agent is still running, can't send follow-up
        if (agent.status === 'running') {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Agent is still running. Wait for completion or stop it first.' })); return;
        }

        // Continue the same agent — use --continue for Claude to keep the same conversation
        const followUpEnv = buildLiveAgentEnv(cwd, agent.command);
        const resolvedCmd = resolveAgentCommand(agent.command, cwd, followUpEnv);
        const isClaude = inferAgentName(agent.command) === 'claude';

        const extraArgs =
          agent.permissions === 'full' ? getAgentFullAccessArgs(resolvedCmd) : [];

        const { cmd, args } = buildAgentInvocation(resolvedCmd, p.message, {
          continueConversation: isClaude, // --continue for Claude = same session
          extraArgs,
        });

        // Update agent state — keep same ID, same sessionId, accumulate stats
        agent.status = 'running';
        agent.finishedAt = null;
        agent.exitCode = null;
        agent.prompt = p.message; // update prompt to latest follow-up

        try {
          const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: followUpEnv });
          agent.pid = child.pid || null;
          agentProcesses.set(agent.id, child);

          broadcast({ type: 'agent_spawned', agent: { id: agent.id, name: agent.name, command: agent.command, prompt: p.message, status: 'running' } });
          persistAgents(cwd);

          child.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            agent.output += chunk;
            if (agent.output.length > 50000) agent.output = agent.output.slice(-40000);
            broadcast({ type: 'agent_output', agentId: agent.id, chunk: chunk.slice(0, 2000) });
          });

          child.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            agent.output += chunk;
            if (agent.output.length > 50000) agent.output = agent.output.slice(-40000);
          });

          child.on('error', (err) => {
            agent.status = 'failed';
            agent.finishedAt = new Date().toISOString();
            agent.output += `\nError: ${err.message}`;
            agentProcesses.delete(agent.id);
            broadcast({ type: 'agent_complete', agentId: agent.id, status: 'failed', error: err.message });
            persistAgents(cwd);
          });

          child.on('close', (code) => {
            agent.status = code === 0 ? 'completed' : 'failed';
            agent.exitCode = code;
            agent.finishedAt = new Date().toISOString();
            agentProcesses.delete(agent.id);

            if (!(storage && syncAgentStatsFromSession(agent, storage))) {
              syncAgentStatsFromGit(agent, cwd);
            }

            broadcast({
              type: 'agent_complete', agentId: agent.id, status: agent.status,
              exitCode: code ?? undefined, filesChanged: agent.filesChanged,
            });
            persistAgents(cwd);
          });

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, agent }));
        } catch (spawnErr) {
          agent.status = 'failed';
          agent.finishedAt = new Date().toISOString();
          persistAgents(cwd);
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Failed to spawn follow-up: ${String(spawnErr)}` }));
        }
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Invalid request: ${String(err)}` }));
    }
  });
}

function serveStatic(url: string, distDir: string, res: ServerResponse): void {
  const resolvedDir = resolve(distDir);
  let filePath = resolve(distDir, url === '/' ? 'index.html' : url.replace(/^\//, ''));

  // Path traversal protection
  if (!filePath.startsWith(resolvedDir + '/') && filePath !== resolvedDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // SPA fallback: if file doesn't exist, serve index.html
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(distDir, 'index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  // HTML: always revalidate so new JS/CSS hashes are picked up
  // Assets with content hashes: cache immutably
  if (ext === '.html') {
    res.setHeader('Cache-Control', 'no-cache');
  }
  res.writeHead(200);
  res.end(readFileSync(filePath));
}
