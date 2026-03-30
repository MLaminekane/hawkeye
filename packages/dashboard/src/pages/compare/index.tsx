import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type SessionComparisonData, type SessionData } from '../../api';
import {
  CHART_METRICS,
  DETAILED_COMPARE_METRICS,
  buildChartData,
  buildCompareInsights,
  formatCurrency,
  formatDriftScore,
  formatDuration,
  formatInteger,
  formatRelativeDate,
  getChartMetricDefinition,
  getMetricWinnerIndices,
  getSessionPalette,
  isComparableSession,
  isLiveSnapshotStatus,
  serializeComparisonCsv,
  serializeComparisonJson,
  shortenPath,
  type CompareChartMetric,
  type SessionPalette,
} from './utils';

type CopyFormat = 'csv' | 'json';

interface CompareTableRowData {
  metric: (typeof DETAILED_COMPARE_METRICS)[number];
  values: Array<number | null>;
  winnerIndices: number[];
}

export function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisons, setComparisons] = useState<SessionComparisonData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [activeMetric, setActiveMetric] = useState<CompareChartMetric>('cost');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const loadComparison = useCallback(async (ids: string[]) => {
    setLoading(true);
    try {
      setComparisons(await api.compareSessions(ids));
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
  }, [loadComparison, searchParams]);

  useEffect(() => {
    if (!copyFeedback) return;
    const timeoutId = window.setTimeout(() => setCopyFeedback(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [copyFeedback]);

  const comparableSessions = useMemo(() => sessions.filter(isComparableSession), [sessions]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return comparableSessions;

    return comparableSessions.filter((session) => {
      const searchable = [
        session.id,
        session.objective,
        session.agent || '',
        session.model || '',
        session.git_branch || '',
        session.status,
      ]
        .join(' ')
        .toLowerCase();

      return searchable.includes(query);
    });
  }, [comparableSessions, search]);

  const selectedSessions = useMemo(
    () => comparableSessions.filter((session) => selectedIds.includes(session.id)),
    [comparableSessions, selectedIds],
  );

  const comparisonPalettes = useMemo(
    () => (comparisons ?? []).map((_, index) => getSessionPalette(index)),
    [comparisons],
  );

  const compareInsights = useMemo(
    () => (comparisons && comparisons.length >= 2 ? buildCompareInsights(comparisons) : []),
    [comparisons],
  );

  const chartDefinition = useMemo(() => getChartMetricDefinition(activeMetric), [activeMetric]);

  const chartData = useMemo(
    () => (comparisons ? buildChartData(comparisons, activeMetric) : []),
    [activeMetric, comparisons],
  );

  const chartMissingCount = comparisons ? comparisons.length - chartData.length : 0;

  const tableRows = useMemo<CompareTableRowData[]>(
    () =>
      (comparisons ?? []).length >= 2
        ? DETAILED_COMPARE_METRICS.map((metric) => {
            const values = comparisons!.map((comparison) => metric.getValue(comparison));
            return {
              metric,
              values,
              winnerIndices: metric.best ? getMetricWinnerIndices(values, metric.best) : [],
            };
          })
        : [],
    [comparisons],
  );

  const selectedLiveCount = selectedSessions.filter((session) => isLiveSnapshotStatus(session.status)).length;

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
    setCopyFeedback(null);
  }

  async function handleCopy(format: CopyFormat) {
    if (!comparisons) return;

    const payload =
      format === 'csv' ? serializeComparisonCsv(comparisons) : serializeComparisonJson(comparisons);

    try {
      await navigator.clipboard.writeText(payload);
      setCopyFeedback(`${format.toUpperCase()} copied to clipboard`);
    } catch {
      setCopyFeedback(`Unable to copy ${format.toUpperCase()}`);
    }
  }

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-52 w-52 rounded-full bg-cyan-400/8 blur-3xl" />
          <div className="absolute right-[-30px] top-8 h-56 w-56 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute bottom-[-60px] left-1/3 h-52 w-52 rounded-full bg-emerald-400/8 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.12fr_0.88fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link
                to="/"
                className="inline-flex items-center gap-1 font-mono text-xs text-hawk-text3 transition-colors hover:text-hawk-orange"
              >
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
                Compare live snapshots and completed runs side by side, then validate the tradeoff across cost,
                duration, drift, and action volume.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <SignalPill label="Comparable runs" value={String(comparableSessions.length)} />
              <SignalPill label="Selected" value={String(selectedIds.length)} />
              <SignalPill label="Live snapshots" value={String(selectedLiveCount)} />
              <SignalPill label="View" value={comparisons ? 'Results' : 'Picker'} />
            </div>

            {selectedSessions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedSessions.slice(0, 4).map((session) => (
                  <span
                    key={session.id}
                    className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2"
                  >
                    <span className="text-hawk-orange">{session.id.slice(0, 8)}</span>
                    <span className="max-w-[200px] truncate text-hawk-text3">
                      {session.agent || 'unknown agent'}
                    </span>
                    {isLiveSnapshotStatus(session.status) && (
                      <span
                        className="rounded-full border px-1.5 py-0.5 text-[9px] text-hawk-text2"
                        style={{
                          borderColor: 'rgba(41, 198, 255, 0.28)',
                          backgroundColor: 'rgba(41, 198, 255, 0.08)',
                        }}
                      >
                        snapshot
                      </span>
                    )}
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

          <div className="space-y-3 rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/40 p-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-orange">
                Compare guidance
              </div>
              <p className="mt-2 text-sm leading-6 text-hawk-text2">
                Mix a finished run with a paused or live snapshot to see how cost, drift, and touched files diverge
                without reading every cell manually.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
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

              {comparisons && (
                <>
                  <button
                    onClick={() => handleCopy('csv')}
                    className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] text-hawk-text2 transition-colors hover:text-hawk-orange"
                  >
                    Copy CSV
                  </button>
                  <button
                    onClick={() => handleCopy('json')}
                    className="rounded-[14px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] text-hawk-text2 transition-colors hover:text-hawk-orange"
                  >
                    Copy JSON
                  </button>
                </>
              )}
            </div>

            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
              {copyFeedback || 'Exports include metrics, files changed, and top cost files.'}
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
                  Select at least two comparable sessions. Recording and paused runs are treated as live snapshots.
                </p>
              </div>
              <div className="w-full lg:max-w-md">
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search objective, agent, model, branch..."
                  className="w-full rounded-[14px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2 font-mono text-xs text-hawk-text placeholder:text-hawk-text3 outline-none transition-colors focus:border-hawk-orange/40"
                />
              </div>
            </div>
          </div>

          <div className="max-h-[34rem] overflow-y-auto p-2.5">
            <div className="space-y-2">
              {filteredSessions.map((session) => {
                const selected = selectedIds.includes(session.id);
                const statusBadge = getStatusBadge(session.status);

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
                        <span
                          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                            selected
                              ? 'border-hawk-orange bg-hawk-orange text-white'
                              : 'border-hawk-border-subtle bg-hawk-surface/60 text-hawk-text3'
                          }`}
                        >
                          {selected ? '✓' : ''}
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-orange">
                              {session.id.slice(0, 8)}
                            </span>
                            <span
                              className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2"
                              style={{ borderColor: statusBadge.borderColor, backgroundColor: statusBadge.backgroundColor }}
                            >
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusBadge.color }} />
                              {statusBadge.label}
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

                          <p className="mt-1.5 text-sm text-hawk-text">{session.objective}</p>

                          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                            {session.git_branch && <span>{session.git_branch}</span>}
                            <span>{formatRelativeDate(session.started_at)}</span>
                            {isLiveSnapshotStatus(session.status) && <span>live snapshot</span>}
                          </div>
                        </div>
                      </div>

                      <div className="grid shrink-0 grid-cols-3 gap-1.5 sm:min-w-[210px]">
                        <MetricTile label="Cost" value={formatCurrency(session.total_cost_usd)} tone="accent" compact />
                        <MetricTile label="Actions" value={formatInteger(session.total_actions)} compact />
                        <MetricTile label="Tokens" value={formatInteger(session.total_tokens)} compact />
                      </div>
                    </div>
                  </button>
                );
              })}

              {filteredSessions.length === 0 && (
                <div className="rounded-[18px] border border-dashed border-hawk-border-subtle bg-hawk-bg/35 py-12 text-center">
                  <p className="font-display text-base font-semibold text-hawk-text">No sessions match</p>
                  <p className="mt-2 font-mono text-xs text-hawk-text3">
                    Broaden the search or record a few more sessions to compare them here.
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
        <div className="py-8 text-center font-mono text-sm text-hawk-text3">Loading comparison...</div>
      )}

      {comparisons && comparisons.length >= 2 && (
        <div className="space-y-5">
          {compareInsights.length > 0 && (
            <section className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
              {compareInsights.map((insight) => {
                const winnerIndex = comparisons.findIndex((comparison) => comparison.session.id === insight.comparison.session.id);
                const palette = comparisonPalettes[winnerIndex] ?? getSessionPalette(0);

                return (
                  <InsightCard
                    key={insight.key}
                    insight={insight}
                    palette={palette}
                  />
                );
              })}
            </section>
          )}

          <section className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
            <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="font-display text-base font-semibold text-hawk-text">Visual benchmark</h2>
                  <p className="mt-1 text-xs text-hawk-text2">{chartDefinition.description}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {CHART_METRICS.map((metric) => {
                    const active = metric.key === activeMetric;
                    return (
                      <button
                        key={metric.key}
                        onClick={() => setActiveMetric(metric.key)}
                        className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                          active
                            ? 'border-hawk-orange/35 bg-hawk-orange/10 text-hawk-orange'
                            : 'border-hawk-border-subtle bg-hawk-bg/40 text-hawk-text3 hover:text-hawk-text'
                        }`}
                      >
                        {metric.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-3">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--hawk-border-subtle)" />
                  <XAxis dataKey="shortId" tick={{ fontSize: 10, fill: 'var(--hawk-text3)' }} />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--hawk-text3)' }}
                    tickFormatter={(value: number) => chartDefinition.compactFormat(value)}
                    domain={activeMetric === 'drift' ? [0, 100] : undefined}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--hawk-surface)',
                      border: '1px solid var(--hawk-border)',
                      borderRadius: 10,
                      fontSize: 12,
                      fontFamily: 'monospace',
                      color: 'var(--hawk-text)',
                    }}
                    formatter={(value: number) => [chartDefinition.format(value), chartDefinition.label]}
                    labelFormatter={(label, payload) => {
                      const datum = payload?.[0]?.payload as { agent?: string; status?: string } | undefined;
                      if (!datum) return label;
                      return `${label} · ${datum.agent || 'unknown'} · ${datum.status || 'unknown'}`;
                    }}
                  />
                  <Bar dataKey="value" radius={[10, 10, 0, 0]} isAnimationActive={false}>
                    {chartData.map((entry) => (
                      <Cell key={entry.id} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              {chartMissingCount > 0 && (
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                  {chartMissingCount} run{chartMissingCount > 1 ? 's' : ''} omitted because this metric is unavailable.
                </p>
              )}
            </div>
          </section>

          <div className="compare-summary-grid grid grid-cols-1 gap-2.5">
            <style>{`@media(min-width:640px){.compare-summary-grid{grid-template-columns:repeat(${comparisons.length},minmax(0,1fr))!important}}`}</style>
            {comparisons.map((comparison, index) => (
              <SessionSummaryCard
                key={comparison.session.id}
                comparison={comparison}
                palette={comparisonPalettes[index] ?? getSessionPalette(index)}
              />
            ))}
          </div>

          <section className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
            <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
              <h2 className="font-display text-base font-semibold text-hawk-text">Detailed comparison</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] font-mono text-xs">
                <thead>
                  <tr className="border-b border-hawk-border/50">
                    <th className="px-4 py-3 text-left font-normal text-hawk-text3">Metric</th>
                    {comparisons.map((comparison, index) => {
                      const palette = comparisonPalettes[index] ?? getSessionPalette(index);

                      return (
                        <th key={comparison.session.id} className="px-4 py-3 text-right font-normal text-hawk-text3">
                          <Link
                            to={`/session/${comparison.session.id}`}
                            className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 transition-colors hover:text-hawk-text"
                            style={{ borderColor: palette.border, backgroundColor: palette.softFill }}
                          >
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: palette.fill }} />
                            <span>{comparison.session.id.slice(0, 8)}</span>
                          </Link>
                          {comparison.session.agent ? (
                            <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                              {comparison.session.agent}
                            </div>
                          ) : null}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hawk-border/30">
                  {tableRows.map((row) => (
                    <CompareRow
                      key={row.metric.key}
                      label={row.metric.label}
                      values={row.values}
                      winnerIndices={row.winnerIndices}
                      format={row.metric.format}
                      palettes={comparisonPalettes}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <TopCostFiles comparisons={comparisons} palettes={comparisonPalettes} />
          <FilesOverlap comparisons={comparisons} />
        </div>
      )}
    </div>
  );
}

function SessionSummaryCard({
  comparison,
  palette,
}: {
  comparison: SessionComparisonData;
  palette: SessionPalette;
}) {
  const statusBadge = getStatusBadge(comparison.session.status);

  return (
    <section
      className="rounded-[20px] border p-3"
      style={{ borderColor: palette.border, backgroundColor: palette.softFill }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/session/${comparison.session.id}`}
          className="rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-opacity hover:opacity-80"
          style={{ borderColor: palette.border, color: palette.text, backgroundColor: palette.softFill }}
        >
          {comparison.session.id.slice(0, 8)}
        </Link>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text2"
          style={{ borderColor: statusBadge.borderColor, backgroundColor: statusBadge.backgroundColor }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusBadge.color }} />
          {statusBadge.label}
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
        started {formatRelativeDate(comparison.session.started_at)}
        {isLiveSnapshotStatus(comparison.session.status) ? ' · live snapshot' : ''}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <MetricTile label="Cost" value={formatCurrency(comparison.session.total_cost_usd)} tone="accent" />
        <MetricTile label="Actions" value={formatInteger(comparison.session.total_actions)} />
        <MetricTile label="Tokens" value={formatInteger(comparison.session.total_tokens)} />
        <MetricTile label="Duration" value={formatDuration(comparison.durationMs)} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <SignalPill label="Drift" value={formatDriftScore(comparison.session.final_drift_score)} />
        <SignalPill label="Errors" value={formatInteger(comparison.stats.error_count)} />
        <SignalPill label="Files" value={formatInteger(comparison.filesChanged.length)} />
      </div>
    </section>
  );
}

function InsightCard({
  insight,
  palette,
}: {
  insight: ReturnType<typeof buildCompareInsights>[number];
  palette: SessionPalette;
}) {
  return (
    <div
      className="rounded-[18px] border p-3"
      style={{ borderColor: palette.border, backgroundColor: palette.softFill }}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{insight.label}</div>
      <div className="mt-1.5 font-mono text-base font-semibold" style={{ color: palette.text }}>
        {insight.value}
      </div>
      <div className="mt-1.5 text-sm text-hawk-text">{insight.comparison.session.objective}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
        <Link
          to={`/session/${insight.comparison.session.id}`}
          className="rounded-full border px-2 py-1 transition-opacity hover:opacity-80"
          style={{ borderColor: palette.border, backgroundColor: palette.softFill, color: palette.text }}
        >
          {insight.comparison.session.id.slice(0, 8)}
        </Link>
        {insight.comparison.session.agent && <span>{insight.comparison.session.agent}</span>}
        <span>{insight.summary}</span>
      </div>
    </div>
  );
}

function CompareRow({
  label,
  values,
  winnerIndices,
  format,
  palettes,
}: {
  label: string;
  values: Array<number | null>;
  winnerIndices: number[];
  format?: (value: number | null) => string;
  palettes: SessionPalette[];
}) {
  const formatter = format || ((value: number | null) => (value == null ? 'n/a' : String(value)));

  return (
    <tr>
      <td className="px-4 py-3 text-hawk-text3">{label}</td>
      {values.map((value, index) => {
        const winner = winnerIndices.includes(index);
        const palette = palettes[index] ?? getSessionPalette(index);

        return (
          <td key={`${label}-${index}`} className="px-4 py-3 text-right text-hawk-text">
            <span
              className={`inline-flex min-w-[72px] justify-end rounded-[10px] px-2.5 py-1.5 ${winner ? 'font-semibold' : ''}`}
              style={
                winner
                  ? {
                      color: palette.text,
                      backgroundColor: palette.softFill,
                      boxShadow: `inset 0 0 0 1px ${palette.border}`,
                    }
                  : undefined
              }
            >
              {formatter(value)}
            </span>
          </td>
        );
      })}
    </tr>
  );
}

function TopCostFiles({
  comparisons,
  palettes,
}: {
  comparisons: SessionComparisonData[];
  palettes: SessionPalette[];
}) {
  return (
    <section className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
      <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
        <h2 className="font-display text-base font-semibold text-hawk-text">Top cost files</h2>
      </div>

      <div className="grid gap-3 p-3 lg:grid-cols-2 xl:grid-cols-3">
        {comparisons.map((comparison, index) => {
          const palette = palettes[index] ?? getSessionPalette(index);

          return (
            <div
              key={comparison.session.id}
              className="rounded-[16px] border p-3"
              style={{ borderColor: palette.border, backgroundColor: palette.softFill }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    to={`/session/${comparison.session.id}`}
                    className="font-mono text-[10px] uppercase tracking-[0.16em] transition-opacity hover:opacity-80"
                    style={{ color: palette.text }}
                  >
                    {comparison.session.id.slice(0, 8)}
                  </Link>
                  <div className="mt-1 text-sm text-hawk-text">
                    {comparison.session.agent || 'unknown agent'}
                  </div>
                </div>
                <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-hawk-text3">
                  {comparison.topCostFiles.length} files
                </span>
              </div>

              <div className="mt-3 space-y-2">
                {comparison.topCostFiles.length === 0 ? (
                  <p className="font-mono text-xs text-hawk-text3">No file-level cost data for this run.</p>
                ) : (
                  comparison.topCostFiles.map((file) => (
                    <div key={`${comparison.session.id}-${file.path}`} className="flex items-center gap-2 font-mono text-xs">
                      <span className="text-hawk-text3">●</span>
                      <span className="flex-1 truncate text-hawk-text">{shortenPath(file.path)}</span>
                      <span className="text-hawk-text2">{formatCurrency(file.cost)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FilesOverlap({ comparisons }: { comparisons: SessionComparisonData[] }) {
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
              <p className="font-mono text-xs text-hawk-text3">
                Every touched file overlaps with at least one other run.
              </p>
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
      <div
        className={`mt-1 font-mono ${compact ? 'text-xs sm:text-sm' : 'text-sm'} font-semibold ${
          tone === 'accent' ? 'text-hawk-orange' : 'text-hawk-text'
        }`}
      >
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

function getStatusBadge(status: string): {
  label: string;
  color: string;
  borderColor: string;
  backgroundColor: string;
} {
  if (status === 'recording') {
    return {
      label: 'Live',
      color: '#29c6ff',
      borderColor: 'rgba(41, 198, 255, 0.28)',
      backgroundColor: 'rgba(41, 198, 255, 0.08)',
    };
  }

  if (status === 'paused') {
    return {
      label: 'Paused',
      color: '#4f8cff',
      borderColor: 'rgba(79, 140, 255, 0.26)',
      backgroundColor: 'rgba(79, 140, 255, 0.08)',
    };
  }

  if (status === 'completed') {
    return {
      label: 'Completed',
      color: '#22c55e',
      borderColor: 'rgba(34, 197, 94, 0.24)',
      backgroundColor: 'rgba(34, 197, 94, 0.08)',
    };
  }

  if (status === 'aborted') {
    return {
      label: 'Aborted',
      color: '#f59e0b',
      borderColor: 'rgba(245, 158, 11, 0.24)',
      backgroundColor: 'rgba(245, 158, 11, 0.08)',
    };
  }

  return {
    label: status,
    color: 'var(--hawk-text3)',
    borderColor: 'var(--hawk-border-subtle)',
    backgroundColor: 'rgba(127, 127, 149, 0.08)',
  };
}
