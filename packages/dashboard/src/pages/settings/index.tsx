import { useEffect, useRef, useState } from 'react';
import { api, type McpServerEntry, type PolicyData } from '../../api';
import {
  DEFAULT_AUTOCORRECT,
  DEFAULT_DRIFT,
  DEFAULT_RULES,
  LOCAL_MODEL_SUGGESTIONS,
  defaultConfigForType,
  type GuardrailRule,
  type WebhookSetting,
} from './constants';
import { PolicySection } from './components';
import {
  ApiKeysSection,
  AutocorrectSection,
  ConfigHint,
  DriftSection,
  GuardrailsSection,
  LoadErrorBanner,
  McpServersSection,
  SettingsHero,
  WebhooksSection,
} from './sections';

export function SettingsPage() {
  const [rules, setRules] = useState<GuardrailRule[]>(DEFAULT_RULES);
  const [driftConfig, setDriftConfig] = useState(DEFAULT_DRIFT);
  const [webhooks, setWebhooks] = useState<WebhookSetting[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [localProviders, setLocalProviders] = useState<Record<string, { available: boolean; models: string[]; url: string }>>({});
  const [policy, setPolicy] = useState<PolicyData | null>(null);
  const [policyStatus, setPolicyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [policyErrors, setPolicyErrors] = useState<string[]>([]);
  const [autocorrect, setAutocorrect] = useState(DEFAULT_AUTOCORRECT);
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerEntry>>({});
  const [mcpDraft, setMcpDraft] = useState<{ name: string; package: string; envKey: string; envValue: string }>({ name: '', package: '', envKey: '', envValue: '' });
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [editingRule, setEditingRule] = useState<number | null>(null);
  const [editingGuardrail, setEditingGuardrail] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const policySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Preserve fields the UI doesn't edit (recording, dashboard)
  const preservedFields = useRef<Pick<import('../../api').SettingsData, 'recording' | 'dashboard'>>(
    {},
  );

  // Load settings + provider list from API
  const loadSettings = () => {
    setLoadError('');
    api
      .getSettings()
      .then((data) => {
        if (data.drift) setDriftConfig({ ...DEFAULT_DRIFT, ...data.drift });
        if (data.guardrails) setRules(data.guardrails);
        if (data.webhooks) setWebhooks(data.webhooks);
        if (data.apiKeys) setApiKeys(data.apiKeys);
        if (data.autocorrect) setAutocorrect({ ...DEFAULT_AUTOCORRECT, ...data.autocorrect });
        preservedFields.current = {
          recording: data.recording,
          dashboard: data.dashboard,
        };
        setTimeout(() => {
          loaded.current = true;
        }, 100);
      })
      .catch(() => {
        setLoadError('Could not load settings from server');
        loaded.current = true;
      });

    api
      .getPolicies()
      .then((p) => {
        if (p) setPolicy(p);
      })
      .catch(() => {});

    api.getMcpServers().then(setMcpServers).catch(() => {});
  };

  useEffect(() => {
    loadSettings();

    api
      .getProviders()
      .then((staticModels) => {
        setProviderModels(staticModels);
        // Fetch actual installed models from Ollama/LM Studio and merge
        api.getLocalProviders().then((local) => {
          setLocalProviders(local);
          setProviderModels((prev) => {
            const merged = { ...prev };
            if (local.ollama?.available && local.ollama.models.length > 0) {
              merged.ollama = local.ollama.models;
            }
            if (local.lmstudio?.available && local.lmstudio.models.length > 0) {
              merged.lmstudio = local.lmstudio.models;
            }
            return merged;
          });
        }).catch(() => {});
      })
      .catch(() => {
        // Fallback provider list
        setProviderModels({
          ollama: [],   // Populated from local Ollama instance
          lmstudio: [], // Populated from local LM Studio instance
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
        });
        // Still try local even if static fails
        api.getLocalProviders().then((local) => {
          setLocalProviders(local);
          setProviderModels((prev) => {
            const merged = { ...prev };
            if (local.ollama?.available && local.ollama.models.length > 0) {
              merged.ollama = local.ollama.models;
            }
            if (local.lmstudio?.available && local.lmstudio.models.length > 0) {
              merged.lmstudio = local.lmstudio.models;
            }
            return merged;
          });
        }).catch(() => {});
      });
  }, []);

  // Auto-save with debounce
  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      setSaveMessage('Saving settings to .hawkeye/config.json...');
      try {
        await api.saveSettings({
          drift: driftConfig,
          guardrails: rules,
          webhooks,
          apiKeys,
          autocorrect,
          ...preservedFields.current,
        });
        setSaveStatus('saved');
        setSaveMessage('Settings saved to .hawkeye/config.json');
        setTimeout(() => {
          setSaveStatus('idle');
          setSaveMessage('');
        }, 1800);
      } catch {
        setSaveStatus('error');
        setSaveMessage('Unable to save settings to .hawkeye/config.json. Check write permissions or retry.');
      }
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [driftConfig, rules, webhooks, apiKeys, autocorrect]);

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
    return () => {
      if (policySaveTimer.current) clearTimeout(policySaveTimer.current);
    };
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
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)));
  };

  const toggleAction = (index: number) => {
    setRules((prev) =>
      prev.map((r, i) =>
        i === index ? { ...r, action: r.action === 'block' ? 'warn' : 'block' } : r,
      ),
    );
  };

  const updateGuardrailConfig = (index: number, config: Record<string, unknown>) => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, config } : r)));
  };

  const removeGuardrail = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
    if (editingGuardrail === index) setEditingGuardrail(null);
  };

  const addGuardrail = (type: string) => {
    const name = `${type}_${rules.length + 1}`;
    const newRule: GuardrailRule = {
      name,
      type,
      enabled: true,
      action: 'block',
      config: defaultConfigForType(type),
    };
    setRules((prev) => [...prev, newRule]);
    setEditingGuardrail(rules.length);
  };

  const currentModels = providerModels[driftConfig.provider] || [];
  const localProviderState =
    driftConfig.provider === 'ollama' || driftConfig.provider === 'lmstudio'
      ? localProviders[driftConfig.provider]
      : null;
  const localProviderSuggestions = LOCAL_MODEL_SUGGESTIONS[driftConfig.provider] || [];
  const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
  const enabledWebhookCount = webhooks.filter((webhook) => webhook.enabled).length;
  const populatedApiKeyCount = Object.values(apiKeys).filter(Boolean).length;
  const enabledPolicyCount = policy?.rules.filter((rule) => rule.enabled).length || 0;
  const updateDriftConfig = (patch: Partial<typeof driftConfig>) => {
    setDriftConfig((prev) => ({ ...prev, ...patch }));
  };

  const addWebhook = () => {
    setWebhooks((prev) => [...prev, { enabled: true, url: '', events: ['drift_critical'] }]);
  };

  const toggleWebhook = (index: number) => {
    setWebhooks((prev) =>
      prev.map((webhook, currentIndex) =>
        currentIndex === index ? { ...webhook, enabled: !webhook.enabled } : webhook,
      ),
    );
  };

  const updateWebhookUrl = (index: number, url: string) => {
    setWebhooks((prev) =>
      prev.map((webhook, currentIndex) =>
        currentIndex === index ? { ...webhook, url } : webhook,
      ),
    );
  };

  const removeWebhook = (index: number) => {
    setWebhooks((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  };

  const toggleWebhookEvent = (index: number, event: string) => {
    setWebhooks((prev) =>
      prev.map((webhook, currentIndex) => {
        if (currentIndex !== index) return webhook;
        const hasEvent = webhook.events.includes(event);
        return {
          ...webhook,
          events: hasEvent ? webhook.events.filter((value) => value !== event) : [...webhook.events, event],
        };
      }),
    );
  };

  const updateApiKey = (provider: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [provider]: value }));
  };

  const removeMcpServer = async (name: string) => {
    await api.saveMcpServers({ [name]: null });
    setMcpServers((prev) => {
      const updated = { ...prev };
      delete updated[name];
      return updated;
    });
  };

  const addMcpServer = async () => {
    if (!mcpDraft.name || !mcpDraft.package) return;
    const entry: McpServerEntry = {
      command: 'npx',
      args: ['-y', mcpDraft.package],
      ...(mcpDraft.envKey && mcpDraft.envValue ? { env: { [mcpDraft.envKey]: mcpDraft.envValue } } : {}),
    };
    await api.saveMcpServers({ [mcpDraft.name]: entry });
    setMcpServers((prev) => ({ ...prev, [mcpDraft.name]: entry }));
    setMcpDraft({ name: '', package: '', envKey: '', envValue: '' });
    setMcpExpanded(false);
  };

  return (
    <div className="space-y-5">
      <SettingsHero
        saveStatus={saveStatus}
        saveMessage={saveMessage}
        policyStatus={policyStatus}
        driftEnabled={driftConfig.enabled}
        enabledRuleCount={enabledRuleCount}
        rulesTotal={rules.length}
        enabledPolicyCount={enabledPolicyCount}
        enabledWebhookCount={enabledWebhookCount}
        populatedApiKeyCount={populatedApiKeyCount}
      />

      <LoadErrorBanner loadError={loadError} onRetry={loadSettings} />

      <DriftSection
        driftConfig={driftConfig}
        providerModels={providerModels}
        localProviders={localProviders}
        localProviderState={localProviderState}
        localProviderSuggestions={localProviderSuggestions}
        currentModels={currentModels}
        onProviderChange={handleProviderChange}
        onDriftChange={updateDriftConfig}
      />

      <GuardrailsSection
        rules={rules}
        editingGuardrail={editingGuardrail}
        onToggleRule={toggleRule}
        onToggleAction={toggleAction}
        onToggleExpanded={(index) => setEditingGuardrail(editingGuardrail === index ? null : index)}
        onUpdateRuleName={(index, name) =>
          setRules((prev) => prev.map((rule, currentIndex) => (currentIndex === index ? { ...rule, name } : rule)))
        }
        onUpdateRuleType={(index, type) =>
          setRules((prev) =>
            prev.map((rule, currentIndex) =>
              currentIndex === index ? { ...rule, type, config: defaultConfigForType(type) } : rule,
            ),
          )
        }
        onUpdateRuleConfig={updateGuardrailConfig}
        onRemoveRule={removeGuardrail}
        onAddRule={addGuardrail}
      />

      {/* Policy Engine */}
      <PolicySection
        policy={policy}
        setPolicy={setPolicy}
        policyStatus={policyStatus}
        policyErrors={policyErrors}
        editingRule={editingRule}
        setEditingRule={setEditingRule}
      />

      <WebhooksSection
        webhooks={webhooks}
        onAddWebhook={addWebhook}
        onToggleWebhook={toggleWebhook}
        onUpdateWebhookUrl={updateWebhookUrl}
        onRemoveWebhook={removeWebhook}
        onToggleWebhookEvent={toggleWebhookEvent}
      />

      <ApiKeysSection apiKeys={apiKeys} onUpdateApiKey={updateApiKey} />

      <AutocorrectSection autocorrect={autocorrect} onAutocorrectChange={setAutocorrect} />

      <McpServersSection
        mcpServers={mcpServers}
        mcpDraft={mcpDraft}
        mcpExpanded={mcpExpanded}
        onSetExpanded={setMcpExpanded}
        onDraftChange={setMcpDraft}
        onRemoveServer={removeMcpServer}
        onAddServer={addMcpServer}
      />

      <ConfigHint />
    </div>
  );
}
