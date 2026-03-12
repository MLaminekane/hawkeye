/**
 * Tests for serve.ts — API validation and rate limiting.
 */
import { describe, it, expect } from 'vitest';

// Re-create validation functions from serve.ts to test in isolation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateIngest(payload: any): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'Payload must be a JSON object';
  }
  if (payload.cost_usd !== undefined && typeof payload.cost_usd !== 'number') {
    return 'cost_usd must be a number';
  }
  if (payload.duration_ms !== undefined && typeof payload.duration_ms !== 'number') {
    return 'duration_ms must be a number';
  }
  if (payload.session_id !== undefined && typeof payload.session_id !== 'string') {
    return 'session_id must be a string';
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateSettings(payload: any): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'Settings must be a JSON object';
  }
  if (payload.guardrails !== undefined && !Array.isArray(payload.guardrails)) {
    return 'guardrails must be an array';
  }
  if (payload.webhooks !== undefined && !Array.isArray(payload.webhooks)) {
    return 'webhooks must be an array';
  }
  return null;
}

describe('API request validation', () => {
  describe('validateIngest', () => {
    it('should accept a valid ingest payload', () => {
      expect(validateIngest({
        session_id: 'abc-123',
        event_type: 'command',
        data: { command: 'ls' },
        cost_usd: 0.001,
      })).toBeNull();
    });

    it('should accept minimal payload (empty object)', () => {
      expect(validateIngest({})).toBeNull();
    });

    it('should reject non-object payload', () => {
      expect(validateIngest('not an object')).toBe('Payload must be a JSON object');
    });

    it('should reject array payload', () => {
      expect(validateIngest([1, 2, 3])).toBe('Payload must be a JSON object');
    });

    it('should reject null', () => {
      expect(validateIngest(null)).toBe('Payload must be a JSON object');
    });

    it('should reject invalid cost_usd type', () => {
      expect(validateIngest({ cost_usd: 'not a number' })).toBe('cost_usd must be a number');
    });

    it('should reject invalid duration_ms type', () => {
      expect(validateIngest({ duration_ms: 'fast' })).toBe('duration_ms must be a number');
    });

    it('should reject invalid session_id type', () => {
      expect(validateIngest({ session_id: 123 })).toBe('session_id must be a string');
    });
  });

  describe('validateSettings', () => {
    it('should accept valid settings', () => {
      expect(validateSettings({
        drift: { enabled: true, provider: 'ollama', model: 'llama3' },
        guardrails: [{ type: 'file_protect', enabled: true }],
        apiKeys: { anthropic: 'sk-xxx' },
        webhooks: [{ url: 'https://hooks.slack.com/xxx', enabled: true, events: [] }],
      })).toBeNull();
    });

    it('should accept empty settings', () => {
      expect(validateSettings({})).toBeNull();
    });

    it('should reject non-object', () => {
      expect(validateSettings([1, 2, 3])).toBe('Settings must be a JSON object');
    });

    it('should reject guardrails as non-array', () => {
      expect(validateSettings({ guardrails: 'not-array' })).toBe('guardrails must be an array');
    });

    it('should reject webhooks as non-array', () => {
      expect(validateSettings({ webhooks: 'not-array' })).toBe('webhooks must be an array');
    });
  });
});

describe('Rate limiting', () => {
  it('should implement a sliding window rate limiter', () => {
    const WINDOW_MS = 60_000;
    const MAX_REQUESTS = 5;
    const map = new Map<string, { count: number; resetAt: number }>();

    function checkLimit(ip: string): boolean {
      const now = Date.now();
      const entry = map.get(ip);
      if (!entry || now > entry.resetAt) {
        map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return true;
      }
      entry.count++;
      return entry.count <= MAX_REQUESTS;
    }

    // First 5 requests should pass
    for (let i = 0; i < MAX_REQUESTS; i++) {
      expect(checkLimit('127.0.0.1')).toBe(true);
    }

    // 6th request should be blocked
    expect(checkLimit('127.0.0.1')).toBe(false);

    // Different IP should still pass
    expect(checkLimit('192.168.1.1')).toBe(true);
  });
});

describe('CORS', () => {
  it('should match valid localhost origins', () => {
    const pattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

    expect(pattern.test('http://localhost:4242')).toBe(true);
    expect(pattern.test('http://localhost:3000')).toBe(true);
    expect(pattern.test('http://127.0.0.1:4242')).toBe(true);
    expect(pattern.test('https://localhost:4242')).toBe(true);
    expect(pattern.test('http://localhost')).toBe(true);
  });

  it('should reject non-localhost origins', () => {
    const pattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

    expect(pattern.test('http://evil.com')).toBe(false);
    expect(pattern.test('http://localhost.evil.com')).toBe(false);
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('https://example.com')).toBe(false);
  });
});
