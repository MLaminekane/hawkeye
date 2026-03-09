import { useEffect, useState } from 'react';
import { api, type SettingsData } from '../api';

interface GuardrailRule {
  name: string;
  type: string;
  enabled: boolean;
  action: string;
  config: Record<string, unknown>;
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
};

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
];

export function SettingsPage() {
  const [rules, setRules] = useState<GuardrailRule[]>(DEFAULT_RULES);
  const [driftConfig, setDriftConfig] = useState(DEFAULT_DRIFT);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Load settings + provider list from API
  useEffect(() => {
    api.getSettings().then((data) => {
      if (data.drift) setDriftConfig({ ...DEFAULT_DRIFT, ...data.drift });
      if (data.guardrails) setRules(data.guardrails);
    }).catch(() => setLoadError('Could not load settings from server'));

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

  // When provider changes, auto-select first model for that provider
  const handleProviderChange = (newProvider: string) => {
    const models = providerModels[newProvider] || [];
    setDriftConfig((p) => ({
      ...p,
      provider: newProvider,
      model: models[0] || '',
    }));
    setSaved(false);
  };

  const toggleRule = (index: number) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, enabled: !r.enabled } : r));
    setSaved(false);
  };

  const toggleAction = (index: number) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, action: r.action === 'block' ? 'warn' : 'block' } : r));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        drift: driftConfig,
        guardrails: rules,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setLoadError('Failed to save settings');
    }
    setSaving(false);
  };

  const currentModels = providerModels[driftConfig.provider] || [];

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-hawk-text">Settings</h1>
          <p className="text-sm text-hawk-text3 mt-1">Configure DriftDetect and Guardrails</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`rounded-lg px-4 py-2 font-mono text-xs font-semibold transition-all ${
            saved
              ? 'bg-hawk-green/20 text-hawk-green border border-hawk-green/30'
              : saving
              ? 'bg-hawk-surface3 text-hawk-text3 cursor-wait'
              : 'bg-hawk-orange text-black hover:bg-hawk-orange/90'
          }`}
        >
          {saved ? 'Saved' : saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {loadError && (
        <div className="mb-4 rounded-lg border border-hawk-amber/30 bg-hawk-amber/10 px-4 py-2 font-mono text-xs text-hawk-amber">
          {loadError}
        </div>
      )}

      {/* DriftDetect Config */}
      <div className="mb-6 overflow-hidden rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/55 shadow-sm">
        <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-surface2/75 px-5 py-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">DriftDetect</h2>
          <Toggle enabled={driftConfig.enabled} onToggle={() => { setDriftConfig((p) => ({ ...p, enabled: !p.enabled })); setSaved(false); }} />
        </div>

        {driftConfig.enabled && (
          <div className="p-5 grid grid-cols-2 gap-4">
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
                  onChange={(e) => { setDriftConfig((p) => ({ ...p, model: e.target.value })); setSaved(false); }}
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
                  onChange={(e) => { setDriftConfig((p) => ({ ...p, model: e.target.value })); setSaved(false); }}
                  placeholder="Model name"
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              )}
            </div>

            {driftConfig.provider !== 'ollama' && (
              <div className="col-span-2">
                <div className="rounded border border-hawk-border-subtle bg-hawk-surface2/60 px-3 py-2 font-mono text-[10px] text-hawk-text3">
                  {driftConfig.provider === 'anthropic' && 'Requires ANTHROPIC_API_KEY environment variable'}
                  {driftConfig.provider === 'openai' && 'Requires OPENAI_API_KEY environment variable'}
                  {driftConfig.provider === 'deepseek' && 'Requires DEEPSEEK_API_KEY environment variable'}
                  {driftConfig.provider === 'mistral' && 'Requires MISTRAL_API_KEY environment variable'}
                  {driftConfig.provider === 'google' && 'Requires GOOGLE_API_KEY environment variable'}
                </div>
              </div>
            )}

            <Field label="Check every N actions" value={String(driftConfig.checkEvery)} onChange={(v) => { setDriftConfig((p) => ({ ...p, checkEvery: parseInt(v) || 5 })); setSaved(false); }} type="number" />
            <Field label="Context window" value={String(driftConfig.contextWindow)} onChange={(v) => { setDriftConfig((p) => ({ ...p, contextWindow: parseInt(v) || 10 })); setSaved(false); }} type="number" />
            <Field label="Warning threshold" value={String(driftConfig.warningThreshold)} onChange={(v) => { setDriftConfig((p) => ({ ...p, warningThreshold: parseInt(v) || 60 })); setSaved(false); }} type="number" />
            <Field label="Critical threshold" value={String(driftConfig.criticalThreshold)} onChange={(v) => { setDriftConfig((p) => ({ ...p, criticalThreshold: parseInt(v) || 30 })); setSaved(false); }} type="number" />

            <div className="col-span-2 flex items-center gap-3 border-t border-hawk-border-subtle pt-2">
              <Toggle enabled={driftConfig.autoPause ?? false} onToggle={() => { setDriftConfig((p) => ({ ...p, autoPause: !p.autoPause })); setSaved(false); }} />
              <div>
                <span className="font-mono text-xs text-hawk-text">Auto-pause on critical drift</span>
                <p className="font-mono text-[10px] text-hawk-text3">Automatically pause recording when drift score drops to critical level</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Guardrails */}
      <div className="overflow-hidden rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/55 shadow-sm">
        <div className="border-b border-hawk-border-subtle bg-hawk-surface2/75 px-5 py-3">
          <h2 className="font-display text-base font-semibold text-hawk-text">Guardrails</h2>
        </div>

        <div className="divide-y divide-hawk-border-subtle">
          {rules.map((rule, i) => (
            <div key={rule.name} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-hawk-surface2/35">
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
                className={`shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase ${
                  rule.action === 'block'
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

      {/* Config file hint */}
      <div className="mt-6 rounded-xl border border-hawk-border-subtle bg-hawk-surface2/55 p-4">
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
      className={`relative shrink-0 h-5 w-9 rounded-full transition-colors ${enabled ? 'bg-hawk-orange' : 'bg-hawk-surface3'}`}
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
        className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
      />
    </div>
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
    default: return '';
  }
}
