```text
   ██╗  ██╗
   ██║  ██║
   ███████║  Hawkeye
   ██╔══██║  The flight recorder for AI agents
   ██║  ██║
   ╚═╝  ╚═╝
```

# Hawkeye CLI

`hawkeye-ai` turns any coding agent into something you can actually observe, debug, and trust.

If Claude Code, Codex, Cline, or a custom agent goes off-script, Hawkeye shows you:

- what it did
- which files it touched
- what it cost
- where it started drifting
- which guardrail blocked it
- how to replay or inspect the failure

This package is the fastest way to try Hawkeye locally: install it, wrap one agent run, then open the dashboard and see the whole session.

## Why try Hawkeye?

Most agent workflows fail in annoying ways:

- the agent changed too many files and you do not know when it went wrong
- the model burned credits without making progress
- a dangerous command almost ran
- a failure happened 8 steps after the actual mistake
- you want to compare a good run with a bad one

Hawkeye is built for that exact moment.

It gives you:

- session recording with cost, token, and action tracking
- drift detection during the run
- guardrails and policy enforcement
- root-cause analysis after failures
- replay, comparison, exports, and dashboard visibility
- background automation through daemon, tasks, and MCP

If you want the full product overview and repo-level architecture, see the root README. This file stays focused on the CLI package and how to get value from it quickly.

## Install

### npm

```bash
npm install -g hawkeye-ai
```

### npx

```bash
npx hawkeye-ai
```

### Homebrew

```bash
brew install MLaminekane/hawkeye/hawkeye-ai
```

### From source

```bash
git clone https://github.com/MLaminekane/hawkeye.git
cd hawkeye
pnpm install
pnpm build
cd packages/cli
npm link
```

## Quick Start

Try it in under a minute:

```bash
hawkeye init
hawkeye record -o "Review this repo and suggest improvements" -- claude
hawkeye serve
```

Then open `http://localhost:4242`.

You will immediately get:

- the recorded session timeline
- files touched
- drift and cost tracking
- session stats and replay tools

If you mainly use Claude Code, install hooks once and Hawkeye can capture Claude Code sessions automatically:

```bash
hawkeye hooks install
```

If you prefer the terminal-first workflow, open the built-in TUI:

```bash
hawkeye
```

## The First 3 Workflows To Try

### 1. Record a session

Wrap any agent command with `hawkeye record`:

```bash
hawkeye record -o "Fix flaky tests" -- codex
hawkeye record -o "Review recent changes" -- claude
hawkeye record -o "Investigate bug 142" -- node ./scripts/agent.js
```

This is the fastest way to understand Hawkeye. One command gives you:

- terminal commands and exit codes
- file reads and writes
- LLM calls, token usage, and cost
- drift updates
- guardrail violations

### 2. Open the dashboard

```bash
hawkeye serve
```

The dashboard is where Hawkeye clicks for most people:

- sessions list
- session detail and replay
- compare view
- firewall
- tasks
- agents control room

It is the easiest way to feel the product value fast.

### 3. Inspect a real session

Once you have one recorded run, try:

```bash
hawkeye sessions
hawkeye inspect <session-id>
hawkeye analyze <session-id>
hawkeye replay <session-id>
```

That is usually the moment where Hawkeye stops feeling like “extra logging” and starts feeling like a debugger for agent behavior.

## Core Workflows

### Claude Code hooks

For Claude Code, Hawkeye integrates through hooks instead of `NODE_OPTIONS` injection:

```bash
hawkeye hooks install
hawkeye hooks install --guardrails-only
hawkeye hooks status
hawkeye hooks uninstall
```

Hooks enable:

- synchronous guardrail enforcement before tool use
- event capture after tool use
- automatic session creation for Claude Code sessions

### Inspect what happened

Common inspection commands:

```bash
hawkeye sessions
hawkeye stats
hawkeye inspect <session-id>
hawkeye analyze <session-id>
hawkeye compare <id-a> <id-b>
hawkeye replay <session-id>
```

Useful exports:

```bash
hawkeye export <session-id> -f json
hawkeye export <session-id> -f html -o report.html
hawkeye otel-export <session-id> -o traces.json
```

### Run the dashboard and automation

```bash
hawkeye serve
hawkeye daemon
hawkeye overnight --budget 5 --task "review the repo"
```

This is the setup to use if you want:

- remote task submission
- persistent task execution
- unattended guarded runs
- dashboard visibility while agents work

### Connect agents through MCP

```bash
hawkeye mcp
```

The MCP server exposes Hawkeye tools for session introspection, drift checks, memory analysis, and corrective workflows.

## Command Guide

### Main commands

| Command | Purpose |
| --- | --- |
| `hawkeye init` | Initialize `.hawkeye/` in the current project |
| `hawkeye record` | Record an agent session |
| `hawkeye hooks` | Install or manage Claude Code hooks |
| `hawkeye serve` | Start the dashboard |
| `hawkeye daemon` | Run the task daemon |
| `hawkeye mcp` | Start the MCP server |
| `hawkeye sessions` | List recorded sessions |
| `hawkeye inspect` | Show detailed session data |
| `hawkeye analyze` | Run root-cause analysis |
| `hawkeye compare` | Compare two or more sessions |
| `hawkeye replay` | Replay a session timeline |
| `hawkeye report` | Generate a recent session report |
| `hawkeye export` | Export a session report |
| `hawkeye policy` | Manage `.hawkeye/policies.yml` |
| `hawkeye autocorrect` | Configure autonomous correction |
| `hawkeye memory` | Compare or aggregate agent memory |
| `hawkeye ci` | Post a session report to GitHub PRs |
| `hawkeye overnight` | Run guarded unattended workflows |
| `hawkeye swarm` | Run multi-agent orchestration |
| `hawkeye restart` | Restart a session with inherited context |
| `hawkeye revert` | Revert file changes from a session |
| `hawkeye approve` | Approve pending review-gate actions |
| `hawkeye end` | End active recording sessions |
| `hawkeye stats` | Show stats for one session or globally |

### Interactive mode

Running `hawkeye` with no subcommand opens the terminal UI.

That mode is great if you want Hawkeye to feel more like a daily control surface than a long list of commands. It is the fastest way to:

- start a new session
- browse sessions
- launch the dashboard
- inspect stats
- manage settings and policies

## Key Commands

### `hawkeye record`

```bash
hawkeye record -o <objective> [options] -- <command...>
```

Common options:

| Option | Meaning |
| --- | --- |
| `-o, --objective` | Required session objective |
| `-a, --agent` | Override agent name |
| `-m, --model` | Override model name |
| `--no-drift` | Disable DriftDetect |
| `--no-guardrails` | Disable guardrails |

Good use cases:

- wrap a single risky run
- compare two agent strategies on the same task
- capture a bug reproduction or failed refactor
- audit what an agent actually did

### `hawkeye serve`

```bash
hawkeye serve [-p 4242]
```

Starts the dashboard locally, usually at `http://localhost:4242`.

Use this when you want visual monitoring, replay, compare, firewall, tasks, or agent orchestration.

### `hawkeye daemon`

```bash
hawkeye daemon [--agent claude] [--interval 30]
```

Runs the background task worker that processes queued dashboard tasks and maintains task memory.

Use this if you want Hawkeye to keep working even when the dashboard tab is closed.

### `hawkeye mcp`

```bash
hawkeye mcp [--db <path>]
```

Starts the Hawkeye MCP server over stdio.

Use this when you want agents to query Hawkeye directly for session stats, drift, memory, or historical context.

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "hawkeye": {
      "command": "hawkeye",
      "args": ["mcp"]
    }
  }
}
```

### `hawkeye policy`

```bash
hawkeye policy init
hawkeye policy check
hawkeye policy show
hawkeye policy export
hawkeye policy import <file>
```

Use this when you want declarative, shareable guardrail rules in `.hawkeye/policies.yml`.

## Who this is for

Hawkeye is a strong fit if you:

- run AI coding agents on real repos
- care about cost visibility
- want safer automation
- need post-mortems when runs go wrong
- want a shared observability layer across multiple agent runtimes

It is especially useful once you move beyond toy prompts and start trusting agents with actual code, CI, secrets, or long-running tasks.

### `hawkeye overnight`

```bash
hawkeye overnight [--budget 5] [--agent claude] [--task "prompt"] [--tunnel]
```

Useful for unattended runs with:

- budget enforcement
- stricter guardrails
- optional remote monitoring
- morning report generation on shutdown

## Configuration

Project config lives in:

```text
.hawkeye/config.json
```

Typical sections:

- `drift`
- `guardrails`
- `apiKeys`
- provider-specific settings such as LM Studio URL

You can manage config through:

- the TUI
- the dashboard Settings page
- direct file edits

## What this package includes

This package ships:

- the `hawkeye` executable
- the bundled dashboard assets used by `hawkeye serve`
- the CLI command set and interactive TUI

This is the package to install if you want to actually use Hawkeye, not just browse the repo.

## Development

From the repo root:

```bash
pnpm install
pnpm build
pnpm test
pnpm --filter hawkeye-ai build
pnpm --filter hawkeye-ai test
```

Requirements:

- Node.js 20+
- pnpm 9+

## Notes

- `packages/cli/README.md` is the package README for `hawkeye-ai`.
- The root README should stay product-level.
- This file should stay CLI-focused and avoid duplicating the entire repository handbook.

## License

MIT
