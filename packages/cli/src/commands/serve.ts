import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, extname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { Storage } from '@hawkeye/core';

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
  .action((options) => {
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
          handlePostApi(url, req, storage, res);
        } else {
          handleApi(url, storage, res);
        }
        return;
      }

      // Static files
      serveStatic(url, dashboardDist, res);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(chalk.yellow(`\n  Port ${port} is already in use.`));
        console.error(chalk.dim(`  Try: hawkeye serve -p <other-port>`));
        storage.close();
        process.exit(1);
      }
      throw err;
    });

    server.listen(port, () => {
      console.log('');
      console.log(chalk.green('  Hawkeye Dashboard'));
      console.log(chalk.dim('  ─'.repeat(25)));
      console.log(`  ${chalk.dim('Local:')}   ${chalk.cyan(`http://localhost:${port}`)}`);
      console.log(`  ${chalk.dim('DB:')}      ${chalk.dim(dbPath)}`);
      console.log('');
      console.log(chalk.dim('  Press Ctrl+C to stop'));
      console.log('');
    });

    process.on('SIGINT', () => {
      storage.close();
      server.close();
      process.exit(0);
    });
  });

function handleApi(url: string, storage: Storage, res: ServerResponse): void {
  res.setHeader('Content-Type', 'application/json');

  try {
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

    // GET /api/settings
    if (url === '/api/settings') {
      const configPath = join(process.cwd(), '.hawkeye', 'config.json');
      const config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, 'utf-8'))
        : getDefaultConfig();
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
function handlePostApi(url: string, req: IncomingMessage, storage: Storage, res: ServerResponse): void {
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
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to end session' }));
        }
        return;
      }

      // POST /api/settings — Save configuration
      if (url === '/api/settings') {
        const config = JSON.parse(body);
        const configPath = join(process.cwd(), '.hawkeye', 'config.json');
        writeFileSync(configPath, JSON.stringify(config, null, 2));
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

// Provider → recommended models mapping (updated 2026-03)
const PROVIDER_MODELS: Record<string, string[]> = {
  ollama: ['llama4', 'llama3.2', 'mistral', 'codellama', 'deepseek-coder', 'phi3'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'o4-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'devstral-latest'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
};

function getDefaultConfig() {
  return {
    drift: {
      enabled: true,
      checkEvery: 5,
      provider: 'ollama',
      model: 'llama3.2',
      warningThreshold: 60,
      criticalThreshold: 30,
      contextWindow: 10,
    },
    guardrails: [
      {
        name: 'protected_files',
        type: 'file_protect',
        enabled: true,
        action: 'block',
        config: { paths: ['.env', '.env.*', '*.pem', '*.key'] },
      },
      {
        name: 'dangerous_commands',
        type: 'command_block',
        enabled: true,
        action: 'block',
        config: { patterns: ['rm -rf /', 'rm -rf ~', 'sudo rm', 'DROP TABLE', 'curl * | bash'] },
      },
      {
        name: 'cost_limit',
        type: 'cost_limit',
        enabled: true,
        action: 'block',
        config: { maxUsdPerSession: 5.0, maxUsdPerHour: 2.0 },
      },
      {
        name: 'token_limit',
        type: 'token_limit',
        enabled: false,
        action: 'warn',
        config: { maxTokensPerSession: 500000 },
      },
      {
        name: 'project_scope',
        type: 'directory_scope',
        enabled: false,
        action: 'block',
        config: { blockedDirs: ['/etc', '/usr', '~/.ssh'] },
      },
    ],
  };
}
