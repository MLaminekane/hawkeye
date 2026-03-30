import { v4 as uuid } from 'uuid';
import { execSync } from 'node:child_process';
import { Storage } from './storage/sqlite.js';
import { createTerminalInterceptor, type TerminalInterceptor } from './interceptors/terminal.js';
import {
  createFilesystemInterceptor,
  type FilesystemInterceptor,
} from './interceptors/filesystem.js';
import {
  createNetworkInterceptor,
  type NetworkInterceptor,
  type NetworkLockConfig,
} from './interceptors/network.js';
import { createDriftEngine, type DriftEngine, type DriftCheckResult } from './drift/engine.js';
import { createGuardrailEnforcer, type GuardrailEnforcer } from './guardrails/enforcer.js';
import type { GuardrailRuleConfig, GuardrailViolation } from './guardrails/rules.js';
import { Logger } from './logger.js';
import type { SessionRow, EventRow } from './storage/sqlite.js';
import type {
  AgentSession,
  TraceEvent,
  CommandEvent,
  FileEvent,
  LlmEvent,
  ApiEvent,
  DriftConfig,
  Result,
  EventType,
} from './types.js';

const logger = new Logger('recorder');

export interface RecorderOptions {
  objective: string;
  agent: string;
  model?: string;
  workingDir: string;
  dbPath: string;
  sessionId?: string;
  ignoredPaths?: string[];
  captureNetwork?: boolean;
  capturePrompts?: boolean;
  maxStdoutBytes?: number;
  drift?: DriftConfig;
  guardrails?: {
    enabled: boolean;
    rules: GuardrailRuleConfig[];
  };
}

export type EventHandler = (event: TraceEvent) => void;
export type DriftAlertHandler = (result: DriftCheckResult) => void;
export type GuardrailViolationHandler = (violation: GuardrailViolation) => void;
export type ReviewGateHandler = (
  violation: GuardrailViolation,
  event: TraceEvent,
) => Promise<'approve' | 'deny' | 'skip'>;

export interface Recorder {
  readonly sessionId: string;
  readonly session: AgentSession;
  start(): void;
  stop(status?: 'completed' | 'aborted'): Result<void>;
  pause(): void;
  resume(): void;
  getTerminalInterceptor(): TerminalInterceptor;
  recordCommandEvent(event: CommandEvent): void;
  recordLlmEvent(event: LlmEvent): void;
  onEvent(handler: EventHandler): () => void;
  onDriftAlert(handler: DriftAlertHandler): void;
  onGuardrailViolation(handler: GuardrailViolationHandler): void;
  onReviewGate(handler: ReviewGateHandler): void;
  getSession(id: string): Result<SessionRow | null>;
  getEvents(sessionId: string, options?: { type?: EventType; limit?: number }): Result<EventRow[]>;
  getSessions(options?: { limit?: number; status?: string }): Result<SessionRow[]>;
}

function getGitInfo(cwd: string): { branch?: string; commit?: string } {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commit = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { branch, commit };
  } catch {
    return {};
  }
}

const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  enabled: true,
  checkEvery: 5,
  provider: 'ollama',
  model: 'llama3.2',
  thresholds: { warning: 60, critical: 30 },
  contextWindow: 10,
  autoPause: false,
  ollamaUrl: 'http://localhost:11434',
  lmstudioUrl: 'http://localhost:1234/v1',
};

export function createRecorder(options: RecorderOptions): Recorder {
  const storage = new Storage(options.dbPath);
  const resuming = !!options.sessionId;
  const sessionId = options.sessionId || uuid();
  const gitInfo = getGitInfo(options.workingDir);

  // Detect developer from git config
  let developer: string | undefined;
  try {
    developer = execSync('git config user.name', {
      encoding: 'utf-8',
      cwd: options.workingDir,
      timeout: 3000,
    }).trim();
  } catch {
    developer = process.env.USER || process.env.USERNAME;
  }

  const session: AgentSession = {
    id: sessionId,
    objective: options.objective,
    startedAt: new Date(),
    status: 'recording',
    metadata: {
      agent: options.agent,
      model: options.model,
      workingDir: options.workingDir,
      gitBranch: gitInfo.branch,
      gitCommitBefore: gitInfo.commit,
      developer,
    },
    totalCostUsd: 0,
    totalTokens: 0,
    totalActions: 0,
  };

  const recentEvents: TraceEvent[] = [];
  let fsInterceptor: FilesystemInterceptor | null = null;
  let terminalInterceptor: TerminalInterceptor | null = null;
  let networkInterceptor: NetworkInterceptor | null = null;
  let driftEngine: DriftEngine | null = null;
  let guardrailEnforcer: GuardrailEnforcer | null = null;
  let totalCostUsd = 0;
  let totalTokens = 0;
  let paused = false;

  const eventHandlers: EventHandler[] = [];
  const driftAlertHandlers: DriftAlertHandler[] = [];
  const guardrailViolationHandlers: GuardrailViolationHandler[] = [];
  let reviewGateHandler: ReviewGateHandler | null = null;
  const reviewGateAllowlist: Set<string> = new Set();

  function recordEvent(
    type: TraceEvent['type'],
    data: TraceEvent['data'],
    durationMs: number = 0,
    costUsd: number = 0,
  ): void {
    if (paused) {
      logger.debug(`Event skipped (paused): ${type}`);
      return;
    }

    const sequence = storage.getNextSequence(sessionId);
    const event: TraceEvent = {
      id: uuid(),
      sessionId,
      timestamp: new Date(),
      sequence,
      type,
      data,
      durationMs,
      costUsd,
    };

    // Update session aggregates
    session.totalActions++;
    if (costUsd) {
      totalCostUsd += costUsd;
      session.totalCostUsd = totalCostUsd;
    }
    if (type === 'llm_call' && 'totalTokens' in data) {
      totalTokens += (data as LlmEvent).totalTokens;
      session.totalTokens = totalTokens;
    }

    // Guardrails check (synchronous, before persisting)
    if (guardrailEnforcer) {
      const violations = guardrailEnforcer.evaluate(event);
      for (const v of violations) {
        if (v.actionTaken === 'pending_review') {
          // Check if this pattern is already in the session-level allowlist
          if (v.matchedPattern && reviewGateAllowlist.has(v.matchedPattern)) {
            logger.info(`Review gate auto-approved (allowlisted): ${v.matchedPattern}`);
            continue;
          }

          // Persist violation as pending_review
          storage.insertGuardrailViolation(sessionId, event.id, v);

          for (const handler of guardrailViolationHandlers) {
            handler(v);
          }

          // If a review gate handler is registered, trigger async approval
          if (reviewGateHandler) {
            const handler = reviewGateHandler;
            handler(v, event)
              .then((decision) => {
                if (decision === 'approve') {
                  // Add pattern to session-level allowlist for future events
                  if (v.matchedPattern) {
                    reviewGateAllowlist.add(v.matchedPattern);
                  }
                  logger.info(`Review gate approved: ${v.description}`);
                } else if (decision === 'deny') {
                  // Mark the event as blocked retroactively
                  logger.warn(`Review gate denied: ${v.description}`);
                  // Insert a guardrail_trigger event to record the denial
                  const denySeq = storage.getNextSequence(sessionId);
                  storage.insertEvent({
                    id: uuid(),
                    sessionId,
                    timestamp: new Date(),
                    sequence: denySeq,
                    type: 'guardrail_trigger',
                    data: {
                      ruleName: v.ruleName,
                      severity: v.severity,
                      description: v.description,
                      blockedAction: type,
                      originalType: type,
                    } as unknown as TraceEvent['data'],
                    durationMs: 0,
                    costUsd: 0,
                  });
                } else {
                  // 'skip' — allow just this once, no allowlist addition
                  logger.info(`Review gate skipped (one-time allow): ${v.description}`);
                }
              })
              .catch((err) => {
                logger.error(`Review gate handler error: ${String(err)}`);
              });
          } else {
            // No handler registered — treat as blocked (safe default)
            logger.warn(`Event blocked by review gate (no handler): ${v.description}`);
            event.type = 'guardrail_trigger';
            event.data = {
              ...(event.data as unknown as Record<string, unknown>),
              ruleName: v.ruleName,
              severity: v.severity,
              description: v.description,
              blockedAction: type,
              originalType: type,
            } as typeof event.data;
          }
          continue;
        }

        // Persist violation
        storage.insertGuardrailViolation(sessionId, event.id, v);

        for (const handler of guardrailViolationHandlers) {
          handler(v);
        }

        if (v.actionTaken === 'blocked') {
          logger.warn(`Event blocked by guardrail: ${v.description}`);
          event.type = 'guardrail_trigger';
          // Enrich data with violation details for dashboard display
          event.data = {
            ...(event.data as unknown as Record<string, unknown>),
            ruleName: v.ruleName,
            severity: v.severity,
            description: v.description,
            blockedAction: type,
            originalType: type,
          } as typeof event.data;
        }
      }

      // Cost limit check
      const costViolation = guardrailEnforcer.checkCostLimit(totalCostUsd, session.startedAt);
      if (costViolation) {
        storage.insertGuardrailViolation(sessionId, event.id, costViolation);
        for (const handler of guardrailViolationHandlers) {
          handler(costViolation);
        }
      }

      // Token limit check
      if (type === 'llm_call' && 'totalTokens' in data) {
        const tokenViolation = guardrailEnforcer.checkTokenLimit(totalTokens);
        if (tokenViolation) {
          storage.insertGuardrailViolation(sessionId, event.id, tokenViolation);
          for (const handler of guardrailViolationHandlers) {
            handler(tokenViolation);
          }
        }
      }
    }

    const result = storage.insertEvent(event);
    if (!result.ok) {
      logger.error(`Failed to insert event: ${result.error.message}`);
      return;
    }

    logger.debug(`Event #${sequence} [${type}] recorded`);

    // Notify event subscribers
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch {}
    }

    // Track for drift detection
    recentEvents.push(event);
    if (recentEvents.length > (options.drift?.contextWindow ?? 10) * 2) {
      recentEvents.splice(0, recentEvents.length - (options.drift?.contextWindow ?? 10) * 2);
    }

    // Drift check (async, non-blocking)
    if (driftEngine) {
      driftEngine.processEvent(event, recentEvents).catch((err) => {
        logger.error(`Drift check error: ${String(err)}`);
      });
    }
  }

  return {
    get sessionId() {
      return sessionId;
    },

    get session() {
      return session;
    },

    recordCommandEvent(event: CommandEvent): void {
      recordEvent('command', event);
    },

    recordLlmEvent(event: LlmEvent): void {
      recordEvent('llm_call', event, event.latencyMs, event.costUsd);
    },

    pause(): void {
      if (paused) return;
      paused = true;
      session.status = 'paused';
      logger.info('Session paused');
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      session.status = 'recording';
      logger.info('Session resumed');
    },

    onEvent(handler: EventHandler): () => void {
      eventHandlers.push(handler);
      return () => {
        const idx = eventHandlers.indexOf(handler);
        if (idx >= 0) eventHandlers.splice(idx, 1);
      };
    },

    onDriftAlert(handler: DriftAlertHandler): void {
      driftAlertHandlers.push(handler);
    },

    onGuardrailViolation(handler: GuardrailViolationHandler): void {
      guardrailViolationHandlers.push(handler);
    },

    onReviewGate(handler: ReviewGateHandler): void {
      reviewGateHandler = handler;
    },

    start() {
      logger.info(`Starting session ${sessionId}`);
      logger.info(`Objective: ${options.objective}`);

      if (resuming) {
        // Resume existing session — set status back to recording
        storage.updateSessionStatus(sessionId, 'recording');
        logger.info(`Resuming existing session ${sessionId}`);
      } else {
        const createResult = storage.createSession(session);
        if (!createResult.ok) {
          logger.error(`Failed to create session: ${createResult.error.message}`);
          return;
        }
      }

      // Initialize DriftDetect
      const driftConfig = options.drift ?? DEFAULT_DRIFT_CONFIG;
      if (driftConfig.enabled) {
        driftEngine = createDriftEngine(driftConfig, options.objective, options.workingDir);
        driftEngine.onAlert((result, eventId) => {
          // Persist drift snapshot
          storage.insertDriftSnapshot(sessionId, eventId, result);

          for (const handler of driftAlertHandlers) {
            handler(result);
          }

          // Auto-pause on critical drift if configured
          if (driftConfig.autoPause && result.flag === 'critical' && !paused) {
            logger.warn(`Auto-pausing session due to critical drift (score=${result.score})`);
            paused = true;
            session.status = 'paused';
          }
        });
        logger.info('DriftDetect enabled');
      }

      // Initialize Guardrails
      if (options.guardrails?.enabled && options.guardrails.rules.length > 0) {
        guardrailEnforcer = createGuardrailEnforcer(options.guardrails.rules, options.workingDir);
        logger.info(`Guardrails enabled (${options.guardrails.rules.length} rules)`);
      }

      // Filesystem interceptor
      fsInterceptor = createFilesystemInterceptor(
        options.workingDir,
        (fileEvent: FileEvent) => {
          const typeMap: Record<string, TraceEvent['type']> = {
            read: 'file_read',
            write: 'file_write',
            delete: 'file_delete',
            rename: 'file_rename',
          };
          recordEvent(typeMap[fileEvent.action] || 'file_write', fileEvent);
        },
        options.ignoredPaths,
      );
      fsInterceptor.start();

      // Terminal interceptor
      terminalInterceptor = createTerminalInterceptor(
        (cmdEvent: CommandEvent) => {
          recordEvent('command', cmdEvent);
        },
        { maxStdoutBytes: options.maxStdoutBytes },
      );

      // Network interceptor (captures LLM calls and API calls)
      if (options.captureNetwork !== false) {
        // Extract network_lock config from guardrails if present
        let networkLockConfig: NetworkLockConfig | undefined;
        if (options.guardrails?.enabled) {
          const networkLockRule = options.guardrails.rules.find(
            (r) => r.type === 'network_lock',
          ) as import('./guardrails/rules.js').NetworkLockRule | undefined;
          if (networkLockRule) {
            networkLockConfig = {
              enabled: true,
              action: networkLockRule.action,
              allowedHosts: networkLockRule.allowedHosts,
              blockedHosts: networkLockRule.blockedHosts,
            };
          }
        }

        networkInterceptor = createNetworkInterceptor(
          (llmEvent: LlmEvent) => {
            recordEvent('llm_call', llmEvent, llmEvent.latencyMs, llmEvent.costUsd);
          },
          (apiEvent: ApiEvent) => {
            recordEvent('api_call', apiEvent, apiEvent.latencyMs);
          },
          {
            capturePrompts: options.capturePrompts,
            networkLockRules: networkLockConfig,
            onNetworkBlock: (hostname: string, url: string, reason: string) => {
              // Record a guardrail_trigger event for the blocked request
              recordEvent('guardrail_trigger', {
                ruleName: 'network_lock',
                severity: 'block',
                description: reason,
                blockedAction: `api_call: ${url}`,
                originalType: 'api_call',
              } as unknown as TraceEvent['data']);

              // Persist guardrail violation
              if (guardrailEnforcer) {
                const violation = {
                  ruleName: 'network_lock',
                  severity: 'block' as const,
                  description: reason,
                  actionTaken: 'blocked' as const,
                };
                storage.insertGuardrailViolation(sessionId, uuid(), violation);
                for (const handler of guardrailViolationHandlers) {
                  handler(violation);
                }
              }
            },
          },
        );
        networkInterceptor.install();
        logger.info('Network interceptor enabled');
        if (networkLockConfig?.enabled) {
          logger.info(
            `Network lock active: ${networkLockConfig.allowedHosts.length} allowed, ${networkLockConfig.blockedHosts.length} blocked`,
          );
        }
      }

      logger.info('Recording started');
    },

    stop(status: 'completed' | 'aborted' = 'completed'): Result<void> {
      logger.info(`Stopping session ${sessionId} (${status})`);

      fsInterceptor?.stop();
      terminalInterceptor?.destroy();
      networkInterceptor?.uninstall();

      // Save final drift score
      if (driftEngine) {
        const finalScore = driftEngine.getSlidingScore();
        session.finalDriftScore = finalScore;
        storage.updateFinalDriftScore(sessionId, finalScore);
        logger.info(`Final drift score: ${finalScore}`);
      }

      const gitAfter = getGitInfo(options.workingDir);
      const result = storage.endSession(sessionId, status, gitAfter.commit);

      storage.close();

      if (result.ok) {
        logger.info('Session saved');
      }

      return result;
    },

    getTerminalInterceptor(): TerminalInterceptor {
      if (!terminalInterceptor) {
        throw new Error('Recorder not started. Call start() first.');
      }
      return terminalInterceptor;
    },

    getSession(id: string): Result<SessionRow | null> {
      return storage.getSession(id);
    },

    getEvents(sid: string, opts?: { type?: EventType; limit?: number }): Result<EventRow[]> {
      return storage.getEvents(sid, opts);
    },

    getSessions(opts?: { limit?: number; status?: string }): Result<SessionRow[]> {
      return storage.listSessions(opts);
    },
  };
}
