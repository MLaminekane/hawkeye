import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage, type AgentSession } from '@mklamine/hawkeye-core';
import { buildAgentInvocation, getAgentFullAccessArgs } from '../agent-command.js';
import { extractCodexFinalResponse, gatherContext, injectConfiguredApiKeys, isLightweightPrompt, shouldContinueSession, shouldInjectTaskContext, type Task } from '../daemon.js';
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
      args: ['exec', 'ship it'],
      agentName: 'codex',
    });

    expect(buildAgentInvocation('/bin/echo --flag', 'hello world')).toEqual({
      cmd: '/bin/echo',
      args: ['--flag', 'hello world'],
      agentName: 'echo',
    });
  });

  it('maps full-access flags per agent runtime', () => {
    expect(getAgentFullAccessArgs('claude')).toEqual(['--dangerously-skip-permissions']);
    expect(getAgentFullAccessArgs('codex')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(getAgentFullAccessArgs('aider')).toEqual([]);
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
    expect(
      shouldContinueSession('claude', [
        {
          ...recentTask,
          id: 'task-2',
          agent: 'codex',
        },
      ]),
    ).toBe(false);
    expect(
      shouldContinueSession('claude', [
        {
          ...recentTask,
          id: 'task-3',
          agent: 'claude-api/claude-sonnet-4-6',
        },
      ]),
    ).toBe(false);
    expect(shouldContinueSession('/bin/echo', [recentTask])).toBe(false);
  });

  it('skips injected daemon context for aider-backed local provider tasks', () => {
    expect(shouldInjectTaskContext('claude')).toBe(true);
    expect(shouldInjectTaskContext('codex')).toBe(false);
    expect(shouldInjectTaskContext('aider')).toBe(false);
    expect(shouldInjectTaskContext('aider --model sonnet')).toBe(false);
    expect(shouldInjectTaskContext('ollama/qwen3.5:cloud')).toBe(false);
    expect(shouldInjectTaskContext('lmstudio/my-model')).toBe(false);
    expect(shouldInjectTaskContext('ollama')).toBe(false);
  });

  it('treats tiny generic prompts as lightweight and leaves repo-aware prompts alone', () => {
    expect(isLightweightPrompt('salut')).toBe(true);
    expect(isLightweightPrompt('hello')).toBe(true);
    expect(isLightweightPrompt('test')).toBe(true);
    expect(isLightweightPrompt('que penses tu du projet ?')).toBe(true);
    expect(isLightweightPrompt('what do you think of the project?')).toBe(true);
    expect(isLightweightPrompt('fix the compare page header')).toBe(false);
    expect(isLightweightPrompt('look at packages/dashboard/src/pages/TasksPage.tsx')).toBe(false);
  });

  it('extracts the final codex answer without the execution transcript', () => {
    const output = [
      'OpenAI Codex v0.116.0 (research preview)',
      '--------',
      'workdir: /repo',
      'model: gpt-5.4',
      'user',
      '[User request]',
      'que penses tu du projet ?',
      'codex',
      'Je vais parcourir la structure du repo.',
      'exec',
      '/bin/zsh -lc "sed -n 1,40 README.md"',
      'codex',
      'Bon projet, avec une vraie thèse produit.',
      'tokens used',
      '8470',
    ].join('\n');

    expect(extractCodexFinalResponse(output)).toBe('Bon projet, avec une vraie thèse produit.');
  });

  it('removes ANTHROPIC_API_KEY for Claude Code subscription tasks', () => {
    const cwd = createTempProject();

    const merged = injectConfiguredApiKeys({
      ANTHROPIC_API_KEY: 'env-key',
      OPENAI_API_KEY: 'openai-key',
    }, cwd, 'claude');

    expect(merged.ANTHROPIC_API_KEY).toBeUndefined();
    expect(merged.OPENAI_API_KEY).toBe('openai-key');
  });
});
