/**
 * Policy Engine
 *
 * Declarative security policies in YAML format.
 * Shareable across projects and teams.
 *
 * File: .hawkeye/policies.yml
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── Policy Types ──

export interface PolicyRule {
  name: string;
  description?: string;
  type:
    | 'file_protect'
    | 'command_block'
    | 'cost_limit'
    | 'token_limit'
    | 'directory_scope'
    | 'network_lock'
    | 'review_gate'
    | 'impact_threshold';
  enabled: boolean;
  action: 'warn' | 'block';
  config: Record<string, unknown>;
}

export interface PolicyFile {
  version: '1';
  name: string;
  description?: string;
  rules: PolicyRule[];
}

export interface PolicyValidationError {
  rule: string;
  field: string;
  message: string;
}

// ── Default Template ──

const DEFAULT_POLICY: PolicyFile = {
  version: '1',
  name: 'default',
  description: 'Hawkeye security policy — edit to match your project',
  rules: [
    {
      name: 'protect-secrets',
      description: 'Block writes to sensitive files',
      type: 'file_protect',
      enabled: true,
      action: 'block',
      config: {
        paths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519'],
      },
    },
    {
      name: 'no-destructive-commands',
      description: 'Block dangerous shell commands',
      type: 'command_block',
      enabled: true,
      action: 'block',
      config: {
        patterns: [
          'rm -rf /',
          'rm -rf ~',
          'rm -rf .',
          'sudo rm',
          'mkfs*',
          'dd if=*of=/dev/*',
          '> /dev/sda',
        ],
      },
    },
    {
      name: 'no-sql-drop',
      description: 'Block destructive database operations',
      type: 'command_block',
      enabled: true,
      action: 'block',
      config: {
        patterns: ['DROP TABLE', 'DROP DATABASE', 'TRUNCATE TABLE'],
      },
    },
    {
      name: 'no-pipe-to-shell',
      description: 'Block piping remote content to shell',
      type: 'command_block',
      enabled: true,
      action: 'block',
      config: {
        patterns: ['curl * | bash', 'curl * | sh', 'wget * | bash', 'wget * | sh'],
      },
    },
    {
      name: 'stay-in-project',
      description: 'Block access to system directories',
      type: 'directory_scope',
      enabled: true,
      action: 'block',
      config: {
        blockedDirs: ['/etc', '/usr', '/var', '/sys', '/boot', '~/.ssh', '~/.gnupg', '~/.aws'],
      },
    },
    {
      name: 'cost-cap',
      description: 'Warn when session cost exceeds $10',
      type: 'cost_limit',
      enabled: false,
      action: 'warn',
      config: {
        maxUsdPerSession: 10,
        maxUsdPerHour: 5,
      },
    },
    {
      name: 'review-deploys',
      description: 'Require human approval for deploy commands',
      type: 'review_gate',
      enabled: false,
      action: 'block',
      config: {
        patterns: ['npm publish', 'docker push', 'kubectl apply', 'terraform apply'],
      },
    },
    {
      name: 'block-high-impact',
      description: 'Block actions with critical impact score',
      type: 'impact_threshold',
      enabled: true,
      action: 'block',
      config: {
        blockAbove: 'critical',
        warnAbove: 'high',
      },
    },
  ],
};

// ── File Operations ──

export function getPolicyPath(cwd: string): string {
  return join(cwd, '.hawkeye', 'policies.yml');
}

export function policyExists(cwd: string): boolean {
  return existsSync(getPolicyPath(cwd));
}

export function loadPolicy(cwd: string): PolicyFile | null {
  const path = getPolicyPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseYaml(raw) as PolicyFile;
  } catch {
    return null;
  }
}

export function savePolicy(cwd: string, policy: PolicyFile): void {
  const dir = join(cwd, '.hawkeye');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = getPolicyPath(cwd);
  const yaml = stringifyYaml(policy, { lineWidth: 100, defaultStringType: 'PLAIN' });
  writeFileSync(path, yaml, { mode: 0o600 });
}

export function generateTemplate(): PolicyFile {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY));
}

export function policyToYaml(policy: PolicyFile): string {
  return stringifyYaml(policy, { lineWidth: 100, defaultStringType: 'PLAIN' });
}

export function yamlToPolicy(yaml: string): PolicyFile {
  return parseYaml(yaml) as PolicyFile;
}

// ── Validation ──

const VALID_TYPES = new Set([
  'file_protect',
  'command_block',
  'cost_limit',
  'token_limit',
  'directory_scope',
  'network_lock',
  'review_gate',
  'impact_threshold',
]);

const VALID_ACTIONS = new Set(['warn', 'block']);

export function validatePolicy(policy: PolicyFile): PolicyValidationError[] {
  const errors: PolicyValidationError[] = [];

  if (policy.version !== '1') {
    errors.push({ rule: '(root)', field: 'version', message: `Unsupported version "${policy.version}", expected "1"` });
  }

  if (!policy.name || typeof policy.name !== 'string') {
    errors.push({ rule: '(root)', field: 'name', message: 'Policy must have a name' });
  }

  if (!Array.isArray(policy.rules)) {
    errors.push({ rule: '(root)', field: 'rules', message: 'Policy must have a rules array' });
    return errors;
  }

  const names = new Set<string>();
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    const ruleId = rule.name || `rules[${i}]`;

    if (!rule.name) {
      errors.push({ rule: ruleId, field: 'name', message: 'Rule must have a name' });
    } else if (names.has(rule.name)) {
      errors.push({ rule: ruleId, field: 'name', message: `Duplicate rule name "${rule.name}"` });
    }
    names.add(rule.name);

    if (!VALID_TYPES.has(rule.type)) {
      errors.push({ rule: ruleId, field: 'type', message: `Invalid type "${rule.type}". Valid: ${[...VALID_TYPES].join(', ')}` });
    }

    if (!VALID_ACTIONS.has(rule.action)) {
      errors.push({ rule: ruleId, field: 'action', message: `Invalid action "${rule.action}". Valid: warn, block` });
    }

    if (!rule.config || typeof rule.config !== 'object') {
      errors.push({ rule: ruleId, field: 'config', message: 'Rule must have a config object' });
      continue;
    }

    // Type-specific validation
    if (rule.type === 'file_protect') {
      if (!Array.isArray(rule.config.paths) || rule.config.paths.length === 0) {
        errors.push({ rule: ruleId, field: 'config.paths', message: 'file_protect requires a non-empty paths array' });
      }
    }

    if (rule.type === 'command_block') {
      if (!Array.isArray(rule.config.patterns) || rule.config.patterns.length === 0) {
        errors.push({ rule: ruleId, field: 'config.patterns', message: 'command_block requires a non-empty patterns array' });
      }
    }

    if (rule.type === 'cost_limit') {
      if (typeof rule.config.maxUsdPerSession !== 'number' || rule.config.maxUsdPerSession <= 0) {
        errors.push({ rule: ruleId, field: 'config.maxUsdPerSession', message: 'cost_limit requires a positive maxUsdPerSession' });
      }
    }

    if (rule.type === 'directory_scope') {
      const has = Array.isArray(rule.config.allowedDirs) || Array.isArray(rule.config.blockedDirs);
      if (!has) {
        errors.push({ rule: ruleId, field: 'config', message: 'directory_scope requires allowedDirs or blockedDirs' });
      }
    }

    if (rule.type === 'network_lock') {
      const has = Array.isArray(rule.config.allowedHosts) || Array.isArray(rule.config.blockedHosts);
      if (!has) {
        errors.push({ rule: ruleId, field: 'config', message: 'network_lock requires allowedHosts or blockedHosts' });
      }
    }

    if (rule.type === 'review_gate') {
      if (!Array.isArray(rule.config.patterns) || rule.config.patterns.length === 0) {
        errors.push({ rule: ruleId, field: 'config.patterns', message: 'review_gate requires a non-empty patterns array' });
      }
    }

    if (rule.type === 'impact_threshold') {
      const validLevels = new Set(['low', 'medium', 'high', 'critical']);
      if (rule.config.blockAbove && !validLevels.has(rule.config.blockAbove as string)) {
        errors.push({ rule: ruleId, field: 'config.blockAbove', message: `Invalid level. Valid: ${[...validLevels].join(', ')}` });
      }
      if (rule.config.warnAbove && !validLevels.has(rule.config.warnAbove as string)) {
        errors.push({ rule: ruleId, field: 'config.warnAbove', message: `Invalid level. Valid: ${[...validLevels].join(', ')}` });
      }
    }
  }

  return errors;
}

// ── Convert policy to guardrail config (for hook-handler compatibility) ──

export interface GuardrailConfigFromPolicy {
  protectedFiles: string[];
  dangerousCommands: string[];
  blockedDirs: string[];
  reviewGatePatterns: string[];
  networkLock: {
    enabled: boolean;
    action: string;
    allowedHosts: string[];
    blockedHosts: string[];
  } | null;
  impactThreshold: {
    blockAbove: string;
    warnAbove: string;
  } | null;
  costLimit: {
    maxUsdPerSession: number;
    maxUsdPerHour?: number;
    action: string;
  } | null;
}

export function policyToGuardrailConfig(policy: PolicyFile): GuardrailConfigFromPolicy {
  const result: GuardrailConfigFromPolicy = {
    protectedFiles: [],
    dangerousCommands: [],
    blockedDirs: [],
    reviewGatePatterns: [],
    networkLock: null,
    impactThreshold: null,
    costLimit: null,
  };

  for (const rule of policy.rules) {
    if (!rule.enabled) continue;

    switch (rule.type) {
      case 'file_protect':
        if (Array.isArray(rule.config.paths)) {
          result.protectedFiles.push(...(rule.config.paths as string[]));
        }
        break;

      case 'command_block':
        if (Array.isArray(rule.config.patterns)) {
          result.dangerousCommands.push(...(rule.config.patterns as string[]));
        }
        break;

      case 'directory_scope':
        if (Array.isArray(rule.config.blockedDirs)) {
          result.blockedDirs.push(...(rule.config.blockedDirs as string[]));
        }
        break;

      case 'review_gate':
        if (Array.isArray(rule.config.patterns)) {
          result.reviewGatePatterns.push(...(rule.config.patterns as string[]));
        }
        break;

      case 'network_lock':
        result.networkLock = {
          enabled: true,
          action: rule.action,
          allowedHosts: (rule.config.allowedHosts as string[]) || [],
          blockedHosts: (rule.config.blockedHosts as string[]) || [],
        };
        break;

      case 'impact_threshold':
        result.impactThreshold = {
          blockAbove: (rule.config.blockAbove as string) || 'critical',
          warnAbove: (rule.config.warnAbove as string) || 'high',
        };
        break;

      case 'cost_limit':
        result.costLimit = {
          maxUsdPerSession: rule.config.maxUsdPerSession as number,
          maxUsdPerHour: rule.config.maxUsdPerHour as number | undefined,
          action: rule.action,
        };
        break;
    }
  }

  return result;
}

// ── Convert existing config.json guardrails → policy YAML ──

export function configToPolicy(config: {
  guardrails?: Array<{
    name: string;
    type: string;
    enabled: boolean;
    action: string;
    config: Record<string, unknown>;
  }>;
}): PolicyFile {
  const policy: PolicyFile = {
    version: '1',
    name: 'imported',
    description: 'Imported from .hawkeye/config.json',
    rules: [],
  };

  if (!config.guardrails) return policy;

  for (const g of config.guardrails) {
    policy.rules.push({
      name: g.name || `rule-${policy.rules.length}`,
      type: g.type as PolicyRule['type'],
      enabled: g.enabled ?? true,
      action: (g.action as 'warn' | 'block') || 'block',
      config: g.config || {},
    });
  }

  return policy;
}
