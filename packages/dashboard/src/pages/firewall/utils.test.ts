import { describe, expect, it } from 'vitest';
import type { EventData } from '../../api';
import {
  buildInitialActionFeed,
  parseEventToAction,
  sortActions,
  type ActionItem,
} from './utils';

function makeEvent(overrides: Partial<EventData> = {}): EventData {
  return {
    id: 'evt-1',
    session_id: 'session-1',
    sequence: 1,
    timestamp: '2026-03-29T10:00:00.000Z',
    type: 'command',
    data: JSON.stringify({ command: 'npm', args: ['test'], exitCode: 1 }),
    drift_score: null,
    drift_flag: null,
    cost_usd: 0,
    duration_ms: 1200,
    ...overrides,
  };
}

describe('interception utils', () => {
  it('parses failed commands as warned actions', () => {
    const action = parseEventToAction(makeEvent(), 'medium', 'session-1');

    expect(action.toolName).toBe('Bash');
    expect(action.status).toBe('warned');
    expect(action.summary).toContain('npm test');
  });

  it('merges recent actions, blocks, and pending reviews without duplicates', () => {
    const block = makeEvent({ type: 'guardrail_block', data: JSON.stringify({ description: 'blocked' }) });
    const feed = buildInitialActionFeed({
      recentActions: [{ ...block, risk: 'critical' }],
      blocks: [block],
      pendingReviews: [
        {
          id: 'review-1',
          timestamp: '2026-03-29T10:01:00.000Z',
          sessionId: 'session-2',
          command: 'git push --force',
          matchedPattern: 'force push',
        },
      ],
    });

    expect(feed).toHaveLength(2);
    expect(feed.find((item) => item.id === 'evt-1')?.status).toBe('blocked');
    expect(feed.find((item) => item.id === 'review-1')?.status).toBe('pending');
  });

  it('sorts pending and blocked items first in risk mode', () => {
    const low: ActionItem = {
      id: 'low',
      timestamp: '2026-03-29T10:00:00.000Z',
      type: 'command',
      risk: 'low',
      summary: 'low',
      details: [],
      toolName: 'Bash',
      sessionId: 's-1',
      status: 'allowed',
      cost: 0,
    };
    const pending: ActionItem = {
      ...low,
      id: 'pending',
      timestamp: '2026-03-29T09:59:00.000Z',
      risk: 'high',
      status: 'pending',
    };

    expect(sortActions([low, pending], 'risk').map((item) => item.id)).toEqual(['pending', 'low']);
  });
});
