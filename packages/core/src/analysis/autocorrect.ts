/**
 * Autonomous Control Layer — Autocorrect Engine.
 *
 * Hawkeye becomes an active co-pilot: when drift, errors, or cost issues are
 * detected, the engine decides AND executes corrections automatically.
 *
 * Executable correction types:
 * - rollback_file: git checkout -- <file> to revert problematic changes
 * - pause_session: freeze the session and write a correction plan
 * - inject_hint: write .hawkeye/active-correction.json for MCP-aware agents
 * - block_pattern: dynamically add a guardrail to prevent repeat failures
 * - notify: fire webhooks with correction details
 */

import { execFileSync } from 'node:child_process';

// ─── Types ───

export type CorrectionType =
  | 'rollback_file'
  | 'pause_session'
  | 'inject_hint'
  | 'block_pattern'
  | 'notify';

export interface ExecutableCorrection {
  type: CorrectionType;
  target: string;
  description: string;
  reasoning: string;
}

export interface CorrectionRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  trigger: 'drift_critical' | 'drift_warning' | 'error_repeat' | 'cost_threshold' | 'manual';
  assessment: {
    driftScore: number | null;
    driftFlag: string;
    errorCount: number;
    recurringErrors: number;
    costPercent: number | null;
  };
  corrections: ExecutedCorrection[];
  dryRun: boolean;
}

export interface ExecutedCorrection extends ExecutableCorrection {
  executed: boolean;
  result: 'success' | 'failed' | 'skipped';
  error?: string;
}

export interface CorrectionHint {
  sessionId: string;
  timestamp: string;
  trigger: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  diagnosis: string;
  corrections: Array<{
    type: string;
    description: string;
    reasoning: string;
    executed: boolean;
  }>;
  agentInstructions: string;
}

export interface AutocorrectConfig {
  enabled: boolean;
  dryRun: boolean;
  triggers: {
    driftCritical: boolean;
    errorRepeat: number;
    costThreshold: number;
  };
  actions: {
    rollbackFiles: boolean;
    pauseSession: boolean;
    injectHint: boolean;
    blockPattern: boolean;
  };
}

export interface AutocorrectContext {
  sessionId: string;
  workingDir: string;
  objective: string;
  driftScore: number | null;
  driftFlag: string;
  driftTrend: 'stable' | 'declining' | 'improving';
  totalCost: number;
  costBudget: number | null;
  errorPatterns: Array<{ pattern: string; count: number }>;
  filesChanged: string[];
  recentEvents: Array<{ type: string; data: string }>;
}

// ─── Default config ───

export function getDefaultAutocorrectConfig(): AutocorrectConfig {
  return {
    enabled: false,
    dryRun: false,
    triggers: {
      driftCritical: true,
      errorRepeat: 3,
      costThreshold: 85,
    },
    actions: {
      rollbackFiles: true,
      pauseSession: true,
      injectHint: true,
      blockPattern: true,
    },
  };
}

// ─── Decision engine ───

export function shouldTriggerAutocorrect(
  ctx: AutocorrectContext,
  config: AutocorrectConfig,
): { shouldTrigger: boolean; trigger: CorrectionRecord['trigger']; reason: string } {
  if (!config.enabled) {
    return { shouldTrigger: false, trigger: 'manual', reason: 'autocorrect disabled' };
  }

  // Drift critical
  if (config.triggers.driftCritical && ctx.driftFlag === 'critical') {
    return {
      shouldTrigger: true,
      trigger: 'drift_critical',
      reason: `Drift score critical (${ctx.driftScore}/100)`,
    };
  }

  // Drift warning + declining trend
  if (ctx.driftFlag === 'warning' && ctx.driftTrend === 'declining') {
    return {
      shouldTrigger: true,
      trigger: 'drift_warning',
      reason: `Drift declining (${ctx.driftScore}/100, trend: declining)`,
    };
  }

  // Repeated errors
  if (config.triggers.errorRepeat > 0) {
    const maxRepeat = Math.max(0, ...ctx.errorPatterns.map((p) => p.count));
    if (maxRepeat >= config.triggers.errorRepeat) {
      return {
        shouldTrigger: true,
        trigger: 'error_repeat',
        reason: `Error repeated ${maxRepeat} times (threshold: ${config.triggers.errorRepeat})`,
      };
    }
  }

  // Cost threshold
  if (config.triggers.costThreshold > 0 && ctx.costBudget && ctx.costBudget > 0) {
    const pct = (ctx.totalCost / ctx.costBudget) * 100;
    if (pct >= config.triggers.costThreshold) {
      return {
        shouldTrigger: true,
        trigger: 'cost_threshold',
        reason: `Cost at ${Math.round(pct)}% of budget (threshold: ${config.triggers.costThreshold}%)`,
      };
    }
  }

  return { shouldTrigger: false, trigger: 'manual', reason: 'no trigger conditions met' };
}

// ─── Correction planner ───

export function planCorrections(
  ctx: AutocorrectContext,
  config: AutocorrectConfig,
  trigger: CorrectionRecord['trigger'],
): ExecutableCorrection[] {
  const corrections: ExecutableCorrection[] = [];

  // 1. Rollback problematic files (drift-related)
  if (config.actions.rollbackFiles && (trigger === 'drift_critical' || trigger === 'drift_warning')) {
    // Find files modified recently that may have caused drift
    // Prioritize: non-test files, files with errors, recently modified
    const suspiciousFiles = ctx.filesChanged
      .filter((f) => !f.includes('node_modules') && !f.includes('.hawkeye'))
      .slice(-3); // Last 3 modified files

    if (suspiciousFiles.length > 0) {
      for (const file of suspiciousFiles) {
        corrections.push({
          type: 'rollback_file',
          target: file,
          description: `Rollback ${file} to pre-session state`,
          reasoning: `File was modified during drift ${trigger === 'drift_critical' ? 'crisis' : 'decline'}. Reverting to prevent further damage.`,
        });
      }
    }
  }

  // 2. Block failing command patterns
  if (config.actions.blockPattern && trigger === 'error_repeat') {
    for (const ep of ctx.errorPatterns.filter((p) => p.count >= (config.triggers.errorRepeat || 3))) {
      // Extract command pattern from error
      const cmdMatch = ep.pattern.match(/command failed.*?:\s*(.+)/i);
      if (cmdMatch) {
        corrections.push({
          type: 'block_pattern',
          target: cmdMatch[1].slice(0, 60),
          description: `Block command pattern: "${cmdMatch[1].slice(0, 60)}"`,
          reasoning: `This command has failed ${ep.count} times. Blocking to prevent further retries.`,
        });
      }
    }
  }

  // 3. Inject correction hint (always, for MCP-aware agents)
  if (config.actions.injectHint) {
    let instruction = '';
    if (trigger === 'drift_critical') {
      instruction = `CRITICAL: You have drifted far from the objective. STOP your current approach. Re-read the objective: "${ctx.objective.slice(0, 200)}". Change strategy completely.`;
    } else if (trigger === 'drift_warning') {
      instruction = `WARNING: Your drift score is declining. Verify your current approach aligns with: "${ctx.objective.slice(0, 200)}". Consider changing direction.`;
    } else if (trigger === 'error_repeat') {
      const patterns = ctx.errorPatterns.filter((p) => p.count >= 2).map((p) => p.pattern);
      instruction = `STOP RETRYING: These errors keep repeating: ${patterns.join('; ')}. Try a completely different approach.`;
    } else if (trigger === 'cost_threshold') {
      const pct = ctx.costBudget ? Math.round((ctx.totalCost / ctx.costBudget) * 100) : 0;
      instruction = `BUDGET ALERT: ${pct}% of budget consumed. Focus only on the most critical remaining work. Skip nice-to-haves.`;
    }

    if (instruction) {
      corrections.push({
        type: 'inject_hint',
        target: '.hawkeye/active-correction.json',
        description: 'Write correction hint for MCP-aware agents',
        reasoning: instruction,
      });
    }
  }

  // 4. Pause session (last resort for critical situations)
  if (config.actions.pauseSession && trigger === 'drift_critical') {
    corrections.push({
      type: 'pause_session',
      target: ctx.sessionId,
      description: 'Pause session to prevent further damage',
      reasoning: 'Drift is critical — freezing session until human reviews or agent self-corrects via MCP.',
    });
  }

  // 5. Always notify
  corrections.push({
    type: 'notify',
    target: 'webhooks',
    description: `Fire autocorrect webhook: ${trigger}`,
    reasoning: `Autocorrect triggered by ${trigger}. Notifying external systems.`,
  });

  return corrections;
}

// ─── Correction executor ───

export function executeCorrection(
  correction: ExecutableCorrection,
  workingDir: string,
  dryRun: boolean,
): ExecutedCorrection {
  if (dryRun) {
    return { ...correction, executed: false, result: 'skipped', error: 'dry run mode' };
  }

  try {
    switch (correction.type) {
      case 'rollback_file': {
        // git checkout -- <file> to revert to last committed state
        execFileSync('git', ['checkout', '--', correction.target], {
          cwd: workingDir,
          timeout: 10000,
          stdio: 'pipe',
        });
        return { ...correction, executed: true, result: 'success' };
      }

      case 'pause_session': {
        // Pause is handled by the caller (hook-handler/serve) via storage.pauseSession()
        // We just signal it should happen
        return { ...correction, executed: true, result: 'success' };
      }

      case 'inject_hint': {
        // Hint file is written by the caller with full context
        return { ...correction, executed: true, result: 'success' };
      }

      case 'block_pattern': {
        // Dynamic guardrail is added by the caller to the config
        return { ...correction, executed: true, result: 'success' };
      }

      case 'notify': {
        // Webhook firing is handled by the caller
        return { ...correction, executed: true, result: 'success' };
      }

      default:
        return { ...correction, executed: false, result: 'skipped', error: 'unknown correction type' };
    }
  } catch (err) {
    return {
      ...correction,
      executed: false,
      result: 'failed',
      error: String(err),
    };
  }
}

// ─── Full pipeline ───

export function evaluateAndCorrect(
  ctx: AutocorrectContext,
  config: AutocorrectConfig,
): CorrectionRecord | null {
  const { shouldTrigger, trigger, reason } = shouldTriggerAutocorrect(ctx, config);
  if (!shouldTrigger) return null;

  const planned = planCorrections(ctx, config, trigger);
  if (planned.length === 0) return null;

  // Execute each correction
  const executed: ExecutedCorrection[] = [];
  for (const correction of planned) {
    // rollback_file is the only one we execute directly — others are signaled
    if (correction.type === 'rollback_file') {
      executed.push(executeCorrection(correction, ctx.workingDir, config.dryRun));
    } else {
      // Mark as executed (caller handles the actual action)
      executed.push({ ...correction, executed: !config.dryRun, result: config.dryRun ? 'skipped' : 'success' });
    }
  }

  const costPct = ctx.costBudget && ctx.costBudget > 0
    ? (ctx.totalCost / ctx.costBudget) * 100
    : null;

  return {
    id: '', // caller assigns UUID
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    trigger,
    assessment: {
      driftScore: ctx.driftScore,
      driftFlag: ctx.driftFlag,
      errorCount: ctx.errorPatterns.reduce((sum, p) => sum + p.count, 0),
      recurringErrors: ctx.errorPatterns.filter((p) => p.count >= 2).length,
      costPercent: costPct ? Math.round(costPct) : null,
    },
    corrections: executed,
    dryRun: config.dryRun,
  };
}

// ─── Hint builder ───

export function buildCorrectionHint(record: CorrectionRecord, objective: string): CorrectionHint {
  const urgencyMap: Record<string, CorrectionHint['urgency']> = {
    drift_critical: 'critical',
    drift_warning: 'high',
    error_repeat: 'high',
    cost_threshold: 'medium',
    manual: 'medium',
  };

  const hintCorrection = record.corrections.find((c) => c.type === 'inject_hint');
  const agentInstructions = hintCorrection?.reasoning || 'Review your approach and correct course.';

  return {
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    trigger: record.trigger,
    urgency: urgencyMap[record.trigger] || 'medium',
    diagnosis: buildDiagnosis(record),
    corrections: record.corrections
      .filter((c) => c.type !== 'notify')
      .map((c) => ({
        type: c.type,
        description: c.description,
        reasoning: c.reasoning,
        executed: c.executed,
      })),
    agentInstructions,
  };
}

function buildDiagnosis(record: CorrectionRecord): string {
  const parts: string[] = [];
  const a = record.assessment;
  if (a.driftFlag !== 'ok') parts.push(`drift ${a.driftFlag} (${a.driftScore}/100)`);
  if (a.recurringErrors > 0) parts.push(`${a.recurringErrors} recurring error patterns`);
  if (a.costPercent !== null && a.costPercent > 70) parts.push(`${a.costPercent}% budget used`);
  return parts.length > 0 ? parts.join(', ') : 'autocorrect triggered';
}
