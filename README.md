<h1 align="center">Hawkeye</h1>

<p align="center">
  <strong>The flight recorder for AI agents</strong><br/>
  <sub>Open-source observability & security for Claude Code · Aider · AutoGPT · CrewAI · Open Interpreter · any LLM-powered agent</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hawkeye-ai"><img src="https://img.shields.io/npm/v/hawkeye-ai?color=ff5f1f&label=npm" alt="npm version"></a>
  <a href="https://github.com/MLaminekane/hawkeye/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <a href="https://github.com/MLaminekane/hawkeye"><img src="https://img.shields.io/github/stars/MLaminekane/hawkeye?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#installation">Install</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#cli-commands">CLI</a> •
  <a href="#dashboard">Dashboard</a> •
  <a href="#driftdetect">DriftDetect</a> •
  <a href="#guardrails">Guardrails</a> •
  <a href="#security">Security</a> •
  <a href="#architecture">Architecture</a>
</p>

---

## What is Hawkeye?

Hawkeye is a **flight recorder** for AI agents. It captures every action an agent performs — terminal commands, file operations, LLM calls, API requests — and provides:

- **Session recording & replay** — Full timeline of every agent action with costs and metadata
- **DriftDetect** — Real-time objective drift detection using heuristic + LLM scoring
- **Guardrails** — File protection, command blocking, cost limits, token limits, directory scoping
- **Impact Preview** — Pre-execution risk analysis for every agent action (low/medium/high/critical)
- **Live Firewall** — Real-time action stream with browser push notifications and badge counter
- **Policy Engine** — Declarative `.hawkeye/policies.yml` for shareable, team-wide security rules
- **Visual dashboard** — Mobile-responsive web UI with session explorer, drift charts, firewall, and settings management
- **Remote tasks** — Submit prompts from your phone via dashboard, with image attachments, auto-approve, and persistent agent memory
- **Interactive TUI** — Terminal-responsive CLI with arrow-key navigation and slash commands
- **OpenTelemetry export** — Push traces to Grafana Tempo, Jaeger, Datadog, Honeycomb
- **Universal ingestion API** — Accept events from any source (MCP servers, custom tools)
- **Multi-agent support** — Claude Code (hooks), Aider, Open Interpreter, AutoGPT, CrewAI, or any custom command

## Installation

### npm (recommended)

```bash
npm install -g hawkeye-ai
```

### npx (no install)

```bash
npx hawkeye-ai
```

### Homebrew (macOS/Linux)

```bash
brew install MLaminekane/hawkeye/hawkeye-ai
```

### Vercel Agent Skill

Install as a skill for any AI coding agent (Claude Code, Cursor, Gemini CLI, GitHub Copilot, and 30+ more):

```bash
npx skills add MLaminekane/hawkeye
```

### From source

```bash
git clone https://github.com/MLaminekane/hawkeye.git
cd hawkeye
pnpm install && pnpm build
cd packages/cli && npm link
```

## Quick Start

```bash
# Initialize in your project
hawkeye init

# Record an agent session
hawkeye record -o "Build a REST API" -- claude chat

# Or launch the interactive TUI
hawkeye
```

## Features

### Session Recording

Wrap any LLM-powered agent with `hawkeye record` to capture everything:

```bash
hawkeye record -o "Refactor auth module" -- claude chat
hawkeye record -o "Fix bug #42" --agent cursor -- cursor .
hawkeye record -o "Deploy to staging" --no-drift -- node deploy.js
```

Hawkeye automatically detects the agent (Claude Code, Aider, AutoGPT, CrewAI, Open Interpreter) and intercepts:

| Interceptor    | What it captures                                       |
| -------------- | ------------------------------------------------------ |
| **Terminal**   | Commands executed, exit codes, stdout/stderr           |
| **Filesystem** | File reads, writes, deletes, renames                   |
| **Network**    | HTTP requests, LLM API calls with token counts & costs |

### Claude Code Hooks

For agents with bundled Node.js runtimes (where `NODE_OPTIONS` injection doesn't work), Hawkeye integrates via **Claude Code hooks**:

```bash
hawkeye hooks install           # Install PreToolUse + PostToolUse hooks
hawkeye hooks install --guardrails-only  # Only install guardrail enforcement
hawkeye hooks status            # Check installation
hawkeye hooks uninstall         # Remove hooks
```

Hooks provide:

- **PreToolUse** — Guardrails enforcement (exit code 2 blocks the action)
- **PostToolUse** — Event recording to SQLite
- **Stop** — Drift score update (fires after every response, does not end session)
- Sessions auto-created per `session_id`

### Interactive TUI

Launch the interactive mode by running `hawkeye` with no subcommand:

```
   ██╗  ██╗
   ██║  ██║
   ███████║  Hawkeye v0.1.0
   ██╔══██║  The flight recorder for AI agents
   ██║  ██║  /Users/you/project
   ╚═╝  ╚═╝

  ● Recording: "Build REST API" (5m 23s)

  › /
```

Type `/` to open the command picker with arrow-key navigation and live filtering:

| Command        | Description                                    |
| -------------- | ---------------------------------------------- |
| `/new`         | New session — pick agent, model, objective     |
| `/sessions`    | List & manage recorded sessions                |
| `/active`      | Show current recording                         |
| `/stats`       | Session statistics                             |
| `/end`         | End active sessions                            |
| `/restart`     | Restart a session (with picker)                |
| `/delete`      | Delete a session                               |
| `/tasks`       | List, create, clear remote tasks               |
| `/tasks journal` | View agent memory (task history)             |
| `/firewall`    | View recent interceptions and blocked actions  |
| `/policy`      | Manage declarative security policies           |
| `/arena`       | Agent Arena — pit agents against each other     |
| `/overnight`   | Run overnight mode (guardrails + morning report)|
| `/report`      | Generate morning report of recent sessions     |
| `/remote`      | Launch serve + daemon + Cloudflare tunnel      |
| `/remote stop` | Stop tunnel + daemon                           |
| `/settings`    | Configure DriftDetect, Guardrails, API keys    |
| `/serve`       | Open the web dashboard                         |
| `/mcp`         | Show MCP server setup instructions             |
| `/revert`      | Revert file changes from a session             |
| `/init`        | Initialize Hawkeye                             |
| `/clear`       | Clear screen                                   |
| `/quit`        | Exit                                           |

## CLI Commands

### `hawkeye init`

Initialize Hawkeye in the current directory. Creates `.hawkeye/` directory and config files.

### `hawkeye record`

```bash
hawkeye record -o <objective> [options] -- <command...>
```

| Option            | Description                             |
| ----------------- | --------------------------------------- |
| `-o, --objective` | Session objective **(required)**        |
| `-a, --agent`     | Agent name (auto-detected from command) |
| `-m, --model`     | Model name                              |
| `--no-drift`      | Disable DriftDetect                     |
| `--no-guardrails` | Disable guardrails                      |

### `hawkeye sessions`

```bash
hawkeye sessions [-n 10] [-s recording|completed|aborted]
```

### `hawkeye stats <session-id>`

Display statistics for a session (accepts ID prefix).

### `hawkeye replay <session-id>`

```bash
hawkeye replay <session-id> [--speed 2] [--no-delay]
```

Replay a session action-by-action with timing.

### `hawkeye serve`

```bash
hawkeye serve [-p 4242]
```

Launch the web dashboard on `http://localhost:4242`. Auto-reloads after `pnpm build` — watches `dist/` and restarts the server when compiled files change.

### `hawkeye daemon`

```bash
hawkeye daemon [--agent claude] [--interval 30]
```

Run the task daemon — polls `.hawkeye/tasks.json` for pending tasks and executes them. Features:

- **Persistent memory**: writes a task journal (`.hawkeye/task-journal.md`) after each task
- **Conversation continuity**: uses `claude --continue` within 30-min windows
- **Context injection**: enriches prompts with git status, recent commits, and task history
- Works with any agent CLI, not just Claude

### `hawkeye arena`

```bash
hawkeye arena -t "Add user auth with JWT" -a claude,aider
hawkeye arena -t "Fix lint errors" -a claude,codex --test "npm test"
hawkeye arena --list
```

Agent Arena — pit multiple AI agents against the same task in isolated git worktrees:

- Each agent gets its own branch and worktree (no conflicts)
- All agents run in parallel with live terminal progress
- Optional test validation (`--test "npm test"`)
- Composite scoring: tests (50pts), speed (20pts), efficiency (15pts), focus (10pts), completion (5pts)
- Results saved and viewable in the dashboard at `/arena`

| Option         | Description                                | Default  |
| -------------- | ------------------------------------------ | -------- |
| `-t, --task`   | The task for agents to complete            | required |
| `-a, --agents` | Comma-separated agent list                 | required |
| `--test`       | Test command to validate results           |          |
| `--timeout`    | Timeout per agent in seconds               | `1800`   |
| `--list`       | List past arena results                    |          |

### `hawkeye overnight`

```bash
hawkeye overnight [--budget 5] [--agent claude] [--task "prompt"] [--tunnel] [--port 4242] [--report-llm]
```

Run overnight mode — composes serve + daemon with strict guardrails for unattended agent runs:

- **Auto-applies guardrails**: cost limit (from `--budget`), file protection for secrets, command blocking, auto-pause on critical drift
- **Backs up config** before modifying and restores on shutdown
- **Optional tunnel**: `--tunnel` starts a Cloudflare tunnel for remote monitoring
- **Optional task**: `--task "..."` queues an initial task for the daemon
- **Morning report on Ctrl+C**: generates consolidated report of all sessions, fires `overnight_report` webhook

| Option          | Description                               | Default  |
| --------------- | ----------------------------------------- | -------- |
| `--budget`      | Maximum cost budget in USD                | `5`      |
| `--agent`       | Agent CLI command                         | `claude` |
| `--task`        | Submit initial task to daemon queue       |          |
| `--tunnel`      | Enable Cloudflare tunnel for remote access|          |
| `--port`        | Dashboard port                            | `4242`   |
| `--report-llm`  | Run LLM post-mortem per session on shutdown|         |

### `hawkeye report`

```bash
hawkeye report [--since <iso>] [--json] [--llm] [--webhook]
```

Generate a morning report of recent sessions. Aggregates stats, drift, errors, and cost per session.

| Option      | Description                                                    | Default                              |
| ----------- | -------------------------------------------------------------- | ------------------------------------ |
| `--since`   | Report on sessions since this ISO timestamp                    | `overnight.json` startedAt or 8h ago |
| `--json`    | Output as JSON                                                 |                                      |
| `--llm`     | Include LLM-powered post-mortem per session                    |                                      |
| `--webhook` | Fire `overnight_report` webhook with the report                |                                      |

### `hawkeye policy`

```bash
hawkeye policy init [--force]      # Generate default policies.yml (or convert existing guardrails)
hawkeye policy check               # Validate policies.yml
hawkeye policy show                # Display current policies
hawkeye policy export [-o file]    # Export guardrails as YAML
hawkeye policy import <file>       # Import a policies.yml
```

Declarative security policies in `.hawkeye/policies.yml` — shareable across projects and teams. The hook-handler automatically loads and merges policy rules with config.json guardrails.

### `hawkeye export`

```bash
hawkeye export <session-id> [-f json|html] [-o report.html]
```

### `hawkeye end`

```bash
hawkeye end [-s <session-id>] [--all] [--status completed|aborted]
```

### `hawkeye restart`

```bash
hawkeye restart [session-id] [-o <objective>] [-a <agent>] [-m <model>]
```

Restart a session — inherits objective, agent, and model from the original if not overridden. Interactive picker when no ID is given.

### `hawkeye otel-export`

```bash
hawkeye otel-export <session-id> [-o traces.json]
hawkeye otel-export <session-id> --endpoint https://tempo.example.com/v1/traces
```

Export as OTLP JSON traces. Compatible with Grafana Tempo, Jaeger, Datadog, Honeycomb.

### `hawkeye hooks`

```bash
hawkeye hooks install [--local] [--guardrails-only]
hawkeye hooks uninstall [--local]
hawkeye hooks status
```

### `hawkeye mcp`

Start the MCP (Model Context Protocol) server over stdio. Agents connect automatically.

```bash
hawkeye mcp [--db <path>]
```

Add to `.mcp.json` at project root for Claude Code:

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

**27 tools** for agent self-awareness:

| Category | Tools |
|----------|-------|
| **Observability** (9) | `list_sessions`, `get_session`, `get_session_events`, `get_session_drift`, `get_session_stats`, `get_global_stats`, `compare_sessions`, `get_violations`, `get_cost_by_file` |
| **Self-awareness** (8) | `check_drift`, `get_objective`, `check_cost`, `check_guardrail`, `check_progress`, `log_event`, `list_changes`, `get_config` |
| **Intelligence** (4) | `get_session_timeline`, `get_error_summary`, `suggest_correction`, `post_mortem` |
| **Actions** (4) | `end_session`, `pause_session`, `resume_session`, `set_objective` |
| **Cross-session** (2) | `search_events`, `revert_file` |

## Dashboard

The web dashboard (`hawkeye serve`) is fully **mobile responsive** and provides:

### Sessions Page

- List all sessions with status filtering (recording / completed / aborted)
- Search by objective or agent name
- Auto-refresh every 5 seconds, module-level cache (no flash on page change)
- Shows costs, drift scores, action counts

### Session Detail Page

- **Drift score chart** — Line chart with warning/critical reference zones
- **Event timeline** — Filterable, searchable list with type badges (CMD, FILE, LLM, GUARD, etc.)
- **Expandable details** — Full event payload for each action
- **Live mode** — Auto-refreshes every 3 seconds for active sessions
- **Export** — Download session as JSON

### Tasks Page (Remote)

- Submit prompts remotely from your phone
- **Image attachments** — Upload photos to include with prompts
- **Auto-approve toggle** — Automatically approve all guardrail-blocked actions
- **Approve/Deny buttons** — Manually review dangerous actions
- **Agent memory** — View/clear the persistent task journal
- Status tracking: pending, running, completed, failed

### Compare Page

- Select two sessions to compare side by side
- Stats comparison (actions, cost, tokens, drift)

### Firewall Page

- **Live action stream** — Every agent action in real-time with risk classification
- **Filters** — All / Risky Only / Blocked / Writes / Commands
- **Browser notifications** — Push alerts when actions are blocked or critical
- **Navbar badge** — Red counter for high/critical actions

### Settings Page

- Configure DriftDetect (provider, model, thresholds, check frequency)
- Manage guardrail rules (enable/disable, toggle warn/block)
- **Policy Engine** — Initialize, edit, and manage `.hawkeye/policies.yml` with full CRUD for rules
- Provider model selection with live lookup

### REST API

| Endpoint                          | Method | Description                      |
| --------------------------------- | ------ | -------------------------------- |
| `/api/sessions`                   | GET    | List sessions                    |
| `/api/sessions/:id`               | GET    | Session details                  |
| `/api/sessions/:id/events`        | GET    | Session events                   |
| `/api/sessions/:id/drift`         | GET    | Drift snapshots                  |
| `/api/sessions/:id/cost-by-file`  | GET    | Cost breakdown by file           |
| `/api/sessions/:id/end`           | POST   | End a session                    |
| `/api/sessions/:id/pause`         | POST   | Pause a session                  |
| `/api/sessions/:id/resume`        | POST   | Resume a paused session          |
| `/api/compare?ids=id1,id2`        | GET    | Compare sessions side by side    |
| `/api/stats`                      | GET    | Global statistics                |
| `/api/settings`                   | GET    | Get configuration                |
| `/api/settings`                   | POST   | Save configuration (Zod-validated) |
| `/api/providers`                  | GET    | Available LLM providers & models |
| `/api/ingest`                     | POST   | Universal event ingestion (Zod-validated) |
| `/api/revert`                     | POST   | Revert a file change             |
| `/api/tasks`                      | GET    | List remote tasks                |
| `/api/tasks`                      | POST   | Create a task (with attachments) |
| `/api/tasks/:id/cancel`           | POST   | Cancel a pending task            |
| `/api/tasks/journal`              | GET    | Read agent memory journal        |
| `/api/tasks/journal/clear`        | POST   | Clear agent memory               |
| `/api/tasks/attachments/:file`    | GET    | Serve task image attachments     |
| `/api/arenas`                     | GET    | List arena results               |
| `/api/arenas/:id`                 | GET    | Get arena details & leaderboard  |
| `/api/pending-reviews`            | GET    | List pending review gate items   |
| `/api/review-approve`             | POST   | Approve a review gate item       |
| `/api/review-deny`                | POST   | Deny a review gate item          |
| `/api/policies`                   | GET    | Get current policies.yml         |
| `/api/policies`                   | POST   | Save policies (server-validated) |
| `/api/impact`                     | GET    | Last impact preview              |
| `/api/interceptions`              | GET    | Recent blocks + pending reviews  |

## DriftDetect

DriftDetect monitors agent behavior in real-time and assigns a **drift score** (0–100):

| Score  | Status      | Meaning                           |
| ------ | ----------- | --------------------------------- |
| 70–100 | ✅ OK       | Agent is on track                 |
| 40–69  | ⚠️ Warning  | Possible deviation from objective |
| 0–39   | 🔴 Critical | Significant drift detected        |

### Scoring Engines

**Heuristic scorer** (always active, zero-cost):

- Penalizes dangerous commands (`rm -rf`, `DROP TABLE`, `curl | bash`)
- Flags suspicious paths (`/etc`, `~/.ssh`, `/root`)
- Detects sensitive file extensions (`.pem`, `.key`, `.env`)
- Monitors error rates

**LLM scorer** (optional, configurable):

- Evaluates actions against the stated objective using an LLM
- Supports 6 providers:

| Provider  | Models                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------- |
| Ollama    | llama4, llama3.2, mistral, codellama, deepseek-coder, phi3                                           |
| Anthropic | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5, claude-sonnet-4-5, claude-opus-4-5             |
| OpenAI    | gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-5, gpt-5-mini, o3, o3-mini, o4-mini    |
| DeepSeek  | deepseek-chat, deepseek-reasoner                                                                     |
| Mistral   | mistral-large-latest, mistral-medium-latest, mistral-small-latest, codestral-latest, devstral-latest |
| Google    | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash                            |

## Guardrails

Guardrails are evaluated **synchronously before** events are persisted. Violations can `warn` (log only) or `block` (prevent the action).

| Rule Type         | Description                            | Config                                |
| ----------------- | -------------------------------------- | ------------------------------------- |
| `file_protect`    | Protect files/dirs from modification   | `paths: string[]` (glob patterns)     |
| `command_block`   | Block dangerous commands               | `patterns: string[]` (regex patterns) |
| `cost_limit`      | Limit spending per session/hour        | `maxUsdPerSession`, `maxUsdPerHour`   |
| `token_limit`     | Limit token consumption                | `maxTokensPerSession`                 |
| `directory_scope` | Restrict agent to specific directories | `allowedDirs`, `blockedDirs`          |
| `network_lock`    | Allow/block specific API hostnames     | `allowedHosts`, `blockedHosts`        |
| `review_gate`     | Require human approval for commands    | `patterns: string[]` (regex patterns) |
| `impact_threshold`| Block actions above a risk level       | `blockAbove`, `warnAbove` (low/medium/high/critical) |

### Impact Preview

Every agent action is analyzed **before execution** via the Impact Preview engine:

- Computes risk level (low/medium/high/critical) based on command patterns, file sensitivity, git status
- Shows affected files, lines, and git tracking status in the terminal
- Blocks critical-risk actions automatically (configurable via `impact_threshold` policy rule)
- Dashboard Firewall page shows all actions in real-time with browser push notifications

### Policy Engine

Declarative policies in `.hawkeye/policies.yml` are shareable, version-controllable, and team-wide:

```yaml
version: "1"
name: my-project
rules:
  - name: protect-secrets
    type: file_protect
    enabled: true
    action: block
    config:
      paths: [".env", "*.pem", "*.key"]
  - name: block-high-impact
    type: impact_threshold
    enabled: true
    action: block
    config:
      blockAbove: critical
      warnAbove: high
```

Manage via `hawkeye policy` CLI, dashboard Settings page, or direct YAML edit.

Example configuration (via `/settings` in TUI or dashboard):

```json
{
  "guardrails": [
    {
      "name": "Protect secrets",
      "type": "file_protect",
      "enabled": true,
      "action": "block",
      "config": { "paths": ["**/.env", "**/*.key", "**/*.pem"] }
    },
    {
      "name": "No destructive commands",
      "type": "command_block",
      "enabled": true,
      "action": "block",
      "config": { "patterns": ["rm\\s+-rf\\s+/", "DROP\\s+TABLE", "curl.*\\|.*bash"] }
    },
    {
      "name": "Budget limit",
      "type": "cost_limit",
      "enabled": true,
      "action": "warn",
      "config": { "maxUsdPerSession": 5.0, "maxUsdPerHour": 2.0 }
    }
  ]
}
```

## Configuration

Configuration is stored at `.hawkeye/config.json`:

```json
{
  "drift": {
    "enabled": true,
    "checkEvery": 5,
    "provider": "ollama",
    "model": "llama3.2",
    "warningThreshold": 60,
    "criticalThreshold": 30,
    "contextWindow": 10
  },
  "guardrails": [],
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-..."
  }
}
```

Manage settings via:

- **TUI**: `/settings` command with interactive sub-menus
- **Dashboard**: Settings page at `http://localhost:4242/settings`
- **Direct edit**: `.hawkeye/config.json`

## Security

Hawkeye is designed to run locally. The dashboard server binds to `localhost` and includes multiple security layers:

| Protection | Description |
|---|---|
| **CORS** | Only `localhost` / `127.0.0.1` origins accepted |
| **WebSocket origin check** | Upgrade requests from cross-origin pages are rejected |
| **POST body limit** | 5 MB max — oversized requests are destroyed (prevents DoS) |
| **Path traversal** | Static file serving and attachment endpoints verify resolved paths stay within their root |
| **No command injection** | All git operations use `execFile()` with argument arrays, never shell strings |
| **Config file permissions** | `.hawkeye/config.json` and `policies.yml` written with `0o600` (owner-only) to protect API keys |
| **Policy validation** | `POST /api/policies` validates schema before writing — rejects invalid rules |
| **Impact analysis** | Pre-execution risk scoring blocks critical actions before they run |
| **Concurrent write safety** | Hook handler uses exclusive lockfile for `hook-sessions.json` writes |

### API Keys

API keys for LLM providers (Anthropic, OpenAI, etc.) are stored in `.hawkeye/config.json`. The file is created with restricted permissions (`0o600`), but you should also add `.hawkeye/` to your global `.gitignore` to avoid accidental commits.

## Architecture

TypeScript monorepo using **pnpm workspaces** + **Turborepo**:

```
packages/
├── core/        Node.js SDK — recorder, interceptors, storage, DriftDetect, guardrails
├── cli/         CLI (Commander.js + chalk) — commands, interactive TUI
└── dashboard/   React 19 + Vite + Tailwind CSS + Recharts — web UI
```

### Data Flow

```
Agent ──► Interceptors ──► Recorder ──► Guardrails (sync) ──► SQLite
                                            │
                                            └──► DriftDetect (async)
```

### Network Interception

For child processes, Hawkeye injects a preload ESM script via `NODE_OPTIONS="--import ..."` that monkey-patches `http/https.request` and `globalThis.fetch`. It detects LLM API calls by hostname and path, parses SSE streaming responses, and sends captured events back to the parent via Node.js IPC.

### Storage

SQLite via `better-sqlite3` with WAL mode. Four tables:

| Table                  | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `sessions`             | Session metadata (objective, agent, status, timestamps)       |
| `events`               | Captured events (type, data, timestamps, token counts, costs) |
| `drift_snapshots`      | Drift score history per session                               |
| `guardrail_violations` | Guardrail violation log                                       |

## Development

```bash
pnpm install                           # Install all dependencies
pnpm build                             # Production build (all packages)
pnpm dev                               # Dev mode (Turborepo watch)
pnpm test                              # Run all tests (Vitest)
pnpm --filter @hawkeye/core test       # Run only core tests
pnpm --filter @hawkeye/cli build       # Build only CLI
```

### Requirements

- Node.js ≥ 20
- pnpm 9.x

### Tech Stack

| Package              | Stack                                  |
| -------------------- | -------------------------------------- |
| `@hawkeye/core`      | TypeScript, better-sqlite3, Vitest     |
| `@hawkeye/cli`       | TypeScript, Commander.js, chalk v5     |
| `@hawkeye/dashboard` | React 19, Vite, Tailwind CSS, Recharts |

### Code Conventions

- TypeScript strict mode, ES2022 target, ESM modules
- File names in kebab-case
- Named exports only (no default exports except React components)
- `Result<T, E>` pattern for error handling (no throwing in core)
- Prettier: semi, singleQuote, trailingComma: all, printWidth: 100

## Acknowledgments

Special thanks to **Lamine** for their contributions and support.

## License

MIT
