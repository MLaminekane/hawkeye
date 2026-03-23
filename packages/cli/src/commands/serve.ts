import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync, mkdirSync, watch, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec, execFile, execFileSync, execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { Storage, analyzeRootCause, extractMemories, diffMemories, detectHallucinations, buildCumulativeMemory, createIncidentSnapshot, selfAssess, generateAutoCorrection, extractGitCommits, type RcaEvent, type RcaSession, type RcaDriftSnapshot, type MemoryItem } from '@mklamine/hawkeye-core';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, getDefaultConfig, PROVIDER_MODELS, getDeveloperName } from '../config.js';
import { fireWebhooks } from '../webhooks.js';
import { loadPolicy, savePolicy, validatePolicy, generateTemplate, configToPolicy, type PolicyFile } from '../policy.js';
import { generatePdfBuffer } from './export.js';
import { loadTasks, saveTasks, createTask, readJournal, clearJournal, type Task } from './daemon.js';
import { runSwarm, setSwarmBroadcast } from './swarm.js';
import { validateSwarmConfig, generateSwarmTemplate } from '@mklamine/hawkeye-core';
import type { ChildProcess } from 'node:child_process';
import { buildAgentInvocation } from './agent-command.js';

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

const AGENTS_FILE = '.hawkeye/agents.json';

function persistAgents(cwd: string): void {
  try {
    const data = Array.from(liveAgents.values()).map((a) => ({
      ...a,
      output: a.output.slice(-2000), // keep only tail for persistence
    }));
    writeFileSync(join(cwd, AGENTS_FILE), JSON.stringify(data, null, 2));
  } catch {}
}

function loadPersistedAgents(cwd: string): void {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, AGENTS_FILE), 'utf-8'));
    if (!Array.isArray(raw)) return;
    for (const a of raw) {
      if (!a.id) continue;
      // Running agents from previous process are now dead
      if (a.status === 'running') {
        a.status = 'failed';
        a.finishedAt = a.finishedAt || new Date().toISOString();
        a.output = (a.output || '') + '\n[Server restarted — agent process lost]';
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

  // Resolve command — pass --dangerously-skip-permissions for 'full' access
  const extraArgs: string[] = [];
  if (permissions === 'full') {
    extraArgs.push('--dangerously-skip-permissions');
  }
  const { cmd, args } = buildAgentInvocation(command, fullPrompt, { extraArgs });

  try {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
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
      broadcast({ type: 'agent_complete', agentId: id, status: 'failed', error: err.message });
      persistAgents(cwd);
    });

    child.on('close', (code) => {
      agent.status = code === 0 ? 'completed' : 'failed';
      agent.exitCode = code;
      agent.finishedAt = new Date().toISOString();
      agentProcesses.delete(id);

      // Detect files changed
      if (initialHash) {
        try {
          const diff = execSync(`git diff --name-only ${initialHash}`, { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
          agent.filesChanged = diff ? diff.split('\n') : [];
          const stat = execSync(`git diff --stat ${initialHash}`, { cwd, encoding: 'utf-8', timeout: 10000 });
          const m = stat.match(/(\d+) insertions?\(\+\)/);
          const d = stat.match(/(\d+) deletions?\(-\)/);
          agent.linesAdded = m ? parseInt(m[1]) : 0;
          agent.linesRemoved = d ? parseInt(d[1]) : 0;
        } catch {}
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
        const evResult = storage.getEvents(agent.sessionId);
        if (evResult.ok) {
          agent.actionCount = evResult.value.length;
          agent.costUsd = evResult.value.reduce((sum: number, e: { cost_usd?: number }) => sum + (e.cost_usd || 0), 0);
        }
        const drResult = storage.getDriftSnapshots(agent.sessionId);
        if (drResult.ok && drResult.value.length > 0) {
          agent.driftScore = drResult.value[drResult.value.length - 1].score;
        }
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
  if (payload.guardrails !== undefined && !Array.isArray(payload.guardrails)) {
    return 'guardrails must be an array';
  }
  if (payload.webhooks !== undefined && !Array.isArray(payload.webhooks)) {
    return 'webhooks must be an array';
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

    // Restore agents from previous server run
    loadPersistedAgents(cwd);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
          handleApi(url, storage, res, dbPath, cwd);
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
      const wsOrigin = req.headers.origin || '';
      const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(wsOrigin);
      if (req.url === '/ws' && (isLocalOrigin || !wsOrigin)) {
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

    function scheduleReload(changedFile: string) {
      if (isRestarting) return;
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

function handleApi(url: string, storage: Storage, res: ServerResponse, dbPath?: string, cwd?: string): void {
  res.setHeader('Content-Type', 'application/json');

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
      const config = loadConfig(cwd || process.cwd());
      res.writeHead(200);
      res.end(JSON.stringify(config));
      return;
    }

    // GET /api/providers
    if (url === '/api/providers') {
      res.writeHead(200);
      res.end(JSON.stringify(PROVIDER_MODELS));
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
      const events = storage.getRecentBlocks(50);
      // Also append any pending reviews
      const pendingFile = join(cwd || process.cwd(), '.hawkeye', 'pending-reviews.json');
      let pending: unknown[] = [];
      try {
        if (existsSync(pendingFile)) pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
      } catch {}
      res.writeHead(200);
      res.end(JSON.stringify({ blocks: events, pendingReviews: pending }));
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
  req.on('end', () => {
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
        writeFileSync(cfgPath, JSON.stringify(config, null, 2));
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/autocorrect — Toggle autocorrect or update config
      if (url === '/api/autocorrect') {
        const payload = JSON.parse(body);
        const cfgPath = join(cwd, '.hawkeye', 'config.json');
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch {}
        existing.autocorrect = {
          enabled: payload.enabled ?? false,
          dryRun: payload.dryRun ?? false,
          triggers: payload.triggers ?? { driftCritical: true, errorRepeat: 3, costThreshold: 85 },
          actions: payload.actions ?? { rollbackFiles: true, pauseSession: true, injectHint: true, blockPattern: true },
        };
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
            // Update task with attachment info and append paths to prompt for agent reference
            const tasks = loadTasks(cwd);
            const idx = tasks.findIndex((t) => t.id === task.id);
            if (idx >= 0) {
              (tasks[idx] as any).attachments = savedPaths;
              saveTasks(cwd, tasks);
            }
            task.prompt += `\n\n[Attached images: ${savedPaths.map(p => join(cwd, '.hawkeye', 'task-attachments', p)).join(', ')}]`;
          }
        }
        broadcast({ type: 'task_created', task });
        res.writeHead(201);
        res.end(JSON.stringify(task));
        return;
      }

      // POST /api/tasks/:id/cancel — Cancel a pending task
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
        if (task.status !== 'pending') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Cannot cancel task with status '${task.status}'` }));
          return;
        }
        task.status = 'cancelled';
        task.completedAt = new Date().toISOString();
        saveTasks(cwd, tasks);
        broadcast({ type: 'task_cancelled', task });
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

      // POST /api/agents/:id/message — Send a follow-up prompt to a completed agent
      const msgAgentMatch = url.match(/^\/api\/agents\/([^/]+)\/message$/);
      if (msgAgentMatch) {
        const prevAgent = liveAgents.get(msgAgentMatch[1]);
        if (!prevAgent) { res.writeHead(404); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
        const p = JSON.parse(body);
        if (!p.message) { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return; }
        // Create a follow-up prompt with context from previous work
        const followUp = `You previously worked on this task:\n"${prevAgent.prompt}"\n\nFiles you changed: ${prevAgent.filesChanged.join(', ') || 'none'}\n\nNew instruction: ${p.message}`;
        const newAgent = spawnLiveAgent(prevAgent.name, prevAgent.command, followUp, cwd, broadcast, prevAgent.role, prevAgent.personality, storage, prevAgent.permissions);
        // Remove old agent
        liveAgents.delete(prevAgent.id);
        persistAgents(cwd);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, agent: newAgent }));
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
