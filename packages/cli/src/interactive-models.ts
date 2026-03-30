import chalk from 'chalk';
import {
  loadConfig,
  normalizeLmStudioUrl,
  PROVIDER_MODELS,
  type HawkeyeConfig,
} from './config.js';
import { AGENTS } from './interactive-constants.js';
import { o } from './interactive-display.js';
import { ensureClineProfile, injectConfiguredApiKeys } from './commands/daemon.js';
import type {
  AiderModelChoice,
  AgentDef,
  LocalProvider,
  LocalProviderState,
} from './interactive-types.js';

type PromptFn = (prompt: string) => Promise<string>;

interface ClineLaunchChoice {
  command: string;
  env: NodeJS.ProcessEnv;
  sessionModel: string | null;
}

export { AGENTS };
export type { AgentDef, LocalProvider, LocalProviderState, AiderModelChoice };

export function isLocalProvider(provider: string): provider is LocalProvider {
  return provider === 'lmstudio' || provider === 'ollama';
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].sort(
    (left, right) => left.localeCompare(right),
  );
}

export function getActiveLocalProvider(config: HawkeyeConfig): LocalProvider {
  return config.drift.provider === 'lmstudio' ? 'lmstudio' : 'ollama';
}

function hasConfiguredKey(config: HawkeyeConfig, provider: 'deepseek' | 'anthropic' | 'openai'): boolean {
  const envMap: Record<typeof provider, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
  };
  return Boolean(config.apiKeys?.[provider] || process.env[envMap[provider]]);
}

function getLocalProviderUrl(config: HawkeyeConfig, provider: LocalProvider): string {
  return provider === 'lmstudio'
    ? normalizeLmStudioUrl(config.drift.lmstudioUrl)
    : config.drift.ollamaUrl || 'http://localhost:11434';
}

async function fetchOllamaModels(ollamaUrl: string): Promise<LocalProviderState> {
  const baseUrl = trimTrailingSlash(ollamaUrl || 'http://localhost:11434');
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };

    return {
      provider: 'ollama',
      label: 'Ollama',
      url: baseUrl,
      models: uniqueSorted((data.models || []).map((model) => model.name || model.model)),
      available: true,
    };
  } catch {
    return {
      provider: 'ollama',
      label: 'Ollama',
      url: baseUrl,
      models: [],
      available: false,
    };
  }
}

async function fetchLmStudioModels(lmstudioUrl: string): Promise<LocalProviderState> {
  const baseUrl = trimTrailingSlash(lmstudioUrl || 'http://localhost:1234/v1');
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    return {
      provider: 'lmstudio',
      label: 'LM Studio',
      url: baseUrl,
      models: uniqueSorted((data.data || []).map((model) => model.id)),
      available: true,
    };
  } catch {
    return {
      provider: 'lmstudio',
      label: 'LM Studio',
      url: baseUrl,
      models: [],
      available: false,
    };
  }
}

async function loadLocalProviderStates(config: HawkeyeConfig): Promise<LocalProviderState[]> {
  const [lmstudio, ollama] = await Promise.all([
    fetchLmStudioModels(getLocalProviderUrl(config, 'lmstudio')),
    fetchOllamaModels(getLocalProviderUrl(config, 'ollama')),
  ]);

  return [lmstudio, ollama];
}

export async function pickLocalProvider(
  config: HawkeyeConfig,
  ask: PromptFn,
): Promise<LocalProvider | null> {
  const states = await loadLocalProviderStates(config);
  console.log('');
  console.log(chalk.dim('  Choose a local backend:'));
  console.log('');

  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const status = state.available
      ? chalk.dim(`${state.models.length} model${state.models.length === 1 ? '' : 's'}`)
      : chalk.yellow('unreachable');
    console.log(`  ${o.bold(`${index + 1})`)} ${chalk.white(state.label)} ${status}`);
    console.log(`     ${chalk.dim(state.url)}`);
  }

  console.log(`  ${o.bold('3)')} ${chalk.dim('Back')}`);
  console.log('');

  const pick = await ask(`  ${o('›')} `);
  if (pick === '1') return 'lmstudio';
  if (pick === '2') return 'ollama';
  return null;
}

export async function pickLocalModel(
  config: HawkeyeConfig,
  provider: LocalProvider,
  ask: PromptFn,
): Promise<string | null> {
  const state =
    provider === 'lmstudio'
      ? await fetchLmStudioModels(getLocalProviderUrl(config, 'lmstudio'))
      : await fetchOllamaModels(getLocalProviderUrl(config, 'ollama'));

  console.log('');
  console.log(chalk.dim(`  ${state.label} models:`));
  console.log('');

  if (!state.available) {
    console.log(chalk.yellow(`  ${state.label} is unreachable at ${state.url}.`));
    console.log(chalk.dim('  Start the local server, then try again.'));
    console.log('');
    return null;
  }

  if (state.models.length === 0) {
    console.log(chalk.yellow(`  No model loaded on ${state.label}.`));
    console.log(chalk.dim('  Enter a model name manually if you still want to continue.'));
    console.log('');
    const manual = await ask(`  ${chalk.dim('Model name:')} `);
    return manual || null;
  }

  for (let index = 0; index < state.models.length; index++) {
    console.log(`  ${o.bold(`${index + 1})`)} ${chalk.white(state.models[index])}`);
  }
  console.log(`  ${o.bold(`${state.models.length + 1}`)} ${chalk.white('Manual model')}`);
  console.log(`  ${o.bold(`${state.models.length + 2}`)} ${chalk.dim('Back')}`);
  console.log('');

  const pick = await ask(`  ${o('›')} `);
  const index = parseInt(pick, 10) - 1;
  if (index >= 0 && index < state.models.length) return state.models[index];
  if (index === state.models.length) {
    const manual = await ask(`  ${chalk.dim('Model name:')} `);
    return manual || null;
  }
  return null;
}

async function pickLocalProviderAndModel(
  config: HawkeyeConfig,
  ask: PromptFn,
): Promise<{ provider: LocalProvider; model: string } | null> {
  const provider = await pickLocalProvider(config, ask);
  if (!provider) return null;
  const model = await pickLocalModel(config, provider, ask);
  if (!model) return null;
  return { provider, model };
}

async function pickRemoteProviderModel(
  provider: 'deepseek' | 'anthropic' | 'openai',
  ask: PromptFn,
): Promise<string | null> {
  const models = PROVIDER_MODELS[provider] || [];
  if (models.length === 0) return null;

  console.log('');
  console.log(chalk.dim(`  ${provider} models:`));
  console.log('');
  for (let index = 0; index < models.length; index++) {
    console.log(`  ${o.bold(`${index + 1})`)} ${chalk.white(models[index])}`);
  }
  console.log(`  ${o.bold(`${models.length + 1}`)} ${chalk.white('Manual model')}`);
  console.log(`  ${o.bold(`${models.length + 2}`)} ${chalk.dim('Back')}`);
  console.log('');

  const pick = await ask(`  ${o('›')} `);
  const index = parseInt(pick, 10) - 1;
  if (index >= 0 && index < models.length) return models[index];
  if (index === models.length) {
    const manual = await ask(`  ${chalk.dim('Model name:')} `);
    return manual || null;
  }
  return null;
}

export async function pickClineLaunch(
  cwd: string,
  ask: PromptFn,
  baseEnv: NodeJS.ProcessEnv,
): Promise<ClineLaunchChoice | null> {
  const config = loadConfig(cwd);
  const localStates = await loadLocalProviderStates(config);
  const ollamaState = localStates.find((state) => state.provider === 'ollama');
  const lmstudioState = localStates.find((state) => state.provider === 'lmstudio');

  const options = [
    {
      id: 'configured',
      label: 'Cline default',
      detail: 'Use your local Cline setup as-is',
      available: true,
    },
    {
      id: 'ollama',
      label: 'Ollama',
      detail: ollamaState?.available
        ? `${ollamaState.models.length} model${ollamaState.models.length === 1 ? '' : 's'} detected`
        : 'local server unavailable',
      available: Boolean(ollamaState?.available),
    },
    {
      id: 'lmstudio',
      label: 'LM Studio',
      detail: lmstudioState?.available
        ? `${lmstudioState.models.length} model${lmstudioState.models.length === 1 ? '' : 's'} detected`
        : 'local server unavailable',
      available: Boolean(lmstudioState?.available),
    },
    {
      id: 'deepseek',
      label: 'DeepSeek API',
      detail: hasConfiguredKey(config, 'deepseek') ? 'API key available' : 'missing API key',
      available: hasConfiguredKey(config, 'deepseek'),
    },
    {
      id: 'anthropic',
      label: 'Anthropic API',
      detail: hasConfiguredKey(config, 'anthropic') ? 'API key available' : 'missing API key',
      available: hasConfiguredKey(config, 'anthropic'),
    },
    {
      id: 'openai',
      label: 'OpenAI API',
      detail: hasConfiguredKey(config, 'openai') ? 'API key available' : 'missing API key',
      available: hasConfiguredKey(config, 'openai'),
    },
  ] as const;

  console.log('');
  console.log(chalk.dim('  Choose a Cline provider:'));
  console.log('');
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const status = option.available ? chalk.dim(option.detail) : chalk.yellow(option.detail);
    console.log(`  ${o.bold(`${index + 1})`)} ${chalk.white(option.label)} ${status}`);
  }
  console.log(`  ${o.bold(`${options.length + 1}`)} ${chalk.dim('Back')}`);
  console.log('');

  const pick = await ask(`  ${o('›')} `);
  const index = parseInt(pick, 10) - 1;
  if (index < 0 || index >= options.length) return null;

  const chosen = options[index];
  if (!chosen.available) {
    console.log(chalk.yellow(`  ${chosen.label} is not ready yet.`));
    return null;
  }

  if (chosen.id === 'configured') {
    const env = injectConfiguredApiKeys(baseEnv, cwd, 'cline');
    return {
      command: ensureClineProfile('cline', cwd, env),
      env,
      sessionModel: null,
    };
  }

  let sessionModel: string | null = null;
  let profileCommand = '';

  if (chosen.id === 'ollama' || chosen.id === 'lmstudio') {
    const model = await pickLocalModel(config, chosen.id, ask);
    if (!model) return null;
    sessionModel = `${chosen.id}/${model}`;
    profileCommand = `cline/${chosen.id}/${model}`;
  } else {
    const model = await pickRemoteProviderModel(chosen.id, ask);
    if (!model) return null;
    sessionModel = `${chosen.id}/${model}`;
    profileCommand = `cline/${chosen.id}/${model}`;
  }

  const env = injectConfiguredApiKeys(baseEnv, cwd, profileCommand);
  try {
    return {
      command: ensureClineProfile(profileCommand, cwd, env),
      env,
      sessionModel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to configure Cline.';
    console.log('');
    console.log(chalk.red(`  ✗ ${message}`));
    console.log('');
    return null;
  }
}

export async function pickAiderModel(
  cwd: string,
  ask: PromptFn,
): Promise<AiderModelChoice | null> {
  const config = loadConfig(cwd);
  console.log('');
  console.log(chalk.dim('  Pick a model for Aider:'));
  console.log('');

  const models = [
    { label: 'DeepSeek Chat', value: 'deepseek/deepseek-chat', provider: 'DeepSeek' },
    { label: 'DeepSeek Reasoner', value: 'deepseek/deepseek-reasoner', provider: 'DeepSeek' },
    { label: 'Claude Sonnet', value: 'anthropic/claude-sonnet-4-6', provider: 'Anthropic' },
    { label: 'Claude Opus', value: 'anthropic/claude-opus-4-6', provider: 'Anthropic' },
    { label: 'GPT-4o', value: 'openai/gpt-4o', provider: 'OpenAI' },
    { label: 'GPT-4.1', value: 'openai/gpt-4.1', provider: 'OpenAI' },
    { label: 'Local', value: '__local__', provider: 'LM Studio / Ollama' },
    { label: 'Custom', value: '', provider: '' },
  ];

  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const provider = model.provider ? chalk.dim(` (${model.provider})`) : '';
    console.log(`  ${o.bold(`${index + 1})`)} ${chalk.white(model.label)}${provider}`);
  }
  console.log('');

  const pickedModel = await ask(`  ${o('›')} `);
  const pickedIndex = parseInt(pickedModel, 10);
  if (pickedIndex < 1 || pickedIndex > models.length) return null;

  const choice = models[pickedIndex - 1];
  if (choice.value === '__local__') {
    const local = await pickLocalProviderAndModel(config, ask);
    if (!local) return null;

    if (local.provider === 'lmstudio') {
      const lmstudioUrl = getLocalProviderUrl(config, 'lmstudio');
      const env: Record<string, string> = {
        AIDER_OPENAI_API_BASE: lmstudioUrl,
        OPENAI_API_BASE: lmstudioUrl,
        OPENAI_BASE_URL: lmstudioUrl,
      };
      if (process.env.AIDER_OPENAI_API_KEY) {
        env.AIDER_OPENAI_API_KEY = process.env.AIDER_OPENAI_API_KEY;
      } else if (process.env.OPENAI_API_KEY) {
        env.AIDER_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      } else {
        env.AIDER_OPENAI_API_KEY = 'lm-studio';
      }
      if (!process.env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = 'lm-studio';
      }
      return {
        commandModel: `openai/${local.model}`,
        sessionModel: `lmstudio/${local.model}`,
        env,
      };
    }

    return {
      commandModel: `ollama/${local.model}`,
      sessionModel: `ollama/${local.model}`,
    };
  }

  let model = choice.value;
  if (!model) {
    model = await ask(`  ${chalk.dim('Model name:')} `);
  }
  if (!model) return null;

  return {
    commandModel: model,
    sessionModel: model,
  };
}
