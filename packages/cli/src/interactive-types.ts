export interface SlashCommand {
  name: string;
  desc: string;
}

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'return'
  | 'backspace'
  | 'tab'
  | 'escape'
  | 'delete'
  | 'home'
  | 'end'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-l'
  | 'ctrl-u'
  | 'char';

export interface Key {
  name: KeyName;
  ch?: string;
}

export interface AgentDef {
  name: string;
  command: string;
  description: string;
  needsInstall?: string;
  usesHooks?: boolean;
}

export type LocalProvider = 'lmstudio' | 'ollama';

export interface LocalProviderState {
  provider: LocalProvider;
  label: string;
  url: string;
  models: string[];
  available: boolean;
}

export interface AiderModelChoice {
  commandModel: string;
  sessionModel: string;
  env?: Record<string, string>;
}
