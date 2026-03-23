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

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence TEXT NOT NULL,
  supersedes TEXT,
  contradicts TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  triggered_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  severity TEXT NOT NULL,
  drift_score REAL,
  drift_flag TEXT,
  summary TEXT NOT NULL,
  snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  timestamp TEXT NOT NULL,
  trigger TEXT NOT NULL,
  assessment TEXT NOT NULL,
  corrections TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_incidents_session ON incidents(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_drift_session ON drift_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_session ON guardrail_violations(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_items(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_items(key);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_items(category);
CREATE INDEX IF NOT EXISTS idx_corrections_session ON corrections(session_id);

CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  total_cost_usd REAL DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  tests_passed INTEGER,
  test_output TEXT,
  merge_commit TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS swarm_agents (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  agent_name TEXT NOT NULL,
  persona TEXT NOT NULL,
  task_prompt TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT DEFAULT 'waiting',
  session_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  pid INTEGER,
  started_at TEXT,
  finished_at TEXT,
  duration_seconds INTEGER,
  exit_code INTEGER,
  output TEXT,
  files_changed TEXT,
  lines_added INTEGER,
  lines_removed INTEGER,
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  final_drift_score REAL,
  error_count INTEGER DEFAULT 0,
  merge_status TEXT,
  merge_conflicts TEXT
);

CREATE TABLE IF NOT EXISTS swarm_conflicts (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES swarms(id),
  path TEXT NOT NULL,
  agents TEXT NOT NULL,
  type TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  resolved_by TEXT,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_swarm_agents_swarm ON swarm_agents(swarm_id);
CREATE INDEX IF NOT EXISTS idx_swarm_conflicts_swarm ON swarm_conflicts(swarm_id);
`;
