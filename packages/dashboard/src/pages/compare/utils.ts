import type { SessionComparisonData, SessionData } from '../../api';

export const COMPARABLE_SESSION_STATUSES = ['recording', 'paused', 'completed', 'aborted'] as const;

export type CompareChartMetric = 'cost' | 'duration' | 'actions' | 'tokens' | 'drift';
export type CompareInsightKey = 'cheapest' | 'fastest' | 'steadiest' | 'safest';
export type CompareMetricPreference = 'low' | 'high';

export interface SessionPalette {
  fill: string;
  softFill: string;
  border: string;
  text: string;
}

export interface CompareMetricDefinition {
  key: CompareChartMetric;
  label: string;
  description: string;
  best: CompareMetricPreference;
  format: (value: number | null) => string;
  compactFormat: (value: number | null) => string;
  getValue: (comparison: SessionComparisonData) => number | null;
}

export interface CompareTableMetric {
  key: string;
  label: string;
  best?: CompareMetricPreference;
  getValue: (comparison: SessionComparisonData) => number | null;
  format?: (value: number | null) => string;
}

export interface CompareInsight {
  key: CompareInsightKey;
  label: string;
  value: string;
  comparison: SessionComparisonData;
  winnerIndices: number[];
  summary: string;
}

export interface CompareChartDatum {
  id: string;
  shortId: string;
  agent: string;
  status: string;
  value: number;
  formattedValue: string;
  fill: string;
}

const SESSION_PALETTES: SessionPalette[] = [
  { fill: '#ff7a45', softFill: 'rgba(255, 122, 69, 0.14)', border: 'rgba(255, 122, 69, 0.45)', text: '#ffb08c' },
  { fill: '#29c6ff', softFill: 'rgba(41, 198, 255, 0.14)', border: 'rgba(41, 198, 255, 0.4)', text: '#95e9ff' },
  { fill: '#22c55e', softFill: 'rgba(34, 197, 94, 0.14)', border: 'rgba(34, 197, 94, 0.38)', text: '#8ae7ae' },
  { fill: '#f59e0b', softFill: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.4)', text: '#ffd27a' },
  { fill: '#a78bfa', softFill: 'rgba(167, 139, 250, 0.14)', border: 'rgba(167, 139, 250, 0.38)', text: '#d4c3ff' },
  { fill: '#fb7185', softFill: 'rgba(251, 113, 133, 0.14)', border: 'rgba(251, 113, 133, 0.38)', text: '#ffb3c0' },
];

export const CHART_METRICS: CompareMetricDefinition[] = [
  {
    key: 'cost',
    label: 'Cost',
    description: 'See which run spends more or less overall.',
    best: 'low',
    format: formatCurrency,
    compactFormat: formatCurrencyCompact,
    getValue: (comparison) => comparison.session.total_cost_usd,
  },
  {
    key: 'duration',
    label: 'Duration',
    description: 'Compare total run time side by side.',
    best: 'low',
    format: formatDuration,
    compactFormat: formatDuration,
    getValue: (comparison) => comparison.durationMs,
  },
  {
    key: 'actions',
    label: 'Actions',
    description: 'Measure how many actions each run needed.',
    best: 'low',
    format: formatInteger,
    compactFormat: formatIntegerCompact,
    getValue: (comparison) => comparison.session.total_actions,
  },
  {
    key: 'tokens',
    label: 'Tokens',
    description: 'Compare total token usage.',
    best: 'low',
    format: formatInteger,
    compactFormat: formatIntegerCompact,
    getValue: (comparison) => comparison.session.total_tokens,
  },
  {
    key: 'drift',
    label: 'Drift',
    description: 'Higher is steadier. Missing drift stays non-comparable.',
    best: 'high',
    format: formatDriftScore,
    compactFormat: formatDriftScore,
    getValue: (comparison) => comparison.session.final_drift_score,
  },
];

export const DETAILED_COMPARE_METRICS: CompareTableMetric[] = [
  {
    key: 'cost',
    label: 'Cost',
    best: 'low',
    getValue: (comparison) => comparison.session.total_cost_usd,
    format: formatCurrency,
  },
  {
    key: 'actions',
    label: 'Actions',
    best: 'low',
    getValue: (comparison) => comparison.session.total_actions,
    format: formatInteger,
  },
  {
    key: 'tokens',
    label: 'Tokens',
    best: 'low',
    getValue: (comparison) => comparison.session.total_tokens,
    format: formatInteger,
  },
  {
    key: 'duration',
    label: 'Duration',
    best: 'low',
    getValue: (comparison) => comparison.durationMs,
    format: formatDuration,
  },
  {
    key: 'llm_calls',
    label: 'LLM calls',
    best: 'low',
    getValue: (comparison) => comparison.stats.llm_count,
    format: formatInteger,
  },
  {
    key: 'commands',
    label: 'Commands',
    getValue: (comparison) => comparison.stats.command_count,
    format: formatInteger,
  },
  {
    key: 'files_changed',
    label: 'Files changed',
    getValue: (comparison) => comparison.filesChanged.length,
    format: formatInteger,
  },
  {
    key: 'errors',
    label: 'Errors',
    best: 'low',
    getValue: (comparison) => comparison.stats.error_count,
    format: formatInteger,
  },
  {
    key: 'guardrail_hits',
    label: 'Guardrail hits',
    best: 'low',
    getValue: (comparison) => comparison.stats.guardrail_count,
    format: formatInteger,
  },
  {
    key: 'drift_score',
    label: 'Drift score',
    best: 'high',
    getValue: (comparison) => comparison.session.final_drift_score,
    format: formatDriftScore,
  },
  {
    key: 'cost_per_action',
    label: '$/action',
    best: 'low',
    getValue: (comparison) =>
      comparison.session.total_actions > 0
        ? comparison.session.total_cost_usd / comparison.session.total_actions
        : null,
    format: formatCurrency,
  },
  {
    key: 'tokens_per_action',
    label: 'tok/action',
    best: 'low',
    getValue: (comparison) =>
      comparison.session.total_actions > 0
        ? Math.round(comparison.session.total_tokens / comparison.session.total_actions)
        : null,
    format: formatInteger,
  },
];

export function isComparableSessionStatus(status: string): boolean {
  return COMPARABLE_SESSION_STATUSES.includes(status as (typeof COMPARABLE_SESSION_STATUSES)[number]);
}

export function isComparableSession(session: Pick<SessionData, 'status'>): boolean {
  return isComparableSessionStatus(session.status);
}

export function isLiveSnapshotStatus(status: string): boolean {
  return status === 'recording' || status === 'paused';
}

export function getSessionPalette(index: number): SessionPalette {
  return SESSION_PALETTES[index % SESSION_PALETTES.length] ?? SESSION_PALETTES[0];
}

export function getMetricWinnerIndices(
  values: Array<number | null>,
  best: CompareMetricPreference,
): number[] {
  const comparableValues = values.filter(isDefinedNumber);
  if (comparableValues.length < 2) return [];

  const target = best === 'low' ? Math.min(...comparableValues) : Math.max(...comparableValues);
  return values.flatMap((value, index) => (value === target ? [index] : []));
}

export function buildCompareInsights(comparisons: SessionComparisonData[]): CompareInsight[] {
  const definitions: Array<{
    key: CompareInsightKey;
    label: string;
    best: CompareMetricPreference;
    getValue: (comparison: SessionComparisonData) => number | null;
    format: (value: number | null) => string;
  }> = [
    {
      key: 'cheapest',
      label: 'Cheapest run',
      best: 'low',
      getValue: (comparison) => comparison.session.total_cost_usd,
      format: formatCurrency,
    },
    {
      key: 'fastest',
      label: 'Fastest run',
      best: 'low',
      getValue: (comparison) => comparison.durationMs,
      format: formatDuration,
    },
    {
      key: 'steadiest',
      label: 'Best drift',
      best: 'high',
      getValue: (comparison) => comparison.session.final_drift_score,
      format: formatDriftScore,
    },
    {
      key: 'safest',
      label: 'Fewest errors',
      best: 'low',
      getValue: (comparison) => comparison.stats.error_count,
      format: formatInteger,
    },
  ];

  return definitions.flatMap((definition) => {
    const values = comparisons.map(definition.getValue);
    const winnerIndices = getMetricWinnerIndices(values, definition.best);
    if (winnerIndices.length === 0) return [];

    const comparison = comparisons[winnerIndices[0]];
    const value = definition.getValue(comparison);
    return [
      {
        key: definition.key,
        label: definition.label,
        value: definition.format(value),
        comparison,
        winnerIndices,
        summary:
          winnerIndices.length > 1
            ? `Tie across ${winnerIndices.length} runs`
            : `${comparison.session.status} run`,
      },
    ];
  });
}

export function buildChartData(
  comparisons: SessionComparisonData[],
  metric: CompareChartMetric,
): CompareChartDatum[] {
  const definition = getChartMetricDefinition(metric);
  return comparisons.flatMap((comparison, index) => {
    const value = definition.getValue(comparison);
    if (!isDefinedNumber(value)) return [];

    const palette = getSessionPalette(index);
    return [
      {
        id: comparison.session.id,
        shortId: comparison.session.id.slice(0, 8),
        agent: comparison.session.agent || 'unknown',
        status: comparison.session.status,
        value,
        formattedValue: definition.format(value),
        fill: palette.fill,
      },
    ];
  });
}

export function getChartMetricDefinition(metric: CompareChartMetric): CompareMetricDefinition {
  return CHART_METRICS.find((item) => item.key === metric) ?? CHART_METRICS[0];
}

export function buildComparisonExportPayload(comparisons: SessionComparisonData[]) {
  return {
    exportedAt: new Date().toISOString(),
    sessions: comparisons.map((comparison) => ({
      sessionId: comparison.session.id,
      shortId: comparison.session.id.slice(0, 8),
      status: comparison.session.status,
      objective: comparison.session.objective,
      agent: comparison.session.agent,
      model: comparison.session.model,
      gitBranch: comparison.session.git_branch,
      startedAt: comparison.session.started_at,
      endedAt: comparison.session.ended_at,
      durationMs: comparison.durationMs,
      metrics: Object.fromEntries(
        DETAILED_COMPARE_METRICS.map((metric) => [metric.key, metric.getValue(comparison)]),
      ),
      filesChanged: comparison.filesChanged,
      topCostFiles: comparison.topCostFiles,
    })),
  };
}

export function serializeComparisonJson(comparisons: SessionComparisonData[]): string {
  return JSON.stringify(buildComparisonExportPayload(comparisons), null, 2);
}

export function serializeComparisonCsv(comparisons: SessionComparisonData[]): string {
  const header = [
    'session_id',
    'short_id',
    'status',
    'objective',
    'agent',
    'model',
    'git_branch',
    'started_at',
    'ended_at',
    'duration_ms',
    ...DETAILED_COMPARE_METRICS.map((metric) => metric.key),
    'files_changed',
    'top_cost_files',
  ];

  const rows = comparisons.map((comparison) => {
    const metricValues = DETAILED_COMPARE_METRICS.map((metric) => metric.getValue(comparison));

    return [
      comparison.session.id,
      comparison.session.id.slice(0, 8),
      comparison.session.status,
      comparison.session.objective,
      comparison.session.agent || '',
      comparison.session.model || '',
      comparison.session.git_branch || '',
      comparison.session.started_at,
      comparison.session.ended_at || '',
      String(comparison.durationMs),
      ...metricValues.map((value) => (value == null ? '' : String(value))),
      comparison.filesChanged.join(' | '),
      comparison.topCostFiles.map((item) => `${item.path} (${item.cost.toFixed(4)})`).join(' | '),
    ];
  });

  return [header, ...rows].map((row) => row.map(escapeCsvValue).join(',')).join('\n');
}

export function formatCurrency(value: number | null): string {
  if (!isDefinedNumber(value)) return 'n/a';
  if (value === 0) return '$0.0000';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatCurrencyCompact(value: number | null): string {
  if (!isDefinedNumber(value)) return 'n/a';
  if (value < 1) return formatCurrency(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatInteger(value: number | null): string {
  if (!isDefinedNumber(value)) return 'n/a';
  return Math.round(value).toLocaleString();
}

export function formatIntegerCompact(value: number | null): string {
  if (!isDefinedNumber(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.round(value));
}

export function formatDriftScore(value: number | null): string {
  if (!isDefinedNumber(value)) return 'n/a';
  return `${Math.round(value)}/100`;
}

export function formatDuration(ms: number | null): string {
  if (!isDefinedNumber(ms)) return 'n/a';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatRelativeDate(iso: string): string {
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

export function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join('/')}`;
}

function isDefinedNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function escapeCsvValue(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
