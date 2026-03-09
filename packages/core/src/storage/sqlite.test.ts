import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { Storage } from './sqlite.js';
import type { AgentSession, TraceEvent } from '../types.js';

const TEST_DB = '/tmp/hawkeye-test.db';

describe('Storage', () => {
  let storage: Storage;

  beforeEach(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {}
    storage = new Storage(TEST_DB);
  });

  afterEach(() => {
    storage.close();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  function makeSession(overrides?: Partial<AgentSession>): AgentSession {
    return {
      id: 'test-session-1',
      objective: 'Fix the auth bug',
      startedAt: new Date('2025-01-01T12:00:00Z'),
      status: 'recording',
      metadata: {
        agent: 'claude-code',
        model: 'claude-sonnet-4-20250514',
        workingDir: '/tmp/project',
      },
      totalCostUsd: 0,
      totalTokens: 0,
      totalActions: 0,
      ...overrides,
    };
  }

  it('creates and retrieves a session', () => {
    const session = makeSession();
    const result = storage.createSession(session);
    expect(result.ok).toBe(true);

    const getResult = storage.getSession('test-session-1');
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value?.objective).toBe('Fix the auth bug');
      expect(getResult.value?.agent).toBe('claude-code');
      expect(getResult.value?.status).toBe('recording');
    }
  });

  it('lists sessions', () => {
    storage.createSession(makeSession({ id: 'session-a', objective: 'Task A' }));
    storage.createSession(makeSession({ id: 'session-b', objective: 'Task B' }));

    const result = storage.listSessions();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('lists sessions with limit', () => {
    storage.createSession(makeSession({ id: 'session-a' }));
    storage.createSession(makeSession({ id: 'session-b' }));
    storage.createSession(makeSession({ id: 'session-c' }));

    const result = storage.listSessions({ limit: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('inserts and retrieves events', () => {
    storage.createSession(makeSession());

    const event: TraceEvent = {
      id: 'event-1',
      sessionId: 'test-session-1',
      timestamp: new Date('2025-01-01T12:01:00Z'),
      sequence: 1,
      type: 'command',
      data: {
        command: 'git',
        args: ['status'],
        cwd: '/tmp/project',
        exitCode: 0,
        stdout: 'On branch main',
      },
      durationMs: 150,
    };

    const insertResult = storage.insertEvent(event);
    expect(insertResult.ok).toBe(true);

    const eventsResult = storage.getEvents('test-session-1');
    expect(eventsResult.ok).toBe(true);
    if (eventsResult.ok) {
      expect(eventsResult.value).toHaveLength(1);
      expect(eventsResult.value[0].type).toBe('command');
      const data = JSON.parse(eventsResult.value[0].data);
      expect(data.command).toBe('git');
    }
  });

  it('tracks sequence numbers', () => {
    storage.createSession(makeSession());

    expect(storage.getNextSequence('test-session-1')).toBe(1);

    storage.insertEvent({
      id: 'e1',
      sessionId: 'test-session-1',
      timestamp: new Date(),
      sequence: 1,
      type: 'command',
      data: { command: 'ls', args: [], cwd: '/tmp' },
      durationMs: 10,
    });

    expect(storage.getNextSequence('test-session-1')).toBe(2);
  });

  it('ends a session and computes stats', () => {
    storage.createSession(makeSession());

    storage.insertEvent({
      id: 'e1',
      sessionId: 'test-session-1',
      timestamp: new Date(),
      sequence: 1,
      type: 'llm_call',
      data: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.005, latencyMs: 500 },
      durationMs: 500,
      costUsd: 0.005,
    });

    const endResult = storage.endSession('test-session-1', 'completed');
    expect(endResult.ok).toBe(true);

    const session = storage.getSession('test-session-1');
    if (session.ok && session.value) {
      expect(session.value.status).toBe('completed');
      expect(session.value.total_actions).toBe(1);
      expect(session.value.total_cost_usd).toBeCloseTo(0.005);
      expect(session.value.ended_at).toBeTruthy();
    }
  });
});
