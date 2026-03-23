/**
 * Incident Mode engine.
 * Creates comprehensive incident snapshots when an agent goes off track.
 * Captures: drift state, recent events, error patterns, git status, files changed.
 */

export interface IncidentSnapshot {
  id: string;
  sessionId: string;
  triggeredAt: string;
  trigger: 'manual' | 'auto_drift' | 'auto_error' | 'auto_cost';
  severity: 'warning' | 'critical';
  driftScore: number | null;
  driftFlag: string | null;
  driftReason: string | null;
  recentEvents: IncidentEvent[];
  errorPatterns: Array<{ pattern: string; count: number }>;
  filesChanged: string[];
  totalCost: number;
  totalActions: number;
  summary: string;
}

export interface IncidentEvent {
  sequence: number;
  type: string;
  timestamp: string;
  summary: string;
}

export interface IncidentInput {
  sessionId: string;
  objective: string;
  status: string;
  driftScore: number | null;
  driftFlag: string | null;
  driftReason: string | null;
  totalCost: number;
  totalActions: number;
}

export interface IncidentEventInput {
  sequence: number;
  type: string;
  timestamp: string;
  data: string;
  cost_usd: number;
}

export function createIncidentSnapshot(
  id: string,
  session: IncidentInput,
  events: IncidentEventInput[],
  trigger: IncidentSnapshot['trigger'],
): IncidentSnapshot {
  // Summarize recent events (last 20)
  const recent = events.slice(-20);
  const recentEvents: IncidentEvent[] = recent.map((e) => ({
    sequence: e.sequence,
    type: e.type,
    timestamp: e.timestamp,
    summary: summarizeEvent(e),
  }));

  // Detect error patterns
  const errorMap = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'error') {
      const data = safeParse(e.data);
      const msg = normalizeError(String(data?.message || data?.stderr || 'unknown'));
      errorMap.set(msg, (errorMap.get(msg) || 0) + 1);
    }
  }
  const errorPatterns = [...errorMap.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Collect files changed
  const filesSet = new Set<string>();
  for (const e of events) {
    if (['file_write', 'file_delete', 'file_rename', 'file_create'].includes(e.type)) {
      const data = safeParse(e.data);
      if (data?.path) filesSet.add(String(data.path));
    }
  }

  // Build severity
  const severity: 'warning' | 'critical' =
    session.driftFlag === 'critical' || trigger === 'auto_error' ? 'critical' : 'warning';

  // Build summary
  const parts: string[] = [];
  if (trigger === 'auto_drift') parts.push(`Drift score dropped to ${session.driftScore}/100 (${session.driftFlag})`);
  if (trigger === 'auto_error') parts.push(`Repeated errors detected (${errorPatterns.length} patterns)`);
  if (trigger === 'auto_cost') parts.push(`Cost limit approaching ($${session.totalCost.toFixed(4)})`);
  if (trigger === 'manual') parts.push('Manually triggered incident');
  if (session.driftReason) parts.push(session.driftReason);
  parts.push(`${events.length} actions, ${filesSet.size} files changed, $${session.totalCost.toFixed(4)} spent`);

  return {
    id,
    sessionId: session.sessionId,
    triggeredAt: new Date().toISOString(),
    trigger,
    severity,
    driftScore: session.driftScore,
    driftFlag: session.driftFlag,
    driftReason: session.driftReason,
    recentEvents,
    errorPatterns,
    filesChanged: [...filesSet],
    totalCost: session.totalCost,
    totalActions: session.totalActions,
    summary: parts.join('. '),
  };
}

// ─── Self-Assessment ───

export interface SelfAssessment {
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  drift: { score: number | null; flag: string; trend: 'stable' | 'declining' | 'improving' };
  cost: { spent: number; budget: number | null; percentUsed: number | null };
  errors: { total: number; recurring: number; unresolvedPatterns: string[] };
  velocity: { actionsPerMinute: number; filesChanged: number };
  recommendations: string[];
}

export interface SelfAssessInput {
  driftScore: number | null;
  driftFlag: string;
  driftSnapshots: Array<{ score: number; flag: string }>;
  totalCost: number;
  costLimit: number | null;
  events: IncidentEventInput[];
  startedAt: string;
  objective: string;
}

export function selfAssess(input: SelfAssessInput): SelfAssessment {
  const { driftScore, driftFlag, driftSnapshots, totalCost, costLimit, events, startedAt } = input;

  // Drift trend
  let trend: 'stable' | 'declining' | 'improving' = 'stable';
  if (driftSnapshots.length >= 3) {
    const recent = driftSnapshots.slice(-3).map((s) => s.score);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const first = recent[0];
    if (avg < first - 5) trend = 'declining';
    else if (avg > first + 5) trend = 'improving';
  }

  // Cost analysis
  const percentUsed = costLimit ? (totalCost / costLimit) * 100 : null;

  // Error analysis
  const errorEvents = events.filter((e) => e.type === 'error');
  const errorPatterns = new Map<string, number>();
  for (const e of errorEvents) {
    const data = safeParse(e.data);
    const msg = normalizeError(String(data?.message || 'unknown'));
    errorPatterns.set(msg, (errorPatterns.get(msg) || 0) + 1);
  }
  const recurring = [...errorPatterns.values()].filter((c) => c >= 2).length;
  const unresolvedPatterns = [...errorPatterns.entries()]
    .filter(([, count]) => count >= 2)
    .map(([pattern]) => pattern)
    .slice(0, 5);

  // Velocity
  const durationMs = Date.now() - new Date(startedAt).getTime();
  const durationMin = Math.max(durationMs / 60000, 1);
  const actionsPerMinute = Math.round((events.length / durationMin) * 10) / 10;
  const filesChanged = new Set(
    events
      .filter((e) => ['file_write', 'file_delete', 'file_create'].includes(e.type))
      .map((e) => {
        const data = safeParse(e.data);
        return data?.path as string;
      })
      .filter(Boolean),
  ).size;

  // Overall risk
  let overallRisk: SelfAssessment['overallRisk'] = 'low';
  if (driftFlag === 'critical' || recurring >= 3 || (percentUsed && percentUsed > 90)) {
    overallRisk = 'critical';
  } else if (driftFlag === 'warning' || recurring >= 2 || (percentUsed && percentUsed > 70)) {
    overallRisk = 'high';
  } else if (errorEvents.length > 5 || (percentUsed && percentUsed > 50)) {
    overallRisk = 'medium';
  }

  // Recommendations
  const recommendations: string[] = [];
  if (driftFlag === 'critical') {
    recommendations.push('STOP: You have drifted critically from the objective. Re-read the objective and change your approach.');
  } else if (driftFlag === 'warning' && trend === 'declining') {
    recommendations.push('Your drift score is declining. Pause and verify your current approach aligns with the objective.');
  }
  if (recurring >= 2) {
    recommendations.push(`You have ${recurring} recurring error patterns. Switch strategy instead of retrying the same approach.`);
  }
  if (percentUsed && percentUsed > 80) {
    recommendations.push(`You have used ${Math.round(percentUsed)}% of budget. Prioritize remaining work carefully.`);
  }
  if (actionsPerMinute > 10) {
    recommendations.push('High action rate detected. Consider if you are iterating too fast without thinking.');
  }
  if (errorEvents.length > events.length * 0.3) {
    recommendations.push(`${Math.round((errorEvents.length / events.length) * 100)}% of your actions resulted in errors. Step back and reassess.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Everything looks good. Continue with your current approach.');
  }

  return {
    overallRisk,
    drift: { score: driftScore, flag: driftFlag, trend },
    cost: { spent: totalCost, budget: costLimit, percentUsed },
    errors: { total: errorEvents.length, recurring, unresolvedPatterns },
    velocity: { actionsPerMinute, filesChanged },
    recommendations,
  };
}

// ─── Auto-Correction ───

export interface AutoCorrection {
  shouldCorrect: boolean;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  diagnosis: string;
  corrections: CorrectionAction[];
}

export interface CorrectionAction {
  type: 'change_strategy' | 'revert_file' | 'stop_retrying' | 'refocus_objective' | 'reduce_scope';
  description: string;
  reasoning: string;
}

export function generateAutoCorrection(assessment: SelfAssessment, objective: string): AutoCorrection {
  const corrections: CorrectionAction[] = [];

  // If drift is critical → refocus on objective
  if (assessment.drift.flag === 'critical') {
    corrections.push({
      type: 'refocus_objective',
      description: `Re-read and refocus on: "${objective.slice(0, 100)}"`,
      reasoning: `Drift score is ${assessment.drift.score}/100 (critical). Your actions are no longer aligned with the task.`,
    });
  }

  // If drift is declining → change strategy
  if (assessment.drift.trend === 'declining' && (assessment.drift.flag === 'warning' || assessment.drift.flag === 'critical')) {
    corrections.push({
      type: 'change_strategy',
      description: 'Your current approach is making things worse. Try a different angle.',
      reasoning: 'Drift score is declining across recent checks, indicating your actions are moving further from the goal.',
    });
  }

  // If recurring errors → stop retrying
  if (assessment.errors.recurring >= 2) {
    corrections.push({
      type: 'stop_retrying',
      description: `Stop retrying the same failing approach. Errors: ${assessment.errors.unresolvedPatterns.slice(0, 2).join(', ')}`,
      reasoning: `${assessment.errors.recurring} error patterns are repeating. Each retry wastes time and budget.`,
    });
  }

  // If high error rate → reduce scope
  if (assessment.errors.total > 10 && assessment.errors.total > assessment.velocity.filesChanged * 2) {
    corrections.push({
      type: 'reduce_scope',
      description: 'Focus on fewer files at a time. Complete one change fully before moving to the next.',
      reasoning: `${assessment.errors.total} errors across ${assessment.velocity.filesChanged} files suggests too broad a scope.`,
    });
  }

  // If high cost → reduce scope
  if (assessment.cost.percentUsed && assessment.cost.percentUsed > 80) {
    corrections.push({
      type: 'reduce_scope',
      description: `Budget ${Math.round(assessment.cost.percentUsed)}% used. Focus only on the most critical remaining work.`,
      reasoning: 'Running low on budget. Prioritize high-impact changes only.',
    });
  }

  const shouldCorrect = corrections.length > 0;
  const urgency = assessment.overallRisk;
  const diagnosisParts: string[] = [];
  if (assessment.drift.flag !== 'ok') diagnosisParts.push(`drift ${assessment.drift.flag} (${assessment.drift.score})`);
  if (assessment.errors.recurring > 0) diagnosisParts.push(`${assessment.errors.recurring} recurring errors`);
  if (assessment.cost.percentUsed && assessment.cost.percentUsed > 70) diagnosisParts.push(`${Math.round(assessment.cost.percentUsed)}% budget used`);

  return {
    shouldCorrect,
    urgency,
    diagnosis: diagnosisParts.length > 0 ? diagnosisParts.join(', ') : 'No issues detected',
    corrections,
  };
}

// ─── Git Intelligence ───

export interface GitCommitInfo {
  sessionId: string;
  sequence: number;
  timestamp: string;
  commitHash: string;
  message: string;
  branch: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  agent: string | null;
}

export function extractGitCommits(
  sessionId: string,
  agent: string | null,
  events: IncidentEventInput[],
): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];

  for (const e of events) {
    if (e.type !== 'git_commit') continue;
    const data = safeParse(e.data);
    if (!data) continue;

    commits.push({
      sessionId,
      sequence: e.sequence,
      timestamp: e.timestamp,
      commitHash: String(data.commitHash || data.hash || ''),
      message: String(data.message || ''),
      branch: (data.branch as string) || null,
      filesChanged: Number(data.filesChanged || 0),
      linesAdded: Number(data.linesAdded || 0),
      linesRemoved: Number(data.linesRemoved || 0),
      agent,
    });
  }

  return commits;
}

// ─── Helpers ───

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function normalizeError(msg: string): string {
  return msg
    .replace(/\d+/g, 'N')
    .replace(/'[^']*'/g, "'...'")
    .replace(/"[^"]*"/g, '"..."')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .toLowerCase();
}

function summarizeEvent(e: IncidentEventInput): string {
  const data = safeParse(e.data);
  if (!data) return e.type;

  switch (e.type) {
    case 'command': return `$ ${String(data.command || '').slice(0, 60)}`;
    case 'file_write':
    case 'file_read':
    case 'file_delete': return `${e.type}: ${String(data.path || '').slice(0, 60)}`;
    case 'error': return `Error: ${String(data.message || data.stderr || '').slice(0, 60)}`;
    case 'llm_call': return `LLM: ${String(data.model || data.provider || '')} ($${(e.cost_usd || 0).toFixed(4)})`;
    case 'git_commit': return `Commit: ${String(data.message || '').slice(0, 60)}`;
    case 'decision': return `Decision: ${String(data.description || '').slice(0, 60)}`;
    default: return e.type;
  }
}
