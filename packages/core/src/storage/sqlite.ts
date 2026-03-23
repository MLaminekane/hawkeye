import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { SCHEMA } from './schema.js';
import type { AgentSession, TraceEvent, EventType, DriftFlag, Result } from '../types.js';
import type { GuardrailViolation } from '../guardrails/rules.js';
import type { DriftCheckResult } from '../drift/engine.js';
import type { SwarmRow, SwarmAgentRow, SwarmConflictRow } from '../swarm/types.js';

export interface SessionRow {
  id: string;
  objective: string;
  agent: string | null;
  model: string | null;
  working_dir: string;
  git_branch: string | null;
  git_commit_before: string | null;
  git_commit_after: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  total_cost_usd: number;
  total_tokens: number;
  total_actions: number;
  final_drift_score: number | null;
  metadata: string | null;
  developer: string | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: string;
  drift_score: number | null;
  drift_flag: string | null;
  cost_usd: number;
  duration_ms: number;
}

export interface IncidentRow {
  id: string;
  session_id: string;
  triggered_at: string;
  trigger: string;
  severity: string;
  drift_score: number | null;
  drift_flag: string | null;
  summary: string;
  snapshot: string;
}

export interface MemoryItemRow {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: string;
  category: string;
  key: string;
  content: string;
  evidence: string;
  confidence: string;
  supersedes: string | null;
  contradicts: string | null;
}

export interface CorrectionRow {
  id: string;
  session_id: string;
  timestamp: string;
  trigger: string;
  assessment: string;
  corrections: string;
  dry_run: number;
}

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  private runMigrations(): void {
    // Add developer column if missing (migration for existing DBs)
    try {
      const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'developer')) {
        this.db.exec('ALTER TABLE sessions ADD COLUMN developer TEXT');
      }
    } catch {}
    // Add incidents table if missing
    try {
      const tables0 = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='incidents'").all();
      if (tables0.length === 0) {
        this.db.exec(`
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
          CREATE INDEX IF NOT EXISTS idx_incidents_session ON incidents(session_id);
        `);
      }
    } catch {}
    // Add memory_items table if missing
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'").all();
      if (tables.length === 0) {
        this.db.exec(`
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
          CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_items(session_id);
          CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_items(key);
          CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_items(category);
        `);
      }
    } catch {}
    // Add corrections table if missing
    try {
      const tables2 = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'").all();
      if (tables2.length === 0) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS corrections (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            timestamp TEXT NOT NULL,
            trigger TEXT NOT NULL,
            assessment TEXT NOT NULL,
            corrections TEXT NOT NULL,
            dry_run INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_corrections_session ON corrections(session_id);
        `);
      }
    } catch {}
    // Add swarm tables if missing
    try {
      const tables3 = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='swarms'").all();
      if (tables3.length === 0) {
        this.db.exec(`
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
        `);
      }
    } catch {}
  }

  createSession(session: AgentSession): Result<string> {
    try {
      const id = session.id || uuid();
      this.db
        .prepare(
          `INSERT INTO sessions (id, objective, agent, model, working_dir, git_branch, git_commit_before, started_at, status, metadata, developer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          session.objective,
          session.metadata.agent,
          session.metadata.model ?? null,
          session.metadata.workingDir,
          session.metadata.gitBranch ?? null,
          session.metadata.gitCommitBefore ?? null,
          session.startedAt.toISOString(),
          session.status,
          JSON.stringify(session.metadata),
          session.metadata.developer ?? null,
        );
      return { ok: true, value: id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateSessionStatus(sessionId: string, status: string): Result<void> {
    try {
      this.db
        .prepare(`UPDATE sessions SET status = ? WHERE id = ?`)
        .run(status, sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateSessionObjective(sessionId: string, objective: string): Result<void> {
    try {
      this.db
        .prepare(`UPDATE sessions SET objective = ? WHERE id = ?`)
        .run(objective, sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  endSession(
    sessionId: string,
    status: 'completed' | 'aborted',
    gitCommitAfter?: string,
  ): Result<void> {
    try {
      const stats = this.db
        .prepare(
          `SELECT COUNT(*) as total_actions,
                  COALESCE(SUM(cost_usd), 0) as total_cost,
                  COALESCE(SUM(CASE WHEN type = 'llm_call' THEN json_extract(data, '$.totalTokens') ELSE 0 END), 0) as total_tokens
         FROM events WHERE session_id = ?`,
        )
        .get(sessionId) as { total_actions: number; total_cost: number; total_tokens: number };

      this.db
        .prepare(
          `UPDATE sessions
         SET status = ?, ended_at = ?, git_commit_after = ?,
             total_actions = ?, total_cost_usd = ?, total_tokens = ?
         WHERE id = ?`,
        )
        .run(
          status,
          new Date().toISOString(),
          gitCommitAfter ?? null,
          stats.total_actions,
          stats.total_cost,
          stats.total_tokens,
          sessionId,
        );
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  pauseSession(sessionId: string): Result<void> {
    try {
      this.db
        .prepare(`UPDATE sessions SET status = 'paused' WHERE id = ? AND status = 'recording'`)
        .run(sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  resumeSession(sessionId: string): Result<void> {
    try {
      this.db
        .prepare(`UPDATE sessions SET status = 'recording' WHERE id = ? AND status = 'paused'`)
        .run(sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  reopenSession(sessionId: string): Result<void> {
    try {
      this.db
        .prepare(`UPDATE sessions SET status = 'recording', ended_at = NULL WHERE id = ?`)
        .run(sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  insertEvent(event: TraceEvent): Result<string> {
    try {
      const id = event.id || uuid();
      this.db
        .prepare(
          `INSERT INTO events (id, session_id, sequence, timestamp, type, data, drift_score, drift_flag, cost_usd, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          event.sessionId,
          event.sequence,
          event.timestamp.toISOString(),
          event.type,
          JSON.stringify(event.data),
          event.driftScore ?? null,
          event.driftFlag ?? null,
          event.costUsd ?? 0,
          event.durationMs,
        );
      return { ok: true, value: id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getSession(sessionId: string): Result<SessionRow | null> {
    try {
      // Try exact match first, then prefix match
      let row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
        | SessionRow
        | undefined;
      if (!row && sessionId.length >= 4) {
        row = this.db
          .prepare('SELECT * FROM sessions WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1')
          .get(`${sessionId}%`) as SessionRow | undefined;
      }
      return { ok: true, value: row ?? null };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  listSessions(options?: {
    limit?: number;
    status?: string;
  }): Result<SessionRow[]> {
    try {
      let query = 'SELECT * FROM sessions';
      const params: unknown[] = [];

      if (options?.status) {
        query += ' WHERE status = ?';
        params.push(options.status);
      }

      query += ' ORDER BY started_at DESC';

      if (options?.limit) {
        query += ' LIMIT ?';
        params.push(options.limit);
      }

      const rows = this.db.prepare(query).all(...params) as SessionRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getEvents(
    sessionId: string,
    options?: { type?: EventType; limit?: number },
  ): Result<EventRow[]> {
    try {
      let query = 'SELECT * FROM events WHERE session_id = ?';
      const params: unknown[] = [sessionId];

      if (options?.type) {
        query += ' AND type = ?';
        params.push(options.type);
      }

      query += ' ORDER BY sequence ASC';

      if (options?.limit) {
        query += ' LIMIT ?';
        params.push(options.limit);
      }

      const rows = this.db.prepare(query).all(...params) as EventRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getEventById(eventId: string): Result<EventRow | null> {
    try {
      const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
      return { ok: true, value: row ?? null };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getRecentBlocks(limit = 50): EventRow[] {
    try {
      return this.db
        .prepare(
          `SELECT * FROM events WHERE type IN ('guardrail_block', 'guardrail_trigger')
           ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(limit) as EventRow[];
    } catch {
      return [];
    }
  }

  getNextSequence(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) as max_seq FROM events WHERE session_id = ?')
      .get(sessionId) as { max_seq: number };
    return row.max_seq + 1;
  }

  insertDriftSnapshot(
    sessionId: string,
    eventId: string,
    result: DriftCheckResult,
  ): Result<string> {
    try {
      const id = uuid();
      this.db
        .prepare(
          `INSERT INTO drift_snapshots (id, session_id, event_id, score, flag, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, sessionId, eventId, result.score, result.flag, result.reason, new Date().toISOString());
      return { ok: true, value: id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  insertGuardrailViolation(
    sessionId: string,
    eventId: string,
    violation: GuardrailViolation,
  ): Result<string> {
    try {
      const id = uuid();
      this.db
        .prepare(
          `INSERT INTO guardrail_violations (id, session_id, event_id, rule_name, severity, description, action_taken, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          eventId,
          violation.ruleName,
          violation.severity,
          violation.description,
          violation.actionTaken,
          new Date().toISOString(),
        );
      return { ok: true, value: id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateEventDrift(eventId: string, score: number, flag: string): Result<void> {
    try {
      this.db
        .prepare('UPDATE events SET drift_score = ?, drift_flag = ? WHERE id = ?')
        .run(score, flag, eventId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateFinalDriftScore(sessionId: string, score: number): Result<void> {
    try {
      this.db
        .prepare('UPDATE sessions SET final_drift_score = ? WHERE id = ?')
        .run(score, sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getDriftSnapshots(sessionId: string): Result<Array<{
    id: string;
    score: number;
    flag: string;
    reason: string;
    created_at: string;
  }>> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM drift_snapshots WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as Array<{ id: string; score: number; flag: string; reason: string; created_at: string }>;
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  deleteSession(sessionId: string): Result<void> {
    try {
      // Delete in FK-safe order: children first, then parents
      this.db.prepare('DELETE FROM corrections WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM incidents WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM memory_items WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM drift_snapshots WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM guardrail_violations WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getCostByFile(sessionId: string): Result<Array<{ path: string; cost: number; edits: number }>> {
    try {
      const rows = this.db.prepare(`
        SELECT json_extract(data, '$.path') as path,
               COALESCE(SUM(cost_usd), 0) as cost,
               COUNT(*) as edits
        FROM events
        WHERE session_id = ? AND type IN ('file_write', 'file_delete', 'file_rename')
        AND json_extract(data, '$.path') IS NOT NULL
        GROUP BY path
        ORDER BY cost DESC
      `).all(sessionId) as Array<{ path: string; cost: number; edits: number }>;
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getGlobalStats(): Result<GlobalStats> {
    try {
      // Use a CTE that computes live stats for active sessions from events table,
      // since sessions table only updates cost/tokens/actions on session end.
      const row = this.db.prepare(`
        WITH session_stats AS (
          SELECT
            s.id,
            s.status,
            s.final_drift_score,
            s.started_at,
            CASE WHEN s.status = 'recording' AND s.total_cost_usd = 0
              THEN COALESCE((SELECT SUM(e.cost_usd) FROM events e WHERE e.session_id = s.id), 0)
              ELSE s.total_cost_usd
            END as real_cost,
            CASE WHEN s.status = 'recording' AND s.total_tokens = 0
              THEN COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0)
              ELSE s.total_tokens
            END as real_tokens,
            CASE WHEN s.status = 'recording' AND s.total_actions = 0
              THEN COALESCE((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id), 0)
              ELSE s.total_actions
            END as real_actions
          FROM sessions s
        )
        SELECT
          COUNT(*) as total_sessions,
          SUM(CASE WHEN status = 'recording' THEN 1 ELSE 0 END) as active_sessions,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_sessions,
          SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) as aborted_sessions,
          COALESCE(SUM(real_actions), 0) as total_actions,
          COALESCE(SUM(real_cost), 0) as total_cost_usd,
          COALESCE(AVG(CASE WHEN final_drift_score IS NOT NULL THEN final_drift_score END), 0) as avg_drift_score,
          COALESCE(SUM(real_tokens), 0) as total_tokens,
          MIN(started_at) as first_session,
          MAX(started_at) as last_session
        FROM session_stats
      `).get() as GlobalStats;
      return { ok: true, value: row };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getDevAnalytics(): Result<DeveloperAnalytics[]> {
    try {
      const rows = this.db.prepare(`
        SELECT
          COALESCE(developer, 'unknown') as developer,
          COUNT(*) as total_sessions,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_sessions,
          SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) as aborted_sessions,
          COALESCE(SUM(total_actions), 0) as total_actions,
          COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(AVG(CASE WHEN final_drift_score IS NOT NULL THEN final_drift_score END), 0) as avg_drift_score,
          MIN(started_at) as first_session,
          MAX(started_at) as last_session
        FROM sessions
        GROUP BY COALESCE(developer, 'unknown')
        ORDER BY total_sessions DESC
      `).all() as DeveloperAnalytics[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateSessionDeveloper(sessionId: string, developer: string): Result<void> {
    try {
      this.db
        .prepare('UPDATE sessions SET developer = ? WHERE id = ?')
        .run(developer, sessionId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  forkSession(sessionId: string, upToSequence: number): Result<string> {
    try {
      // 1. Read source session
      const sessionResult = this.getSession(sessionId);
      if (!sessionResult.ok || !sessionResult.value) {
        return { ok: false, error: new Error('Source session not found') };
      }
      const source = sessionResult.value;

      // 2. Query events up to the given sequence
      const events = this.db
        .prepare(
          'SELECT * FROM events WHERE session_id = ? AND sequence <= ? ORDER BY sequence ASC',
        )
        .all(sessionId, upToSequence) as EventRow[];

      if (events.length === 0) {
        return { ok: false, error: new Error('No events found up to the given sequence') };
      }

      const eventIds = events.map((e) => e.id);
      const placeholders = eventIds.map(() => '?').join(',');

      // 3. Query drift snapshots for those events
      const driftSnapshots = this.db
        .prepare(
          `SELECT * FROM drift_snapshots WHERE session_id = ? AND event_id IN (${placeholders})`,
        )
        .all(sessionId, ...eventIds) as Array<{
        id: string;
        session_id: string;
        event_id: string;
        score: number;
        flag: string;
        reason: string;
        created_at: string;
      }>;

      // 4. Query guardrail violations for those events
      const violations = this.db
        .prepare(
          `SELECT * FROM guardrail_violations WHERE session_id = ? AND event_id IN (${placeholders})`,
        )
        .all(sessionId, ...eventIds) as GuardrailViolationRow[];

      // 5. Execute fork in a single transaction
      const newSessionId = uuid();
      const now = new Date().toISOString();

      const doFork = this.db.transaction(() => {
        // Recompute totals from copied events
        const totalCostUsd = events.reduce((sum, e) => sum + (e.cost_usd || 0), 0);
        const totalActions = events.length;
        const totalTokens = events.reduce((sum, e) => {
          try {
            const data = JSON.parse(e.data);
            return sum + (data.totalTokens || 0);
          } catch {
            return sum;
          }
        }, 0);

        // Augment metadata with fork info
        let metadata: Record<string, unknown> = {};
        try {
          metadata = source.metadata ? JSON.parse(source.metadata) : {};
        } catch {}
        metadata.forkedFrom = sessionId;
        metadata.forkedAtSequence = upToSequence;

        // Get final drift score from last event that has one
        let finalDrift: number | null = null;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].drift_score != null) {
            finalDrift = events[i].drift_score;
            break;
          }
        }

        // Insert new session
        this.db
          .prepare(
            `INSERT INTO sessions (id, objective, agent, model, working_dir, git_branch, git_commit_before, git_commit_after, started_at, ended_at, status, total_cost_usd, total_tokens, total_actions, final_drift_score, metadata, developer)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newSessionId,
            source.objective,
            source.agent,
            source.model,
            source.working_dir,
            source.git_branch,
            source.git_commit_before,
            source.git_commit_after,
            source.started_at,
            now,
            'completed',
            totalCostUsd,
            totalTokens,
            totalActions,
            finalDrift,
            JSON.stringify(metadata),
            source.developer,
          );

        // Copy events with new IDs, build old->new ID map
        const eventIdMap = new Map<string, string>();
        const insertEvent = this.db.prepare(
          `INSERT INTO events (id, session_id, sequence, timestamp, type, data, drift_score, drift_flag, cost_usd, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const event of events) {
          const newEventId = uuid();
          eventIdMap.set(event.id, newEventId);
          insertEvent.run(
            newEventId,
            newSessionId,
            event.sequence,
            event.timestamp,
            event.type,
            event.data,
            event.drift_score,
            event.drift_flag,
            event.cost_usd,
            event.duration_ms,
          );
        }

        // Copy drift snapshots with remapped event IDs
        const insertDrift = this.db.prepare(
          `INSERT INTO drift_snapshots (id, session_id, event_id, score, flag, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const snap of driftSnapshots) {
          const newEventId = eventIdMap.get(snap.event_id);
          if (!newEventId) continue;
          insertDrift.run(uuid(), newSessionId, newEventId, snap.score, snap.flag, snap.reason, snap.created_at);
        }

        // Copy guardrail violations with remapped event IDs
        const insertViolation = this.db.prepare(
          `INSERT INTO guardrail_violations (id, session_id, event_id, rule_name, severity, description, action_taken, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const v of violations) {
          const newEventId = eventIdMap.get(v.event_id);
          if (!newEventId) continue;
          insertViolation.run(uuid(), newSessionId, newEventId, v.rule_name, v.severity, v.description, v.action_taken, v.created_at);
        }
      });

      doFork();

      // 6. Return new session ID
      return { ok: true, value: newSessionId };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Incidents ───

  insertIncident(incident: { id: string; sessionId: string; triggeredAt: string; trigger: string; severity: string; driftScore: number | null; driftFlag: string | null; summary: string; snapshot: string }): Result<string> {
    try {
      this.db.prepare(
        `INSERT INTO incidents (id, session_id, triggered_at, trigger, severity, drift_score, drift_flag, summary, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(incident.id, incident.sessionId, incident.triggeredAt, incident.trigger, incident.severity, incident.driftScore, incident.driftFlag, incident.summary, incident.snapshot);
      return { ok: true, value: incident.id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getIncidents(sessionId: string): Result<IncidentRow[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM incidents WHERE session_id = ? ORDER BY triggered_at DESC')
        .all(sessionId) as IncidentRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getAllIncidents(limit = 50): Result<IncidentRow[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM incidents ORDER BY triggered_at DESC LIMIT ?')
        .all(limit) as IncidentRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Git Intelligence ───

  getGitCommits(sessionId?: string): Result<Array<{ session_id: string; agent: string | null; sequence: number; timestamp: string; data: string }>> {
    try {
      const sql = sessionId
        ? `SELECT e.session_id, s.agent, e.sequence, e.timestamp, e.data FROM events e JOIN sessions s ON e.session_id = s.id WHERE e.type = 'git_commit' AND e.session_id = ? ORDER BY e.timestamp DESC`
        : `SELECT e.session_id, s.agent, e.sequence, e.timestamp, e.data FROM events e JOIN sessions s ON e.session_id = s.id WHERE e.type = 'git_commit' ORDER BY e.timestamp DESC LIMIT 100`;
      const rows = sessionId
        ? this.db.prepare(sql).all(sessionId) as Array<{ session_id: string; agent: string | null; sequence: number; timestamp: string; data: string }>
        : this.db.prepare(sql).all() as Array<{ session_id: string; agent: string | null; sequence: number; timestamp: string; data: string }>;
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Memory Items ───

  upsertMemoryItems(sessionId: string, items: MemoryItemRow[]): Result<void> {
    try {
      const doUpsert = this.db.transaction(() => {
        this.db.prepare('DELETE FROM memory_items WHERE session_id = ?').run(sessionId);
        const insert = this.db.prepare(
          `INSERT INTO memory_items (id, session_id, sequence, timestamp, category, key, content, evidence, confidence, supersedes, contradicts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of items) {
          insert.run(
            item.id || uuid(),
            sessionId,
            item.sequence,
            item.timestamp,
            item.category,
            item.key,
            item.content,
            item.evidence,
            item.confidence,
            item.supersedes ?? null,
            item.contradicts ?? null,
          );
        }
      });
      doUpsert();
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getMemoryItems(sessionId: string, category?: string): Result<MemoryItemRow[]> {
    try {
      const sql = category
        ? 'SELECT * FROM memory_items WHERE session_id = ? AND category = ? ORDER BY sequence ASC'
        : 'SELECT * FROM memory_items WHERE session_id = ? ORDER BY sequence ASC';
      const rows = category
        ? (this.db.prepare(sql).all(sessionId, category) as MemoryItemRow[])
        : (this.db.prepare(sql).all(sessionId) as MemoryItemRow[]);
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getMemoryItemsByKey(key: string): Result<MemoryItemRow[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM memory_items WHERE key = ? ORDER BY timestamp ASC')
        .all(key) as MemoryItemRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getAllMemoryItems(options?: { limit?: number; since?: string }): Result<MemoryItemRow[]> {
    try {
      let sql = 'SELECT * FROM memory_items';
      const params: unknown[] = [];
      if (options?.since) {
        sql += ' WHERE timestamp >= ?';
        params.push(options.since);
      }
      sql += ' ORDER BY timestamp ASC';
      if (options?.limit) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }
      const rows = this.db.prepare(sql).all(...params) as MemoryItemRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Corrections ───

  insertCorrection(correction: CorrectionRow): Result<string> {
    try {
      this.db.prepare(
        `INSERT INTO corrections (id, session_id, timestamp, trigger, assessment, corrections, dry_run)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        correction.id,
        correction.session_id,
        correction.timestamp,
        correction.trigger,
        correction.assessment,
        correction.corrections,
        correction.dry_run,
      );
      return { ok: true, value: correction.id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getCorrections(sessionId: string): Result<CorrectionRow[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM corrections WHERE session_id = ? ORDER BY timestamp DESC')
        .all(sessionId) as CorrectionRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getAllCorrections(limit = 50): Result<CorrectionRow[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM corrections ORDER BY timestamp DESC LIMIT ?')
        .all(limit) as CorrectionRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Swarms ──────────────────────────────────────────────

  createSwarm(swarm: SwarmRow): Result<string> {
    try {
      this.db.prepare(
        `INSERT INTO swarms (id, name, objective, config, status, created_at, started_at, completed_at, total_cost_usd, total_tokens, tests_passed, test_output, merge_commit, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        swarm.id, swarm.name, swarm.objective, swarm.config, swarm.status,
        swarm.created_at, swarm.started_at, swarm.completed_at,
        swarm.total_cost_usd, swarm.total_tokens, swarm.tests_passed,
        swarm.test_output, swarm.merge_commit, swarm.summary,
      );
      return { ok: true, value: swarm.id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getSwarm(swarmId: string): Result<SwarmRow | null> {
    try {
      let row = this.db.prepare('SELECT * FROM swarms WHERE id = ?').get(swarmId) as SwarmRow | undefined;
      if (!row && swarmId.length >= 4) {
        row = this.db.prepare('SELECT * FROM swarms WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1')
          .get(`${swarmId}%`) as SwarmRow | undefined;
      }
      return { ok: true, value: row ?? null };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  listSwarms(options?: { limit?: number; status?: string }): Result<SwarmRow[]> {
    try {
      let query = 'SELECT * FROM swarms';
      const params: unknown[] = [];
      if (options?.status) {
        query += ' WHERE status = ?';
        params.push(options.status);
      }
      query += ' ORDER BY created_at DESC';
      if (options?.limit) {
        query += ' LIMIT ?';
        params.push(options.limit);
      }
      const rows = this.db.prepare(query).all(...params) as SwarmRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateSwarm(swarmId: string, updates: Partial<SwarmRow>): Result<void> {
    try {
      const fields: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'id') continue;
        fields.push(`${key} = ?`);
        values.push(value);
      }
      if (fields.length > 0) {
        values.push(swarmId);
        this.db.prepare(`UPDATE swarms SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  deleteSwarm(swarmId: string): Result<void> {
    try {
      this.db.prepare('DELETE FROM swarm_conflicts WHERE swarm_id = ?').run(swarmId);
      this.db.prepare('DELETE FROM swarm_agents WHERE swarm_id = ?').run(swarmId);
      this.db.prepare('DELETE FROM swarms WHERE id = ?').run(swarmId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Swarm Agents ───────────────────────────────────────

  insertSwarmAgent(agent: SwarmAgentRow): Result<string> {
    try {
      this.db.prepare(
        `INSERT INTO swarm_agents (id, swarm_id, agent_name, persona, task_prompt, task_id, status,
          session_id, worktree_path, branch, pid, started_at, finished_at, duration_seconds,
          exit_code, output, files_changed, lines_added, lines_removed, cost_usd, tokens_used,
          final_drift_score, error_count, merge_status, merge_conflicts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agent.id, agent.swarm_id, agent.agent_name, agent.persona,
        agent.task_prompt, agent.task_id, agent.status,
        agent.session_id, agent.worktree_path, agent.branch, agent.pid,
        agent.started_at, agent.finished_at, agent.duration_seconds,
        agent.exit_code, agent.output, agent.files_changed,
        agent.lines_added, agent.lines_removed, agent.cost_usd, agent.tokens_used,
        agent.final_drift_score, agent.error_count, agent.merge_status, agent.merge_conflicts,
      );
      return { ok: true, value: agent.id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getSwarmAgents(swarmId: string): Result<SwarmAgentRow[]> {
    try {
      const rows = this.db.prepare('SELECT * FROM swarm_agents WHERE swarm_id = ? ORDER BY started_at ASC')
        .all(swarmId) as SwarmAgentRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  updateSwarmAgent(agentId: string, updates: Partial<SwarmAgentRow>): Result<void> {
    try {
      const fields: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'id') continue;
        fields.push(`${key} = ?`);
        values.push(value);
      }
      if (fields.length > 0) {
        values.push(agentId);
        this.db.prepare(`UPDATE swarm_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  // ─── Swarm Conflicts ───────────────────────────────────

  insertSwarmConflict(conflict: SwarmConflictRow): Result<string> {
    try {
      this.db.prepare(
        `INSERT INTO swarm_conflicts (id, swarm_id, path, agents, type, resolved, resolved_by, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        conflict.id, conflict.swarm_id, conflict.path, conflict.agents,
        conflict.type, conflict.resolved, conflict.resolved_by, conflict.resolution,
      );
      return { ok: true, value: conflict.id };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getSwarmConflicts(swarmId: string): Result<SwarmConflictRow[]> {
    try {
      const rows = this.db.prepare('SELECT * FROM swarm_conflicts WHERE swarm_id = ?')
        .all(swarmId) as SwarmConflictRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  resolveSwarmConflict(conflictId: string, resolvedBy: string, resolution: string): Result<void> {
    try {
      this.db.prepare(
        `UPDATE swarm_conflicts SET resolved = 1, resolved_by = ?, resolution = ? WHERE id = ?`,
      ).run(resolvedBy, resolution, conflictId);
      return { ok: true, value: undefined };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  close(): void {
    this.db.close();
  }

  getEventCount(sessionId: string): Result<number> {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?')
        .get(sessionId) as { count: number };
      return { ok: true, value: row.count };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getViolations(sessionId: string): Result<GuardrailViolationRow[]> {
    try {
      const rows = this.db
        .prepare('SELECT * FROM guardrail_violations WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as GuardrailViolationRow[];
      return { ok: true, value: rows };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  compareSessions(sessionIds: string[]): Result<SessionComparison[]> {
    try {
      const results: SessionComparison[] = [];
      for (const sid of sessionIds) {
        const sResult = this.getSession(sid);
        if (!sResult.ok || !sResult.value) continue;
        const session = sResult.value;

        const statsResult = this.getSessionStats(sid);
        const stats = statsResult.ok ? statsResult.value : {
          total_events: 0, command_count: 0, file_count: 0, llm_count: 0,
          api_count: 0, git_count: 0, error_count: 0, guardrail_count: 0,
          total_cost_usd: 0, total_duration_ms: 0,
        };

        const startMs = new Date(session.started_at).getTime();
        const endMs = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
        const durationMs = endMs - startMs;

        const files = this.db.prepare(`
          SELECT DISTINCT json_extract(data, '$.path') as path
          FROM events
          WHERE session_id = ? AND type IN ('file_write', 'file_delete', 'file_rename')
          AND json_extract(data, '$.path') IS NOT NULL
        `).all(sid) as Array<{ path: string }>;

        const topCost = this.db.prepare(`
          SELECT json_extract(data, '$.path') as path, COALESCE(SUM(cost_usd), 0) as cost
          FROM events
          WHERE session_id = ? AND type IN ('file_write', 'file_delete', 'file_rename')
          AND json_extract(data, '$.path') IS NOT NULL
          GROUP BY path ORDER BY cost DESC LIMIT 5
        `).all(sid) as Array<{ path: string; cost: number }>;

        results.push({
          session,
          stats,
          durationMs,
          filesChanged: files.map((f) => f.path),
          topCostFiles: topCost,
        });
      }
      return { ok: true, value: results };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }

  getSessionStats(sessionId: string): Result<SessionStats> {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total_events,
          SUM(CASE WHEN type = 'command' THEN 1 ELSE 0 END) as command_count,
          SUM(CASE WHEN type IN ('file_read','file_write','file_delete','file_rename') THEN 1 ELSE 0 END) as file_count,
          SUM(CASE WHEN type = 'llm_call' THEN 1 ELSE 0 END) as llm_count,
          SUM(CASE WHEN type = 'api_call' THEN 1 ELSE 0 END) as api_count,
          SUM(CASE WHEN type LIKE 'git_%' THEN 1 ELSE 0 END) as git_count,
          SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END) as error_count,
          SUM(CASE WHEN type IN ('guardrail_trigger','guardrail_block') THEN 1 ELSE 0 END) as guardrail_count,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms
        FROM events WHERE session_id = ?
      `).get(sessionId) as SessionStats;
      return { ok: true, value: row };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  }
}

export interface GlobalStats {
  total_sessions: number;
  active_sessions: number;
  completed_sessions: number;
  aborted_sessions: number;
  total_actions: number;
  total_cost_usd: number;
  avg_drift_score: number;
  total_tokens: number;
  first_session: string | null;
  last_session: string | null;
}

export interface GuardrailViolationRow {
  id: string;
  session_id: string;
  event_id: string;
  rule_name: string;
  severity: string;
  description: string;
  action_taken: string;
  created_at: string;
}

export interface SessionStats {
  total_events: number;
  command_count: number;
  file_count: number;
  llm_count: number;
  api_count: number;
  git_count: number;
  error_count: number;
  guardrail_count: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

export interface SessionComparison {
  session: SessionRow;
  stats: SessionStats;
  durationMs: number;
  filesChanged: string[];
  topCostFiles: Array<{ path: string; cost: number }>;
}

export interface DeveloperAnalytics {
  developer: string;
  total_sessions: number;
  completed_sessions: number;
  aborted_sessions: number;
  total_actions: number;
  total_cost_usd: number;
  total_tokens: number;
  avg_drift_score: number;
  first_session: string | null;
  last_session: string | null;
}
