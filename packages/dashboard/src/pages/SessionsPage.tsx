import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api, hawkeyeWs, type SessionData, type GlobalStatsData } from '../api';

// Module-level cache to prevent flash on route change
let cachedSessions: SessionData[] | null = null;
let cachedStats: GlobalStatsData | null = null;

type SortKey = 'date' | 'actions' | 'cost' | 'drift';
type SortDir = 'asc' | 'desc';

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionData[]>(cachedSessions || []);
  const [stats, setStats] = useState<GlobalStatsData | null>(cachedStats);
  const [loading, setLoading] = useState(cachedSessions === null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [driftMin, setDriftMin] = useState('');
  const [driftMax, setDriftMax] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    const load = () => {
      api.listSessions(200)
        .then((data) => {
          cachedSessions = data;
          setSessions(data);
          setLoading(false);
        })
        .catch(() => setLoading(false));
      api.getStats()
        .then((s) => {
          cachedStats = s;
          setStats(s);
        })
        .catch(() => {});
    };
    load();

    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'event' || msg.type === 'drift_update') {
        load();
      }
    });

    return () => { unsub(); };
  }, []);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const filtered = useMemo(() => {
    let result = sessions;

    // Status filter
    if (statusFilter) result = result.filter((s) => s.status === statusFilter);

    // Text search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((s) =>
        s.objective.toLowerCase().includes(q) ||
        (s.agent || '').toLowerCase().includes(q) ||
        s.id.includes(q)
      );
    }

    // Date range filter
    if (dateFrom) {
      const from = new Date(dateFrom).getTime();
      result = result.filter((s) => new Date(s.started_at).getTime() >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo).getTime() + 86400000; // include full day
      result = result.filter((s) => new Date(s.started_at).getTime() <= to);
    }

    // Drift range filter
    if (driftMin) {
      const min = parseFloat(driftMin);
      result = result.filter((s) => s.final_drift_score != null && s.final_drift_score >= min);
    }
    if (driftMax) {
      const max = parseFloat(driftMax);
      result = result.filter((s) => s.final_drift_score != null && s.final_drift_score <= max);
    }

    // Sort
    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'date':
          cmp = new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
          break;
        case 'actions':
          cmp = a.total_actions - b.total_actions;
          break;
        case 'cost':
          cmp = a.total_cost_usd - b.total_cost_usd;
          break;
        case 'drift':
          cmp = (a.final_drift_score ?? -1) - (b.final_drift_score ?? -1);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [sessions, statusFilter, search, sortKey, sortDir, dateFrom, dateTo, driftMin, driftMax]);

  if (loading) {
    return <div className="text-hawk-text3 font-mono text-sm p-8">Loading...</div>;
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="text-5xl mb-4 opacity-30">H</div>
        <h2 className="font-display text-xl font-semibold text-hawk-text mb-2">No sessions yet</h2>
        <p className="text-hawk-text3 text-sm max-w-md mb-4">
          Start recording an AI agent session to see it here.
        </p>
        <code className="rounded-lg bg-hawk-surface border border-hawk-border px-4 py-2 font-mono text-sm text-hawk-orange">
          hawkeye record -o "your objective" -- agent-command
        </code>
      </div>
    );
  }

  // Status counts
  const statusCounts = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      {/* ─── Global Stats Cards ─── */}
      {stats && (
        <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Sessions" value={String(stats.total_sessions)} sub={`${stats.active_sessions} active`} color="text-hawk-orange" />
          <StatCard label="Total Cost" value={`$${stats.total_cost_usd.toFixed(2)}`} sub={`${stats.total_tokens.toLocaleString()} tokens`} color="text-hawk-amber" />
          <StatCard label="Actions" value={String(stats.total_actions)} sub={`${(stats.total_actions / Math.max(stats.total_sessions, 1)).toFixed(0)} avg/session`} color="text-hawk-text" />
          <StatCard
            label="Avg Drift"
            value={`${stats.avg_drift_score.toFixed(0)}/100`}
            sub={stats.avg_drift_score >= 70 ? 'healthy' : stats.avg_drift_score >= 40 ? 'attention needed' : 'critical'}
            color={stats.avg_drift_score >= 70 ? 'text-hawk-green' : stats.avg_drift_score >= 40 ? 'text-hawk-amber' : 'text-hawk-red'}
          />
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold text-hawk-text">Sessions</h1>
        <span className="font-mono text-xs text-hawk-text3">{sessions.length} total</span>
      </div>

      {/* Search + Status Filters */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          type="text"
          placeholder="Search objectives, agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:flex-1 rounded-lg bg-hawk-surface border border-hawk-border px-3 py-2 font-mono text-xs text-hawk-text placeholder-hawk-text3 outline-none focus:border-hawk-orange/50 transition-colors"
        />
        <div className="flex gap-1 overflow-x-auto">
          {['recording', 'completed', 'aborted'].map((status) => (
            statusCounts[status] ? (
              <button
                key={status}
                onClick={() => setStatusFilter(statusFilter === status ? null : status)}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase transition-all ${
                  statusFilter === status
                    ? 'ring-1 ring-hawk-orange bg-hawk-surface2'
                    : 'bg-hawk-surface hover:bg-hawk-surface2'
                } ${status === 'completed' ? 'text-hawk-green' : status === 'recording' ? 'text-hawk-orange' : 'text-hawk-red'}`}
              >
                {status} ({statusCounts[status]})
              </button>
            ) : null
          ))}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`shrink-0 rounded-lg px-2.5 py-1.5 font-mono text-[10px] font-bold transition-all ${showFilters ? 'bg-hawk-orange text-black' : 'bg-hawk-surface text-hawk-text3 hover:bg-hawk-surface2'}`}
          >
            Filters
          </button>
        </div>
      </div>

      {/* ─── Advanced Filters ─── */}
      {showFilters && (
        <div className="mb-4 rounded-lg border border-hawk-border bg-hawk-surface p-3 flex flex-wrap gap-4 font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className="text-hawk-text3">From:</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="rounded bg-hawk-surface2 border border-hawk-border px-2 py-1 text-hawk-text outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-hawk-text3">To:</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="rounded bg-hawk-surface2 border border-hawk-border px-2 py-1 text-hawk-text outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-hawk-text3">Drift:</span>
            <input type="number" min="0" max="100" placeholder="min" value={driftMin} onChange={(e) => setDriftMin(e.target.value)}
              className="w-14 rounded bg-hawk-surface2 border border-hawk-border px-2 py-1 text-hawk-text outline-none" />
            <span className="text-hawk-text3">–</span>
            <input type="number" min="0" max="100" placeholder="max" value={driftMax} onChange={(e) => setDriftMax(e.target.value)}
              className="w-14 rounded bg-hawk-surface2 border border-hawk-border px-2 py-1 text-hawk-text outline-none" />
          </div>
          {(dateFrom || dateTo || driftMin || driftMax) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setDriftMin(''); setDriftMax(''); }}
              className="text-hawk-red hover:underline">Clear</button>
          )}
        </div>
      )}

      {/* ─── Sort Bar ─── */}
      <div className="mb-2 flex items-center gap-4 font-mono text-[10px] text-hawk-text3">
        <span className="text-hawk-text3">Sort:</span>
        {([['date', 'Date'], ['actions', 'Actions'], ['cost', 'Cost'], ['drift', 'Drift']] as const).map(([key, label]) => (
          <button key={key} onClick={() => toggleSort(key)}
            className={`transition-colors ${sortKey === key ? 'text-hawk-orange font-bold' : 'hover:text-hawk-text'}`}>
            {label} {sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : ''}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filtered.map((s) => (
          <SessionCard key={s.id} session={s} />
        ))}
        {filtered.length === 0 && sessions.length > 0 && (
          <div className="text-center py-8 text-hawk-text3 text-sm">
            No sessions match your filters.
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/70 p-4 shadow-sm transition-transform duration-200 hover:-translate-y-0.5">
      <div className="font-mono text-[10px] text-hawk-text3 uppercase mb-1">{label}</div>
      <div className={`font-display text-xl font-bold ${color}`}>{value}</div>
      <div className="font-mono text-[10px] text-hawk-text3 mt-0.5">{sub}</div>
    </div>
  );
}

function SessionCard({ session: s }: { session: SessionData }) {
  const isRecording = s.status === 'recording';
  const duration = getDuration(s.started_at, s.ended_at);
  const driftColor = getDriftColor(s.final_drift_score);

  return (
    <Link
      to={`/session/${s.id}`}
      className="group block overflow-hidden rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/45 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-hawk-orange/35 hover:shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
    >
      {/* Top status line */}
      <div className="flex items-center gap-3 border-b border-hawk-border-subtle bg-hawk-surface2/55 px-4 py-2">
        <div className="flex items-center gap-2">
          {isRecording ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-hawk-orange opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-hawk-orange"></span>
              </span>
              <span className="font-mono text-[10px] font-bold text-hawk-orange uppercase">Recording</span>
            </>
          ) : s.status === 'completed' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-hawk-green"></span>
              <span className="font-mono text-[10px] font-bold text-hawk-green uppercase">Completed</span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-hawk-red"></span>
              <span className="font-mono text-[10px] font-bold text-hawk-red uppercase">Aborted</span>
            </>
          )}
        </div>

        {s.agent && (
          <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 font-mono text-[10px] text-hawk-text3">
            {s.agent}
          </span>
        )}

        <span className="font-mono text-[10px] text-hawk-text3">{s.id.slice(0, 8)}</span>

        <span className="ml-auto font-mono text-[10px] text-hawk-text3">{formatDate(s.started_at)}</span>
      </div>

      {/* Main content */}
      <div className="px-4 py-3">
        <h3 className="mb-3 text-sm font-semibold text-hawk-text transition-colors group-hover:text-hawk-orange">
          {s.objective}
        </h3>

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
          <div className="flex items-center gap-1">
            <span className="text-hawk-text3">Duration:</span>
            <span className="text-hawk-text">{duration}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-hawk-text3">Actions:</span>
            <span className="text-hawk-text font-semibold">{s.total_actions}</span>
          </div>

          {s.total_cost_usd > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-hawk-text3">Cost:</span>
              <span className="text-hawk-amber">${s.total_cost_usd.toFixed(4)}</span>
            </div>
          )}

          {s.final_drift_score != null && (
            <div className="flex items-center gap-2 sm:ml-auto">
              <span className="text-hawk-text3">Drift:</span>
              <div className="flex items-center gap-1.5">
                <div className="w-16 h-1.5 rounded-full bg-hawk-surface3 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${driftColor === 'text-hawk-green' ? 'bg-hawk-green' : driftColor === 'text-hawk-amber' ? 'bg-hawk-amber' : 'bg-hawk-red'}`}
                    style={{ width: `${s.final_drift_score}%` }}
                  />
                </div>
                <span className={`font-semibold ${driftColor}`}>{s.final_drift_score}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

function getDuration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function getDriftColor(score: number | null): string {
  if (score == null) return 'text-hawk-text3';
  if (score >= 70) return 'text-hawk-green';
  if (score >= 40) return 'text-hawk-amber';
  return 'text-hawk-red';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}
