import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage, type AgentSession } from '@mklamine/hawkeye-core';
import { buildAgentInvocation } from '../agent-command.js';
import { gatherContext, shouldContinueSession, type Task } from '../daemon.js';
import { ensureHawkeyeDir, getTraceDbPath, openTraceStorage, resolveSession } from '../storage-helpers.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hawkeye-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeSession(id: string, objective: string): AgentSession {
  return {
    id,
    objective,
    startedAt: new Date('2026-03-23T00:00:00.000Z'),
    status: 'recording',
    metadata: {
      agent: 'claude-code',
      model: 'claude-sonnet-4-20250514',
      workingDir: '/tmp/project',
    },
    totalCostUsd: 0,
    totalTokens: 0,
    totalActions: 0,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('analyze/memory storage helpers', () => {
  it('use .hawkeye/traces.db as the shared CLI database path', () => {
    const cwd = createTempProject();

    expect(getTraceDbPath(cwd)).toBe(join(cwd, '.hawkeye', 'traces.db'));

    const storage = openTraceStorage(cwd, { createDir: true });
    storage.createSession(makeSession('analyze-session-0001', 'Analyze trace path'));
    storage.close();

    const reopened = new Storage(getTraceDbPath(cwd));
    const session = reopened.getSession('analyze-session-0001');
    reopened.close();

    expect(session.ok).toBe(true);
    expect(session.ok && session.value?.objective).toBe('Analyze trace path');
  });

  it('resolve short prefixes for analyze/memory and reject ambiguous prefixes', () => {
    const cwd = createTempProject();
    ensureHawkeyeDir(cwd);
    const storage = openTraceStorage(cwd);

    storage.createSession(makeSession('abcd1111-session-alpha', 'Alpha session'));
    storage.createSession(makeSession('abcd2222-session-beta', 'Beta session'));
    storage.createSession(makeSession('wxyz9999-session-gamma', 'Gamma session'));

    const unique = resolveSession(storage, 'wxyz');
    const ambiguous = resolveSession(storage, 'abcd');
    const tooShort = resolveSession(storage, 'abc');

    storage.close();

    expect(unique.kind).toBe('prefix');
    expect(unique.session?.id).toBe('wxyz9999-session-gamma');
    expect(ambiguous.kind).toBe('ambiguous');
    expect(ambiguous.matches).toHaveLength(2);
    expect(tooShort.kind).toBe('missing');
  });
});

describe('stats/inspect/replay short prefix resolution', () => {
  it('resolves a unique short prefix back to the full session id', () => {
    const cwd = createTempProject();
    const storage = openTraceStorage(cwd, { createDir: true });
    storage.createSession(makeSession('59de27ce-aa92-4c4b-9ca2-e5a4b44d8083', 'Replay me'));
    storage.createSession(makeSession('e5afa8fa-1122-3344-5566-77889900aabb', 'Inspect me'));

    const resolvedReplay = resolveSession(storage, '59de27ce');
    const resolvedInspect = resolveSession(storage, 'e5afa8fa');

    storage.close();

    expect(resolvedReplay.session?.id).toBe('59de27ce-aa92-4c4b-9ca2-e5a4b44d8083');
    expect(resolvedInspect.session?.id).toBe('e5afa8fa-1122-3344-5566-77889900aabb');
  });
});

describe('daemon/swarm/serve agent invocation', () => {
  it('uses native prompt flags for known agents and positional prompts for generic commands', () => {
    expect(buildAgentInvocation('claude', 'fix it', { continueConversation: true })).toEqual({
      cmd: 'claude',
      args: ['--continue', '-p', 'fix it'],
      agentName: 'claude',
    });

    expect(buildAgentInvocation('aider --model sonnet', 'review this')).toEqual({
      cmd: 'aider',
      args: ['--model', 'sonnet', '--message', 'review this', '--yes'],
      agentName: 'aider',
    });

    expect(buildAgentInvocation('codex', 'ship it')).toEqual({
      cmd: 'codex',
      args: ['-q', 'ship it'],
      agentName: 'codex',
    });

    expect(buildAgentInvocation('/bin/echo --flag', 'hello world')).toEqual({
      cmd: '/bin/echo',
      args: ['--flag', 'hello world'],
      agentName: 'echo',
    });
  });

  it('keeps daemon context building safe outside git repos and only continues Claude sessions', () => {
    const cwd = createTempProject();
    ensureHawkeyeDir(cwd);
    writeFileSync(join(cwd, '.hawkeye', 'task-journal.md'), '# Hawkeye Task Journal\n\n## [OK] test\n');

    const now = new Date().toISOString();
    const recentTask: Task = {
      id: 'task-1',
      prompt: 'Continue work',
      status: 'completed',
      createdAt: now,
      completedAt: now,
      agent: 'claude',
      exitCode: 0,
    };

    const context = gatherContext(cwd);

    expect(context).toContain('[Task history');
    expect(() => gatherContext(cwd)).not.toThrow();
    expect(shouldContinueSession('claude', [recentTask])).toBe(true);
    expect(shouldContinueSession('/bin/echo', [recentTask])).toBe(false);
  });
});
