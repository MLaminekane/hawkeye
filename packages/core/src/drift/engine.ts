import type { TraceEvent, DriftFlag, DriftConfig } from '../types.js';
import { Logger } from '../logger.js';
import { scoreHeuristic, slidingDriftScore } from './scorer.js';
import { buildDriftPrompt, parseDriftResponse, type DriftLlmResponse } from './prompts.js';
import {
  type LlmProvider,
  createOllamaProvider,
  createAnthropicProvider,
  createOpenAIProvider,
  createLmStudioProvider,
  createDeepSeekProvider,
  createMistralProvider,
  createGoogleProvider,
} from '../llm/providers.js';

const logger = new Logger('drift:engine');

export interface DriftCheckResult {
  score: number;
  flag: DriftFlag;
  reason: string;
  suggestion: string | null;
  source: 'heuristic' | 'llm';
}

export type DriftAlertCallback = (result: DriftCheckResult, eventId: string) => void;

export interface DriftEngine {
  check(events: TraceEvent[]): Promise<DriftCheckResult>;
  getSlidingScore(): number;
  onAlert(callback: DriftAlertCallback): void;
  processEvent(event: TraceEvent, allRecentEvents: TraceEvent[]): Promise<void>;
}

function formatEventsForPrompt(events: TraceEvent[]): string {
  return events
    .map((e, i) => {
      const data = e.data;
      let desc: string;

      switch (e.type) {
        case 'command':
          desc = `[COMMAND] ${'command' in data ? `${data.command} ${(data.args as string[]).join(' ')}` : 'unknown'}`;
          if ('exitCode' in data && data.exitCode !== 0) desc += ` (exit ${data.exitCode})`;
          break;
        case 'file_write':
          desc = `[FILE WRITE] ${'path' in data ? data.path : 'unknown'}`;
          break;
        case 'file_delete':
          desc = `[FILE DELETE] ${'path' in data ? data.path : 'unknown'}`;
          break;
        case 'file_read':
          desc = `[FILE READ] ${'path' in data ? data.path : 'unknown'}`;
          break;
        case 'llm_call':
          desc = `[LLM CALL] ${'provider' in data ? `${data.provider}/${(data as { model?: string }).model}` : 'unknown'}`;
          break;
        case 'error':
          desc = `[ERROR] ${'description' in data ? data.description : 'unknown error'}`;
          break;
        default:
          desc = `[${e.type.toUpperCase()}]`;
      }

      return `${i + 1}. ${desc}`;
    })
    .join('\n');
}

export function createDriftEngine(
  config: DriftConfig,
  objective: string,
  workingDir: string,
): DriftEngine {
  const scoreHistory: number[] = [];
  const alertCallbacks: DriftAlertCallback[] = [];
  let eventsSinceLastCheck = 0;
  let llmProvider: LlmProvider | null = null;

  // Initialize LLM provider if configured
  if (config.enabled) {
    try {
      switch (config.provider) {
        case 'ollama':
          llmProvider = createOllamaProvider(config.model, config.ollamaUrl);
          logger.info(`DriftDetect: using Ollama (${config.model})`);
          break;
        case 'anthropic':
          llmProvider = createAnthropicProvider(config.model);
          logger.info(`DriftDetect: using Anthropic (${config.model})`);
          break;
        case 'openai':
          llmProvider = createOpenAIProvider(config.model);
          logger.info(`DriftDetect: using OpenAI (${config.model})`);
          break;
        case 'lmstudio':
          llmProvider = createLmStudioProvider(config.model, config.lmstudioUrl);
          logger.info(`DriftDetect: using LM Studio (${config.model})`);
          break;
        case 'deepseek':
          llmProvider = createDeepSeekProvider(config.model);
          logger.info(`DriftDetect: using DeepSeek (${config.model})`);
          break;
        case 'mistral':
          llmProvider = createMistralProvider(config.model);
          logger.info(`DriftDetect: using Mistral (${config.model})`);
          break;
        case 'google':
          llmProvider = createGoogleProvider(config.model);
          logger.info(`DriftDetect: using Google (${config.model})`);
          break;
      }
    } catch (err) {
      logger.warn(`Failed to initialize LLM provider: ${String(err)}`);
    }
  }

  async function checkWithLlm(events: TraceEvent[]): Promise<DriftCheckResult | null> {
    if (!llmProvider) return null;

    try {
      const formatted = formatEventsForPrompt(events);
      const prompt = buildDriftPrompt(objective, formatted);
      const rawResponse = await llmProvider.complete(prompt);
      const parsed = parseDriftResponse(rawResponse);

      if (!parsed) {
        logger.warn('Failed to parse LLM drift response');
        return null;
      }

      return {
        score: parsed.score,
        flag: parsed.flag,
        reason: parsed.reason,
        suggestion: parsed.suggestion,
        source: 'llm',
      };
    } catch (err) {
      logger.warn(`LLM drift check failed: ${String(err)}`);
      return null;
    }
  }

  return {
    async check(events: TraceEvent[]): Promise<DriftCheckResult> {
      const recentEvents = events.slice(-config.contextWindow);

      // Try LLM first, fall back to heuristic
      const llmResult = await checkWithLlm(recentEvents);

      if (llmResult) {
        scoreHistory.push(llmResult.score);
        return llmResult;
      }

      // Heuristic fallback
      const heuristic = scoreHeuristic(recentEvents, { objective, workingDir });
      scoreHistory.push(heuristic.score);

      return {
        score: heuristic.score,
        flag: heuristic.flag,
        reason: heuristic.reason,
        suggestion: null,
        source: 'heuristic',
      };
    },

    getSlidingScore(): number {
      return slidingDriftScore(scoreHistory);
    },

    onAlert(callback: DriftAlertCallback): void {
      alertCallbacks.push(callback);
    },

    async processEvent(event: TraceEvent, allRecentEvents: TraceEvent[]): Promise<void> {
      if (!config.enabled) return;

      eventsSinceLastCheck++;

      if (eventsSinceLastCheck < config.checkEvery) return;
      eventsSinceLastCheck = 0;

      const result = await this.check(allRecentEvents);

      logger.info(`Drift check: score=${result.score} flag=${result.flag} source=${result.source}`);

      if (result.flag !== 'ok') {
        for (const cb of alertCallbacks) {
          cb(result, event.id);
        }
      }
    },
  };
}
