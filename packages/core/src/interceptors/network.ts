import http from 'node:http';
import https from 'node:https';
import type { LlmEvent, ApiEvent } from '../types.js';
import { Logger } from '../logger.js';
import {
  LLM_ENDPOINTS,
  PATH_SIGNATURES,
  estimateCost,
  extractPromptText,
  extractResponseText,
  extractToolCalls,
  type LlmEndpointConfig,
} from './llm.js';

const logger = new Logger('interceptor:network');

function truncate(text: string, max: number = 2048): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `... [truncated]`;
}

function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // Strip auth headers
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      result[key] = '[REDACTED]';
    } else if (value != null) {
      result[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}

export type LlmCallback = (event: LlmEvent) => void;
export type ApiCallback = (event: ApiEvent) => void;
export type NetworkBlockCallback = (hostname: string, url: string, reason: string) => void;

export interface NetworkLockConfig {
  enabled: boolean;
  action: 'warn' | 'block';
  allowedHosts: string[];
  blockedHosts: string[];
}

export interface NetworkInterceptor {
  install(): void;
  uninstall(): void;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isLocalhostOrInternal(hostname: string): boolean {
  return LOCALHOST_HOSTS.has(hostname);
}

function checkNetworkLock(
  hostname: string,
  config: NetworkLockConfig,
): { blocked: boolean; reason: string } | null {
  if (!config.enabled || config.action !== 'block') return null;

  // Always allow localhost / internal communication
  if (isLocalhostOrInternal(hostname)) return null;

  // Check blocked hosts first
  for (const pattern of config.blockedHosts) {
    if (hostname === pattern || hostname.endsWith('.' + pattern)) {
      return {
        blocked: true,
        reason: `Network request blocked by Hawkeye guardrail: hostname "${hostname}" is in the blocklist (matched: "${pattern}")`,
      };
    }
  }

  // Check allowlist (if specified, only allowed hosts pass through)
  if (config.allowedHosts.length > 0) {
    const isAllowed = config.allowedHosts.some(
      (pattern) => hostname === pattern || hostname.endsWith('.' + pattern),
    );
    if (!isAllowed) {
      return {
        blocked: true,
        reason: `Network request blocked by Hawkeye guardrail: hostname "${hostname}" is not in the allowlist`,
      };
    }
  }

  return null;
}

export function createNetworkInterceptor(
  onLlmEvent: LlmCallback,
  onApiEvent: ApiCallback,
  options?: {
    capturePrompts?: boolean;
    networkLockRules?: NetworkLockConfig;
    onNetworkBlock?: NetworkBlockCallback;
  },
): NetworkInterceptor {
  const capturePrompts = options?.capturePrompts ?? false;
  const networkLockConfig = options?.networkLockRules;
  const onNetworkBlock = options?.onNetworkBlock;

  // Save originals
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  function patchRequest(
    originalFn: typeof http.request,
    protocol: string,
  ): typeof http.request {
    return function patchedRequest(
      this: unknown,
      ...args: Parameters<typeof http.request>
    ): http.ClientRequest {
      // Extract URL info BEFORE making the request to check network lock
      const urlInfo = extractUrlInfo(args, protocol);

      // Check network lock rules before making the request
      if (urlInfo && networkLockConfig) {
        const blockResult = checkNetworkLock(urlInfo.hostname, networkLockConfig);
        if (blockResult?.blocked) {
          const fullUrl = `${protocol}//${urlInfo.hostname}${urlInfo.port ? ':' + urlInfo.port : ''}${urlInfo.path}`;
          logger.warn(`Network blocked: ${fullUrl} — ${blockResult.reason}`);

          if (onNetworkBlock) {
            onNetworkBlock(urlInfo.hostname, fullUrl, blockResult.reason);
          }

          // Return a fake ClientRequest that immediately emits an error
          const fakeReq = new http.ClientRequest(`${protocol}//localhost/__hawkeye_blocked`);
          // Prevent the actual connection by destroying the socket
          fakeReq.destroy(new Error(blockResult.reason));
          return fakeReq;
        }
      }

      const req = originalFn.apply(this, args) as http.ClientRequest;

      if (!urlInfo) return req;

      const { hostname, path, method } = urlInfo;
      const hostPort = urlInfo.port ? `${hostname}:${urlInfo.port}` : hostname;
      const startTime = Date.now();

      // Capture request body
      let requestBody = '';
      const originalWrite = req.write.bind(req);
      const originalEnd = req.end.bind(req);

      req.write = function (chunk: unknown, ...rest: unknown[]): boolean {
        if (chunk) {
          requestBody += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
        }
        return (originalWrite as Function)(chunk, ...rest);
      } as typeof req.write;

      req.end = function (chunk: unknown, ...rest: unknown[]): http.ClientRequest {
        if (chunk && typeof chunk !== 'function') {
          requestBody += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
        }
        return (originalEnd as Function)(chunk, ...rest);
      } as typeof req.end;

      // Capture request headers for path-based detection
      const reqHeaders = req.getHeaders() as Record<string, string | string[] | undefined>;

      // Capture response
      req.on('response', (res: http.IncomingMessage) => {
        let responseBody = '';

        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString();
        });

        res.on('end', () => {
          const latencyMs = Date.now() - startTime;
          const fullUrl = `${protocol}//${hostPort}${path}`;

          // Check if this is a known LLM endpoint (hostname match first, then path+header fallback)
          let llmConfig: LlmEndpointConfig | undefined =
            LLM_ENDPOINTS[hostPort] || LLM_ENDPOINTS[hostname];

          if (!llmConfig) {
            // Path-based detection: match by API path and optional header check
            const pathSig = PATH_SIGNATURES[path] || PATH_SIGNATURES[path.split('?')[0]];
            if (pathSig && (!pathSig.headerCheck || pathSig.headerCheck(reqHeaders))) {
              llmConfig = { provider: pathSig.provider, tokenExtractor: pathSig.tokenExtractor };
            }
          }

          if (llmConfig && res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const responseJson = JSON.parse(responseBody);
              const tokens = llmConfig.tokenExtractor(responseJson);
              const costUsd = estimateCost(tokens.model, tokens.promptTokens, tokens.completionTokens);

              const llmEvent: LlmEvent = {
                provider: llmConfig.provider,
                model: tokens.model,
                promptTokens: tokens.promptTokens,
                completionTokens: tokens.completionTokens,
                totalTokens: tokens.totalTokens,
                costUsd,
                latencyMs,
              };

              // Optionally capture prompt/response content
              if (capturePrompts) {
                try {
                  const reqJson = JSON.parse(requestBody);
                  llmEvent.prompt = truncate(extractPromptText(llmConfig.provider, reqJson));
                  llmEvent.response = truncate(extractResponseText(llmConfig.provider, responseJson));
                  llmEvent.toolCalls = extractToolCalls(llmConfig.provider, responseJson);
                } catch {
                  // Ignore parse errors for content
                }
              }

              logger.info(
                `LLM call: ${llmConfig.provider}/${tokens.model} ` +
                `${tokens.totalTokens} tokens $${costUsd.toFixed(4)} ${latencyMs}ms`,
              );
              onLlmEvent(llmEvent);
            } catch {
              // Not valid JSON LLM response, treat as generic API call
              emitApiEvent();
            }
          } else {
            emitApiEvent();
          }

          function emitApiEvent() {
            // Only emit for external calls, skip localhost non-LLM
            if (hostname === 'localhost' || hostname === '127.0.0.1') return;

            const apiEvent: ApiEvent = {
              url: fullUrl,
              method: method || 'GET',
              statusCode: res.statusCode,
              requestHeaders: sanitizeHeaders(req.getHeaders() as Record<string, string | string[] | undefined>),
              responseSizeBytes: responseBody.length,
              latencyMs,
            };

            logger.debug(`API call: ${apiEvent.method} ${apiEvent.url} ${apiEvent.statusCode}`);
            onApiEvent(apiEvent);
          }
        });
      });

      return req;
    } as typeof http.request;
  }

  return {
    install() {
      (http as unknown as Record<string, unknown>).request = patchRequest(originalHttpRequest, 'http:');
      (https as unknown as Record<string, unknown>).request = patchRequest(originalHttpsRequest, 'https:');
      logger.info('Network interceptor installed');
    },

    uninstall() {
      (http as unknown as Record<string, unknown>).request = originalHttpRequest;
      (https as unknown as Record<string, unknown>).request = originalHttpsRequest;
      logger.debug('Network interceptor uninstalled');
    },
  };
}

// Helpers to extract URL info from various request signatures
function extractUrlInfo(
  args: unknown[],
  protocol: string,
): { hostname: string; port?: string; path: string; method?: string } | null {
  const first = args[0];

  if (typeof first === 'string') {
    try {
      const url = new URL(first);
      return { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' };
    } catch {
      return null;
    }
  }

  if (first instanceof URL) {
    return { hostname: first.hostname, port: first.port, path: first.pathname + first.search, method: 'GET' };
  }

  if (first && typeof first === 'object') {
    const opts = first as Record<string, unknown>;
    const hostname = (opts.hostname || opts.host || 'unknown') as string;
    const port = opts.port ? String(opts.port) : undefined;
    const path = (opts.path || '/') as string;
    const method = (opts.method || 'GET') as string;
    return { hostname: hostname.split(':')[0], port: port || hostname.split(':')[1], path, method };
  }

  return null;
}
