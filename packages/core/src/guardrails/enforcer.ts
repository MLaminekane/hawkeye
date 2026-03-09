import { resolve } from 'node:path';
import type { TraceEvent, CommandEvent, FileEvent, ApiEvent } from '../types.js';
import type { GuardrailRuleConfig, GuardrailViolation } from './rules.js';
import { Logger } from '../logger.js';

const logger = new Logger('guardrails');

export type ViolationCallback = (violation: GuardrailViolation, event: TraceEvent) => void;

export interface GuardrailEnforcer {
  evaluate(event: TraceEvent): GuardrailViolation[];
  onViolation(callback: ViolationCallback): void;
  checkCostLimit(currentCostUsd: number, sessionStartTime: Date): GuardrailViolation | null;
  checkTokenLimit(currentTokens: number): GuardrailViolation | null;
}

function matchesGlob(filePath: string, pattern: string): boolean {
  // Simple glob matching: supports * and **
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`(^|/)${regex}$`).test(filePath);
}

function matchesCommandPattern(fullCommand: string, pattern: string): boolean {
  // Support wildcard * in command patterns
  if (pattern.includes('*')) {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(regex, 'i').test(fullCommand);
  }
  return fullCommand.toLowerCase().includes(pattern.toLowerCase());
}

export function createGuardrailEnforcer(
  rules: GuardrailRuleConfig[],
  workingDir: string,
): GuardrailEnforcer {
  const violationCallbacks: ViolationCallback[] = [];

  function evaluateFileProtect(
    event: TraceEvent,
    rule: GuardrailRuleConfig & { type: 'file_protect' },
  ): GuardrailViolation | null {
    if (event.type !== 'file_read' && event.type !== 'file_write' && event.type !== 'file_delete') return null;

    const data = event.data as FileEvent;
    const filePath = data.path;
    const relativePath = filePath.replace(workingDir + '/', '').replace(workingDir, '');

    for (const pattern of rule.paths) {
      if (matchesGlob(relativePath, pattern) || matchesGlob(filePath, pattern)) {
        const verb = event.type === 'file_read' ? 'read' : event.type === 'file_write' ? 'write' : 'delete';
        return {
          ruleName: rule.name,
          severity: rule.action,
          description: `Protected file ${verb} ${rule.action === 'block' ? 'blocked' : 'warning'}: ${relativePath} matches pattern "${pattern}"`,
          actionTaken: rule.action === 'block' ? 'blocked' : 'logged',
        };
      }
    }

    return null;
  }

  function evaluateCommandBlock(
    event: TraceEvent,
    rule: GuardrailRuleConfig & { type: 'command_block' },
  ): GuardrailViolation | null {
    if (event.type !== 'command') return null;

    const data = event.data as CommandEvent;
    const fullCommand = `${data.command} ${data.args.join(' ')}`;

    for (const pattern of rule.patterns) {
      if (matchesCommandPattern(fullCommand, pattern)) {
        return {
          ruleName: rule.name,
          severity: rule.action,
          description: `Dangerous command ${rule.action === 'block' ? 'blocked' : 'detected'}: "${fullCommand}" matches pattern "${pattern}"`,
          actionTaken: rule.action === 'block' ? 'blocked' : 'logged',
        };
      }
    }

    return null;
  }

  function evaluateDirectoryScope(
    event: TraceEvent,
    rule: GuardrailRuleConfig & { type: 'directory_scope' },
  ): GuardrailViolation | null {
    if (event.type !== 'file_read' && event.type !== 'file_write' && event.type !== 'file_delete') return null;

    const data = event.data as FileEvent;
    const filePath = data.path;

    // Check blocked dirs
    for (const dir of rule.blockedDirs) {
      const resolvedDir = resolve(dir.replace('~', process.env.HOME || ''));
      if (filePath.startsWith(resolvedDir)) {
        return {
          ruleName: rule.name,
          severity: rule.action,
          description: `File operation in blocked directory: ${filePath} (blocked: ${dir})`,
          actionTaken: rule.action === 'block' ? 'blocked' : 'logged',
        };
      }
    }

    // Check if within allowed dirs
    if (rule.allowedDirs.length > 0) {
      const isAllowed = rule.allowedDirs.some((dir) => {
        const resolvedDir = dir === '.' ? workingDir : resolve(workingDir, dir);
        return filePath.startsWith(resolvedDir);
      });

      if (!isAllowed) {
        return {
          ruleName: rule.name,
          severity: rule.action,
          description: `File operation outside allowed directories: ${filePath}`,
          actionTaken: rule.action === 'block' ? 'blocked' : 'logged',
        };
      }
    }

    return null;
  }

  function evaluateNetworkLock(
    event: TraceEvent,
    rule: GuardrailRuleConfig & { type: 'network_lock' },
  ): GuardrailViolation | null {
    if (event.type !== 'api_call') return null;

    const data = event.data as ApiEvent;
    let hostname: string;
    try {
      hostname = new URL(data.url).hostname;
    } catch {
      hostname = data.url;
    }

    // Check blocked hosts
    for (const pattern of rule.blockedHosts) {
      if (hostname === pattern || hostname.endsWith('.' + pattern)) {
        return {
          ruleName: rule.name,
          severity: rule.action,
          description: `Network call to blocked host: ${hostname} (blocked: ${pattern})`,
          actionTaken: rule.action === 'block' ? 'blocked' : 'logged',
        };
      }
    }

    // Check if within allowed hosts (if specified)
    if (rule.allowedHosts.length > 0) {
      const isAllowed = rule.allowedHosts.some(
        (pattern) => hostname === pattern || hostname.endsWith('.' + pattern),
      );
      if (!isAllowed) {
        return {
          ruleName: rule.name,
          severity: rule.action,
          description: `Network call to unauthorized host: ${hostname} (not in allowlist)`,
          actionTaken: rule.action === 'block' ? 'blocked' : 'logged',
        };
      }
    }

    return null;
  }

  function evaluateReviewGate(
    event: TraceEvent,
    rule: GuardrailRuleConfig & { type: 'review_gate' },
  ): GuardrailViolation | null {
    if (event.type !== 'command') return null;

    const data = event.data as CommandEvent;
    const fullCommand = `${data.command} ${data.args.join(' ')}`;

    for (const pattern of rule.patterns) {
      if (matchesCommandPattern(fullCommand, pattern)) {
        return {
          ruleName: rule.name,
          severity: 'block',
          description: `Review gate: "${fullCommand}" requires human approval (matches: "${pattern}")`,
          actionTaken: 'pending_review',
          matchedPattern: pattern,
        };
      }
    }

    return null;
  }

  return {
    evaluate(event: TraceEvent): GuardrailViolation[] {
      const violations: GuardrailViolation[] = [];

      for (const rule of rules) {
        let violation: GuardrailViolation | null = null;

        switch (rule.type) {
          case 'file_protect':
            violation = evaluateFileProtect(event, rule);
            break;
          case 'command_block':
            violation = evaluateCommandBlock(event, rule);
            break;
          case 'directory_scope':
            violation = evaluateDirectoryScope(event, rule);
            break;
          case 'network_lock':
            violation = evaluateNetworkLock(event, rule);
            break;
          case 'review_gate':
            violation = evaluateReviewGate(event, rule);
            break;
          // cost_limit and token_limit are checked separately
        }

        if (violation) {
          violations.push(violation);
          logger.warn(`Guardrail violation [${rule.name}]: ${violation.description}`);

          for (const cb of violationCallbacks) {
            cb(violation, event);
          }
        }
      }

      return violations;
    },

    onViolation(callback: ViolationCallback): void {
      violationCallbacks.push(callback);
    },

    checkCostLimit(currentCostUsd: number, sessionStartTime: Date): GuardrailViolation | null {
      for (const rule of rules) {
        if (rule.type !== 'cost_limit') continue;

        if (currentCostUsd >= rule.maxUsdPerSession) {
          return {
            ruleName: rule.name,
            severity: rule.action,
            description: `Session cost limit exceeded: $${currentCostUsd.toFixed(4)} >= $${rule.maxUsdPerSession.toFixed(2)}`,
            actionTaken: rule.action === 'block' ? 'session_aborted' : 'logged',
          };
        }

        if (rule.maxUsdPerHour) {
          const hoursElapsed = (Date.now() - sessionStartTime.getTime()) / 3600000;
          if (hoursElapsed > 0) {
            const costPerHour = currentCostUsd / hoursElapsed;
            if (costPerHour >= rule.maxUsdPerHour) {
              return {
                ruleName: rule.name,
                severity: rule.action,
                description: `Hourly cost rate exceeded: $${costPerHour.toFixed(4)}/hr >= $${rule.maxUsdPerHour.toFixed(2)}/hr`,
                actionTaken: rule.action === 'block' ? 'session_aborted' : 'logged',
              };
            }
          }
        }
      }

      return null;
    },

    checkTokenLimit(currentTokens: number): GuardrailViolation | null {
      for (const rule of rules) {
        if (rule.type !== 'token_limit') continue;

        if (currentTokens >= rule.maxTokensPerSession) {
          return {
            ruleName: rule.name,
            severity: rule.action,
            description: `Session token limit exceeded: ${currentTokens} >= ${rule.maxTokensPerSession}`,
            actionTaken: rule.action === 'block' ? 'session_aborted' : 'logged',
          };
        }
      }

      return null;
    },
  };
}
