import { useEffect, useState } from 'react';
import { api, type DeveloperAnalyticsData, type GlobalStatsData } from '../api';

export function AnalyticsPage() {
  const [devs, setDevs] = useState<DeveloperAnalyticsData[]>([]);
  const [stats, setStats] = useState<GlobalStatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getDevAnalytics(), api.getStats()])
      .then(([d, s]) => {
        setDevs(d);
        setStats(s);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-hawk-orange border-t-transparent" />
      </div>
    );
  }

  const totalCost = devs.reduce((s, d) => s + d.total_cost_usd, 0);
  const totalSessions = devs.reduce((s, d) => s + d.total_sessions, 0);
  const totalTokens = devs.reduce((s, d) => s + d.total_tokens, 0);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-display text-xl sm:text-2xl font-bold text-hawk-text">Developer Analytics</h1>
        <p className="text-sm text-hawk-text3 mt-1">Cross-developer usage, cost, and drift analysis</p>
      </div>

      {/* Global summary cards */}
      <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Developers" value={String(devs.length)} />
        <StatCard label="Total Sessions" value={formatNumber(totalSessions)} />
        <StatCard label="Total Cost" value={`$${totalCost.toFixed(2)}`} accent />
        <StatCard label="Total Tokens" value={formatNumber(totalTokens)} />
      </div>

      {/* Developer breakdown table */}
      {devs.length === 0 ? (
        <div className="rounded-xl border border-hawk-border-subtle bg-hawk-surface p-10 text-center">
          <p className="font-mono text-sm text-hawk-text3">No developer data yet</p>
          <p className="font-mono text-xs text-hawk-text3/60 mt-2">
            Sessions will be tagged with developer names from <code className="text-hawk-orange">git config user.name</code>
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/55 shadow-sm">
          <div className="border-b border-hawk-border-subtle bg-hawk-surface2/75 px-5 py-3">
            <h2 className="font-display text-base font-semibold text-hawk-text">By Developer</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-hawk-border-subtle bg-hawk-surface2/40">
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium">Developer</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right">Sessions</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right">Actions</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right">Cost</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right">Tokens</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right">Avg Drift</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right hidden sm:table-cell">Completed</th>
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-wider text-hawk-text3 font-medium text-right hidden sm:table-cell">Last Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hawk-border-subtle">
                {devs.map((d) => {
                  const costPct = totalCost > 0 ? (d.total_cost_usd / totalCost) * 100 : 0;
                  const driftColor = d.avg_drift_score >= 70 ? 'text-hawk-green' : d.avg_drift_score >= 40 ? 'text-hawk-amber' : 'text-hawk-red';

                  return (
                    <tr key={d.developer} className="transition-colors hover:bg-hawk-surface2/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-hawk-orange/15 text-hawk-orange text-[10px] font-bold uppercase">
                            {d.developer.slice(0, 2)}
                          </div>
                          <div>
                            <span className="text-hawk-text font-medium">{d.developer}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-hawk-text">{d.total_sessions}</td>
                      <td className="px-4 py-3 text-right text-hawk-text2">{formatNumber(d.total_actions)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-hawk-amber">${d.total_cost_usd.toFixed(2)}</span>
                        <div className="mt-1 h-1 rounded-full bg-hawk-surface3 overflow-hidden">
                          <div className="h-full rounded-full bg-hawk-orange" style={{ width: `${Math.min(100, costPct)}%` }} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-hawk-text2">{formatNumber(d.total_tokens)}</td>
                      <td className={`px-4 py-3 text-right font-medium ${driftColor}`}>
                        {d.avg_drift_score > 0 ? `${Math.round(d.avg_drift_score)}/100` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-hawk-text2 hidden sm:table-cell">
                        <span className="text-hawk-green">{d.completed_sessions}</span>
                        {d.aborted_sessions > 0 && (
                          <span className="text-hawk-red ml-1">/ {d.aborted_sessions} aborted</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-hawk-text3 hidden sm:table-cell">
                        {d.last_session ? formatRelativeTime(d.last_session) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cost distribution */}
      {devs.length > 1 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/55 shadow-sm">
          <div className="border-b border-hawk-border-subtle bg-hawk-surface2/75 px-5 py-3">
            <h2 className="font-display text-base font-semibold text-hawk-text">Cost Distribution</h2>
          </div>
          <div className="p-5">
            <div className="flex h-6 w-full overflow-hidden rounded-full bg-hawk-surface3">
              {devs.filter((d) => d.total_cost_usd > 0).map((d, i) => {
                const pct = totalCost > 0 ? (d.total_cost_usd / totalCost) * 100 : 0;
                const colors = ['bg-hawk-orange', 'bg-hawk-blue', 'bg-hawk-green', 'bg-hawk-purple', 'bg-hawk-amber', 'bg-hawk-red'];
                return (
                  <div
                    key={d.developer}
                    className={`h-full ${colors[i % colors.length]} transition-all`}
                    style={{ width: `${pct}%` }}
                    title={`${d.developer}: $${d.total_cost_usd.toFixed(2)} (${pct.toFixed(1)}%)`}
                  />
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              {devs.filter((d) => d.total_cost_usd > 0).map((d, i) => {
                const colors = ['bg-hawk-orange', 'bg-hawk-blue', 'bg-hawk-green', 'bg-hawk-purple', 'bg-hawk-amber', 'bg-hawk-red'];
                const pct = totalCost > 0 ? (d.total_cost_usd / totalCost) * 100 : 0;
                return (
                  <div key={d.developer} className="flex items-center gap-1.5">
                    <div className={`h-2.5 w-2.5 rounded-full ${colors[i % colors.length]}`} />
                    <span className="font-mono text-[10px] text-hawk-text2">
                      {d.developer} <span className="text-hawk-text3">${d.total_cost_usd.toFixed(2)} ({pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-hawk-border-subtle bg-hawk-surface p-3 sm:p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-text3">{label}</div>
      <div className={`mt-1 font-mono text-lg sm:text-xl font-bold ${accent ? 'text-hawk-orange' : 'text-hawk-text'}`}>
        {value}
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
