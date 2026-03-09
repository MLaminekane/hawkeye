import { describe, it, expect } from 'vitest';
import { createGuardrailEnforcer } from './enforcer.js';
import type { GuardrailRuleConfig } from './rules.js';
import type { TraceEvent } from '../types.js';

function makeEvent(overrides: Partial<TraceEvent> & Pick<TraceEvent, 'type' | 'data'>): TraceEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    timestamp: new Date(),
    sequence: 1,
    durationMs: 0,
    ...overrides,
  };
}

const workingDir = '/home/user/project';

const rules: GuardrailRuleConfig[] = [
  {
    name: 'protected_files',
    type: 'file_protect',
    paths: ['.env', '.env.*', '*.pem', '*.key'],
    action: 'block',
  },
  {
    name: 'dangerous_commands',
    type: 'command_block',
    patterns: ['rm -rf /', 'rm -rf ~', 'sudo rm', 'DROP TABLE'],
    action: 'block',
  },
  {
    name: 'cost_limit',
    type: 'cost_limit',
    maxUsdPerSession: 5.0,
    maxUsdPerHour: 2.0,
    action: 'block',
  },
  {
    name: 'project_scope',
    type: 'directory_scope',
    allowedDirs: ['.'],
    blockedDirs: ['/etc', '/usr'],
    action: 'block',
  },
];

describe('GuardrailEnforcer', () => {
  it('blocks writes to .env files', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'file_write',
      data: { path: '/home/user/project/.env', action: 'write', sizeBytes: 50 },
    });
    const violations = enforcer.evaluate(event);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].ruleName).toBe('protected_files');
    expect(violations[0].actionTaken).toBe('blocked');
  });

  it('blocks reads of .env files', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'file_read',
      data: { path: '/home/user/project/.env', action: 'read', sizeBytes: 50 },
    });
    const violations = enforcer.evaluate(event);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].ruleName).toBe('protected_files');
    expect(violations[0].description).toContain('read');
  });

  it('blocks reads of .pem and .key files', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const pemEvent = makeEvent({
      type: 'file_read',
      data: { path: '/home/user/project/server.pem', action: 'read', sizeBytes: 200 },
    });
    const keyEvent = makeEvent({
      type: 'file_read',
      data: { path: '/home/user/project/private.key', action: 'read', sizeBytes: 100 },
    });
    expect(enforcer.evaluate(pemEvent).some((v) => v.ruleName === 'protected_files')).toBe(true);
    expect(enforcer.evaluate(keyEvent).some((v) => v.ruleName === 'protected_files')).toBe(true);
  });

  it('blocks writes to .pem files', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'file_write',
      data: { path: '/home/user/project/cert.pem', action: 'write', sizeBytes: 500 },
    });
    const violations = enforcer.evaluate(event);
    expect(violations.some((v) => v.ruleName === 'protected_files')).toBe(true);
  });

  it('blocks dangerous rm -rf / command', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'command',
      data: { command: 'rm', args: ['-rf', '/'], cwd: workingDir },
    });
    const violations = enforcer.evaluate(event);
    expect(violations.some((v) => v.ruleName === 'dangerous_commands')).toBe(true);
  });

  it('blocks DROP TABLE commands', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'command',
      data: { command: 'psql', args: ['-c', 'DROP TABLE users;'], cwd: workingDir },
    });
    const violations = enforcer.evaluate(event);
    expect(violations.some((v) => v.ruleName === 'dangerous_commands')).toBe(true);
  });

  it('allows normal file writes in project dir', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'file_write',
      data: { path: '/home/user/project/src/index.ts', action: 'write', sizeBytes: 200 },
    });
    const violations = enforcer.evaluate(event);
    expect(violations).toHaveLength(0);
  });

  it('allows normal commands', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'command',
      data: { command: 'npm', args: ['install'], cwd: workingDir },
    });
    const violations = enforcer.evaluate(event);
    expect(violations).toHaveLength(0);
  });

  it('blocks file writes to /etc/', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const event = makeEvent({
      type: 'file_write',
      data: { path: '/etc/hosts', action: 'write', sizeBytes: 100 },
    });
    const violations = enforcer.evaluate(event);
    expect(violations.some((v) => v.ruleName === 'project_scope')).toBe(true);
  });

  it('detects session cost limit exceeded', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const violation = enforcer.checkCostLimit(6.0, new Date());
    expect(violation).not.toBeNull();
    expect(violation?.ruleName).toBe('cost_limit');
  });

  it('allows costs within limit', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const violation = enforcer.checkCostLimit(1.0, new Date());
    expect(violation).toBeNull();
  });

  it('calls violation callbacks', () => {
    const enforcer = createGuardrailEnforcer(rules, workingDir);
    const violations: string[] = [];
    enforcer.onViolation((v) => violations.push(v.ruleName));

    const event = makeEvent({
      type: 'file_write',
      data: { path: '/home/user/project/.env', action: 'write', sizeBytes: 50 },
    });
    enforcer.evaluate(event);
    expect(violations.length).toBeGreaterThan(0);
  });
});
