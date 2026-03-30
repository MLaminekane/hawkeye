import type { PolicyRule as PolicyRuleType, SettingsData } from '../../api';

export interface GuardrailRule {
  name: string;
  type: string;
  enabled: boolean;
  action: string;
  config: Record<string, unknown>;
}

export interface WebhookSetting {
  enabled: boolean;
  url: string;
  events: string[];
}

export const DEFAULT_DRIFT = {
  enabled: true,
  checkEvery: 5,
  provider: 'ollama',
  model: 'llama3.2',
  warningThreshold: 60,
  criticalThreshold: 30,
  contextWindow: 10,
  autoPause: false,
  ollamaUrl: 'http://localhost:11434',
  lmstudioUrl: 'http://localhost:1234/v1',
};

export const WEBHOOK_EVENTS = [
  { value: 'drift_critical', label: 'Critical drift', description: 'Send alerts when drift reaches critical level.' },
  { value: 'guardrail_block', label: 'Guardrail block', description: 'Notify when an action is blocked by policy.' },
  { value: 'session_complete', label: 'Session complete', description: 'Report when a recording session finishes.' },
  { value: 'task_complete', label: 'Task complete', description: 'Notify when a tracked task completes.' },
  { value: 'overnight_report', label: 'Overnight report', description: 'Send the scheduled overnight summary.' },
  { value: 'autocorrect', label: 'Autocorrect', description: 'Notify when Hawkeye proposes or runs a correction.' },
  { value: 'swarm_complete', label: 'Swarm complete', description: 'Report when a swarm run finishes.' },
] as const;

export const LOCAL_MODEL_SUGGESTIONS: Record<string, string[]> = {
  ollama: ['llama3.2', 'qwen2.5-coder:7b', 'mistral'],
  lmstudio: ['local-model'],
};

export const DEFAULT_AUTOCORRECT: NonNullable<SettingsData['autocorrect']> = {
  enabled: false,
  dryRun: true,
  triggers: { driftCritical: true, errorRepeat: 3, costThreshold: 85 },
  actions: { rollbackFiles: true, pauseSession: true, injectHint: true, blockPattern: true },
};

export const GUARDRAIL_TYPES = [
  { value: 'file_protect', label: 'File Protect' },
  { value: 'command_block', label: 'Command Block' },
  { value: 'cost_limit', label: 'Cost Limit' },
  { value: 'token_limit', label: 'Token Limit' },
  { value: 'directory_scope', label: 'Directory Scope' },
  { value: 'network_lock', label: 'Network Lock' },
  { value: 'review_gate', label: 'Review Gate' },
  { value: 'pii_filter', label: 'PII Filter' },
  { value: 'prompt_shield', label: 'Prompt Shield' },
  { value: 'impact_threshold', label: 'Impact Threshold' },
];

export const DEFAULT_RULES: GuardrailRule[] = [
  {
    name: 'protected_files',
    type: 'file_protect',
    enabled: true,
    action: 'block',
    config: { paths: ['.env', '.env.*', '*.pem', '*.key'] },
  },
  {
    name: 'dangerous_commands',
    type: 'command_block',
    enabled: true,
    action: 'block',
    config: { patterns: ['rm -rf /', 'rm -rf ~', 'sudo rm', 'DROP TABLE', 'curl * | bash'] },
  },
  {
    name: 'cost_limit',
    type: 'cost_limit',
    enabled: true,
    action: 'block',
    config: { maxUsdPerSession: 5.0, maxUsdPerHour: 2.0 },
  },
  {
    name: 'token_limit',
    type: 'token_limit',
    enabled: false,
    action: 'warn',
    config: { maxTokensPerSession: 500000 },
  },
  {
    name: 'project_scope',
    type: 'directory_scope',
    enabled: false,
    action: 'block',
    config: { blockedDirs: ['/etc', '/usr', '~/.ssh'] },
  },
  {
    name: 'network_lock',
    type: 'network_lock',
    enabled: false,
    action: 'block',
    config: { allowedHosts: [], blockedHosts: [] },
  },
  {
    name: 'review_gate',
    type: 'review_gate',
    enabled: false,
    action: 'block',
    config: { patterns: ['git push --force', 'git push -f', 'migrate', 'DROP DATABASE'] },
  },
  {
    name: 'pii_filter',
    type: 'pii_filter',
    enabled: false,
    action: 'warn',
    config: { categories: ['ssn', 'credit_card', 'api_key', 'private_key'], scope: 'both' },
  },
  {
    name: 'prompt_shield',
    type: 'prompt_shield',
    enabled: false,
    action: 'warn',
    config: { scope: 'input' },
  },
];

export const POLICY_RULE_TYPES = [
  { value: 'file_protect', label: 'File Protect', description: 'Block writes to sensitive files' },
  { value: 'command_block', label: 'Command Block', description: 'Block dangerous shell commands' },
  { value: 'cost_limit', label: 'Cost Limit', description: 'Cap session spending' },
  { value: 'token_limit', label: 'Token Limit', description: 'Cap token usage per session' },
  { value: 'directory_scope', label: 'Directory Scope', description: 'Restrict access to directories' },
  { value: 'network_lock', label: 'Network Lock', description: 'Control allowed/blocked hosts' },
  { value: 'review_gate', label: 'Review Gate', description: 'Require human approval for commands' },
  { value: 'impact_threshold', label: 'Impact Threshold', description: 'Block high-impact actions' },
] as const;

export function defaultConfigForType(type: string): Record<string, unknown> {
  switch (type) {
    case 'file_protect':
      return { paths: ['.env', '*.pem', '*.key'] };
    case 'command_block':
      return { patterns: ['rm -rf /'] };
    case 'cost_limit':
      return { maxUsdPerSession: 10, maxUsdPerHour: 5 };
    case 'token_limit':
      return { maxTokensPerSession: 500000 };
    case 'directory_scope':
      return { blockedDirs: ['/etc', '/usr', '~/.ssh'] };
    case 'network_lock':
      return { allowedHosts: [], blockedHosts: [] };
    case 'review_gate':
      return { patterns: ['npm publish', 'docker push'] };
    case 'pii_filter':
      return { categories: ['ssn', 'credit_card', 'api_key', 'private_key'], scope: 'both' };
    case 'prompt_shield':
      return { scope: 'input' };
    case 'impact_threshold':
      return { blockAbove: 'critical', warnAbove: 'high' };
    default:
      return {};
  }
}

export function describeRule(rule: GuardrailRule): string {
  const c = rule.config;
  switch (rule.type) {
    case 'file_protect':
      return `Protects: ${(c.paths as string[]).join(', ')}`;
    case 'command_block':
      return `Blocks: ${(c.patterns as string[]).slice(0, 3).join(', ')}${(c.patterns as string[]).length > 3 ? '...' : ''}`;
    case 'cost_limit':
      return `Max $${c.maxUsdPerSession}/session, $${c.maxUsdPerHour}/hour`;
    case 'token_limit':
      return `Max ${(c.maxTokensPerSession as number).toLocaleString()} tokens/session`;
    case 'directory_scope':
      return `Blocked: ${(c.blockedDirs as string[]).join(', ')}`;
    case 'network_lock': {
      const allowed = (c.allowedHosts as string[]) || [];
      const blocked = (c.blockedHosts as string[]) || [];
      if (allowed.length > 0) return `Allowed hosts: ${allowed.join(', ')}`;
      if (blocked.length > 0) return `Blocked hosts: ${blocked.join(', ')}`;
      return 'No hosts configured — add allowed or blocked hosts';
    }
    case 'review_gate':
      return `Requires approval: ${(c.patterns as string[]).slice(0, 3).join(', ')}${(c.patterns as string[]).length > 3 ? '...' : ''}`;
    case 'pii_filter': {
      const cats = (c.categories as string[]) || [];
      const scope = c.scope || 'both';
      return `Scans ${scope}: ${cats.join(', ')}`;
    }
    case 'prompt_shield':
      return `Detects prompt injection (scope: ${c.scope || 'input'})`;
    default:
      return '';
  }
}

export function describePolicyRule(rule: PolicyRuleType): string {
  const c = rule.config;
  switch (rule.type) {
    case 'file_protect':
      return Array.isArray(c.paths) ? (c.paths as string[]).join(', ') : '';
    case 'command_block':
      return Array.isArray(c.patterns) ? (c.patterns as string[]).join(', ') : '';
    case 'cost_limit':
      return `$${c.maxUsdPerSession ?? '?'}/session${c.maxUsdPerHour ? `, $${c.maxUsdPerHour}/hour` : ''}`;
    case 'token_limit':
      return `${((c.maxTokensPerSession as number) || 0).toLocaleString()} tokens/session`;
    case 'directory_scope': {
      const blocked = (c.blockedDirs as string[]) || [];
      const allowed = (c.allowedDirs as string[]) || [];
      if (blocked.length > 0) return `Blocked: ${blocked.join(', ')}`;
      if (allowed.length > 0) return `Allowed: ${allowed.join(', ')}`;
      return 'No directories configured';
    }
    case 'network_lock': {
      const allowed = (c.allowedHosts as string[]) || [];
      const blocked = (c.blockedHosts as string[]) || [];
      if (allowed.length > 0) return `Allowed: ${allowed.join(', ')}`;
      if (blocked.length > 0) return `Blocked: ${blocked.join(', ')}`;
      return 'No hosts configured';
    }
    case 'review_gate':
      return Array.isArray(c.patterns) ? (c.patterns as string[]).join(', ') : '';
    case 'impact_threshold':
      return `Block: ${c.blockAbove || '-'}, Warn: ${c.warnAbove || '-'}`;
    default:
      return '';
  }
}
