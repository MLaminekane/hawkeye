import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, hawkeyeWs, type GlobalStatsData, type SessionData } from '../../api';

type SortKey = 'date' | 'actions' | 'cost' | 'drift';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'recording' | 'paused' | 'completed' | 'aborted';

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'recording', label: 'Live' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
  { id: 'aborted', label: 'Aborted' },
];

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'date', label: 'Latest' },
  { key: 'actions', label: 'Actions' },
  { key: 'cost', label: 'Cost' },
  { key: 'drift', label: 'Drift' },
];

const INITIAL_LIMIT = 200;
const LIMIT_STEP = 100;
const WS_REFRESH_DELAY_MS = 750;

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [stats, setStats] = useState<GlobalStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [driftMin, setDriftMin] = useState('');
  const [driftMax, setDriftMax] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(INITIAL_LIMIT);
  const [liveNow, setLiveNow] = useState(Date.now());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const refreshTimeoutRef = useRef<number | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'refresh') => {
      if (mode === 'initial') {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const [sessionData, statsData] = await Promise.all([
          api.listSessions(sessionLimit),
          api.getStats(),
        ]);
        setSessions(sessionData);
        setStats(statsData);
      } catch {
        if (mode === 'initial') {
          setFeedback({ tone: 'error', message: 'Unable to load sessions right now' });
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [sessionLimit],
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current !== null) return;
    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null;
      void load('refresh');
    }, WS_REFRESH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  useEffect(() => {
    const unsubscribe = hawkeyeWs.subscribe((message) => {
      if (
        message.type === 'event' ||
        message.type === 'drift_update' ||
        message.type === 'session_end' ||
        message.type === 'session_pause' ||
        message.type === 'session_resume'
      ) {
        scheduleRefresh();
      }
    });

    return () => {
      unsubscribe();
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, [scheduleRefresh]);

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  useEffect(() => {
    const hasLiveSessions = sessions.some((session) => session.status === 'recording');
    if (!hasLiveSessions) return;

    const interval = window.setInterval(() => setLiveNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [sessions]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir('desc');
  };

  const statusCounts = useMemo(() => {
    return sessions.reduce<Record<StatusFilter, number>>(
      (acc, session) => {
        if (
          session.status === 'recording' ||
          session.status === 'paused' ||
          session.status === 'completed' ||
          session.status === 'aborted'
        ) {
          acc[session.status] += 1;
        }
        acc.all += 1;
        return acc;
      },
      { all: 0, recording: 0, paused: 0, completed: 0, aborted: 0 },
    );
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    let result = sessions;

    if (statusFilter !== 'all') {
      result = result.filter((session) => session.status === statusFilter);
    }

    if (deferredSearch) {
      result = result.filter((session) => {
        const haystack = [
          session.objective,
          session.agent || '',
          session.developer || '',
          session.model || '',
          session.working_dir || '',
          session.git_branch || '',
          session.id,
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(deferredSearch);
      });
    }

    if (dateFrom) {
      const from = new Date(dateFrom).getTime();
      result = result.filter((session) => new Date(session.started_at).getTime() >= from);
    }

    if (dateTo) {
      const to = new Date(dateTo).getTime() + 86400000;
      result = result.filter((session) => new Date(session.started_at).getTime() <= to);
    }

    if (driftMin) {
      const min = parseFloat(driftMin);
      result = result.filter(
        (session) => session.final_drift_score != null && session.final_drift_score >= min,
      );
    }

    if (driftMax) {
      const max = parseFloat(driftMax);
      result = result.filter(
        (session) => session.final_drift_score != null && session.final_drift_score <= max,
      );
    }

    return [...result].sort((left, right) => {
      let comparison = 0;

      switch (sortKey) {
        case 'date':
          comparison = new Date(left.started_at).getTime() - new Date(right.started_at).getTime();
          break;
        case 'actions':
          comparison = left.total_actions - right.total_actions;
          break;
        case 'cost':
          comparison = left.total_cost_usd - right.total_cost_usd;
          break;
        case 'drift':
          comparison = (left.final_drift_score ?? -1) - (right.final_drift_score ?? -1);
          break;
      }

      return sortDir === 'asc' ? comparison : -comparison;
    });
  }, [sessions, statusFilter, deferredSearch, dateFrom, dateTo, driftMin, driftMax, sortKey, sortDir]);

  const activeFilterCount = [
    statusFilter !== 'all',
    Boolean(deferredSearch),
    Boolean(dateFrom),
    Boolean(dateTo),
    Boolean(driftMin),
    Boolean(driftMax),
  ].filter(Boolean).length;

  const overview = useMemo(() => {
    const totalSessions = stats?.total_sessions ?? sessions.length;
    const activeSessions =
      stats?.active_sessions ??
      sessions.filter((session) => session.status === 'recording' || session.status === 'paused').length;
    const totalCost =
      stats?.total_cost_usd ?? sessions.reduce((sum, session) => sum + session.total_cost_usd, 0);
    const averageDrift = (() => {
      if (stats?.avg_drift_score != null) return stats.avg_drift_score;
      const driftSessions = sessions.filter((session) => session.final_drift_score !== null);
      if (driftSessions.length === 0) return 0;
      return (
        driftSessions.reduce((sum, session) => sum + (session.final_drift_score || 0), 0) /
        driftSessions.length
      );
    })();

    return {
      totalSessions,
      activeSessions,
      totalCost,
      averageDrift,
    };
  }, [sessions, stats]);

  const latestSession = useMemo(
    () =>
      [...sessions].sort(
        (left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime(),
      )[0] || null,
    [sessions],
  );

  const riskiestSession = useMemo(
    () =>
      sessions
        .filter((session) => session.final_drift_score !== null)
        .sort(
          (left, right) =>
            (left.final_drift_score ?? Infinity) - (right.final_drift_score ?? Infinity),
        )[0] || null,
    [sessions],
  );

  const priciestSession = useMemo(
    () => [...sessions].sort((left, right) => right.total_cost_usd - left.total_cost_usd)[0] || null,
    [sessions],
  );

  const loadedTotal = sessions.length;
  const availableTotal = stats?.total_sessions ?? loadedTotal;
  const canLoadMore = loadedTotal < availableTotal;

  const clearAdvancedFilters = () => {
    setDateFrom('');
    setDateTo('');
    setDriftMin('');
    setDriftMax('');
  };

  const clearAllFilters = () => {
    setStatusFilter('all');
    setSearch('');
    clearAdvancedFilters();
  };

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (deletingId) return;
      if (!window.confirm(`Delete session ${sessionId.slice(0, 8)}? This removes its events and derived data.`)) {
        return;
      }

      setDeletingId(sessionId);
      try {
        await api.deleteSession(sessionId);
        setSessions((previous) => previous.filter((session) => session.id !== sessionId));
        setFeedback({ tone: 'success', message: 'Session deleted' });
        await load('refresh');
      } catch {
        setFeedback({ tone: 'error', message: 'Delete failed' });
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, load],
  );

  if (loading) {
    return (
      <div className="rounded-[24px] border border-hawk-border-subtle bg-hawk-surface/55 px-6 py-20 text-center font-mono text-sm text-hawk-text3">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="rounded-[28px] border border-dashed border-hawk-border-subtle bg-hawk-surface/55 px-6 py-20 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[20px] border border-hawk-border-subtle bg-hawk-bg/60 font-display text-2xl text-hawk-orange">
          H
        </div>
        <h2 className="mt-4 font-display text-2xl font-semibold text-hawk-text">No sessions yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-hawk-text2">
          Start recording an AI agent session and this page will turn into your timeline, scoreboard, and investigation surface.
        </p>
        <code className="mt-6 inline-flex rounded-2xl border border-hawk-border-subtle bg-hawk-bg/70 px-4 py-3 font-mono text-sm text-hawk-orange">
          hawkeye record -o "your objective" -- agent-command
        </code>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/70 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-16 top-0 h-56 w-56 rounded-full bg-hawk-orange/8 blur-3xl" />
          <div className="absolute right-[-60px] top-12 h-64 w-64 rounded-full bg-emerald-400/6 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              <span className={`inline-block h-2 w-2 rounded-full ${overview.activeSessions > 0 ? 'bg-hawk-orange' : 'bg-hawk-text3'}`} />
              Session Observatory
            </div>

            <div className="max-w-2xl">
              <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
                Review recent runs, jump into the right session fast, and keep the list clean.
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-hawk-text2">
                Live updates are throttled, running durations stay fresh, and older sessions can be removed directly from the board.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <OverviewCard label="Sessions" value={String(overview.totalSessions)} hint={`${loadedTotal} loaded`} toneClass="text-hawk-orange" />
              <OverviewCard label="Live now" value={String(overview.activeSessions)} hint="Recording or paused" />
              <OverviewCard label="Total cost" value={formatMoney(overview.totalCost)} hint="Across all tracked runs" toneClass="text-amber-400" />
              <OverviewCard label="Avg drift" value={`${Math.round(overview.averageDrift)}/100`} hint={getDriftLabel(overview.averageDrift)} toneClass={getDriftTextClass(overview.averageDrift)} />
            </div>
          </div>

          <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                Quick Signals
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                {refreshing ? 'Refreshing…' : 'Stable'}
              </div>
            </div>

            <div className="mt-3 space-y-2.5">
              <InsightCard
                title="Latest movement"
                headline={latestSession ? latestSession.objective : 'No recent session'}
                detail={
                  latestSession
                    ? `${formatRelativeDate(latestSession.started_at, liveNow)} · ${latestSession.agent || 'unknown agent'}`
                    : 'Waiting for the next run'
                }
                session={latestSession}
              />
              <InsightCard
                title="Most expensive run"
                headline={priciestSession ? formatMoney(priciestSession.total_cost_usd) : formatMoney(0)}
                detail={priciestSession ? priciestSession.objective : 'No spend recorded yet'}
                toneClass="text-amber-400"
                session={priciestSession}
              />
              <InsightCard
                title="Lowest drift score"
                headline={
                  riskiestSession && riskiestSession.final_drift_score !== null
                    ? `${riskiestSession.final_drift_score}/100`
                    : 'No drift signal'
                }
                detail={
                  riskiestSession ? riskiestSession.objective : 'Need at least one scored session'
                }
                toneClass={
                  riskiestSession && riskiestSession.final_drift_score !== null
                    ? getDriftTextClass(riskiestSession.final_drift_score)
                    : 'text-hawk-text'
                }
                session={riskiestSession}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/60 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="relative min-w-[260px] flex-1 xl:max-w-xl">
              <input
                type="text"
                placeholder="Search objective, agent, model, branch, or session id"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
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

            <div className="flex flex-wrap items-center gap-2">
              {STATUS_OPTIONS.map((option) => {
                const isSelected = statusFilter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setStatusFilter(option.id)}
                    className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                      isSelected
                        ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                        : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                    }`}
                  >
                    {option.label} <span className="ml-1 text-hawk-text2">{statusCounts[option.id]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap gap-2">
              {SORT_OPTIONS.map((option) => {
                const isSelected = sortKey === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => toggleSort(option.key)}
                    className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                      isSelected
                        ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                        : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                    }`}
                  >
                    {option.label}
                    {isSelected ? ` ${sortDir === 'desc' ? 'v' : '^'}` : ''}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowFilters((current) => !current)}
                className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                  showFilters
                    ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                    : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                }`}
              >
                Advanced filters
              </button>

              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors hover:border-hawk-border hover:text-hawk-text"
                >
                  Reset all
                </button>
              )}
            </div>
          </div>

          {showFilters && (
            <div className="grid gap-2.5 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3 md:grid-cols-2 xl:grid-cols-4">
              <FilterField label="From">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                  className="w-full rounded-2xl border border-hawk-border-subtle bg-hawk-surface/55 px-3 py-2 text-sm text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </FilterField>
              <FilterField label="To">
                <input
                  type="date"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                  className="w-full rounded-2xl border border-hawk-border-subtle bg-hawk-surface/55 px-3 py-2 text-sm text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </FilterField>
              <FilterField label="Drift Min">
                <input
                  type="number"
                  min="0"
                  max="100"
                  placeholder="0"
                  value={driftMin}
                  onChange={(event) => setDriftMin(event.target.value)}
                  className="w-full rounded-2xl border border-hawk-border-subtle bg-hawk-surface/55 px-3 py-2 text-sm text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </FilterField>
              <FilterField label="Drift Max">
                <input
                  type="number"
                  min="0"
                  max="100"
                  placeholder="100"
                  value={driftMax}
                  onChange={(event) => setDriftMax(event.target.value)}
                  className="w-full rounded-2xl border border-hawk-border-subtle bg-hawk-surface/55 px-3 py-2 text-sm text-hawk-text outline-none focus:border-hawk-orange/50"
                />
              </FilterField>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 text-sm text-hawk-text2">
            <span>
              Showing <span className="font-semibold text-hawk-text">{filteredSessions.length}</span> of{' '}
              <span className="font-semibold text-hawk-text">{loadedTotal}</span> loaded sessions
            </span>
            <span className="hidden h-1 w-1 rounded-full bg-hawk-border sm:inline-block" />
            <span>
              {loadedTotal} / {availableTotal} fetched
            </span>
            {activeFilterCount > 0 && (
              <>
                <span className="hidden h-1 w-1 rounded-full bg-hawk-border sm:inline-block" />
                <span>{activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active</span>
              </>
            )}
            {refreshing && (
              <>
                <span className="hidden h-1 w-1 rounded-full bg-hawk-border sm:inline-block" />
                <span>Refreshing…</span>
              </>
            )}
          </div>

          {feedback && (
            <div className={`rounded-[14px] border px-3 py-2 font-mono text-[11px] ${
              feedback.tone === 'error'
                ? 'border-red-400/20 bg-red-400/8 text-red-400'
                : 'border-hawk-green/20 bg-hawk-green/8 text-hawk-green'
            }`}>
              {feedback.message}
            </div>
          )}
        </div>
      </section>

      {filteredSessions.length === 0 ? (
        <div className="rounded-[24px] border border-hawk-border-subtle bg-hawk-surface/55 px-6 py-16 text-center">
          <h2 className="font-display text-2xl font-semibold text-hawk-text">No sessions match the current view</h2>
          <p className="mt-2 text-sm leading-6 text-hawk-text2">
            Try a broader search, reset the filters, or switch back to the latest sort to widen the list again.
          </p>
          <button
            type="button"
            onClick={clearAllFilters}
            className="mt-5 rounded-2xl bg-hawk-orange px-4 py-3 text-sm font-semibold text-white transition-all hover:brightness-105"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <div className="space-y-3.5">
          <div className="grid gap-3.5 xl:grid-cols-2">
            {filteredSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                now={liveNow}
                deleting={deletingId === session.id}
                onDelete={() => void handleDelete(session.id)}
              />
            ))}
          </div>

          {canLoadMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setSessionLimit((current) => current + LIMIT_STEP)}
                className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/55 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-text2 transition-colors hover:border-hawk-orange/30 hover:text-hawk-orange"
              >
                Load more sessions
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewCard({
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
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/55 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-display text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-hawk-text2">{hint}</div>
    </div>
  );
}

function InsightCard({
  title,
  headline,
  detail,
  session,
  toneClass = 'text-hawk-text',
}: {
  title: string;
  headline: string;
  detail: string;
  session: SessionData | null;
  toneClass?: string;
}) {
  const body = (
    <>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">{title}</div>
      <div className={`mt-1 text-sm font-semibold ${toneClass}`}>{headline}</div>
      <div className="mt-1 text-xs leading-5 text-hawk-text2">{detail}</div>
    </>
  );

  if (!session) {
    return <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/55 p-3">{body}</div>;
  }

  return (
    <Link
      to={`/session/${session.id}`}
      className="block rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/55 p-3 transition-colors hover:border-hawk-orange/20 hover:text-hawk-text"
    >
      {body}
    </Link>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="space-y-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">{label}</span>
      {children}
    </label>
  );
}

function SessionCard({
  session,
  now,
  deleting,
  onDelete,
}: {
  session: SessionData;
  now: number;
  deleting: boolean;
  onDelete: () => void;
}) {
  const statusTone = getStatusTone(session.status);
  const driftScore = session.final_drift_score;
  const driftTone = getDriftTone(driftScore);

  return (
    <article
      className={`group overflow-hidden rounded-[20px] border bg-hawk-surface/75 shadow-[0_20px_48px_-38px_rgba(0,0,0,1)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_56px_-38px_rgba(0,0,0,1)] ${statusTone.cardClass}`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-hawk-border-subtle px-3 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${statusTone.badgeClass}`}>
              {session.status === 'recording' ? 'Live' : session.status}
            </span>
            <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
              {session.id.slice(0, 8)}
            </span>
            {session.agent && (
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text2">
                {session.agent}
              </span>
            )}
            {session.git_branch && (
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text2">
                {session.git_branch}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="rounded-[14px] border border-red-400/20 bg-red-400/8 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-red-400 transition-colors hover:bg-red-400/14 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      <Link to={`/session/${session.id}`} className="block p-3">
        <h2 className="text-base font-semibold leading-6 text-hawk-text transition-colors group-hover:text-hawk-orange sm:text-lg">
          {session.objective}
        </h2>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-hawk-text2">
          {session.developer && (
            <span className="rounded-full border border-hawk-orange/20 bg-hawk-orange/8 px-2 py-1">
              {session.developer}
            </span>
          )}
          {session.model && (
            <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1">
              {session.model}
            </span>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SessionMetric
            label="Started"
            value={formatRelativeDate(session.started_at, now)}
            hint={formatFullDate(session.started_at)}
          />
          <SessionMetric
            label="Duration"
            value={formatDuration(session.started_at, session.ended_at, now)}
            hint={session.status === 'recording' ? 'Still running' : 'Run length'}
          />
          <SessionMetric label="Actions" value={String(session.total_actions)} hint="Recorded operations" />
          <SessionMetric
            label="Cost"
            value={formatMoney(session.total_cost_usd)}
            hint={session.total_cost_usd > 0 ? 'Tracked spend' : 'No cost recorded'}
            toneClass={session.total_cost_usd > 0 ? 'text-amber-400' : 'text-hawk-text'}
          />
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-hawk-border-subtle pt-3">
          <span className={`rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${driftTone.badgeClass}`}>
            {driftScore !== null ? `Drift ${driftScore}` : 'No drift signal'}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-text3 transition-colors group-hover:text-hawk-text">
            Open session
          </span>
        </div>
      </Link>
    </article>
  );
}

function SessionMetric({
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

function getStatusTone(status: string): {
  badgeClass: string;
  cardClass: string;
} {
  if (status === 'recording') {
    return {
      badgeClass: 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange',
      cardClass: 'border-hawk-orange/20',
    };
  }

  if (status === 'paused') {
    return {
      badgeClass: 'border-sky-400/30 bg-sky-400/10 text-sky-400',
      cardClass: 'border-sky-400/18',
    };
  }

  if (status === 'completed') {
    return {
      badgeClass: 'border-green-500/30 bg-green-500/10 text-green-400',
      cardClass: 'border-green-500/15',
    };
  }

  return {
    badgeClass: 'border-red-500/30 bg-red-500/10 text-red-400',
    cardClass: 'border-red-500/18',
  };
}

function getDriftTone(score: number | null): { badgeClass: string } {
  if (score === null) {
    return { badgeClass: 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3' };
  }

  if (score >= 70) {
    return { badgeClass: 'border-green-500/30 bg-green-500/10 text-green-400' };
  }

  if (score >= 40) {
    return { badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-400' };
  }

  return { badgeClass: 'border-red-500/30 bg-red-500/10 text-red-400' };
}

function getDriftTextClass(score: number | null): string {
  if (score === null) return 'text-hawk-text';
  if (score >= 70) return 'text-green-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-red-400';
}

function getDriftLabel(score: number | null): string {
  if (score === null) return 'No drift signal';
  if (score >= 70) return 'Healthy';
  if (score >= 40) return 'Needs attention';
  return 'Critical';
}

function formatMoney(value: number): string {
  return currencyFormatter.format(value);
}

function formatDuration(start: string, end: string | null, now: number): string {
  const ms = (end ? new Date(end).getTime() : now) - new Date(start).getTime();
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatRelativeDate(iso: string, now: number): string {
  const date = new Date(iso);
  const diff = now - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString();
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCount(value: number): string {
  return compactNumberFormatter.format(value);
}
