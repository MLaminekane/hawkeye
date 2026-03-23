import { useEffect, useRef, useState } from 'react';
import { api, type PolicyData, type PolicyRule as PolicyRuleType } from '../api';

interface GuardrailRule {
  name: string;
  type: string;
  enabled: boolean;
  action: string;
  config: Record<string, unknown>;
}

interface WebhookSetting {
  enabled: boolean;
  url: string;
  events: string[];
}

const DEFAULT_DRIFT = {
  enabled: true,
  checkEvery: 5,
  provider: 'ollama',
  model: 'llama3.2',
  warningThreshold: 60,
  criticalThreshold: 30,
  contextWindow: 10,
  autoPause: false,
  ollamaUrl: 'http://localhost:11434',
};

const WEBHOOK_EVENTS = ['drift_critical', 'guardrail_block'];

const DEFAULT_RULES: GuardrailRule[] = [
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

export function SettingsPage() {
  const [rules, setRules] = useState<GuardrailRule[]>(DEFAULT_RULES);
  const [driftConfig, setDriftConfig] = useState(DEFAULT_DRIFT);
  const [webhooks, setWebhooks] = useState<WebhookSetting[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [policy, setPolicy] = useState<PolicyData | null>(null);
  const [policyStatus, setPolicyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [policyErrors, setPolicyErrors] = useState<string[]>([]);
  const [editingRule, setEditingRule] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loadError, setLoadError] = useState('');
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const policySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Preserve fields the UI doesn't edit (recording, dashboard)
  const preservedFields = useRef<Pick<import('../api').SettingsData, 'recording' | 'dashboard'>>({});

  // Load settings + provider list from API
  const loadSettings = () => {
    setLoadError('');
    api.getSettings().then((data) => {
      if (data.drift) setDriftConfig({ ...DEFAULT_DRIFT, ...data.drift });
      if (data.guardrails) setRules(data.guardrails);
      if (data.webhooks) setWebhooks(data.webhooks);
      if (data.apiKeys) setApiKeys(data.apiKeys);
      preservedFields.current = {
        recording: data.recording,
        dashboard: data.dashboard,
      };
      setTimeout(() => { loaded.current = true; }, 100);
    }).catch(() => {
      setLoadError('Could not load settings from server');
      loaded.current = true;
    });

    api.getPolicies().then((p) => { if (p) setPolicy(p); }).catch(() => {});
  };

  useEffect(() => {
    loadSettings();

    api.getProviders().then(setProviderModels).catch(() => {
      // Fallback provider list
      setProviderModels({
        ollama: ['llama4', 'llama3.2', 'mistral', 'codellama', 'deepseek-coder', 'phi3'],
        anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
        openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'o4-mini'],
        deepseek: ['deepseek-chat', 'deepseek-reasoner'],
        mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'devstral-latest'],
        google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
      });
    });
  }, []);

  // Auto-save with debounce
  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await api.saveSettings({ drift: driftConfig, guardrails: rules, webhooks, apiKeys, ...preservedFields.current });
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 1500);
      } catch {
        setSaveStatus('error');
      }
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [driftConfig, rules, webhooks, apiKeys]);

  // Auto-save policy with debounce
  useEffect(() => {
    if (!loaded.current || !policy) return;
    if (policySaveTimer.current) clearTimeout(policySaveTimer.current);
    policySaveTimer.current = setTimeout(async () => {
      setPolicyStatus('saving');
      setPolicyErrors([]);
      try {
        const result = await api.savePolicies(policy);
        if (result.errors && result.errors.length > 0) {
          setPolicyErrors(result.errors.map((e) => `${e.rule}.${e.field}: ${e.message}`));
          setPolicyStatus('error');
        } else {
          setPolicyStatus('saved');
          setTimeout(() => setPolicyStatus('idle'), 1500);
        }
      } catch {
        setPolicyStatus('error');
      }
    }, 600);
    return () => { if (policySaveTimer.current) clearTimeout(policySaveTimer.current); };
  }, [policy]);

  // When provider changes, auto-select first model for that provider
  const handleProviderChange = (newProvider: string) => {
    const models = providerModels[newProvider] || [];
    setDriftConfig((p) => ({
      ...p,
      provider: newProvider,
      model: models[0] || '',
    }));
  };

  const toggleRule = (index: number) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, enabled: !r.enabled } : r));
  };

  const toggleAction = (index: number) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, action: r.action === 'block' ? 'warn' : 'block' } : r));
  };

  const currentModels = providerModels[driftConfig.provider] || [];
  const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
  const enabledWebhookCount = webhooks.filter((webhook) => webhook.enabled).length;
  const populatedApiKeyCount = Object.values(apiKeys).filter(Boolean).length;
  const enabledPolicyCount = policy?.rules.filter((rule) => rule.enabled).length || 0;

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-52 w-52 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute right-[-30px] top-8 h-56 w-56 rounded-full bg-emerald-400/8 blur-3xl" />
          <div className="absolute bottom-[-60px] left-1/3 h-52 w-52 rounded-full bg-cyan-400/8 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
          <div className="space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              <span className={`inline-block h-2 w-2 rounded-full ${saveStatus === 'error' ? 'bg-hawk-red' : saveStatus === 'saving' ? 'bg-hawk-orange animate-pulse' : 'bg-hawk-green'}`} />
              Settings
            </span>

            <div className="space-y-2">
              <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
                Control Center
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-hawk-text2">
                Configure DriftDetect, guardrails, policy rules, webhooks and API credentials from a single control surface.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <StatusPill label="Autosave" value={saveStatus === 'idle' ? 'ready' : saveStatus} tone={saveStatus === 'error' ? 'danger' : saveStatus === 'saved' ? 'good' : saveStatus === 'saving' ? 'accent' : 'muted'} />
              <StatusPill label="Policy" value={policyStatus === 'idle' ? 'ready' : policyStatus} tone={policyStatus === 'error' ? 'danger' : policyStatus === 'saved' ? 'good' : policyStatus === 'saving' ? 'accent' : 'muted'} />
              <StatusPill label="Drift" value={driftConfig.enabled ? 'enabled' : 'disabled'} tone={driftConfig.enabled ? 'good' : 'muted'} />
            </div>

            <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
                Current posture
              </div>
              <p className="mt-2 text-sm text-hawk-text2">
                {enabledRuleCount} guardrails enabled, {enabledPolicyCount} declarative policy rules active, and {enabledWebhookCount} live webhook{enabledWebhookCount === 1 ? '' : 's'} ready to notify.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5">
              <OverviewStat label="Guardrails" value={`${enabledRuleCount}/${rules.length}`} meta="Enabled rules" tone="accent" />
              <OverviewStat label="Policies" value={String(enabledPolicyCount)} meta="Active policy rules" tone="good" />
              <OverviewStat label="Webhooks" value={String(enabledWebhookCount)} meta="Live endpoints" />
              <OverviewStat label="API keys" value={String(populatedApiKeyCount)} meta="Configured providers" />
            </div>

            <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Sync notes</div>
              <p className="mt-2 text-xs text-hawk-text2">
                Changes autosave to <span className="font-mono text-hawk-orange">.hawkeye/config.json</span> and policy edits sync to <span className="font-mono text-hawk-orange">.hawkeye/policies.yml</span>.
              </p>
            </div>
          </div>
        </div>
      </section>

      {loadError && (
        <div className="flex items-center justify-between rounded-[16px] border border-hawk-amber/30 bg-hawk-amber/10 px-3 py-2.5 font-mono text-xs text-hawk-amber">
          <span>{loadError}</span>
          <button onClick={loadSettings} className="rounded bg-hawk-amber/20 px-3 py-1 text-hawk-amber transition-colors hover:bg-hawk-amber/30">
            Retry
          </button>
        </div>
      )}

      {/* DriftDetect Config */}
      <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
        <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 sm:px-5 py-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">DriftDetect</h2>
          <Toggle enabled={driftConfig.enabled} onToggle={() => { setDriftConfig((p) => ({ ...p, enabled: !p.enabled })); }} />
        </div>

        {driftConfig.enabled && (
          <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4">
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Provider</label>
              <select
                value={driftConfig.provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
              >
                {Object.keys(providerModels).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Model</label>
              {currentModels.length > 0 ? (
                <select
                  value={driftConfig.model}
                  onChange={(e) => { setDriftConfig((p) => ({ ...p, model: e.target.value })); }}
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                >
                  {currentModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={driftConfig.model}
                  onChange={(e) => { setDriftConfig((p) => ({ ...p, model: e.target.value })); }}
                  placeholder="Model name"
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              )}
            </div>

            {driftConfig.provider === 'ollama' && (
              <div className="col-span-2">
                <Field label="Ollama URL" value={driftConfig.ollamaUrl || 'http://localhost:11434'} onChange={(v) => { setDriftConfig((p) => ({ ...p, ollamaUrl: v })); }} />
              </div>
            )}

            {driftConfig.provider !== 'ollama' && (
              <div className="col-span-2">
                <div className="rounded border border-hawk-border-subtle bg-hawk-surface2/60 px-3 py-2 font-mono text-[10px] text-hawk-text3">
                  Requires {driftConfig.provider} API key — configure it in the <span className="text-hawk-orange">API Keys</span> section below
                </div>
              </div>
            )}

            <Field label="Check every N actions" value={String(driftConfig.checkEvery)} onChange={(v) => { setDriftConfig((p) => ({ ...p, checkEvery: parseInt(v) || 5 })); }} type="number" />
            <Field label="Context window" value={String(driftConfig.contextWindow)} onChange={(v) => { setDriftConfig((p) => ({ ...p, contextWindow: parseInt(v) || 10 })); }} type="number" />
            <Field label="Warning threshold" value={String(driftConfig.warningThreshold)} onChange={(v) => { setDriftConfig((p) => ({ ...p, warningThreshold: parseInt(v) || 60 })); }} type="number" />
            <Field label="Critical threshold" value={String(driftConfig.criticalThreshold)} onChange={(v) => { setDriftConfig((p) => ({ ...p, criticalThreshold: parseInt(v) || 30 })); }} type="number" />

            <div className="col-span-2 flex items-center gap-3 border-t border-hawk-border-subtle pt-2">
              <Toggle enabled={driftConfig.autoPause ?? false} onToggle={() => { setDriftConfig((p) => ({ ...p, autoPause: !p.autoPause })); }} />
              <div>
                <span className="font-mono text-xs text-hawk-text">Auto-pause on critical drift</span>
                <p className="font-mono text-[10px] text-hawk-text3">Automatically pause recording when drift score drops to critical level</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Guardrails */}
      <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
        <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-5 py-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">Guardrails</h2>
        </div>

        <div className="divide-y divide-hawk-border-subtle">
          {rules.map((rule, i) => (
            <div key={rule.name} className="flex items-start gap-3 sm:gap-4 px-3 sm:px-4 py-3 transition-colors hover:bg-hawk-surface2/35">
              <Toggle enabled={rule.enabled} onToggle={() => toggleRule(i)} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-sm text-hawk-text font-semibold">{rule.name}</span>
                  <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 font-mono text-[10px] text-hawk-text3">
                    {rule.type}
                  </span>
                </div>
                <div className="font-mono text-xs text-hawk-text3">
                  {describeRule(rule)}
                </div>
              </div>

              <button
                onClick={() => toggleAction(i)}
                className={`shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase ${rule.action === 'block'
                  ? 'bg-hawk-red/15 text-hawk-red'
                  : 'bg-hawk-amber/15 text-hawk-amber'
                  }`}
              >
                {rule.action}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Policy Engine */}
      <PolicySection
        policy={policy}
        setPolicy={setPolicy}
        policyStatus={policyStatus}
        policyErrors={policyErrors}
        editingRule={editingRule}
        setEditingRule={setEditingRule}
      />

      {/* Webhooks */}
      <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
        <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-5 py-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">Webhooks</h2>
          <button
            onClick={() => { setWebhooks((prev) => [...prev, { enabled: true, url: '', events: ['drift_critical'] }]); }}
            className="rounded bg-hawk-surface3 px-2.5 py-1 font-mono text-[10px] text-hawk-text3 hover:text-hawk-text transition-colors"
          >
            + Add webhook
          </button>
        </div>

        {webhooks.length === 0 ? (
          <div className="px-5 py-6 text-center">
            <p className="font-mono text-xs text-hawk-text3">No webhooks configured</p>
            <p className="font-mono text-[10px] text-hawk-text3/60 mt-1">Add a webhook to receive Slack/Discord notifications on drift or guardrail events</p>
          </div>
        ) : (
          <div className="divide-y divide-hawk-border-subtle">
            {webhooks.map((wh, i) => (
              <div key={i} className="px-4 sm:px-5 py-4 space-y-3">
                <div className="flex items-center gap-3">
                  <Toggle enabled={wh.enabled} onToggle={() => { setWebhooks((prev) => prev.map((w, j) => j === i ? { ...w, enabled: !w.enabled } : w)); }} />
                  <input
                    type="url"
                    value={wh.url}
                    onChange={(e) => { setWebhooks((prev) => prev.map((w, j) => j === i ? { ...w, url: e.target.value } : w)); }}
                    placeholder="https://hooks.slack.com/services/... or Discord webhook URL"
                    className="flex-1 rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
                  />
                  <button
                    onClick={() => { setWebhooks((prev) => prev.filter((_, j) => j !== i)); }}
                    className="shrink-0 rounded px-2 py-1 font-mono text-[10px] text-hawk-red hover:bg-hawk-red/10 transition-colors"
                  >
                    Remove
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 ml-0 sm:ml-12">
                  <span className="font-mono text-[10px] text-hawk-text3 mr-1">Events:</span>
                  {WEBHOOK_EVENTS.map((ev) => (
                    <button
                      key={ev}
                      onClick={() => {
                        setWebhooks((prev) => prev.map((w, j) => {
                          if (j !== i) return w;
                          const has = w.events.includes(ev);
                          return { ...w, events: has ? w.events.filter((e) => e !== ev) : [...w.events, ev] };
                        }));
                      }}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${wh.events.includes(ev)
                        ? 'bg-hawk-orange/15 text-hawk-orange border border-hawk-orange/30'
                        : 'bg-hawk-surface3 text-hawk-text3 border border-hawk-border-subtle hover:text-hawk-text'
                        }`}
                    >
                      {ev}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API Keys */}
      <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
        <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-5 py-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">API Keys</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4">
          {(['anthropic', 'openai', 'deepseek', 'mistral', 'google'] as const).map((provider) => (
            <div key={provider}>
              <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">
                {provider}
              </label>
              <input
                type="password"
                value={apiKeys[provider] || ''}
                onChange={(e) => { setApiKeys((p) => ({ ...p, [provider]: e.target.value })); }}
                placeholder={`${provider} API key`}
                className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
              />
            </div>
          ))}
        </div>
        <div className="border-t border-hawk-border-subtle px-5 py-3">
          <p className="font-mono text-[10px] text-hawk-text3/60">
            Keys are saved to <code className="text-hawk-text3">config.json</code> and auto-injected as environment variables when recording.
          </p>
        </div>
      </div>

      {/* Config file hint */}
      <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
        <p className="font-mono text-xs text-hawk-text3">
          Settings are saved to{' '}
          <code className="text-hawk-orange">.hawkeye/config.json</code>{' '}
          and applied on next recording session.
        </p>
      </div>
    </div>
  );
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-hawk-orange' : 'bg-hawk-surface3'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function Field({ label, value, onChange, type }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">{label}</label>
      <input
        type={type || 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/60 px-3 py-2 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
      />
    </div>
  );
}

function OverviewStat({
  label,
  value,
  meta,
  tone = 'default',
}: {
  label: string;
  value: string;
  meta: string;
  tone?: 'default' | 'accent' | 'good';
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-hawk-orange'
      : tone === 'good'
        ? 'text-hawk-green'
        : 'text-hawk-text';

  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/50 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text3">{meta}</div>
    </div>
  );
}

function StatusPill({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'good' | 'accent' | 'danger';
}) {
  const toneClass =
    tone === 'good'
      ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green'
      : tone === 'accent'
        ? 'border-hawk-orange/25 bg-hawk-orange/10 text-hawk-orange'
        : tone === 'danger'
          ? 'border-hawk-red/25 bg-hawk-red/10 text-hawk-red'
          : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text2';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${toneClass}`}>
      <span className="text-hawk-text3">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function describeRule(rule: GuardrailRule): string {
  const c = rule.config;
  switch (rule.type) {
    case 'file_protect': return `Protects: ${(c.paths as string[]).join(', ')}`;
    case 'command_block': return `Blocks: ${(c.patterns as string[]).slice(0, 3).join(', ')}${(c.patterns as string[]).length > 3 ? '...' : ''}`;
    case 'cost_limit': return `Max $${c.maxUsdPerSession}/session, $${c.maxUsdPerHour}/hour`;
    case 'token_limit': return `Max ${(c.maxTokensPerSession as number).toLocaleString()} tokens/session`;
    case 'directory_scope': return `Blocked: ${(c.blockedDirs as string[]).join(', ')}`;
    case 'network_lock': {
      const allowed = (c.allowedHosts as string[] || []);
      const blocked = (c.blockedHosts as string[] || []);
      if (allowed.length > 0) return `Allowed hosts: ${allowed.join(', ')}`;
      if (blocked.length > 0) return `Blocked hosts: ${blocked.join(', ')}`;
      return 'No hosts configured — add allowed or blocked hosts';
    }
    case 'review_gate': return `Requires approval: ${(c.patterns as string[]).slice(0, 3).join(', ')}${(c.patterns as string[]).length > 3 ? '...' : ''}`;
    case 'pii_filter': {
      const cats = (c.categories as string[] || []);
      const scope = c.scope || 'both';
      return `Scans ${scope}: ${cats.join(', ')}`;
    }
    case 'prompt_shield': {
      return `Detects prompt injection (scope: ${c.scope || 'input'})`;
    }
    default: return '';
  }
}

// ─── Policy Rule Types ──────────────────────────────────────────

const POLICY_RULE_TYPES = [
  { value: 'file_protect', label: 'File Protect', description: 'Block writes to sensitive files' },
  { value: 'command_block', label: 'Command Block', description: 'Block dangerous shell commands' },
  { value: 'cost_limit', label: 'Cost Limit', description: 'Cap session spending' },
  { value: 'token_limit', label: 'Token Limit', description: 'Cap token usage per session' },
  { value: 'directory_scope', label: 'Directory Scope', description: 'Restrict access to directories' },
  { value: 'network_lock', label: 'Network Lock', description: 'Control allowed/blocked hosts' },
  { value: 'review_gate', label: 'Review Gate', description: 'Require human approval for commands' },
  { value: 'impact_threshold', label: 'Impact Threshold', description: 'Block high-impact actions' },
] as const;

function defaultConfigForType(type: string): Record<string, unknown> {
  switch (type) {
    case 'file_protect': return { paths: ['.env', '*.pem', '*.key'] };
    case 'command_block': return { patterns: ['rm -rf /'] };
    case 'cost_limit': return { maxUsdPerSession: 10, maxUsdPerHour: 5 };
    case 'token_limit': return { maxTokensPerSession: 500000 };
    case 'directory_scope': return { blockedDirs: ['/etc', '/usr', '~/.ssh'] };
    case 'network_lock': return { allowedHosts: [], blockedHosts: [] };
    case 'review_gate': return { patterns: ['npm publish', 'docker push'] };
    case 'impact_threshold': return { blockAbove: 'critical', warnAbove: 'high' };
    default: return {};
  }
}

function describePolicyRule(rule: PolicyRuleType): string {
  const c = rule.config;
  switch (rule.type) {
    case 'file_protect': return Array.isArray(c.paths) ? (c.paths as string[]).join(', ') : '';
    case 'command_block': return Array.isArray(c.patterns) ? (c.patterns as string[]).join(', ') : '';
    case 'cost_limit': return `$${c.maxUsdPerSession ?? '?'}/session${c.maxUsdPerHour ? `, $${c.maxUsdPerHour}/hour` : ''}`;
    case 'token_limit': return `${((c.maxTokensPerSession as number) || 0).toLocaleString()} tokens/session`;
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
    case 'review_gate': return Array.isArray(c.patterns) ? (c.patterns as string[]).join(', ') : '';
    case 'impact_threshold': return `Block: ${c.blockAbove || '-'}, Warn: ${c.warnAbove || '-'}`;
    default: return '';
  }
}

// ─── Policy Section Component ───────────────────────────────────

function PolicySection({
  policy,
  setPolicy,
  policyStatus,
  policyErrors,
  editingRule,
  setEditingRule,
}: {
  policy: PolicyData | null;
  setPolicy: (p: PolicyData | null) => void;
  policyStatus: string;
  policyErrors: string[];
  editingRule: number | null;
  setEditingRule: (i: number | null) => void;
}) {
  const initPolicy = () => {
    setPolicy({
      version: '1',
      name: 'project',
      description: 'Project security policy',
      rules: [
        {
          name: 'protect-secrets',
          description: 'Block writes to sensitive files',
          type: 'file_protect',
          enabled: true,
          action: 'block',
          config: { paths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519'] },
        },
        {
          name: 'no-destructive-commands',
          description: 'Block dangerous shell commands',
          type: 'command_block',
          enabled: true,
          action: 'block',
          config: { patterns: ['rm -rf /', 'rm -rf ~', 'sudo rm', 'DROP TABLE', 'curl * | bash'] },
        },
        {
          name: 'block-high-impact',
          description: 'Block actions with critical impact score',
          type: 'impact_threshold',
          enabled: true,
          action: 'block',
          config: { blockAbove: 'critical', warnAbove: 'high' },
        },
      ],
    });
  };

  const updateRule = (index: number, partial: Partial<PolicyRuleType>) => {
    if (!policy) return;
    setPolicy({
      ...policy,
      rules: policy.rules.map((r, i) => i === index ? { ...r, ...partial } : r),
    });
  };

  const removeRule = (index: number) => {
    if (!policy) return;
    setPolicy({
      ...policy,
      rules: policy.rules.filter((_, i) => i !== index),
    });
    if (editingRule === index) setEditingRule(null);
  };

  const addRule = () => {
    if (!policy) return;
    const newRule: PolicyRuleType = {
      name: `rule-${policy.rules.length + 1}`,
      description: '',
      type: 'command_block',
      enabled: true,
      action: 'block',
      config: defaultConfigForType('command_block'),
    };
    setPolicy({ ...policy, rules: [...policy.rules, newRule] });
    setEditingRule(policy.rules.length);
  };

  return (
    <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">Policy Engine</h2>
          <span className="rounded bg-hawk-orange/15 px-1.5 py-0.5 font-mono text-[10px] text-hawk-orange">
            .hawkeye/policies.yml
          </span>
        </div>
        <div className="flex items-center gap-2">
          {policyStatus === 'saving' && (
            <span className="font-mono text-[10px] text-hawk-text3 animate-pulse">Saving...</span>
          )}
          {policyStatus === 'saved' && (
            <span className="font-mono text-[10px] text-hawk-green">Saved</span>
          )}
          {policyStatus === 'error' && (
            <span className="font-mono text-[10px] text-hawk-red">Error</span>
          )}
        </div>
      </div>

      {!policy ? (
        <div className="px-5 py-8 text-center">
          <p className="font-mono text-sm text-hawk-text3 mb-1">No policies.yml found</p>
          <p className="font-mono text-[10px] text-hawk-text3/60 mb-4">
            Policies are declarative security rules you can share across projects and teams.
          </p>
          <button
            onClick={initPolicy}
            className="rounded-lg bg-hawk-orange/15 border border-hawk-orange/30 px-4 py-2 font-mono text-xs text-hawk-orange hover:bg-hawk-orange/25 transition-colors"
          >
            Initialize policies.yml
          </button>
        </div>
      ) : (
        <>
          {/* Policy metadata */}
          <div className="border-b border-hawk-border-subtle bg-hawk-bg/20 px-4 py-3 sm:px-5">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Name</label>
                <input
                  type="text"
                  value={policy.name}
                  onChange={(e) => setPolicy({ ...policy, name: e.target.value })}
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </div>
              <div className="flex-[2]">
                <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Description</label>
                <input
                  type="text"
                  value={policy.description || ''}
                  onChange={(e) => setPolicy({ ...policy, description: e.target.value })}
                  placeholder="Describe this policy set..."
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
                />
              </div>
            </div>
          </div>

          {/* Validation errors */}
          {policyErrors.length > 0 && (
            <div className="mx-4 sm:mx-5 mt-3 rounded-lg border border-hawk-red/30 bg-hawk-red/10 px-4 py-2">
              {policyErrors.map((err, i) => (
                <p key={i} className="font-mono text-[10px] text-hawk-red">{err}</p>
              ))}
            </div>
          )}

          {/* Policy rules */}
          <div className="divide-y divide-hawk-border-subtle">
            {policy.rules.map((rule, i) => (
              <div key={i} className="px-4 sm:px-5 py-4 transition-colors hover:bg-hawk-surface2/35">
                <div className="flex items-start gap-3">
                  <Toggle enabled={rule.enabled} onToggle={() => updateRule(i, { enabled: !rule.enabled })} />

                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditingRule(editingRule === i ? null : i)}>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-sm text-hawk-text font-semibold">{rule.name}</span>
                      <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 font-mono text-[10px] text-hawk-text3">
                        {rule.type}
                      </span>
                      {rule.description && (
                        <span className="hidden sm:inline font-mono text-[10px] text-hawk-text3/60">{rule.description}</span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-hawk-text3 truncate">
                      {describePolicyRule(rule)}
                    </div>
                  </div>

                  <button
                    onClick={() => updateRule(i, { action: rule.action === 'block' ? 'warn' : 'block' })}
                    className={`shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase ${rule.action === 'block'
                      ? 'bg-hawk-red/15 text-hawk-red'
                      : 'bg-hawk-amber/15 text-hawk-amber'
                    }`}
                  >
                    {rule.action}
                  </button>

                  <button
                    onClick={() => setEditingRule(editingRule === i ? null : i)}
                    className="shrink-0 rounded px-1.5 py-1 font-mono text-[10px] text-hawk-text3 hover:text-hawk-text transition-colors"
                  >
                    {editingRule === i ? '▲' : '▼'}
                  </button>
                </div>

                {/* Expanded editor */}
                {editingRule === i && (
                  <div className="mt-3 ml-0 sm:ml-12 space-y-3 rounded-lg border border-hawk-border-subtle bg-hawk-surface2/40 p-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Rule name</label>
                        <input
                          type="text"
                          value={rule.name}
                          onChange={(e) => updateRule(i, { name: e.target.value })}
                          className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                        />
                      </div>
                      <div>
                        <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Type</label>
                        <select
                          value={rule.type}
                          onChange={(e) => {
                            const newType = e.target.value;
                            updateRule(i, { type: newType, config: defaultConfigForType(newType) });
                          }}
                          className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                        >
                          {POLICY_RULE_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>{t.label} — {t.description}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Description</label>
                      <input
                        type="text"
                        value={rule.description || ''}
                        onChange={(e) => updateRule(i, { description: e.target.value })}
                        placeholder="What this rule does..."
                        className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
                      />
                    </div>

                    {/* Type-specific config editors */}
                    <PolicyConfigEditor rule={rule} onChange={(config) => updateRule(i, { config })} />

                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => removeRule(i)}
                        className="rounded px-2.5 py-1 font-mono text-[10px] text-hawk-red hover:bg-hawk-red/10 transition-colors"
                      >
                        Delete rule
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add rule + summary */}
          <div className="flex items-center justify-between border-t border-hawk-border-subtle bg-hawk-bg/20 px-4 py-3 sm:px-5">
            <div className="font-mono text-[10px] text-hawk-text3">
              {policy.rules.filter((r) => r.enabled).length} of {policy.rules.length} rules enabled
            </div>
            <button
              onClick={addRule}
              className="rounded bg-hawk-surface3 px-2.5 py-1 font-mono text-[10px] text-hawk-text3 hover:text-hawk-text transition-colors"
            >
              + Add rule
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Policy Config Editor (type-specific) ───────────────────────

function PolicyConfigEditor({
  rule,
  onChange,
}: {
  rule: PolicyRuleType;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const c = rule.config;

  const updateList = (key: string, value: string) => {
    onChange({ ...c, [key]: value.split(',').map((s) => s.trim()).filter(Boolean) });
  };

  const listValue = (key: string) => ((c[key] as string[]) || []).join(', ');

  switch (rule.type) {
    case 'file_protect':
      return (
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">
            Protected file patterns (comma-separated)
          </label>
          <input
            type="text"
            value={listValue('paths')}
            onChange={(e) => updateList('paths', e.target.value)}
            placeholder=".env, *.pem, *.key, id_rsa"
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
          />
        </div>
      );

    case 'command_block':
    case 'review_gate':
      return (
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">
            {rule.type === 'review_gate' ? 'Commands requiring approval' : 'Blocked command patterns'} (comma-separated)
          </label>
          <textarea
            value={listValue('patterns')}
            onChange={(e) => updateList('patterns', e.target.value)}
            placeholder="rm -rf /, sudo rm, DROP TABLE, curl * | bash"
            rows={2}
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40 resize-y"
          />
        </div>
      );

    case 'cost_limit':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Max $/session</label>
            <input
              type="number"
              step="0.5"
              value={c.maxUsdPerSession as number || ''}
              onChange={(e) => onChange({ ...c, maxUsdPerSession: parseFloat(e.target.value) || 0 })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Max $/hour</label>
            <input
              type="number"
              step="0.5"
              value={c.maxUsdPerHour as number || ''}
              onChange={(e) => onChange({ ...c, maxUsdPerHour: parseFloat(e.target.value) || 0 })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            />
          </div>
        </div>
      );

    case 'token_limit':
      return (
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Max tokens/session</label>
          <input
            type="number"
            step="10000"
            value={c.maxTokensPerSession as number || ''}
            onChange={(e) => onChange({ ...c, maxTokensPerSession: parseInt(e.target.value) || 0 })}
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
          />
        </div>
      );

    case 'directory_scope':
      return (
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">
            Blocked directories (comma-separated)
          </label>
          <input
            type="text"
            value={listValue('blockedDirs')}
            onChange={(e) => updateList('blockedDirs', e.target.value)}
            placeholder="/etc, /usr, ~/.ssh, ~/.aws"
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
          />
        </div>
      );

    case 'network_lock':
      return (
        <div className="space-y-3">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">
              Allowed hosts (comma-separated, empty = allow all)
            </label>
            <input
              type="text"
              value={listValue('allowedHosts')}
              onChange={(e) => updateList('allowedHosts', e.target.value)}
              placeholder="api.openai.com, api.anthropic.com"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">
              Blocked hosts (comma-separated)
            </label>
            <input
              type="text"
              value={listValue('blockedHosts')}
              onChange={(e) => updateList('blockedHosts', e.target.value)}
              placeholder="evil.com, malware.net"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3/40"
            />
          </div>
        </div>
      );

    case 'impact_threshold':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Block above</label>
            <select
              value={(c.blockAbove as string) || 'critical'}
              onChange={(e) => onChange({ ...c, blockAbove: e.target.value })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Warn above</label>
            <select
              value={(c.warnAbove as string) || 'high'}
              onChange={(e) => onChange({ ...c, warnAbove: e.target.value })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
        </div>
      );

    default:
      return (
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-1">Config (JSON)</label>
          <textarea
            value={JSON.stringify(c, null, 2)}
            onChange={(e) => {
              try { onChange(JSON.parse(e.target.value)); } catch {}
            }}
            rows={4}
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 resize-y"
          />
        </div>
      );
  }
}
