import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandEvent } from '@mklamine/hawkeye-core';

interface PendingExecCall {
  command: string;
  cwd: string;
}

export interface CodexLineState {
  pendingExecCalls: Map<string, PendingExecCall>;
}

export interface CodexSessionBridge {
  start(): void;
  stop(): void;
  getSessionFile(): string | null;
}

export interface CodexSessionBridgeOptions {
  cwd: string;
  startTimeMs: number;
  onCommand: (event: CommandEvent) => void;
  onLinkedFile?: (filePath: string) => void;
  pollIntervalMs?: number;
  sessionsRoot?: string;
}

const DEFAULT_LOOKBACK_MS = 60_000;

export function createCodexLineState(): CodexLineState {
  return {
    pendingExecCalls: new Map(),
  };
}

export function consumeCodexJsonLine(line: string, state: CodexLineState): CommandEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];
  const outer = parsed as { type?: unknown; payload?: unknown };
  if (outer.type !== 'response_item' || typeof outer.payload !== 'object' || outer.payload === null) {
    return [];
  }

  const payload = outer.payload as {
    type?: unknown;
    name?: unknown;
    call_id?: unknown;
    arguments?: unknown;
    output?: unknown;
  };
  if (payload.type === 'function_call' && payload.name === 'exec_command' && typeof payload.call_id === 'string') {
    let args: unknown = null;
    try {
      args = JSON.parse(String(payload.arguments || '{}'));
    } catch {
      args = null;
    }
    if (typeof args !== 'object' || args === null) return [];
    const callArgs = args as { cmd?: unknown; workdir?: unknown };
    if (typeof callArgs.cmd !== 'string') return [];
    state.pendingExecCalls.set(payload.call_id, {
      command: callArgs.cmd,
      cwd: typeof callArgs.workdir === 'string' && callArgs.workdir ? callArgs.workdir : process.cwd(),
    });
    return [];
  }

  if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
    const pending = state.pendingExecCalls.get(payload.call_id);
    if (!pending) return [];
    state.pendingExecCalls.delete(payload.call_id);
    return [buildCommandEventFromCodexOutput(pending, typeof payload.output === 'string' ? payload.output : '')];
  }

  return [];
}

export function buildCommandEventFromCodexOutput(
  pending: PendingExecCall,
  rawOutput: string,
): CommandEvent {
  const exitCodeMatch = rawOutput.match(/Process exited with code (\d+)/);
  const outputMarker = '\nOutput:\n';
  const outputIndex = rawOutput.indexOf(outputMarker);
  const stdout = outputIndex >= 0
    ? rawOutput.slice(outputIndex + outputMarker.length).trim()
    : undefined;

  return {
    command: pending.command,
    args: [],
    cwd: pending.cwd,
    exitCode: exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : undefined,
    stdout: stdout || undefined,
  };
}

export function createCodexSessionBridge(options: CodexSessionBridgeOptions): CodexSessionBridge {
  const sessionsRoot = options.sessionsRoot || join(homedir(), '.codex', 'sessions');
  const initialFiles = new Set(listJsonlFiles(sessionsRoot));
  const state = createCodexLineState();
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  let interval: NodeJS.Timeout | null = null;
  let linkedFile: string | null = null;
  let offset = 0;
  let remainder = '';

  function processLinkedFile(): void {
    if (!linkedFile || !existsSync(linkedFile)) return;

    let content = '';
    try {
      content = readFileSync(linkedFile, 'utf-8');
    } catch {
      return;
    }

    if (content.length < offset) {
      offset = 0;
      remainder = '';
    }

    const chunk = content.slice(offset);
    offset = content.length;
    if (!chunk) return;

    const lines = `${remainder}${chunk}`.split('\n');
    remainder = lines.pop() ?? '';

    for (const line of lines) {
      const commandEvents = consumeCodexJsonLine(line, state);
      for (const event of commandEvents) {
        options.onCommand(event);
      }
    }
  }

  function linkSessionFile(): boolean {
    const file = findRelevantSessionFile({
      cwd: options.cwd,
      startTimeMs: options.startTimeMs,
      sessionsRoot,
      initialFiles,
    });
    if (!file) return false;
    if (file === linkedFile) return true;

    linkedFile = file;
    offset = 0;
    remainder = '';
    options.onLinkedFile?.(file);
    processLinkedFile();
    return true;
  }

  return {
    start(): void {
      if (!existsSync(sessionsRoot) || interval) return;
      interval = setInterval(() => {
        if (!linkedFile) {
          linkSessionFile();
          return;
        }
        processLinkedFile();
      }, pollIntervalMs);
      interval.unref?.();
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (linkedFile) {
        processLinkedFile();
      }
    },

    getSessionFile(): string | null {
      return linkedFile;
    },
  };
}

function findRelevantSessionFile(options: {
  cwd: string;
  startTimeMs: number;
  sessionsRoot: string;
  initialFiles: Set<string>;
}): string | null {
  const files = listJsonlFiles(options.sessionsRoot)
    .map((filePath) => {
      try {
        return { filePath, mtimeMs: statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const matchingFiles = files.filter((entry) => {
    const meta = readSessionMeta(entry.filePath);
    if (!meta || meta.cwd !== options.cwd) return false;
    const metaTimeMs = meta.timestamp ? Date.parse(meta.timestamp) : NaN;
    if (Number.isFinite(metaTimeMs)) {
      return metaTimeMs >= options.startTimeMs - DEFAULT_LOOKBACK_MS;
    }
    return entry.mtimeMs >= options.startTimeMs - DEFAULT_LOOKBACK_MS;
  });

  const freshFile = matchingFiles.find((entry) => !options.initialFiles.has(entry.filePath));
  if (freshFile) return freshFile.filePath;

  return matchingFiles[0]?.filePath ?? null;
}

function readSessionMeta(filePath: string): { cwd?: string; timestamp?: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n', 1)[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: unknown };
    if (parsed.type !== 'session_meta' || typeof parsed.payload !== 'object' || parsed.payload === null) {
      return null;
    }
    const payload = parsed.payload as { cwd?: unknown; timestamp?: unknown };
    return {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
    };
  } catch {
    return null;
  }
}

function listJsonlFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const results: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    try {
      const entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && fullPath.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}
