---
name: hawkeye
description: Use this skill to add observability, guardrails, and drift detection to AI agent sessions. Activate when the user wants to monitor agent actions, track costs/tokens, detect objective drift, enforce file protection or command blocking, replay past sessions, or generate post-mortem reports. Wraps the Hawkeye CLI and MCP server.
license: MIT
compatibility: Requires Node.js >= 20. Install via npm install -g hawkeye-ai or use npx hawkeye-ai.
metadata:
  author: "MLaminekane"
  version: "0.1.12"
  homepage: "https://github.com/MLaminekane/hawkeye"
---

# Hawkeye — The Flight Recorder for AI Agents

Hawkeye captures every action an AI agent performs (commands, file changes, LLM calls, API requests, git operations) and provides real-time observability, drift detection, guardrails, and session replay.

## When to Use This Skill

- User asks to **monitor**, **record**, or **observe** an AI agent session
- User wants **cost tracking** or **token budget limits**
- User wants to **protect files** or **block dangerous commands**
- User wants to **replay** or **inspect** what an agent did
- User asks about **drift detection** (is the agent still on-task?)
- User wants a **post-mortem** or **session summary**
- User wants to run an agent **overnight** with safety guardrails

## Setup

### Quick Setup (Claude Code)

```bash
# Install Hawkeye globally
npm install -g hawkeye-ai

# Initialize in the project
hawkeye init

# Install Claude Code hooks (captures every action automatically)
hawkeye hooks install
```

After `hawkeye hooks install`, every Claude Code action is automatically recorded. No further configuration needed.

You can also run the setup script:

```bash
bash "$skill_dir/scripts/setup.sh"
```

### MCP Server (Alternative)

For agents that support MCP, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "hawkeye": {
      "command": "npx",
      "args": ["-y", "hawkeye-ai", "mcp"]
    }
  }
}
```

This exposes 27 tools the agent can call for self-awareness (check drift, check cost, log decisions, etc.).

### Recording Other Agents

```bash
# Record any command-line agent
hawkeye record -o "Build a REST API" -- aider
hawkeye record -o "Refactor auth module" -- open-interpreter
hawkeye record -o "Deploy to prod" -- claude chat
```

## Core Commands

### Session Management

```bash
hawkeye sessions              # List all sessions
hawkeye sessions --active     # Show only active sessions
hawkeye inspect <session-id>  # Detailed session view (timeline, files, cost)
hawkeye stats                 # Aggregate stats across sessions
hawkeye compare <id1> <id2>   # Side-by-side session comparison
hawkeye end <session-id>      # End a recording session
```

### Observability

```bash
hawkeye replay <session-id>   # Replay session events in terminal
hawkeye export <session-id>   # Export session as JSON
hawkeye serve                 # Launch dashboard on http://localhost:4242
hawkeye report                # Morning report of recent sessions
hawkeye report --llm --json   # With LLM post-mortem, JSON output
hawkeye arena -t "task" -a claude,aider  # Agent Arena: compare agents head-to-head
hawkeye arena --list           # View past arena results
```

### Status Check

To check the current state of Hawkeye in a project:

```bash
bash "$skill_dir/scripts/status.sh"
```

This returns JSON with: hooks installed (yes/no), active sessions, total sessions, guardrail rules count, and config path.

## Guardrails Configuration

Edit `.hawkeye/config.json` to add guardrails:

### File Protection
```json
{
  "guardrails": [
    { "type": "file_protect", "pattern": ".env*", "action": "block" },
    { "type": "file_protect", "pattern": "*.pem", "action": "block" },
    { "type": "file_protect", "pattern": "package-lock.json", "action": "warn" }
  ]
}
```

### Command Blocking
```json
{
  "guardrails": [
    { "type": "command_block", "pattern": "rm -rf /", "action": "block" },
    { "type": "command_block", "pattern": "DROP TABLE", "action": "block" },
    { "type": "command_block", "pattern": "git push.*--force", "action": "block" }
  ]
}
```

### Cost & Token Limits
```json
{
  "guardrails": [
    { "type": "cost_limit", "maxCostPerSession": 5.00, "maxCostPerHour": 2.00, "action": "block" },
    { "type": "token_limit", "maxTokensPerSession": 500000, "action": "warn" }
  ]
}
```

### Directory Scoping
```json
{
  "guardrails": [
    { "type": "directory_scope", "allowedPaths": ["src/", "tests/", "docs/"], "action": "block" }
  ]
}
```

### Network Lock
```json
{
  "guardrails": [
    { "type": "network_lock", "allowed": ["api.anthropic.com", "api.openai.com"], "action": "block" }
  ]
}
```

### Review Gate (Human Approval)
```json
{
  "guardrails": [
    { "type": "review_gate", "pattern": "git push|rm -rf|docker", "action": "block" }
  ]
}
```

## DriftDetect Configuration

DriftDetect monitors whether the agent stays aligned with its objective.

```json
{
  "drift": {
    "enabled": true,
    "checkInterval": 5,
    "mode": "heuristic",
    "thresholds": { "warning": 40, "critical": 20 },
    "autoPause": true
  }
}
```

- `mode`: `"heuristic"` (fast, no LLM needed) or `"llm"` (uses configured provider)
- `autoPause`: Automatically pauses the session when drift score drops to critical
- `checkInterval`: Number of events between drift checks

## Dashboard

```bash
hawkeye serve
# Opens http://localhost:4242
```

The dashboard provides:
- Session list with live status
- Timeline view of every action
- Drift score chart over time
- File diff viewer
- Cost breakdown by file
- Guardrail violation log
- Settings management
- Session comparison

## Overnight / Background Agent Use

Use `hawkeye overnight` for unattended runs with automatic safety guardrails:

```bash
# Start overnight mode with $5 budget (serves dashboard + daemon + strict guardrails)
hawkeye overnight --budget 5

# With an initial task and remote access
hawkeye overnight --budget 10 --task "Fix all lint errors" --tunnel

# With LLM post-mortem on shutdown
hawkeye overnight --budget 5 --report-llm

# Generate a morning report separately
hawkeye report                          # Sessions since overnight.json or 8h ago
hawkeye report --since 2026-03-19T00:00 # Specific time range
hawkeye report --llm --webhook          # With post-mortem + webhook notification
```

Overnight mode automatically:
- Applies cost limits, file protection, command blocking, auto-pause on critical drift
- Backs up your config and restores it on shutdown
- Generates a morning report on Ctrl+C with per-session stats, drift, errors
- Fires `overnight_report`, `session_complete`, and `task_complete` webhooks

For manual setup without `overnight`:

```bash
# Start the dashboard + daemon separately
hawkeye serve &
hawkeye daemon

# Or use the remote mode (includes Cloudflare tunnel for mobile access)
hawkeye remote
```
```

## MCP Tools Reference (Agent Self-Awareness)

When the MCP server is configured, agents can call these tools:

| Tool | Use When |
|------|----------|
| `check_drift` | Every ~10 actions to verify objective alignment |
| `check_cost` | Periodically to stay within budget |
| `check_guardrail` | Before dangerous operations (force push, delete, deploy) |
| `get_objective` | When unsure about direction |
| `log_event` | When making significant decisions (type: "decision") |
| `get_error_summary` | When encountering repeated errors |
| `check_progress` | To estimate how far along the task is |
| `list_changes` | To see files modified in current session |
| `post_mortem` | At session end for structured debrief |
| `suggest_correction` | When drift is high or errors repeat |

## Troubleshooting

### Hooks not working
```bash
hawkeye hooks status    # Check if hooks are installed
hawkeye hooks install   # Reinstall hooks
```

### Port 4242 in use
```bash
hawkeye serve           # Auto-kills previous process on same port
```

### No active session showing
Sessions are auto-created on first hook event. Make sure `hawkeye hooks install` was run in the project directory.

### High drift score false positives
Switch to heuristic mode (default) or adjust thresholds in `.hawkeye/config.json`.

## Output Format

### Session inspect output example
```
Session abc1234
  Objective: Build a REST API with auth
  Status: recording | Duration: 12m 34s
  Actions: 47 | Cost: $1.23 | Tokens: 89,432
  Drift: 78/100 (ok)
  Files modified: 8

  Cost by file:
    src/auth.ts          $0.45  (36.6%)
    src/routes/api.ts    $0.31  (25.2%)
    src/middleware.ts     $0.22  (17.9%)
    ...
```

### Present Results to User

When presenting Hawkeye data to users:
- Always show the **drift score** with its status (ok/warning/critical)
- Always show the **total cost** and **top files by cost**
- Highlight any **guardrail violations** or **blocked actions**
- If drift is in warning/critical range, suggest the user review the agent's recent actions
