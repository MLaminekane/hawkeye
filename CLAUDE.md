# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Hawkeye is an open-source observability and control layer for AI agents.

Core product pillars:
- session recording and replay
- drift detection
- guardrails / live firewall
- task daemon + dashboard
- live agent spawning / swarm orchestration
- memory diff / RCA / autocorrect

The repo is large, but the architecture is straightforward once you split it by package.

## Repo Map

- `packages/core`
  Node/TypeScript SDK: recorder, interceptors, drift engine, SQLite storage, RCA, memory diff, swarm types/config.
- `packages/cli`
  Main product runtime: CLI commands, daemon, `serve`, hooks, MCP server, desktop automation, reports.
- `packages/dashboard`
  React + Vite dashboard served by `hawkeye serve`.
- `packages/vscode-extension`
  Local VS Code bridge used by desktop automation.

## Most Important Files

- `packages/cli/src/commands/serve.ts`
  Dashboard API server, live agent spawning, websockets, a lot of product behavior lives here.
- `packages/cli/src/commands/daemon.ts`
  Remote task runner, journal, prompt enrichment, task execution.
- `packages/cli/src/commands/agent-command.ts`
  Central place that maps logical runtimes to actual CLI invocations.
- `packages/cli/src/config.ts`
  Unified config loading/saving and provider model lists.
- `packages/cli/src/interactive.ts`
  TUI entrypoint. Large file, but it is the home of slash commands and menus.
- `packages/core/src/storage/sqlite.ts`
  SQLite storage layer. If data looks wrong, start here.
- `packages/core/src/types.ts`
  Shared types across packages.
- `packages/dashboard/src/pages/TasksPage.tsx`
  Remote tasks UI.
- `packages/dashboard/src/pages/SwarmPage.tsx`
  Live agents / control room UI.
- `packages/dashboard/src/pages/SessionDetailPage.tsx`
  Replay / timeline / analysis view.

## How The System Fits Together

Normal event flow:

1. Interceptors or hooks capture actions.
2. Guardrails evaluate synchronously for risky actions.
3. Events are persisted to SQLite in `.hawkeye/traces.db`.
4. Drift snapshots and derived analyses are computed on top.
5. `hawkeye serve` exposes REST + WebSocket APIs for the dashboard.

Important distinction:

- `Tasks` go through `packages/cli/src/commands/daemon.ts`
- live `Agents` on the dashboard go through `packages/cli/src/commands/serve.ts`

If one works and the other does not, compare those two execution paths first.

## Non-Obvious Runtime Details

### Claude Code hooks

`NODE_OPTIONS` preload does not work with Claude Code's bundled runtime.
For Claude Code, Hawkeye relies on hooks via `.claude/settings.json`.

The Stop hook updates drift but does not mean the session is over.

### Tasks vs live agents

- Tasks are queued in `.hawkeye/tasks.json`
- the daemon executes them
- live agents are tracked in `.hawkeye/agents.json`
- the server spawns and monitors them directly

### Claude runtime gotcha

Plain `claude` inherits the current Claude Code model selection.
If Claude Code is currently set to a heavier model or context tier, Hawkeye launches may inherit that behavior unless a model is forced explicitly.

### Server reload

`hawkeye serve` auto-reloads after a successful CLI build.
Dashboard static files are read from disk per request.

## Useful Commands

```bash
pnpm install
pnpm build
pnpm test

pnpm --filter hawkeye-ai build
pnpm --filter hawkeye-ai test
pnpm --filter @hawkeye/dashboard build
pnpm --filter @hawkeye/dashboard test
```

For local CLI testing:

```bash
cd packages/cli
npm link
pnpm build
hawkeye
```

## Working Rules

- Prefer small, focused fixes over wide rewrites.
- When changing behavior shared by `Tasks` and `Agents`, check both code paths.
- Preserve user changes in the worktree; do not reset unrelated edits.
- Use existing helper modules when possible instead of re-embedding logic into page components.
- Add tests when changing execution routing, prompt shaping, provider selection, or status logic.

## Config

Primary config file:

- `.hawkeye/config.json`

Important module:

- `packages/cli/src/config.ts`

Config covers:
- drift settings
- guardrails
- API keys
- webhooks
- autocorrect

Saved API keys may be injected into child processes. Be careful not to let subscription-based runtimes accidentally inherit API-key auth when that changes behavior.

## Database

Storage is SQLite via `better-sqlite3`.

Main local state:
- `.hawkeye/traces.db`
- `.hawkeye/tasks.json`
- `.hawkeye/agents.json`
- `.hawkeye/task-journal.md`

When debugging product behavior:
- session data wrong -> inspect `sqlite.ts`
- queued task behavior wrong -> inspect `daemon.ts`
- live agent behavior wrong -> inspect `serve.ts`

## Dashboard Notes

The dashboard uses React + Vite + Tailwind + Recharts.

When editing dashboard pages:
- keep components readable
- move pure logic to helper modules when the page starts becoming too dense
- avoid hardcoded dark-only visuals; the app has a light theme too
- large outputs in cards should scroll internally, not deform the layout

## Security / Guardrails

Guardrails can block:
- file edits
- commands
- cost overruns
- token overruns
- out-of-scope directories
- risky network targets
- actions requiring review

If a change affects guardrails, review both:
- hook-time enforcement
- dashboard/API rendering of the resulting events

## High-Value Areas To Be Careful In

- `serve.ts`
  Large blast radius; many product surfaces depend on it.
- `interactive.ts`
  Big file, easy to regress TUI behavior.
- `sqlite.ts`
  Migration or schema mistakes can break many features at once.
- `SwarmPage.tsx`, `TasksPage.tsx`, `SettingsPage.tsx`
  UX-heavy pages that can become hard to maintain if logic drifts back into the component.

## When In Doubt

- Read the package-local code instead of trusting this file.
- Prefer actual source of truth over documentation.
- If behavior differs between CLI, Tasks, and Agents, reproduce the exact path rather than assuming the bug is shared.
