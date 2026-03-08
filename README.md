<p align="center">
  <pre align="center">
   ██╗  ██╗
   ██║  ██║
   ███████║  <b>Hawkeye</b>
   ██╔══██║  The flight recorder for AI agents
   ██║  ██║
   ╚═╝  ╚═╝
  </pre>
</p>

<p align="center">
  <strong>Open-source observability & security for AI agents</strong><br/>
  <em>Claude Code · Cursor · AutoGPT · CrewAI · Aider · any LLM-powered agent</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#cli-commands">CLI</a> •
  <a href="#dashboard">Dashboard</a> •
  <a href="#driftdetect">DriftDetect</a> •
  <a href="#guardrails">Guardrails</a> •
  <a href="#architecture">Architecture</a>
</p>

---

## What is Hawkeye?

Hawkeye is a **flight recorder** for AI agents. It captures every action an agent performs — terminal commands, file operations, LLM calls, API requests — and provides:

- **Session recording & replay** — Full timeline of every agent action with costs and metadata
- **DriftDetect** — Real-time objective drift detection using heuristic + LLM scoring
- **Guardrails** — File protection, command blocking, cost limits, token limits, directory scoping
- **Visual dashboard** — Web UI with session explorer, drift charts, and settings management
- **Interactive TUI** — Claude Code-style CLI with arrow-key navigation and slash commands
- **OpenTelemetry export** — Push traces to Grafana Tempo, Jaeger, Datadog, Honeycomb
- **Universal ingestion API** — Accept events from any source (MCP servers, custom tools)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

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

Hawkeye automatically detects the agent (Claude Code, Cursor, Copilot, AutoGPT, CrewAI, Aider) and intercepts:

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

| Command     | Description                                 |
| ----------- | ------------------------------------------- |
| `/sessions` | List & manage recorded sessions             |
| `/active`   | Show current recording                      |
| `/stats`    | Session statistics                          |
| `/end`      | End active sessions                         |
| `/restart`  | Restart a session (with picker)             |
| `/delete`   | Delete a session                            |
| `/settings` | Configure DriftDetect, Guardrails, API keys |
| `/serve`    | Open the web dashboard                      |
| `/init`     | Initialize Hawkeye                          |
| `/clear`    | Clear screen                                |
| `/quit`     | Exit                                        |

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

Launch the web dashboard on `http://localhost:4242`.

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

## Dashboard

The web dashboard (`hawkeye serve`) provides three views:

### Sessions Page

- List all sessions with status filtering (recording / completed / aborted)
- Search by objective or agent name
- Auto-refresh every 5 seconds
- Shows costs, drift scores, action counts

### Session Detail Page

- **Drift score chart** — Line chart with warning/critical reference zones
- **Event timeline** — Filterable, searchable list with type badges (CMD, FILE, LLM, GUARD, etc.)
- **Expandable details** — Full event payload for each action
- **Live mode** — Auto-refreshes every 3 seconds for active sessions
- **Export** — Download session as JSON

### Settings Page

- Configure DriftDetect (provider, model, thresholds, check frequency)
- Manage guardrail rules (enable/disable, toggle warn/block)
- Provider model selection with live lookup

### REST API

| Endpoint                   | Method | Description                      |
| -------------------------- | ------ | -------------------------------- |
| `/api/sessions`            | GET    | List sessions                    |
| `/api/sessions/:id`        | GET    | Session details                  |
| `/api/sessions/:id/events` | GET    | Session events                   |
| `/api/sessions/:id/drift`  | GET    | Drift snapshots                  |
| `/api/sessions/:id/end`    | POST   | End a session                    |
| `/api/settings`            | GET    | Get configuration                |
| `/api/settings`            | POST   | Save configuration               |
| `/api/providers`           | GET    | Available LLM providers & models |
| `/api/ingest`              | POST   | Universal event ingestion        |

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
