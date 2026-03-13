import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// ─── Shape (matches dashboard SettingsData & serve getDefaultConfig) ─────

export interface DriftSettings {
  enabled: boolean;
  checkEvery: number;
  provider: string;
  model: string;
  warningThreshold: number;
  criticalThreshold: number;
  contextWindow: number;
  autoPause?: boolean;
  ollamaUrl?: string;
}

export interface RecordingSettings {
  ignorePatterns: string[];
  maxStdoutBytes: number;
  captureLlmContent: boolean;
}

export interface DashboardSettings {
  openBrowser: boolean;
}

export interface GuardrailRuleSetting {
  name: string;
  type: string;
  enabled: boolean;
  action: string;
  config: Record<string, unknown>;
}

export interface ApiKeysSettings {
  anthropic?: string;
  openai?: string;
  deepseek?: string;
  mistral?: string;
  google?: string;
}

export interface WebhookSettings {
  enabled: boolean;
  url: string;
  events: string[];
}

export interface HawkeyeConfig {
  drift: DriftSettings;
  guardrails: GuardrailRuleSetting[];
  apiKeys?: ApiKeysSettings;
  recording?: RecordingSettings;
  dashboard?: DashboardSettings;
  webhooks?: WebhookSettings[];
}

// ─── Provider models ─────────────────────────────────────────

export const PROVIDER_MODELS: Record<string, string[]> = {
  ollama: ['llama4', 'llama3.2', 'mistral', 'codellama', 'deepseek-coder', 'phi3'],
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-5',
    'gpt-5-mini',
    'o3',
    'o3-mini',
    'o4-mini',
  ],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: [
    'mistral-large-latest',
    'mistral-medium-latest',
    'mistral-small-latest',
    'codestral-latest',
    'devstral-latest',
  ],
  google: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
  ],
};

// ─── Defaults ────────────────────────────────────────────────

export function getDefaultConfig(): HawkeyeConfig {
  return {
    drift: {
      enabled: true,
      checkEvery: 5,
      provider: 'ollama',
      model: 'llama3.2',
      warningThreshold: 60,
      criticalThreshold: 30,
      contextWindow: 10,
      autoPause: true,
      ollamaUrl: 'http://localhost:11434',
    },
    recording: {
      ignorePatterns: [],
      maxStdoutBytes: 10240,
      captureLlmContent: false,
    },
    dashboard: {
      openBrowser: true,
    },
    guardrails: [
      {
        name: 'protected_files',
        type: 'file_protect',
        enabled: true,
        action: 'block',
        config: { paths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519', '*.credentials', '*.secret'] },
      },
      {
        name: 'dangerous_commands',
        type: 'command_block',
        enabled: true,
        action: 'block',
        config: {
          patterns: [
            'rm -rf /', 'rm -rf ~', 'rm -rf .', 'sudo rm',
            'DROP TABLE', 'DROP DATABASE', 'TRUNCATE TABLE',
            'curl * | bash', 'curl * | sh', 'wget * | bash', 'wget * | sh',
            'chmod 777', 'mkfs*', 'dd if=*of=/dev/*',
            '> /dev/sda',
          ],
        },
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
        enabled: true,
        action: 'block',
        config: { blockedDirs: ['/etc', '/usr', '/var', '/sys', '/boot', '~/.ssh', '~/.gnupg', '~/.aws'] },
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
    ],
    apiKeys: {},
    webhooks: [],
  };
}

// ─── Load / Save ─────────────────────────────────────────────

export function configPath(cwd: string): string {
  return join(cwd, '.hawkeye', 'config.json');
}

export function loadConfig(cwd: string): HawkeyeConfig {
  const p = configPath(cwd);
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      // Merge with defaults to fill missing fields
      const def = getDefaultConfig();
      return {
        drift: { ...def.drift, ...raw.drift },
        guardrails: raw.guardrails || def.guardrails,
        apiKeys: { ...def.apiKeys, ...raw.apiKeys },
        recording: { ...def.recording, ...raw.recording },
        dashboard: { ...def.dashboard, ...raw.dashboard },
        webhooks: raw.webhooks || [],
      };
    } catch {
      return getDefaultConfig();
    }
  }
  return getDefaultConfig();
}

export function saveConfig(cwd: string, config: HawkeyeConfig): void {
  const dir = join(cwd, '.hawkeye');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  const p = configPath(cwd);
  writeFileSync(p, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ─── Developer identity ───────────────────────────────────────

/** Get the current developer name from git config or OS user. */
export function getDeveloperName(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}
