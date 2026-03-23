import { useState, useEffect, useCallback } from 'react';
import {
  api,
  type SessionData,
  type MemoryDiffResultData,
  type CumulativeMemoryData,
  type MemoryItemData,
  type MemoryDiffItemData,
  type HallucinationItemData,
} from '../api';

type Tab = 'cumulative' | 'diff' | 'hallucinations';

const countFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const CAT_META: Record<string, { label: string; tone: string; chip: string }> = {
  file_knowledge: {
    label: 'Files',
    tone: 'text-sky-600 dark:text-sky-400',
    chip: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  },
  error_lesson: {
    label: 'Error Lessons',
    tone: 'text-red-500 dark:text-red-400',
    chip: 'border-red-500/20 bg-red-500/10 text-red-500 dark:text-red-300',
  },
  correction: {
    label: 'Corrections',
    tone: 'text-amber-600 dark:text-amber-400',
    chip: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  tool_pattern: {
    label: 'Tool Patterns',
    tone: 'text-cyan-600 dark:text-cyan-400',
    chip: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',
  },
  decision: {
    label: 'Decisions',
    tone: 'text-violet-600 dark:text-violet-400',
    chip: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  },
  dependency_fact: {
    label: 'Dependencies',
    tone: 'text-emerald-600 dark:text-emerald-400',
    chip: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  },
  api_knowledge: {
    label: 'API Knowledge',
    tone: 'text-pink-600 dark:text-pink-400',
    chip: 'border-pink-500/20 bg-pink-500/10 text-pink-600 dark:text-pink-300',
  },
};

const HALLUCINATION_META: Record<
  HallucinationItemData['type'],
  { label: string; chip: string }
> = {
  recurring_error: {
    label: 'Recurring Error',
    chip: 'border-red-500/20 bg-red-500/10 text-red-500 dark:text-red-300',
  },
  contradicted_fact: {
    label: 'Contradicted Fact',
    chip: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  nonexistent_file: {
    label: 'Missing File',
    chip: 'border-rose-500/20 bg-rose-500/10 text-rose-500 dark:text-rose-300',
  },
  phantom_api: {
    label: 'Phantom API',
    chip: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  },
};

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not available';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateText(value: string, max = 180): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getCategoryMeta(category: string) {
  return (
    CAT_META[category] ?? {
      label: category.replace(/_/g, ' '),
      tone: 'text-hawk-text',
      chip: 'border-hawk-border-subtle bg-hawk-surface2 text-hawk-text2',
    }
  );
}

function confidenceClass(confidence: MemoryItemData['confidence']): string {
  if (confidence === 'high') {
    return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300';
  }
  if (confidence === 'medium') {
    return 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300';
  }
  return 'border-red-500/20 bg-red-500/10 text-red-500 dark:text-red-300';
}

function sessionOptionLabel(session: SessionData): string {
  const summary = truncateText(session.objective || 'Untitled objective', 44);
  return `${session.id.slice(0, 8)} - ${summary}`;
}

function confidenceLabel(confidence: MemoryItemData['confidence']): string {
  return confidence === 'high' ? 'High confidence' : confidence === 'medium' ? 'Medium confidence' : 'Low confidence';
}

export function MemoryPage() {
  const [tab, setTab] = useState<Tab>('cumulative');
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [cumulative, setCumulative] = useState<CumulativeMemoryData | null>(null);
  const [diff, setDiff] = useState<MemoryDiffResultData | null>(null);
  const [hallucinations, setHallucinations] = useState<HallucinationItemData[]>([]);
  const [sessionA, setSessionA] = useState('');
  const [sessionB, setSessionB] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === 'cumulative' && !cumulative) {
      setLoading(true);
      api
        .getCumulativeMemory(20)
        .then(setCumulative)
        .catch(() => {})
        .finally(() => setLoading(false));
    }

    if (tab === 'hallucinations' && hallucinations.length === 0) {
      setLoading(true);
      api
        .getHallucinations()
        .then(setHallucinations)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [tab, cumulative, hallucinations.length]);

  const runDiff = useCallback(async () => {
    if (!sessionA || !sessionB || sessionA === sessionB) return;
    setLoading(true);
    try {
      const result = await api.getMemoryDiff(sessionA, sessionB);
      setDiff(result);
    } catch {}
    setLoading(false);
  }, [sessionA, sessionB]);

  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );

  const tabs: Array<{ id: Tab; label: string; count?: number | null }> = [
    { id: 'cumulative', label: 'Cumulative Memory', count: cumulative?.stats.totalItems ?? null },
    {
      id: 'diff',
      label: 'Memory Diff',
      count: diff
        ? diff.learned.length +
          diff.forgotten.length +
          diff.retained.length +
          diff.evolved.length +
          diff.contradicted.length
        : null,
    },
    {
      id: 'hallucinations',
      label: 'Hallucinations',
      count: tab === 'hallucinations' ? hallucinations.length : cumulative?.hallucinations.length ?? null,
    },
  ];

  const heroSignals = [
    {
      label: 'Sessions Indexed',
      value: formatCount(sortedSessions.length),
      hint: 'Available for compare mode',
      toneClass: 'text-hawk-text',
    },
    {
      label: 'Stored Memories',
      value: cumulative ? formatCount(cumulative.stats.totalItems) : '--',
      hint: cumulative ? `${Object.keys(cumulative.stats.byCategory).length} active categories` : 'Load cumulative view',
      toneClass: 'text-hawk-orange',
    },
    {
      label: 'Corrections',
      value: cumulative ? formatCount(cumulative.stats.corrections) : '--',
      hint: cumulative ? 'Useful self-fixes retained' : 'Waiting for memory graph',
      toneClass: 'text-amber-600 dark:text-amber-400',
    },
    {
      label: 'Risk Signals',
      value:
        tab === 'hallucinations'
          ? formatCount(hallucinations.length)
          : formatCount(cumulative?.hallucinations.length ?? 0),
      hint: tab === 'hallucinations' ? 'Current hallucination watch' : 'Contradictions + hallucination flags',
      toneClass:
        (tab === 'hallucinations' ? hallucinations.length : cumulative?.hallucinations.length ?? 0) > 0
          ? 'text-red-500 dark:text-red-400'
          : 'text-emerald-600 dark:text-emerald-400',
    },
  ];

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_24px_70px_-48px_rgba(0,0,0,0.9)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-16 top-0 h-48 w-48 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute right-0 top-10 h-40 w-40 rounded-full bg-cyan-500/10 blur-3xl" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-hawk-border to-transparent" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.08fr_0.92fr]">
          <div className="space-y-4">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                <span className="h-2 w-2 rounded-full bg-hawk-orange" />
                Memory Observatory
              </div>
              <h1 className="mt-4 max-w-2xl font-display text-2xl font-semibold leading-tight text-hawk-text sm:text-3xl">
                Track what the system keeps, what it forgets, and where its memory starts to drift.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-hawk-text2 sm:text-[15px]">
                This page now treats memory as a live signal board: cumulative knowledge, session-to-session
                compare, and hallucination watch all stay readable without turning into giant cards.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
              {heroSignals.map((signal) => (
                <SignalCard
                  key={signal.label}
                  label={signal.label}
                  value={signal.value}
                  hint={signal.hint}
                  toneClass={signal.toneClass}
                />
              ))}
            </div>
          </div>

          <div className="rounded-[20px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              Quick Signals
            </div>
            <div className="mt-3 space-y-2">
              <SignalRow
                label="Current mode"
                value={
                  tab === 'cumulative'
                    ? 'Knowledge ledger'
                    : tab === 'diff'
                      ? 'Session compare'
                      : 'Hallucination watch'
                }
              />
              <SignalRow
                label="Last memory refresh"
                value={cumulative ? formatDateTime(cumulative.lastUpdated) : 'Waiting for cumulative load'}
              />
              <SignalRow
                label="Range covered"
                value={cumulative ? `${formatDateTime(cumulative.firstSeen)} to ${formatDateTime(cumulative.lastUpdated)}` : 'Load cumulative memory'}
              />
              <SignalRow
                label="Compare readiness"
                value={
                  sortedSessions.length >= 2
                    ? `${formatCount(sortedSessions.length)} sessions available`
                    : 'Need at least 2 sessions'
                }
              />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/60 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
        <div className="flex flex-wrap gap-2">
          {tabs.map((item) => {
            const isActive = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-all ${
                  isActive
                    ? 'border-hawk-orange/30 bg-hawk-orange/10 text-hawk-orange'
                    : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text3 hover:border-hawk-border hover:text-hawk-text'
                }`}
              >
                {item.label}
                {typeof item.count === 'number' && <span className="ml-2 text-hawk-text2">{formatCount(item.count)}</span>}
              </button>
            );
          })}
        </div>
      </section>

      {loading && (
        <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/60 px-4 py-10 text-center">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-hawk-text3">Memory extraction</div>
          <div className="mt-3 text-sm text-hawk-text2">Pulling the latest memory graph and shaping the view.</div>
        </section>
      )}

      {tab === 'cumulative' && !loading && cumulative && <CumulativeView data={cumulative} />}

      {tab === 'diff' && !loading && (
        <div className="space-y-4">
          <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/70 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
            <div className="grid gap-3 xl:grid-cols-[1.02fr_0.98fr]">
              <div className="space-y-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                    Diff Studio
                  </div>
                  <h2 className="mt-1.5 font-display text-lg font-semibold text-hawk-text">
                    Compare two runs and inspect what the system learned or lost.
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-hawk-text2">
                    Pick two sessions, generate the delta, then scan what stayed stable, what evolved, and where contradictions appeared.
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <SelectField
                    label="Session A"
                    value={sessionA}
                    onChange={setSessionA}
                    sessions={sortedSessions}
                  />
                  <SelectField
                    label="Session B"
                    value={sessionB}
                    onChange={setSessionB}
                    sessions={sortedSessions}
                  />
                </div>
              </div>

              <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                  Launch Compare
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <SignalCard
                    label="Selected"
                    value={
                      sessionA && sessionB
                        ? '2 runs'
                        : `${Number(Boolean(sessionA)) + Number(Boolean(sessionB))} ${
                            Number(Boolean(sessionA)) + Number(Boolean(sessionB)) === 1 ? 'run' : 'runs'
                          }`
                    }
                    hint="Choose two distinct sessions"
                    toneClass="text-hawk-text"
                  />
                  <SignalCard
                    label="Status"
                    value={diff ? 'Ready' : 'Idle'}
                    hint={diff ? 'Diff is available below' : 'No comparison generated yet'}
                    toneClass={diff ? 'text-emerald-600 dark:text-emerald-400' : 'text-hawk-text'}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void runDiff()}
                  disabled={!sessionA || !sessionB || sessionA === sessionB}
                  className="mt-3 inline-flex w-full items-center justify-center rounded-[18px] bg-hawk-orange px-4 py-2.5 text-sm font-semibold text-black transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Compare Memories
                </button>
              </div>
            </div>
          </section>

          {diff ? (
            <DiffView data={diff} />
          ) : (
            <section className="rounded-[20px] border border-dashed border-hawk-border-subtle bg-hawk-surface/50 px-4 py-10 text-center">
              <div className="font-mono text-xs uppercase tracking-[0.2em] text-hawk-text3">No diff yet</div>
              <div className="mt-3 text-sm text-hawk-text2">
                Pick two different sessions to generate a memory delta and surface retained, learned, or contradicted facts.
              </div>
            </section>
          )}
        </div>
      )}

      {tab === 'hallucinations' && !loading && <HallucinationsView data={hallucinations} title="Hallucination Watch" />}
    </div>
  );
}

function CumulativeView({ data }: { data: CumulativeMemoryData }) {
  const grouped = new Map<string, MemoryItemData[]>();
  for (const item of data.items) {
    const list = grouped.get(item.category) || [];
    list.push(item);
    grouped.set(item.category, list);
  }

  const groupedEntries = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  const categoryEntries = Object.entries(data.stats.byCategory).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-4">
      <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/70 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
        <div className="grid gap-4 xl:grid-cols-[1.02fr_0.98fr]">
          <div className="space-y-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
                Cumulative Knowledge
              </div>
              <h2 className="mt-1.5 font-display text-lg font-semibold text-hawk-text">
                The memory ledger shows what survives across sessions.
              </h2>
              <p className="mt-2 text-sm leading-6 text-hawk-text2">
                Corrections and stable lessons should rise here over time. Contradictions and hallucinations are the places that deserve review first.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
              <SignalCard label="Sessions" value={formatCount(data.totalSessions)} hint="Runs folded into memory" />
              <SignalCard label="Memories" value={formatCount(data.stats.totalItems)} hint="Tracked memory items" toneClass="text-hawk-orange" />
              <SignalCard
                label="Corrections"
                value={formatCount(data.stats.corrections)}
                hint="Useful fixes retained"
                toneClass="text-amber-600 dark:text-amber-400"
              />
              <SignalCard
                label="Contradictions"
                value={formatCount(data.stats.contradictions)}
                hint="Conflicting signals in memory"
                toneClass={
                  data.stats.contradictions > 0
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }
              />
            </div>
          </div>

          <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              Coverage
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {categoryEntries.slice(0, 6).map(([category, count]) => {
                const meta = getCategoryMeta(category);
                return (
                  <div key={category} className="rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/45 p-2.5">
                    <div className={`font-mono text-[10px] uppercase tracking-[0.16em] ${meta.tone}`}>{meta.label}</div>
                    <div className="mt-1 text-sm font-semibold text-hawk-text">{formatCount(count)}</div>
                    <div className="mt-1 text-[11px] text-hawk-text2">active items</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 text-xs text-hawk-text3">
              First seen {formatDateTime(data.firstSeen)}. Last updated {formatDateTime(data.lastUpdated)}.
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {categoryEntries.map(([category, count]) => {
          const meta = getCategoryMeta(category);
          return (
            <article key={category} className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/60 p-3">
              <div className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${meta.chip}`}>
                {meta.label}
              </div>
              <div className="mt-2 text-lg font-semibold text-hawk-text">{formatCount(count)}</div>
              <div className="mt-1 text-xs text-hawk-text2">signals currently retained</div>
            </article>
          );
        })}
      </section>

      {groupedEntries.map(([category, items]) => {
        const meta = getCategoryMeta(category);
        return (
          <section key={category} className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/68 p-3 shadow-[0_16px_40px_-34px_rgba(0,0,0,0.9)]">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className={`font-mono text-[10px] uppercase tracking-[0.18em] ${meta.tone}`}>{meta.label}</div>
                <div className="mt-1 text-sm text-hawk-text2">
                  {items.length} retained item{items.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className={`inline-flex rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${meta.chip}`}>
                {formatCount(items.length)} active
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {items.slice(0, 6).map((item) => (
                <MemoryCard key={item.id} item={item} category={category} />
              ))}
            </div>

            {items.length > 6 && (
              <div className="mt-3 font-mono text-[11px] text-hawk-text3">
                +{items.length - 6} more retained memories in this category
              </div>
            )}
          </section>
        );
      })}

      {data.hallucinations.length > 0 && (
        <HallucinationsView data={data.hallucinations} title="Memory Risk Watch" />
      )}
    </div>
  );
}

function DiffView({ data }: { data: MemoryDiffResultData }) {
  return (
    <div className="space-y-4">
      <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/70 p-3 shadow-[0_20px_60px_-45px_rgba(0,0,0,1)]">
        <div className="grid gap-4 xl:grid-cols-[1.04fr_0.96fr]">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              Comparison Brief
            </div>
            <p className="mt-2 text-sm leading-6 text-hawk-text">{data.summary}</p>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <SessionSnapshot label="Session A" session={data.sessionA} />
              <SessionSnapshot label="Session B" session={data.sessionB} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <SignalCard
              label="Learned"
              value={formatCount(data.learned.length)}
              hint="New memory items"
              toneClass="text-emerald-600 dark:text-emerald-400"
            />
            <SignalCard
              label="Forgotten"
              value={formatCount(data.forgotten.length)}
              hint="Signals that dropped out"
              toneClass="text-red-500 dark:text-red-400"
            />
            <SignalCard
              label="Retained"
              value={formatCount(data.retained.length)}
              hint="Stable facts preserved"
              toneClass="text-hawk-text"
            />
            <SignalCard
              label="Evolved"
              value={formatCount(data.evolved.length)}
              hint="Meaningfully changed items"
              toneClass="text-amber-600 dark:text-amber-400"
            />
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <DiffSection
          title="Learned"
          items={data.learned}
          toneClass="text-emerald-600 dark:text-emerald-400"
          chipClass="border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
        />
        <DiffSection
          title="Forgotten"
          items={data.forgotten}
          toneClass="text-red-500 dark:text-red-400"
          chipClass="border-red-500/20 bg-red-500/10 text-red-500 dark:text-red-300"
        />
        <DiffSection
          title="Retained"
          items={data.retained}
          toneClass="text-hawk-text"
          chipClass="border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text2"
        />
      </div>

      {data.evolved.length > 0 && (
        <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/68 p-3 shadow-[0_16px_40px_-34px_rgba(0,0,0,0.9)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-600 dark:text-amber-400">
              Evolved
            </div>
            <div className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-600 dark:text-amber-300">
              {formatCount(data.evolved.length)} changed
            </div>
          </div>
          <div className="mt-3 grid gap-2 xl:grid-cols-2">
            {data.evolved.slice(0, 8).map((item, index) => (
              <article key={`${item.key}-${index}`} className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${getCategoryMeta(item.category).chip}`}>
                    {getCategoryMeta(item.category).label}
                  </span>
                </div>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/45 p-2.5">
                    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">Before</div>
                    <div className="mt-1 text-hawk-text2">{truncateText(item.before?.content || 'No previous content', 180)}</div>
                  </div>
                  <div className="rounded-[16px] border border-amber-500/20 bg-amber-500/8 p-2.5">
                    <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-600 dark:text-amber-400">After</div>
                    <div className="mt-1 text-hawk-text">{truncateText(item.after?.content || 'No updated content', 180)}</div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {data.contradicted.length > 0 && (
        <section className="rounded-[20px] border border-red-500/20 bg-red-500/6 p-3 shadow-[0_16px_40px_-34px_rgba(0,0,0,0.9)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-500 dark:text-red-400">
              Contradicted
            </div>
            <div className="rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-red-500 dark:text-red-300">
              {formatCount(data.contradicted.length)} conflicts
            </div>
          </div>
          <div className="mt-3 grid gap-2 xl:grid-cols-2">
            {data.contradicted.map((item, index) => (
              <article key={`${item.key}-${index}`} className="rounded-[18px] border border-red-500/15 bg-hawk-bg/45 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${getCategoryMeta(item.category).chip}`}>
                    {getCategoryMeta(item.category).label}
                  </span>
                </div>
                <div className="mt-2 text-sm text-hawk-text">{truncateText(item.explanation, 220)}</div>
              </article>
            ))}
          </div>
        </section>
      )}

      {data.hallucinations.length > 0 && <HallucinationsView data={data.hallucinations} title="Diff Risk Watch" />}
    </div>
  );
}

function DiffSection({
  title,
  items,
  toneClass,
  chipClass,
}: {
  title: string;
  items: MemoryDiffItemData[];
  toneClass: string;
  chipClass: string;
}) {
  return (
    <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/68 p-3 shadow-[0_16px_40px_-34px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between gap-3">
        <div className={`font-mono text-[10px] uppercase tracking-[0.18em] ${toneClass}`}>{title}</div>
        <div className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${chipClass}`}>
          {formatCount(items.length)} items
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mt-3 rounded-[16px] border border-dashed border-hawk-border-subtle bg-hawk-bg/35 px-3 py-5 text-sm text-hawk-text3">
          No entries in this bucket for the selected comparison.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {items.slice(0, 8).map((item, index) => {
            const target = item.after || item.before;
            const meta = getCategoryMeta(item.category);
            return (
              <article key={`${item.key}-${index}`} className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${meta.chip}`}>
                    {meta.label}
                  </span>
                </div>
                <div className="mt-2 text-sm leading-5 text-hawk-text">{truncateText(target?.content || item.explanation, 180)}</div>
                {item.explanation && (
                  <div className="mt-2 text-[11px] leading-5 text-hawk-text3">{truncateText(item.explanation, 140)}</div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function HallucinationsView({
  data,
  title,
}: {
  data: HallucinationItemData[];
  title: string;
}) {
  if (data.length === 0) {
    return (
      <section className="rounded-[20px] border border-emerald-500/20 bg-emerald-500/6 px-4 py-8 text-center">
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-600 dark:text-emerald-400">
          Memory looks clean
        </div>
        <div className="mt-3 text-sm text-hawk-text2">No hallucination pattern is currently flagged.</div>
      </section>
    );
  }

  return (
    <section className="rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/68 p-3 shadow-[0_16px_40px_-34px_rgba(0,0,0,0.9)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-600 dark:text-violet-400">
            {title}
          </div>
          <div className="mt-1 text-sm text-hawk-text2">
            Claims that look fabricated, contradicted, or repeated without grounding.
          </div>
        </div>
        <div className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">
          {formatCount(data.length)} flagged
        </div>
      </div>

      <div className="mt-3 grid gap-2 xl:grid-cols-2">
        {data.map((item, index) => {
          const meta = HALLUCINATION_META[item.type];
          const categoryMeta = getCategoryMeta(item.category);
          return (
            <article key={`${item.key}-${index}`} className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${meta.chip}`}>
                  {meta.label}
                </span>
                <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${categoryMeta.chip}`}>
                  {categoryMeta.label}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                  {item.occurrences.length} occurrence{item.occurrences.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="mt-3 text-sm leading-6 text-hawk-text">{truncateText(item.claim, 220)}</div>
              <div className="mt-2 text-[11px] leading-5 text-hawk-text3">{truncateText(item.evidence, 220)}</div>

              <div className="mt-3 flex flex-wrap gap-2">
                {item.occurrences.slice(0, 3).map((occurrence) => (
                  <span
                    key={`${occurrence.sessionId}-${occurrence.sequence}`}
                    className="rounded-full border border-hawk-border-subtle bg-hawk-surface/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3"
                  >
                    {occurrence.sessionId.slice(0, 8)} · #{occurrence.sequence}
                  </span>
                ))}
                {item.occurrences.length > 3 && (
                  <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                    +{item.occurrences.length - 3} more
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SelectField({
  label,
  value,
  onChange,
  sessions,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  sessions: SessionData[];
}) {
  return (
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
      <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
        {label}
      </label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-[16px] border border-hawk-border-subtle bg-hawk-surface px-3 py-2.5 text-sm text-hawk-text outline-none transition-colors focus:border-hawk-orange/40"
      >
        <option value="">Select session...</option>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {sessionOptionLabel(session)}
          </option>
        ))}
      </select>
    </div>
  );
}

function SessionSnapshot({
  label,
  session,
}: {
  label: string;
  session: { id: string; objective: string; startedAt: string };
}) {
  return (
    <article className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">{label}</div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-hawk-orange">
        {session.id.slice(0, 8)}
      </div>
      <div className="mt-2 text-sm leading-6 text-hawk-text">{truncateText(session.objective, 130)}</div>
      <div className="mt-2 text-[11px] text-hawk-text3">{formatDateTime(session.startedAt)}</div>
    </article>
  );
}

function MemoryCard({ item, category }: { item: MemoryItemData; category: string }) {
  return (
    <article className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/45 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${confidenceClass(item.confidence)}`}>
          {confidenceLabel(item.confidence)}
        </span>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${getCategoryMeta(category).chip}`}>
          {getCategoryMeta(category).label}
        </span>
      </div>

      <div className="mt-3 text-sm leading-6 text-hawk-text">{truncateText(item.content, 180)}</div>

      {item.evidence && (
        <div className="mt-2 text-[11px] leading-5 text-hawk-text3">{truncateText(item.evidence, 160)}</div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
        <span>{item.sessionId.slice(0, 8)}</span>
        <span className="h-1 w-1 rounded-full bg-hawk-border" />
        <span>#{item.sequence}</span>
        <span className="h-1 w-1 rounded-full bg-hawk-border" />
        <span>{formatDateTime(item.timestamp)}</span>
      </div>
    </article>
  );
}

function SignalCard({
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
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-bg/55 p-3 shadow-[0_16px_40px_-30px_rgba(0,0,0,0.9)]">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-display text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-hawk-text2">{hint}</div>
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-surface/45 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className="mt-1 text-sm text-hawk-text">{value}</div>
    </div>
  );
}
