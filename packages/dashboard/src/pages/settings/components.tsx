import type { PolicyData, PolicyRule as PolicyRuleType } from '../../api';
import {
  POLICY_RULE_TYPES,
  defaultConfigForType,
  describePolicyRule,
  type GuardrailRule,
} from './constants';

export function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-hawk-orange' : 'bg-hawk-surface3'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-hawk-surface shadow-sm transition-transform ${enabled ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
        {label}
      </label>
      <input
        type={type || 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
      />
    </div>
  );
}

export function OverviewStat({
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
    tone === 'accent' ? 'text-hawk-orange' : tone === 'good' ? 'text-hawk-green' : 'text-hawk-text';

  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/50 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
        {label}
      </div>
      <div className={`mt-1 font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text3">{meta}</div>
    </div>
  );
}

export function StatusPill({
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
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${toneClass}`}
    >
      <span className="text-hawk-text3">{label}</span>
      <span>{value}</span>
    </span>
  );
}

export function GuardrailConfigEditor({
  rule,
  onChange,
}: {
  rule: GuardrailRule;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const c = rule.config;

  const updateList = (key: string, value: string) => {
    onChange({
      ...c,
      [key]: value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };

  const listValue = (key: string) => ((c[key] as string[]) || []).join(', ');

  switch (rule.type) {
    case 'file_protect':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Protected file patterns (comma-separated)
          </label>
          <input
            type="text"
            value={listValue('paths')}
            onChange={(e) => updateList('paths', e.target.value)}
            placeholder=".env, *.pem, *.key, id_rsa"
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
          />
        </div>
      );

    case 'command_block':
    case 'review_gate':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            {rule.type === 'review_gate' ? 'Commands requiring approval' : 'Blocked command patterns'}{' '}
            (comma-separated)
          </label>
          <textarea
            value={listValue('patterns')}
            onChange={(e) => updateList('patterns', e.target.value)}
            placeholder="rm -rf /, sudo rm, DROP TABLE, curl * | bash"
            rows={2}
            className="w-full resize-y rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
          />
        </div>
      );

    case 'cost_limit':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Max $/session
            </label>
            <input
              type="number"
              step="0.5"
              value={(c.maxUsdPerSession as number) || ''}
              onChange={(e) => onChange({ ...c, maxUsdPerSession: parseFloat(e.target.value) || 0 })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Max $/hour
            </label>
            <input
              type="number"
              step="0.5"
              value={(c.maxUsdPerHour as number) || ''}
              onChange={(e) => onChange({ ...c, maxUsdPerHour: parseFloat(e.target.value) || 0 })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            />
          </div>
        </div>
      );

    case 'token_limit':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Max tokens/session
          </label>
          <input
            type="number"
            step="10000"
            value={(c.maxTokensPerSession as number) || ''}
            onChange={(e) => onChange({ ...c, maxTokensPerSession: parseInt(e.target.value) || 0 })}
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
          />
        </div>
      );

    case 'directory_scope':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Blocked directories (comma-separated)
          </label>
          <input
            type="text"
            value={listValue('blockedDirs')}
            onChange={(e) => updateList('blockedDirs', e.target.value)}
            placeholder="/etc, /usr, ~/.ssh, ~/.aws"
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
          />
        </div>
      );

    case 'network_lock':
      return (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Allowed hosts (comma-separated, empty = allow all)
            </label>
            <input
              type="text"
              value={listValue('allowedHosts')}
              onChange={(e) => updateList('allowedHosts', e.target.value)}
              placeholder="api.openai.com, api.anthropic.com"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Blocked hosts (comma-separated)
            </label>
            <input
              type="text"
              value={listValue('blockedHosts')}
              onChange={(e) => updateList('blockedHosts', e.target.value)}
              placeholder="evil.com, malware.net"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
            />
          </div>
        </div>
      );

    case 'pii_filter':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Categories (comma-separated)
            </label>
            <input
              type="text"
              value={listValue('categories')}
              onChange={(e) => updateList('categories', e.target.value)}
              placeholder="ssn, credit_card, api_key, private_key"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Scope
            </label>
            <select
              value={(c.scope as string) || 'both'}
              onChange={(e) => onChange({ ...c, scope: e.target.value })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            >
              <option value="input">Input only</option>
              <option value="output">Output only</option>
              <option value="both">Both</option>
            </select>
          </div>
        </div>
      );

    case 'prompt_shield':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Scope
          </label>
          <select
            value={(c.scope as string) || 'input'}
            onChange={(e) => onChange({ ...c, scope: e.target.value })}
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
          >
            <option value="input">Input only</option>
            <option value="output">Output only</option>
            <option value="both">Both</option>
          </select>
        </div>
      );

    case 'impact_threshold':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Block above
            </label>
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
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Warn above
            </label>
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
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Config (JSON)
          </label>
          <textarea
            value={JSON.stringify(c, null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {}
            }}
            rows={4}
            className="w-full resize-y rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
          />
        </div>
      );
  }
}

export function PolicySection({
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
          config: {
            paths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519'],
          },
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
      rules: policy.rules.map((r, i) => (i === index ? { ...r, ...partial } : r)),
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
            <span className="animate-pulse font-mono text-[10px] text-hawk-text3">Saving...</span>
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
          <p className="mb-1 font-mono text-sm text-hawk-text3">No policies.yml found</p>
          <p className="mb-4 font-mono text-[10px] text-hawk-text3/60">
            Policies are declarative security rules you can share across projects and teams.
          </p>
          <button
            onClick={initPolicy}
            className="rounded-lg border border-hawk-orange/30 bg-hawk-orange/15 px-4 py-2 font-mono text-xs text-hawk-orange transition-colors hover:bg-hawk-orange/25"
          >
            Initialize policies.yml
          </button>
        </div>
      ) : (
        <>
          <div className="border-b border-hawk-border-subtle bg-hawk-bg/20 px-4 py-3 sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                  Name
                </label>
                <input
                  type="text"
                  value={policy.name}
                  onChange={(e) => setPolicy({ ...policy, name: e.target.value })}
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </div>
              <div className="flex-[2]">
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                  Description
                </label>
                <input
                  type="text"
                  value={policy.description || ''}
                  onChange={(e) => setPolicy({ ...policy, description: e.target.value })}
                  placeholder="Describe this policy set..."
                  className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
                />
              </div>
            </div>
          </div>

          {policyErrors.length > 0 && (
            <div className="mx-4 mt-3 rounded-lg border border-hawk-red/30 bg-hawk-red/10 px-4 py-2 sm:mx-5">
              {policyErrors.map((err, i) => (
                <p key={i} className="font-mono text-[10px] text-hawk-red">
                  {err}
                </p>
              ))}
            </div>
          )}

          <div className="divide-y divide-hawk-border-subtle">
            {policy.rules.map((rule, i) => (
              <div
                key={i}
                className="px-4 py-4 transition-colors hover:bg-hawk-surface2/35 sm:px-5"
              >
                <div className="flex items-start gap-3">
                  <Toggle
                    enabled={rule.enabled}
                    onToggle={() => updateRule(i, { enabled: !rule.enabled })}
                  />

                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => setEditingRule(editingRule === i ? null : i)}
                  >
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-hawk-text">
                        {rule.name}
                      </span>
                      <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 font-mono text-[10px] text-hawk-text3">
                        {rule.type}
                      </span>
                      {rule.description && (
                        <span className="hidden font-mono text-[10px] text-hawk-text3/60 sm:inline">
                          {rule.description}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[10px] text-hawk-text3">
                      {describePolicyRule(rule)}
                    </div>
                  </div>

                  <button
                    onClick={() =>
                      updateRule(i, { action: rule.action === 'block' ? 'warn' : 'block' })
                    }
                    className={`shrink-0 rounded px-2 py-1 font-mono text-[10px] font-bold uppercase ${
                      rule.action === 'block'
                        ? 'bg-hawk-red/15 text-hawk-red'
                        : 'bg-hawk-amber/15 text-hawk-amber'
                    }`}
                  >
                    {rule.action}
                  </button>

                  <button
                    onClick={() => setEditingRule(editingRule === i ? null : i)}
                    className="shrink-0 rounded px-1.5 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:text-hawk-text"
                  >
                    {editingRule === i ? '▲' : '▼'}
                  </button>
                </div>

                {editingRule === i && (
                  <div className="ml-0 mt-3 space-y-3 rounded-lg border border-hawk-border-subtle bg-hawk-surface2/40 p-3 sm:ml-12">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                          Rule name
                        </label>
                        <input
                          type="text"
                          value={rule.name}
                          onChange={(e) => updateRule(i, { name: e.target.value })}
                          className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                          Type
                        </label>
                        <select
                          value={rule.type}
                          onChange={(e) => {
                            const newType = e.target.value;
                            updateRule(i, { type: newType, config: defaultConfigForType(newType) });
                          }}
                          className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
                        >
                          {POLICY_RULE_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label} — {t.description}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
                        Description
                      </label>
                      <input
                        type="text"
                        value={rule.description || ''}
                        onChange={(e) => updateRule(i, { description: e.target.value })}
                        placeholder="What this rule does..."
                        className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
                      />
                    </div>

                    <PolicyConfigEditor
                      rule={rule}
                      onChange={(config) => updateRule(i, { config })}
                    />

                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => removeRule(i)}
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

          <div className="flex items-center justify-between border-t border-hawk-border-subtle bg-hawk-bg/20 px-4 py-3 sm:px-5">
            <div className="font-mono text-[10px] text-hawk-text3">
              {policy.rules.filter((r) => r.enabled).length} of {policy.rules.length} rules enabled
            </div>
            <button
              onClick={addRule}
              className="rounded bg-hawk-surface3 px-2.5 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:text-hawk-text"
            >
              + Add rule
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function PolicyConfigEditor({
  rule,
  onChange,
}: {
  rule: PolicyRuleType;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const c = rule.config;

  const updateList = (key: string, value: string) => {
    onChange({
      ...c,
      [key]: value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };

  const listValue = (key: string) => ((c[key] as string[]) || []).join(', ');

  switch (rule.type) {
    case 'file_protect':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Protected file patterns (comma-separated)
          </label>
          <input
            type="text"
            value={listValue('paths')}
            onChange={(e) => updateList('paths', e.target.value)}
            placeholder=".env, *.pem, *.key, id_rsa"
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
          />
        </div>
      );

    case 'command_block':
    case 'review_gate':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            {rule.type === 'review_gate'
              ? 'Commands requiring approval'
              : 'Blocked command patterns'}{' '}
            (comma-separated)
          </label>
          <textarea
            value={listValue('patterns')}
            onChange={(e) => updateList('patterns', e.target.value)}
            placeholder="rm -rf /, sudo rm, DROP TABLE, curl * | bash"
            rows={2}
            className="w-full resize-y rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
          />
        </div>
      );

    case 'cost_limit':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Max $/session
            </label>
            <input
              type="number"
              step="0.5"
              value={(c.maxUsdPerSession as number) || ''}
              onChange={(e) =>
                onChange({ ...c, maxUsdPerSession: parseFloat(e.target.value) || 0 })
              }
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Max $/hour
            </label>
            <input
              type="number"
              step="0.5"
              value={(c.maxUsdPerHour as number) || ''}
              onChange={(e) => onChange({ ...c, maxUsdPerHour: parseFloat(e.target.value) || 0 })}
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
            />
          </div>
        </div>
      );

    case 'token_limit':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Max tokens/session
          </label>
          <input
            type="number"
            step="10000"
            value={(c.maxTokensPerSession as number) || ''}
            onChange={(e) => onChange({ ...c, maxTokensPerSession: parseInt(e.target.value) || 0 })}
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
          />
        </div>
      );

    case 'directory_scope':
      return (
        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Blocked directories (comma-separated)
          </label>
          <input
            type="text"
            value={listValue('blockedDirs')}
            onChange={(e) => updateList('blockedDirs', e.target.value)}
            placeholder="/etc, /usr, ~/.ssh, ~/.aws"
            className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
          />
        </div>
      );

    case 'network_lock':
      return (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Allowed hosts (comma-separated, empty = allow all)
            </label>
            <input
              type="text"
              value={listValue('allowedHosts')}
              onChange={(e) => updateList('allowedHosts', e.target.value)}
              placeholder="api.openai.com, api.anthropic.com"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Blocked hosts (comma-separated)
            </label>
            <input
              type="text"
              value={listValue('blockedHosts')}
              onChange={(e) => updateList('blockedHosts', e.target.value)}
              placeholder="evil.com, malware.net"
              className="w-full rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50 placeholder:text-hawk-text3"
            />
          </div>
        </div>
      );

    case 'impact_threshold':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Block above
            </label>
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
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
              Warn above
            </label>
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
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-hawk-text3">
            Config (JSON)
          </label>
          <textarea
            value={JSON.stringify(c, null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {}
            }}
            rows={4}
            className="w-full resize-y rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text outline-none focus:border-hawk-orange/50"
          />
        </div>
      );
  }
}
