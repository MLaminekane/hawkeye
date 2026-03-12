import { useEffect, useState, useRef, useCallback } from 'react';
import { api, hawkeyeWs, type TaskData } from '../api';

interface PendingReview {
  id: string;
  timestamp: string;
  sessionId: string;
  command: string;
  matchedPattern: string;
}

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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Module-level cache
let cachedTasks: TaskData[] | null = null;

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskData[]>(cachedTasks || []);
  const [loading, setLoading] = useState(cachedTasks === null);
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('claude');
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Array<{ name: string; data: string; preview: string }>>([]);
  const [pendingReviews, setPendingReviews] = useState<PendingReview[]>([]);
  const [autoApprove, setAutoApprove] = useState(() => localStorage.getItem('hawkeye-auto-approve') === 'true');
  const [journal, setJournal] = useState<string | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadTasks = () => {
    api.listTasks()
      .then((data) => {
        const sorted = data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        cachedTasks = sorted;
        setTasks(sorted);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const loadJournal = () => {
    api.getTaskJournal().then(setJournal).catch(() => {});
  };

  const handleClearJournal = async () => {
    await api.clearTaskJournal();
    setJournal('');
  };

  const loadReviews = useCallback(() => {
    api.getPendingReviews().then((reviews) => {
      setPendingReviews(reviews);
      // Auto-approve all if toggle is on
      if (autoApprove && reviews.length > 0) {
        reviews.forEach((r) => api.approveReview(r.id, 'session').catch(() => {}));
      }
    }).catch(() => {});
  }, [autoApprove]);

  useEffect(() => {
    loadTasks();
    loadReviews();
    loadJournal();
    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type.startsWith('task_')) { loadTasks(); loadJournal(); }
      if (msg.type === 'review_approved' || msg.type === 'review_denied') loadReviews();
    });
    // Poll every 3s for daemon updates + reviews
    const poll = setInterval(() => { loadTasks(); loadReviews(); }, 3000);
    return () => { unsub(); clearInterval(poll); };
  }, [loadReviews]);

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
    e.target.value = ''; // Reset input
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    try {
      const atts = attachments.length > 0 ? attachments.map(a => ({ name: a.name, data: a.data })) : undefined;
      await api.createTask(prompt.trim(), agent, atts);
      setPrompt('');
      setAttachments([]);
      loadTasks();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.cancelTask(id);
      loadTasks();
    } catch (err) {
      console.error('Failed to cancel task:', err);
    }
  };

  const toggleAutoApprove = () => {
    const next = !autoApprove;
    setAutoApprove(next);
    localStorage.setItem('hawkeye-auto-approve', String(next));
    // If turning on, immediately approve all pending reviews
    if (next) {
      pendingReviews.forEach((r) => api.approveReview(r.id, 'session').catch(() => {}));
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

  const pending = tasks.filter((t) => t.status === 'pending').length;
  const running = tasks.filter((t) => t.status === 'running').length;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-xl font-bold text-hawk-text sm:text-2xl">Remote Tasks</h1>
          <p className="mt-1 text-xs text-hawk-text3 sm:text-sm">
            Submit prompts remotely. Run <code className="rounded bg-hawk-surface2 px-1.5 py-0.5 font-mono text-[10px] text-hawk-orange sm:text-xs">hawkeye daemon</code> to execute.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono sm:text-xs">
          {pending > 0 && <span className="rounded-lg bg-hawk-surface px-2.5 py-1 text-yellow-400">{pending} pending</span>}
          {running > 0 && <span className="rounded-lg bg-hawk-surface px-2.5 py-1 text-blue-400">{running} running</span>}
          <span className="rounded-lg bg-hawk-surface px-2.5 py-1 text-hawk-green">{completed} done</span>
          {failed > 0 && <span className="rounded-lg bg-hawk-surface px-2.5 py-1 text-red-400">{failed} failed</span>}
          <button
            onClick={() => { setShowJournal(!showJournal); if (!showJournal) loadJournal(); }}
            className={`rounded-lg px-2.5 py-1 transition-colors ${showJournal ? 'bg-hawk-orange/20 text-hawk-orange' : 'bg-hawk-surface text-hawk-text3 hover:text-hawk-text'}`}
          >
            Memory
          </button>
        </div>
      </div>

      {/* Journal / Agent Memory */}
      {showJournal && (
        <div className="rounded-xl border border-hawk-border-subtle bg-hawk-surface/30 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-hawk-text">Agent Memory</h3>
            <button
              onClick={handleClearJournal}
              className="rounded-md px-2 py-1 text-[10px] text-hawk-text3 transition-colors hover:bg-red-500/20 hover:text-red-400"
            >
              Clear memory
            </button>
          </div>
          {journal ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-hawk-bg p-3 font-mono text-xs text-hawk-text2">
              {journal}
            </pre>
          ) : (
            <p className="text-xs text-hawk-text3">No memory yet. Tasks will be logged here after execution.</p>
          )}
        </div>
      )}

      {/* Auto-approve toggle + Pending reviews */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-hawk-border-subtle bg-hawk-surface/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleAutoApprove}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${autoApprove ? 'bg-hawk-orange' : 'bg-hawk-surface3'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${autoApprove ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <div>
            <span className="text-sm font-medium text-hawk-text">Auto-approve actions</span>
            <p className="text-[10px] text-hawk-text3">
              {autoApprove ? 'All agent actions approved automatically' : 'Dangerous actions need your approval'}
            </p>
          </div>
        </div>
        {pendingReviews.length > 0 && !autoApprove && (
          <span className="rounded-lg bg-hawk-amber/20 px-2.5 py-1 font-mono text-xs text-hawk-amber animate-pulse">
            {pendingReviews.length} awaiting approval
          </span>
        )}
      </div>

      {/* Pending review actions */}
      {pendingReviews.length > 0 && !autoApprove && (
        <div className="space-y-2">
          {pendingReviews.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 rounded-xl border border-hawk-amber/30 bg-hawk-amber/5 p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-4">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs text-hawk-text">{r.command}</p>
                <p className="mt-0.5 text-[10px] text-hawk-text3">
                  Pattern: <span className="text-hawk-amber">{r.matchedPattern}</span>
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => handleApprove(r.id)}
                  className="rounded-lg bg-hawk-green/20 px-4 py-2 text-xs font-bold text-hawk-green transition-colors hover:bg-hawk-green/30"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleDeny(r.id)}
                  className="rounded-lg bg-hawk-red/20 px-4 py-2 text-xs font-bold text-hawk-red transition-colors hover:bg-hawk-red/30"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Submit form */}
      <form onSubmit={handleSubmit} className="rounded-xl border border-hawk-border-subtle bg-hawk-surface/50 p-4 sm:p-5">
        <label className="mb-2 block text-sm font-medium text-hawk-text2">New Prompt</label>
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what the agent should do..."
          rows={3}
          className="w-full resize-none rounded-lg border border-hawk-border-subtle bg-hawk-bg px-3 py-2.5 font-mono text-sm text-hawk-text placeholder:text-hawk-text3/50 focus:border-hawk-orange/50 focus:outline-none focus:ring-1 focus:ring-hawk-orange/30 sm:px-4 sm:py-3"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              handleSubmit(e);
            }
          }}
        />
        {/* Image attachments */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {attachments.map((att, i) => (
              <div key={i} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-hawk-border-subtle sm:h-20 sm:w-20">
                <img src={att.preview} alt={att.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 rounded-md border border-hawk-border-subtle px-2 py-1 text-xs text-hawk-text3 transition-colors hover:bg-hawk-surface2 hover:text-hawk-text"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <span className="hidden sm:inline">Photo</span>
            </button>
            <label className="text-xs text-hawk-text3">Agent:</label>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="rounded-md border border-hawk-border-subtle bg-hawk-bg px-2 py-1 font-mono text-xs text-hawk-text focus:border-hawk-orange/50 focus:outline-none"
            >
              <option value="claude">claude</option>
              <option value="aider">aider</option>
              <option value="codex">codex</option>
            </select>
            <span className="hidden text-[10px] text-hawk-text3/60 sm:inline">Cmd+Enter to submit</span>
          </div>
          <button
            type="submit"
            disabled={!prompt.trim() || submitting}
            className="w-full rounded-lg bg-hawk-orange px-5 py-2.5 text-sm font-semibold text-black transition-all hover:bg-hawk-orange/90 disabled:opacity-40 disabled:cursor-not-allowed sm:w-auto sm:py-2"
          >
            {submitting ? 'Submitting...' : 'Submit Task'}
          </button>
        </div>
      </form>

      {/* Task list */}
      {loading ? (
        <div className="py-20 text-center text-hawk-text3">Loading tasks...</div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hawk-border-subtle py-12 text-center sm:py-16">
          <div className="text-3xl">📡</div>
          <h3 className="mt-3 font-display text-lg font-semibold text-hawk-text">No tasks yet</h3>
          <p className="mt-1 text-sm text-hawk-text3">
            Submit a prompt above or POST to <code className="font-mono text-hawk-orange">/api/tasks</code>
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`group rounded-xl border transition-colors ${
                task.status === 'running'
                  ? 'border-blue-500/30 bg-blue-500/5'
                  : 'border-hawk-border-subtle bg-hawk-surface/40 hover:bg-hawk-surface/70'
              }`}
            >
              <div
                className="flex cursor-pointer items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-4"
                onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
              >
                {/* Status icon */}
                <span className={`text-base sm:text-lg ${STATUS_COLORS[task.status]}`}>
                  {STATUS_ICONS[task.status]}
                </span>

                {/* Prompt preview */}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-hawk-text sm:text-sm">
                    {task.prompt}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-hawk-text3 sm:gap-3 sm:text-[11px]">
                    <span>{timeAgo(task.createdAt)}</span>
                    <span className="text-hawk-border-subtle">|</span>
                    <span>{task.agent}</span>
                    {task.exitCode !== undefined && (
                      <>
                        <span className="text-hawk-border-subtle">|</span>
                        <span className={task.exitCode === 0 ? 'text-hawk-green' : 'text-red-400'}>
                          exit {task.exitCode}
                        </span>
                      </>
                    )}
                    {task.status === 'running' && task.startedAt && (
                      <>
                        <span className="text-hawk-border-subtle">|</span>
                        <span className="text-blue-400">running for {timeAgo(task.startedAt).replace(' ago', '')}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Status badge - hidden on very small screens */}
                <span className={`hidden rounded-md bg-hawk-bg px-2.5 py-1 font-mono text-xs sm:inline ${STATUS_COLORS[task.status]}`}>
                  {task.status}
                </span>

                {/* Cancel button for pending tasks */}
                {task.status === 'pending' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCancel(task.id); }}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-hawk-text3 transition-colors hover:bg-red-500/20 hover:text-red-400"
                  >
                    Cancel
                  </button>
                )}

                {/* Expand chevron */}
                <svg
                  className={`h-4 w-4 shrink-0 text-hawk-text3 transition-transform ${expandedId === task.id ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              {/* Expanded detail */}
              {expandedId === task.id && (
                <div className="border-t border-hawk-border-subtle px-4 py-4 sm:px-5">
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-hawk-text3">Full Prompt</label>
                      <p className="mt-1 whitespace-pre-wrap rounded-lg bg-hawk-bg p-3 font-mono text-xs text-hawk-text">
                        {task.prompt}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 sm:gap-4">
                      <div>
                        <span className="text-hawk-text3">ID</span>
                        <p className="mt-0.5 font-mono text-hawk-text">{task.id.slice(0, 8)}</p>
                      </div>
                      <div>
                        <span className="text-hawk-text3">Created</span>
                        <p className="mt-0.5 text-hawk-text">{new Date(task.createdAt).toLocaleString()}</p>
                      </div>
                      {task.startedAt && (
                        <div>
                          <span className="text-hawk-text3">Started</span>
                          <p className="mt-0.5 text-hawk-text">{new Date(task.startedAt).toLocaleString()}</p>
                        </div>
                      )}
                      {task.completedAt && (
                        <div>
                          <span className="text-hawk-text3">Completed</span>
                          <p className="mt-0.5 text-hawk-text">{new Date(task.completedAt).toLocaleString()}</p>
                        </div>
                      )}
                    </div>
                    {/* Display task attachments */}
                    {(task as any).attachments && (task as any).attachments.length > 0 && (
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-hawk-text3">Attachments</label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {((task as any).attachments as string[]).map((filename: string, i: number) => (
                            <a
                              key={i}
                              href={`/api/tasks/attachments/${filename}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block h-24 w-24 overflow-hidden rounded-lg border border-hawk-border-subtle transition-transform hover:scale-105 sm:h-32 sm:w-32"
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
                    {(task.output || task.error) && (
                      <div>
                        <label className={`text-[10px] uppercase tracking-wider ${task.error ? 'text-red-400' : 'text-hawk-green'}`}>
                          {task.error ? 'Error Output' : 'Agent Output'}
                        </label>
                        <pre className={`mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs ${
                          task.error
                            ? 'border border-red-500/20 bg-red-500/5 text-red-300'
                            : 'bg-hawk-bg text-hawk-text'
                        }`}>
                          {task.error || task.output}
                        </pre>
                      </div>
                    )}
                    {task.status === 'running' && (
                      <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-300">
                        <span className="animate-pulse">●</span>
                        Task is running... Output will appear when complete.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
