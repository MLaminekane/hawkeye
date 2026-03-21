import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { SCHEMA } from './schema.js';
import type { AgentSession, TraceEvent, EventType, DriftFlag, Result } from '../types.js';
import type { GuardrailViolation } from '../guardrails/rules.js';
import type { DriftCheckResult } from '../drift/engine.js';

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
