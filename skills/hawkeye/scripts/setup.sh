#!/bin/bash
set -e

# Hawkeye Setup Script
# Installs Hawkeye and configures hooks for the current project

echo "Setting up Hawkeye..." >&2

# Check if hawkeye is installed
if ! command -v hawkeye &> /dev/null; then
  echo "Installing hawkeye-ai globally..." >&2
  npm install -g hawkeye-ai
fi

# Initialize if not already done
if [ ! -d ".hawkeye" ]; then
  echo "Initializing Hawkeye..." >&2
  hawkeye init
else
  echo ".hawkeye/ already exists, skipping init" >&2
fi

# Install Claude Code hooks if .claude directory exists or we're in a Claude Code context
if [ -n "$CLAUDE_SESSION_ID" ] || [ -d ".claude" ]; then
  echo "Installing Claude Code hooks..." >&2
  hawkeye hooks install
fi

# Configure MCP if .mcp.json exists but hawkeye is not configured
if [ -f ".mcp.json" ]; then
  if ! grep -q '"hawkeye"' .mcp.json 2>/dev/null; then
    echo "Note: Add Hawkeye MCP server to .mcp.json for agent self-awareness" >&2
    echo "See: hawkeye mcp --help" >&2
  fi
fi

# Output JSON status
HOOKS_STATUS="false"
if command -v hawkeye &> /dev/null; then
  if hawkeye hooks status 2>/dev/null | grep -q "installed"; then
    HOOKS_STATUS="true"
  fi
fi

CONFIG_EXISTS="false"
if [ -f ".hawkeye/config.json" ]; then
  CONFIG_EXISTS="true"
fi

cat <<EOF
{
  "status": "ready",
  "hawkeye_installed": true,
  "hooks_installed": $HOOKS_STATUS,
  "config_exists": $CONFIG_EXISTS,
  "config_path": ".hawkeye/config.json",
  "dashboard": "http://localhost:4242"
}
EOF

echo "" >&2
echo "Hawkeye is ready. Run 'hawkeye serve' to launch the dashboard." >&2
