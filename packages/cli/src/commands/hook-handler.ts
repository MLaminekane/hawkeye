/**
 * Claude Code Hook Handler
 *
 * Invoked by Claude Code hooks (PreToolUse, PostToolUse, Stop).
 * Reads JSON from stdin, evaluates guardrails, records events with full data
 * capture including Bash output, LLM cost estimation, and drift detection.
 *
 * Usage:
 *   hawkeye hook-handler --event PreToolUse   (stdin: JSON from Claude Code)
 *   hawkeye hook-handler --event PostToolUse  (stdin: JSON from Claude Code)
 *   hawkeye hook-handler --event Stop         (stdin: JSON from Claude Code)
 */

import { Command } from 'commander';
import { join, extname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Storage, scoreHeuristic, slidingDriftScore } from '@hawkeye/core';
import type { TraceEvent, EventType, DriftFlag } from '@hawkeye/core';

// ── Cost estimation ──
// Claude Code primarily uses Claude models. Default to sonnet pricing.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const COST_PER_1M: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function estimateTokens(text: string): number {
  // ~4 chars per token for English/code
  return Math.ceil((text?.length || 0) / 4);
}

function estimateLlmCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const costs =
    COST_PER_1M[model] ||
    Object.entries(COST_PER_1M).find(([k]) => model.startsWith(k))?.[1] ||
    COST_PER_1M[DEFAULT_MODEL];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

// ── File utilities ──

function computeFileHash(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function truncate(text: string, max: number = 10240): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `... [truncated, ${text.length} bytes]`;
}

// ── Guardrail config ──

interface WebhookConfig {
  enabled: boolean;
  url: string;
  events: string[];
}

interface NetworkLockConfig {
  enabled: boolean;
  action: string;
  allowedHosts: string[];
  blockedHosts: string[];
}

interface GuardrailConfig {
  protectedFiles: string[];
  dangerousCommands: string[];
  blockedDirs: string[];
  reviewGatePatterns: string[];
  networkLock: NetworkLockConfig | null;
  autoPause: boolean;
  webhooks: WebhookConfig[];
}

function loadGuardrailConfig(): GuardrailConfig {
  const defaults: GuardrailConfig = {
    protectedFiles: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519', '*.credentials', '*.secret'],
    dangerousCommands: [
      'rm -rf /', 'rm -rf ~', 'rm -rf .', 'sudo rm',
      'DROP TABLE', 'DROP DATABASE', 'TRUNCATE TABLE',
      'curl * | bash', 'curl * | sh', 'wget * | bash', 'wget * | sh',
      'chmod 777', 'mkfs*', 'dd if=*of=/dev/*',
      '> /dev/sda',
    ],
    blockedDirs: ['/etc', '/usr', '/var', '/sys', '/boot', '~/.ssh', '~/.gnupg', '~/.aws'],
    reviewGatePatterns: [],
    networkLock: null,
    autoPause: true,
    webhooks: [],
  };

  // Load custom config from .hawkeye/config.json if exists
  try {
    const configPath = join(process.cwd(), '.hawkeye', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const rules = config.guardrails || [];
      const filePaths: string[] = [];
      const cmdPatterns: string[] = [];
      const blockDirs: string[] = [];
      const reviewPatterns: string[] = [];
      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.type === 'file_protect' && rule.config?.paths?.length) {
          filePaths.push(...rule.config.paths);
        }
        if (rule.type === 'command_block' && rule.config?.patterns?.length) {
          cmdPatterns.push(...rule.config.patterns);
        }
        if (rule.type === 'directory_scope' && rule.config?.blockedDirs?.length) {
          blockDirs.push(...rule.config.blockedDirs);
        }
        if (rule.type === 'review_gate' && rule.config?.patterns?.length) {
          reviewPatterns.push(...rule.config.patterns);
        }
        if (rule.type === 'network_lock' && rule.config) {
          defaults.networkLock = {
            enabled: true,
            action: rule.action || 'block',
            allowedHosts: rule.config.allowedHosts || [],
            blockedHosts: rule.config.blockedHosts || [],
          };
        }
      }
      if (filePaths.length) defaults.protectedFiles = filePaths;
      if (cmdPatterns.length) defaults.dangerousCommands = cmdPatterns;
      if (blockDirs.length) defaults.blockedDirs = blockDirs;
      if (reviewPatterns.length) defaults.reviewGatePatterns = reviewPatterns;

      // Load auto-pause setting from drift config
      if (config.drift?.autoPause) defaults.autoPause = true;

      // Load webhooks
      if (config.webhooks?.length) {
        defaults.webhooks = config.webhooks.filter((w: WebhookConfig) => w.enabled);
      }
    }
  } catch {}

  return defaults;
}

// ── Webhook notifications ──

function fireWebhooks(
  webhooks: WebhookConfig[],
  eventType: string,
  payload: Record<string, unknown>,
): void {
  for (const wh of webhooks) {
    if (wh.events.length > 0 && !wh.events.includes(eventType)) continue;
    // Fire-and-forget — don't block the hook handler
    fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    }).catch(() => {});
  }
}

// ── Session tracking ──

interface HookSession {
  hawkeyeSessionId: string;
  claudeSessionId: string;
  objective: string;
  startedAt: string;
  lastActivityAt: string;
  eventCount: number;
  totalCostUsd: number;
  driftScores: number[];
  model: string;
}

function getHawkDir(): string {
  return join(process.cwd(), '.hawkeye');
}

function getSessionsFile(): string {
  return join(getHawkDir(), 'hook-sessions.json');
}

function loadSessions(): Record<string, HookSession> {
  const file = getSessionsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions: Record<string, HookSession>): void {
  const dir = getHawkDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getSessionsFile(), JSON.stringify(sessions, null, 2));
}

function getOrCreateSession(
  claudeSessionId: string,
  storage: Storage,
  objective?: string,
): HookSession {
  const sessions = loadSessions();

  if (sessions[claudeSessionId]) {
    sessions[claudeSessionId].lastActivityAt = new Date().toISOString();
    saveSessions(sessions);
    return sessions[claudeSessionId];
  }

  // Check for a pending session pre-created by /new in the TUI
  let resolvedObjective = objective || 'Claude Code Session';
  let sessionId: string | null = null;
  const pendingPath = join(getHawkDir(), 'pending-session.json');
  try {
    if (existsSync(pendingPath)) {
      const pending = JSON.parse(readFileSync(pendingPath, 'utf-8'));
      if (pending.sessionId) sessionId = pending.sessionId;
      if (pending.objective) resolvedObjective = pending.objective;
      // Consume it — one-time use
      unlinkSync(pendingPath);
    }
  } catch {}

  // If no pre-created session, create one now
  if (!sessionId) {
    sessionId = randomUUID();
    const now = new Date();
    storage.createSession({
      id: sessionId,
      objective: resolvedObjective,
      startedAt: now,
      status: 'recording',
      metadata: {
        agent: 'claude-code',
        model: DEFAULT_MODEL,
        workingDir: process.cwd(),
      },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
    });
  }

  const hookSession: HookSession = {
    hawkeyeSessionId: sessionId,
    claudeSessionId,
    objective: resolvedObjective,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    eventCount: 0,
    totalCostUsd: 0,
    driftScores: [],
    model: DEFAULT_MODEL,
  };

  sessions[claudeSessionId] = hookSession;
  saveSessions(sessions);
  return hookSession;
}

function updateSessionTracking(
  claudeSessionId: string,
  costUsd: number,
  driftScore?: number,
): void {
  const sessions = loadSessions();
  const session = sessions[claudeSessionId];
  if (!session) return;

  session.eventCount++;
  session.totalCostUsd += costUsd;
  session.lastActivityAt = new Date().toISOString();
  if (driftScore !== undefined) {
    session.driftScores.push(driftScore);
  }
  saveSessions(sessions);
}

// ── Guardrail checks ──

function matchesGlob(filePath: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${regex}$`).test(filePath);
}

function checkFileProtection(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: GuardrailConfig,
): string | null {
  if (!['Write', 'Edit', 'Read', 'Bash'].includes(toolName)) return null;

  let filePath = '';
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
    filePath = String(toolInput.file_path || toolInput.path || '');
  } else if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    for (const pattern of config.protectedFiles) {
      const cleanPattern = pattern.replace(/\*/g, '');
      if (cleanPattern && cmd.includes(cleanPattern)) {
        return `Command references protected file pattern: ${pattern}`;
      }
    }
    return null;
  }

  if (!filePath) return null;

  for (const pattern of config.protectedFiles) {
    if (matchesGlob(filePath, pattern)) {
      return `File "${filePath}" matches protected pattern "${pattern}"`;
    }
  }
  return null;
}

function checkDangerousCommand(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: GuardrailConfig,
): string | null {
  if (toolName !== 'Bash') return null;
  const cmd = String(toolInput.command || '');
  if (!cmd) return null;

  for (const pattern of config.dangerousCommands) {
    // Convert wildcard pattern to regex: * → .* , escape regex-special chars
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    if (new RegExp(escaped, 'i').test(cmd)) {
      return `Command matches dangerous pattern: "${pattern}"`;
    }
  }
  return null;
}

function checkDirectoryScope(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: GuardrailConfig,
): string | null {
  let targetPath = '';

  if (['Write', 'Edit', 'Read'].includes(toolName)) {
    targetPath = String(toolInput.file_path || toolInput.path || '');
  } else if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    const home = process.env.HOME || '/root';
    for (const dir of config.blockedDirs) {
      const expanded = dir.replace('~', home);
      if (cmd.includes(expanded) || cmd.includes(dir) || cmd.includes(expanded.replace(home, '~'))) {
        return `Command accesses blocked directory: ${dir}`;
      }
    }
    return null;
  }

  if (!targetPath) return null;

  for (const dir of config.blockedDirs) {
    const expanded = dir.replace('~', process.env.HOME || '/root');
    if (targetPath.startsWith(expanded) || targetPath.startsWith(dir)) {
      return `Path "${targetPath}" is in blocked directory "${dir}"`;
    }
  }
  return null;
}

function checkReviewGate(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: GuardrailConfig,
): string | null {
  if (toolName !== 'Bash' || config.reviewGatePatterns.length === 0) return null;
  const cmd = String(toolInput.command || '');
  if (!cmd) return null;

  for (const pattern of config.reviewGatePatterns) {
    const check = pattern.replace(/\*/g, '');
    if (check && cmd.includes(check)) {
      return `Review gate: command matches "${pattern}" — requires human approval`;
    }
  }
  return null;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function checkNetworkLock(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: GuardrailConfig,
): string | null {
  if (!config.networkLock || config.networkLock.action !== 'block') return null;
  if (toolName !== 'Bash') return null;

  const cmd = String(toolInput.command || '');
  if (!cmd) return null;

  // Extract hostnames from curl/wget/fetch commands
  const urlPatterns = [
    // curl https://example.com/... or curl http://example.com/...
    /\bcurl\b[^|]*?\b(?:https?:\/\/)([^\/\s:]+)/g,
    // wget https://example.com/...
    /\bwget\b[^|]*?\b(?:https?:\/\/)([^\/\s:]+)/g,
    // curl -X POST https://... (already covered above)
    // nc / ncat hostname port
    /\b(?:nc|ncat)\b\s+([^\s-][^\s]*)/g,
  ];

  const { allowedHosts, blockedHosts } = config.networkLock;

  for (const pattern of urlPatterns) {
    let match;
    while ((match = pattern.exec(cmd)) !== null) {
      const hostname = match[1];
      if (!hostname || LOCALHOST_HOSTS.has(hostname)) continue;

      // Check blocked hosts
      for (const blocked of blockedHosts) {
        if (hostname === blocked || hostname.endsWith('.' + blocked)) {
          return `Network request blocked by Hawkeye guardrail: hostname "${hostname}" is in the blocklist (matched: "${blocked}")`;
        }
      }

      // Check allowlist
      if (allowedHosts.length > 0) {
        const isAllowed = allowedHosts.some(
          (allowed: string) => hostname === allowed || hostname.endsWith('.' + allowed),
        );
        if (!isAllowed) {
          return `Network request blocked by Hawkeye guardrail: hostname "${hostname}" is not in the allowlist`;
        }
      }
    }
  }

  return null;
}

// ── Event mapping ──

// ── Git command detection ──

const GIT_PATTERNS: Array<{ regex: RegExp; type: EventType; operation: string }> = [
  { regex: /\bgit\s+commit\b/, type: 'git_commit', operation: 'commit' },
  { regex: /\bgit\s+push\b/, type: 'git_push', operation: 'push' },
  { regex: /\bgit\s+pull\b/, type: 'git_pull', operation: 'pull' },
  { regex: /\bgit\s+merge\b/, type: 'git_merge', operation: 'merge' },
  { regex: /\bgit\s+(?:checkout|switch)\b/, type: 'git_checkout', operation: 'checkout' },
];

function detectGitCommand(command: string): { type: EventType; operation: string } | null {
  for (const pattern of GIT_PATTERNS) {
    if (pattern.regex.test(command)) {
      return { type: pattern.type, operation: pattern.operation };
    }
  }
  return null;
}

function parseGitOutput(operation: string, command: string, output: string): Record<string, unknown> {
  const data: Record<string, unknown> = { operation };

  if (operation === 'commit') {
    // Extract commit hash from output like "[main abc1234] message"
    const hashMatch = output.match(/\[[\w/.-]+\s+([a-f0-9]{7,40})\]/);
    if (hashMatch) data.commitHash = hashMatch[1];
    // Extract message from -m flag
    const msgMatch = command.match(/-m\s+["']([^"']+)["']/);
    if (msgMatch) data.message = msgMatch[1];
    // Extract stats: "3 files changed, 10 insertions(+), 5 deletions(-)"
    const statsMatch = output.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?)?(?:.*?(\d+)\s+deletions?)?/);
    if (statsMatch) {
      data.filesChanged = parseInt(statsMatch[1]) || 0;
      data.linesAdded = parseInt(statsMatch[2]) || 0;
      data.linesRemoved = parseInt(statsMatch[3]) || 0;
    }
  } else if (operation === 'checkout') {
    // Extract branch from "Switched to branch 'foo'" or from command
    const branchMatch = output.match(/Switched to (?:a new )?branch '([^']+)'/) ||
                        command.match(/(?:checkout|switch)\s+(?:-[bB]\s+)?(\S+)/);
    if (branchMatch) data.branch = branchMatch[1];
  } else if (operation === 'push') {
    const remoteMatch = command.match(/push\s+(\S+)(?:\s+(\S+))?/);
    if (remoteMatch) {
      data.branch = remoteMatch[2] || undefined;
    }
  } else if (operation === 'pull') {
    const statsMatch = output.match(/(\d+)\s+files?\s+changed/);
    if (statsMatch) data.filesChanged = parseInt(statsMatch[1]) || 0;
  } else if (operation === 'merge') {
    const branchMatch = command.match(/merge\s+(\S+)/);
    if (branchMatch) data.targetBranch = branchMatch[1];
  }

  return data;
}

function mapToolToEventType(toolName: string, toolInput?: Record<string, unknown>): EventType {
  if (toolName === 'Bash' && toolInput?.command) {
    const gitCmd = detectGitCommand(String(toolInput.command));
    if (gitCmd) return gitCmd.type;
  }
  switch (toolName) {
    case 'Bash':
      return 'command';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'file_write';
    case 'Read':
      return 'file_read';
    case 'Glob':
    case 'Grep':
      return 'file_read';
    default:
      return 'api_call';
  }
}

function buildEventData(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput?: string,
  eventType?: EventType,
): Record<string, unknown> {
  // ── Git events ──
  if (eventType && eventType.startsWith('git_') && toolName === 'Bash') {
    const command = String(toolInput.command || '');
    const gitCmd = detectGitCommand(command);
    if (gitCmd) {
      return parseGitOutput(gitCmd.operation, command, toolOutput || '');
    }
  }

  switch (toolName) {
    case 'Bash': {
      const command = String(toolInput.command || '');
      // Detect exit code from output patterns
      let exitCode: number | undefined;
      if (toolOutput) {
        const exitMatch = toolOutput.match(
          /(?:exit(?:ed with)?\s+(?:code\s+)?|returned?\s+)(\d+)/i,
        );
        if (exitMatch) exitCode = parseInt(exitMatch[1]);
        // Heuristic: if output contains error indicators without explicit exit code
        if (
          exitCode === undefined &&
          /\b(?:error|failed|ENOENT|Permission denied|command not found)\b/i.test(
            toolOutput,
          )
        ) {
          exitCode = 1;
        }
      }
      return {
        command,
        args: [],
        cwd: String(toolInput.cwd || process.cwd()),
        exitCode: exitCode ?? 0,
        stdout: toolOutput ? truncate(toolOutput) : undefined,
      };
    }
    case 'Write': {
      const filePath = String(toolInput.file_path || toolInput.path || '');
      const content = toolInput.content ? String(toolInput.content) : undefined;
      return {
        path: filePath,
        action: 'write',
        sizeBytes: getFileSize(filePath),
        contentHash: computeFileHash(filePath),
        contentAfter: content ? truncate(content, 5000) : undefined,
      };
    }
    case 'Edit': {
      const filePath = String(toolInput.file_path || toolInput.path || '');
      const oldStr = toolInput.old_string ? String(toolInput.old_string) : undefined;
      const newStr = toolInput.new_string ? String(toolInput.new_string) : undefined;
      // Build a unified diff for display
      let diff: string | undefined;
      if (oldStr != null || newStr != null) {
        const oldLines = (oldStr || '').split('\n').map((l: string) => `- ${l}`);
        const newLines = (newStr || '').split('\n').map((l: string) => `+ ${l}`);
        diff = [...oldLines, ...newLines].join('\n');
      }
      return {
        path: filePath,
        action: 'write',
        sizeBytes: getFileSize(filePath),
        contentHash: computeFileHash(filePath),
        linesAdded: newStr ? newStr.split('\n').length : undefined,
        linesRemoved: oldStr ? oldStr.split('\n').length : undefined,
        diff,
        contentBefore: oldStr ? truncate(oldStr, 5000) : undefined,
        contentAfter: newStr ? truncate(newStr, 5000) : undefined,
      };
    }
    case 'Read': {
      const filePath = String(toolInput.file_path || toolInput.path || '');
      return {
        path: filePath,
        action: 'read',
        sizeBytes: getFileSize(filePath),
      };
    }
    case 'Glob':
    case 'Grep':
      return {
        path: String(toolInput.pattern || toolInput.path || ''),
        action: 'read',
        sizeBytes: 0,
      };
    default:
      return { tool: toolName, input: toolInput };
  }
}

// ── Drift detection (heuristic, inline — must be fast) ──

const DRIFT_CHECK_EVERY = 5;

function runDriftCheck(
  storage: Storage,
  hawkeyeSessionId: string,
  eventId: string,
  eventCount: number,
  driftScores: number[],
  objective: string,
): { score: number; flag: DriftFlag } | null {
  // Only check every N events
  if (eventCount % DRIFT_CHECK_EVERY !== 0) return null;
  if (eventCount < DRIFT_CHECK_EVERY) return null;

  try {
    const eventsResult = storage.getEvents(hawkeyeSessionId, { limit: 20 });
    if (!eventsResult.ok || eventsResult.value.length < 3) return null;

    // Convert EventRows to TraceEvents for the scorer
    const traceEvents: TraceEvent[] = eventsResult.value.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: new Date(row.timestamp),
      sequence: row.sequence,
      type: row.type as EventType,
      data: JSON.parse(row.data),
      durationMs: row.duration_ms,
      costUsd: row.cost_usd,
    }));

    const result = scoreHeuristic(traceEvents, {
      objective,
      workingDir: process.cwd(),
    });

    // Update sliding score
    driftScores.push(result.score);
    const sliding = slidingDriftScore(driftScores);

    // Persist drift snapshot
    storage.insertDriftSnapshot(hawkeyeSessionId, eventId, {
      score: sliding,
      flag: result.flag,
      reason: result.reason,
      suggestion: null,
      source: 'heuristic',
    });

    return { score: sliding, flag: result.flag };
  } catch {
    return null;
  }
}

// ── Read stdin ──

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    // Timeout after 5s (Claude Code hooks have a timeout)
    setTimeout(() => resolve(data), 5000);
  });
}

// ── Command ──

export const hookHandlerCommand = new Command('hook-handler')
  .description('Internal: Claude Code hook handler')
  .option(
    '--event <type>',
    'Hook event type (PreToolUse, PostToolUse, Stop)',
    'PostToolUse',
  )
  .action(async (options) => {
    try {
      const input = await readStdin();
      if (!input.trim()) {
        process.exit(0);
      }

      const hookData = JSON.parse(input);
      const claudeSessionId = hookData.session_id || 'unknown';
      const eventType = options.event;

      // Ensure .hawkeye directory exists
      const hawkDir = getHawkDir();
      if (!existsSync(hawkDir)) mkdirSync(hawkDir, { recursive: true });

      const dbPath = join(hawkDir, 'traces.db');
      const storage = new Storage(dbPath);

      try {
        if (eventType === 'PreToolUse') {
          // ── Guardrail evaluation ──
          const toolName = hookData.tool_name || '';
          const toolInput = (hookData.tool_input || {}) as Record<
            string,
            unknown
          >;
          const config = loadGuardrailConfig();

          const violations: string[] = [];
          const fileCheck = checkFileProtection(toolName, toolInput, config);
          if (fileCheck) violations.push(fileCheck);
          const cmdCheck = checkDangerousCommand(toolName, toolInput, config);
          if (cmdCheck) violations.push(cmdCheck);
          const dirCheck = checkDirectoryScope(toolName, toolInput, config);
          if (dirCheck) violations.push(dirCheck);
          const reviewCheck = checkReviewGate(toolName, toolInput, config);
          if (reviewCheck) violations.push(reviewCheck);
          const networkCheck = checkNetworkLock(toolName, toolInput, config);
          if (networkCheck) violations.push(networkCheck);

          if (violations.length > 0) {
            // Record the guardrail block event
            const session = getOrCreateSession(
              claudeSessionId,
              storage,
              hookData.objective,
            );
            const seq = storage.getNextSequence(session.hawkeyeSessionId);
            const eventId = randomUUID();

            storage.insertEvent({
              id: eventId,
              sessionId: session.hawkeyeSessionId,
              timestamp: new Date(),
              sequence: seq,
              type: 'guardrail_block' as EventType,
              data: {
                ruleName: 'hook_guardrail',
                severity: 'block' as const,
                description: violations.join('; '),
                blockedAction: `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`,
              } as unknown as TraceEvent['data'],
              durationMs: 0,
              costUsd: 0,
            });

            for (const desc of violations) {
              storage.insertGuardrailViolation(
                session.hawkeyeSessionId,
                eventId,
                {
                  ruleName: 'hook_guardrail',
                  severity: 'block',
                  description: desc,
                  actionTaken: 'blocked',
                },
              );
            }

            // Webhook notification for guardrail block
            if (config.webhooks.length > 0) {
              fireWebhooks(config.webhooks, 'guardrail_block', {
                sessionId: session.hawkeyeSessionId,
                violations,
                tool: toolName,
                objective: session.objective,
              });
            }

            // Output block reason and exit 2
            process.stdout.write(
              JSON.stringify({
                decision: 'block',
                reason: `Hawkeye Guardrail: ${violations.join('; ')}`,
              }),
            );
            storage.close();
            process.exit(2);
          }

          // Allow the action
          storage.close();
          process.exit(0);
        } else if (eventType === 'PostToolUse') {
          // ── Record the completed action with full data ──
          const toolName = hookData.tool_name || '';
          const toolInput = (hookData.tool_input || {}) as Record<
            string,
            unknown
          >;
          const toolOutput =
            typeof hookData.tool_output === 'string'
              ? hookData.tool_output
              : hookData.tool_output
                ? JSON.stringify(hookData.tool_output)
                : undefined;

          const session = getOrCreateSession(
            claudeSessionId,
            storage,
            hookData.objective,
          );
          const seq = storage.getNextSequence(session.hawkeyeSessionId);
          const type = mapToolToEventType(toolName, toolInput);
          const data = buildEventData(toolName, toolInput, toolOutput, type);
          const eventId = randomUUID();

          // ── LLM cost estimation ──
          // Each Claude Code tool use involves at least one LLM call.
          // Estimate tokens from tool input/output sizes.
          const inputText = JSON.stringify(toolInput);
          const outputText = toolOutput || '';

          // Use explicit token counts from hook data if available (newer Claude Code versions)
          const inputTokens =
            hookData.input_tokens || estimateTokens(inputText) + 500; // +500 for system prompt overhead
          const outputTokens =
            hookData.output_tokens || estimateTokens(outputText) + 50;

          const model = hookData.model || session.model || DEFAULT_MODEL;
          const costUsd = estimateLlmCost(model, inputTokens, outputTokens);

          // Insert the tool action event
          storage.insertEvent({
            id: eventId,
            sessionId: session.hawkeyeSessionId,
            timestamp: new Date(),
            sequence: seq,
            type,
            data: data as unknown as TraceEvent['data'],
            durationMs: hookData.duration_ms || 0,
            costUsd,
          });

          // Also insert a synthetic llm_call event to track token usage
          const llmSeq = storage.getNextSequence(session.hawkeyeSessionId);
          storage.insertEvent({
            id: randomUUID(),
            sessionId: session.hawkeyeSessionId,
            timestamp: new Date(),
            sequence: llmSeq,
            type: 'llm_call',
            data: {
              provider: 'anthropic',
              model,
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
              costUsd,
              latencyMs: hookData.duration_ms || 0,
            } as unknown as TraceEvent['data'],
            durationMs: hookData.duration_ms || 0,
            costUsd,
          });

          // ── Error event emission ──
          // If a command failed (non-zero exit code), emit a separate error event
          if (type === 'command' && data.exitCode && data.exitCode !== 0) {
            const errSeq = storage.getNextSequence(session.hawkeyeSessionId);
            const stderr = typeof data.stdout === 'string'
              ? data.stdout.split('\n').filter((l: string) => /error|fail|denied|not found/i.test(l)).join('\n').slice(0, 2048)
              : '';
            storage.insertEvent({
              id: randomUUID(),
              sessionId: session.hawkeyeSessionId,
              timestamp: new Date(),
              sequence: errSeq,
              type: 'error',
              data: {
                message: `Command failed with exit code ${data.exitCode}: ${String(data.command || '').slice(0, 200)}`,
                code: data.exitCode,
                stderr: stderr || undefined,
                source: 'command',
                relatedEventId: eventId,
              } as unknown as TraceEvent['data'],
              durationMs: 0,
              costUsd: 0,
            });
          }

          // ── Drift detection ──
          const drift = runDriftCheck(
            storage,
            session.hawkeyeSessionId,
            eventId,
            session.eventCount + 1,
            [...session.driftScores],
            session.objective,
          );

          // Update event with drift info if we got a score
          if (drift) {
            storage.updateEventDrift(eventId, drift.score, drift.flag);
          }

          // Auto-pause on critical drift + webhook notification
          if (drift && drift.flag === 'critical') {
            const guardConfig = loadGuardrailConfig();
            if (guardConfig.autoPause) {
              storage.pauseSession(session.hawkeyeSessionId);
              process.stderr.write(
                `[hawkeye] Auto-paused session: drift score critical (${drift.score}/100)\n`,
              );
            }
            if (guardConfig.webhooks.length > 0) {
              fireWebhooks(guardConfig.webhooks, 'drift_critical', {
                sessionId: session.hawkeyeSessionId,
                score: drift.score,
                objective: session.objective,
                autoPaused: guardConfig.autoPause,
              });
            }
          }

          // Update session tracking
          updateSessionTracking(
            claudeSessionId,
            costUsd,
            drift?.score,
          );

          storage.close();
          process.exit(0);
        } else if (eventType === 'Stop') {
          // ── Session end ──
          const sessions = loadSessions();
          const hookSession = sessions[claudeSessionId];

          if (hookSession) {
            // Compute final drift score
            const finalDrift =
              hookSession.driftScores.length > 0
                ? slidingDriftScore(hookSession.driftScores)
                : null;

            if (finalDrift !== null) {
              storage.updateFinalDriftScore(
                hookSession.hawkeyeSessionId,
                finalDrift,
              );
            }

            // End the session
            storage.endSession(hookSession.hawkeyeSessionId, 'completed');

            // Record session_end event
            const seq = storage.getNextSequence(hookSession.hawkeyeSessionId);
            storage.insertEvent({
              id: randomUUID(),
              sessionId: hookSession.hawkeyeSessionId,
              timestamp: new Date(),
              sequence: seq,
              type: 'session_end' as EventType,
              data: {
                description: hookData.stop_reason || 'Session ended',
                reasoning: `Total cost: $${hookSession.totalCostUsd.toFixed(4)}, Events: ${hookSession.eventCount}`,
              } as unknown as TraceEvent['data'],
              durationMs: 0,
              costUsd: 0,
            });

            // Remove from active sessions
            delete sessions[claudeSessionId];
            saveSessions(sessions);
          }

          storage.close();
          process.exit(0);
        } else {
          // Unknown event type — just record as-is
          storage.close();
          process.exit(0);
        }
      } catch (innerErr) {
        try {
          storage.close();
        } catch {}
        throw innerErr;
      }
    } catch (err) {
      // Never crash — always exit cleanly so we don't block Claude Code
      process.stderr.write(`hawkeye hook-handler error: ${String(err)}\n`);
      process.exit(0);
    }
  });
