/**
 * LLM interceptor — token extraction, cost estimation, provider detection.
 * Separated from network.ts per spec: handles all LLM-specific logic.
 */

export interface TokenInfo {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Known LLM API endpoints (by hostname or host:port)
export interface LlmEndpointConfig {
  provider: string;
  tokenExtractor: (body: unknown) => TokenInfo;
}

export const LLM_ENDPOINTS: Record<string, LlmEndpointConfig> = {
  'api.anthropic.com': { provider: 'anthropic', tokenExtractor: extractAnthropicTokens },
  'api.openai.com': { provider: 'openai', tokenExtractor: extractOpenAITokens },
  'api.deepseek.com': { provider: 'deepseek', tokenExtractor: extractOpenAITokens },
  'api.mistral.ai': { provider: 'mistral', tokenExtractor: extractOpenAITokens },
  'generativelanguage.googleapis.com': { provider: 'google', tokenExtractor: extractGoogleTokens },
  'localhost:11434': { provider: 'ollama', tokenExtractor: extractOllamaTokens },
  '127.0.0.1:11434': { provider: 'ollama', tokenExtractor: extractOllamaTokens },
};

// Path + header based detection for proxied/custom-port LLM calls
export interface PathSignature extends LlmEndpointConfig {
  headerCheck?: (headers: Record<string, string | string[] | undefined>) => boolean;
}

export const PATH_SIGNATURES: Record<string, PathSignature> = {
  '/v1/messages': {
    provider: 'anthropic',
    tokenExtractor: extractAnthropicTokens,
    headerCheck: (h) => h['anthropic-version'] != null || h['x-api-key'] != null,
  },
  '/v1/chat/completions': {
    provider: 'openai',
    tokenExtractor: extractOpenAITokens,
  },
  '/api/generate': {
    provider: 'ollama',
    tokenExtractor: extractOllamaTokens,
  },
  '/api/chat': {
    provider: 'ollama',
    tokenExtractor: extractOllamaTokens,
  },
};

// Cost per 1M tokens in USD — updated 2026-03
export const COST_TABLE: Record<string, { input: number; output: number }> = {
  // Anthropic Claude
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'o3': { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'o1': { input: 15, output: 60 },
  // DeepSeek
  'deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek-reasoner': { input: 0.28, output: 0.42 },
  // Mistral
  'mistral-large-latest': { input: 0.5, output: 1.5 },
  'mistral-medium-latest': { input: 0.4, output: 2 },
  'mistral-small-latest': { input: 0.1, output: 0.3 },
  'codestral-latest': { input: 0.3, output: 0.9 },
  'devstral-latest': { input: 0.4, output: 2 },
  // Google Gemini
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  // Ollama (local, free)
  'llama4': { input: 0, output: 0 },
  'llama3.2': { input: 0, output: 0 },
  'mistral': { input: 0, output: 0 },
  'codellama': { input: 0, output: 0 },
  'deepseek-coder': { input: 0, output: 0 },
};

// Token extraction per provider
export function extractAnthropicTokens(body: unknown): TokenInfo {
  const b = body as Record<string, unknown>;
  const usage = b.usage as Record<string, number> | undefined;
  return {
    model: (b.model as string) || 'unknown',
    promptTokens: usage?.input_tokens ?? 0,
    completionTokens: usage?.output_tokens ?? 0,
    totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
  };
}

export function extractOpenAITokens(body: unknown): TokenInfo {
  const b = body as Record<string, unknown>;
  const usage = b.usage as Record<string, number> | undefined;
  return {
    model: (b.model as string) || 'unknown',
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

export function extractGoogleTokens(body: unknown): TokenInfo {
  const b = body as Record<string, unknown>;
  const usage = b.usageMetadata as Record<string, number> | undefined;
  return {
    model: (b.modelVersion as string) || 'gemini',
    promptTokens: usage?.promptTokenCount ?? 0,
    completionTokens: usage?.candidatesTokenCount ?? 0,
    totalTokens: usage?.totalTokenCount ?? 0,
  };
}

export function extractOllamaTokens(body: unknown): TokenInfo {
  const b = body as Record<string, unknown>;
  return {
    model: (b.model as string) || 'unknown',
    promptTokens: (b.prompt_eval_count as number) ?? 0,
    completionTokens: (b.eval_count as number) ?? 0,
    totalTokens: ((b.prompt_eval_count as number) ?? 0) + ((b.eval_count as number) ?? 0),
  };
}

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const costs = COST_TABLE[model] ?? Object.entries(COST_TABLE).find(([k]) => model.startsWith(k))?.[1];
  if (!costs) return 0;
  return (promptTokens * costs.input + completionTokens * costs.output) / 1_000_000;
}

// Content extraction helpers (for capturePrompts mode)
export function extractPromptText(provider: string, reqBody: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    const messages = reqBody.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return '';
    const last = messages[messages.length - 1];
    return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  }

  if (provider === 'openai') {
    const messages = reqBody.messages as Array<{ role: string; content: string }> | undefined;
    if (!messages) return '';
    const last = messages[messages.length - 1];
    return last.content;
  }

  if (provider === 'ollama') {
    return (reqBody.prompt as string) || '';
  }

  return '';
}

export function extractResponseText(provider: string, resBody: Record<string, unknown>): string {
  if (provider === 'anthropic') {
    const content = resBody.content as Array<{ type: string; text?: string }> | undefined;
    if (!content) return '';
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }

  if (provider === 'openai') {
    const choices = resBody.choices as Array<{ message: { content: string } }> | undefined;
    if (!choices?.[0]) return '';
    return choices[0].message.content;
  }

  if (provider === 'ollama') {
    return (resBody.response as string) || '';
  }

  return '';
}

export function extractToolCalls(provider: string, resBody: Record<string, unknown>): string[] | undefined {
  if (provider === 'anthropic') {
    const content = resBody.content as Array<{ type: string; name?: string }> | undefined;
    if (!content) return undefined;
    const tools = content.filter((c) => c.type === 'tool_use').map((c) => c.name!);
    return tools.length > 0 ? tools : undefined;
  }

  if (provider === 'openai') {
    const choices = resBody.choices as Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }> | undefined;
    const tools = choices?.[0]?.message?.tool_calls?.map((t) => t.function.name);
    return tools && tools.length > 0 ? tools : undefined;
  }

  return undefined;
}
