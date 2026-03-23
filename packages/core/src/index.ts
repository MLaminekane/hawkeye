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
export type { SessionRow, EventRow, GlobalStats, GuardrailViolationRow, SessionStats, SessionComparison, DeveloperAnalytics, MemoryItemRow, IncidentRow, CorrectionRow } from './storage/sqlite.js';

export { createRecorder } from './recorder.js';
export type { Recorder, RecorderOptions, EventHandler, DriftAlertHandler, GuardrailViolationHandler, ReviewGateHandler } from './recorder.js';

export { createTerminalInterceptor } from './interceptors/terminal.js';
export type { TerminalInterceptor, TerminalInterceptorOptions, CommandCallback } from './interceptors/terminal.js';

export { createFilesystemInterceptor } from './interceptors/filesystem.js';
export type { FilesystemInterceptor, FilesystemInterceptorOptions, FileCallback } from './interceptors/filesystem.js';

export { createNetworkInterceptor } from './interceptors/network.js';
export type { NetworkInterceptor, LlmCallback, ApiCallback, NetworkBlockCallback, NetworkLockConfig } from './interceptors/network.js';

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
  PiiFilterRule,
  PromptShieldRule,
} from './guardrails/rules.js';

export { scanContent } from './guardrails/content-scanner.js';
export type { PiiMatch, ContentScanResult } from './guardrails/content-scanner.js';

export {
  createLlmProvider,
  createOllamaProvider,
  createAnthropicProvider,
  createOpenAIProvider,
  createDeepSeekProvider,
  createMistralProvider,
  createGoogleProvider,
} from './llm/providers.js';
export type { LlmProvider } from './llm/providers.js';

export { buildPostMortemPrompt, parsePostMortemResponse } from './llm/post-mortem.js';
export type { PostMortemInput, PostMortemResult } from './llm/post-mortem.js';

export { analyzeRootCause, buildRcaPrompt, parseRcaResponse } from './analysis/rca.js';
export type { RcaEvent, RcaSession, RcaDriftSnapshot, RcaResult, CausalStep, ErrorPattern, DriftAnalysis, RcaLlmResult } from './analysis/rca.js';

export { extractMemories, diffMemories, detectHallucinations, buildCumulativeMemory, buildMemoryDiffPrompt, parseMemoryDiffResponse } from './analysis/memory-diff.js';

export { createIncidentSnapshot, selfAssess, generateAutoCorrection, extractGitCommits } from './analysis/incident.js';
export type { IncidentSnapshot, IncidentEvent, IncidentInput, IncidentEventInput, SelfAssessment, SelfAssessInput, AutoCorrection, CorrectionAction, GitCommitInfo } from './analysis/incident.js';
export type { MemoryItem, MemoryCategory, MemoryEvent, MemorySession, MemoryDiffItem, MemoryDiffResult, HallucinationItem, CumulativeMemory, MemoryDiffLlmResult } from './analysis/memory-diff.js';

export { evaluateAndCorrect, shouldTriggerAutocorrect, planCorrections, executeCorrection, buildCorrectionHint, getDefaultAutocorrectConfig } from './analysis/autocorrect.js';
export type { AutocorrectConfig, AutocorrectContext, CorrectionRecord, ExecutedCorrection, ExecutableCorrection, CorrectionHint, CorrectionType } from './analysis/autocorrect.js';

export { parseSwarmYaml, validateSwarmConfig, resolveDependencies, isInScope, generateSwarmTemplate } from './swarm/config.js';
export { detectConflicts, detectDetailedConflicts, scoreConflict, suggestMergeOrder } from './swarm/conflict.js';
export type {
  AgentPersona, AgentScope, SwarmConfig, SwarmTask,
  SwarmStatus, SwarmAgentStatus, SwarmAgent, SwarmResult,
  FileConflict, SwarmEventType, SwarmEvent,
  SwarmRow, SwarmAgentRow, SwarmConflictRow,
} from './swarm/types.js';

export { Logger } from './logger.js';
