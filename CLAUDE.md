# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hawkeye is an open-source observability and security tool for AI agents (Claude Code, Cursor, AutoGPT, CrewAI, Aider, etc.). It acts as a "flight recorder" that logs every action an agent performs, enables visual session replay, and includes **DriftDetect** (real-time objective drift detection) and **Guardrails** (file protection, command blocking, cost limits).

## Architecture

TypeScript monorepo using pnpm workspaces + Turborepo:

- `packages/core` — Node.js SDK: recorder engine, interceptors (terminal, filesystem, network, LLM), SQLite storage, DriftDetect engine, guardrails enforcer
- `packages/cli` — CLI (Commander.js + chalk). Commands: `init`, `record` (alias: `watch`), `replay`, `sessions`, `stats`, `inspect`, `compare`, `serve`, `export`, `hooks`, `hook-handler`, `mcp`, `otel-export`, `end`, `restart`. Interactive TUI via raw-mode stdin with slash command picker.
- `packages/dashboard` — React 19 + Vite + Tailwind CSS + Recharts web UI served by `hawkeye serve` on port 4242

### Data Flow

Interceptors capture events → Recorder evaluates guardrails (sync, blocking) → persists to SQLite → triggers drift check (async, non-blocking). The CLI's `serve` command exposes a REST API (`/api/sessions`, `/api/sessions/:id/events`, `/api/sessions/:id/drift`, `/api/sessions/:id/pause`, `/api/sessions/:id/resume`, `/api/sessions/:id/end`, `/api/sessions/:id/cost-by-file`, `/api/compare?ids=id1,id2`, `/api/settings`, `/api/providers`, `/api/ingest`, `/api/stats`, `/api/revert`) and serves the dashboard as static files.

### Network Interception (Child Process)

The network interceptor works across process boundaries: `hawkeye record` writes a preload ESM script to `.hawkeye/_preload.mjs` and injects it into the child process via `NODE_OPTIONS="--import ..."`. The preload script monkey-patches `http/https.request` and `globalThis.fetch`, detects LLM calls by hostname or API path+headers (`/v1/messages` for Anthropic, `/v1/chat/completions` for OpenAI, `/api/generate` and `/api/chat` for Ollama), parses SSE streaming responses, and sends captured events back to the parent via Node.js IPC (`process.send()`).

### Claude Code Hooks Integration

For agents like Claude Code that use a bundled Node.js runtime (NODE_OPTIONS doesn't work), Hawkeye uses Claude Code hooks. `hawkeye hooks install` configures `.claude/settings.json` with PreToolUse (guardrails — exit code 2 blocks actions), PostToolUse (event recording), and Stop (drift score update) hooks. The `hook-handler` reads JSON from stdin, evaluates guardrails, and writes events directly to SQLite. Sessions are auto-created per Claude Code session_id. **Important**: The Stop hook fires after every Claude Code response (not just conversation end), so it only updates drift scores — it does NOT end the session.

### Universal Ingestion API

`POST /api/ingest` accepts events from any source (MCP servers, custom agents, external tools). Auto-creates sessions if `session_id` is omitted. `POST /api/sessions/:id/end` closes a session.

### OpenTelemetry Export

`hawkeye otel-export <session-id>` exports sessions as OTLP JSON traces (compatible with Grafana Tempo, Jaeger, Datadog, Honeycomb). Session = root span, events = child spans. Supports direct push to OTLP HTTP endpoints via `--endpoint`.

### Interactive TUI

When `hawkeye` is run with no subcommand, it launches an interactive TUI (`packages/cli/src/interactive.ts`). Key implementation details:

- **Raw mode input** (`process.stdin.setRawMode(true)`) with custom `parseKeys()` for arrow keys, escape, ctrl combos
- **Slash command picker**: type `/` to open dropdown, arrow keys to navigate, Tab to complete, Escape to dismiss, live filtering as you type
- **Ghost text** `/ for commands` when buffer is empty
- **Piped mode fallback**: when stdin is not TTY, uses a line queue (`nextLine()`, `lineQueue[]`, `lineWaiter`) for proper async serialization
- Commands dispatch from `executeCommand()` to individual `cmdXxx()` functions
- Numeric input at main prompt selects from `lastSessions[]` array
- Settings management via sub-menus (DriftDetect, Guardrails, API Keys) using `loadConfig()`/`saveConfig()` from `config.ts`

### Configuration

Two config files exist (legacy):

- `hawkeye init` writes **YAML** to `.hawkeye/config.yaml` (legacy format)
- `hawkeye serve` and the interactive TUI read/write **JSON** to `.hawkeye/config.json` (canonical format)

The unified config module is `packages/cli/src/config.ts`:

- `HawkeyeConfig` = `{ drift: DriftSettings, guardrails: GuardrailRuleSetting[], apiKeys?: ApiKeysSettings, webhooks?: WebhookSettings[] }`
- `PROVIDER_MODELS` — map of provider → model list for 6 providers (ollama, anthropic, openai, deepseek, mistral, google)
- `loadConfig(cwd)` reads `.hawkeye/config.json`, merges with defaults
- `saveConfig(cwd, config)` writes back to `.hawkeye/config.json`

## Prerequisites

- Node.js ≥ 20
- pnpm 9.x

## Build & Dev Commands

```bash
pnpm install                    # Install all dependencies
pnpm build                      # Production build (all packages)
pnpm dev                        # Dev mode (Turborepo watch)
pnpm test                       # Run all tests (Vitest)
pnpm --filter @hawkeye/core test  # Run only core tests
pnpm --filter @hawkeye/cli build  # Build only CLI
npx vitest run src/drift/scorer.test.ts  # Run a single test file (from package dir)
```

### Local CLI Testing

```bash
cd packages/cli && npm link     # Installs global `hawkeye` binary (use npm, not pnpm)
pnpm build                      # Rebuild after changes
hawkeye                         # Test the CLI globally
```

## Code Conventions

- TypeScript strict mode, ES2022 target, ESM modules
- File names in kebab-case
- Named exports only (no default exports except React components)
- `Result<T, E>` pattern for error handling (no throwing in core)
- Logging via `Logger` class from `src/logger.ts` (writes to stderr, not console.log)
- Formatting: Prettier (semi, singleQuote, trailingComma: all, printWidth: 100)
- chalk v5 (ESM-only) for terminal colors, `o` = `chalk.hex('#ff5f1f')` accent color
- Use `crypto.randomUUID()` in CLI (no uuid npm dependency); core package uses the `uuid` package

## Database

SQLite via `better-sqlite3` with WAL mode. Schema in `packages/core/src/storage/schema.ts`. Four tables: `sessions`, `events`, `drift_snapshots`, `guardrail_violations`. Manual migrations (no ORM). Local data directory: `.hawkeye/` (auto-created on first use). `Storage` class has `deleteSession()` and `getCostByFile()` methods.

## Common Gotchas

- Port 4242 (dashboard) may be in use from previous sessions — kill the old process before restarting `hawkeye serve`
- `pnpm build` must succeed before testing CLI commands (TypeScript must be compiled)
- Live stats for recording sessions: `serve.ts` computes from events table since sessions table only updates on end
- Claude Code hooks require `hawkeye hooks install` (NODE_OPTIONS preload doesn't work with Claude Code's bundled Node.js runtime)

## DriftDetect

- Heuristic scorer (`drift/scorer.ts`): penalizes dangerous commands (rm -rf, DROP TABLE, curl|bash), suspicious paths (/etc, ~/.ssh), sensitive file extensions (.pem, .key, .env), high error rates
- LLM scorer: prompt templates in `drift/prompts.ts` with few-shot examples for actionable reasons (e.g., "Agent was asked to add auth but has been editing CSS"). Supports Ollama (default), Anthropic, OpenAI, DeepSeek, Mistral, Google
- Sliding weighted average via `slidingDriftScore()`. Checks every N actions (configurable)
- Thresholds: ok (70-100), warning (40-69), critical (0-39)
- Auto-pause: when `autoPause` is enabled, sessions auto-pause on critical drift
- Webhook notifications: configurable webhook URLs for `drift_critical` and `guardrail_block` events (Slack/Discord compatible)

## Guardrails

Rules evaluated synchronously before event persistence. Rule types: `file_protect` (glob patterns), `command_block` (regex patterns), `cost_limit` (per-session and per-hour), `token_limit`, `directory_scope`, `network_lock` (allowed/blocked hostnames for API calls), `review_gate` (command patterns requiring human approval). Actions: `warn` or `block`. Blocked events are persisted as `guardrail_trigger` type. Rule definitions in `packages/core/src/guardrails/rules.ts`.

## Design System (Dashboard)

- Dark mode default. Colors: bg `#060608`, surface `#111117`, surface2 `#18181f`, border `#242430`, accent `#ff5f1f` (orange)
- Drift indicators: green `#22c55e` (ok), amber `#f0a830` (warning), red `#ef4444` (critical)
- Fonts: IBM Plex Mono (code), Outfit (headings), Instrument Sans (body)

## Key Files Reference

| File                                        | Why it's non-obvious                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/cli/src/interactive.ts`           | TUI with raw-mode input, slash command picker — all `cmdXxx()` functions    |
| `packages/cli/src/config.ts`                | Unified config types, load/save, `PROVIDER_MODELS` map (shared by TUI+API) |
| `packages/cli/src/commands/serve.ts`        | Dashboard server + all REST API endpoints (not just static file serving)    |
| `packages/cli/src/commands/hook-handler.ts` | Internal hook handler — reads JSON from stdin, writes directly to SQLite    |
| `packages/core/src/types.ts`                | Central type definitions used across all packages                           |
| `packages/core/src/interceptors/llm.ts`     | LLM endpoint detection, token extraction, cost estimation (shared logic)    |
| `packages/core/src/drift/scorer.ts`         | Heuristic drift scorer — scoring logic and penalty rules                    |
| `packages/cli/src/mcp/server.ts`            | MCP server — 27 tools for agent self-awareness (stdio JSON-RPC)             |
| `packages/core/src/llm/providers.ts`        | LLM provider factory — Ollama, Anthropic, OpenAI, DeepSeek, Mistral, Google |
| `packages/core/src/llm/post-mortem.ts`      | Post-mortem prompt template and JSON response parser                        |

## MCP Server

Hawkeye exposes an MCP (Model Context Protocol) server via `hawkeye mcp` (stdio JSON-RPC). Agents like Claude Code, Cursor, Windsurf, and Cline can connect to it for real-time self-awareness.

### Setup

Add to `.mcp.json` at project root (Claude Code auto-reads this):

```json
{
  "mcpServers": {
    "hawkeye": {
      "command": "node",
      "args": ["path/to/hawkeye/packages/cli/dist/index.js", "mcp"]
    }
  }
}
```

### MCP Tools Reference (27 tools)

**Observability** — Query session data and metrics:

| Tool | Description |
|------|-------------|
| `list_sessions` | List sessions with optional status filter and limit |
| `get_session` | Get session details by ID or prefix (min 4 chars) |
| `get_session_events` | Get events with optional type/limit filters |
| `get_session_drift` | Get drift score snapshots for a session |
| `get_session_stats` | Get session statistics (actions, cost, tokens, duration) |
| `get_global_stats` | Get aggregate stats across all sessions |
| `compare_sessions` | Compare two sessions side by side |
| `get_violations` | Get guardrail violations for a session |
| `get_cost_by_file` | Get cost breakdown by file for a session |

**Self-awareness** — Tools the agent calls to understand its own state:

| Tool | Description |
|------|-------------|
| `check_drift` | Get current drift score + trend for active session |
| `get_objective` | Retrieve the original objective of the current session |
| `check_cost` | Get current cost/token usage vs budget limits |
| `check_guardrail` | Pre-check if a command/file/network action would be blocked |
| `check_progress` | Heuristic progress estimate based on actions, files, drift, errors |
| `log_event` | Record a custom event (decision, note, milestone) |
| `list_changes` | List files modified in the current session with stats |
| `get_config` | Read current Hawkeye config (drift, guardrails, webhooks) |

**Intelligence** — LLM-powered analysis and summaries:

| Tool | Description |
|------|-------------|
| `get_session_timeline` | Condensed timeline grouped into phases (30s gaps) |
| `get_error_summary` | Aggregate errors by pattern with frequency and last occurrence |
| `suggest_correction` | LLM-generated correction when drift is high or errors repeat |
| `post_mortem` | Full LLM-powered session post-mortem (summary, outcome, recommendations) |

**Actions** — Control session lifecycle:

| Tool | Description |
|------|-------------|
| `end_session` | End a recording session |
| `pause_session` | Pause a recording session |
| `resume_session` | Resume a paused session |
| `set_objective` | Update the objective of a session |

**Cross-session** — Search and act across sessions:

| Tool | Description |
|------|-------------|
| `search_events` | Keyword search across all sessions' events |
| `revert_file` | Revert a file to its pre-session state using git |

### Hawkeye MCP Self-Monitoring

This project has a Hawkeye MCP server configured. Use these tools proactively:

- **Every 10 actions**: call `check_drift` to verify you're still aligned with the objective
- **Before dangerous operations** (force push, delete, deploy): call `check_guardrail` to pre-check
- **When unsure about direction**: call `get_objective` to re-read the original task
- **When making a significant decision**: call `log_event` with type "decision" to document your reasoning
- **If you encounter repeated errors**: call `get_error_summary` to spot patterns
- **Periodically**: call `check_cost` to stay budget-aware
- **At session end**: call `post_mortem` for a structured debrief
