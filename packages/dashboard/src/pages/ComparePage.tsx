import { useEffect, useState, useMemo } from 'react';
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

export function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparisons, setComparisons] = useState<SessionComparison[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Load session list
  useEffect(() => {
    api.listSessions(100).then(setSessions);
  }, []);

  // Load comparison from URL params
  useEffect(() => {
    const ids = searchParams.get('ids');
    if (ids) {
      const idList = ids.split(',').filter(Boolean);
      setSelectedIds(idList);
      if (idList.length >= 2) {
        loadComparison(idList);
      }
    }
  }, []);

  async function loadComparison(ids: string[]) {
    setLoading(true);
    try {
      const data = await api.compareSessions(ids);
      if (Array.isArray(data)) {
        setComparisons(data as unknown as SessionComparison[]);
      }
    } catch {}
    setLoading(false);
  }

  function toggleSession(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
    setComparisons(null);
  }

  function handleCompare() {
    if (selectedIds.length < 2) return;
    setSearchParams({ ids: selectedIds.join(',') });
    loadComparison(selectedIds);
  }

  // Completed/aborted sessions only
  const completedSessions = useMemo(
    () => sessions.filter((s) => s.status === 'completed' || s.status === 'aborted'),
    [sessions],
  );

  return (
    <div>
      <div className="mb-6">
        <Link to="/" className="font-mono text-xs text-hawk-text3 hover:text-hawk-orange transition-colors">
          ← Sessions
        </Link>
        <h1 className="font-display text-xl sm:text-2xl font-bold text-hawk-text mt-2">Compare Sessions</h1>
        <p className="text-sm text-hawk-text3 mt-1">
          Select 2 or more sessions to compare side by side
        </p>
      </div>

      {/* Session picker */}
      {!comparisons && (
        <div className="mb-6 rounded-xl border border-hawk-border bg-hawk-surface overflow-hidden">
          <div className="px-5 py-3 border-b border-hawk-border bg-hawk-surface2/70">
            <span className="font-mono text-xs text-hawk-text3">
              Select sessions ({selectedIds.length} selected)
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-hawk-border/30">
            {completedSessions.map((s) => {
              const selected = selectedIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => toggleSession(s.id)}
                  className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-hawk-surface2/50 ${
                    selected ? 'bg-hawk-orange/5' : ''
                  }`}
                >
                  <span
                    className={`shrink-0 h-4 w-4 rounded border-2 flex items-center justify-center transition-colors ${
                      selected
                        ? 'border-hawk-orange bg-hawk-orange'
                        : 'border-hawk-border'
                    }`}
                  >
                    {selected && <span className="text-black text-[10px] font-bold">✓</span>}
                  </span>
                  <span className="font-mono text-xs text-hawk-text3 w-16 shrink-0">
                    {s.id.slice(0, 8)}
                  </span>
                  <span className="text-sm text-hawk-text flex-1 truncate">
                    {s.objective}
                  </span>
                  <span className="font-mono text-[10px] text-hawk-text3 shrink-0 hidden sm:inline">
                    {s.agent || 'unknown'}
                  </span>
                  <span className="font-mono text-[10px] text-hawk-amber shrink-0 hidden sm:inline">
                    ${s.total_cost_usd.toFixed(4)}
                  </span>
                  <span className="font-mono text-[10px] text-hawk-text3 shrink-0 hidden sm:inline">
                    {s.total_actions}a
                  </span>
                </button>
              );
            })}
            {completedSessions.length === 0 && (
              <div className="px-5 py-8 text-center text-hawk-text3 text-sm">
                No completed sessions found
              </div>
            )}
          </div>
          {selectedIds.length >= 2 && (
            <div className="px-5 py-3 border-t border-hawk-border bg-hawk-surface2/70">
              <button
                onClick={handleCompare}
                className="rounded-lg bg-hawk-orange px-4 py-2 font-mono text-xs font-semibold text-black hover:bg-hawk-orange/90 transition-colors"
              >
                Compare {selectedIds.length} Sessions
              </button>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="text-hawk-text3 font-mono text-sm py-8 text-center">
          Loading comparison...
        </div>
      )}

      {/* Comparison results */}
      {comparisons && comparisons.length >= 2 && (
        <div className="space-y-3 sm:space-y-6">
          {/* Reset button */}
          <button
            onClick={() => {
              setComparisons(null);
              setSelectedIds([]);
              setSearchParams({});
            }}
            className="rounded-lg border border-hawk-border bg-hawk-surface px-3 py-1.5 font-mono text-xs text-hawk-text3 hover:text-hawk-orange transition-colors"
          >
            ← New Comparison
          </button>

          {/* Summary cards */}
          <div className="compare-summary-grid grid grid-cols-1 gap-3 sm:gap-4">
          <style>{`@media(min-width:640px){.compare-summary-grid{grid-template-columns:repeat(${comparisons.length},1fr)!important}}`}</style>
            {comparisons.map((c) => (
              <div
                key={c.session.id}
                className="rounded-xl border border-hawk-border bg-hawk-surface p-4"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-xs text-hawk-text3">
                    {c.session.id.slice(0, 8)}
                  </span>
                  {c.session.agent && (
                    <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 font-mono text-[10px] text-hawk-text3">
                      {c.session.agent}
                    </span>
                  )}
                </div>
                <h3 className="font-display text-sm font-semibold text-hawk-text mb-3 line-clamp-2">
                  {c.session.objective}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  <MetricBox label="Cost" value={`$${c.session.total_cost_usd.toFixed(4)}`} color="text-hawk-amber" />
                  <MetricBox label="Actions" value={String(c.session.total_actions)} />
                  <MetricBox label="Tokens" value={c.session.total_tokens.toLocaleString()} />
                  <MetricBox label="Duration" value={formatDuration(c.durationMs)} />
                </div>
              </div>
            ))}
          </div>

          {/* Detailed comparison table */}
          <div className="rounded-xl border border-hawk-border bg-hawk-surface overflow-hidden">
            <div className="px-5 py-3 border-b border-hawk-border bg-hawk-surface2/70">
              <h2 className="font-display text-base font-semibold text-hawk-text">Detailed Comparison</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="border-b border-hawk-border/50">
                    <th className="text-left px-5 py-2 text-hawk-text3 font-normal">Metric</th>
                    {comparisons.map((c) => (
                      <th key={c.session.id} className="text-right px-5 py-2 text-hawk-text3 font-normal">
                        {c.session.id.slice(0, 8)}
                        {c.session.agent ? ` (${c.session.agent})` : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hawk-border/30">
                  <CompareRow label="Cost" values={comparisons.map((c) => c.session.total_cost_usd)} format={(v) => `$${v.toFixed(4)}`} best="low" />
                  <CompareRow label="Actions" values={comparisons.map((c) => c.session.total_actions)} best="low" />
                  <CompareRow label="Tokens" values={comparisons.map((c) => c.session.total_tokens)} format={(v) => v.toLocaleString()} best="low" />
                  <CompareRow label="Duration" values={comparisons.map((c) => c.durationMs)} format={(v) => formatDuration(v)} best="low" />
                  <CompareRow label="LLM Calls" values={comparisons.map((c) => c.stats.llm_count)} best="low" />
                  <CompareRow label="Commands" values={comparisons.map((c) => c.stats.command_count)} />
                  <CompareRow label="Files Changed" values={comparisons.map((c) => c.filesChanged.length)} />
                  <CompareRow label="Errors" values={comparisons.map((c) => c.stats.error_count)} best="low" />
                  <CompareRow label="Guardrail Hits" values={comparisons.map((c) => c.stats.guardrail_count)} best="low" />
                  <CompareRow
                    label="Drift Score"
                    values={comparisons.map((c) => c.session.final_drift_score ?? -1)}
                    format={(v) => (v >= 0 ? `${v}/100` : 'n/a')}
                    best="high"
                  />
                  <CompareRow
                    label="$/action"
                    values={comparisons.map((c) =>
                      c.session.total_actions > 0 ? c.session.total_cost_usd / c.session.total_actions : 0,
                    )}
                    format={(v) => `$${v.toFixed(4)}`}
                    best="low"
                  />
                  <CompareRow
                    label="tok/action"
                    values={comparisons.map((c) =>
                      c.session.total_actions > 0 ? Math.round(c.session.total_tokens / c.session.total_actions) : 0,
                    )}
                    best="low"
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* Files overlap */}
          <FilesOverlap comparisons={comparisons} />
        </div>
      )}
    </div>
  );
}

function MetricBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded bg-hawk-surface2 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-hawk-text3">{label}</div>
      <div className={`text-sm font-semibold ${color || 'text-hawk-text'}`}>{value}</div>
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
  format?: (v: number) => string;
  best?: 'low' | 'high';
}) {
  const fmt = format || ((v: number) => String(v));
  let bestIdx = -1;
  if (best) {
    const valid = values.filter((v) => v >= 0);
    if (valid.length >= 2) {
      const target = best === 'low' ? Math.min(...valid) : Math.max(...valid);
      bestIdx = values.indexOf(target);
    }
  }

  return (
    <tr>
      <td className="px-5 py-2 text-hawk-text3">{label}</td>
      {values.map((v, i) => (
        <td
          key={i}
          className={`px-5 py-2 text-right ${
            i === bestIdx ? 'text-hawk-green font-semibold' : 'text-hawk-text'
          }`}
        >
          {fmt(v)}
        </td>
      ))}
    </tr>
  );
}

function FilesOverlap({ comparisons }: { comparisons: SessionComparison[] }) {
  // Find files that appear in multiple sessions
  const fileMap: Record<string, string[]> = {};
  comparisons.forEach((c) => {
    c.filesChanged.forEach((f) => {
      if (!fileMap[f]) fileMap[f] = [];
      fileMap[f].push(c.session.id.slice(0, 8));
    });
  });

  const shared = Object.entries(fileMap).filter(([, ids]) => ids.length > 1);
  const unique = Object.entries(fileMap).filter(([, ids]) => ids.length === 1);

  if (shared.length === 0 && unique.length === 0) return null;

  return (
    <div className="rounded-xl border border-hawk-border bg-hawk-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-hawk-border bg-hawk-surface2/70">
        <h2 className="font-display text-base font-semibold text-hawk-text">Files Overlap</h2>
      </div>
      <div className="p-5 space-y-3">
        {shared.length > 0 && (
          <div>
            <h3 className="font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-2">
              Shared Files ({shared.length})
            </h3>
            <div className="space-y-1">
              {shared.map(([path, ids]) => (
                <div key={path} className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-hawk-orange">●</span>
                  <span className="text-hawk-text flex-1 truncate">{shortenPath(path)}</span>
                  <span className="text-hawk-text3">{ids.join(', ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {unique.length > 0 && (
          <div>
            <h3 className="font-mono text-[10px] uppercase tracking-wider text-hawk-text3 mb-2">
              Unique Files ({unique.length})
            </h3>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {unique.map(([path, ids]) => (
                <div key={path} className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-hawk-text3">·</span>
                  <span className="text-hawk-text2 flex-1 truncate">{shortenPath(path)}</span>
                  <span className="text-hawk-text3">{ids[0]}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function shortenPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-3).join('/');
}
