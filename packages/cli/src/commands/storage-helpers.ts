import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Storage, type SessionRow } from '@mklamine/hawkeye-core';

export interface SessionResolution {
  kind: 'exact' | 'prefix' | 'missing' | 'ambiguous';
  session: SessionRow | null;
  matches: SessionRow[];
}

export function getHawkeyeDir(cwd: string = process.cwd()): string {
  return join(cwd, '.hawkeye');
}

export function ensureHawkeyeDir(cwd: string = process.cwd()): string {
  const dir = getHawkeyeDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getTraceDbPath(cwd: string = process.cwd()): string {
  return join(getHawkeyeDir(cwd), 'traces.db');
}

export function traceDbExists(cwd: string = process.cwd()): boolean {
  return existsSync(getTraceDbPath(cwd));
}

export function openTraceStorage(cwd: string = process.cwd(), options?: { createDir?: boolean }): Storage {
  if (options?.createDir) {
    ensureHawkeyeDir(cwd);
  }
  return new Storage(getTraceDbPath(cwd));
}

export function resolveSession(storage: Storage, input: string, minPrefixLength: number = 4): SessionResolution {
  const all = storage.listSessions();
  if (!all.ok || !all.value) {
    return { kind: 'missing', session: null, matches: [] };
  }

  const exact = all.value.find((session) => session.id === input);
  if (exact) {
    return { kind: 'exact', session: exact, matches: [exact] };
  }

  const matches = input.length >= minPrefixLength
    ? all.value.filter((session) => session.id.startsWith(input))
    : [];

  if (matches.length === 1) {
    return { kind: 'prefix', session: matches[0], matches };
  }

  if (matches.length > 1) {
    return { kind: 'ambiguous', session: null, matches };
  }

  return { kind: 'missing', session: null, matches: [] };
}

export function formatAmbiguousSessionMessage(matches: SessionRow[]): string {
  return `Ambiguous session ID. Matches: ${matches.map((session) => session.id.slice(0, 8)).join(', ')}`;
}
