import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, extname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec, execSync } from 'node:child_process';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { Storage } from '@hawkeye/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, getDefaultConfig, PROVIDER_MODELS } from '../config.js';

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
    const currentDir = fileURLToPath(new URL('.', import.meta.url));
    const dashboardDist = join(currentDir, '..', '..', '..', 'dashboard', 'dist');

    if (!existsSync(dashboardDist)) {
      console.error(chalk.red('Dashboard not built. Run `pnpm build` first.'));
      return;
    }

    const storage = new Storage(dbPath);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/';

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

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
      if (req.url === '/ws') {
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
      } catch {}
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
        console.log(chalk.dim('  ─'.repeat(25)));
        if (currentPort !== port) {
          console.log(`  ${chalk.yellow('⚠')} Port ${port} was in use, using ${currentPort} instead`);
        }
        console.log(`  ${chalk.dim('Local:')}   ${chalk.cyan(`http://localhost:${currentPort}`)}`);
        console.log(`  ${chalk.dim('WS:')}      ${chalk.cyan(`ws://localhost:${currentPort}/ws`)}`);
        console.log(`  ${chalk.dim('DB:')}      ${chalk.dim(dbPath)}`);
        console.log('');
        console.log(chalk.dim('  Press Ctrl+C to stop'));
        console.log('');

        // Auto-open browser if configured
        const cfg = loadConfig(cwd);
        if (cfg.dashboard?.openBrowser !== false) {
          const url = `http://localhost:${currentPort}`;
          const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
          exec(`${cmd} ${url}`, () => {});
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

    process.on('SIGINT', () => {
      clearInterval(pollInterval);
      wss.close();
      storage.close();
      server.close();
      process.exit(0);
    });
  });

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

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      // POST /api/ingest
      if (url === '/api/ingest') {
        const payload = JSON.parse(body);
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
        exec(
          `git checkout HEAD -- "${filePath}"`,
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
        const cfgPath = join(cwd, '.hawkeye', 'config.json');
        writeFileSync(cfgPath, JSON.stringify(config, null, 2));
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

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Invalid request: ${String(err)}` }));
    }
  });
}

function serveStatic(url: string, distDir: string, res: ServerResponse): void {
  let filePath = join(distDir, url === '/' ? 'index.html' : url);

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
  res.writeHead(200);
  res.end(readFileSync(filePath));
}
