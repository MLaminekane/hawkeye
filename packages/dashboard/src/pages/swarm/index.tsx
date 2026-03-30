import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, hawkeyeWs } from '../../api';
import type { AgentMessageData, LiveAgentData } from '../../api';
import { QUICK_STARTS } from './constants';
import {
  AgentCard,
  AgentCommsPanel,
  EmptySwarmState,
  SwarmHero,
  SwarmToolbar,
} from './components';
import type {
  AgentRole,
  AgentStatusFilter,
  CIReportData,
  LocalProviderState,
  Notice,
  QuickStart,
} from './types';
import {
  getCommandOption,
  getRoleOption,
  normalizeLiveAgent,
  normalizeSessionId,
} from './utils';
import { buildClineAgentCommand, type ClineMode } from '../tasks/runtime-utils';

export default function SwarmPage() {
  const [agents, setAgents] = useState<LiveAgentData[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [command, setCommand] = useState('claude');
  const [localModel] = useState('');
  const [localProviders, setLocalProviders] = useState<Record<string, LocalProviderState>>({});
  const [refreshingLocalProviders, setRefreshingLocalProviders] = useState(false);
  const [clineMode, setClineMode] = useState<ClineMode>('configured');
  const [clineModel, setClineModel] = useState('');
  const [clineProviderModels, setClineProviderModels] = useState<Record<string, string[]>>({});
  const [configuredApiKeys, setConfiguredApiKeys] = useState<Record<string, string>>({});
  const clineChoiceTouchedRef = useRef(false);
  const [role, setRole] = useState<AgentRole>('worker');
  const [permissions, setPermissions] = useState<'default' | 'full' | 'supervised'>('full');
  const [prompt, setPrompt] = useState('');
  const [personality, setPersonality] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedStarterId, setSelectedStarterId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [filter, setFilter] = useState<AgentStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showOutputId, setShowOutputId] = useState<string | null>(null);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [sendingMessageId, setSendingMessageId] = useState<string | null>(null);
  const [actingAgentId, setActingAgentId] = useState<string | null>(null);

  const [agentEvents, setAgentEvents] = useState<Record<string, Awaited<ReturnType<typeof api.getAgentEvents>>>>({});
  const [commsMessages, setCommsMessages] = useState<AgentMessageData[]>([]);
  const [commsOpen, setCommsOpen] = useState(false);
  const [commsInput, setCommsInput] = useState('');
  const [commsTo, setCommsTo] = useState<string>('broadcast');
  const [commsSending, setCommsSending] = useState(false);
  const commsEndRef = useRef<HTMLDivElement>(null);
  const [permDropdownId, setPermDropdownId] = useState<string | null>(null);
  const [updatingPermId, setUpdatingPermId] = useState<string | null>(null);
  const [ciReportAgentId, setCiReportAgentId] = useState<string | null>(null);
  const [ciReportData, setCiReportData] = useState<CIReportData | null>(null);
  const [ciReportLoading, setCiReportLoading] = useState(false);

  const outputRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pollingTargetsRef = useRef<Array<{ id: string; sessionId: string }>>([]);
  const [, setClockTick] = useState(0);

  useEffect(() => {
    if (!permDropdownId) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-perm-dropdown]')) setPermDropdownId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [permDropdownId]);

  const load = useCallback(async () => {
    try {
      const data = await api.listAgents();
      setAgents(
        data
          .map((agent) => normalizeLiveAgent(agent as Partial<LiveAgentData> & Record<string, unknown>))
          .filter((agent) => agent.id),
      );
    } catch {
      setNotice({ type: 'error', text: 'Unable to load agents right now.' });
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshLocalProviders = useCallback(async () => {
    setRefreshingLocalProviders(true);
    try {
      const data = await api.getLocalProviders();
      setLocalProviders(data);
      setNotice({ type: 'success', text: 'Local runtimes refreshed.' });
    } catch {
      setNotice({ type: 'error', text: 'Unable to refresh local runtimes right now.' });
    } finally {
      setRefreshingLocalProviders(false);
    }
  }, []);

  useEffect(() => {
    void load();
    api.getAgentMessages().then(setCommsMessages).catch(() => {});
    void refreshLocalProviders();
    api.getProviders().then(setClineProviderModels).catch(() => {});
    api.getSettings().then((data) => setConfiguredApiKeys(data.apiKeys || {})).catch(() => {});
  }, [load, refreshLocalProviders]);

  const preferredCline = useMemo(() => {
    if (localProviders.ollama?.available && (localProviders.ollama.models?.length ?? 0) > 0) {
      return { mode: 'ollama' as const, model: localProviders.ollama.models?.[0] || '' };
    }
    if (localProviders.lmstudio?.available && (localProviders.lmstudio.models?.length ?? 0) > 0) {
      return { mode: 'lmstudio' as const, model: localProviders.lmstudio.models?.[0] || '' };
    }
    if (configuredApiKeys.deepseek && (clineProviderModels.deepseek?.length ?? 0) > 0) {
      return { mode: 'deepseek' as const, model: clineProviderModels.deepseek[0] };
    }
    if (configuredApiKeys.anthropic && (clineProviderModels.anthropic?.length ?? 0) > 0) {
      return { mode: 'anthropic' as const, model: clineProviderModels.anthropic[0] };
    }
    if (configuredApiKeys.openai && (clineProviderModels.openai?.length ?? 0) > 0) {
      return {
        mode: 'openai' as const,
        model: clineProviderModels.openai[1] || clineProviderModels.openai[0] || 'gpt-4o-mini',
      };
    }
    return { mode: 'configured' as const, model: '' };
  }, [clineProviderModels, configuredApiKeys, localProviders]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    pollingTargetsRef.current = agents
      .map((agent) => ({ id: agent.id, sessionId: normalizeSessionId(agent.sessionId) }))
      .filter((agent): agent is { id: string; sessionId: string } => Boolean(agent.sessionId));
  }, [agents]);

  useEffect(() => {
    return hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'agent_spawned') {
        const normalizedAgent = normalizeLiveAgent(msg.agent as Partial<LiveAgentData> & Record<string, unknown>);
        setAgents((prev) => [normalizedAgent, ...prev.filter((agent) => agent.id !== normalizedAgent.id)]);
      } else if (msg.type === 'agent_output') {
        setAgents((prev) =>
          prev.map((agent) =>
            agent.id === msg.agentId ? { ...agent, output: ((agent.output || '') + msg.chunk).slice(-50000) } : agent,
          ),
        );
        const element = outputRefs.current.get(msg.agentId);
        if (element) element.scrollTop = element.scrollHeight;
      } else if (msg.type === 'agent_complete') {
        void load();
      } else if (msg.type === 'agent_removed') {
        setAgents((prev) => prev.filter((agent) => agent.id !== msg.agentId));
        setExpandedId((prev) => (prev === msg.agentId ? null : prev));
        setShowOutputId((prev) => (prev === msg.agentId ? null : prev));
        outputRefs.current.delete(msg.agentId);
        setMessageDrafts((prev) => {
          if (!(msg.agentId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.agentId];
          return next;
        });
        setAgentEvents((prev) => {
          if (!(msg.agentId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.agentId];
          return next;
        });
      } else if (msg.type === 'agent_session_linked') {
        setAgents((prev) =>
          prev.map((agent) =>
            agent.id === msg.agentId ? { ...agent, sessionId: normalizeSessionId(msg.sessionId) } : agent,
          ),
        );
      } else if (msg.type === 'agent_stats') {
        setAgents((prev) =>
          prev.map((agent) =>
            agent.id === msg.agentId
              ? { ...agent, driftScore: msg.drift, costUsd: msg.cost, actionCount: msg.actions }
              : agent,
          ),
        );
      } else if (msg.type === 'agent_message') {
        setCommsMessages((prev) => [...prev, msg.message]);
      } else if (msg.type === 'agent_permissions') {
        setAgents((prev) =>
          prev.map((agent) => (agent.id === msg.agentId ? { ...agent, permissions: msg.permissions } : agent)),
        );
      }
    });
  }, [load]);

  const pollingKey = useMemo(
    () =>
      agents
        .map((agent) => {
          const sessionId = normalizeSessionId(agent.sessionId);
          return sessionId ? `${agent.id}:${sessionId}` : null;
        })
        .filter((value): value is string => Boolean(value))
        .sort()
        .join('|'),
    [agents],
  );

  useEffect(() => {
    const trackedAgents = pollingTargetsRef.current;
    if (trackedAgents.length === 0) return;

    let cancelled = false;

    const fetchEvents = async () => {
      const results = await Promise.allSettled(
        trackedAgents.map((agent) => api.getAgentEvents(agent.id, 10).then((events) => ({ id: agent.id, events }))),
      );
      if (cancelled) return;

      const updates: Record<string, Awaited<ReturnType<typeof api.getAgentEvents>>> = {};
      for (const result of results) {
        if (result.status === 'fulfilled') updates[result.value.id] = result.value.events;
      }

      if (Object.keys(updates).length > 0) {
        setAgentEvents((prev) => ({ ...prev, ...updates }));
      }
    };

    void fetchEvents();
    const interval = window.setInterval(() => {
      void fetchEvents();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pollingKey]);

  const hasRunningAgents = useMemo(() => agents.some((agent) => agent.status === 'running'), [agents]);

  useEffect(() => {
    if (!hasRunningAgents) return;
    const interval = window.setInterval(() => {
      setClockTick((tick) => tick + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [hasRunningAgents]);

  useEffect(() => {
    if (!showOutputId) return;
    const element = outputRefs.current.get(showOutputId);
    if (element) element.scrollTop = element.scrollHeight;
  }, [showOutputId, agents]);

  const selectedCommand = getCommandOption(command);
  const selectedRole = getRoleOption(role);

  const suggestedName = useMemo(() => {
    const starter = QUICK_STARTS.find((option) => option.id === selectedStarterId);
    const prefix = starter?.namePrefix || `${role}-${command}`;
    return `${prefix}-${agents.length + 1}`;
  }, [selectedStarterId, role, command, agents.length]);

  const searchValue = searchQuery.trim().toLowerCase();

  const sortedAgents = useMemo(() => {
    const statusOrder: Record<LiveAgentData['status'], number> = {
      running: 0,
      failed: 1,
      completed: 2,
    };

    return [...agents].sort((left, right) => {
      const leftOrder = statusOrder[left.status];
      const rightOrder = statusOrder[right.status];
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;

      const leftTime = new Date(left.finishedAt || left.startedAt).getTime();
      const rightTime = new Date(right.finishedAt || right.startedAt).getTime();
      return rightTime - leftTime;
    });
  }, [agents]);

  const visibleAgents = useMemo(
    () =>
      sortedAgents.filter((agent) => {
        if (filter !== 'all' && agent.status !== filter) return false;
        if (!searchValue) return true;

        const haystack = [
          agent.name,
          agent.command,
          agent.role,
          agent.prompt,
          agent.personality,
          normalizeSessionId(agent.sessionId) || '',
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(searchValue);
      }),
    [sortedAgents, filter, searchValue],
  );

  const runningCount = agents.filter((agent) => agent.status === 'running').length;
  const completedCount = agents.filter((agent) => agent.status === 'completed').length;
  const failedCount = agents.filter((agent) => agent.status === 'failed').length;
  const finishedCount = completedCount + failedCount;
  const linkedSessionCount = new Set(
    agents
      .map((agent) => normalizeSessionId(agent.sessionId))
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  ).size;
  const totalActions = agents.reduce((total, agent) => total + (agent.actionCount || 0), 0);
  const totalCost = agents.reduce((total, agent) => total + (agent.costUsd || 0), 0);
  const runningCost = agents
    .filter((agent) => agent.status === 'running')
    .reduce((total, agent) => total + (agent.costUsd || 0), 0);
  const needsAttentionCount = new Set([
    ...agents.filter((agent) => agent.status === 'failed').map((agent) => agent.id),
    ...agents
      .filter((agent) => agent.driftScore !== null && agent.driftScore < 40)
      .map((agent) => agent.id),
  ]).size;

  const filterCounts: Record<AgentStatusFilter, number> = {
    all: agents.length,
    running: runningCount,
    failed: failedCount,
    completed: completedCount,
  };

  const launchAgent = useCallback(async () => {
    if (!prompt.trim() || submitting) return;

    const resolvedName = name.trim() || suggestedName;
    setSubmitting(true);

    try {
      const resolvedCommand = (() => {
        if (command === 'cline') return buildClineAgentCommand({ mode: clineMode, model: clineModel });
        const isLocal = command === 'ollama' || command === 'lmstudio';
        return isLocal && localModel ? `${command}/${localModel}` : command;
      })();

      await api.spawnAgent(
        resolvedName,
        resolvedCommand,
        prompt.trim(),
        role,
        personality.trim(),
        permissions,
      );

      setNotice({
        type: 'success',
        text: `${resolvedName} is launching. Live telemetry will appear here as soon as the runtime attaches.`,
      });
      setName('');
      setPrompt('');
      setPersonality('');
      setSelectedStarterId(null);
      setShowAdvanced(false);
    } catch (error) {
      console.error('Spawn failed:', error);
      setNotice({
        type: 'error',
        text: 'Unable to launch the agent. Check the runtime command and try again.',
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    clineMode,
    clineModel,
    command,
    localModel,
    name,
    permissions,
    personality,
    prompt,
    role,
    submitting,
    suggestedName,
  ]);

  const handleSpawnSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void launchAgent();
    },
    [launchAgent],
  );

  const applyQuickStart = useCallback(
    (starter: QuickStart) => {
      setSelectedStarterId(starter.id);
      setCommand(starter.command);
      setRole(starter.role);
      setPrompt(starter.prompt);
      setPersonality(starter.personality);
      setShowAdvanced(Boolean(starter.personality));
      if (!name.trim()) setName(`${starter.namePrefix}-${agents.length + 1}`);
    },
    [agents.length, name],
  );

  const handleStop = useCallback(
    async (id: string) => {
      setActingAgentId(id);
      try {
        await api.stopAgent(id);
        setNotice({ type: 'success', text: 'Stop signal sent to the agent.' });
        await load();
      } catch {
        setNotice({ type: 'error', text: 'Unable to stop that agent right now.' });
      } finally {
        setActingAgentId(null);
      }
    },
    [load],
  );

  const handleRemove = useCallback(async (id: string) => {
    setActingAgentId(id);
    try {
      await api.removeAgent(id);
      setNotice({ type: 'success', text: 'Agent removed from the board.' });
    } catch {
      setNotice({ type: 'error', text: 'Unable to remove that agent right now.' });
    } finally {
      setActingAgentId(null);
    }
  }, []);

  const handleClearFinished = useCallback(async () => {
    const finishedAgents = agents.filter((agent) => agent.status !== 'running');
    if (finishedAgents.length === 0 || actingAgentId) return;

    setActingAgentId('clear-finished');
    try {
      await Promise.all(finishedAgents.map((agent) => api.removeAgent(agent.id)));
      setNotice({
        type: 'success',
        text: `${finishedAgents.length} finished agent${finishedAgents.length === 1 ? '' : 's'} removed from the board.`,
      });
    } catch {
      setNotice({ type: 'error', text: 'Unable to clear finished agents right now.' });
      await load();
    } finally {
      setActingAgentId(null);
    }
  }, [actingAgentId, agents, load]);

  const handleCloneAgent = useCallback(
    async (agent: LiveAgentData) => {
      if (submitting) return;
      const cloneName = `${agent.name}-clone-${agents.length + 1}`;

      setSubmitting(true);
      try {
        await api.spawnAgent(
          cloneName,
          agent.command,
          agent.prompt,
          agent.role,
          agent.personality,
          agent.permissions,
        );
        setNotice({ type: 'success', text: `${cloneName} launched from ${agent.name}.` });
      } catch {
        setNotice({ type: 'error', text: 'Unable to relaunch that agent right now.' });
      } finally {
        setSubmitting(false);
      }
    },
    [agents.length, submitting],
  );

  const handleSendComm = useCallback(async () => {
    if (!commsInput.trim() || commsSending) return;

    setCommsSending(true);
    try {
      const message: {
        content: string;
        from?: string;
        fromName?: string;
        to?: string;
        toRole?: string;
        type?: string;
      } = {
        content: commsInput.trim(),
        fromName: 'Dashboard',
        type: commsTo === 'broadcast' ? 'broadcast' : 'direct',
      };

      if (commsTo !== 'broadcast') {
        if (['lead', 'worker', 'reviewer'].includes(commsTo)) {
          message.toRole = commsTo;
          message.type = 'broadcast';
        } else {
          message.to = commsTo;
        }
      }

      await api.sendAgentComm(message);
      setCommsInput('');
    } catch {
      setNotice({ type: 'error', text: 'Failed to send message.' });
    } finally {
      setCommsSending(false);
    }
  }, [commsInput, commsSending, commsTo]);

  useEffect(() => {
    commsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [commsMessages]);

  const handleChangePermissions = useCallback(
    async (agentId: string, newPermissions: 'default' | 'full' | 'supervised') => {
      setUpdatingPermId(agentId);
      try {
        await api.updateAgentPermissions(agentId, newPermissions);
        setAgents((prev) =>
          prev.map((agent) => (agent.id === agentId ? { ...agent, permissions: newPermissions } : agent)),
        );
        setPermDropdownId(null);
        setNotice({ type: 'success', text: `Permissions updated to ${newPermissions}.` });
      } catch {
        setNotice({ type: 'error', text: 'Unable to update permissions.' });
      } finally {
        setUpdatingPermId(null);
      }
    },
    [],
  );

  const handleCIReport = useCallback(
    async (agentId: string, sessionId: string) => {
      if (ciReportLoading) return;
      setCiReportLoading(true);
      setCiReportAgentId(agentId);
      try {
        const result = await api.getCIReport(sessionId);
        setCiReportData(result);
      } catch {
        setNotice({ type: 'error', text: 'Unable to generate CI report for this agent.' });
        setCiReportAgentId(null);
      } finally {
        setCiReportLoading(false);
      }
    },
    [ciReportLoading],
  );

  const handleSendMessage = useCallback(
    async (id: string) => {
      const message = messageDrafts[id]?.trim();
      if (!message || sendingMessageId) return;

      setSendingMessageId(id);
      try {
        await api.sendAgentMessage(id, message);
        setMessageDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setExpandedId(null);
        setNotice({ type: 'success', text: 'Follow-up instruction sent.' });
        await load();
      } catch (error) {
        console.error('Send message failed:', error);
        setNotice({ type: 'error', text: 'Unable to send that follow-up right now.' });
      } finally {
        setSendingMessageId(null);
      }
    },
    [load, messageDrafts, sendingMessageId],
  );

  const clearFilters = useCallback(() => {
    setFilter('all');
    setSearchQuery('');
  }, []);

  const handleCopyReport = useCallback((markdown: string) => {
    navigator.clipboard.writeText(markdown).then(
      () => setNotice({ type: 'success', text: 'Report copied to clipboard.' }),
      () => setNotice({ type: 'error', text: 'Failed to copy — try selecting and copying manually.' }),
    );
  }, []);

  const handleCloseReport = useCallback(() => {
    setCiReportAgentId(null);
    setCiReportData(null);
  }, []);

  return (
    <div className="space-y-5">
      <SwarmHero
        agentsCount={agents.length}
        runningCount={runningCount}
        linkedSessionCount={linkedSessionCount}
        needsAttentionCount={needsAttentionCount}
        failedCount={failedCount}
        totalActions={totalActions}
        totalCost={totalCost}
        runningCost={runningCost}
        completedCount={completedCount}
        handleSpawnSubmit={handleSpawnSubmit}
        notice={notice}
        name={name}
        setName={setName}
        command={command}
        setCommand={setCommand}
        localModel={localModel}
        localProviders={localProviders}
        refreshingLocalProviders={refreshingLocalProviders}
        refreshLocalProviders={() => void refreshLocalProviders()}
        clineMode={clineMode}
        setClineMode={setClineMode}
        clineModel={clineModel}
        setClineModel={setClineModel}
        clineProviderModels={clineProviderModels}
        configuredApiKeys={configuredApiKeys}
        preferredCline={preferredCline}
        clineChoiceTouchedRef={clineChoiceTouchedRef}
        role={role}
        setRole={setRole}
        permissions={permissions}
        setPermissions={setPermissions}
        prompt={prompt}
        setPrompt={setPrompt}
        personality={personality}
        setPersonality={setPersonality}
        showAdvanced={showAdvanced}
        setShowAdvanced={setShowAdvanced}
        selectedStarterId={selectedStarterId}
        applyQuickStart={applyQuickStart}
        submitting={submitting}
        suggestedName={suggestedName}
        selectedCommand={selectedCommand}
        selectedRole={selectedRole}
        launchAgent={() => void launchAgent()}
      />

      <SwarmToolbar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        filter={filter}
        setFilter={setFilter}
        filterCounts={filterCounts}
        finishedCount={finishedCount}
        actingAgentId={actingAgentId}
        handleClearFinished={() => void handleClearFinished()}
        clearFilters={clearFilters}
        visibleAgentsCount={visibleAgents.length}
        agentsCount={agents.length}
        runningCount={runningCount}
      />

      {loading ? (
        <div className="rounded-[24px] border border-hawk-border-subtle bg-hawk-surface/60 py-20 text-center font-mono text-sm text-hawk-text3">
          Loading agents...
        </div>
      ) : agents.length === 0 ? (
        <EmptySwarmState
          title="No agents on the board yet"
          body="Start from the launch studio above. Pick a starter kit if you want a clean first prompt, then launch your first specialist."
          tone="dashed"
        />
      ) : visibleAgents.length === 0 ? (
        <EmptySwarmState
          title="Nothing matches the current view"
          body="Try a broader search or reset the status filter to bring more agents back into view."
        />
      ) : (
        <div className="grid gap-3.5 xl:grid-cols-2">
          {visibleAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              events={agentEvents[agent.id] || []}
              isExpanded={expandedId === agent.id}
              showingOutput={showOutputId === agent.id}
              messageDraft={messageDrafts[agent.id] || ''}
              sendingMessage={sendingMessageId === agent.id}
              actingAgentId={actingAgentId}
              submitting={submitting}
              permDropdownId={permDropdownId}
              updatingPermId={updatingPermId}
              onTogglePermissions={() =>
                setPermDropdownId((current) => (current === agent.id ? null : agent.id))
              }
              onChangePermissions={(value) => void handleChangePermissions(agent.id, value)}
              onStop={() => void handleStop(agent.id)}
              onRemove={() => void handleRemove(agent.id)}
              onClone={() => void handleCloneAgent(agent)}
              onToggleOutput={() =>
                setShowOutputId((current) => (current === agent.id ? null : agent.id))
              }
              onToggleExpanded={() =>
                setExpandedId((current) => (current === agent.id ? null : agent.id))
              }
              onMessageDraftChange={(value) =>
                setMessageDrafts((prev) => ({
                  ...prev,
                  [agent.id]: value,
                }))
              }
              onSendMessage={() => void handleSendMessage(agent.id)}
              onRequestCIReport={(sessionId) => void handleCIReport(agent.id, sessionId)}
              ciReportLoading={ciReportLoading && ciReportAgentId === agent.id}
              ciReport={ciReportAgentId === agent.id ? ciReportData : null}
              onCloseCIReport={handleCloseReport}
              onCopyReport={handleCopyReport}
              outputRef={(element) => {
                if (element) {
                  outputRefs.current.set(agent.id, element);
                } else {
                  outputRefs.current.delete(agent.id);
                }
              }}
            />
          ))}
        </div>
      )}

      <AgentCommsPanel
        agents={agents}
        commsMessages={commsMessages}
        commsOpen={commsOpen}
        setCommsOpen={setCommsOpen}
        commsInput={commsInput}
        setCommsInput={setCommsInput}
        commsTo={commsTo}
        setCommsTo={setCommsTo}
        commsSending={commsSending}
        handleSendComm={() => void handleSendComm()}
        commsEndRef={commsEndRef}
      />
    </div>
  );
}
