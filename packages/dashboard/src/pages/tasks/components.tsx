import type { ChangeEvent, FormEvent, KeyboardEvent, RefObject } from 'react';
import type { TaskData } from '../../api';
import {
  describeClineMode,
  formatTaskDuration,
  getTaskAgentLabel,
  getTaskFailureSuggestion,
} from './runtime-utils';
import type { ClineMode } from './runtime-utils';
import type { PendingReview, TaskFilter } from './types';

const STATUS_COLORS: Record<string, string> = {
  pending: 'text-yellow-400',
  running: 'text-blue-400 animate-pulse',
  completed: 'text-hawk-green',
  failed: 'text-red-400',
  cancelled: 'text-hawk-text3',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '\u23F3',
  running: '\u25B6',
  completed: '\u2713',
  failed: '\u2717',
  cancelled: '\u2298',
};

function timeAgo(dateStr: string, now = Date.now()): string {
  const diff = now - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TaskHero({
  running,
  tasksCount,
  pendingReviewsCount,
  daemonSummary,
  feedback,
  activeTask,
  now,
  showJournal,
  onToggleJournal,
  pending,
  completed,
  failed,
  autoApprove,
  onToggleAutoApprove,
}: {
  running: number;
  tasksCount: number;
  pendingReviewsCount: number;
  daemonSummary: { value: string; detail: string; tone: string };
  feedback: { tone: 'good' | 'danger'; message: string } | null;
  activeTask: TaskData | null;
  now: number;
  showJournal: boolean;
  onToggleJournal: () => void;
  pending: number;
  completed: number;
  failed: number;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
}) {
  return (
    <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-0 h-52 w-52 rounded-full bg-blue-500/8 blur-3xl" />
        <div className="absolute right-[-30px] top-8 h-56 w-56 rounded-full bg-hawk-orange/10 blur-3xl" />
        <div className="absolute bottom-[-60px] left-1/3 h-52 w-52 rounded-full bg-cyan-400/8 blur-3xl" />
      </div>

      <div className="relative grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
        <div className="space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
            <span className={`inline-block h-2 w-2 rounded-full ${running > 0 ? 'bg-blue-400 animate-pulse' : 'bg-hawk-orange'}`} />
            Remote Tasks
          </span>

          <div className="space-y-2">
            <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
              Task Studio
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-hawk-text2">
              Send prompts to the daemon, attach screenshots, track the execution queue, and handle review gates in one place.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <InfoPill label="Daemon" value={daemonSummary.value} tone={daemonSummary.tone === 'good' ? 'good' : 'warning'} />
            <InfoPill label="Queue" value={`${tasksCount} tasks`} />
            <InfoPill label="Reviews" value={pendingReviewsCount > 0 ? `${pendingReviewsCount} pending` : 'clear'} tone={pendingReviewsCount > 0 ? 'warning' : 'good'} />
          </div>

          <p className="text-xs text-hawk-text3">{daemonSummary.detail}</p>

          {feedback && (
            <div className={`rounded-[16px] border px-3 py-2 text-sm ${
              feedback.tone === 'good'
                ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green'
                : 'border-red-500/25 bg-red-500/10 text-red-400'
            }`}>
              {feedback.message}
            </div>
          )}

          {activeTask && (
            <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
                Current hotspot
              </div>
              <p className="mt-2 text-sm text-hawk-text">{activeTask.prompt}</p>
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                <span>{getTaskAgentLabel(activeTask.agent)}</span>
                <span>{activeTask.status}</span>
                <span>{formatTimestamp(activeTask.createdAt)}</span>
                {formatTaskDuration(activeTask, now) && <span>{formatTaskDuration(activeTask, now)} run time</span>}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
            <button
              onClick={onToggleJournal}
              className={`rounded-[18px] border px-3 py-2 font-mono text-[11px] transition-colors ${
                showJournal
                  ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                  : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:text-hawk-text'
              }`}
            >
              {showJournal ? 'Hide memory' : 'Open memory'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <MiniMetric label="Pending" value={String(pending)} meta="Queued tasks" tone="warning" />
            <MiniMetric label="Running" value={String(running)} meta="Active executions" tone="running" />
            <MiniMetric label="Completed" value={String(completed)} meta="Finished runs" tone="good" />
            <MiniMetric label="Failed" value={String(failed)} meta="Needs review" tone={failed > 0 ? 'danger' : 'muted'} />
          </div>

          <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Auto-approve</div>
                <p className="mt-1 text-xs text-hawk-text2">
                  {autoApprove ? 'Review gates will be approved automatically.' : 'Risky actions pause until you approve them.'}
                </p>
              </div>
              <button
                onClick={onToggleAutoApprove}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${autoApprove ? 'bg-hawk-orange' : 'bg-hawk-surface3'}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-hawk-surface shadow transition-transform ${autoApprove ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function JournalPanel({
  journal,
  onClearJournal,
}: {
  journal: string | null;
  onClearJournal: () => void;
}) {
  return (
    <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-hawk-text">Agent memory</h2>
          <p className="text-xs text-hawk-text2">
            Persistent task journal — useful for keeping daemon execution context across runs.
          </p>
        </div>
        <button
          onClick={onClearJournal}
          className="rounded-[14px] border border-red-500/30 bg-red-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400 hover:bg-red-500/20"
        >
          Clear memory
        </button>
      </div>
      {journal ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/60 p-2.5 font-mono text-xs text-hawk-text2">
          {journal}
        </pre>
      ) : (
        <div className="rounded-[16px] border border-dashed border-hawk-border-subtle bg-hawk-bg/35 py-8 text-center">
          <p className="font-mono text-xs text-hawk-text3">No memory yet. Tasks will be logged here after execution.</p>
        </div>
      )}
    </section>
  );
}

export function ReviewQueue({
  pendingReviews,
  autoApprove,
  onApprove,
  onDeny,
}: {
  pendingReviews: PendingReview[];
  autoApprove: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  return (
    <div className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <div className="mb-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">Review gates</h2>
        <p className="text-xs text-hawk-text2">
          Sensitive commands land here as long as auto-approve is disabled.
        </p>
      </div>

      {pendingReviews.length > 0 && !autoApprove ? (
        <div className="space-y-2">
          {pendingReviews.map((review) => (
            <div key={review.id} className="rounded-[16px] border border-hawk-amber/30 bg-hawk-amber/5 p-2.5">
              <p className="font-mono text-xs text-hawk-text">{review.command}</p>
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                <span>{formatTimestamp(review.timestamp)}</span>
                <span>{review.sessionId.slice(0, 8)}</span>
                <span className="text-hawk-amber">{review.matchedPattern}</span>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => onApprove(review.id)}
                  className="rounded-[14px] border border-hawk-green/30 bg-hawk-green/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-green hover:bg-hawk-green/20"
                >
                  Approve
                </button>
                <button
                  onClick={() => onDeny(review.id)}
                  className="rounded-[14px] border border-red-500/30 bg-red-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400 hover:bg-red-500/20"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-[16px] border border-dashed border-hawk-border-subtle bg-hawk-bg/35 py-8 text-center">
          <p className="font-mono text-xs text-hawk-text3">
            {autoApprove ? 'Auto-approve is enabled. Review queue stays clear unless you disable it.' : 'No actions awaiting approval right now.'}
          </p>
        </div>
      )}
    </div>
  );
}

export function TaskComposer({
  onSubmit,
  prompt,
  onPromptChange,
  onPromptKeyDown,
  agent,
  onAgentChange,
  claudeMode,
  onClaudeModeChange,
  claudeApiModel,
  onClaudeApiModelChange,
  clineMode,
  onClineModeChange,
  clineModel,
  onClineModelChange,
  clineProviderModels,
  configuredApiKeys,
  localProviders,
  attachments,
  onRemoveAttachment,
  fileInputRef,
  onFileSelect,
  onOpenFilePicker,
  submitting,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  agent: string;
  onAgentChange: (value: string) => void;
  claudeMode: 'subscription' | 'api';
  onClaudeModeChange: (value: 'subscription' | 'api') => void;
  claudeApiModel: string;
  onClaudeApiModelChange: (value: string) => void;
  clineMode: ClineMode;
  onClineModeChange: (value: ClineMode) => void;
  clineModel: string;
  onClineModelChange: (value: string) => void;
  clineProviderModels: Record<string, string[]>;
  configuredApiKeys: Record<string, string>;
  localProviders: Record<string, { available: boolean; models?: string[] }>;
  attachments: Array<{ name: string; data: string; preview: string }>;
  onRemoveAttachment: (index: number) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  onOpenFilePicker: () => void;
  submitting: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <div className="grid gap-3.5 lg:grid-cols-[1.14fr_0.86fr]">
        <div>
          <div className="mb-3">
            <h2 className="font-display text-base font-semibold text-hawk-text">Launch a new task</h2>
            <p className="text-xs text-hawk-text2">
              Write the brief, pick the remote agent, and attach screenshots if the daemon needs visual context.
            </p>
          </div>

          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder="Describe what the agent should do..."
            rows={4}
            className="w-full resize-none rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3.5 py-2.5 font-mono text-sm text-hawk-text placeholder:text-hawk-text3 focus:border-hawk-orange/50 focus:outline-none focus:ring-1 focus:ring-hawk-orange/30"
            onKeyDown={onPromptKeyDown}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onFileSelect}
          />

          {attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <div key={index} className="group relative h-16 w-16 overflow-hidden rounded-[14px] border border-hawk-border-subtle sm:h-20 sm:w-20">
                  <img src={attachment.preview} alt={attachment.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(index)}
                    className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Execution setup</div>
            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">Agent</label>
                <select
                  value={agent}
                  onChange={(event) => onAgentChange(event.target.value)}
                  className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text focus:border-hawk-orange/50 focus:outline-none"
                >
                  <optgroup label="CLI Agents">
                    <option value="claude">claude code</option>
                    <option value="cline">cline cli</option>
                    <option value="codex">codex</option>
                  </optgroup>
                </select>
              </div>

              {agent === 'claude' && (
                <div className="space-y-3 rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">Claude mode</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onClaudeModeChange('subscription')}
                        className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
                          claudeMode === 'subscription'
                            ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                            : 'border-hawk-border-subtle bg-hawk-bg/45 text-hawk-text3'
                        }`}
                      >
                        Claude Code plan
                      </button>
                      <button
                        type="button"
                        onClick={() => onClaudeModeChange('api')}
                        className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
                          claudeMode === 'api'
                            ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                            : 'border-hawk-border-subtle bg-hawk-bg/45 text-hawk-text3'
                        }`}
                      >
                        Anthropic API
                      </button>
                    </div>
                  </div>

                  {claudeMode === 'subscription' ? (
                    <p className="text-xs text-hawk-text2">
                      Uses the local <span className="font-mono text-hawk-text">Claude Code</span> CLI login and subscription, not <span className="font-mono text-hawk-text">ANTHROPIC_API_KEY</span>.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div>
                        <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">API model</label>
                        <select
                          value={claudeApiModel}
                          onChange={(event) => onClaudeApiModelChange(event.target.value)}
                          className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text focus:border-hawk-orange/50 focus:outline-none"
                        >
                          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                          <option value="claude-opus-4-6">claude-opus-4-6</option>
                        </select>
                      </div>
                      <p className="text-xs text-hawk-text2">
                        Uses the Anthropic API with an explicit Claude model, so this mode needs a working <span className="font-mono text-hawk-text">ANTHROPIC_API_KEY</span>.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {agent === 'cline' && (
                <div className="space-y-3 rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">Cline provider</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {([
                        ['ollama', 'Ollama'],
                        ['lmstudio', 'LM Studio'],
                        ['deepseek', 'DeepSeek API'],
                        ['anthropic', 'Anthropic API'],
                        ['openai', 'OpenAI API'],
                        ['configured', 'Cline default'],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => onClineModeChange(value)}
                          disabled={
                            (value === 'ollama' && !localProviders.ollama?.available)
                            || (value === 'lmstudio' && !localProviders.lmstudio?.available)
                            || (value === 'deepseek' && !configuredApiKeys.deepseek)
                            || (value === 'anthropic' && !configuredApiKeys.anthropic)
                            || (value === 'openai' && !configuredApiKeys.openai)
                          }
                          className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
                            clineMode === value
                              ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                              : 'border-hawk-border-subtle bg-hawk-bg/45 text-hawk-text3'
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {agent === 'cline' && clineMode !== 'configured' && (
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">Model</label>
                      {clineMode === 'ollama' || clineMode === 'lmstudio' ? (
                        <select
                          value={clineModel}
                          onChange={(event) => onClineModelChange(event.target.value)}
                          className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text focus:border-hawk-orange/50 focus:outline-none"
                        >
                          {((clineMode === 'ollama' ? localProviders.ollama?.models : localProviders.lmstudio?.models) || []).map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                      ) : (
                        <select
                          value={clineModel}
                          onChange={(event) => onClineModelChange(event.target.value)}
                          className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text focus:border-hawk-orange/50 focus:outline-none"
                        >
                          {(clineMode === 'anthropic'
                            ? ['claude-sonnet-4-6', 'claude-opus-4-6']
                            : clineMode === 'deepseek'
                              ? ['deepseek-chat', 'deepseek-reasoner']
                              : ['gpt-4o-mini', 'gpt-4o']
                          ).map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <p className="text-xs text-hawk-text2">{describeClineMode(clineMode)}</p>
                  {clineMode === 'configured' && (
                    <div className="rounded-[12px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-2 text-xs text-hawk-text2">
                      `Cline default` does not use Hawkeye API keys. It hands the task to your local `cline` setup, including any Cline Credits, ChatGPT sign-in, or existing provider choice already configured on this machine.
                    </div>
                  )}
                  <p className="text-xs text-hawk-text2">
                    Hawkeye keeps the launch context lean for Cline so it can inspect the repo dynamically instead of exploding the prompt with a giant preloaded map.
                  </p>
                  {(clineMode === 'ollama' || clineMode === 'lmstudio') && (
                    <div className="rounded-[12px] border border-hawk-amber/25 bg-hawk-amber/8 px-3 py-2 text-xs text-hawk-text2">
                      Local Cline runs need a model with a roomy context window. If the model only exposes 4k context, Cline can fail before the first reply. Prefer 16k+ and ideally 32k+ context for repo work.
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={onOpenFilePicker}
                className="flex w-full items-center justify-center gap-2 rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-hawk-text3 transition-colors hover:text-hawk-text"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21" /></svg>
                Add screenshot
              </button>

              <div className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/55 p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">Dispatch note</div>
                <p className="mt-2 text-xs text-hawk-text2">
                  Use <span className="font-mono text-hawk-orange">Cmd+Enter</span> to submit quickly when your brief is ready.
                </p>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={!prompt.trim() || submitting}
            className="w-full rounded-[16px] border border-hawk-orange/30 bg-hawk-orange/10 px-4 py-3 font-mono text-sm font-semibold text-hawk-orange transition-colors hover:bg-hawk-orange/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Submitting...' : 'Submit task'}
          </button>
        </div>
      </div>
    </form>
  );
}

export function TaskFeed({
  loading,
  tasks,
  filteredTasks,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  pending,
  running,
  completed,
  failed,
  cancelled,
  clearableCount,
  onClearFinished,
  expandedId,
  onToggleExpanded,
  onCancelTask,
  onRetryTask,
  now,
}: {
  loading: boolean;
  tasks: TaskData[];
  filteredTasks: TaskData[];
  search: string;
  onSearchChange: (value: string) => void;
  filter: TaskFilter;
  onFilterChange: (filter: TaskFilter) => void;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  clearableCount: number;
  onClearFinished: () => void;
  expandedId: string | null;
  onToggleExpanded: (id: string) => void;
  onCancelTask: (id: string) => void;
  onRetryTask: (id: string) => void;
  now: number;
}) {
  return (
    <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-hawk-text">Task feed</h2>
            <p className="text-xs text-hawk-text2">
              Browse the queue, filter by status, and open a task to see its prompt, assets, and output.
            </p>
          </div>
          <div className="w-full lg:max-w-md">
            <input
              type="text"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search prompt, agent, output..."
              className="w-full rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2.5 font-mono text-xs text-hawk-text placeholder:text-hawk-text3 outline-none transition-colors focus:border-hawk-orange/40"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {([
              ['all', tasks.length],
              ['pending', pending],
              ['running', running],
              ['completed', completed],
              ['failed', failed],
              ['cancelled', cancelled],
            ] as Array<[TaskFilter, number]>).map(([key, count]) => (
              <FilterChip
                key={key}
                active={filter === key}
                label={key === 'all' ? 'All tasks' : key}
                count={count}
                onClick={() => onFilterChange(key)}
              />
            ))}
          </div>

          <button
            onClick={onClearFinished}
            disabled={clearableCount === 0}
            className="rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-hawk-text2 transition-colors hover:text-hawk-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear finished
          </button>
        </div>
      </div>

      <div className="p-3">
        {loading ? (
          <div className="py-20 text-center text-hawk-text3">Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="rounded-[18px] border border-dashed border-hawk-border-subtle py-12 text-center">
            <div className="text-3xl">📡</div>
            <h3 className="mt-3 font-display text-lg font-semibold text-hawk-text">No tasks yet</h3>
            <p className="mt-1 text-sm text-hawk-text3">
              Submit a prompt above or POST to <code className="font-mono text-hawk-orange">/api/tasks</code>
            </p>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="rounded-[18px] border border-dashed border-hawk-border-subtle py-12 text-center">
            <h3 className="font-display text-lg font-semibold text-hawk-text">No matching tasks</h3>
            <p className="mt-2 text-sm text-hawk-text3">Try another search or switch the status filter.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                now={now}
                expanded={expandedId === task.id}
                onToggle={() => onToggleExpanded(task.id)}
                onCancel={() => onCancelTask(task.id)}
                onRetry={() => onRetryTask(task.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MiniMetric({
  label,
  value,
  meta,
  tone = 'default',
}: {
  label: string;
  value: string;
  meta: string;
  tone?: 'default' | 'good' | 'warning' | 'danger' | 'running' | 'muted';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-hawk-green'
      : tone === 'warning'
        ? 'text-yellow-400'
        : tone === 'danger'
          ? 'text-red-400'
          : tone === 'running'
            ? 'text-blue-400'
            : tone === 'muted'
              ? 'text-hawk-text2'
              : 'text-hawk-text';

  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/50 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-[11px] text-hawk-text3">{meta}</div>
    </div>
  );
}

function InfoPill({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'accent' | 'good' | 'warning';
}) {
  const toneClass =
    tone === 'accent'
      ? 'border-hawk-orange/25 bg-hawk-orange/10 text-hawk-orange'
      : tone === 'good'
        ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green'
        : tone === 'warning'
          ? 'border-yellow-400/25 bg-yellow-400/10 text-yellow-400'
          : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text2';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${toneClass}`}>
      <span className="text-hawk-text3">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-all ${
        active
          ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
          : 'border-hawk-border-subtle bg-hawk-bg/45 text-hawk-text3 hover:border-hawk-orange/20 hover:text-hawk-text'
      }`}
    >
      <span>{label}</span>
      <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${active ? 'bg-hawk-orange/10 text-hawk-orange' : 'bg-hawk-surface2 text-hawk-text2'}`}>
        {count}
      </span>
    </button>
  );
}

function TaskRow({
  task,
  now,
  expanded,
  onToggle,
  onCancel,
  onRetry,
}: {
  task: TaskData;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const shellTone =
    task.status === 'running'
      ? 'border-blue-500/30 bg-blue-500/5'
      : task.status === 'failed'
        ? 'border-red-500/25 bg-red-500/5'
        : 'border-hawk-border-subtle bg-hawk-bg/35 hover:border-hawk-orange/20 hover:bg-hawk-bg/55';
  const durationLabel = formatTaskDuration(task, now);
  const failureHint = getTaskFailureSuggestion(task);
  const agentLabel = getTaskAgentLabel(task.agent);
  const showLivePlaceholder = task.status === 'running' && !(task.output || '').trim();

  return (
    <div className={`overflow-hidden rounded-[16px] border transition-all ${shellTone}`}>
      <div className="flex flex-col gap-3 px-3 py-2.5 lg:flex-row lg:items-start">
        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-hawk-border-subtle bg-hawk-bg/55">
              <span className={`text-base ${STATUS_COLORS[task.status]}`}>
                {STATUS_ICONS[task.status]}
              </span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <TaskStatusBadge status={task.status} />
                <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                  {agentLabel}
                </span>
                {task.exitCode !== undefined && (
                  <span className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${task.exitCode === 0 ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green' : 'border-red-500/25 bg-red-500/10 text-red-400'}`}>
                    exit {task.exitCode}
                  </span>
                )}
              </div>

              <p className="mt-1.5 text-sm leading-5 text-hawk-text">
                {task.prompt}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                <span>{task.id.slice(0, 8)}</span>
                <span>{timeAgo(task.createdAt, now)}</span>
                {task.startedAt && <span>started {timeAgo(task.startedAt, now)}</span>}
                {task.completedAt && <span>finished {timeAgo(task.completedAt, now)}</span>}
                {durationLabel && <span>{durationLabel} total</span>}
              </div>
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2 self-end lg:self-start">
          {(task.status === 'pending' || task.status === 'running') && (
            <button
              onClick={onCancel}
              className="rounded-[14px] border border-red-500/30 bg-red-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400 hover:bg-red-500/20"
            >
              Cancel
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={onRetry}
              className="rounded-[14px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-orange hover:bg-hawk-orange/20"
            >
              Retry
            </button>
          )}
          <button
            onClick={onToggle}
            aria-label={expanded ? 'Collapse task' : 'Expand task'}
            className="rounded-[12px] p-1.5 text-hawk-text3 transition-colors hover:bg-hawk-bg/55 hover:text-hawk-text"
          >
            {expanded ? '▾' : '▸'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="overflow-hidden border-t border-hawk-border-subtle px-3 py-2.5">
          <div className="grid items-start gap-2.5 xl:grid-cols-[minmax(18rem,0.92fr)_minmax(0,1.08fr)]">
            <div className="min-w-0 space-y-3">
              <div className="min-w-0 rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Full prompt</div>
                <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-xs text-hawk-text">
                  {task.prompt}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1.5 min-[1400px]:grid-cols-2">
                <MetaTile label="ID" value={task.id.slice(0, 8)} />
                <MetaTile label="Agent" value={agentLabel} />
                <MetaTile label="Created" value={formatTimestamp(task.createdAt)} />
                {task.startedAt && <MetaTile label="Started" value={formatTimestamp(task.startedAt)} />}
                {task.completedAt && <MetaTile label="Completed" value={formatTimestamp(task.completedAt)} />}
                {durationLabel && <MetaTile label="Duration" value={durationLabel} />}
              </div>

              {task.attachments && task.attachments.length > 0 && (
                <div className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Attachments</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {task.attachments.map((filename, index) => (
                      <a
                        key={index}
                        href={`/api/tasks/attachments/${filename}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block h-24 w-24 overflow-hidden rounded-[14px] border border-hawk-border-subtle transition-transform hover:scale-[1.02] sm:h-28 sm:w-28"
                      >
                        <img
                          src={`/api/tasks/attachments/${filename}`}
                          alt={filename}
                          className="h-full w-full object-cover"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              {(task.output || task.error) && (
                <div className="min-w-0 overflow-hidden rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
                  <div className={`font-mono text-[10px] uppercase tracking-[0.16em] ${task.error ? 'text-red-400' : task.status === 'running' ? 'text-blue-400' : 'text-hawk-green'}`}>
                    {task.error ? 'Error output' : task.status === 'running' ? 'Live output' : 'Agent output'}
                  </div>
                  {failureHint && task.error && (
                    <div className="mt-2 rounded-[12px] border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                      <span className="font-mono uppercase tracking-[0.12em] text-red-400">Suggested fix</span>
                      <p className="mt-1">{failureHint}</p>
                    </div>
                  )}
                  <pre className={`mt-2 max-h-[24rem] min-w-0 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all [overflow-wrap:anywhere] rounded-[12px] p-2.5 font-mono text-xs ${
                    task.error
                      ? 'border border-red-500/20 bg-red-500/5 text-red-300'
                      : task.status === 'running'
                        ? 'border border-blue-500/20 bg-blue-500/5 text-blue-200'
                        : 'bg-hawk-bg/70 text-hawk-text'
                  }`}>
                    {task.error || task.output}
                  </pre>
                </div>
              )}

              {showLivePlaceholder && (
                <div className="rounded-[16px] border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-300">
                  <span className="font-mono uppercase tracking-[0.14em]">Live execution</span>
                  <p className="mt-2">Waiting for the daemon to stream its first output chunk.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'completed'
      ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green'
      : status === 'running'
        ? 'border-blue-500/25 bg-blue-500/10 text-blue-400'
        : status === 'pending'
          ? 'border-yellow-400/25 bg-yellow-400/10 text-yellow-400'
          : status === 'failed'
            ? 'border-red-500/25 bg-red-500/10 text-red-400'
            : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text2';

  return (
    <span className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${tone}`}>
      {status}
    </span>
  );
}

function MetaTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">{label}</div>
      <div className="mt-1 break-words [overflow-wrap:anywhere] text-xs text-hawk-text">{value}</div>
    </div>
  );
}
