import type {
  FormEventHandler,
  KeyboardEvent,
  MutableRefObject,
} from 'react';
import { Link } from 'react-router-dom';
import type { AgentEventData, AgentMessageData, LiveAgentData } from '../../api';
import { CLINE_PROVIDER_OPTIONS, COMMAND_OPTIONS, QUICK_STARTS, ROLE_OPTIONS, STATUS_FILTERS } from './constants';
import type {
  AgentRole,
  AgentStatusFilter,
  CIReportData,
  CommandOption,
  LocalProviderState,
  Notice,
  QuickStart,
  RoleOption,
} from './types';
import {
  agentColor,
  driftColor,
  eventColor,
  eventIcon,
  formatClock,
  formatCount,
  formatDuration,
  formatMoney,
  formatOutputLineClass,
  getCommandOption,
  getOutputPreview,
  getRoleOption,
  getStatusBadgeClass,
  normalizeSessionId,
  parseEventSummary,
  timeAgo,
} from './utils';
import { describeClineMode, type ClineMode } from '../tasks/runtime-utils';

function getProviderModels(
  mode: ClineMode,
  localProviders: Record<string, LocalProviderState>,
  providerModels: Record<string, string[]>,
): string[] {
  if (mode === 'ollama') return localProviders.ollama?.models || [];
  if (mode === 'lmstudio') return localProviders.lmstudio?.models || [];
  return providerModels[mode] || [];
}

function getDefaultProviderModel(
  mode: ClineMode,
  localProviders: Record<string, LocalProviderState>,
  providerModels: Record<string, string[]>,
): string {
  if (mode === 'ollama') return localProviders.ollama?.models?.[0] || '';
  if (mode === 'lmstudio') return localProviders.lmstudio?.models?.[0] || '';
  if (mode === 'deepseek') return providerModels.deepseek?.[0] || 'deepseek-chat';
  if (mode === 'anthropic') return providerModels.anthropic?.[0] || 'claude-sonnet-4-6';
  if (mode === 'openai') return providerModels.openai?.[1] || providerModels.openai?.[0] || 'gpt-4o-mini';
  return '';
}

function getProviderDisabled(
  mode: ClineMode,
  localProviders: Record<string, LocalProviderState>,
  configuredApiKeys: Record<string, string>,
): boolean {
  if (mode === 'ollama') return !localProviders.ollama?.available;
  if (mode === 'lmstudio') return !localProviders.lmstudio?.available;
  if (mode === 'deepseek') return !configuredApiKeys.deepseek;
  if (mode === 'anthropic') return !configuredApiKeys.anthropic;
  if (mode === 'openai') return !configuredApiKeys.openai;
  return false;
}

export function SummaryCard({
  label,
  value,
  hint,
  toneClass = 'text-hawk-text',
}: {
  label: string;
  value: string;
  hint: string;
  toneClass?: string;
}) {
  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/50 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text2">{hint}</div>
    </div>
  );
}

export function AgentMetric({
  label,
  value,
  hint,
  toneClass = 'text-hawk-text',
}: {
  label: string;
  value: string;
  hint: string;
  toneClass?: string;
}) {
  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text2">{hint}</div>
    </div>
  );
}

interface SwarmHeroProps {
  agentsCount: number;
  runningCount: number;
  linkedSessionCount: number;
  needsAttentionCount: number;
  failedCount: number;
  totalActions: number;
  totalCost: number;
  runningCost: number;
  completedCount: number;
  handleSpawnSubmit: FormEventHandler<HTMLFormElement>;
  notice: Notice;
  name: string;
  setName: (value: string) => void;
  command: string;
  setCommand: (value: string) => void;
  localModel: string;
  localProviders: Record<string, LocalProviderState>;
  refreshingLocalProviders: boolean;
  refreshLocalProviders: () => void;
  clineMode: ClineMode;
  setClineMode: (value: ClineMode) => void;
  clineModel: string;
  setClineModel: (value: string) => void;
  clineProviderModels: Record<string, string[]>;
  configuredApiKeys: Record<string, string>;
  preferredCline: { mode: ClineMode; model: string };
  clineChoiceTouchedRef: MutableRefObject<boolean>;
  role: AgentRole;
  setRole: (value: AgentRole) => void;
  permissions: 'default' | 'full' | 'supervised';
  setPermissions: (value: 'default' | 'full' | 'supervised') => void;
  prompt: string;
  setPrompt: (value: string) => void;
  personality: string;
  setPersonality: (value: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (value: boolean | ((current: boolean) => boolean)) => void;
  selectedStarterId: string | null;
  applyQuickStart: (starter: QuickStart) => void;
  submitting: boolean;
  suggestedName: string;
  selectedCommand: CommandOption;
  selectedRole: RoleOption;
  launchAgent: () => void;
}

export function SwarmHero({
  agentsCount,
  runningCount,
  linkedSessionCount,
  needsAttentionCount,
  failedCount,
  totalActions,
  totalCost,
  runningCost,
  completedCount,
  handleSpawnSubmit,
  notice,
  name,
  setName,
  command,
  setCommand,
  localModel,
  localProviders,
  refreshingLocalProviders,
  refreshLocalProviders,
  clineMode,
  setClineMode,
  clineModel,
  setClineModel,
  clineProviderModels,
  configuredApiKeys,
  preferredCline,
  clineChoiceTouchedRef,
  role,
  setRole,
  permissions,
  setPermissions,
  prompt,
  setPrompt,
  personality,
  setPersonality,
  showAdvanced,
  setShowAdvanced,
  selectedStarterId,
  applyQuickStart,
  submitting,
  suggestedName,
  selectedCommand,
  selectedRole,
  launchAgent,
}: SwarmHeroProps) {
  return (
    <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/70 p-3 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-3.5">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-16 top-0 h-40 w-40 rounded-full bg-hawk-orange/8 blur-3xl" />
        <div className="absolute right-[-20px] top-6 h-44 w-44 rounded-full bg-cyan-400/8 blur-3xl" />
      </div>

      <div className="relative grid gap-3 xl:grid-cols-[0.92fr_1.08fr]">
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
              Agents Control Room
            </div>
            <div className="max-w-2xl">
              <h1 className="font-display text-lg font-semibold tracking-tight text-hawk-text sm:text-xl">
                Launch specialists, steer them live, and keep the whole room legible.
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-hawk-text2">
                Choose a runtime, frame the mission, set permissions, then monitor the roster in real time.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <SummaryCard
              label="Live"
              value={String(runningCount)}
              hint={`${linkedSessionCount} linked`}
              toneClass="text-cyan-600 dark:text-cyan-400"
            />
            <SummaryCard
              label="Attention"
              value={String(needsAttentionCount)}
              hint={`${failedCount} failed`}
              toneClass={failedCount > 0 ? 'text-red-500 dark:text-red-400' : 'text-hawk-text'}
            />
            <SummaryCard
              label="Actions"
              value={formatCount(totalActions)}
              hint={`${agentsCount} tracked`}
            />
            <SummaryCard
              label="Spend"
              value={formatMoney(totalCost)}
              hint={runningCount > 0 ? `${formatMoney(runningCost)} live` : `${completedCount} done`}
              toneClass="text-hawk-orange"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-hawk-text2">
            <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-3 py-1">
              Guardrails active
            </span>
            <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-3 py-1">
              DriftDetect streaming
            </span>
            <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-3 py-1">
              Follow-ups preserved
            </span>
          </div>
        </div>

        <form
          onSubmit={handleSpawnSubmit}
          className="relative overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/92 p-3 shadow-[0_24px_60px_-40px_rgba(0,0,0,0.72)]"
        >
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute right-0 top-0 h-24 w-24 rounded-full bg-hawk-orange/8 blur-3xl" />
          </div>

          <div className="relative space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Launch Studio
                </div>
                <h2 className="mt-1 font-display text-base font-semibold text-hawk-text">
                  Launch faster, keep the board visible
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <div className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                  Cmd/Ctrl + Enter
                </div>
                <button
                  type="submit"
                  disabled={!prompt.trim() || submitting}
                  className="inline-flex shrink-0 items-center justify-center rounded-full bg-hawk-orange px-4 py-2 font-semibold text-white transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? 'Launching...' : 'Launch'}
                </button>
              </div>
            </div>

            <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/40 p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Starter Kits
                </div>
                <span className="text-[11px] text-hawk-text2">Optional presets</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {QUICK_STARTS.map((starter) => {
                  const isSelected = selectedStarterId === starter.id;
                  return (
                    <button
                      key={starter.id}
                      type="button"
                      onClick={() => applyQuickStart(starter)}
                      className={`rounded-[14px] border px-3 py-2 text-left transition-all ${
                        isSelected
                          ? 'border-hawk-orange/30 bg-hawk-orange/10'
                          : 'border-hawk-border-subtle bg-hawk-bg/45 hover:border-hawk-border hover:bg-hawk-bg/70'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                          {starter.kicker}
                        </span>
                        {isSelected && (
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
                            active
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-hawk-text">{starter.label}</div>
                      <div className="mt-1 text-[11px] leading-4 text-hawk-text2">{starter.summary}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-3">
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Mission
                  </div>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Describe exactly what this agent should own, what good looks like, and what constraints it should respect."
                    rows={3}
                    className="w-full resize-none rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2.5 text-sm leading-6 text-hawk-text placeholder:text-hawk-text3 focus:border-hawk-orange/50 focus:outline-none focus:ring-1 focus:ring-hawk-orange/20"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        launchAgent();
                      }
                    }}
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                      Name
                    </div>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={suggestedName}
                      className="w-full rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2.5 text-sm text-hawk-text placeholder:text-hawk-text3 focus:border-hawk-orange/50 focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((current) => !current)}
                    className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
                  >
                    {showAdvanced ? 'Hide Briefing' : 'Add Briefing'}
                  </button>
                </div>

                {showAdvanced && (
                  <div>
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                      Operating Brief
                    </div>
                    <textarea
                      value={personality}
                      onChange={(event) => setPersonality(event.target.value)}
                      placeholder="Optional: tone, coding style, verification level, or constraints."
                      rows={2}
                      className="w-full resize-none rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2.5 text-sm leading-6 text-hawk-text placeholder:text-hawk-text3 focus:border-hawk-orange/50 focus:outline-none"
                    />
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/40 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                      Runtime
                    </div>
                    <button
                      type="button"
                      onClick={refreshLocalProviders}
                      disabled={refreshingLocalProviders}
                      className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text disabled:opacity-50"
                    >
                      {refreshingLocalProviders ? 'Refreshing...' : 'Refresh'}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {COMMAND_OPTIONS.map((option) => {
                      const isSelected = command === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setCommand(option.value);
                            if (
                              option.value === 'cline'
                              && !clineChoiceTouchedRef.current
                              && clineMode === 'configured'
                              && !clineModel
                            ) {
                              setClineMode(preferredCline.mode);
                              setClineModel(preferredCline.model);
                            }
                          }}
                          className={`rounded-[14px] border px-3 py-2 text-left transition-all ${
                            isSelected
                              ? 'border-hawk-orange/30 bg-hawk-orange/10'
                              : 'border-hawk-border-subtle bg-hawk-surface/55 hover:border-hawk-border'
                          }`}
                        >
                          <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${option.badgeClass}`}>
                            {option.kicker}
                          </span>
                          <div className="mt-1 text-sm font-semibold text-hawk-text">{option.label}</div>
                        </button>
                      );
                    })}
                  </div>

                  {command === 'cline' && (
                    <div className="mt-3 space-y-3 rounded-[14px] border border-hawk-border-subtle bg-hawk-surface/55 px-3 py-3">
                      <div>
                        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                          Cline provider
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {CLINE_PROVIDER_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                clineChoiceTouchedRef.current = true;
                                setClineMode(option.value);
                                setClineModel(
                                  option.value === 'configured'
                                    ? ''
                                    : getDefaultProviderModel(option.value, localProviders, clineProviderModels),
                                );
                              }}
                              disabled={getProviderDisabled(option.value, localProviders, configuredApiKeys)}
                              className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
                                clineMode === option.value
                                  ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                                  : 'border-hawk-border-subtle bg-hawk-bg/45 text-hawk-text3'
                              } disabled:cursor-not-allowed disabled:opacity-40`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {clineMode !== 'configured' && (
                        <div>
                          <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                            Model
                          </label>
                          <select
                            value={clineModel}
                            onChange={(event) => setClineModel(event.target.value)}
                            className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text focus:border-hawk-orange/50 focus:outline-none"
                          >
                            {getProviderModels(clineMode, localProviders, clineProviderModels).map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <p className="text-xs text-hawk-text2">{describeClineMode(clineMode)}</p>
                    </div>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/40 p-3">
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                      Role
                    </div>
                    <select
                      value={role}
                      onChange={(event) => setRole(event.target.value as AgentRole)}
                      className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text outline-none transition-colors focus:border-hawk-orange/35"
                    >
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 text-[11px] leading-5 text-hawk-text2">{selectedRole.summary}</div>
                  </div>

                  <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/40 p-3">
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                      Permissions
                    </div>
                    <select
                      value={permissions}
                      onChange={(event) => setPermissions(event.target.value as 'default' | 'full' | 'supervised')}
                      className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text outline-none transition-colors focus:border-hawk-orange/35"
                    >
                      <option value="full">Full access</option>
                      <option value="supervised">Supervised</option>
                      <option value="default">Restricted</option>
                    </select>
                    <div className="mt-2 text-[11px] leading-5 text-hawk-text2">
                      {permissions === 'full'
                        ? 'Read and write without asking.'
                        : permissions === 'supervised'
                          ? 'Guardrails stay active.'
                          : 'Default runtime permissions only.'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {notice && (
              <div
                className={`rounded-[16px] border px-3 py-2.5 text-sm ${
                  notice.type === 'success'
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                    : 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300'
                }`}
              >
                {notice.text}
              </div>
            )}

            <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                Launch Preview
              </div>
              <div className="mt-1 text-sm font-semibold text-hawk-text">
                {(name.trim() || suggestedName)} with {selectedCommand.label}{localModel ? ` (${localModel})` : ''} as{' '}
                {selectedRole.label}
              </div>
              <div className="mt-1 text-xs leading-5 text-hawk-text2">
                {selectedCommand.detail}
                {permissions === 'full' && ' · Full file access granted.'}
                {permissions === 'supervised' && ' · Guardrails will control dangerous actions.'}
                {permissions === 'default' && ' · Default permissions — may need manual approval.'}
              </div>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

interface SwarmToolbarProps {
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  filter: AgentStatusFilter;
  setFilter: (value: AgentStatusFilter) => void;
  filterCounts: Record<AgentStatusFilter, number>;
  finishedCount: number;
  actingAgentId: string | null;
  handleClearFinished: () => void;
  clearFilters: () => void;
  visibleAgentsCount: number;
  agentsCount: number;
  runningCount: number;
}

export function SwarmToolbar({
  searchQuery,
  setSearchQuery,
  filter,
  setFilter,
  filterCounts,
  finishedCount,
  actingAgentId,
  handleClearFinished,
  clearFilters,
  visibleAgentsCount,
  agentsCount,
  runningCount,
}: SwarmToolbarProps) {
  return (
    <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/60 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative min-w-[240px] flex-1 sm:max-w-md">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by name, runtime, mission, or session id"
              className="w-full rounded-[18px] border border-hawk-border-subtle bg-hawk-surface px-4 py-2.5 pl-11 text-sm text-hawk-text placeholder:text-hawk-text3 focus:border-hawk-orange/50 focus:outline-none"
            />
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-hawk-text3"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>

          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((option) => {
              const isSelected = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                    isSelected
                      ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                      : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                  }`}
                >
                  {option.label} <span className="ml-1 text-hawk-text2">{filterCounts[option.id]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {finishedCount > 0 && (
            <button
              type="button"
              onClick={handleClearFinished}
              disabled={actingAgentId === 'clear-finished'}
              className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-red-500/25 hover:text-red-500 dark:hover:text-red-300 disabled:opacity-50"
            >
              {actingAgentId === 'clear-finished' ? 'Clearing...' : `Clear finished (${finishedCount})`}
            </button>
          )}

          {(filter !== 'all' || searchQuery.trim()) && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-hawk-text2">
        <span>
          Showing <span className="font-semibold text-hawk-text">{visibleAgentsCount}</span> of{' '}
          <span className="font-semibold text-hawk-text">{agentsCount}</span> agents
        </span>
        <span className="hidden h-1 w-1 rounded-full bg-hawk-border sm:inline-block" />
        <span>{runningCount > 0 ? `${runningCount} still live` : 'No live runs right now'}</span>
      </div>
    </section>
  );
}

export function EmptySwarmState({
  title,
  body,
  tone = 'solid',
}: {
  title: string;
  body: string;
  tone?: 'solid' | 'dashed';
}) {
  return (
    <div
      className={`rounded-[24px] ${
        tone === 'dashed' ? 'border-dashed' : ''
      } border border-hawk-border-subtle bg-hawk-surface/50 px-6 py-16 text-center`}
    >
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[20px] border border-hawk-border-subtle bg-hawk-bg/55 font-display text-2xl text-hawk-orange">
        A
      </div>
      <h3 className="mt-4 font-display text-2xl font-semibold text-hawk-text">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-hawk-text2">{body}</p>
    </div>
  );
}

interface AgentCardProps {
  agent: LiveAgentData;
  events: AgentEventData[];
  isExpanded: boolean;
  showingOutput: boolean;
  messageDraft: string;
  sendingMessage: boolean;
  actingAgentId: string | null;
  submitting: boolean;
  permDropdownId: string | null;
  updatingPermId: string | null;
  onTogglePermissions: () => void;
  onChangePermissions: (value: 'default' | 'full' | 'supervised') => void;
  onStop: () => void;
  onRemove: () => void;
  onClone: () => void;
  onToggleOutput: () => void;
  onToggleExpanded: () => void;
  onMessageDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onRequestCIReport: (sessionId: string) => void;
  ciReportLoading: boolean;
  ciReport: CIReportData | null;
  onCloseCIReport: () => void;
  onCopyReport: (markdown: string) => void;
  outputRef: (element: HTMLDivElement | null) => void;
}

export function AgentCard({
  agent,
  events,
  isExpanded,
  showingOutput,
  messageDraft,
  sendingMessage,
  actingAgentId,
  submitting,
  permDropdownId,
  updatingPermId,
  onTogglePermissions,
  onChangePermissions,
  onStop,
  onRemove,
  onClone,
  onToggleOutput,
  onToggleExpanded,
  onMessageDraftChange,
  onSendMessage,
  onRequestCIReport,
  ciReportLoading,
  ciReport,
  onCloseCIReport,
  onCopyReport,
  outputRef,
}: AgentCardProps) {
  const commandOption = getCommandOption(agent.command);
  const roleOption = getRoleOption(agent.role);
  const sessionId = normalizeSessionId(agent.sessionId);
  const isRunning = agent.status === 'running';
  const color = agentColor(agent.command);
  const output = agent.output || '';
  const outputPreview = getOutputPreview(output);
  const durationLabel = isRunning
    ? `Live for ${timeAgo(agent.startedAt)}`
    : `Ran for ${formatDuration(agent.startedAt, agent.finishedAt)}`;

  return (
    <article
      className={`relative flex max-h-[540px] flex-col overflow-hidden rounded-[20px] border bg-hawk-surface/75 shadow-[0_20px_48px_-38px_rgba(0,0,0,1)] transition-all ${
        isRunning
          ? 'border-cyan-500/25'
          : agent.status === 'failed'
            ? 'border-red-500/25'
            : 'border-hawk-border-subtle'
      }`}
    >
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute -right-12 top-0 h-44 w-44 rounded-full blur-3xl"
          style={{ backgroundColor: `${color}16` }}
        />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-hawk-border to-transparent" />
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] text-sm font-bold text-white ${
                isRunning ? 'animate-pulse' : ''
              }`}
              style={{
                backgroundColor: color,
                boxShadow: isRunning ? `0 0 22px ${color}35` : 'none',
              }}
            >
              {agent.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-base font-semibold text-hawk-text sm:text-lg">{agent.name}</h3>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${getStatusBadgeClass(agent.status)}`}
                >
                  {agent.status}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${roleOption.badgeClass}`}
                >
                  {roleOption.label}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${commandOption.borderClass} ${commandOption.badgeClass}`}
                >
                  {commandOption.label}
                </span>
                <div className="relative" data-perm-dropdown>
                  <button
                    type="button"
                    onClick={onTogglePermissions}
                    disabled={updatingPermId === agent.id}
                    className={`cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors disabled:opacity-50 ${
                      agent.permissions === 'full'
                        ? 'border-green-500/30 text-green-700 hover:bg-green-500/10 dark:text-green-400'
                        : agent.permissions === 'supervised'
                          ? 'border-amber-500/30 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400'
                          : 'border-red-500/30 text-red-700 hover:bg-red-500/10 dark:text-red-400'
                    }`}
                    title="Click to change permissions"
                  >
                    {agent.permissions === 'full'
                      ? 'Full Access'
                      : agent.permissions === 'supervised'
                        ? 'Supervised'
                        : 'Restricted'}
                    <span className="ml-1 text-[8px]">▼</span>
                  </button>
                  {permDropdownId === agent.id && (
                    <div className="absolute left-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-[14px] border border-hawk-border-subtle bg-hawk-surface shadow-xl">
                      {([
                        {
                          value: 'full' as const,
                          label: 'Full Access',
                          desc: 'Skip all permission checks',
                          cls: 'text-green-700 dark:text-green-400',
                        },
                        {
                          value: 'supervised' as const,
                          label: 'Supervised',
                          desc: 'Hawkeye guardrails active',
                          cls: 'text-amber-700 dark:text-amber-400',
                        },
                        {
                          value: 'default' as const,
                          label: 'Restricted',
                          desc: 'Default runtime permissions',
                          cls: 'text-red-700 dark:text-red-400',
                        },
                      ]).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => onChangePermissions(option.value)}
                          className={`flex w-full flex-col px-3 py-2 text-left transition-colors hover:bg-hawk-orange/10 ${
                            agent.permissions === option.value ? 'bg-hawk-bg/60' : ''
                          }`}
                        >
                          <span className={`font-mono text-[11px] font-bold uppercase tracking-[0.12em] ${option.cls}`}>
                            {option.label}
                            {agent.permissions === option.value && <span className="ml-1 text-hawk-text3">✓</span>}
                          </span>
                          <span className="text-[10px] text-hawk-text3">{option.desc}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p className="mt-1.5 line-clamp-3 max-w-2xl text-sm leading-5 text-hawk-text2">
                {agent.prompt.length > 200 ? `${agent.prompt.slice(0, 200)}...` : agent.prompt}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-hawk-text2">
                <span>Started {formatClock(agent.startedAt)}</span>
                <span className="h-1 w-1 rounded-full bg-hawk-border" />
                <span>{durationLabel}</span>
                {agent.pid && (
                  <>
                    <span className="h-1 w-1 rounded-full bg-hawk-border" />
                    <span>PID {agent.pid}</span>
                  </>
                )}
                {agent.exitCode !== null && !isRunning && (
                  <>
                    <span className="h-1 w-1 rounded-full bg-hawk-border" />
                    <span>Exit {agent.exitCode}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                disabled={actingAgentId === agent.id}
                className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-red-600 transition-colors hover:bg-red-500/15 disabled:opacity-50 dark:text-red-300"
              >
                {actingAgentId === agent.id ? 'Stopping...' : 'Stop'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onRemove}
                disabled={actingAgentId === agent.id}
                className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-red-500/25 hover:text-red-500 disabled:opacity-50 dark:hover:text-red-300"
              >
                {actingAgentId === agent.id ? 'Removing...' : 'Remove'}
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
          <AgentMetric
            label="Drift"
            value={agent.driftScore !== null ? String(agent.driftScore) : '--'}
            hint={agent.driftScore !== null ? 'Current score' : 'No signal yet'}
            toneClass={driftColor(agent.driftScore)}
          />
          <AgentMetric
            label="Cost"
            value={formatMoney(agent.costUsd || 0)}
            hint={isRunning ? 'Live spend' : 'Accumulated spend'}
          />
          <AgentMetric
            label="Actions"
            value={String(agent.actionCount || 0)}
            hint="Tracked operations"
          />
          <AgentMetric
            label="Session"
            value={sessionId ? 'Linked' : 'Pending'}
            hint={sessionId ? sessionId.slice(0, 8) : 'Waiting for session link'}
            toneClass={sessionId ? 'text-hawk-orange' : 'text-hawk-text'}
          />
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-3">
            {agent.personality && (
              <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Operating Brief
                </div>
                <p className="mt-2 text-sm leading-5 text-hawk-text2">{agent.personality}</p>
              </section>
            )}

            {agent.filesChanged?.length > 0 && (
              <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Files Touched
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-emerald-600 dark:text-emerald-400">+{agent.linesAdded}</span>
                    <span className="text-red-500 dark:text-red-400">-{agent.linesRemoved}</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {agent.filesChanged.slice(0, 6).map((filePath) => (
                    <span
                      key={filePath}
                      className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-2.5 py-1 text-[10px] text-hawk-text2"
                    >
                      {filePath.split('/').pop()}
                    </span>
                  ))}
                  {agent.filesChanged.length > 6 && (
                    <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface2 px-2.5 py-1 text-[10px] text-hawk-text3">
                      +{agent.filesChanged.length - 6} more
                    </span>
                  )}
                </div>
              </section>
            )}

            {outputPreview && !showingOutput && (
              <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/72 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Terminal Tail
                </div>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-5 text-hawk-text2">
                  {outputPreview}
                </pre>
              </section>
            )}
          </div>

          <section className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                Recent Activity
              </div>
              {sessionId && (
                <Link
                  to={`/session/${sessionId}`}
                  className="font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-orange transition-colors hover:text-hawk-text"
                >
                  Open session
                </Link>
              )}
            </div>

            {events.length === 0 ? (
              <div className="mt-3 rounded-[16px] border border-dashed border-hawk-border-subtle bg-hawk-surface/40 px-3 py-5 text-sm text-hawk-text3">
                {isRunning
                  ? 'Waiting for the first traced action to land.'
                  : 'No recent traced activity was recorded for this agent.'}
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {events.slice(-8).map((event, index) => (
                  <div
                    key={event.id || index}
                    className="flex items-start gap-2.5 rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/35 px-2.5 py-2"
                  >
                    <div className={`mt-0.5 font-mono text-xs ${eventColor(event.type)}`}>{eventIcon(event.type)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-hawk-text2 sm:text-sm">{parseEventSummary(event)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                        <span>{event.type}</span>
                        <span>{timeAgo(event.timestamp)} ago</span>
                      </div>
                    </div>
                    {event.drift_score !== null && (
                      <div className={`font-mono text-[11px] ${driftColor(event.drift_score)}`}>
                        {event.drift_score}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hawk-border-subtle pt-3">
          {output && (
            <button
              type="button"
              onClick={onToggleOutput}
              className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                showingOutput
                  ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                  : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
              }`}
            >
              {showingOutput ? 'Hide tail' : 'Show tail'}
            </button>
          )}

          <button
            type="button"
            onClick={onToggleExpanded}
            className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
              isExpanded
                ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
            }`}
          >
            {isExpanded ? 'Close follow-up' : isRunning ? 'Steer live' : 'Send follow-up'}
          </button>

          {!isRunning && (
            <button
              type="button"
              onClick={onClone}
              disabled={submitting}
              className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-orange/30 hover:text-hawk-orange disabled:opacity-50"
            >
              {submitting ? 'Launching...' : agent.status === 'failed' ? 'Relaunch' : 'Clone'}
            </button>
          )}

          {sessionId && (
            <Link
              to={`/session/${sessionId}`}
              className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
            >
              Full session
            </Link>
          )}

          {sessionId && (
            <button
              type="button"
              onClick={() => onRequestCIReport(sessionId)}
              disabled={ciReportLoading}
              className="rounded-full border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange transition-colors hover:bg-hawk-orange/20 disabled:opacity-50"
            >
              {ciReportLoading ? 'Generating...' : 'CI Report'}
            </button>
          )}
        </div>

        {ciReport && (
          <section className="mt-3 overflow-hidden rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/72">
            <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">CI Report</span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                    ciReport.passed ? 'bg-hawk-green/15 text-hawk-green' : 'bg-hawk-red/15 text-hawk-red'
                  }`}
                >
                  {ciReport.passed ? 'passed' : 'failed'}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                    ciReport.risk === 'critical'
                      ? 'bg-hawk-red/15 text-hawk-red'
                      : ciReport.risk === 'high'
                        ? 'bg-hawk-amber/15 text-hawk-amber'
                        : ciReport.risk === 'medium'
                          ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400'
                          : 'bg-hawk-green/15 text-hawk-green'
                  }`}
                >
                  {ciReport.risk} risk
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onCopyReport(ciReport.markdown)}
                  className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] text-hawk-text3 transition-colors hover:border-hawk-orange/30 hover:text-hawk-orange"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={onCloseCIReport}
                  className="text-xs text-hawk-text3 hover:text-hawk-text"
                >
                  ✕
                </button>
              </div>
            </div>
            {ciReport.flags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                {ciReport.flags.map((flag) => (
                  <span
                    key={flag}
                    className="rounded-full border border-hawk-amber/30 bg-hawk-amber/15 px-2 py-0.5 font-mono text-[10px] text-hawk-amber"
                  >
                    {flag}
                  </span>
                ))}
              </div>
            )}
            <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-5 text-hawk-text2">
              {ciReport.markdown}
            </pre>
          </section>
        )}

        {showingOutput && output && (
          <section className="mt-3 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/72 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              Output
            </div>
            <div
              ref={outputRef}
              className="max-h-72 overflow-y-auto rounded-[14px] border border-hawk-border-subtle bg-hawk-surface/55 p-3 font-mono text-[11px] leading-5"
            >
              {output
                .slice(-9000)
                .split('\n')
                .map((line, index) => (
                  <div
                    key={`${agent.id}-output-${index}`}
                    className={`${formatOutputLineClass(line)} whitespace-pre-wrap break-words`}
                  >
                    {line || ' '}
                  </div>
                ))}
            </div>
          </section>
        )}

        {isExpanded && (
          <section className="mt-3 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              {isRunning ? 'Live redirect' : 'Follow-up Instruction'}
            </div>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <input
                value={messageDraft}
                onChange={(event) => onMessageDraftChange(event.target.value)}
                placeholder={
                  isRunning
                    ? 'Redirect the agent, tighten scope, or correct drift while it is still running.'
                    : 'Ask for a refinement, redirect the task, or request a tighter review pass.'
                }
                className="flex-1 rounded-[18px] border border-hawk-border-subtle bg-hawk-surface px-3.5 py-2.5 text-sm text-hawk-text placeholder:text-hawk-text3 focus:border-hawk-orange/50 focus:outline-none"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onSendMessage();
                  }
                }}
              />
              <button
                type="button"
                onClick={onSendMessage}
                disabled={!messageDraft.trim() || sendingMessage}
                className="rounded-[18px] bg-hawk-orange px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sendingMessage ? 'Sending...' : 'Send'}
              </button>
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

interface AgentCommsPanelProps {
  agents: LiveAgentData[];
  commsMessages: AgentMessageData[];
  commsOpen: boolean;
  setCommsOpen: (value: boolean) => void;
  commsInput: string;
  setCommsInput: (value: string) => void;
  commsTo: string;
  setCommsTo: (value: string) => void;
  commsSending: boolean;
  handleSendComm: () => void;
  commsEndRef: MutableRefObject<HTMLDivElement | null>;
}

export function AgentCommsPanel({
  agents,
  commsMessages,
  commsOpen,
  setCommsOpen,
  commsInput,
  setCommsInput,
  commsTo,
  setCommsTo,
  commsSending,
  handleSendComm,
  commsEndRef,
}: AgentCommsPanelProps) {
  if (agents.length === 0) return null;

  return (
    <div
      className={`fixed bottom-0 left-3 right-3 z-50 transition-all duration-300 md:left-auto md:right-6 md:w-[380px] ${
        commsOpen ? 'translate-y-0' : 'translate-y-[calc(100%-44px)]'
      }`}
    >
      <button
        type="button"
        onClick={() => setCommsOpen(!commsOpen)}
        className="flex w-full items-center justify-between rounded-t-[16px] border border-b-0 border-hawk-border-subtle bg-hawk-surface px-4 py-2.5"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-text">Agent Comms</span>
          {commsMessages.length > 0 && (
            <span className="rounded-full bg-hawk-orange/20 px-1.5 py-0.5 font-mono text-[10px] text-hawk-orange">
              {commsMessages.length}
            </span>
          )}
        </div>
        <span className="text-xs text-hawk-text3">{commsOpen ? '▼' : '▲'}</span>
      </button>

      <div className="flex h-[55vh] max-h-[400px] min-h-[280px] flex-col border border-hawk-border-subtle bg-hawk-bg md:h-[400px]">
        <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
          {commsMessages.length === 0 && (
            <div className="flex h-full items-center justify-center text-[11px] text-hawk-text3">
              No messages yet. Agents can communicate here.
            </div>
          )}
          {commsMessages.map((message) => {
            const isFromDashboard = message.from === 'dashboard';
            const typeColors: Record<string, string> = {
              direct: 'border-cyan-500/30',
              broadcast: 'border-hawk-orange/30',
              decision: 'border-green-500/30',
              request: 'border-amber-500/30',
              response: 'border-blue-500/30',
            };
            const borderClass = typeColors[message.type] || 'border-hawk-border-subtle';

            return (
              <div key={message.id} className={`rounded-[12px] border ${borderClass} bg-hawk-surface/80 px-3 py-2`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className={`font-mono text-[10px] font-bold ${isFromDashboard ? 'text-hawk-orange' : 'text-cyan-400'}`}>
                      {message.fromName}
                    </span>
                    <span
                      className={`rounded px-1 py-0.5 font-mono text-[8px] uppercase ${
                        message.type === 'broadcast'
                          ? 'bg-hawk-orange/15 text-hawk-orange'
                          : message.type === 'decision'
                            ? 'bg-green-500/15 text-green-400'
                            : message.type === 'request'
                              ? 'bg-amber-500/15 text-amber-400'
                              : 'bg-cyan-500/15 text-cyan-400'
                      }`}
                    >
                      {message.type}
                    </span>
                    {message.to && (
                      <span className="font-mono text-[9px] text-hawk-text3">
                        → {agents.find((agent) => agent.id === message.to)?.name || message.to}
                      </span>
                    )}
                    {message.toRole && (
                      <span className="font-mono text-[9px] text-hawk-text3">→ all {message.toRole}s</span>
                    )}
                  </div>
                  <span className="font-mono text-[9px] text-hawk-text3">
                    {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-hawk-text2">
                  {message.content}
                </div>
              </div>
            );
          })}
          <div ref={commsEndRef} />
        </div>

        <div className="border-t border-hawk-border-subtle bg-hawk-surface/60 px-3 py-2">
          <div className="mb-2 flex items-center gap-2">
            <select
              value={commsTo}
              onChange={(event) => setCommsTo(event.target.value)}
              className="rounded-[10px] border border-hawk-border-subtle bg-hawk-surface px-2 py-1 font-mono text-[10px] text-hawk-text2 outline-none"
            >
              <option value="broadcast">All agents</option>
              <option value="lead">All leads</option>
              <option value="worker">All workers</option>
              <option value="reviewer">All reviewers</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.role})
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={commsInput}
              onChange={(event) => setCommsInput(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSendComm();
                }
              }}
              placeholder="Send a message to agents..."
              className="flex-1 rounded-[10px] border border-hawk-border-subtle bg-hawk-surface px-3 py-1.5 font-mono text-[11px] text-hawk-text placeholder:text-hawk-text3 outline-none focus:border-hawk-orange/50"
            />
            <button
              type="button"
              onClick={handleSendComm}
              disabled={commsSending || !commsInput.trim()}
              className="rounded-[10px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-hawk-orange transition-colors hover:bg-hawk-orange/20 disabled:opacity-40"
            >
              {commsSending ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
