<p align="center">
<pre>
   ██╗  ██╗
   ██║  ██║
   ███████║  Hawkeye
   ██╔══██║  The flight recorder for AI agents
   ██║  ██║
   ╚═╝  ╚═╝
</pre>
</p>

<h1 align="center">Hawkeye</h1>

<p align="center">
  <strong>The flight recorder for AI agents</strong><br/>
  <sub>Open-source observability, guardrails, and post-mortems for Claude Code, Codex, Cline, and custom agent CLIs.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hawkeye-ai"><img src="https://img.shields.io/npm/v/hawkeye-ai?color=ff5f1f&label=npm" alt="npm version"></a>
  <a href="https://github.com/MLaminekane/hawkeye/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <a href="https://github.com/MLaminekane/hawkeye"><img src="https://img.shields.io/github/stars/MLaminekane/hawkeye?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#why-try-hawkeye">Why</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#what-you-get">What You Get</a> •
  <a href="#core-workflows">Workflows</a> •
  <a href="#dashboard">Dashboard</a> •
  <a href="#cli-essentials">CLI</a> •
  <a href="#configuration">Config</a> •
  <a href="#development">Development</a>
</p>

---

## Why try Hawkeye?

Most agent tooling helps you launch an agent.
Hawkeye helps you answer what happened after it started drifting, overspending, touching the wrong files, or failing in a way nobody can explain.

Use it when you want to:

- record exactly what an agent did across terminal, files, network, and LLM calls
- replay a bad run instead of guessing
- detect objective drift before a session goes off the rails
- enforce guardrails around files, commands, directories, cost, and review gates
- compare runs, inspect memory, and generate useful post-mortems
- monitor live tasks, spawned agents, and multi-agent work in one place

Hawkeye is especially useful once your workflow stops being "one CLI prompt in one terminal" and becomes "multiple agents, long-running sessions, real cost, real risk".

## Quick Start

### Install

```bash
npm install -g hawkeye-ai
```

Or run without installing:

```bash
npx hawkeye-ai
```

Homebrew is also supported:

```bash
brew install MLaminekane/hawkeye/hawkeye-ai
```

### First 5 minutes

```bash
# 1. Initialize Hawkeye in your repo
hawkeye init

# 2. If you use Claude Code, install hooks once
hawkeye hooks install

# 3. Launch the interactive TUI
hawkeye

# 4. Or record a session directly
hawkeye record -o "review the auth flow" -- codex

# 5. Open the dashboard
hawkeye serve
```

Then try one of these:

1. Start a `Claude Code` session and let the hooks auto-record it.
2. Launch a `Codex` or `Cline` run with `hawkeye record`.
3. Open the dashboard and inspect `Sessions`, `Compare`, `Firewall`, and `Tasks`.

## What you get

After one recorded run, Hawkeye gives you:

- a session timeline with commands, file reads/writes, LLM requests, tokens, and cost
- a replayable history with drift score and risk signals
- file-level and cost-level insight into what changed
- analysis tools for "why did this fail?" instead of "I think it probably..."
- a dashboard you can actually use while an agent is running, not just after the fact

The product idea is simple:

> If an agent touched your repo, spent money, or got weird, you should be able to inspect it like a real system.

## Core Workflows

### 1. Record any agent CLI

Wrap a command with `hawkeye record`:

```bash
hawkeye record -o "refactor session detail page" -- codex
hawkeye record -o "audit the settings page" -- cline
hawkeye record -o "review this repo" -- my-custom-agent --arg value
```

Hawkeye records:

- terminal commands and exit codes
- file operations
- network and LLM activity
- tokens and cost when available
- session metadata and timing

### 2. Use Claude Code with hooks

Claude Code works best with Hawkeye through hooks:

```bash
hawkeye hooks install
hawkeye
```

From the TUI:

- use `/new`
- choose `Claude Code`
- enter an objective
- run `claude` in your terminal

Hawkeye will link the Claude session automatically and record actions through the installed hooks.

Useful commands:

```bash
hawkeye hooks install
hawkeye hooks install --guardrails-only
hawkeye hooks status
hawkeye hooks uninstall
```

### 3. Monitor tasks and agents

Hawkeye is not just a recorder.
It can also drive work:

- `Tasks` for prompt submission and remote execution
- `Agents` for live spawned agents, follow-ups, relaunch, and cost tracking
- `Swarm` for multi-agent orchestration and coordination

This is where Hawkeye starts feeling less like "logging" and more like an operations layer for agent work.

### 4. Catch drift and enforce guardrails

Hawkeye can score how aligned a run still is with its goal and stop or warn when it starts going wrong.

Built-in guardrail categories include:

- file protection
- command blocking
- directory scope
- cost limits
- token limits
- network lock
- review gates

You can manage guardrails from the dashboard or from policy files.

### 5. Compare, replay, analyze

The most valuable moment often comes after a bad run:

- `Compare` shows multiple sessions side by side
- `Replay` helps inspect what happened step by step
- `Analyze` gives a root-cause style summary
- `Memory` shows what the agent retained or hallucinated across runs

## Dashboard

Launch it with:

```bash
hawkeye serve
```

Default URL:

```text
http://localhost:4242
```

Main pages:

- `Sessions` - browse recent runs, inspect durations, costs, drift, and current activity
- `Session Detail` - deep timeline, changed files, cost breakdown, replay, export
- `Compare` - compare runs visually across cost, actions, tokens, duration, drift
- `Firewall` - watch live actions, blocks, reviews, and impact previews
- `Tasks` - queue prompts, retry failures, stream output, and monitor daemon work
- `Agents` - spawn and steer agents live, review outputs, relaunch failures
- `Swarm` - coordinate multi-agent work and see dependencies/conflicts
- `Memory` - inspect what an agent appears to remember across sessions
- `Settings` - configure providers, keys, guardrails, webhooks, autocorrect, and local runtimes

## CLI Essentials

Run `hawkeye` with no subcommand to open the interactive TUI.
The TUI includes a slash-command picker with arrow navigation and search.

Useful commands:

| Command | What it does |
| --- | --- |
| `hawkeye` | Open the interactive TUI |
| `hawkeye init` | Initialize `.hawkeye/` in the current repo |
| `hawkeye record -o "..." -- <command>` | Record a new run around any agent command |
| `hawkeye serve` | Start the dashboard |
| `hawkeye daemon` | Run the task daemon |
| `hawkeye hooks install` | Install Claude Code hooks |
| `hawkeye analyze <session-id>` | Generate a root-cause style analysis |
| `hawkeye replay <session-id>` | Replay a session |
| `hawkeye compare <id1> <id2>` | Compare runs |
| `hawkeye report` | Generate a morning report |
| `hawkeye ci --pr 42` | Post a session report to a GitHub PR |
| `hawkeye mcp` | Start the MCP server |

Inside the TUI, the most useful slash commands are:

- `/new`
- `/attach`
- `/sessions`
- `/inspect`
- `/compare`
- `/firewall`
- `/tasks`
- `/swarm`
- `/settings`
- `/watch`

## Agent Support

Hawkeye currently fits best with:

- `Claude Code` via hooks
- `Codex`
- `Cline`
- any custom command you want to wrap with `hawkeye record`

The product is designed to stay useful even when the underlying agent changes.
The point is observability and control, not lock-in to a single runtime.

## Tasks, Agents, and Swarm

### Tasks

Queue a prompt and let the daemon execute it:

```bash
hawkeye daemon
hawkeye serve
```

Then submit tasks from the dashboard.

Good for:

- running prompts from your phone
- retrying failed jobs
- reviewing output after completion
- monitoring long-running work from one place

### Agents

Spawn a live agent from the dashboard and keep control over:

- role
- runtime
- permissions
- cost
- drift
- follow-up instructions

### Swarm

Swarm is for multi-agent work where a single run is not enough.

Typical use cases:

- parallelize a big refactor
- split review vs implementation
- isolate work in separate worktrees
- coordinate merge order and detect conflicts early

## DriftDetect

DriftDetect scores whether an agent still looks aligned with its stated objective.

It combines:

- local heuristics
- provider/model-based scoring
- configurable thresholds
- optional auto-pause behavior

You can configure:

- provider
- model
- check frequency
- context window
- warning threshold
- critical threshold
- auto-pause

Local backends are supported:

- `Ollama`
- `LM Studio`

## Guardrails and Policy

Hawkeye supports both dashboard editing and policy-file workflows.

You can manage rules for:

- protected files
- dangerous commands
- cost ceilings
- token ceilings
- directory scope
- network restrictions
- review gates

Example policy flow:

```bash
hawkeye policy init
hawkeye policy show
hawkeye policy check
```

## MCP Server

Start the MCP server over stdio:

```bash
hawkeye mcp
```

This lets MCP-aware agents query Hawkeye for session awareness, memory, and operational context.

Useful when you want agents to become aware of:

- current session state
- correction hints
- memory snapshots
- previous failures
- drift or guardrail signals

## CI and Reports

Hawkeye can report AI-generated work back to GitHub PRs.

Example:

```bash
hawkeye ci --pr 42
```

It can post:

- a Check Run
- a PR comment
- risk, drift, cost, and session summaries
- replay links back to the dashboard

There is also a reusable GitHub Action in this repo for CI workflows.

## Configuration

Hawkeye stores project config under:

```text
.hawkeye/config.json
```

Main config areas:

- `drift`
- `guardrails`
- `apiKeys`
- `webhooks`
- `autocorrect`
- `recording`
- `dashboard`

You can configure local providers for `Ollama` and `LM Studio`, plus API-backed providers like `OpenAI`, `Anthropic`, and `DeepSeek`.

## Architecture

This repo is a monorepo:

```text
packages/
├── cli/         CLI, daemon, server, hooks, MCP integration
├── core/        recorder, interceptors, drift engine, storage
└── dashboard/   React dashboard
```

High-level flow:

```text
Agent command
  -> Hawkeye recorder / hooks
  -> interceptors + storage
  -> drift + guardrails
  -> dashboard / replay / compare / reports
```

## Development

From source:

```bash
git clone https://github.com/MLaminekane/hawkeye.git
cd hawkeye
pnpm install
pnpm build
```

Useful commands:

```bash
pnpm dev
pnpm build
pnpm test
pnpm --filter hawkeye-ai build
pnpm --filter @hawkeye/dashboard build
```

Requirements:

- Node.js 20+
- pnpm

## Why Hawkeye feels different

A lot of agent tooling stops at "launch a model and hope for the best."

Hawkeye is more opinionated:

- it assumes agent work should be inspectable
- it treats cost and drift as first-class signals
- it gives you guardrails before damage, not just logs after damage
- it works across CLI, dashboard, tasks, agents, and swarm instead of leaving those as separate tools

If you are already serious enough about agents to care about reliability, cost, and auditability, Hawkeye is worth trying.

## License

MIT
