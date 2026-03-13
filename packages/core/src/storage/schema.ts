export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  working_dir TEXT NOT NULL,
  git_branch TEXT,
  git_commit_before TEXT,
  git_commit_after TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT DEFAULT 'recording',
  total_cost_usd REAL DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_actions INTEGER DEFAULT 0,
  final_drift_score REAL,
  metadata TEXT,
  developer TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  drift_score REAL,
  drift_flag TEXT,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  UNIQUE(session_id, sequence)
);

CREATE TABLE IF NOT EXISTS drift_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  score REAL NOT NULL,
  flag TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardrail_violations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event_id TEXT REFERENCES events(id),
  rule_name TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT,
  action_taken TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_drift_session ON drift_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_session ON guardrail_violations(session_id);
`;
