# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hawkeye is an open-source observability and security tool for AI agents (Claude Code, Cursor, AutoGPT, CrewAI, Aider, Codex, etc.). It acts as a "flight recorder" that logs every action an agent performs, enables visual session replay, and includes **DriftDetect** (real-time objective drift detection), **Guardrails** (file protection, command blocking, cost limits), **Impact Preview** (pre-execution risk analysis), **Live Firewall** (real-time action stream with browser notifications), **Policy Engine** (declarative `.hawkeye/policies.yml`), **Time Travel Debugging** (step-through replay with breakpoints, session forking), **Memory Diff** (cross-session agent memory tracking, hallucination detection), **Autonomous Control Layer** (autocorrect engine that autonomously rolls back files, pauses sessions, blocks failing patterns, and injects correction hints to agents via MCP), **Multi-agent Orchestration (Swarm)** (coordinate multiple AI agents on parallel tasks with isolated worktrees, scope enforcement, dependency ordering, conflict detection, and merge strategies), and **Live Agent Spawning** (spawn, monitor, and control AI agents directly from the dashboard with role assignment, permission levels, real-time session linking, and persistent state).

## Architecture

TypeScript monorepo using pnpm workspaces + Turborepo:

- `packages/core` — Node.js SDK: recorder engine, interceptors (terminal, filesystem, network, LLM), SQLite storage, DriftDetect engine, guardrails enforcer, RCA engine, Memory Diff engine
- `packages/cli` — CLI (Commander.js + chalk). Commands: `init`, `record` (alias: `watch`), `replay`, `sessions`, `stats`, `inspect`, `compare`, `serve`, `export`, `hooks`, `hook-handler`, `mcp`, `otel-export`, `end`, `restart`, `daemon`, `overnight`, `report`, `policy`, `analyze`, `memory`, `autocorrect`, `swarm`, `ci`. Interactive TUI via raw-mode stdin with slash command picker.
- `packages/dashboard` — React 19 + Vite + Tailwind CSS + Recharts web UI served by `hawkeye serve` on port 4242. Mobile responsive.

### Data Flow

Interceptors capture events → Recorder evaluates guardrails (sync, blocking) → persists to SQLite → triggers drift check (async, non-blocking). The CLI's `serve` command exposes a REST API (`/api/sessions`, `/api/sessions/:id/events`, `/api/sessions/:id/drift`, `/api/sessions/:id/pause`, `/api/sessions/:id/resume`, `/api/sessions/:id/end`, `/api/sessions/:id/fork`, `/api/sessions/:id/analyze`, `/api/sessions/:id/memory`, `/api/sessions/:id/cost-by-file`, `/api/compare?ids=id1,id2`, `/api/settings`, `/api/providers`, `/api/policies`, `/api/ingest`, `/api/stats`, `/api/revert`, `/api/tasks`, `/api/tasks/journal`, `/api/pending-reviews`, `/api/review-approve`, `/api/review-deny`, `/api/impact`, `/api/interceptions`, `/api/sessions/:id/corrections`, `/api/corrections`, `/api/active-correction`, `/api/autocorrect`, `/api/swarms`, `/api/swarms/:id`, `/api/swarms/:id/agents`, `/api/swarms/:id/conflicts`, `/api/swarms/:id/full`, `/api/swarms/:id/cancel`, `/api/swarms/:id/delete`, `/api/agents`, `/api/agents/spawn`, `/api/agents/:id`, `/api/agents/:id/stop`, `/api/agents/:id/remove`, `/api/agents/:id/message`, `/api/agents/:id/permissions`, `/api/agents/:id/events`, `/api/sessions/:id/ci-report`) and serves the dashboard as static files. The server **auto-reloads** on `pnpm build` — it watches `dist/` and restarts itself when compiled files change.

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
- **Terminal-responsive**: `tw()` returns clamped terminal width (max 120), `hr()` generates adaptive horizontal rules. All separators, session lines, inspect boxes adapt to terminal width
- Commands dispatch from `executeCommand()` to individual `cmdXxx()` functions
- Numeric input at main prompt selects from `lastSessions[]` array
- Settings management via sub-menus (DriftDetect, Guardrails, API Keys) using `loadConfig()`/`saveConfig()` from `config.ts`
- `/tasks` — List/create/clear remote tasks, view/clear agent memory journal
- `/remote` — Launch serve + daemon + cloudflare tunnel for mobile access
- `/remote stop` — Kill tunnel + daemon

### Remote Tasks & Daemon

`hawkeye daemon` (`packages/cli/src/commands/daemon.ts`) polls `.hawkeye/tasks.json` for pending tasks and executes them via `claude -p` (or any agent CLI). Key features:

- **Persistent memory** via `.hawkeye/task-journal.md`: after each task, a summary (prompt, files changed via `git diff --stat`, output) is appended to the journal. This journal is injected as context into every new task prompt, so the agent "remembers" what it did before.
- **Session continuity** (`--continue`): for Claude, if the last task completed within 30 minutes, uses `claude --continue -p` to resume the conversation instead of starting fresh.
- **Context injection**: when starting a new session (no `--continue`), the prompt is enriched with git status, branch, recent commits, and the task journal.
- **Task queue**: tasks stored in `.hawkeye/tasks.json`, created via dashboard (`POST /api/tasks`), TUI (`/tasks new`), or direct file edit.
- **Image attachments**: tasks can include base64-encoded images saved to `.hawkeye/task-attachments/` and served via `/api/tasks/attachments/:filename`.
- **Review gate integration**: dashboard Tasks page has auto-approve toggle + approve/deny buttons for guardrail-blocked actions.

### Live Agent Spawning

`hawkeye serve` includes a full agent lifecycle manager. Agents are spawned, monitored, and controlled via the dashboard or API.

- **LiveAgent interface**: `id`, `name`, `command`, `prompt`, `role` (lead/worker/reviewer), `personality`, `permissions` (default/full/supervised), `status`, `output`, `pid`, `sessionId`, `driftScore`, `actionCount`, `costUsd`
- **Permission levels**: `'full'` passes `--dangerously-skip-permissions` to `claude -p`; `'supervised'` relies on Hawkeye guardrails; `'default'` uses agent runtime defaults
- **Agent command resolution**: `packages/cli/src/commands/agent-command.ts` — `buildAgentInvocation()` resolves CLI commands with `extraArgs` support. Known agents: `claude` (`-p`), `aider` (`--message --yes`), `codex` (`-q`)
- **Session linking**: Two detection methods — (1) diff `.hawkeye/hook-sessions.json` before/after spawn, (2) DB fallback querying `listSessions()` for sessions started after spawn time. Retries at 3s/6s/10s/15s + continuous polling
- **Stats polling**: Every 5s, queries Storage for linked session's events to compute live drift, cost, and action count
- **Persistence**: `Map<string, LiveAgent>` backed by `.hawkeye/agents.json`. Written on every mutation (spawn, error, close, stop, remove, message, session link, stats). Loaded on server startup via `loadPersistedAgents()`
- **WebSocket events**: `agent_spawned`, `agent_output`, `agent_complete`, `agent_removed`, `agent_session_linked`, `agent_stats`, `agent_permissions`
- **Follow-up messages**: `POST /api/agents/:id/message` continues the same conversation (`claude --continue -p`), reuses the same agent ID and linked session, accumulates stats (cost, actions, files). No new session is created — it's like talking to the same person.
- **Permission change**: `POST /api/agents/:id/permissions` — change an agent's permission level at any time (full/supervised/default). Dashboard shows a clickable dropdown on the permission badge. Persisted to `agents.json`.
- **CI Report per agent**: Dashboard agent cards have a "CI Report" button that generates the same report as `hawkeye ci` for the agent's linked session (risk, flags, markdown, copy-to-clipboard).

### Server Auto-Reload

`hawkeye serve` watches the CLI `dist/` directory using `fs.watch`. When `pnpm build` writes new compiled `.js` files:

1. Debounces for 1.5s (build writes multiple files)
2. Spawns a new serve process (detached, inherits stdio)
3. Gracefully shuts down the current process (close WebSocket, DB, HTTP server)
4. New server takes over on the same port

Dashboard static files (HTML/CSS/JS) are read from disk per-request, so dashboard changes are visible immediately after build without server restart.

### Configuration

All config is **JSON** at `.hawkeye/config.json` (created by `hawkeye init`, edited by TUI `/settings`, dashboard, or directly).

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

SQLite via `better-sqlite3` with WAL mode. Schema in `packages/core/src/storage/schema.ts`. Nine tables: `sessions`, `events`, `drift_snapshots`, `guardrail_violations`, `memory_items`, `corrections`, `swarms`, `swarm_agents`, `swarm_conflicts`. Manual migrations (no ORM). Local data directory: `.hawkeye/` (auto-created on first use). `Storage` class has `deleteSession()`, `getCostByFile()`, `upsertMemoryItems()`, `getMemoryItems()`, `getAllMemoryItems()`, `insertCorrection()`, `getCorrections()`, `getAllCorrections()`, `createSwarm()`, `getSwarm()`, `listSwarms()`, `updateSwarm()`, `deleteSwarm()`, `insertSwarmAgent()`, `getSwarmAgents()`, `updateSwarmAgent()`, `insertSwarmConflict()`, `getSwarmConflicts()`, `resolveSwarmConflict()` methods.

## Security

### API Server (`serve.ts`)

- **CORS**: restricted to `localhost`/`127.0.0.1` origins only
- **WebSocket origin validation**: upgrade requests rejected unless origin is localhost or absent (direct CLI connections)
- **POST body size limit**: 5 MB max — requests exceeding this are destroyed with 413
- **Path traversal protection**: `serveStatic()` and `/api/tasks/attachments` both resolve paths and verify they don't escape their root directory
- **No command injection**: `/api/revert` uses `execFile()` (array args) instead of `exec()` (shell string)

### Configuration (`config.ts`)

- **File permissions**: `saveConfig()` writes `config.json` with mode `0o600` (owner read/write only) and creates `.hawkeye/` with mode `0o700`. This protects API keys stored in config from other users on shared machines.

### Hook Handler (`hook-handler.ts`)

- **Lockfile for concurrent writes**: `saveSessions()` uses an exclusive lockfile (`hook-sessions.json.lock`) to prevent race conditions when multiple hook invocations write simultaneously. Includes stale lock detection (2s timeout) and retry with spin-wait.
- **Read retry**: `loadSessions()` retries once on JSON parse failure to handle reads during concurrent writes.

## Common Gotchas

- `hawkeye serve` **auto-restarts** after `pnpm build` — no manual restart needed. Dashboard static files are read per-request so UI changes are immediate.
- Port 4242 (dashboard) may be in use from previous sessions — serve handles this by killing the old process automatically
- `pnpm build` must succeed before testing CLI commands (TypeScript must be compiled)
- Live stats for recording sessions: `serve.ts` computes from events table since sessions table only updates on end
- Claude Code hooks require `hawkeye hooks install` (NODE_OPTIONS preload doesn't work with Claude Code's bundled Node.js runtime)
- Daemon tasks run as independent `claude -p` processes. Use `--continue` for conversation continuity (auto-detected within 30 min window)
- Task journal (`.hawkeye/task-journal.md`) is auto-trimmed to 30 entries. Clear via `/tasks clear-journal` or dashboard Memory button

## DriftDetect

- Heuristic scorer (`drift/scorer.ts`): penalizes dangerous commands (rm -rf, DROP TABLE, curl|bash), suspicious paths (/etc, ~/.ssh), sensitive file extensions (.pem, .key, .env), high error rates
- LLM scorer: prompt templates in `drift/prompts.ts` with few-shot examples for actionable reasons (e.g., "Agent was asked to add auth but has been editing CSS"). Supports Ollama (default), Anthropic, OpenAI, DeepSeek, Mistral, Google
- Sliding weighted average via `slidingDriftScore()`. Checks every N actions (configurable)
- Thresholds: ok (70-100), warning (40-69), critical (0-39)
- Auto-pause: when `autoPause` is enabled, sessions auto-pause on critical drift
- Webhook notifications: configurable webhook URLs for `drift_critical` and `guardrail_block` events (Slack/Discord compatible)

## Guardrails

Rules evaluated synchronously before event persistence. Rule types: `file_protect` (glob patterns), `command_block` (regex patterns), `cost_limit` (per-session and per-hour), `token_limit`, `directory_scope`, `network_lock` (allowed/blocked hostnames for API calls), `review_gate` (command patterns requiring human approval), `impact_threshold` (block/warn above risk level). Actions: `warn` or `block`. Blocked events are persisted as `guardrail_trigger` type. Rule definitions in `packages/core/src/guardrails/rules.ts`.

## Time Travel Debugging

Dashboard session replay upgraded to a full agent debugger. `SessionDetailPage.tsx` + `TimelineBar.tsx`:

- **Step-through**: Step forward/back buttons (⏮/⏭) + play/pause + speed controls (1x–10x)
- **Breakpoints**: `Set<number>` state. Toggle via SVG timeline click, keyboard `B`, or right-click menu. Playback auto-pauses at breakpoints
- **Interactive SVG timeline** (`TimelineBar`): Color-coded dots by event type, drift score line overlay, current position marker (orange), breakpoint diamonds (red). Right-click context menu: "Toggle breakpoint", "Replay from here", "Fork from here", "Jump to event"
- **Session forking**: `POST /api/sessions/:id/fork` + `Storage.forkSession()`. Copies session + events + drift snapshots + guardrail violations up to sequence N into a new session. Navigates to forked session
- **Keyboard shortcuts**: `←`/`→` step, `Space` play/pause, `B` toggle breakpoint. Only active in replay mode, ignored in input fields
- **Auto-expand**: Current event details auto-expand during step-through via `setExpandedEvent()`

## Root Cause Analysis

`packages/core/src/analysis/rca.ts` — Heuristic RCA engine + LLM prompt builder. CLI: `hawkeye analyze <session> [--json] [--llm]`. Dashboard: "Analyze" button on session detail. MCP: `analyze_root_cause` tool. API: `GET /api/sessions/:id/analyze`.

Algorithm: (1) classify events into errors/guardrails/normal, (2) detect error patterns by normalizing + grouping, (3) find primary error (most repeated pattern or last error), (4) build causal chain by tracing backwards from primary error through related file modifications and LLM decisions, (5) analyze drift trajectory (trend, inflection point), (6) generate pattern-based suggestions, (7) assess confidence. Optional `--llm` flag sends condensed timeline + heuristic results to LLM for natural language root cause explanation.

## Memory Diff

`packages/core/src/analysis/memory-diff.ts` — Cross-session agent memory tracking engine. Extracts structured "memories" from session events (file knowledge, error lessons, corrections, tool patterns, decisions, dependency facts, API knowledge), persists them in SQLite, and enables comparison across sessions.

- **Memory Extraction**: 7-phase heuristic analysis of session events. File interactions → file_knowledge, errors + fixes → error_lesson/correction, recurring commands → tool_pattern, explicit decisions → decision, dependency manifests → dependency_fact, API calls → api_knowledge
- **Memory Diff** (`diffMemories`): Compare two sessions' memories — learned (new in B), forgotten (in A not B), retained (same), evolved (same key, different content), contradicted (opposing conclusions)
- **Hallucination Detection** (`detectHallucinations`): Cross-session analysis for recurring errors (same error pattern in 2+ sessions), contradicted facts (same key, opposite content)
- **Cumulative Memory** (`buildCumulativeMemory`): Aggregates all memories across sessions, deduplicates by key (latest wins), tracks corrections and contradictions
- **Storage**: `memory_items` table (session_id, category, key, content, evidence, confidence). Methods: `upsertMemoryItems()`, `getMemoryItems()`, `getAllMemoryItems()`, `getMemoryItemsByKey()`
- **CLI**: `hawkeye memory [session]`, `hawkeye memory diff <s1> <s2>`, `hawkeye memory cumulative`, `hawkeye memory hallucinations` (all support `--json`)
- **TUI**: `/memory`, `/memory diff <s1> <s2>`, `/memory hallucinations`
- **API**: `GET /api/sessions/:id/memory`, `GET /api/memory/diff?a=<id>&b=<id>`, `GET /api/memory/cumulative?limit=N`, `GET /api/memory/hallucinations`
- **MCP**: `memory_diff` (compare two sessions), `check_memory` (cumulative view)
- **Dashboard**: `/memory` page with 3 tabs: Cumulative Memory, Memory Diff (session picker), Hallucinations

## Autonomous Control Layer (Autocorrect)

`packages/core/src/analysis/autocorrect.ts` — Active co-pilot engine. Hawkeye doesn't just observe — it autonomously corrects agent behavior when drift, errors, or cost issues are detected.

### How it works

1. **Trigger evaluation** (`shouldTriggerAutocorrect`): After every drift check in the hook-handler, evaluates conditions:
   - Drift score hits critical (< 30)
   - Drift declining (warning + downward trend)
   - Error pattern repeats N times (configurable, default 3)
   - Cost exceeds budget threshold (configurable, default 85%)

2. **Correction planning** (`planCorrections`): Generates a correction plan based on trigger type:
   - `rollback_file` — `git checkout -- <file>` to revert problematic recent changes
   - `pause_session` — Freeze the session to prevent further damage
   - `inject_hint` — Write `.hawkeye/active-correction.json` with instructions for MCP-aware agents
   - `block_pattern` — Dynamically block failing command patterns
   - `notify` — Fire webhooks with correction details

3. **Execution** (`evaluateAndCorrect`): Executes corrections immediately (or logs them in dry-run mode). All corrections are persisted to the `corrections` SQLite table.

4. **Agent integration**: MCP-aware agents (Claude Code, Cursor) receive correction hints via `get_correction` or `auto_correct` tools. The hint includes `agentInstructions` — a direct instruction to change behavior.

### Configuration

```json
{
  "autocorrect": {
    "enabled": true,
    "dryRun": false,
    "triggers": { "driftCritical": true, "errorRepeat": 3, "costThreshold": 85 },
    "actions": { "rollbackFiles": true, "pauseSession": true, "injectHint": true, "blockPattern": true }
  }
}
```

- **CLI**: `hawkeye autocorrect enable [--dry-run]`, `hawkeye autocorrect disable`, `hawkeye autocorrect status`, `hawkeye autocorrect history`
- **TUI**: `/autocorrect enable`, `/autocorrect disable`, `/autocorrect status`, `/autocorrect history`
- **API**: `GET /api/sessions/:id/corrections`, `GET /api/corrections`, `GET /api/active-correction`, `POST /api/autocorrect`, `POST /api/autocorrect/clear`
- **MCP**: `auto_correct` (enhanced — includes active correction + history), `get_correction` (read active hint)
- **Dashboard**: Autocorrect toggle in settings, correction history per session

## Impact Preview

`packages/cli/src/impact.ts` — Pre-execution risk analysis engine. Every agent action is analyzed BEFORE execution via the hook-handler's PreToolUse phase. Computes risk level (low/medium/high/critical) based on command patterns (rm, git push --force, DROP TABLE, curl|bash, npm publish), file sensitivity (.env, .pem, .key), and git status. Outputs formatted preview to stderr and writes `last-impact.json` for the dashboard. Critical-risk actions are blocked (configurable via `impact_threshold` policy rule). The dashboard's Firewall page shows the live action stream via WebSocket `action_stream` messages, with browser push notifications for blocked/critical actions.

## Policy Engine

Declarative security policies in `.hawkeye/policies.yml` (YAML format). Shareable across projects and teams.

- `packages/cli/src/policy.ts` — Core: schema types, YAML parser/serializer, validator, template generator, config↔policy converters
- `packages/cli/src/commands/policy.ts` — CLI: `hawkeye policy init|check|show|export|import`
- Dashboard Settings page has full CRUD for policy rules (add/remove/edit/toggle)
- `loadGuardrailConfig()` in hook-handler merges policies.yml rules with config.json guardrails
- `POST /api/policies` validates schema server-side before writing
- Policy file written with `0o600` permissions

Rule types: `file_protect`, `command_block`, `cost_limit`, `token_limit`, `directory_scope`, `network_lock`, `review_gate`, `impact_threshold`.

## Overnight Mode

`hawkeye overnight` composes serve + daemon + strict guardrails into a single command for unattended runs:

1. Backs up config to `.hawkeye/overnight-config-backup.json`
2. Applies strict guardrails: cost limit (from `--budget`), file_protect for sensitive files, command_block enabled, drift `autoPause: true`
3. Writes `.hawkeye/overnight.json` with state (startedAt, budget, agent, port)
4. Spawns serve + daemon (detached), optional cloudflare tunnel (`--tunnel`), optional initial task (`--task`)
5. Blocks on Ctrl+C → generates morning report, fires `overnight_report` webhook, restores config backup, kills daemon/tunnel

`hawkeye report` generates a standalone morning report: `--since <iso>`, `--json`, `--llm` (post-mortem per session), `--webhook`. Defaults to reading `startedAt` from `overnight.json` or 8h ago.

## Multi-agent Orchestration (Swarm)

`hawkeye swarm` coordinates multiple AI agents working on subtasks in parallel, each in an isolated git worktree with enforced scope boundaries.

### Architecture

- **Core types**: `packages/core/src/swarm/types.ts` — SwarmConfig, AgentPersona, AgentScope, SwarmTask, SwarmAgent, SwarmResult, FileConflict, DB row types
- **Config & validation**: `packages/core/src/swarm/config.ts` — JSON config parsing, validation, topological sort for task dependencies (Kahn's algorithm), scope validation with glob matching, template generation
- **Conflict detection**: `packages/core/src/swarm/conflict.ts` — File conflict detection between agents, conflict severity scoring, merge order optimization
- **CLI orchestrator**: `packages/cli/src/commands/swarm.ts` — Full orchestrator with git worktree isolation, parallel agent execution, scope enforcement (prompt-level), conflict detection, sequential/octopus merge strategies, live terminal progress display, webhook notifications, SQLite persistence
- **Storage**: 3 tables — `swarms` (run metadata, status, cost, test results), `swarm_agents` (per-agent state, files changed, merge status), `swarm_conflicts` (file conflicts between agents)
- **API**: `GET /api/swarms`, `GET /api/swarms/:id`, `GET /api/swarms/:id/agents`, `GET /api/swarms/:id/conflicts`, `GET /api/swarms/:id/full`, `POST /api/swarms/:id/cancel`, `POST /api/swarms/:id/delete`
- **Dashboard**: `/swarm` page (list + detail view with expandable agent cards, scope display, conflict visualization, test results, merge info). Real-time WebSocket updates during execution
- **MCP**: 3 tools — `list_swarms`, `get_swarm`, `get_swarm_agent`
- **TUI**: `/swarm [list|init|<id>]`

### Config Format (JSON)

```json
{
  "name": "my-swarm",
  "objective": "Build feature X",
  "mergeStrategy": "sequential",
  "autoMerge": true,
  "testCommand": "npm test",
  "timeout": 3600,
  "agents": [
    {
      "name": "backend-agent",
      "role": "worker",
      "command": "claude",
      "scope": { "include": ["src/api/**"], "exclude": ["*.test.ts"] },
      "timeout": 1800,
      "color": "#3b82f6"
    }
  ],
  "tasks": [
    {
      "id": "backend",
      "agent": "backend-agent",
      "prompt": "Create REST API endpoints",
      "dependsOn": [],
      "priority": 0
    }
  ]
}
```

### Execution Flow

1. Parse + validate config, resolve task dependency order (topological sort)
2. Create isolated git worktrees per agent (`.hawkeye/swarm-<id>/<agent>/`)
3. Execute agents in waves respecting dependencies — agents with unmet deps are `blocked`
4. Scope enforcement: agent prompts include scope restrictions (include/exclude globs)
5. After completion: collect git diff stats, detect file conflicts between agents
6. Merge phase: sequential (least-conflict-first) or octopus strategy
7. Optional test phase: run test command after merge
8. Persist results to SQLite, fire webhooks, clean up worktrees

### Agent Personas

Each agent has a persona with: name, role (`lead`/`worker`/`reviewer`), command (CLI to invoke), scope (include/exclude globs), timeout, cost budget, model override, and display color. Known agents: `claude`, `aider`, `codex`. Custom agents supported.

### Scope Enforcement

Scope is enforced at two levels:
1. **Prompt-level**: Agent's prompt includes `IMPORTANT: You are ONLY allowed to modify files matching: <patterns>`
2. **Post-execution validation**: After agent completes, files changed outside scope are flagged as violations

### Conflict Detection

After all agents complete, Hawkeye compares file lists to detect overlaps. Conflicts scored by severity (config/lock files = critical, more agents = worse, modify+delete = worse). Merge order optimized to minimize conflicts (agents with fewer conflicts merge first).

## GitHub PR Integration

`hawkeye ci` posts session observability reports to GitHub PRs as Check Runs and comments.

- **Report generation**: `packages/cli/src/commands/ci-report.ts` — `generateCIReport()` produces markdown with metrics table, flags (sensitive files, dangerous commands, failed commands, guardrail violations), drift trajectory, cost-by-file, and files changed
- **CLI command**: `packages/cli/src/commands/ci.ts` — auto-detects repo/SHA/branch, finds session by branch match, posts via GitHub API (native `fetch`, no Octokit)
- **GitHub Action**: `action.yml` at repo root — `MLaminekane/hawkeye@v1` composite action
- **Idempotent comments**: Uses `<!-- hawkeye-ci-report -->` HTML marker to update existing comments instead of duplicating
- **Check Run**: `hawkeye/safety` check with pass/fail based on risk level (critical = fail)
- **Risk assessment**: critical (drift < 30 OR guardrail blocks OR 3+ dangerous commands), high (drift < 50 OR 5+ errors), medium (drift < 70 OR any errors/sensitive files), low
- **Session auto-detection**: matches `git_branch` in session metadata to current branch, falls back to most recent session
- **Branch capture**: hook-handler now includes `gitBranch` in session metadata at creation time (via `execSync('git rev-parse --abbrev-ref HEAD')`)

## Webhooks

Shared `fireWebhooks()` utility in `packages/cli/src/webhooks.ts`. Seven webhook event types:

- `drift_critical` — fired by record.ts when drift score drops to critical
- `guardrail_block` — fired by record.ts when a guardrail blocks an action
- `session_complete` — fired by serve.ts auto-close on 30min inactivity
- `task_complete` — fired by daemon.ts after each task finishes (completed or failed)
- `overnight_report` — fired by overnight.ts / report.ts with full report payload
- `autocorrect` — fired by hook-handler when autocorrect engine executes corrections
- `swarm_complete` — fired by swarm.ts when a swarm run finishes (all agents + merge + tests)

## Design System (Dashboard)

- Dark mode default. Colors: bg `#060608`, surface `#111117`, surface2 `#18181f`, border `#242430`, accent `#ff5f1f` (orange)
- Drift indicators: green `#22c55e` (ok), amber `#f0a830` (warning), red `#ef4444` (critical)
- Fonts: IBM Plex Mono (code), Outfit (headings), Instrument Sans (body)

## Key Files Reference

| File                                        | Why it's non-obvious                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/cli/src/interactive.ts`           | TUI with raw-mode input, slash command picker — all `cmdXxx()` functions      |
| `packages/cli/src/config.ts`                | Unified config types, load/save, `PROVIDER_MODELS` map (shared by TUI+API)   |
| `packages/cli/src/commands/serve.ts`        | Dashboard server + REST API + agent spawning + auto-reload watcher            |
| `packages/cli/src/commands/agent-command.ts`| Agent command resolver — buildAgentInvocation() for claude/aider/codex       |
| `packages/cli/src/commands/daemon.ts`       | Task daemon — polls tasks.json, context injection, journal, `--continue`      |
| `packages/cli/src/commands/hook-handler.ts` | Internal hook handler — reads JSON from stdin, writes directly to SQLite      |
| `packages/cli/src/commands/record-overlay.ts` | Recording banner + terminal title bar (adaptive width)                      |
| `packages/core/src/types.ts`                | Central type definitions used across all packages                             |
| `packages/core/src/interceptors/llm.ts`     | LLM endpoint detection, token extraction, cost estimation (shared logic)      |
| `packages/core/src/drift/scorer.ts`         | Heuristic drift scorer — scoring logic and penalty rules                      |
| `packages/cli/src/mcp/server.ts`            | MCP server — 38 tools for agent self-awareness (stdio JSON-RPC)               |
| `packages/core/src/llm/providers.ts`        | LLM provider factory — Ollama, Anthropic, OpenAI, DeepSeek, Mistral, Google   |
| `packages/core/src/llm/post-mortem.ts`      | Post-mortem prompt template and JSON response parser                          |
| `packages/dashboard/src/pages/TasksPage.tsx` | Remote tasks page — image upload, auto-approve, journal viewer               |
| `packages/cli/src/commands/overnight.ts`    | Overnight orchestrator — serve + daemon + strict guardrails + morning report  |
| `packages/cli/src/commands/report.ts`       | Morning report generator — aggregates sessions, drift, errors, post-mortem   |
| `packages/cli/src/webhooks.ts`              | Shared `fireWebhooks()` utility used by record, serve, daemon, overnight     |
| `packages/cli/src/commands/ci.ts`           | GitHub PR integration — Check Run + comment, auto-detect session/repo       |
| `packages/cli/src/commands/ci-report.ts`    | CI markdown report generator — risk, flags, drift, cost-by-file             |
| `packages/cli/src/commands/arena.ts`        | Agent Arena (not registered as CLI command — code exists but not wired)       |
| `packages/cli/src/impact.ts`               | Impact Preview engine — risk analysis, command patterns, file sensitivity    |
| `packages/cli/src/policy.ts`               | Policy Engine — YAML schema, parser, validator, template, converters         |
| `packages/cli/src/commands/policy.ts`      | Policy CLI — init, check, show, export, import subcommands                   |
| `packages/dashboard/src/pages/InterceptionPage.tsx` | Firewall page — live action stream, risk classification, notifications |
| `packages/core/src/analysis/rca.ts`                 | RCA engine — heuristic analysis, causal chain, error patterns, LLM prompt |
| `packages/core/src/analysis/memory-diff.ts`         | Memory Diff engine — extraction, diffing, hallucination detection, cumulative |
| `packages/cli/src/commands/memory.ts`               | CLI memory command — extract, diff, cumulative, hallucinations              |
| `packages/dashboard/src/pages/MemoryPage.tsx`       | Dashboard Memory page — cumulative view, diff picker, hallucinations        |
| `packages/cli/src/commands/analyze.ts`              | CLI analyze command — chalk-formatted RCA report, --json, --llm           |
| `packages/core/src/analysis/autocorrect.ts`                | Autocorrect engine — triggers, correction planner, executor, hint builder |
| `packages/cli/src/commands/autocorrect.ts`                  | CLI autocorrect command — enable, disable, status, history, clear        |
| `packages/dashboard/src/components/TimelineBar.tsx` | Time Travel timeline — SVG dots, breakpoints, drift overlay, context menu |
| `packages/core/src/swarm/types.ts`                          | Swarm types — SwarmConfig, AgentPersona, SwarmResult, FileConflict       |
| `packages/core/src/swarm/config.ts`                         | Swarm config — validation, topological sort, scope matching, templates   |
| `packages/core/src/swarm/conflict.ts`                       | Swarm conflict detection — file overlap, severity scoring, merge order   |
| `packages/cli/src/commands/swarm.ts`                        | Swarm CLI orchestrator — worktrees, execution, merge, live progress      |
| `packages/dashboard/src/pages/SwarmPage.tsx`                | Dashboard Agents Control Room — spawn, monitor, control live agents + swarm orchestration |

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

### MCP Tools Reference (38 tools)

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
| `analyze_root_cause` | Heuristic root cause analysis: primary error, causal chain, patterns, suggestions |
| `memory_diff` | Compare what an agent remembers between two sessions (learned, forgotten, hallucinations) |
| `check_memory` | Cumulative agent memory across sessions — what knowledge persists and what was lost |
| `post_mortem` | Full LLM-powered session post-mortem (summary, outcome, recommendations) |
| `auto_correct` | Get correction actions + check if autocorrect engine has already intervened (rollback, pause, hints) |
| `get_correction` | Check if Hawkeye has autonomously corrected your session — returns active correction hint |

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

**Swarm** — Multi-agent orchestration:

| Tool | Description |
|------|-------------|
| `list_swarms` | List past and active swarm runs with status, cost, agent count |
| `get_swarm` | Get full swarm details: agents, files changed, conflicts, merge results |
| `get_swarm_agent` | Get detailed info about a specific agent within a swarm run |

### Hawkeye MCP Self-Monitoring

This project has a Hawkeye MCP server configured. Use these tools proactively:

- **At session start**: call `check_memory` to see what previous agents learned — avoid repeating their mistakes and build on their work
- **Every 10 actions**: call `check_drift` to verify you're still aligned with the objective
- **Every 15-20 actions**: call `self_assess` for a comprehensive health check (drift + cost + errors + velocity)
- **Before dangerous operations** (force push, delete, deploy): call `check_guardrail` to pre-check
- **When unsure about direction**: call `get_objective` to re-read the original task
- **When making a significant decision**: call `log_event` with type "decision" to document your reasoning
- **If you encounter repeated errors**: call `get_error_summary` to spot patterns, then call `memory_diff` to check if a previous agent already solved this
- **If self_assess returns high/critical risk**: call `auto_correct` to get concrete correction actions, then follow them
- **After any drift warning/critical**: call `get_correction` to check if the autocorrect engine has already intervened (rolled back files, blocked patterns). Follow any `agentInstructions` immediately.
- **If things go completely wrong**: call `trigger_incident` to freeze the session and create a snapshot for human review
- **Periodically**: call `check_cost` to stay budget-aware
- **At session end**: call `post_mortem` for a structured debrief
