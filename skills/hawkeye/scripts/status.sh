#!/bin/bash
set -e

# Hawkeye Status Script
# Returns JSON with current Hawkeye state in the project

echo "Checking Hawkeye status..." >&2

# Check if hawkeye is installed
INSTALLED="false"
VERSION="none"
if command -v hawkeye &> /dev/null; then
  INSTALLED="true"
  VERSION=$(hawkeye --version 2>/dev/null || echo "unknown")
fi

# Check hooks
HOOKS="false"
if [ "$INSTALLED" = "true" ]; then
  if hawkeye hooks status 2>/dev/null | grep -q "installed"; then
    HOOKS="true"
  fi
fi

# Check config
CONFIG="false"
GUARDRAIL_COUNT=0
DRIFT_ENABLED="false"
if [ -f ".hawkeye/config.json" ]; then
  CONFIG="true"
  if command -v node &> /dev/null; then
    GUARDRAIL_COUNT=$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('.hawkeye/config.json','utf8'));
        console.log((c.guardrails||[]).length);
      } catch { console.log(0); }
    " 2>/dev/null || echo "0")
    DRIFT_ENABLED=$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('.hawkeye/config.json','utf8'));
        console.log(c.drift?.enabled ? 'true' : 'false');
      } catch { console.log('false'); }
    " 2>/dev/null || echo "false")
  fi
fi

# Check active sessions
ACTIVE_SESSIONS=0
TOTAL_SESSIONS=0
if [ "$INSTALLED" = "true" ] && [ -f ".hawkeye/traces.db" ]; then
  TOTAL_SESSIONS=$(node -e "
    try {
      const db = require('better-sqlite3')('.hawkeye/traces.db');
      console.log(db.prepare('SELECT COUNT(*) as c FROM sessions').get().c);
      db.close();
    } catch { console.log(0); }
  " 2>/dev/null || echo "0")
  ACTIVE_SESSIONS=$(node -e "
    try {
      const db = require('better-sqlite3')('.hawkeye/traces.db');
      console.log(db.prepare(\"SELECT COUNT(*) as c FROM sessions WHERE status='recording'\").get().c);
      db.close();
    } catch { console.log(0); }
  " 2>/dev/null || echo "0")
fi

# Check if dashboard is running
DASHBOARD="false"
if curl -s -o /dev/null -w "%{http_code}" http://localhost:4242/api/sessions 2>/dev/null | grep -q "200"; then
  DASHBOARD="true"
fi

cat <<EOF
{
  "hawkeye_installed": $INSTALLED,
  "version": "$VERSION",
  "hooks_installed": $HOOKS,
  "config_exists": $CONFIG,
  "guardrail_rules": $GUARDRAIL_COUNT,
  "drift_enabled": $DRIFT_ENABLED,
  "active_sessions": $ACTIVE_SESSIONS,
  "total_sessions": $TOTAL_SESSIONS,
  "dashboard_running": $DASHBOARD,
  "config_path": ".hawkeye/config.json",
  "dashboard_url": "http://localhost:4242"
}
EOF
