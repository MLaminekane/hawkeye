/**
 * Root Cause Analysis engine.
 * Heuristic analysis of agent sessions to identify primary errors,
 * causal chains, drift triggers, and actionable suggestions.
 */

// ─── Input types (decoupled from storage) ───

export interface RcaEvent {
  id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: string;
  drift_score: number | null;
  drift_flag: string | null;
  cost_usd: number;
}

export interface RcaSession {
  id: string;
  objective: string;
  agent: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  total_cost_usd: number;
  final_drift_score: number | null;
}

export interface RcaDriftSnapshot {
  score: number;
  flag: string;
  reason: string;
  created_at: string;
}

// ─── Output types ───

export interface CausalStep {
  sequence: number;
  type: string;
  description: string;
  timestamp: string;
  relevance: 'root_cause' | 'contributing' | 'effect' | 'context';
  explanation: string;
}

export interface ErrorPattern {
  pattern: string;
  count: number;
  sequences: number[];
}

export interface DriftAnalysis {
  trend: 'stable' | 'declining' | 'volatile' | 'improving';
  lowestScore: number;
  highestScore: number;
  inflectionPoint: {
    sequence: number;
    scoreBefore: number;
    scoreAfter: number;
    triggerDescription: string;
  } | null;
}

export interface RcaResult {
  summary: string;
  outcome: 'success' | 'failure' | 'partial' | 'unknown';
  primaryError: {
    sequence: number;
    type: string;
    description: string;
    timestamp: string;
  } | null;
  causalChain: CausalStep[];
  driftAnalysis: DriftAnalysis | null;
  errorPatterns: ErrorPattern[];
  suggestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

// ─── Parsed event helper ───

interface ParsedEvent {
  event: RcaEvent;
  parsed: Record<string, unknown>;
  files: string[];
  isError: boolean;
  isGuardrail: boolean;
  errorMessage: string | null;
  commandStr: string | null;
  exitCode: number | null;
}

function parseEvent(e: RcaEvent): ParsedEvent {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(e.data); } catch { /* ignore */ }

  const files: string[] = [];
  if (parsed.path) files.push(shortenPath(String(parsed.path)));
  if (parsed.file_path) files.push(shortenPath(String(parsed.file_path)));
  if (parsed.oldPath) files.push(shortenPath(String(parsed.oldPath)));

  const isError = e.type === 'error' || (e.type === 'command' && parsed.exitCode != null && parsed.exitCode !== 0);
  const isGuardrail = e.type === 'guardrail_trigger' || e.type === 'guardrail_block';

  let errorMessage: string | null = null;
  if (isError) {
    errorMessage = String(parsed.message || parsed.stderr || parsed.description || '').slice(0, 200);
  }
  if (isGuardrail) {
    errorMessage = String(parsed.description || parsed.ruleName || 'Guardrail triggered');
  }

  let commandStr: string | null = null;
  if (e.type === 'command') {
    const args = Array.isArray(parsed.args) ? parsed.args.join(' ') : '';
    commandStr = `${parsed.command || ''} ${args}`.trim();
  }

  return {
    event: e,
    parsed,
    files,
    isError,
    isGuardrail,
    errorMessage,
    commandStr,
    exitCode: (parsed.exitCode as number) ?? null,
  };
}

function shortenPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return parts.slice(-3).join('/');
}

// ─── Main analysis function ───

export function analyzeRootCause(
  session: RcaSession,
  events: RcaEvent[],
  driftSnapshots: RcaDriftSnapshot[],
): RcaResult {
  if (events.length === 0) {
    return {
      summary: 'No events recorded in this session.',
      outcome: 'unknown',
      primaryError: null,
      causalChain: [],
      driftAnalysis: null,
      errorPatterns: [],
      suggestions: ['No data available for analysis.'],
      confidence: 'low',
    };
  }

  const parsed = events.map(parseEvent);

  // Phase 1: Find all failure events
  const errors = parsed.filter((p) => p.isError);
  const guardrails = parsed.filter((p) => p.isGuardrail);
  const allFailures = [...errors, ...guardrails].sort((a, b) => a.event.sequence - b.event.sequence);

  // Phase 2: Detect error patterns
  const errorPatterns = detectErrorPatterns(errors);

  // Phase 3: Find primary error
  const primaryError = findPrimaryError(errors, guardrails, errorPatterns);

  // Phase 4: Build causal chain
  const causalChain = primaryError
    ? buildCausalChain(primaryError, parsed)
    : [];

  // Phase 5: Analyze drift
  const driftAnalysis = analyzeDrift(parsed, driftSnapshots);

  // Phase 6: Determine outcome
  const outcome = determineOutcome(session, errors, guardrails, driftAnalysis);

  // Phase 7: Generate suggestions
  const suggestions = generateSuggestions(
    session, primaryError, causalChain, errorPatterns, driftAnalysis, errors, guardrails, parsed,
  );

  // Phase 8: Determine confidence
  const confidence = determineConfidence(allFailures, causalChain, driftAnalysis);

  // Phase 9: Build summary
  const summary = buildSummary(session, outcome, primaryError, errorPatterns, driftAnalysis, parsed);

  return {
    summary,
    outcome,
    primaryError: primaryError
      ? {
          sequence: primaryError.event.sequence,
          type: primaryError.event.type,
          description: primaryError.errorMessage || describeEvent(primaryError),
          timestamp: primaryError.event.timestamp,
        }
      : null,
    causalChain,
    driftAnalysis,
    errorPatterns,
    suggestions,
    confidence,
  };
}

// ─── Phase 2: Error pattern detection ───

function detectErrorPatterns(errors: ParsedEvent[]): ErrorPattern[] {
  const groups = new Map<string, number[]>();

  for (const err of errors) {
    // Normalize the error to a pattern key
    let key: string;
    if (err.commandStr) {
      // Group by command base (e.g., "tsc", "npm test", "cargo build")
      const base = err.commandStr.split(/\s+/)[0] || 'unknown';
      key = `${base} failed (exit ${err.exitCode || '?'})`;
    } else if (err.errorMessage) {
      // Group by first ~80 chars of error message (normalized)
      key = err.errorMessage
        .replace(/\d+/g, 'N')
        .replace(/[a-f0-9]{8,}/gi, 'HASH')
        .slice(0, 80);
    } else {
      key = err.event.type;
    }

    const existing = groups.get(key) || [];
    existing.push(err.event.sequence);
    groups.set(key, existing);
  }

  return Array.from(groups.entries())
    .map(([pattern, sequences]) => ({ pattern, count: sequences.length, sequences }))
    .sort((a, b) => b.count - a.count);
}

// ─── Phase 3: Primary error identification ───

function findPrimaryError(
  errors: ParsedEvent[],
  guardrails: ParsedEvent[],
  patterns: ErrorPattern[],
): ParsedEvent | null {
  if (errors.length === 0 && guardrails.length === 0) return null;

  // Priority 1: Most repeated error pattern (the persistent blocker)
  if (patterns.length > 0 && patterns[0].count >= 3) {
    const targetSeq = patterns[0].sequences[patterns[0].sequences.length - 1];
    const found = errors.find((e) => e.event.sequence === targetSeq);
    if (found) return found;
  }

  // Priority 2: Last error (usually the final failure)
  if (errors.length > 0) {
    return errors[errors.length - 1];
  }

  // Priority 3: Most impactful guardrail (blocks > warns)
  const blocks = guardrails.filter((g) => {
    const severity = String(g.parsed.severity || g.parsed.action || '');
    return severity === 'block';
  });
  if (blocks.length > 0) return blocks[blocks.length - 1];

  return guardrails[guardrails.length - 1] || null;
}

// ─── Phase 4: Causal chain construction ───

function buildCausalChain(primary: ParsedEvent, allEvents: ParsedEvent[]): CausalStep[] {
  const chain: CausalStep[] = [];
  const primarySeq = primary.event.sequence;
  const primaryFiles = new Set(primary.files);

  // Extract file paths from error messages (e.g., "src/foo.ts(12,5): error TS2345")
  const errMsg = primary.errorMessage || '';
  const fileRefs = errMsg.match(/[\w./\\-]+\.\w{1,5}/g) || [];
  for (const ref of fileRefs) {
    primaryFiles.add(shortenPath(ref));
  }

  // Walk backwards from primary error to find causes
  const lookback = allEvents.filter((e) => e.event.sequence < primarySeq);

  // Track what we've found
  let foundRootCause = false;
  const seen = new Set<number>();

  // 1. Find file modifications that led to the error
  for (let i = lookback.length - 1; i >= 0; i--) {
    const ev = lookback[i];
    if (seen.has(ev.event.sequence)) continue;

    if (ev.event.type === 'file_write' || ev.event.type === 'file_delete') {
      const overlap = ev.files.some(
        (f) => primaryFiles.has(f) || [...primaryFiles].some((pf) => f.includes(pf) || pf.includes(f)),
      );
      if (overlap) {
        const isFirst = !chain.some((c) => c.relevance === 'root_cause');
        chain.push({
          sequence: ev.event.sequence,
          type: ev.event.type,
          description: describeEvent(ev),
          timestamp: ev.event.timestamp,
          relevance: isFirst ? 'root_cause' : 'contributing',
          explanation: `Modified ${ev.files.join(', ')} — related to the error`,
        });
        seen.add(ev.event.sequence);
        if (!foundRootCause) foundRootCause = true;

        // Find the LLM call that preceded this file change (the decision)
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (lookback[j].event.type === 'llm_call' && !seen.has(lookback[j].event.sequence)) {
            chain.push({
              sequence: lookback[j].event.sequence,
              type: 'llm_call',
              description: describeEvent(lookback[j]),
              timestamp: lookback[j].event.timestamp,
              relevance: 'context',
              explanation: 'LLM decision that led to the file change',
            });
            seen.add(lookback[j].event.sequence);
            break;
          }
        }
      }
    }
  }

  // 2. Find earlier errors of the same pattern (escalation)
  for (const ev of lookback) {
    if (!ev.isError || seen.has(ev.event.sequence)) continue;
    if (primary.commandStr && ev.commandStr) {
      const baseA = primary.commandStr.split(/\s+/)[0];
      const baseB = ev.commandStr.split(/\s+/)[0];
      if (baseA === baseB) {
        chain.push({
          sequence: ev.event.sequence,
          type: ev.event.type,
          description: describeEvent(ev),
          timestamp: ev.event.timestamp,
          relevance: 'effect',
          explanation: `Earlier occurrence of the same failure (${baseA})`,
        });
        seen.add(ev.event.sequence);
      }
    }
  }

  // 3. Find drift inflection event if relevant
  const driftEvents = allEvents.filter((e) => e.event.drift_score != null && e.event.sequence <= primarySeq);
  if (driftEvents.length >= 2) {
    let biggestDrop = 0;
    let dropEvent: ParsedEvent | null = null;
    for (let i = 1; i < driftEvents.length; i++) {
      const drop = (driftEvents[i - 1].event.drift_score || 100) - (driftEvents[i].event.drift_score || 100);
      if (drop > biggestDrop && !seen.has(driftEvents[i].event.sequence)) {
        biggestDrop = drop;
        dropEvent = driftEvents[i];
      }
    }
    if (dropEvent && biggestDrop >= 10) {
      chain.push({
        sequence: dropEvent.event.sequence,
        type: dropEvent.event.type,
        description: describeEvent(dropEvent),
        timestamp: dropEvent.event.timestamp,
        relevance: 'context',
        explanation: `Drift score dropped by ${biggestDrop} points here`,
      });
    }
  }

  // Add the primary error itself as the final effect
  chain.push({
    sequence: primary.event.sequence,
    type: primary.event.type,
    description: primary.errorMessage || describeEvent(primary),
    timestamp: primary.event.timestamp,
    relevance: 'effect',
    explanation: 'Primary failure',
  });

  // Sort chronologically and deduplicate
  chain.sort((a, b) => a.sequence - b.sequence);

  // If no root cause found in file analysis, mark the first chain event as root_cause
  if (!foundRootCause && chain.length > 1) {
    chain[0].relevance = 'root_cause';
  }

  return chain;
}

// ─── Phase 5: Drift analysis ───

function analyzeDrift(
  parsed: ParsedEvent[],
  snapshots: RcaDriftSnapshot[],
): DriftAnalysis | null {
  // Use event-level drift scores if snapshots are sparse
  const scores: Array<{ sequence: number; score: number }> = [];
  for (const p of parsed) {
    if (p.event.drift_score != null) {
      scores.push({ sequence: p.event.sequence, score: p.event.drift_score });
    }
  }

  if (scores.length < 2) return null;

  const highest = Math.max(...scores.map((s) => s.score));
  const lowest = Math.min(...scores.map((s) => s.score));

  // Determine trend
  const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
  const secondHalf = scores.slice(Math.floor(scores.length / 2));
  const avgFirst = firstHalf.reduce((s, v) => s + v.score, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, v) => s + v.score, 0) / secondHalf.length;

  let trend: DriftAnalysis['trend'];
  const diff = avgSecond - avgFirst;
  if (Math.abs(diff) < 5) trend = 'stable';
  else if (diff < -10) trend = 'declining';
  else if (diff > 10) trend = 'improving';
  else {
    // Check volatility: standard deviation
    const mean = scores.reduce((s, v) => s + v.score, 0) / scores.length;
    const variance = scores.reduce((s, v) => s + (v.score - mean) ** 2, 0) / scores.length;
    trend = Math.sqrt(variance) > 15 ? 'volatile' : diff < 0 ? 'declining' : 'improving';
  }

  // Find the biggest inflection point (largest single drop)
  let inflectionPoint: DriftAnalysis['inflectionPoint'] = null;
  let biggestDrop = 0;
  for (let i = 1; i < scores.length; i++) {
    const drop = scores[i - 1].score - scores[i].score;
    if (drop > biggestDrop && drop >= 8) {
      biggestDrop = drop;
      const triggerEvt = parsed.find((p) => p.event.sequence === scores[i].sequence);
      inflectionPoint = {
        sequence: scores[i].sequence,
        scoreBefore: scores[i - 1].score,
        scoreAfter: scores[i].score,
        triggerDescription: triggerEvt ? describeEvent(triggerEvt) : `Event #${scores[i].sequence}`,
      };
    }
  }

  return { trend, lowestScore: lowest, highestScore: highest, inflectionPoint };
}

// ─── Phase 6: Outcome ───

function determineOutcome(
  session: RcaSession,
  errors: ParsedEvent[],
  guardrails: ParsedEvent[],
  drift: DriftAnalysis | null,
): RcaResult['outcome'] {
  if (session.status === 'aborted') return 'failure';

  const hasErrors = errors.length > 0;
  const hasBlocks = guardrails.some((g) => String(g.parsed.severity || g.parsed.action) === 'block');
  const criticalDrift = drift && drift.lowestScore < 40;

  if (!hasErrors && !hasBlocks && !criticalDrift) return 'success';
  if (hasErrors && errors.length >= 5) return 'failure';
  if (hasBlocks && guardrails.length >= 3) return 'failure';
  if (criticalDrift && drift.trend === 'declining') return 'failure';

  return 'partial';
}

// ─── Phase 7: Suggestions ───

function generateSuggestions(
  session: RcaSession,
  primary: ParsedEvent | null,
  chain: CausalStep[],
  patterns: ErrorPattern[],
  drift: DriftAnalysis | null,
  errors: ParsedEvent[],
  guardrails: ParsedEvent[],
  allEvents: ParsedEvent[],
): string[] {
  const suggestions: string[] = [];

  // Pattern-based suggestions
  for (const pat of patterns.slice(0, 3)) {
    if (pat.count >= 3) {
      const base = pat.pattern.split(' ')[0] || '';
      if (/^(tsc|typescript|ts-node)$/i.test(base)) {
        suggestions.push(`TypeScript compilation failed ${pat.count} times — fix type errors before making more changes. Consider running tsc incrementally after each file edit.`);
      } else if (/^(npm|pnpm|yarn)$/i.test(base)) {
        suggestions.push(`Package manager failed ${pat.count} times — check dependencies and lockfile consistency.`);
      } else if (/^(cargo|rustc)$/i.test(base)) {
        suggestions.push(`Rust compilation failed ${pat.count} times — fix borrow checker / type errors before continuing.`);
      } else if (/^(go|gobuild)$/i.test(base)) {
        suggestions.push(`Go build failed ${pat.count} times — resolve compilation errors.`);
      } else if (/test/i.test(base)) {
        suggestions.push(`Tests failed ${pat.count} times — review test assertions and the code under test.`);
      } else {
        suggestions.push(`"${pat.pattern}" occurred ${pat.count} times — investigate why this keeps failing.`);
      }
    }
  }

  // Primary error suggestions
  if (primary) {
    const msg = (primary.errorMessage || '').toLowerCase();
    if (msg.includes('permission') || msg.includes('eacces')) {
      suggestions.push('Permission denied — check file/directory permissions or run with appropriate privileges.');
    }
    if (msg.includes('not found') || msg.includes('enoent') || msg.includes('no such file')) {
      suggestions.push('File or command not found — verify paths and that required tools are installed.');
    }
    if (msg.includes('timeout') || msg.includes('etimedout')) {
      suggestions.push('Operation timed out — check network connectivity or increase timeout limits.');
    }
    if (msg.includes('out of memory') || msg.includes('enomem') || msg.includes('heap')) {
      suggestions.push('Memory exhaustion — reduce workload or increase memory limits.');
    }
  }

  // Drift-based suggestions
  if (drift) {
    if (drift.trend === 'declining' && drift.lowestScore < 40) {
      const inflection = drift.inflectionPoint
        ? ` starting at event #${drift.inflectionPoint.sequence} (${drift.inflectionPoint.triggerDescription})`
        : '';
      suggestions.push(
        `Agent drifted from objective${inflection}. Score dropped from ${drift.highestScore} to ${drift.lowestScore}. Consider adding guardrails or re-reading the objective more frequently.`,
      );
    }
    if (drift.trend === 'volatile') {
      suggestions.push('Drift score was volatile — agent alternated between on-task and off-task work. Consider breaking the task into smaller sub-objectives.');
    }
  }

  // Guardrail suggestions
  if (guardrails.length > 0) {
    const ruleNames = [...new Set(guardrails.map((g) => String(g.parsed.ruleName || 'unknown')))];
    suggestions.push(`Guardrail${guardrails.length > 1 ? 's' : ''} triggered ${guardrails.length} time${guardrails.length > 1 ? 's' : ''} (${ruleNames.join(', ')}) — review if these rules need adjustment or if the agent should take a different approach.`);
  }

  // Cost suggestion
  if (session.total_cost_usd > 1.0) {
    suggestions.push(`Session cost $${session.total_cost_usd.toFixed(2)} — consider using a smaller model for iterative debugging, or adding cost limits.`);
  }

  // Retry suggestion
  if (errors.length >= 5 && chain.length > 0) {
    suggestions.push('Agent made multiple unsuccessful attempts — it should have stepped back and tried a different approach after 2-3 failures.');
  }

  // High action count with few file changes
  const fileWrites = allEvents.filter((e) => e.event.type === 'file_write').length;
  const llmCalls = allEvents.filter((e) => e.event.type === 'llm_call').length;
  if (llmCalls > 20 && fileWrites < 3) {
    suggestions.push(`${llmCalls} LLM calls but only ${fileWrites} file changes — agent may be stuck in a reasoning loop. Consider a more action-oriented approach.`);
  }

  // Deduplicate
  return [...new Set(suggestions)].slice(0, 6);
}

// ─── Phase 8: Confidence ───

function determineConfidence(
  failures: ParsedEvent[],
  chain: CausalStep[],
  drift: DriftAnalysis | null,
): RcaResult['confidence'] {
  if (failures.length === 0) return 'high'; // No errors = clear success
  if (chain.length >= 3 && chain.some((c) => c.relevance === 'root_cause')) return 'high';
  if (chain.length >= 2) return 'medium';
  return 'low';
}

// ─── Phase 9: Summary ───

function buildSummary(
  session: RcaSession,
  outcome: RcaResult['outcome'],
  primary: ParsedEvent | null,
  patterns: ErrorPattern[],
  drift: DriftAnalysis | null,
  allEvents: ParsedEvent[],
): string {
  const parts: string[] = [];

  // Outcome
  const outcomeStr = outcome === 'success'
    ? 'Session completed successfully'
    : outcome === 'failure'
      ? 'Session failed'
      : outcome === 'partial'
        ? 'Session completed with issues'
        : 'Session outcome unclear';
  parts.push(outcomeStr);

  // Agent and action count
  parts.push(`(${allEvents.length} actions by ${session.agent || 'unknown agent'})`);

  // Primary error
  if (primary) {
    const desc = primary.errorMessage || describeEvent(primary);
    parts.push(`— Primary issue: ${desc.slice(0, 100)}`);
  }

  // Patterns
  if (patterns.length > 0 && patterns[0].count >= 3) {
    parts.push(`(${patterns[0].pattern}: ${patterns[0].count}x)`);
  }

  // Drift
  if (drift && drift.trend === 'declining') {
    parts.push(`Drift: ${drift.highestScore} → ${drift.lowestScore}`);
  }

  return parts.join('. ').replace(/\.\./g, '.').replace(/\s+/g, ' ').trim();
}

// ─── Event description helper ───

function describeEvent(ev: ParsedEvent): string {
  switch (ev.event.type) {
    case 'command':
      return ev.commandStr
        ? `${ev.commandStr.slice(0, 80)}${ev.exitCode ? ` → exit ${ev.exitCode}` : ''}`
        : 'Command';
    case 'file_write':
      return `Modified ${ev.files[0] || 'file'}`;
    case 'file_delete':
      return `Deleted ${ev.files[0] || 'file'}`;
    case 'file_read':
      return `Read ${ev.files[0] || 'file'}`;
    case 'llm_call': {
      const model = String(ev.parsed.model || 'unknown');
      const provider = String(ev.parsed.provider || '');
      return `${provider}/${model}`;
    }
    case 'guardrail_trigger':
    case 'guardrail_block':
      return String(ev.parsed.description || ev.parsed.ruleName || 'Guardrail triggered');
    case 'error':
      return String(ev.parsed.message || 'Error');
    default:
      return ev.event.type;
  }
}

// ─── LLM prompt builder ───

export function buildRcaPrompt(
  session: RcaSession,
  events: RcaEvent[],
  heuristicResult: RcaResult,
): string {
  // Condense event timeline
  const timeline = events
    .slice(0, 200)
    .map((e) => {
      const p = parseEvent(e);
      const drift = e.drift_score != null ? ` [drift:${e.drift_score}]` : '';
      const flag = p.isError ? ' [ERROR]' : p.isGuardrail ? ' [BLOCKED]' : '';
      return `#${e.sequence} ${e.type}: ${describeEvent(p)}${drift}${flag}`;
    })
    .join('\n');

  // Error details
  const errorDetail = heuristicResult.errorPatterns
    .map((p) => `  - "${p.pattern}" (${p.count}x, at events ${p.sequences.join(', ')})`)
    .join('\n') || '  None';

  // Causal chain
  const chain = heuristicResult.causalChain
    .map((c) => `  #${c.sequence} [${c.relevance}] ${c.type}: ${c.description} — ${c.explanation}`)
    .join('\n') || '  Not determined';

  // Drift
  const driftInfo = heuristicResult.driftAnalysis
    ? `Trend: ${heuristicResult.driftAnalysis.trend}, Range: ${heuristicResult.driftAnalysis.lowestScore}-${heuristicResult.driftAnalysis.highestScore}${heuristicResult.driftAnalysis.inflectionPoint ? `, Inflection at #${heuristicResult.driftAnalysis.inflectionPoint.sequence} (${heuristicResult.driftAnalysis.inflectionPoint.scoreBefore} → ${heuristicResult.driftAnalysis.inflectionPoint.scoreAfter})` : ''}`
    : 'No drift data';

  return `You are an expert debugger analyzing an AI coding agent session. Perform root cause analysis.

SESSION:
- Objective: "${session.objective}"
- Agent: ${session.agent}
- Status: ${session.status}
- Cost: $${session.total_cost_usd.toFixed(4)}
- Final drift: ${session.final_drift_score ?? 'N/A'}/100
- Outcome (heuristic): ${heuristicResult.outcome}

EVENT TIMELINE (condensed):
${timeline}

ERROR PATTERNS:
${errorDetail}

CAUSAL CHAIN (heuristic):
${chain}

DRIFT:
${driftInfo}

Analyze this session and respond in JSON:
{
  "summary": "1-2 paragraph natural language summary of what happened and why",
  "rootCause": "The specific root cause of the primary failure (or 'N/A' if successful)",
  "suggestions": ["actionable suggestion 1", "actionable suggestion 2", "actionable suggestion 3"]
}

Be specific. Reference event numbers and file names. Focus on the WHY, not the WHAT.`;
}

export interface RcaLlmResult {
  summary: string;
  rootCause: string;
  suggestions: string[];
}

export function parseRcaResponse(text: string): RcaLlmResult | null {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.summary && parsed.rootCause && Array.isArray(parsed.suggestions)) {
      return parsed as RcaLlmResult;
    }
    return null;
  } catch {
    return null;
  }
}
