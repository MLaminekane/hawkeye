import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage, EventType, TraceEvent } from '@mklamine/hawkeye-core';
import {
  createLlmProvider,
  buildPostMortemPrompt,
  parsePostMortemResponse,
  analyzeRootCause,
  extractMemories,
  diffMemories,
  detectHallucinations,
  buildCumulativeMemory,
  createIncidentSnapshot,
  selfAssess,
  generateAutoCorrection,
  extractGitCommits,
} from '@mklamine/hawkeye-core';
import type { MemoryItem } from '@mklamine/hawkeye-core';
import type { PostMortemInput } from '@mklamine/hawkeye-core';
import { loadConfig, getDefaultConfig } from '../config.js';
import type { GuardrailRuleSetting, HawkeyeConfig } from '../config.js';

/**
 * Create and configure the Hawkeye MCP server.
 * Exposes session/event/drift/guardrail data as MCP tools and resources.
 *
 * Two categories of tools:
 * 1. Observability — query sessions, events, drift, stats, violations
 * 2. Agent-facing — check_drift, check_cost, check_guardrail, log_event, get_objective
 */
export function createMcpServer(storage: Storage, cwd?: string): McpServer {
  const workingDir = cwd || process.cwd();

  const server = new McpServer({
    name: 'hawkeye',
    version: '0.1.0',
  });

  // ─── Observability Tools ─────────────────────────────────────

  server.tool(
    'list_sessions',
    'List recorded AI agent sessions. Returns session IDs, objectives, status, cost, and timestamps.',
    {
      limit: z.number().optional().describe('Maximum number of sessions to return (default 50)'),
      status: z
        .string()
        .optional()
        .describe('Filter by status: recording, paused, completed, aborted'),
    },
    async ({ limit, status }) => {
      const result = storage.listSessions({ limit: limit ?? 50, status });
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_session',
    'Get details of a single session by ID (supports prefix matching with 4+ characters). Use status "recording" to find the current active session.',
    {
      sessionId: z.string().describe('Session ID or prefix (min 4 chars)'),
    },
    async ({ sessionId }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }],
      };
    },
  );

  server.tool(
    'get_session_events',
    'Get events (actions) recorded in a session. Events include commands, file changes, LLM calls, git operations, errors, etc.',
    {
      sessionId: z.string().describe('Session ID or prefix'),
      type: z
        .string()
        .optional()
        .describe(
          'Filter by event type: command, file_read, file_write, file_delete, file_rename, api_call, llm_call, decision, error, git_commit, git_checkout, git_push, git_pull, git_merge, guardrail_trigger, guardrail_block, drift_alert',
        ),
      limit: z.number().optional().describe('Maximum number of events to return'),
    },
    async ({ sessionId, type, limit }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }], isError: true };
      }
      const result = storage.getEvents(session.id, {
        type: type as EventType | undefined,
        limit,
      });
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      const events = result.value.map((e) => ({
        ...e,
        data: tryParseJson(e.data),
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }],
      };
    },
  );

  server.tool(
    'get_session_drift',
    'Get drift analysis snapshots for a session. Drift measures how far the agent has strayed from its original objective.',
    {
      sessionId: z.string().describe('Session ID or prefix'),
    },
    async ({ sessionId }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }], isError: true };
      }
      const result = storage.getDriftSnapshots(session.id);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_session_stats',
    'Get detailed statistics for a session: event counts by type, total cost, total duration.',
    {
      sessionId: z.string().describe('Session ID or prefix'),
    },
    async ({ sessionId }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }], isError: true };
      }
      const result = storage.getSessionStats(session.id);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_global_stats',
    'Get global statistics across all recorded sessions: total sessions, costs, tokens, average drift score.',
    {},
    async () => {
      const result = storage.getGlobalStats();
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'compare_sessions',
    'Compare multiple sessions side by side: stats, duration, files changed, and top cost files.',
    {
      sessionIds: z.array(z.string()).min(2).describe('Array of session IDs to compare (minimum 2)'),
    },
    async ({ sessionIds }) => {
      const result = storage.compareSessions(sessionIds);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_violations',
    'Get guardrail violations for a session. Violations occur when the agent triggers safety rules (file protection, command blocking, cost limits, etc.).',
    {
      sessionId: z.string().describe('Session ID or prefix'),
    },
    async ({ sessionId }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }], isError: true };
      }
      const result = storage.getViolations(session.id);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_cost_by_file',
    'Get cost breakdown by file for a session — shows which files were most expensive to edit.',
    {
      sessionId: z.string().describe('Session ID or prefix'),
    },
    async ({ sessionId }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return { content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }], isError: true };
      }
      const result = storage.getCostByFile(session.id);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  // ─── Agent-Facing Tools (Game Changers) ──────────────────────

  server.tool(
    'check_drift',
    'Check the current drift score for a session. Drift score ranges from 0 (completely off-track) to 100 (perfectly on-track). Thresholds: ok (70-100), warning (40-69), critical (0-39). Use this to self-monitor whether you are staying aligned with the original objective.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found. Start a recording first.' }],
          isError: true,
        };
      }

      const driftResult = storage.getDriftSnapshots(session.id);
      const snapshots = driftResult.ok ? driftResult.value : [];
      const latest = snapshots[snapshots.length - 1];

      // Load thresholds from config
      const config = loadConfigSafe(workingDir);

      const response = {
        session_id: session.id,
        objective: session.objective,
        status: session.status,
        current_drift_score: session.final_drift_score ?? (latest?.score ?? null),
        drift_flag: latest?.flag ?? 'unknown',
        drift_reason: latest?.reason ?? null,
        total_checks: snapshots.length,
        thresholds: {
          ok: `>= ${config.drift.warningThreshold}`,
          warning: `${config.drift.criticalThreshold} - ${config.drift.warningThreshold - 1}`,
          critical: `< ${config.drift.criticalThreshold}`,
        },
        recommendation:
          latest?.flag === 'critical'
            ? 'CRITICAL: You have drifted significantly from the objective. Re-read the objective and realign your actions.'
            : latest?.flag === 'warning'
              ? 'WARNING: You are starting to drift. Consider whether your current actions serve the original objective.'
              : 'You are on track.',
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'get_objective',
    'Recall the original objective of a session. Use this as an anti-drift anchor — when you feel uncertain about your direction, call this to re-ground yourself.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      const response = {
        session_id: session.id,
        objective: session.objective,
        agent: session.agent,
        started_at: session.started_at,
        status: session.status,
        actions_so_far: session.total_actions,
        cost_so_far_usd: session.total_cost_usd,
        drift_score: session.final_drift_score,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'check_cost',
    'Check real-time cost and token usage for a session. Use this for budget awareness — know how much you have spent and whether you are approaching limits.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      // Compute live cost from events for recording sessions
      let totalCost = session.total_cost_usd;
      let totalTokens = session.total_tokens;
      let totalActions = session.total_actions;

      if (session.status === 'recording' || session.status === 'paused') {
        const eventsResult = storage.getEvents(session.id);
        if (eventsResult.ok) {
          totalCost = eventsResult.value.reduce((sum, e) => sum + e.cost_usd, 0);
          totalTokens = eventsResult.value.reduce((sum, e) => {
            const d = tryParseJson(e.data);
            return sum + ((d && typeof d === 'object' && 'totalTokens' in d) ? (d as { totalTokens: number }).totalTokens : 0);
          }, 0);
          totalActions = eventsResult.value.length;
        }
      }

      // Check cost limits from config
      const config = loadConfigSafe(workingDir);
      const costRule = config.guardrails.find(
        (r: GuardrailRuleSetting) => r.type === 'cost_limit' && r.enabled,
      );
      const tokenRule = config.guardrails.find(
        (r: GuardrailRuleSetting) => r.type === 'token_limit' && r.enabled,
      );

      const costLimit = costRule?.config?.maxUsdPerSession as number | undefined;
      const tokenLimit = tokenRule?.config?.maxTokensPerSession as number | undefined;

      const elapsedMs = Date.now() - new Date(session.started_at).getTime();
      const elapsedHrs = elapsedMs / 3600000;
      const costPerHour = elapsedHrs > 0 ? totalCost / elapsedHrs : 0;
      const costPerAction = totalActions > 0 ? totalCost / totalActions : 0;

      const response = {
        session_id: session.id,
        total_cost_usd: Number(totalCost.toFixed(6)),
        total_tokens: totalTokens,
        total_actions: totalActions,
        cost_per_action_usd: Number(costPerAction.toFixed(6)),
        cost_per_hour_usd: Number(costPerHour.toFixed(4)),
        elapsed_minutes: Math.round(elapsedMs / 60000),
        limits: {
          cost_limit_usd: costLimit ?? null,
          cost_remaining_usd: costLimit ? Number((costLimit - totalCost).toFixed(4)) : null,
          cost_pct_used: costLimit ? Number(((totalCost / costLimit) * 100).toFixed(1)) : null,
          token_limit: tokenLimit ?? null,
          tokens_remaining: tokenLimit ? tokenLimit - totalTokens : null,
        },
        warning:
          costLimit && totalCost / costLimit > 0.8
            ? `You have used ${((totalCost / costLimit) * 100).toFixed(0)}% of your cost budget.`
            : null,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'check_guardrail',
    'Pre-check if an action would be allowed by Hawkeye guardrails before attempting it. Supports checking commands, file paths, and network hosts.',
    {
      action_type: z
        .enum(['command', 'file_write', 'file_read', 'file_delete', 'network'])
        .describe('The type of action to check'),
      target: z
        .string()
        .describe(
          'The target to check. For commands: the full command string. For files: the file path. For network: the hostname.',
        ),
    },
    async ({ action_type, target }) => {
      const config = loadConfigSafe(workingDir);
      const enabledRules = config.guardrails.filter((r: GuardrailRuleSetting) => r.enabled);
      const violations: Array<{ rule: string; type: string; severity: string; reason: string }> = [];

      for (const rule of enabledRules) {
        if (action_type === 'command' && rule.type === 'command_block') {
          const patterns = (rule.config.patterns || []) as string[];
          for (const pattern of patterns) {
            if (matchesPattern(target, pattern)) {
              violations.push({
                rule: rule.name,
                type: 'command_block',
                severity: rule.action,
                reason: `Command "${target}" matches blocked pattern "${pattern}"`,
              });
            }
          }
        }

        if (action_type === 'command' && rule.type === 'review_gate') {
          const patterns = (rule.config.patterns || []) as string[];
          for (const pattern of patterns) {
            if (matchesPattern(target, pattern)) {
              violations.push({
                rule: rule.name,
                type: 'review_gate',
                severity: 'block',
                reason: `Command "${target}" requires human approval (matches "${pattern}")`,
              });
            }
          }
        }

        if (
          (action_type === 'file_write' || action_type === 'file_read' || action_type === 'file_delete') &&
          rule.type === 'file_protect'
        ) {
          const paths = (rule.config.paths || []) as string[];
          for (const pattern of paths) {
            if (matchesGlob(target, pattern)) {
              violations.push({
                rule: rule.name,
                type: 'file_protect',
                severity: rule.action,
                reason: `File "${target}" matches protected pattern "${pattern}"`,
              });
            }
          }
        }

        if (
          (action_type === 'file_write' || action_type === 'file_read' || action_type === 'file_delete') &&
          rule.type === 'directory_scope'
        ) {
          const blockedDirs = (rule.config.blockedDirs || []) as string[];
          for (const dir of blockedDirs) {
            const resolved = dir.replace('~', process.env.HOME || '');
            if (target.startsWith(resolved)) {
              violations.push({
                rule: rule.name,
                type: 'directory_scope',
                severity: rule.action,
                reason: `File "${target}" is in blocked directory "${dir}"`,
              });
            }
          }
        }

        if (action_type === 'network' && rule.type === 'network_lock') {
          const blockedHosts = (rule.config.blockedHosts || []) as string[];
          const allowedHosts = (rule.config.allowedHosts || []) as string[];

          for (const pattern of blockedHosts) {
            if (target === pattern || target.endsWith('.' + pattern)) {
              violations.push({
                rule: rule.name,
                type: 'network_lock',
                severity: rule.action,
                reason: `Host "${target}" is in the blocklist (matched "${pattern}")`,
              });
            }
          }

          if (allowedHosts.length > 0) {
            const isAllowed = allowedHosts.some(
              (p) => target === p || target.endsWith('.' + p),
            );
            if (!isAllowed) {
              violations.push({
                rule: rule.name,
                type: 'network_lock',
                severity: rule.action,
                reason: `Host "${target}" is not in the allowlist`,
              });
            }
          }
        }
      }

      const allowed = violations.filter((v) => v.severity === 'block').length === 0;

      const response = {
        action_type,
        target,
        allowed,
        violations,
        summary: allowed
          ? violations.length > 0
            ? `Action is allowed but has ${violations.length} warning(s).`
            : 'Action is allowed. No guardrail rules triggered.'
          : `Action BLOCKED by ${violations.filter((v) => v.severity === 'block').length} rule(s).`,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'log_event',
    'Log a custom event into the current Hawkeye session. Use this to record decisions, observations, or actions that Hawkeye cannot automatically capture.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID. If omitted, uses the most recent active session.'),
      type: z
        .enum(['decision', 'command', 'error'])
        .describe('Event type: decision (reasoning/choice), command (action taken), error (problem encountered)'),
      description: z.string().describe('What happened — a concise description of the event'),
      reasoning: z
        .string()
        .optional()
        .describe('Why this action was taken (for decision events)'),
    },
    async ({ sessionId, type, description, reasoning }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found. Cannot log event.' }],
          isError: true,
        };
      }

      const sequence = storage.getNextSequence(session.id);
      const eventId = crypto.randomUUID();

      let eventData: TraceEvent['data'];
      let eventType: TraceEvent['type'];

      if (type === 'decision') {
        eventType = 'decision';
        eventData = { description, reasoning } as TraceEvent['data'];
      } else if (type === 'error') {
        eventType = 'error';
        eventData = { message: description, source: 'agent' } as TraceEvent['data'];
      } else {
        eventType = 'command';
        eventData = { command: description, args: [], cwd: workingDir, exitCode: 0 } as TraceEvent['data'];
      }

      const event: TraceEvent = {
        id: eventId,
        sessionId: session.id,
        timestamp: new Date(),
        sequence,
        type: eventType,
        data: eventData,
        durationMs: 0,
      };

      const result = storage.insertEvent(event);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error logging event: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              logged: true,
              event_id: eventId,
              session_id: session.id,
              type: eventType,
              sequence,
            }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    'list_changes',
    'Get a summary of all files modified in a session — useful for reviewing what has been changed so far.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      const eventsResult = storage.getEvents(session.id);
      if (!eventsResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${eventsResult.error.message}` }],
          isError: true,
        };
      }

      const fileEvents = eventsResult.value.filter(
        (e) => e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename',
      );

      const fileMap = new Map<string, { action: string; count: number; linesAdded: number; linesRemoved: number }>();

      for (const e of fileEvents) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (!data) continue;
        const path = (data.path || data.oldPath || 'unknown') as string;
        const existing = fileMap.get(path) || { action: e.type, count: 0, linesAdded: 0, linesRemoved: 0 };
        existing.count++;
        existing.action = e.type;
        existing.linesAdded += (data.linesAdded as number) || 0;
        existing.linesRemoved += (data.linesRemoved as number) || 0;
        fileMap.set(path, existing);
      }

      const files = [...fileMap.entries()]
        .map(([path, info]) => ({
          path,
          action: info.action,
          edit_count: info.count,
          lines_added: info.linesAdded,
          lines_removed: info.linesRemoved,
        }))
        .sort((a, b) => b.edit_count - a.edit_count);

      // Also get cost by file
      const costResult = storage.getCostByFile(session.id);
      const costMap = new Map<string, number>();
      if (costResult.ok) {
        for (const c of costResult.value) {
          costMap.set(c.path, c.cost);
        }
      }

      const response = {
        session_id: session.id,
        total_files_changed: files.length,
        files: files.map((f) => ({
          ...f,
          cost_usd: costMap.get(f.path) ?? 0,
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'analyze_root_cause',
    'Perform root cause analysis on a session to identify the primary error, causal chain, error patterns, drift analysis, and actionable fix suggestions. Fast heuristic analysis — no LLM needed.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, analyzes the most recent completed session.'),
    },
    async ({ sessionId }) => {
      let session;
      if (sessionId) {
        session = resolveSession(storage, sessionId);
      } else {
        const completedResult = storage.listSessions({ limit: 1, status: 'completed' });
        session = completedResult.ok && completedResult.value.length > 0
          ? completedResult.value[0]
          : null;
        if (!session) session = findActiveSession(storage);
      }

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No session found.' }],
          isError: true,
        };
      }

      const eventsResult = storage.getEvents(session.id);
      const events = eventsResult.ok ? eventsResult.value : [];
      const driftResult = storage.getDriftSnapshots(session.id);
      const driftSnapshots = driftResult.ok ? driftResult.value : [];

      const rcaEvents = events.map((e) => ({
        id: e.id, sequence: e.sequence, timestamp: e.timestamp, type: e.type,
        data: e.data, drift_score: e.drift_score, drift_flag: e.drift_flag, cost_usd: e.cost_usd,
      }));

      const rcaSession = {
        id: session.id, objective: session.objective || '', agent: session.agent || '',
        status: session.status, started_at: session.started_at, ended_at: session.ended_at,
        total_cost_usd: session.total_cost_usd, final_drift_score: session.final_drift_score,
      };

      const result = analyzeRootCause(rcaSession, rcaEvents, driftSnapshots);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ─── Memory helper ───

  function loadOrExtractMemories(session: { id: string; objective: string; agent: string | null; status: string; started_at: string; ended_at: string | null }): MemoryItem[] {
    const cached = storage.getMemoryItems(session.id);
    if (cached.ok && cached.value && cached.value.length > 0) {
      return cached.value.map((r) => ({
        id: r.id, sessionId: r.session_id, sequence: r.sequence, timestamp: r.timestamp,
        category: r.category as MemoryItem['category'], key: r.key, content: r.content,
        evidence: r.evidence, confidence: r.confidence as MemoryItem['confidence'],
        supersedes: r.supersedes ?? undefined, contradicts: r.contradicts ?? undefined,
      }));
    }

    const eventsResult = storage.getEvents(session.id);
    const events = (eventsResult.ok ? eventsResult.value : []).map((e) => ({
      id: e.id, sequence: e.sequence, timestamp: e.timestamp, type: e.type,
      data: e.data, drift_score: e.drift_score, cost_usd: e.cost_usd,
    }));

    const memSession = { id: session.id, objective: session.objective, agent: session.agent, status: session.status, started_at: session.started_at, ended_at: session.ended_at };
    const memories = extractMemories(memSession, events);

    storage.upsertMemoryItems(session.id, memories.map((m) => ({
      id: m.id, session_id: m.sessionId, sequence: m.sequence, timestamp: m.timestamp,
      category: m.category, key: m.key, content: m.content, evidence: m.evidence,
      confidence: m.confidence, supersedes: m.supersedes ?? null, contradicts: m.contradicts ?? null,
    })));

    return memories;
  }

  server.tool(
    'memory_diff',
    'Compare what an agent remembers between two sessions. Shows learned knowledge, forgotten items, evolved understanding, contradictions, and recurring hallucinations.',
    {
      sessionIdA: z.string().optional().describe('First session ID or prefix. If omitted, uses second-most-recent completed session.'),
      sessionIdB: z.string().optional().describe('Second session ID or prefix. If omitted, uses most recent completed session.'),
    },
    async ({ sessionIdA, sessionIdB }) => {
      const completedResult = storage.listSessions({ limit: 5, status: 'completed' });
      const completed = completedResult.ok ? completedResult.value : [];

      const sA = sessionIdA ? resolveSession(storage, sessionIdA) : completed[1] ?? null;
      const sB = sessionIdB ? resolveSession(storage, sessionIdB) : completed[0] ?? null;

      if (!sA || !sB) {
        return { content: [{ type: 'text' as const, text: 'Need at least 2 sessions for memory diff.' }], isError: true };
      }

      const memA = loadOrExtractMemories(sA);
      const memB = loadOrExtractMemories(sB);

      const msA = { id: sA.id, objective: sA.objective || '', agent: sA.agent, status: sA.status, started_at: sA.started_at, ended_at: sA.ended_at };
      const msB = { id: sB.id, objective: sB.objective || '', agent: sB.agent, status: sB.status, started_at: sB.started_at, ended_at: sB.ended_at };

      const result = diffMemories(memA, memB, msA, msB);

      const memBySession = new Map<string, MemoryItem[]>();
      memBySession.set(sA.id, memA);
      memBySession.set(sB.id, memB);
      result.hallucinations = detectHallucinations(memBySession);

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'check_memory',
    'Check cumulative agent memory across sessions. Shows what knowledge persists, what was lost, and recurring hallucinations. Call at session start to see what context to re-establish.',
    {
      limit: z.number().optional().describe('Max sessions to include (default 10)'),
    },
    async ({ limit }) => {
      const sessionsResult = storage.listSessions({ limit: limit || 10 });
      const sessions = sessionsResult.ok ? sessionsResult.value : [];

      if (sessions.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No sessions found.' }], isError: true };
      }

      const sessionMemories = sessions.map((s) => ({
        session: { id: s.id, objective: s.objective || '', agent: s.agent, status: s.status, started_at: s.started_at, ended_at: s.ended_at },
        memories: loadOrExtractMemories(s),
      }));

      const cumulative = buildCumulativeMemory(sessionMemories);

      return { content: [{ type: 'text' as const, text: JSON.stringify(cumulative, null, 2) }] };
    },
  );

  server.tool(
    'self_assess',
    'Comprehensive self-assessment combining drift, cost, errors, and velocity into one actionable health check. Returns overall risk level (low/medium/high/critical) with specific recommendations. Call this when you sense something is off, or periodically every 15-20 actions.',
    {
      sessionId: z.string().optional().describe('Session ID or prefix. If omitted, uses active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId ? resolveSession(storage, sessionId) : findActiveSession(storage);
      if (!session) {
        return { content: [{ type: 'text' as const, text: 'No active session found.' }], isError: true };
      }

      const eventsResult = storage.getEvents(session.id);
      const events = (eventsResult.ok ? eventsResult.value : []).map((e) => ({
        sequence: e.sequence, type: e.type, timestamp: e.timestamp,
        data: e.data, cost_usd: e.cost_usd,
      }));
      const driftResult = storage.getDriftSnapshots(session.id);
      const drifts = driftResult.ok ? driftResult.value : [];
      const latestDrift = drifts[drifts.length - 1];

      const config = loadConfigSafe(workingDir);
      const costLimit = config.guardrails?.find((g: { type: string }) => g.type === 'cost_limit');

      const assessment = selfAssess({
        driftScore: latestDrift?.score ?? session.final_drift_score ?? null,
        driftFlag: latestDrift?.flag ?? 'unknown',
        driftSnapshots: drifts.map((d) => ({ score: d.score, flag: d.flag })),
        totalCost: session.total_cost_usd ?? 0,
        costLimit: costLimit ? (costLimit as { value?: number }).value ?? null : null,
        events,
        startedAt: session.started_at,
        objective: session.objective ?? '',
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(assessment, null, 2) }] };
    },
  );

  server.tool(
    'auto_correct',
    'Get auto-correction recommendations AND check if Hawkeye has already taken autonomous corrections. Returns concrete actions: change_strategy, stop_retrying, refocus_objective, reduce_scope. Also returns any active correction hint from the Autonomous Control Layer. IMPORTANT: If there is an active correction, follow its agentInstructions immediately.',
    {
      sessionId: z.string().optional().describe('Session ID or prefix. If omitted, uses active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId ? resolveSession(storage, sessionId) : findActiveSession(storage);
      if (!session) {
        return { content: [{ type: 'text' as const, text: 'No active session found.' }], isError: true };
      }

      const eventsResult = storage.getEvents(session.id);
      const events = (eventsResult.ok ? eventsResult.value : []).map((e) => ({
        sequence: e.sequence, type: e.type, timestamp: e.timestamp,
        data: e.data, cost_usd: e.cost_usd,
      }));
      const driftResult = storage.getDriftSnapshots(session.id);
      const drifts = driftResult.ok ? driftResult.value : [];
      const latestDrift = drifts[drifts.length - 1];

      const assessment = selfAssess({
        driftScore: latestDrift?.score ?? session.final_drift_score ?? null,
        driftFlag: latestDrift?.flag ?? 'unknown',
        driftSnapshots: drifts.map((d) => ({ score: d.score, flag: d.flag })),
        totalCost: session.total_cost_usd ?? 0,
        costLimit: null,
        events,
        startedAt: session.started_at,
        objective: session.objective ?? '',
      });

      const correction = generateAutoCorrection(assessment, session.objective ?? '');

      // Check for active autonomous correction hint
      let activeHint: unknown = null;
      try {
        const hintPath = join(workingDir, '.hawkeye', 'active-correction.json');
        if (existsSync(hintPath)) {
          activeHint = JSON.parse(readFileSync(hintPath, 'utf-8'));
        }
      } catch {}

      // Get correction history for this session
      const correctionHistory = storage.getCorrections(session.id);
      const recentCorrections = (correctionHistory.ok ? correctionHistory.value : []).slice(0, 5);

      const result = {
        ...correction,
        activeCorrection: activeHint,
        recentAutocorrections: recentCorrections.map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          trigger: r.trigger,
          corrections: (() => { try { return JSON.parse(r.corrections); } catch { return []; } })(),
          dryRun: r.dry_run === 1,
        })),
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'get_correction',
    'Check if Hawkeye has autonomously corrected your session (rollback files, blocked patterns, etc). Returns the active correction hint with instructions. Call this after check_drift if drift is declining, or periodically to see if the autocorrect engine has intervened.',
    {},
    async () => {
      try {
        const hintPath = join(workingDir, '.hawkeye', 'active-correction.json');
        if (existsSync(hintPath)) {
          const hint = JSON.parse(readFileSync(hintPath, 'utf-8'));
          return { content: [{ type: 'text' as const, text: JSON.stringify(hint, null, 2) }] };
        }
      } catch {}
      return { content: [{ type: 'text' as const, text: JSON.stringify({ active: false, message: 'No active corrections. You are on track.' }) }] };
    },
  );

  server.tool(
    'trigger_incident',
    'Trigger incident mode: freezes the session, captures a full snapshot, and creates an incident record. Use when you detect a critical issue or when the session should be paused for human review.',
    {
      sessionId: z.string().optional().describe('Session ID or prefix. If omitted, uses active session.'),
      reason: z.string().optional().describe('Why the incident was triggered.'),
    },
    async ({ sessionId, reason }) => {
      const session = sessionId ? resolveSession(storage, sessionId) : findActiveSession(storage);
      if (!session) {
        return { content: [{ type: 'text' as const, text: 'No active session found.' }], isError: true };
      }

      const eventsResult = storage.getEvents(session.id);
      const events = (eventsResult.ok ? eventsResult.value : []).map((e) => ({
        sequence: e.sequence, type: e.type, timestamp: e.timestamp,
        data: e.data, cost_usd: e.cost_usd,
      }));
      const driftResult = storage.getDriftSnapshots(session.id);
      const drifts = driftResult.ok ? driftResult.value : [];
      const latestDrift = drifts[drifts.length - 1];

      const incidentId = `inc_${Date.now().toString(36)}`;
      const incident = createIncidentSnapshot(incidentId, {
        sessionId: session.id, objective: session.objective ?? '',
        status: session.status,
        driftScore: latestDrift?.score ?? session.final_drift_score ?? null,
        driftFlag: latestDrift?.flag ?? null, driftReason: reason || latestDrift?.reason || null,
        totalCost: session.total_cost_usd ?? 0, totalActions: events.length,
      }, events, 'manual');

      storage.insertIncident({
        id: incident.id, sessionId: session.id, triggeredAt: incident.triggeredAt,
        trigger: incident.trigger, severity: incident.severity,
        driftScore: incident.driftScore, driftFlag: incident.driftFlag,
        summary: incident.summary, snapshot: JSON.stringify(incident),
      });

      storage.pauseSession(session.id);

      return { content: [{ type: 'text' as const, text: JSON.stringify({ incident, action: 'Session frozen. Incident recorded.' }, null, 2) }] };
    },
  );

  server.tool(
    'list_commits',
    'List git commits made during agent sessions. Shows which agent wrote which commit, enabling intelligent revert. Use to audit what code changes agents have made.',
    {
      sessionId: z.string().optional().describe('Session ID or prefix. If omitted, shows commits across all sessions.'),
      limit: z.number().optional().describe('Max commits to return (default 20).'),
    },
    async ({ sessionId, limit }) => {
      const sid = sessionId ? resolveSession(storage, sessionId)?.id : undefined;
      const result = storage.getGitCommits(sid);
      const rows = result.ok ? result.value : [];

      const commits = rows.slice(0, limit || 20).map((r) => {
        const data = (() => { try { return JSON.parse(r.data); } catch { return {}; } })();
        return {
          sessionId: r.session_id, agent: r.agent, sequence: r.sequence, timestamp: r.timestamp,
          commitHash: data.commitHash || data.hash || '', message: data.message || '',
          branch: data.branch || null, filesChanged: data.filesChanged || 0,
        };
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(commits, null, 2) }] };
    },
  );

  server.tool(
    'post_mortem',
    'Generate an LLM-powered post-mortem analysis of a completed session. Returns a structured report with summary, outcome assessment, key actions, issues, drift analysis, cost assessment, and recommendations. Requires a configured LLM provider (set via Hawkeye settings).',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recently completed session.'),
    },
    async ({ sessionId }) => {
      // Resolve session
      let session;
      if (sessionId) {
        session = resolveSession(storage, sessionId);
      } else {
        // Find most recent completed session
        const completedResult = storage.listSessions({ limit: 1, status: 'completed' });
        session = completedResult.ok && completedResult.value.length > 0
          ? completedResult.value[0]
          : null;
        // Fallback to active session
        if (!session) session = findActiveSession(storage);
      }

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No session found. Record a session first.' }],
          isError: true,
        };
      }

      // Load LLM config — need full config for provider + apiKeys
      const fullConfig = loadFullConfigSafe(workingDir);
      const { provider, model, ollamaUrl } = fullConfig.drift;

      // Inject API keys from config
      if (fullConfig.apiKeys) {
        const keyMap: Record<string, string> = {
          anthropic: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          deepseek: 'DEEPSEEK_API_KEY',
          mistral: 'MISTRAL_API_KEY',
          google: 'GOOGLE_API_KEY',
        };
        for (const [p, envVar] of Object.entries(keyMap)) {
          const key = (fullConfig.apiKeys as Record<string, string | undefined>)[p];
          if (key && !process.env[envVar]) {
            process.env[envVar] = key;
          }
        }
      }

      let llm;
      try {
        llm = createLlmProvider(provider, model, ollamaUrl);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to initialize LLM provider "${provider}": ${String(err)}. Configure a provider in Hawkeye settings.`,
          }],
          isError: true,
        };
      }

      // Gather session data
      const eventsResult = storage.getEvents(session.id);
      const events = eventsResult.ok ? eventsResult.value : [];
      const statsResult = storage.getSessionStats(session.id);
      const stats = statsResult.ok ? statsResult.value : null;
      const driftResult = storage.getDriftSnapshots(session.id);
      const driftSnapshots = driftResult.ok ? driftResult.value : [];
      const violationsResult = storage.getViolations(session.id);
      const violations = violationsResult.ok ? violationsResult.value : [];
      const costResult = storage.getCostByFile(session.id);
      const costByFile = costResult.ok ? costResult.value : [];

      // Build event summary by type
      const typeCounts = new Map<string, number>();
      for (const e of events) {
        typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
      }
      const eventSummary = [...typeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `- ${type}: ${count}`)
        .join('\n');

      // Build files summary
      const fileEvents = events.filter(
        (e) => e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename',
      );
      const fileMap = new Map<string, number>();
      for (const e of fileEvents) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (!data) continue;
        const path = (data.path || 'unknown') as string;
        fileMap.set(path, (fileMap.get(path) || 0) + 1);
      }
      const filesSummary = [...fileMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([path, count]) => {
          const cost = costByFile.find((c) => c.path === path);
          return `- ${path} (${count} edits${cost ? `, $${cost.cost.toFixed(4)}` : ''})`;
        })
        .join('\n');

      // Build drift history
      const driftHistory = driftSnapshots
        .map((d) => `- Score: ${d.score}, Flag: ${d.flag}${d.reason ? ` — ${d.reason}` : ''}`)
        .join('\n');

      // Build violations summary
      const violationsSummary = violations
        .map((v) => `- [${v.severity}] ${v.rule_name}: ${v.description}`)
        .join('\n');

      // Build errors summary
      const errorEvents = events.filter((e) => e.type === 'error');
      const errorsSummary = errorEvents
        .slice(-10)
        .map((e) => {
          const data = tryParseJson(e.data) as Record<string, unknown> | null;
          return `- ${data?.message || data?.description || 'Unknown error'}`;
        })
        .join('\n');

      // Compute duration
      const startMs = new Date(session.started_at).getTime();
      const endMs = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
      const durationMinutes = Math.round((endMs - startMs) / 60000);

      // Compute live cost for active sessions
      let totalCost = session.total_cost_usd;
      let totalTokens = session.total_tokens;
      if (session.status === 'recording' || session.status === 'paused') {
        totalCost = events.reduce((sum, e) => sum + e.cost_usd, 0);
        totalTokens = events.reduce((sum, e) => {
          const d = tryParseJson(e.data);
          return sum + ((d && typeof d === 'object' && 'totalTokens' in d) ? (d as { totalTokens: number }).totalTokens : 0);
        }, 0);
      }

      const input: PostMortemInput = {
        objective: session.objective || 'No objective specified',
        agent: session.agent || 'unknown',
        status: session.status,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        durationMinutes,
        totalActions: events.length,
        totalCostUsd: totalCost,
        totalTokens,
        finalDriftScore: session.final_drift_score,
        eventSummary,
        filesSummary,
        driftHistory,
        violations: violationsSummary,
        errors: errorsSummary,
      };

      const prompt = buildPostMortemPrompt(input);

      try {
        const rawResponse = await llm.complete(prompt, { maxTokens: 1500 });
        const parsed = parsePostMortemResponse(rawResponse);

        if (!parsed) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Failed to parse LLM response',
                raw_response: rawResponse.slice(0, 500),
                session_id: session.id,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const response = {
          session_id: session.id,
          objective: session.objective,
          duration_minutes: durationMinutes,
          total_cost_usd: Number(totalCost.toFixed(4)),
          total_actions: events.length,
          ...parsed,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `LLM call failed: ${String(err)}. Check your ${provider} configuration and API key.`,
          }],
          isError: true,
        };
      }
    },
  );

  // ─── Session Control Tools ────────────────────────────────────

  server.tool(
    'end_session',
    'End the current or specified Hawkeye recording session. Marks it as completed and saves the final drift score.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, ends the most recent active session.'),
      status: z
        .enum(['completed', 'aborted'])
        .optional()
        .describe('How the session ended (default: completed)'),
    },
    async ({ sessionId, status }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      if (session.status !== 'recording' && session.status !== 'paused') {
        return {
          content: [{ type: 'text' as const, text: `Session ${session.id.slice(0, 8)} is already ${session.status}.` }],
          isError: true,
        };
      }

      const result = storage.endSession(session.id, status || 'completed');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ended: true,
            session_id: session.id,
            objective: session.objective,
            status: status || 'completed',
            total_actions: session.total_actions,
            total_cost_usd: session.total_cost_usd,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'pause_session',
    'Pause a recording session. The agent can resume it later. Useful when you need to take a break or investigate something.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, pauses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      if (session.status !== 'recording') {
        return {
          content: [{ type: 'text' as const, text: `Session ${session.id.slice(0, 8)} is ${session.status}, not recording.` }],
          isError: true,
        };
      }

      const result = storage.pauseSession(session.id);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ paused: true, session_id: session.id, objective: session.objective }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'resume_session',
    'Resume a paused session.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, resumes the most recently paused session.'),
    },
    async ({ sessionId }) => {
      let session;
      if (sessionId) {
        session = resolveSession(storage, sessionId);
      } else {
        const pausedResult = storage.listSessions({ limit: 1, status: 'paused' });
        session = pausedResult.ok && pausedResult.value.length > 0 ? pausedResult.value[0] : null;
      }

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No paused session found.' }],
          isError: true,
        };
      }

      if (session.status !== 'paused') {
        return {
          content: [{ type: 'text' as const, text: `Session ${session.id.slice(0, 8)} is ${session.status}, not paused.` }],
          isError: true,
        };
      }

      const result = storage.resumeSession(session.id);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ resumed: true, session_id: session.id, objective: session.objective }, null, 2),
        }],
      };
    },
  );

  // ─── Intelligence Tools ──────────────────────────────────────

  server.tool(
    'get_session_timeline',
    'Get a condensed timeline of a session grouped by phase — not raw events but a high-level summary of what happened when, with drift score overlay. Much more useful than raw events for understanding session flow.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No session found.' }],
          isError: true,
        };
      }

      const eventsResult = storage.getEvents(session.id);
      if (!eventsResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${eventsResult.error.message}` }],
          isError: true,
        };
      }

      const events = eventsResult.value;
      if (events.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ session_id: session.id, phases: [], summary: 'No events recorded.' }, null, 2) }],
        };
      }

      // Group events into phases (clusters of activity separated by >30s gaps)
      const phases: Array<{
        phase: number;
        start: string;
        end: string;
        duration_seconds: number;
        actions: number;
        drift_score: number | null;
        drift_flag: string | null;
        summary: string;
        files_touched: string[];
        cost_usd: number;
      }> = [];

      let phaseStart = 0;
      let phaseNum = 1;

      for (let i = 0; i < events.length; i++) {
        const gap = i > phaseStart
          ? new Date(events[i].timestamp).getTime() - new Date(events[i - 1].timestamp).getTime()
          : 0;

        const isLastEvent = i === events.length - 1;
        const isGap = gap > 30000; // 30 second gap = new phase

        if (isGap || isLastEvent) {
          const phaseEnd = isGap ? i - 1 : i;
          const phaseEvents = events.slice(phaseStart, phaseEnd + 1);

          // Summarize this phase
          const typeCounts = new Map<string, number>();
          const filesSet = new Set<string>();
          let phaseCost = 0;
          let lastDrift: number | null = null;
          let lastDriftFlag: string | null = null;

          for (const e of phaseEvents) {
            typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
            phaseCost += e.cost_usd;
            if (e.drift_score !== null) {
              lastDrift = e.drift_score;
              lastDriftFlag = e.drift_flag;
            }

            if (e.type === 'file_write' || e.type === 'file_delete' || e.type === 'file_rename') {
              const data = tryParseJson(e.data) as Record<string, unknown> | null;
              if (data?.path) filesSet.add(shortenPath(data.path as string));
            }
          }

          const parts: string[] = [];
          for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
            parts.push(`${count} ${type}`);
          }

          const startTime = phaseEvents[0].timestamp;
          const endTime = phaseEvents[phaseEvents.length - 1].timestamp;
          const durationSec = Math.round(
            (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000,
          );

          phases.push({
            phase: phaseNum,
            start: startTime,
            end: endTime,
            duration_seconds: durationSec,
            actions: phaseEvents.length,
            drift_score: lastDrift,
            drift_flag: lastDriftFlag,
            summary: parts.join(', '),
            files_touched: [...filesSet],
            cost_usd: Number(phaseCost.toFixed(4)),
          });

          phaseNum++;
          phaseStart = i;
        }
      }

      // Overall summary
      const totalCost = events.reduce((s, e) => s + e.cost_usd, 0);
      const startMs = new Date(events[0].timestamp).getTime();
      const endMs = new Date(events[events.length - 1].timestamp).getTime();

      const response = {
        session_id: session.id,
        objective: session.objective,
        total_phases: phases.length,
        total_actions: events.length,
        total_duration_seconds: Math.round((endMs - startMs) / 1000),
        total_cost_usd: Number(totalCost.toFixed(4)),
        final_drift: session.final_drift_score,
        phases,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'get_error_summary',
    'Get a summary of errors in a session — recurring patterns, failure rate, last error, and commands that failed. Use this to quickly understand what went wrong.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No session found.' }],
          isError: true,
        };
      }

      const eventsResult = storage.getEvents(session.id);
      if (!eventsResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${eventsResult.error.message}` }],
          isError: true,
        };
      }

      const events = eventsResult.value;
      const errorEvents = events.filter((e) => e.type === 'error');
      const commandEvents = events.filter((e) => e.type === 'command');

      // Failed commands (exitCode !== 0)
      const failedCommands: Array<{ command: string; exitCode: number; timestamp: string }> = [];
      for (const e of commandEvents) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (data && data.exitCode && data.exitCode !== 0) {
          failedCommands.push({
            command: `${data.command || ''} ${Array.isArray(data.args) ? (data.args as string[]).join(' ') : ''}`.trim(),
            exitCode: data.exitCode as number,
            timestamp: e.timestamp,
          });
        }
      }

      // Error patterns (group by message prefix)
      const errorPatterns = new Map<string, number>();
      const errorMessages: Array<{ message: string; timestamp: string }> = [];
      for (const e of errorEvents) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        const msg = (data?.message || data?.description || 'Unknown error') as string;
        errorMessages.push({ message: msg, timestamp: e.timestamp });
        // Group by first 60 chars
        const key = msg.slice(0, 60);
        errorPatterns.set(key, (errorPatterns.get(key) || 0) + 1);
      }

      const totalActions = events.length;
      const errorRate = totalActions > 0 ? errorEvents.length / totalActions : 0;
      const failureRate = commandEvents.length > 0 ? failedCommands.length / commandEvents.length : 0;

      const response = {
        session_id: session.id,
        total_errors: errorEvents.length,
        total_failed_commands: failedCommands.length,
        error_rate: `${(errorRate * 100).toFixed(1)}% of all actions`,
        command_failure_rate: `${(failureRate * 100).toFixed(1)}% of commands`,
        recurring_patterns: [...errorPatterns.entries()]
          .filter(([, count]) => count > 1)
          .sort((a, b) => b[1] - a[1])
          .map(([pattern, count]) => ({ pattern, occurrences: count })),
        last_error: errorMessages.length > 0 ? errorMessages[errorMessages.length - 1] : null,
        recent_failed_commands: failedCommands.slice(-5),
        assessment:
          errorEvents.length === 0 && failedCommands.length === 0
            ? 'Clean session — no errors or failed commands.'
            : errorRate > 0.2
              ? 'High error rate — consider investigating recurring patterns.'
              : failedCommands.length > 3
                ? 'Multiple command failures — check environment setup or dependencies.'
                : 'Some errors occurred but within normal range.',
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  // ─── Cross-Session & Correction Tools ─────────────────────────

  server.tool(
    'suggest_correction',
    'When drift is warning or critical, this tool analyzes what went wrong and suggests concrete next actions to get back on track. Uses LLM analysis of recent events vs the original objective.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      // Get drift info
      const driftResult = storage.getDriftSnapshots(session.id);
      const snapshots = driftResult.ok ? driftResult.value : [];
      const latest = snapshots[snapshots.length - 1];
      const currentScore = session.final_drift_score ?? latest?.score ?? null;

      if (currentScore !== null && currentScore >= 70) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              session_id: session.id,
              drift_score: currentScore,
              status: 'on_track',
              message: 'You are on track (score >= 70). No correction needed.',
            }, null, 2),
          }],
        };
      }

      // Get recent events to understand what happened
      const eventsResult = storage.getEvents(session.id, { limit: 20 });
      const recentEvents = eventsResult.ok ? eventsResult.value : [];

      // Build context about recent activity
      const recentActivity: string[] = [];
      for (const e of recentEvents.slice(-15)) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (e.type === 'command') {
          recentActivity.push(`CMD: ${data?.command || '?'} ${Array.isArray(data?.args) ? (data.args as string[]).join(' ') : ''}`);
        } else if (e.type === 'file_write' || e.type === 'file_read') {
          recentActivity.push(`${e.type.toUpperCase()}: ${shortenPath((data?.path || '?') as string)}`);
        } else if (e.type === 'error') {
          recentActivity.push(`ERROR: ${data?.message || '?'}`);
        }
      }

      // Try LLM-powered suggestion
      const fullConfig = loadFullConfigSafe(workingDir);
      let llmSuggestion: string | null = null;

      try {
        const { provider, model, ollamaUrl } = fullConfig.drift;
        if (fullConfig.apiKeys) {
          const keyMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY', mistral: 'MISTRAL_API_KEY', google: 'GOOGLE_API_KEY',
          };
          for (const [p, envVar] of Object.entries(keyMap)) {
            const key = (fullConfig.apiKeys as Record<string, string | undefined>)[p];
            if (key && !process.env[envVar]) process.env[envVar] = key;
          }
        }

        const llm = createLlmProvider(provider, model, ollamaUrl);
        const prompt = `You are an AI session analyst. An agent has drifted from its objective.

OBJECTIVE: "${session.objective}"
CURRENT DRIFT SCORE: ${currentScore}/100 (${currentScore !== null && currentScore < 30 ? 'CRITICAL' : 'WARNING'})
DRIFT REASON: ${latest?.reason || 'Unknown'}

RECENT ACTIVITY (last 15 actions):
${recentActivity.join('\n')}

Provide a brief, actionable correction plan. Be specific — reference the objective and suggest exact next steps.

Respond as JSON:
{
  "diagnosis": "<1-2 sentences: what went wrong>",
  "correction_steps": ["<step 1>", "<step 2>", "<step 3>"],
  "first_action": "<the very first thing to do right now>"
}`;

        const raw = await llm.complete(prompt, { maxTokens: 500 });
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          llmSuggestion = jsonMatch[0];
        }
      } catch {
        // LLM unavailable — fall back to heuristic
      }

      // Heuristic fallback
      const heuristicSteps: string[] = [];
      if (latest?.reason?.includes('No file modifications')) {
        heuristicSteps.push('You have been reading without writing. Start implementing changes.');
      }
      if (latest?.reason?.includes('repetitive')) {
        heuristicSteps.push('You are doing repetitive actions. Step back and try a different approach.');
      }
      if (recentActivity.filter(a => a.startsWith('ERROR')).length > 3) {
        heuristicSteps.push('Multiple errors detected. Fix the root cause before continuing.');
      }
      heuristicSteps.push(`Re-read the objective: "${session.objective}"`);
      heuristicSteps.push('Identify which part of the objective you haven\'t addressed yet and focus there.');

      const response: Record<string, unknown> = {
        session_id: session.id,
        drift_score: currentScore,
        drift_flag: currentScore !== null && currentScore < 30 ? 'critical' : 'warning',
        objective: session.objective,
        drift_reason: latest?.reason || null,
      };

      if (llmSuggestion) {
        try {
          const parsed = JSON.parse(llmSuggestion);
          response.diagnosis = parsed.diagnosis;
          response.correction_steps = parsed.correction_steps;
          response.first_action = parsed.first_action;
          response.source = 'llm';
        } catch {
          response.correction_steps = heuristicSteps;
          response.source = 'heuristic';
        }
      } else {
        response.correction_steps = heuristicSteps;
        response.source = 'heuristic';
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'search_events',
    'Search for events by keyword across all sessions. Useful for debugging cross-session issues — find all occurrences of a file, command, error message, etc.',
    {
      query: z.string().describe('Search keyword (searched in event data JSON)'),
      type: z
        .string()
        .optional()
        .describe('Filter by event type (command, file_write, error, llm_call, etc.)'),
      limit: z.number().optional().describe('Maximum results (default 20)'),
    },
    async ({ query, type, limit }) => {
      const maxResults = limit ?? 20;
      const sessionsResult = storage.listSessions({ limit: 100 });
      if (!sessionsResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${sessionsResult.error.message}` }],
          isError: true,
        };
      }

      const matches: Array<{
        session_id: string;
        session_objective: string;
        event_id: string;
        event_type: string;
        timestamp: string;
        snippet: string;
      }> = [];

      const lowerQuery = query.toLowerCase();

      for (const sess of sessionsResult.value) {
        if (matches.length >= maxResults) break;

        const eventsResult = storage.getEvents(sess.id, {
          type: type as EventType | undefined,
        });
        if (!eventsResult.ok) continue;

        for (const e of eventsResult.value) {
          if (matches.length >= maxResults) break;

          const dataStr = e.data.toLowerCase();
          if (dataStr.includes(lowerQuery)) {
            // Extract a snippet around the match
            const idx = dataStr.indexOf(lowerQuery);
            const start = Math.max(0, idx - 40);
            const end = Math.min(dataStr.length, idx + query.length + 40);
            const snippet = e.data.slice(start, end).replace(/\n/g, ' ');

            matches.push({
              session_id: sess.id.slice(0, 8),
              session_objective: sess.objective,
              event_id: e.id,
              event_type: e.type,
              timestamp: e.timestamp,
              snippet: (start > 0 ? '…' : '') + snippet + (end < e.data.length ? '…' : ''),
            });
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            query,
            total_matches: matches.length,
            matches,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'revert_file',
    'Revert a file to its state before it was modified in a session. Uses git checkout to restore the original version. Only works for files tracked by git.',
    {
      sessionId: z.string().describe('Session ID or prefix'),
      filePath: z.string().describe('Path of the file to revert'),
    },
    async ({ sessionId, filePath }) => {
      const session = resolveSession(storage, sessionId);
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Session not found: ${sessionId}` }],
          isError: true,
        };
      }

      // Find the first file_write event for this path to get the git state before
      const eventsResult = storage.getEvents(session.id);
      if (!eventsResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${eventsResult.error.message}` }],
          isError: true,
        };
      }

      const fileEvent = eventsResult.value.find((e) => {
        if (e.type !== 'file_write' && e.type !== 'file_delete') return false;
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (!data) return false;
        const ePath = data.path as string;
        return ePath === filePath || ePath.endsWith('/' + filePath) || filePath.endsWith('/' + ePath);
      });

      if (!fileEvent) {
        return {
          content: [{
            type: 'text' as const,
            text: `No file write/delete event found for "${filePath}" in session ${session.id.slice(0, 8)}.`,
          }],
          isError: true,
        };
      }

      // Use git to revert — checkout the file from the commit before the session
      const gitCommit = session.git_commit_before;
      const { execSync } = await import('node:child_process');
      const data = tryParseJson(fileEvent.data) as Record<string, unknown>;
      const fullPath = (data.path || filePath) as string;

      try {
        if (gitCommit) {
          execSync(`git checkout ${gitCommit} -- "${fullPath}"`, {
            cwd: session.working_dir,
            encoding: 'utf-8',
            timeout: 10000,
          });
        } else {
          // No commit reference — try HEAD~1
          execSync(`git checkout HEAD~1 -- "${fullPath}"`, {
            cwd: session.working_dir,
            encoding: 'utf-8',
            timeout: 10000,
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              reverted: true,
              path: fullPath,
              session_id: session.id.slice(0, 8),
              method: gitCommit ? `git checkout ${gitCommit.slice(0, 8)}` : 'git checkout HEAD~1',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Revert failed: ${String(err)}. The file may not be tracked by git or the commit reference is invalid.`,
          }],
          isError: true,
        };
      }
    },
  );

  // ─── Config & Progress Tools ──────────────────────────────────

  server.tool(
    'check_progress',
    'Estimate progress toward the session objective. Analyzes files touched, actions taken, errors encountered, and time spent to give a rough completion percentage and status.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
    },
    async ({ sessionId }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      const eventsResult = storage.getEvents(session.id);
      if (!eventsResult.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${eventsResult.error.message}` }],
          isError: true,
        };
      }

      const events = eventsResult.value;

      // Gather signals
      const fileWrites = events.filter((e) => e.type === 'file_write');
      const fileReads = events.filter((e) => e.type === 'file_read');
      const commands = events.filter((e) => e.type === 'command');
      const errors = events.filter((e) => e.type === 'error');
      const uniqueFilesWritten = new Set<string>();
      const uniqueFilesRead = new Set<string>();

      for (const e of fileWrites) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (data?.path) uniqueFilesWritten.add(data.path as string);
      }
      for (const e of fileReads) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (data?.path) uniqueFilesRead.add(data.path as string);
      }

      // Failed commands
      let failedCmds = 0;
      for (const e of commands) {
        const data = tryParseJson(e.data) as Record<string, unknown> | null;
        if (data && data.exitCode && data.exitCode !== 0) failedCmds++;
      }

      // Heuristic progress estimation
      // - Files written vs read ratio (writing = making progress)
      // - Error rate (high errors = stuck)
      // - Drift score (on track = progressing)
      const writeReadRatio = uniqueFilesRead.size > 0
        ? uniqueFilesWritten.size / uniqueFilesRead.size
        : (uniqueFilesWritten.size > 0 ? 1 : 0);

      const errorRate = events.length > 0 ? errors.length / events.length : 0;
      const failRate = commands.length > 0 ? failedCmds / commands.length : 0;
      const driftScore = session.final_drift_score ?? 85;

      // Composite score (0-100)
      let progressScore = 0;
      // Action volume (more actions = more progress, with diminishing returns)
      progressScore += Math.min(30, events.length * 0.5);
      // Files written (each unique file = tangible output)
      progressScore += Math.min(25, uniqueFilesWritten.size * 5);
      // Write/read ratio (writing > reading = executing vs exploring)
      progressScore += Math.min(15, writeReadRatio * 15);
      // Drift alignment bonus
      progressScore += (driftScore / 100) * 20;
      // Error penalty
      progressScore -= errorRate * 30;
      progressScore -= failRate * 10;

      progressScore = Math.max(0, Math.min(100, Math.round(progressScore)));

      const elapsedMs = Date.now() - new Date(session.started_at).getTime();
      const phase = progressScore < 20
        ? 'exploring'
        : progressScore < 50
          ? 'implementing'
          : progressScore < 80
            ? 'refining'
            : 'finishing';

      const response = {
        session_id: session.id,
        objective: session.objective,
        estimated_progress_pct: progressScore,
        phase,
        signals: {
          total_actions: events.length,
          unique_files_written: uniqueFilesWritten.size,
          unique_files_read: uniqueFilesRead.size,
          commands_run: commands.length,
          commands_failed: failedCmds,
          errors: errors.length,
          drift_score: session.final_drift_score,
        },
        elapsed_minutes: Math.round(elapsedMs / 60000),
        files_modified: [...uniqueFilesWritten].map(shortenPath),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'get_config',
    'Read the active Hawkeye configuration — drift thresholds, guardrail rules, webhook settings. Useful for understanding what rules are in effect.',
    {},
    async () => {
      const config = loadFullConfigSafe(workingDir);

      // Redact API key values
      const safeApiKeys: Record<string, string> = {};
      if (config.apiKeys) {
        for (const [k, v] of Object.entries(config.apiKeys)) {
          safeApiKeys[k] = v ? '••••' + String(v).slice(-4) : '(not set)';
        }
      }

      const response = {
        drift: config.drift,
        guardrails: config.guardrails.map((r) => ({
          name: r.name,
          type: r.type,
          enabled: r.enabled,
          action: r.action,
        })),
        webhooks: (config.webhooks || []).map((w) => ({
          enabled: w.enabled,
          url: w.url.slice(0, 30) + '…',
          events: w.events,
        })),
        apiKeys: safeApiKeys,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'set_objective',
    'Update the objective of the current session. Use this when the mission evolves mid-session — keeps drift detection aligned with the actual goal.',
    {
      sessionId: z
        .string()
        .optional()
        .describe('Session ID or prefix. If omitted, uses the most recent active session.'),
      objective: z.string().describe('The new objective for this session'),
    },
    async ({ sessionId, objective }) => {
      const session = sessionId
        ? resolveSession(storage, sessionId)
        : findActiveSession(storage);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: 'No active session found.' }],
          isError: true,
        };
      }

      const previousObjective = session.objective;
      const result = storage.updateSessionObjective(session.id, objective);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }

      // Log the objective change as a decision event
      const seq = storage.getNextSequence(session.id);
      storage.insertEvent({
        id: crypto.randomUUID(),
        sessionId: session.id,
        timestamp: new Date(),
        sequence: seq,
        type: 'decision' as TraceEvent['type'],
        data: {
          description: `Objective updated: "${objective}"`,
          reasoning: `Previous objective: "${previousObjective}"`,
        } as TraceEvent['data'],
        durationMs: 0,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            updated: true,
            session_id: session.id,
            previous_objective: previousObjective,
            new_objective: objective,
          }, null, 2),
        }],
      };
    },
  );

  // ─── Swarm Tools ──────────────────────────────────────────────

  server.tool(
    'list_swarms',
    'List multi-agent swarm runs. Shows past and active orchestration sessions with status, cost, and agent count.',
    {
      limit: z.number().optional().describe('Max number of swarms to return (default 10)'),
      status: z.string().optional().describe('Filter by status: pending, running, completed, failed, cancelled'),
    },
    async ({ limit, status }) => {
      const result = storage.listSwarms({ limit: limit || 10, status });
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: 'Failed to list swarms' }], isError: true };
      }

      const swarms = result.value.map((s) => {
        let agentCount = 0;
        try { agentCount = JSON.parse(s.config).agents?.length || 0; } catch {}
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          agents: agentCount,
          cost: s.total_cost_usd,
          created: s.created_at,
          completed: s.completed_at,
        };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(swarms, null, 2) }],
      };
    },
  );

  server.tool(
    'get_swarm',
    'Get detailed info about a specific swarm run including all agents, their status, files changed, conflicts, and merge results.',
    {
      swarmId: z.string().describe('Swarm ID or prefix (min 4 chars)'),
    },
    async ({ swarmId }) => {
      const swarm = storage.getSwarm(swarmId);
      if (!swarm.ok || !swarm.value) {
        return { content: [{ type: 'text' as const, text: `Swarm "${swarmId}" not found` }], isError: true };
      }

      const agents = storage.getSwarmAgents(swarm.value.id);
      const conflicts = storage.getSwarmConflicts(swarm.value.id);

      const response = {
        swarm: {
          id: swarm.value.id,
          name: swarm.value.name,
          objective: swarm.value.objective,
          status: swarm.value.status,
          cost: swarm.value.total_cost_usd,
          tokens: swarm.value.total_tokens,
          testsPassed: swarm.value.tests_passed,
          mergeCommit: swarm.value.merge_commit,
          created: swarm.value.created_at,
          completed: swarm.value.completed_at,
        },
        agents: (agents.ok ? agents.value : []).map((a) => ({
          name: a.agent_name,
          status: a.status,
          task: a.task_prompt.slice(0, 200),
          duration: a.duration_seconds,
          filesChanged: a.files_changed ? JSON.parse(a.files_changed).length : 0,
          cost: a.cost_usd,
          mergeStatus: a.merge_status,
          exitCode: a.exit_code,
        })),
        conflicts: (conflicts.ok ? conflicts.value : []).map((c) => ({
          path: c.path,
          agents: JSON.parse(c.agents),
          type: c.type,
          resolved: !!c.resolved,
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  server.tool(
    'get_swarm_agent',
    'Get detailed info about a specific agent within a swarm run — output, files changed, scope, errors.',
    {
      swarmId: z.string().describe('Swarm ID or prefix'),
      agentName: z.string().describe('Agent name within the swarm'),
    },
    async ({ swarmId, agentName }) => {
      const swarm = storage.getSwarm(swarmId);
      if (!swarm.ok || !swarm.value) {
        return { content: [{ type: 'text' as const, text: `Swarm "${swarmId}" not found` }], isError: true };
      }

      const agents = storage.getSwarmAgents(swarm.value.id);
      if (!agents.ok) {
        return { content: [{ type: 'text' as const, text: 'Failed to get agents' }], isError: true };
      }

      const agent = agents.value.find((a) => a.agent_name === agentName);
      if (!agent) {
        return { content: [{ type: 'text' as const, text: `Agent "${agentName}" not found in swarm` }], isError: true };
      }

      let persona: Record<string, unknown> = {};
      try { persona = JSON.parse(agent.persona); } catch {}

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          name: agent.agent_name,
          role: persona.role,
          description: persona.description,
          scope: persona.scope,
          status: agent.status,
          task: agent.task_prompt,
          duration: agent.duration_seconds,
          exitCode: agent.exit_code,
          filesChanged: agent.files_changed ? JSON.parse(agent.files_changed) : [],
          linesAdded: agent.lines_added,
          linesRemoved: agent.lines_removed,
          cost: agent.cost_usd,
          tokens: agent.tokens_used,
          driftScore: agent.final_drift_score,
          errorCount: agent.error_count,
          mergeStatus: agent.merge_status,
          output: agent.output?.slice(-2000),
          sessionId: agent.session_id,
        }, null, 2) }],
      };
    },
  );

  // ─── Resources ───────────────────────────────────────────────

  server.resource('sessions_list', 'hawkeye://sessions', {
    description: 'All recorded Hawkeye sessions',
    mimeType: 'application/json',
  }, async () => {
    const result = storage.listSessions({ limit: 100 });
    return {
      contents: [
        {
          uri: 'hawkeye://sessions',
          mimeType: 'application/json',
          text: JSON.stringify(result.ok ? result.value : [], null, 2),
        },
      ],
    };
  });

  server.resource('session_detail', 'hawkeye://session/{id}', {
    description: 'Single session with its recent events',
    mimeType: 'application/json',
  }, async (uri) => {
    const id = uri.pathname.split('/').pop() || '';
    const sessionResult = storage.getSession(id);
    const eventsResult = storage.getEvents(id, { limit: 50 });

    const data = {
      session: sessionResult.ok ? sessionResult.value : null,
      events: eventsResult.ok
        ? eventsResult.value.map((e) => ({ ...e, data: tryParseJson(e.data) }))
        : [],
    };

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  });

  server.resource('active_session', 'hawkeye://active', {
    description: 'The currently active (recording) session with live stats',
    mimeType: 'application/json',
  }, async () => {
    const session = findActiveSession(storage);
    if (!session) {
      return {
        contents: [{
          uri: 'hawkeye://active',
          mimeType: 'application/json',
          text: JSON.stringify({ active: false, session: null }, null, 2),
        }],
      };
    }

    const statsResult = storage.getSessionStats(session.id);
    const driftResult = storage.getDriftSnapshots(session.id);
    const latestDrift = driftResult.ok ? driftResult.value[driftResult.value.length - 1] : null;

    return {
      contents: [{
        uri: 'hawkeye://active',
        mimeType: 'application/json',
        text: JSON.stringify({
          active: true,
          session,
          stats: statsResult.ok ? statsResult.value : null,
          drift: latestDrift,
        }, null, 2),
      }],
    };
  });

  return server;
}

// ─── Helpers ─────────────────────────────────────────────────

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function resolveSession(storage: Storage, sessionId: string) {
  const result = storage.getSession(sessionId);
  return result.ok ? result.value : null;
}

function findActiveSession(storage: Storage) {
  const result = storage.listSessions({ limit: 1, status: 'recording' });
  if (result.ok && result.value.length > 0) return result.value[0];

  // Fallback to paused
  const pausedResult = storage.listSessions({ limit: 1, status: 'paused' });
  if (pausedResult.ok && pausedResult.value.length > 0) return pausedResult.value[0];

  return null;
}

function loadConfigSafe(cwd: string) {
  try {
    if (existsSync(join(cwd, '.hawkeye', 'config.json'))) {
      return loadConfig(cwd);
    }
  } catch {}
  // Return minimal defaults
  return {
    drift: { warningThreshold: 60, criticalThreshold: 30 },
    guardrails: [] as GuardrailRuleSetting[],
  };
}

function loadFullConfigSafe(cwd: string): HawkeyeConfig {
  try {
    if (existsSync(join(cwd, '.hawkeye', 'config.json'))) {
      return loadConfig(cwd);
    }
  } catch {}
  return getDefaultConfig();
}

function matchesPattern(command: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(regex, 'i').test(command);
  }
  return command.toLowerCase().includes(pattern.toLowerCase());
}

function shortenPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-3).join('/');
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`(^|/)${regex}$`).test(filePath);
}
