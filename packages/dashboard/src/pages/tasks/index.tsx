import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, hawkeyeWs, type DaemonStatusData, type TaskData } from '../../api';
import {
  buildClineAgentCommand,
  type ClineMode,
  describeDaemonStatus,
  isFinishedTask,
} from './runtime-utils';
import { JournalPanel, ReviewQueue, TaskComposer, TaskFeed, TaskHero } from './components';
import type { PendingReview, TaskFilter } from './types';

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('claude');
  const [claudeMode, setClaudeMode] = useState<'subscription' | 'api'>('subscription');
  const [claudeApiModel, setClaudeApiModel] = useState('claude-sonnet-4-6');
  const [clineMode, setClineMode] = useState<ClineMode>('configured');
  const [clineModel, setClineModel] = useState('');
  const [clineProviderModels, setClineProviderModels] = useState<Record<string, string[]>>({});
  const [configuredApiKeys, setConfiguredApiKeys] = useState<Record<string, string>>({});
  const [localProviders, setLocalProviders] = useState<Record<string, { available: boolean; models?: string[] }>>({});
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatusData | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<{ name: string; data: string; preview: string }>>([]);
  const [pendingReviews, setPendingReviews] = useState<PendingReview[]>([]);
  const [autoApprove, setAutoApprove] = useState(() => localStorage.getItem('hawkeye-auto-approve') === 'true');
  const [journal, setJournal] = useState<string | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'good' | 'danger'; message: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clineChoiceTouchedRef = useRef(false);

  const loadTasks = useCallback(() => {
    api.listTasks()
      .then((data) => {
        const sorted = data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setTasks(sorted);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loadDaemonStatus = useCallback(() => {
    api.getDaemonStatus().then(setDaemonStatus).catch(() => setDaemonStatus(null));
  }, []);

  const loadJournal = useCallback(() => {
    api.getTaskJournal().then(setJournal).catch(() => {});
  }, []);

  const handleClearJournal = async () => {
    await api.clearTaskJournal();
    setJournal('');
  };

  const loadReviews = useCallback(() => {
    api.getPendingReviews().then((reviews) => {
      setPendingReviews(reviews);
      if (autoApprove && reviews.length > 0) {
        reviews.forEach((review) => api.approveReview(review.id, 'session').catch(() => {}));
      }
    }).catch(() => {});
  }, [autoApprove]);

  useEffect(() => {
    api.getSettings().then((data) => {
      setConfiguredApiKeys(data.apiKeys || {});
    }).catch(() => {});

    api.getProviders().then((providers) => {
      setClineProviderModels(providers);
    }).catch(() => {});

    api.getLocalProviders().then((data) => {
      setLocalProviders(data);
    }).catch(() => {});
  }, []);

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
      return { mode: 'openai' as const, model: clineProviderModels.openai[1] || clineProviderModels.openai[0] || 'gpt-4o-mini' };
    }
    return { mode: 'configured' as const, model: '' };
  }, [clineProviderModels, configuredApiKeys, localProviders]);

  useEffect(() => {
    loadTasks();
    loadReviews();
    loadJournal();
    loadDaemonStatus();

    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type.startsWith('task_')) {
        loadTasks();
        if (showJournal && msg.type !== 'task_running') loadJournal();
      }
      if (msg.type === 'daemon_status') setDaemonStatus(msg.status);
      if (msg.type === 'review_approved' || msg.type === 'review_denied') loadReviews();
    });

    return () => {
      unsub();
    };
  }, [loadDaemonStatus, loadJournal, loadReviews, loadTasks, showJournal]);

  useEffect(() => {
    const refreshMs = tasks.some((task) => task.status === 'running') ? 1000 : 30000;
    const timer = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(timer);
  }, [tasks]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result as string;
        setAttachments((prev) => [...prev, { name: file.name, data, preview: data }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const atts = attachments.length > 0 ? attachments.map((attachment) => ({ name: attachment.name, data: attachment.data })) : undefined;
      const agentParam = (() => {
        if (agent === 'claude') {
          return claudeMode === 'api' ? `claude-api/${claudeApiModel}` : 'claude';
        }
        if (agent === 'cline') {
          return buildClineAgentCommand({
            mode: clineMode,
            model: clineModel,
          });
        }
        return agent;
      })();
      await api.createTask(prompt.trim(), agentParam, atts);
      setPrompt('');
      setAttachments([]);
      loadTasks();
    } catch (err) {
      console.error('Failed to create task:', err);
      setFeedback({
        tone: 'danger',
        message: 'Task submission failed. Check that the daemon and selected runtime are available.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    setFeedback(null);
    try {
      await api.cancelTask(id);
      loadTasks();
      setFeedback({ tone: 'good', message: 'Task cancelled.' });
    } catch (err) {
      console.error('Failed to cancel task:', err);
      setFeedback({
        tone: 'danger',
        message: 'Task cancellation failed. The daemon may no longer control that task.',
      });
    }
  };

  const handleRetry = async (id: string) => {
    setFeedback(null);
    try {
      await api.retryTask(id);
      loadTasks();
      setFeedback({ tone: 'good', message: 'Task queued again with the same prompt and runtime.' });
    } catch (err) {
      console.error('Failed to retry task:', err);
      setFeedback({ tone: 'danger', message: 'Task retry failed.' });
    }
  };

  const handleClearFinished = async () => {
    setFeedback(null);
    try {
      const result = await api.clearFinishedTasks();
      loadTasks();
      setExpandedId((current) => {
        if (!current) return current;
        const expandedTask = tasks.find((task) => task.id === current);
        return expandedTask && isFinishedTask(expandedTask.status) ? null : current;
      });
      setFeedback({
        tone: 'good',
        message: result.removed > 0
          ? `Cleared ${result.removed} finished task${result.removed > 1 ? 's' : ''}.`
          : 'No finished tasks to clear.',
      });
    } catch (err) {
      console.error('Failed to clear finished tasks:', err);
      setFeedback({ tone: 'danger', message: 'Clearing finished tasks failed.' });
    }
  };

  const toggleAutoApprove = () => {
    const next = !autoApprove;
    setAutoApprove(next);
    localStorage.setItem('hawkeye-auto-approve', String(next));
    if (next) {
      pendingReviews.forEach((review) => api.approveReview(review.id, 'session').catch(() => {}));
    }
  };

  const handleApprove = async (id: string) => {
    await api.approveReview(id, 'session');
    loadReviews();
  };

  const handleDeny = async (id: string) => {
    await api.denyReview(id);
    loadReviews();
  };

  const pending = tasks.filter((task) => task.status === 'pending').length;
  const running = tasks.filter((task) => task.status === 'running').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const cancelled = tasks.filter((task) => task.status === 'cancelled').length;
  const clearableCount = tasks.filter((task) => isFinishedTask(task.status)).length;
  const daemonSummary = useMemo(() => describeDaemonStatus(daemonStatus), [daemonStatus]);
  const activeTask = useMemo(
    () => tasks.find((task) => task.status === 'running')
      || tasks.find((task) => task.status === 'pending')
      || tasks[0]
      || null,
    [tasks],
  );
  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();

    return tasks.filter((task) => {
      const matchesFilter = filter === 'all' ? true : task.status === filter;
      if (!matchesFilter) return false;
      if (!query) return true;

      const searchable = [
        task.prompt,
        task.agent,
        task.status,
        task.id,
        task.output || '',
        task.error || '',
      ].join(' ').toLowerCase();

      return searchable.includes(query);
    });
  }, [tasks, filter, search]);

  const handleAgentChange = (value: string) => {
    setAgent(value);
    if (value === 'claude') {
      setClaudeMode('subscription');
    }
    if (
      value === 'cline'
      && agent !== 'cline'
      && !clineChoiceTouchedRef.current
      && clineMode === 'configured'
      && !clineModel
    ) {
      setClineMode(preferredCline.mode);
      setClineModel(preferredCline.model);
    }
  };

  const handleClineModeChange = (value: ClineMode) => {
    clineChoiceTouchedRef.current = true;
    setClineMode(value);
    if (value === 'ollama') setClineModel(localProviders.ollama?.models?.[0] || '');
    if (value === 'lmstudio') setClineModel(localProviders.lmstudio?.models?.[0] || '');
    if (value === 'deepseek') setClineModel(clineProviderModels.deepseek?.[0] || 'deepseek-chat');
    if (value === 'anthropic') setClineModel(clineProviderModels.anthropic?.[0] || 'claude-sonnet-4-6');
    if (value === 'openai') setClineModel(clineProviderModels.openai?.[1] || clineProviderModels.openai?.[0] || 'gpt-4o-mini');
    if (value === 'configured') setClineModel('');
  };

  return (
    <div className="space-y-5">
      <TaskHero
        running={running}
        tasksCount={tasks.length}
        pendingReviewsCount={pendingReviews.length}
        daemonSummary={daemonSummary}
        feedback={feedback}
        activeTask={activeTask}
        now={now}
        showJournal={showJournal}
        onToggleJournal={() => {
          setShowJournal(!showJournal);
          if (!showJournal) loadJournal();
        }}
        pending={pending}
        completed={completed}
        failed={failed}
        autoApprove={autoApprove}
        onToggleAutoApprove={toggleAutoApprove}
      />

      {showJournal && (
        <JournalPanel journal={journal} onClearJournal={handleClearJournal} />
      )}

      <section className="grid gap-3.5 xl:grid-cols-[0.84fr_1.16fr]">
        <ReviewQueue
          pendingReviews={pendingReviews}
          autoApprove={autoApprove}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />

        <TaskComposer
          onSubmit={handleSubmit}
          prompt={prompt}
          onPromptChange={setPrompt}
          onPromptKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              handleSubmit(event as unknown as React.FormEvent);
            }
          }}
          agent={agent}
          onAgentChange={handleAgentChange}
          claudeMode={claudeMode}
          onClaudeModeChange={setClaudeMode}
          claudeApiModel={claudeApiModel}
          onClaudeApiModelChange={setClaudeApiModel}
          clineMode={clineMode}
          onClineModeChange={handleClineModeChange}
          clineModel={clineModel}
          onClineModelChange={setClineModel}
          clineProviderModels={clineProviderModels}
          configuredApiKeys={configuredApiKeys}
          localProviders={localProviders}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          fileInputRef={fileInputRef}
          onFileSelect={handleFileSelect}
          onOpenFilePicker={() => fileInputRef.current?.click()}
          submitting={submitting}
        />
      </section>

      <TaskFeed
        loading={loading}
        tasks={tasks}
        filteredTasks={filteredTasks}
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        pending={pending}
        running={running}
        completed={completed}
        failed={failed}
        cancelled={cancelled}
        clearableCount={clearableCount}
        onClearFinished={handleClearFinished}
        expandedId={expandedId}
        onToggleExpanded={(id) => setExpandedId(expandedId === id ? null : id)}
        onCancelTask={handleCancel}
        onRetryTask={handleRetry}
        now={now}
      />
    </div>
  );
}
