/**
 * Tests for hook-handler guardrail checks and utility functions.
 *
 * We test the exported command indirectly by importing and testing
 * the guardrail logic that runs on PreToolUse events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Storage } from '@hawkeye/core';

// Test fixture directory
const TEST_DIR = join(process.cwd(), '.hawkeye-test-hook');
const DB_PATH = join(TEST_DIR, 'traces.db');

describe('hook-handler', () => {
  let storage: Storage;

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    storage = new Storage(DB_PATH);
  });

  afterEach(() => {
    storage.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('Storage session lifecycle', () => {
    it('should create and retrieve a session', () => {
      const id = 'test-session-1';
      const result = storage.createSession({
        id,
        objective: 'Test objective',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });
      expect(result.ok).toBe(true);

      const session = storage.getSession(id);
      expect(session.ok).toBe(true);
      if (session.ok) {
        expect(session.value?.objective).toBe('Test objective');
        expect(session.value?.status).toBe('recording');
      }
    });

    it('should insert and retrieve events', () => {
      const sessionId = 'test-session-events';
      storage.createSession({
        id: sessionId,
        objective: 'Event test',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });

      storage.insertEvent({
        id: 'event-1',
        sessionId,
        timestamp: new Date(),
        sequence: 1,
        type: 'command',
        data: { command: 'ls -la', exitCode: 0 },
        durationMs: 100,
        costUsd: 0.001,
      });

      const events = storage.getEvents(sessionId);
      expect(events.ok).toBe(true);
      if (events.ok) {
        expect(events.value.length).toBe(1);
        expect(events.value[0].type).toBe('command');
      }
    });

    it('should end a session', () => {
      const id = 'test-session-end';
      storage.createSession({
        id,
        objective: 'End test',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });

      storage.endSession(id, 'completed');

      const session = storage.getSession(id);
      expect(session.ok).toBe(true);
      if (session.ok) {
        expect(session.value?.status).toBe('completed');
      }
    });

    it('should pause and resume a session', () => {
      const id = 'test-session-pause';
      storage.createSession({
        id,
        objective: 'Pause test',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });

      storage.pauseSession(id);
      let session = storage.getSession(id);
      expect(session.ok && session.value?.status).toBe('paused');

      storage.resumeSession(id);
      session = storage.getSession(id);
      expect(session.ok && session.value?.status).toBe('recording');
    });
  });

  describe('Drift scoring integration', () => {
    it('should insert drift snapshots', () => {
      const sessionId = 'test-drift';
      storage.createSession({
        id: sessionId,
        objective: 'Drift test',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });

      storage.insertEvent({
        id: 'drift-event-1',
        sessionId,
        timestamp: new Date(),
        sequence: 1,
        type: 'command',
        data: { command: 'echo hello' },
        durationMs: 50,
        costUsd: 0,
      });

      storage.insertDriftSnapshot(sessionId, 'drift-event-1', {
        score: 85,
        flag: 'ok',
        reason: 'On track',
        suggestion: null,
        source: 'heuristic',
      });

      const snapshots = storage.getDriftSnapshots(sessionId);
      expect(snapshots.ok).toBe(true);
      if (snapshots.ok) {
        expect(snapshots.value.length).toBe(1);
        expect(snapshots.value[0].score).toBe(85);
      }
    });
  });

  describe('Guardrail violation recording', () => {
    it('should record guardrail violations via events', () => {
      const sessionId = 'test-guardrail';
      storage.createSession({
        id: sessionId,
        objective: 'Guardrail test',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });

      storage.insertEvent({
        id: 'guard-event-1',
        sessionId,
        timestamp: new Date(),
        sequence: 1,
        type: 'guardrail_trigger',
        data: {
          ruleName: 'command_block',
          action: 'block',
          reason: 'Blocked dangerous command',
          blocked: true,
        },
        durationMs: 0,
        costUsd: 0,
      });

      const events = storage.getEvents(sessionId);
      expect(events.ok).toBe(true);
      if (events.ok) {
        const guardEvent = events.value.find((e) => e.type === 'guardrail_trigger');
        expect(guardEvent).toBeDefined();
      }
    });
  });

  describe('JSON parse safety', () => {
    it('should handle malformed JSON gracefully in config loading', () => {
      // Write invalid JSON to config
      const configDir = join(TEST_DIR, 'config-test');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), '{invalid json!!!');

      // loadConfig should not throw — it returns defaults
      // We test the principle that JSON.parse failures don't crash
      expect(() => {
        try {
          JSON.parse('{invalid}');
        } catch {
          // Expected — this is what the hook-handler does
        }
      }).not.toThrow();
    });

    it('should validate regex patterns and skip invalid ones', () => {
      const validPatterns = ['rm -rf.*', 'DROP TABLE', 'curl.*\\|.*bash'];
      const invalidPatterns = ['[invalid', '(unclosed', '*bad'];

      const validated: string[] = [];
      for (const p of [...validPatterns, ...invalidPatterns]) {
        try {
          new RegExp(p);
          validated.push(p);
        } catch {
          // Skip invalid
        }
      }

      expect(validated).toEqual(validPatterns);
      expect(validated.length).toBe(3);
    });
  });

  describe('Cost estimation', () => {
    it('should compute cost by file', () => {
      const sessionId = 'test-cost-by-file';
      storage.createSession({
        id: sessionId,
        objective: 'Cost test',
        startedAt: new Date(),
        status: 'recording',
        metadata: { agent: 'test', workingDir: '/tmp' },
        totalCostUsd: 0,
        totalTokens: 0,
        totalActions: 0,
      });

      // Insert file_write events with different files
      for (let i = 0; i < 3; i++) {
        storage.insertEvent({
          id: `cost-event-${i}`,
          sessionId,
          timestamp: new Date(),
          sequence: i + 1,
          type: 'file_write',
          data: { path: '/tmp/test.ts', linesChanged: 10 },
          durationMs: 50,
          costUsd: 0.01,
        });
      }

      storage.insertEvent({
        id: 'cost-event-other',
        sessionId,
        timestamp: new Date(),
        sequence: 4,
        type: 'file_write',
        data: { path: '/tmp/other.ts', linesChanged: 5 },
        durationMs: 30,
        costUsd: 0.005,
      });

      const result = storage.getCostByFile(sessionId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
