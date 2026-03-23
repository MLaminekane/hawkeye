import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type SessionData } from '../api';

interface SessionComparison {
  session: SessionData;
  stats: {
    total_events: number;
    command_count: number;
    file_count: number;
    llm_count: number;
    api_count: number;
    git_count: number;
    error_count: number;
    guardrail_count: number;
    total_cost_usd: number;
    total_duration_ms: number;
  };
  durationMs: number;
  filesChanged: string[];
  topCostFiles: Array<{ path: string; cost: number }>;
}

type InsightMetric = 'cost' | 'duration' | 'drift' | 'errors';

export function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisons, setComparisons] = useState<SessionComparison[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const loadComparison = useCallback(async (ids: string[]) => {
    setLoading(true);
    try {
      const data = await api.compareSessions(ids);
      if (Array.isArray(data)) {
        setComparisons(data as unknown as SessionComparison[]);
      }
    } catch {
      // ignore transient compare failures
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api.listSessions(100).then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    const ids = searchParams.get('ids');
    if (!ids) return;

    const idList = ids.split(',').filter(Boolean);
    setSelectedIds(idList);

    if (idList.length >= 2) {
      loadComparison(idList);
    }
  }, [searchParams, loadComparison]);

  const completedSessions = useMemo(
    () => sessions.filter((session) => session.status === 'completed' || session.status === 'aborted'),
    [sessions],
  );

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return completedSessions;

    return completedSessions.filter((session) => {
      const searchable = [
        session.id,
        session.objective,
        session.agent || '',
        session.model || '',
        session.git_branch || '',
      ].join(' ').toLowerCase();

      return searchable.includes(query);
    });
  }, [completedSessions, search]);

  const selectedSessions = useMemo(
    () => completedSessions.filter((session) => selectedIds.includes(session.id)),
    [completedSessions, selectedIds],
  );

  const compareInsights = useMemo(() => {
    if (!comparisons || comparisons.length < 2) return null;

    const getLeader = (metric: InsightMetric) => {
      let winner = comparisons[0];
      for (const candidate of comparisons.slice(1)) {
        const winnerValue = metricValue(winner, metric);
        const candidateValue = metricValue(candidate, metric);
        const candidateWins = metric === 'drift' ? candidateValue > winnerValue : candidateValue < winnerValue;
        if (candidateWins) winner = candidate;
      }
      return winner;
    };

    return {
      cheapest: getLeader('cost'),
      fastest: getLeader('duration'),
      steadiest: getLeader('drift'),
      safest: getLeader('errors'),
    };
  }, [comparisons]);

  function toggleSession(id: string) {
    setSelectedIds((previous) =>
      previous.includes(id) ? previous.filter((sessionId) => sessionId !== id) : [...previous, id],
    );
    setComparisons(null);
  }

  function handleCompare() {
    if (selectedIds.length < 2) return;
    setSearchParams({ ids: selectedIds.join(',') });
    loadComparison(selectedIds);
  }

  function resetComparison() {
    setComparisons(null);
    setSelectedIds([]);
    setSearchParams({});
  }

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-52 w-52 rounded-full bg-cyan-400/8 blur-3xl" />
          <div className="absolute right-[-30px] top-8 h-56 w-56 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute bottom-[-60px] left-1/3 h-52 w-52 rounded-full bg-emerald-400/8 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link to="/" className="inline-flex items-center gap-1 font-mono text-xs text-hawk-text3 transition-colors hover:text-hawk-orange">
                ← Sessions
              </Link>
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                Benchmarking
              </span>
            </div>

            <div className="space-y-2">
              <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
                Compare Sessions
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-hawk-text2">
                Put multiple runs side by side to spot the best tradeoff between cost, duration, stability, and action volume.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <SignalPill label="Completed runs" value={String(completedSessions.length)} />
              <SignalPill label="Selected" value={String(selectedIds.length)} />
              <SignalPill label="Mode" value={comparisons ? 'Results' : 'Picker'} />
            </div>

            {selectedSessions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedSessions.slice(0, 4).map((session) => (
                  <span
                    key={session.id}
                    className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2"
                  >
                    <span className="text-hawk-orange">{session.id.slice(0, 8)}</span>
                    <span className="max-w-[160px] truncate text-hawk-text3">{session.agent || 'unknown agent'}</span>
                  </span>
                ))}
                {selectedSessions.length > 4 && (
                  <span className="inline-flex items-center rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                    +{selectedSessions.length - 4} more
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5">
              <MiniMetric label="Ready to compare" value={selectedIds.length >= 2 ? 'Yes' : 'Need 2+'} meta={selectedIds.length >= 2 ? 'Selection valid' : 'Pick more sessions'} tone={selectedIds.length >= 2 ? 'good' : 'muted'} />
              <MiniMetric label="Current focus" value={comparisons ? 'Results' : 'Selection'} meta={comparisons ? `${comparisons.length} runs loaded` : 'Choose sessions'} tone="accent" />
              <MiniMetric label="Search" value={search ? `"${search}"` : 'Off'} meta="Picker filter" />
              <MiniMetric label="Loaded runs" value={String(comparisons?.length || 0)} meta="Comparison payload" />
            </div>

            <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
                Compare guidance
              </div>
              <p className="mt-2 text-sm text-hawk-text2">
                Mix a successful run, an aborted run, and a pricier run to instantly see what changes in drift, errors, and files touched.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!comparisons ? (
                  <button
                    onClick={handleCompare}
                    disabled={selectedIds.length < 2 || loading}
                    className="rounded-[14px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] text-hawk-orange transition-colors hover:bg-hawk-orange/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {loading ? 'Loading...' : `Compare ${Math.max(selectedIds.length, 2)} runs`}
                  </button>
                ) : (
                  <button
                    onClick={resetComparison}
                    className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] text-hawk-text3 transition-colors hover:text-hawk-orange"
                  >
                    New comparison
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {!comparisons && (
        <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
          <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="font-display text-base font-semibold text-hawk-text">Session picker</h2>
                <p className="text-xs text-hawk-text2">
                  Select at least two completed sessions to build a visual benchmark.
                </p>
              </div>
              <div className="w-full lg:max-w-md">
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search objective, agent, model, branch..."
                  className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-2 font-mono text-xs text-hawk-text placeholder-hawk-text3 outline-none transition-colors focus:border-hawk-orange/40"
                />
              </div>
            </div>
          </div>

          <div className="max-h-[30rem] overflow-y-auto p-2.5">
            <div className="space-y-2">
              {filteredSessions.map((session) => {
                const selected = selectedIds.includes(session.id);

                return (
                  <button
                    key={session.id}
                    onClick={() => toggleSession(session.id)}
                    className={`w-full rounded-[16px] border p-2.5 text-left transition-all ${
                      selected
                        ? 'border-hawk-orange/30 bg-hawk-orange/8'
                        : 'border-hawk-border-subtle bg-hawk-bg/35 hover:border-hawk-orange/20 hover:bg-hawk-bg/55'
                    }`}
                  >
                    <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                          selected
                            ? 'border-hawk-orange bg-hawk-orange text-black'
                            : 'border-hawk-border-subtle bg-hawk-surface/60 text-hawk-text3'
                        }`}>
                          {selected ? '✓' : ''}
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-orange">
                              {session.id.slice(0, 8)}
                            </span>
                            {session.agent && (
                              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                                {session.agent}
                              </span>
                            )}
                            {session.model && (
                              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                                {session.model}
                              </span>
                            )}
                          </div>

                          <p className="mt-1.5 text-sm text-hawk-text">
                            {session.objective}
                          </p>

                          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                            <span>{session.status}</span>
                            {session.git_branch && <span>{session.git_branch}</span>}
                            <span>{formatRelativeDate(session.started_at)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="grid shrink-0 grid-cols-3 gap-1.5 sm:min-w-[210px]">
                        <MetricTile label="Cost" value={formatCurrency(session.total_cost_usd)} tone="accent" compact />
                        <MetricTile label="Actions" value={String(session.total_actions)} compact />
                        <MetricTile label="Tokens" value={session.total_tokens.toLocaleString()} compact />
                      </div>
                    </div>
                  </button>
                );
              })}

              {filteredSessions.length === 0 && (
                <div className="rounded-[18px] border border-dashed border-hawk-border-subtle bg-hawk-bg/35 py-12 text-center">
                  <p className="font-display text-base font-semibold text-hawk-text">No sessions match</p>
                  <p className="mt-2 font-mono text-xs text-hawk-text3">
                    Broaden the search or finish a few sessions to compare them here.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-hawk-border-subtle bg-hawk-bg/30 px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                {selectedIds.length} selected
              </span>
              <button
                onClick={handleCompare}
                disabled={selectedIds.length < 2 || loading}
                className="rounded-[14px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] text-hawk-orange transition-colors hover:bg-hawk-orange/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? 'Loading comparison...' : `Compare ${Math.max(2, selectedIds.length)} sessions`}
              </button>
            </div>
          </div>
        </section>
      )}

      {loading && comparisons === null && (
        <div className="py-8 text-center font-mono text-sm text-hawk-text3">
          Loading comparison...
        </div>
      )}

      {comparisons && comparisons.length >= 2 && (
        <div className="space-y-5">
          {compareInsights && (
            <section className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
              <InsightCard label="Cheapest run" session={compareInsights.cheapest.session} value={formatCurrency(compareInsights.cheapest.session.total_cost_usd)} tone="accent" />
              <InsightCard label="Fastest run" session={compareInsights.fastest.session} value={formatDuration(compareInsights.fastest.durationMs)} tone="good" />
              <InsightCard label="Best drift" session={compareInsights.steadiest.session} value={compareInsights.steadiest.session.final_drift_score != null ? `${compareInsights.steadiest.session.final_drift_score}/100` : 'n/a'} tone="good" />
              <InsightCard label="Fewest errors" session={compareInsights.safest.session} value={String(compareInsights.safest.stats.error_count)} tone="muted" />
            </section>
          )}

          <div className="compare-summary-grid grid grid-cols-1 gap-2.5">
            <style>{`@media(min-width:640px){.compare-summary-grid{grid-template-columns:repeat(${comparisons.length},minmax(0,1fr))!important}}`}</style>
            {comparisons.map((comparison) => (
              <section
                key={comparison.session.id}
                className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-orange">
                    {comparison.session.id.slice(0, 8)}
                  </span>
                  {comparison.session.agent && (
                    <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                      {comparison.session.agent}
                    </span>
                  )}
                  {comparison.session.git_branch && (
                    <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
                      {comparison.session.git_branch}
                    </span>
                  )}
                </div>

                <h3 className="mt-2.5 font-display text-base font-semibold text-hawk-text sm:text-lg">
                  {comparison.session.objective}
                </h3>
                <p className="mt-1 text-xs text-hawk-text3">
                  {comparison.session.status} · started {formatRelativeDate(comparison.session.started_at)}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-1.5">
                  <MetricTile label="Cost" value={formatCurrency(comparison.session.total_cost_usd)} tone="accent" />
                  <MetricTile label="Actions" value={String(comparison.session.total_actions)} />
                  <MetricTile label="Tokens" value={comparison.session.total_tokens.toLocaleString()} />
                  <MetricTile label="Duration" value={formatDuration(comparison.durationMs)} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <SignalPill label="Drift" value={comparison.session.final_drift_score != null ? `${comparison.session.final_drift_score}/100` : 'n/a'} />
                  <SignalPill label="Errors" value={String(comparison.stats.error_count)} />
                  <SignalPill label="Files" value={String(comparison.filesChanged.length)} />
                </div>
              </section>
            ))}
          </div>

          <section className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
            <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
              <h2 className="font-display text-base font-semibold text-hawk-text">Detailed comparison</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[740px] font-mono text-xs">
                <thead>
                  <tr className="border-b border-hawk-border/50">
                    <th className="px-4 py-3 text-left font-normal text-hawk-text3">Metric</th>
                    {comparisons.map((comparison) => (
                      <th key={comparison.session.id} className="px-4 py-3 text-right font-normal text-hawk-text3">
                        {comparison.session.id.slice(0, 8)}
                        {comparison.session.agent ? ` (${comparison.session.agent})` : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hawk-border/30">
                  <CompareRow label="Cost" values={comparisons.map((comparison) => comparison.session.total_cost_usd)} format={(value) => formatCurrency(value)} best="low" />
                  <CompareRow label="Actions" values={comparisons.map((comparison) => comparison.session.total_actions)} best="low" />
                  <CompareRow label="Tokens" values={comparisons.map((comparison) => comparison.session.total_tokens)} format={(value) => value.toLocaleString()} best="low" />
                  <CompareRow label="Duration" values={comparisons.map((comparison) => comparison.durationMs)} format={(value) => formatDuration(value)} best="low" />
                  <CompareRow label="LLM calls" values={comparisons.map((comparison) => comparison.stats.llm_count)} best="low" />
                  <CompareRow label="Commands" values={comparisons.map((comparison) => comparison.stats.command_count)} />
                  <CompareRow label="Files changed" values={comparisons.map((comparison) => comparison.filesChanged.length)} />
                  <CompareRow label="Errors" values={comparisons.map((comparison) => comparison.stats.error_count)} best="low" />
                  <CompareRow label="Guardrail hits" values={comparisons.map((comparison) => comparison.stats.guardrail_count)} best="low" />
                  <CompareRow
                    label="Drift score"
                    values={comparisons.map((comparison) => comparison.session.final_drift_score ?? -1)}
                    format={(value) => (value >= 0 ? `${value}/100` : 'n/a')}
                    best="high"
                  />
                  <CompareRow
                    label="$/action"
                    values={comparisons.map((comparison) => (
                      comparison.session.total_actions > 0
                        ? comparison.session.total_cost_usd / comparison.session.total_actions
                        : 0
                    ))}
                    format={(value) => formatCurrency(value)}
                    best="low"
                  />
                  <CompareRow
                    label="tok/action"
                    values={comparisons.map((comparison) => (
                      comparison.session.total_actions > 0
                        ? Math.round(comparison.session.total_tokens / comparison.session.total_actions)
                        : 0
                    ))}
                    best="low"
                  />
                </tbody>
              </table>
            </div>
          </section>

          <FilesOverlap comparisons={comparisons} />
        </div>
      )}
    </div>
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
  tone?: 'default' | 'good' | 'accent' | 'muted';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-hawk-green'
      : tone === 'accent'
        ? 'text-hawk-orange'
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

function MetricTile({
  label,
  value,
  tone = 'default',
  compact = false,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'accent';
  compact?: boolean;
}) {
  return (
    <div className={`rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/45 ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-mono ${compact ? 'text-xs sm:text-sm' : 'text-sm'} font-semibold ${tone === 'accent' ? 'text-hawk-orange' : 'text-hawk-text'}`}>
        {value}
      </div>
    </div>
  );
}

function SignalPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2">
      <span className="text-hawk-text3">{label}</span>
      <span className="text-hawk-text">{value}</span>
    </span>
  );
}

function InsightCard({
  label,
  session,
  value,
  tone,
}: {
  label: string;
  session: SessionData;
  value: string;
  tone: 'accent' | 'good' | 'muted';
}) {
  const valueClass =
    tone === 'accent'
      ? 'text-hawk-orange'
      : tone === 'good'
        ? 'text-hawk-green'
        : 'text-hawk-text';

  return (
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1.5 font-mono text-base font-semibold ${valueClass}`}>{value}</div>
      <div className="mt-1.5 text-sm text-hawk-text">{session.objective}</div>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
        {session.id.slice(0, 8)} {session.agent ? `· ${session.agent}` : ''}
      </div>
    </div>
  );
}

function CompareRow({
  label,
  values,
  format,
  best,
}: {
  label: string;
  values: number[];
  format?: (value: number) => string;
  best?: 'low' | 'high';
}) {
  const formatter = format || ((value: number) => String(value));
  let bestIndex = -1;

  if (best) {
    const valid = values.filter((value) => value >= 0);
    if (valid.length >= 2) {
      const target = best === 'low' ? Math.min(...valid) : Math.max(...valid);
      bestIndex = values.indexOf(target);
    }
  }

  return (
    <tr>
      <td className="px-4 py-3 text-hawk-text3">{label}</td>
      {values.map((value, index) => (
        <td
          key={`${label}-${index}`}
          className={`px-4 py-3 text-right ${index === bestIndex ? 'font-semibold text-hawk-green' : 'text-hawk-text'}`}
        >
          {formatter(value)}
        </td>
      ))}
    </tr>
  );
}

function FilesOverlap({ comparisons }: { comparisons: SessionComparison[] }) {
  const fileMap: Record<string, string[]> = {};

  comparisons.forEach((comparison) => {
    comparison.filesChanged.forEach((path) => {
      if (!fileMap[path]) fileMap[path] = [];
      fileMap[path].push(comparison.session.id.slice(0, 8));
    });
  });

  const shared = Object.entries(fileMap).filter(([, ids]) => ids.length > 1);
  const unique = Object.entries(fileMap).filter(([, ids]) => ids.length === 1);

  if (shared.length === 0 && unique.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">Files overlap</h2>
      </div>

      <div className="grid gap-3 p-3 lg:grid-cols-2">
        <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
            Shared files ({shared.length})
          </div>
          <div className="mt-3 space-y-2">
            {shared.length === 0 ? (
              <p className="font-mono text-xs text-hawk-text3">No shared files between the selected runs.</p>
            ) : (
              shared.map(([path, ids]) => (
                <div key={path} className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-hawk-orange">●</span>
                  <span className="flex-1 truncate text-hawk-text">{shortenPath(path)}</span>
                  <span className="text-hawk-text3">{ids.join(', ')}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/45 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
            Unique files ({unique.length})
          </div>
          <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
            {unique.length === 0 ? (
              <p className="font-mono text-xs text-hawk-text3">Every touched file overlaps with at least one other run.</p>
            ) : (
              unique.map(([path, ids]) => (
                <div key={path} className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-hawk-text3">·</span>
                  <span className="flex-1 truncate text-hawk-text2">{shortenPath(path)}</span>
                  <span className="text-hawk-text3">{ids[0]}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function metricValue(comparison: SessionComparison, metric: InsightMetric): number {
  if (metric === 'cost') return comparison.session.total_cost_usd;
  if (metric === 'duration') return comparison.durationMs;
  if (metric === 'drift') return comparison.session.final_drift_score ?? -1;
  return comparison.stats.error_count;
}

function formatCurrency(value: number): string {
  if (value === 0) return '$0.0000';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return iso;

  const diffMinutes = Math.floor((Date.now() - date) / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '…/' + parts.slice(-3).join('/');
}
