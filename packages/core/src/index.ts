export type {
  AgentSession,
  SessionMetadata,
  EventType,
  DriftFlag,
  TraceEvent,
  CommandEvent,
  FileEvent,
  ApiEvent,
  LlmEvent,
  DecisionEvent,
  GitEvent,
  ErrorEvent,
  GuardrailEventData,
  DriftAlertEventData,
  Result,
  GuardrailRule,
  DriftConfig,
  AppConfig,
} from './types.js';

export { Storage } from './storage/sqlite.js';
export type { SessionRow, EventRow, GlobalStats, GuardrailViolationRow, SessionStats, SessionComparison } from './storage/sqlite.js';

export { createRecorder } from './recorder.js';
export type { Recorder, RecorderOptions, EventHandler, DriftAlertHandler, GuardrailViolationHandler } from './recorder.js';

export { createTerminalInterceptor } from './interceptors/terminal.js';
export type { TerminalInterceptor, TerminalInterceptorOptions, CommandCallback } from './interceptors/terminal.js';

export { createFilesystemInterceptor } from './interceptors/filesystem.js';
export type { FilesystemInterceptor, FilesystemInterceptorOptions, FileCallback } from './interceptors/filesystem.js';

export { createNetworkInterceptor } from './interceptors/network.js';
export type { NetworkInterceptor, LlmCallback, ApiCallback } from './interceptors/network.js';

export { estimateCost, COST_TABLE, LLM_ENDPOINTS } from './interceptors/llm.js';
export type { TokenInfo, LlmEndpointConfig } from './interceptors/llm.js';

export { createDriftEngine } from './drift/engine.js';
export type { DriftEngine, DriftCheckResult, DriftAlertCallback } from './drift/engine.js';

export { scoreHeuristic, slidingDriftScore } from './drift/scorer.js';
export type { DriftResult } from './drift/scorer.js';

export { buildDriftPrompt, parseDriftResponse } from './drift/prompts.js';
export type { DriftLlmResponse } from './drift/prompts.js';

export { createGuardrailEnforcer } from './guardrails/enforcer.js';
export type { GuardrailEnforcer, ViolationCallback } from './guardrails/enforcer.js';

export type {
  GuardrailRuleConfig,
  GuardrailViolation,
  FileProtectRule,
  CommandBlockRule,
  CostLimitRule,
  TokenLimitRule,
  DirectoryScopeRule,
  NetworkLockRule,
  ReviewGateRule,
} from './guardrails/rules.js';

export { Logger } from './logger.js';
