import { describe, expect, it } from 'vitest';
import type { SessionComparisonData } from '../../api';
import {
  getMetricWinnerIndices,
  isComparableSession,
  isComparableSessionStatus,
  serializeComparisonCsv,
  serializeComparisonJson,
} from './utils';

function makeComparison(overrides: Partial<SessionComparisonData> = {}): SessionComparisonData {
  const session = {
    id: 'session-1',
    objective: 'Compare session output',
    agent: 'codex',
    model: 'gpt-5.4',
    working_dir: '/tmp/project',
    git_branch: 'main',
    started_at: '2026-03-29T10:00:00.000Z',
    ended_at: '2026-03-29T10:05:00.000Z',
    status: 'completed',
    total_cost_usd: 1.25,
    total_tokens: 1200,
    total_actions: 12,
    final_drift_score: 82,
    developer: 'lamine',
    ...(overrides.session ?? {}),
  };

  const base: SessionComparisonData = {
    session,
    stats: {
      total_events: 24,
      command_count: 5,
      file_count: 3,
      llm_count: 7,
      api_count: 1,
      git_count: 0,
      error_count: 1,
      guardrail_count: 0,
      total_cost_usd: 1.25,
      total_duration_ms: 300000,
      ...(overrides.stats ?? {}),
    },
    durationMs: 300000,
    filesChanged: ['src/compare.tsx'],
    topCostFiles: [{ path: 'src/compare.tsx', cost: 0.44 }],
  };

  return {
    ...base,
    ...overrides,
    session,
  };
}

describe('compare utils', () => {
  it('accepts all comparable session statuses', () => {
    expect(isComparableSessionStatus('recording')).toBe(true);
    expect(isComparableSessionStatus('paused')).toBe(true);
    expect(isComparableSessionStatus('completed')).toBe(true);
    expect(isComparableSessionStatus('aborted')).toBe(true);
    expect(isComparableSessionStatus('failed')).toBe(false);
    expect(isComparableSession({ status: 'paused' })).toBe(true);
  });

  it('requires at least two comparable values before picking winners', () => {
    expect(getMetricWinnerIndices([null, 72, null], 'high')).toEqual([]);
    expect(getMetricWinnerIndices([0.25, null, 0.1], 'low')).toEqual([2]);
  });

  it('returns all tied winners for low and high metrics', () => {
    expect(getMetricWinnerIndices([2, 4, 2], 'low')).toEqual([0, 2]);
    expect(getMetricWinnerIndices([90, 90, 82], 'high')).toEqual([0, 1]);
  });

  it('serializes CSV and JSON exports with top cost files', () => {
    const comparison = makeComparison();

    const csv = serializeComparisonCsv([comparison]);
    const json = serializeComparisonJson([comparison]);

    expect(csv).toContain('top_cost_files');
    expect(csv).toContain('src/compare.tsx (0.4400)');
    expect(json).toContain('"topCostFiles"');
    expect(json).toContain('"path": "src/compare.tsx"');
  });
});
