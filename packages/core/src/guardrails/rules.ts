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

export interface SupplyChainAuditRule {
  name: string;
  type: 'supply_chain_audit';
  action: 'warn' | 'block';
  /** Block on vulnerability severity at or above this level */
  blockSeverity: 'critical' | 'high' | 'moderate' | 'low';
  /** Also audit before pnpm/yarn install */
  packageManagers: ('npm' | 'pnpm' | 'yarn' | 'bun')[];
}

export interface EgressMonitorRule {
  name: string;
  type: 'egress_monitor';
  action: 'warn' | 'block';
  /** Allowed outbound hosts for child processes (empty = alert on all non-localhost) */
  allowedHosts: string[];
  /** Check interval in milliseconds */
  checkIntervalMs: number;
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
  | PromptShieldRule
  | SupplyChainAuditRule
  | EgressMonitorRule;

export interface GuardrailViolation {
  ruleName: string;
  severity: 'warn' | 'block';
  description: string;
  actionTaken: 'logged' | 'blocked' | 'session_aborted' | 'pending_review';
  matchedPattern?: string;
}
