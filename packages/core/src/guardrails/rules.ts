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

export type GuardrailRuleConfig =
  | FileProtectRule
  | CommandBlockRule
  | CostLimitRule
  | TokenLimitRule
  | DirectoryScopeRule
  | NetworkLockRule
  | ReviewGateRule;

export interface GuardrailViolation {
  ruleName: string;
  severity: 'warn' | 'block';
  description: string;
  actionTaken: 'logged' | 'blocked' | 'session_aborted';
}
