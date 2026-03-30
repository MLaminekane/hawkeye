import type { McpServerEntry } from '../../api';
import { GUARDRAIL_TYPES, WEBHOOK_EVENTS, describeRule, type GuardrailRule, type WebhookSetting } from './constants';
import { Field, GuardrailConfigEditor, OverviewStat, StatusPill, Toggle } from './components';

type LocalProviderMap = Record<string, { available: boolean; models: string[]; url: string }>;

export function SettingsHero({
  saveStatus,
  saveMessage,
  policyStatus,
  driftEnabled,
  enabledRuleCount,
  rulesTotal,
  enabledPolicyCount,
  enabledWebhookCount,
  populatedApiKeyCount,
}: {
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveMessage: string;
  policyStatus: 'idle' | 'saving' | 'saved' | 'error';
  driftEnabled: boolean;
  enabledRuleCount: number;
  rulesTotal: number;
  enabledPolicyCount: number;
  enabledWebhookCount: number;
  populatedApiKeyCount: number;
}) {
  return (
    <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-0 h-52 w-52 rounded-full bg-hawk-orange/10 blur-3xl" />
        <div className="absolute right-[-30px] top-8 h-56 w-56 rounded-full bg-emerald-400/8 blur-3xl" />
        <div className="absolute bottom-[-60px] left-1/3 h-52 w-52 rounded-full bg-cyan-400/8 blur-3xl" />
      </div>

      <div className="relative grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
        <div className="space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
            <span
              className={`inline-block h-2 w-2 rounded-full ${saveStatus === 'error' ? 'bg-hawk-red' : saveStatus === 'saving' ? 'bg-hawk-orange animate-pulse' : 'bg-hawk-green'}`}
            />
            Settings
          </span>

          <div className="space-y-2">
            <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
              Control Center
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-hawk-text2">
              Configure DriftDetect, guardrails, policy rules, webhooks and API credentials from a
              single control surface.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <StatusPill
              label="Autosave"
              value={saveStatus === 'idle' ? 'ready' : saveStatus}
              tone={
                saveStatus === 'error'
                  ? 'danger'
                  : saveStatus === 'saved'
                    ? 'good'
                    : saveStatus === 'saving'
                      ? 'accent'
                      : 'muted'
              }
            />
            <StatusPill
              label="Policy"
              value={policyStatus === 'idle' ? 'ready' : policyStatus}
              tone={
                policyStatus === 'error'
                  ? 'danger'
                  : policyStatus === 'saved'
                    ? 'good'
                    : policyStatus === 'saving'
                      ? 'accent'
                      : 'muted'
              }
            />
            <StatusPill label="Drift" value={driftEnabled ? 'enabled' : 'disabled'} tone={driftEnabled ? 'good' : 'muted'} />
          </div>

          <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
              Current posture
            </div>
            <p className="mt-2 text-sm text-hawk-text2">
              {enabledRuleCount} guardrails enabled, {enabledPolicyCount} declarative policy rules
              active, and {enabledWebhookCount} live webhook{enabledWebhookCount === 1 ? '' : 's'}{' '}
              ready to notify.
            </p>
          </div>

          {saveMessage && (
            <div
              className={`rounded-[16px] border px-3 py-2.5 font-mono text-[11px] ${
                saveStatus === 'error'
                  ? 'border-hawk-red/30 bg-hawk-red/10 text-hawk-red'
                  : saveStatus === 'saved'
                    ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green'
                    : 'border-hawk-orange/25 bg-hawk-orange/10 text-hawk-orange'
              }`}
            >
              {saveMessage}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5">
            <OverviewStat label="Guardrails" value={`${enabledRuleCount}/${rulesTotal}`} meta="Enabled rules" tone="accent" />
            <OverviewStat label="Policies" value={String(enabledPolicyCount)} meta="Active policy rules" tone="good" />
            <OverviewStat label="Webhooks" value={String(enabledWebhookCount)} meta="Live endpoints" />
            <OverviewStat label="API keys" value={String(populatedApiKeyCount)} meta="Configured providers" />
          </div>

          <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
              Sync notes
            </div>
            <p className="mt-2 text-xs text-hawk-text2">
              Changes autosave to <span className="font-mono text-hawk-orange">.hawkeye/config.json</span> and policy edits sync to <span className="font-mono text-hawk-orange">.hawkeye/policies.yml</span>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LoadErrorBanner({
  loadError,
  onRetry,
}: {
  loadError: string;
  onRetry: () => void;
}) {
  if (!loadError) return null;

  return (
    <div className="flex items-center justify-between rounded-[16px] border border-hawk-amber/30 bg-hawk-amber/10 px-3 py-2.5 font-mono text-xs text-hawk-amber">
      <span>{loadError}</span>
      <button
        onClick={onRetry}
        className="rounded bg-hawk-amber/20 px-3 py-1 text-hawk-amber transition-colors hover:bg-hawk-amber/30"
      >
        Retry
      </button>
    </div>
  );
}

export function DriftSection({
  driftConfig,
  providerModels,
  localProviders,
  localProviderState,
  localProviderSuggestions,
  currentModels,
  onProviderChange,
  onDriftChange,
}: {
  driftConfig: {
    enabled: boolean;
    provider: string;
    model: string;
    checkEvery: number;
    contextWindow: number;
    warningThreshold: number;
    criticalThreshold: number;
    autoPause?: boolean;
    ollamaUrl?: string;
    lmstudioUrl?: string;
  };
  providerModels: Record<string, string[]>;
  localProviders: LocalProviderMap;
  localProviderState: { available: boolean; models: string[]; url: string } | null;
  localProviderSuggestions: string[];
  currentModels: string[];
  onProviderChange: (provider: string) => void;
  onDriftChange: (patch: Partial<typeof driftConfig>) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3 sm:px-5">
        <h2 className="font-display text-base font-semibold text-hawk-text">DriftDetect</h2>
        <Toggle enabled={driftConfig.enabled} onToggle={() => onDriftChange({ enabled: !driftConfig.enabled })} />
      </div>

      {driftConfig.enabled && (
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Provider
            </label>
            <select
              value={driftConfig.provider}
              onChange={(e) => onProviderChange(e.target.value)}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            >
              {Object.keys(providerModels).map((p) => (
                <option
                  key={p}
                  value={p}
                  disabled={
                    (p === 'ollama' || p === 'lmstudio') &&
                    localProviders[p] &&
                    !localProviders[p].available &&
                    driftConfig.provider !== p
                  }
                >
                  {p}
                  {(p === 'ollama' || p === 'lmstudio') && localProviders[p] && !localProviders[p].available ? ' (offline)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Model
            </label>
            {currentModels.length > 0 ? (
              <select
                value={driftConfig.model}
                onChange={(e) => onDriftChange({ model: e.target.value })}
                className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
              >
                {currentModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={driftConfig.model}
                onChange={(e) => onDriftChange({ model: e.target.value })}
                placeholder="Model name"
                className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
              />
            )}
            {currentModels.length === 0 && localProviderState && (
              <div className="mt-2 space-y-2">
                <div className="rounded-[14px] border border-hawk-amber/20 bg-hawk-amber/8 px-3 py-2 font-mono text-[10px] text-hawk-amber">
                  {localProviderState.available
                    ? `No ${driftConfig.provider} models were detected yet. Enter a model name manually or refresh the local runtime.`
                    : `${driftConfig.provider === 'ollama' ? 'Ollama' : 'LM Studio'} looks offline at ${localProviderState.url}. Start it, then come back here or enter a known model manually.`}
                </div>
                {localProviderSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {localProviderSuggestions.map((model) => (
                      <button
                        key={model}
                        type="button"
                        onClick={() => onDriftChange({ model })}
                        className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:border-hawk-orange/30 hover:text-hawk-orange"
                      >
                        {model}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {driftConfig.provider === 'ollama' && (
            <div className="col-span-2">
              <Field
                label="Ollama URL"
                value={driftConfig.ollamaUrl || 'http://localhost:11434'}
                onChange={(v) => onDriftChange({ ollamaUrl: v })}
              />
              {localProviderState && (
                <p className="mt-2 font-mono text-[10px] text-hawk-text3">
                  {localProviderState.available
                    ? `${localProviderState.models.length} model${localProviderState.models.length === 1 ? '' : 's'} detected from the local Ollama runtime.`
                    : 'Hawkeye could not reach the local Ollama runtime at this URL.'}
                </p>
              )}
            </div>
          )}

          {driftConfig.provider === 'lmstudio' && (
            <div className="col-span-2">
              <Field
                label="LM Studio URL"
                value={driftConfig.lmstudioUrl || 'http://localhost:1234/v1'}
                onChange={(v) => onDriftChange({ lmstudioUrl: v })}
              />
              {localProviderState && (
                <p className="mt-2 font-mono text-[10px] text-hawk-text3">
                  {localProviderState.available
                    ? `${localProviderState.models.length} model${localProviderState.models.length === 1 ? '' : 's'} detected from LM Studio.`
                    : 'Hawkeye could not reach LM Studio at this URL.'}
                </p>
              )}
            </div>
          )}

          {driftConfig.provider !== 'ollama' && driftConfig.provider !== 'lmstudio' && (
            <div className="col-span-2">
              <div className="rounded border border-hawk-border-subtle bg-hawk-surface2/60 px-3 py-2 font-mono text-[10px] text-hawk-text3">
                Requires {driftConfig.provider} API key — configure it in the <span className="text-hawk-orange">API Keys</span> section below
              </div>
            </div>
          )}

          <Field label="Check every N actions" value={String(driftConfig.checkEvery)} onChange={(v) => onDriftChange({ checkEvery: parseInt(v) || 5 })} type="number" />
          <Field label="Context window" value={String(driftConfig.contextWindow)} onChange={(v) => onDriftChange({ contextWindow: parseInt(v) || 10 })} type="number" />
          <Field label="Warning threshold" value={String(driftConfig.warningThreshold)} onChange={(v) => onDriftChange({ warningThreshold: parseInt(v) || 60 })} type="number" />
          <Field label="Critical threshold" value={String(driftConfig.criticalThreshold)} onChange={(v) => onDriftChange({ criticalThreshold: parseInt(v) || 30 })} type="number" />

          <div className="col-span-2 flex items-center gap-3 border-t border-hawk-border-subtle pt-2">
            <Toggle enabled={driftConfig.autoPause ?? false} onToggle={() => onDriftChange({ autoPause: !driftConfig.autoPause })} />
            <div>
              <span className="font-mono text-xs text-hawk-text">Auto-pause on critical drift</span>
              <p className="font-mono text-[10px] text-hawk-text3">
                Automatically pause recording when drift score drops to critical level
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function GuardrailsSection({
  rules,
  editingGuardrail,
  onToggleRule,
  onToggleAction,
  onToggleExpanded,
  onUpdateRuleName,
  onUpdateRuleType,
  onUpdateRuleConfig,
  onRemoveRule,
  onAddRule,
}: {
  rules: GuardrailRule[];
  editingGuardrail: number | null;
  onToggleRule: (index: number) => void;
  onToggleAction: (index: number) => void;
  onToggleExpanded: (index: number) => void;
  onUpdateRuleName: (index: number, name: string) => void;
  onUpdateRuleType: (index: number, type: string) => void;
  onUpdateRuleConfig: (index: number, config: Record<string, unknown>) => void;
  onRemoveRule: (index: number) => void;
  onAddRule: (type: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-5 py-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">Guardrails</h2>
        <div className="group relative">
          <button className="rounded bg-hawk-surface3 px-2.5 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:text-hawk-text">
            + Add rule
          </button>
          <div className="invisible absolute right-0 top-full z-10 mt-1 w-48 rounded-lg border border-hawk-border-subtle bg-hawk-surface shadow-xl group-hover:visible">
            {GUARDRAIL_TYPES.map((t) => (
              <button
                key={t.value}
                onClick={() => onAddRule(t.value)}
                className="block w-full px-3 py-2 text-left font-mono text-[11px] text-hawk-text3 transition-colors hover:bg-hawk-surface2 hover:text-hawk-text first:rounded-t-lg last:rounded-b-lg"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="divide-y divide-hawk-border-subtle">
        {rules.map((rule, i) => (
          <div key={`${rule.name}-${i}`} className="transition-colors hover:bg-hawk-surface2/35">
            <div className="flex items-start gap-3 px-3 py-3 sm:gap-4 sm:px-4">
              <Toggle enabled={rule.enabled} onToggle={() => onToggleRule(i)} />

              <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onToggleExpanded(i)}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-hawk-text">{rule.name}</span>
                  <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 font-mono text-[10px] text-hawk-text3">
                    {rule.type}
                  </span>
                </div>
                <div className="font-mono text-xs text-hawk-text3">{describeRule(rule)}</div>
              </div>

              <button
                onClick={() => onToggleAction(i)}
                className={`shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase ${
                  rule.action === 'block' ? 'bg-hawk-red/15 text-hawk-red' : 'bg-hawk-amber/15 text-hawk-amber'
                }`}
              >
                {rule.action}
              </button>

              <button
                onClick={() => onToggleExpanded(i)}
                className="shrink-0 rounded px-1.5 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:text-hawk-text"
              >
                {editingGuardrail === i ? '▲' : '▼'}
              </button>
            </div>

            {editingGuardrail === i && (
              <div className="mx-3 mb-3 ml-12 space-y-3 rounded-lg border border-hawk-border-subtle bg-hawk-surface2/40 p-3 sm:mx-4 sm:ml-14">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                      Rule name
                    </label>
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) => onUpdateRuleName(i, e.target.value)}
                      className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                      Type
                    </label>
                    <select
                      value={rule.type}
                      onChange={(e) => onUpdateRuleType(i, e.target.value)}
                      className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                    >
                      {GUARDRAIL_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <GuardrailConfigEditor rule={rule} onChange={(config) => onUpdateRuleConfig(i, config)} />

                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => onRemoveRule(i)}
                    className="rounded px-2.5 py-1 font-mono text-[10px] text-hawk-red transition-colors hover:bg-hawk-red/10"
                  >
                    Delete rule
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WebhooksSection({
  webhooks,
  onAddWebhook,
  onToggleWebhook,
  onUpdateWebhookUrl,
  onRemoveWebhook,
  onToggleWebhookEvent,
}: {
  webhooks: WebhookSetting[];
  onAddWebhook: () => void;
  onToggleWebhook: (index: number) => void;
  onUpdateWebhookUrl: (index: number, url: string) => void;
  onRemoveWebhook: (index: number) => void;
  onToggleWebhookEvent: (index: number, event: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-5 py-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">Webhooks</h2>
        <button
          onClick={onAddWebhook}
          className="rounded bg-hawk-surface3 px-2.5 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:text-hawk-text"
        >
          + Add webhook
        </button>
      </div>

      {webhooks.length === 0 ? (
        <div className="px-5 py-6 text-center">
          <p className="font-mono text-xs text-hawk-text3">No webhooks configured</p>
          <p className="mt-1 font-mono text-[10px] text-hawk-text3/60">
            Add a webhook to receive Slack/Discord notifications for session, swarm, drift, and autocorrect events
          </p>
        </div>
      ) : (
        <div className="divide-y divide-hawk-border-subtle">
          {webhooks.map((wh, i) => (
            <div key={i} className="space-y-3 px-4 py-4 sm:px-5">
              <div className="flex items-center gap-3">
                <Toggle enabled={wh.enabled} onToggle={() => onToggleWebhook(i)} />
                <input
                  type="url"
                  value={wh.url}
                  onChange={(e) => onUpdateWebhookUrl(i, e.target.value)}
                  placeholder="https://hooks.slack.com/services/... or Discord webhook URL"
                  className="flex-1 rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
                />
                <button
                  onClick={() => onRemoveWebhook(i)}
                  className="shrink-0 rounded px-2 py-1 font-mono text-[10px] text-hawk-red transition-colors hover:bg-hawk-red/10"
                >
                  Remove
                </button>
              </div>
              <div className="ml-0 flex flex-wrap items-center gap-2 sm:ml-12">
                <span className="mr-1 font-mono text-[10px] text-hawk-text3">Events:</span>
                {WEBHOOK_EVENTS.map((ev) => (
                  <button
                    key={ev.value}
                    onClick={() => onToggleWebhookEvent(i, ev.value)}
                    title={ev.description}
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                      wh.events.includes(ev.value)
                        ? 'border-hawk-orange/30 bg-hawk-orange/15 text-hawk-orange'
                        : 'border-hawk-border-subtle bg-hawk-surface3 text-hawk-text3 hover:text-hawk-text'
                    }`}
                  >
                    {ev.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ApiKeysSection({
  apiKeys,
  onUpdateApiKey,
}: {
  apiKeys: Record<string, string>;
  onUpdateApiKey: (provider: string, value: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-5 py-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">API Keys</h2>
      </div>
      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4">
        {(['anthropic', 'openai', 'deepseek', 'mistral', 'google'] as const).map((provider) => (
          <div key={provider}>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              {provider}
            </label>
            <input
              type="password"
              value={apiKeys[provider] || ''}
              onChange={(e) => onUpdateApiKey(provider, e.target.value)}
              placeholder={`${provider} API key`}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
            />
          </div>
        ))}
      </div>
      <div className="border-t border-hawk-border-subtle px-5 py-3">
        <p className="font-mono text-[10px] text-hawk-text3/60">
          Keys are saved to <code className="text-hawk-text3">config.json</code> and auto-injected
          as environment variables when recording.
        </p>
      </div>
    </div>
  );
}

export function AutocorrectSection({
  autocorrect,
  onAutocorrectChange,
}: {
  autocorrect: {
    enabled: boolean;
    dryRun: boolean;
    triggers: { driftCritical: boolean; errorRepeat: number; costThreshold: number };
    actions: { rollbackFiles: boolean; pauseSession: boolean; injectHint: boolean; blockPattern: boolean };
  };
  onAutocorrectChange: (next: typeof autocorrect) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3 sm:px-5">
        <h2 className="font-display text-base font-semibold text-hawk-text">Autocorrect</h2>
        <Toggle enabled={autocorrect.enabled} onToggle={() => onAutocorrectChange({ ...autocorrect, enabled: !autocorrect.enabled })} />
      </div>

      {autocorrect.enabled && (
        <div className="space-y-4 p-3 sm:p-4">
          <div className="flex items-center gap-3 rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 px-3 py-2.5">
            <Toggle enabled={autocorrect.dryRun} onToggle={() => onAutocorrectChange({ ...autocorrect, dryRun: !autocorrect.dryRun })} />
            <div>
              <span className="font-mono text-xs text-hawk-text">Dry run mode</span>
              <p className="font-mono text-[10px] text-hawk-text3">Log corrections without executing them</p>
            </div>
          </div>

          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-hawk-text3">Triggers</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="flex items-center gap-3 rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 px-3 py-2.5">
                <Toggle
                  enabled={autocorrect.triggers.driftCritical}
                  onToggle={() =>
                    onAutocorrectChange({
                      ...autocorrect,
                      triggers: { ...autocorrect.triggers, driftCritical: !autocorrect.triggers.driftCritical },
                    })
                  }
                />
                <span className="font-mono text-xs text-hawk-text">Critical drift</span>
              </div>
              <div className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 px-3 py-2.5">
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                  Error repeat count
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={autocorrect.triggers.errorRepeat}
                  onChange={(e) =>
                    onAutocorrectChange({
                      ...autocorrect,
                      triggers: { ...autocorrect.triggers, errorRepeat: parseInt(e.target.value) || 3 },
                    })
                  }
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </div>
              <div className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 px-3 py-2.5">
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                  Cost threshold %
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={autocorrect.triggers.costThreshold}
                  onChange={(e) =>
                    onAutocorrectChange({
                      ...autocorrect,
                      triggers: { ...autocorrect.triggers, costThreshold: parseInt(e.target.value) || 85 },
                    })
                  }
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-hawk-text3">Correction actions</div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {(
                [
                  ['rollbackFiles', 'Rollback files'],
                  ['pauseSession', 'Pause session'],
                  ['injectHint', 'Inject hint'],
                  ['blockPattern', 'Block pattern'],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2.5 rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 px-3 py-2.5">
                  <Toggle
                    enabled={autocorrect.actions[key]}
                    onToggle={() =>
                      onAutocorrectChange({
                        ...autocorrect,
                        actions: { ...autocorrect.actions, [key]: !autocorrect.actions[key] },
                      })
                    }
                  />
                  <span className="font-mono text-[11px] text-hawk-text">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function McpServersSection({
  mcpServers,
  mcpDraft,
  mcpExpanded,
  onSetExpanded,
  onDraftChange,
  onRemoveServer,
  onAddServer,
}: {
  mcpServers: Record<string, McpServerEntry>;
  mcpDraft: { name: string; package: string; envKey: string; envValue: string };
  mcpExpanded: boolean;
  onSetExpanded: (expanded: boolean) => void;
  onDraftChange: (draft: { name: string; package: string; envKey: string; envValue: string }) => void;
  onRemoveServer: (name: string) => void;
  onAddServer: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-surface2/40 px-5 py-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">MCP Servers</h2>
        <span className="font-mono text-xs text-hawk-text3">{Object.keys(mcpServers).length} configured</span>
      </div>
      <div className="divide-y divide-hawk-border-subtle">
        {Object.entries(mcpServers).map(([name, server]) => (
          <div key={name} className="flex items-center justify-between px-5 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="font-mono text-sm text-hawk-text">{name}</span>
              <span className="truncate font-mono text-[10px] text-hawk-text3">{server.args?.join(' ') || server.command}</span>
              {server.env && Object.keys(server.env).length > 0 && (
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-400">
                  {Object.keys(server.env).length} env
                </span>
              )}
            </div>
            {name !== 'hawkeye' && (
              <button
                onClick={() => onRemoveServer(name)}
                className="ml-2 rounded px-2 py-1 font-mono text-[10px] text-red-400 transition-colors hover:bg-red-500/10"
              >
                remove
              </button>
            )}
          </div>
        ))}
        {Object.keys(mcpServers).length === 0 && (
          <div className="px-5 py-4 text-center font-mono text-xs text-hawk-text3">
            No MCP servers configured. Add one below.
          </div>
        )}
      </div>

      <div className="border-t border-hawk-border-subtle px-5 py-3">
        {!mcpExpanded ? (
          <button
            onClick={() => onSetExpanded(true)}
            className="font-mono text-xs text-hawk-orange transition-colors hover:text-hawk-orange/80"
          >
            + Add MCP Server
          </button>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={mcpDraft.name}
                onChange={(e) => onDraftChange({ ...mcpDraft, name: e.target.value })}
                placeholder="Server name (e.g. slack)"
                className="rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
              />
              <input
                value={mcpDraft.package}
                onChange={(e) => onDraftChange({ ...mcpDraft, package: e.target.value })}
                placeholder="npm package (e.g. @modelcontextprotocol/server-slack)"
                className="rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
              />
              <input
                value={mcpDraft.envKey}
                onChange={(e) => onDraftChange({ ...mcpDraft, envKey: e.target.value })}
                placeholder="Env var name (e.g. SLACK_BOT_TOKEN)"
                className="rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
              />
              <input
                value={mcpDraft.envValue}
                onChange={(e) => onDraftChange({ ...mcpDraft, envValue: e.target.value })}
                placeholder="Token / API key value"
                type="password"
                className="rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={onAddServer}
                disabled={!mcpDraft.name || !mcpDraft.package}
                className="rounded bg-hawk-orange px-3 py-1.5 font-mono text-xs text-white transition-colors hover:bg-hawk-orange/80 disabled:opacity-40"
              >
                Add
              </button>
              <button
                onClick={() => {
                  onSetExpanded(false);
                  onDraftChange({ name: '', package: '', envKey: '', envValue: '' });
                }}
                className="rounded px-3 py-1.5 font-mono text-xs text-hawk-text3 transition-colors hover:text-hawk-text"
              >
                Cancel
              </button>
            </div>
            <p className="font-mono text-[9px] text-hawk-text3/60">
              Added servers appear in <code className="text-hawk-text3">.mcp.json</code> — Claude Code picks them up automatically.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfigHint() {
  return (
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <p className="font-mono text-xs text-hawk-text3">
        Settings are saved to <code className="text-hawk-orange">.hawkeye/config.json</code> and applied on next recording session.
      </p>
    </div>
  );
}
