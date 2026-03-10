export interface FileProtectRule {
  name: string;
  type: 'file_protect';
  paths: string[];
  action: 'warn' | 'block';
}

export interface CommandBlockRule {
  name: string;
  type: 'command_block';
  patterns: string[];
  action: 'warn' | 'block';
}

export interface CostLimitRule {
  name: string;
  type: 'cost_limit';
  maxUsdPerSession: number;
  maxUsdPerHour?: number;
  action: 'warn' | 'block';
}

export interface TokenLimitRule {
  name: string;
  type: 'token_limit';
  maxTokensPerSession: number;
  action: 'warn' | 'block';
}

export interface DirectoryScopeRule {
  name: string;
  type: 'directory_scope';
  allowedDirs: string[];
  blockedDirs: string[];
  action: 'warn' | 'block';
}

export interface NetworkLockRule {
  name: string;
  type: 'network_lock';
  allowedHosts: string[];
  blockedHosts: string[];
  action: 'warn' | 'block';
}

export interface ReviewGateRule {
  name: string;
  type: 'review_gate';
  patterns: string[];
  action: 'block';
}

export interface PiiFilterRule {
  name: string;
  type: 'pii_filter';
  action: 'warn' | 'block';
  categories: string[]; // e.g. ['ssn', 'credit_card', 'email', 'phone', 'api_key', 'ip_address']
  scope: 'input' | 'output' | 'both'; // Cloudflare pattern: evaluate prompts, responses, or both
}

export interface PromptShieldRule {
  name: string;
  type: 'prompt_shield';
  action: 'warn' | 'block';
  scope: 'input' | 'output' | 'both';
}

export type GuardrailRuleConfig =
  | FileProtectRule
  | CommandBlockRule
  | CostLimitRule
  | TokenLimitRule
  | DirectoryScopeRule
  | NetworkLockRule
  | ReviewGateRule
  | PiiFilterRule
  | PromptShieldRule;

export interface GuardrailViolation {
  ruleName: string;
  severity: 'warn' | 'block';
  description: string;
  actionTaken: 'logged' | 'blocked' | 'session_aborted' | 'pending_review';
  matchedPattern?: string;
}
