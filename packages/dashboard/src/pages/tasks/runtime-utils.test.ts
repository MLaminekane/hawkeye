import { describe, expect, it } from 'vitest';
import {
  buildClineAgentCommand,
  describeClineMode,
  describeDaemonStatus,
  formatTaskDuration,
  getTaskAgentLabel,
  getTaskFailureSuggestion,
} from './runtime-utils';

describe('tasks utils', () => {
  it('shortens local runtime agent labels', () => {
    expect(getTaskAgentLabel('ollama/qwen3.5:cloud')).toBe('qwen3.5:cloud');
    expect(getTaskAgentLabel('lmstudio/deepseek-r1')).toBe('deepseek-r1');
    expect(getTaskAgentLabel('claude')).toBe('Claude Code');
    expect(getTaskAgentLabel('claude-api/claude-sonnet-4-6')).toBe('Claude API · claude-sonnet-4-6');
    expect(getTaskAgentLabel('cline/deepseek/deepseek-chat')).toBe('Cline · deepseek-chat');
    expect(getTaskAgentLabel('cline')).toBe('Cline default');
    expect(getTaskAgentLabel('aider --model anthropic/claude-sonnet-4-6 --map-tokens 0')).toBe('Aider · claude-sonnet-4-6');
    expect(getTaskAgentLabel('aider --no-show-model-warnings --no-auto-commits --map-tokens 0')).toBe('Aider default');
  });

  it('builds cline task commands from provider settings', () => {
    expect(buildClineAgentCommand({
      mode: 'configured',
      model: '',
    })).toBe('cline');

    expect(buildClineAgentCommand({
      mode: 'deepseek',
      model: 'deepseek-chat',
    })).toBe('cline/deepseek/deepseek-chat');

    expect(buildClineAgentCommand({
      mode: 'openai',
      model: 'gpt-4o',
    })).toBe('cline/openai-native/gpt-4o');

    expect(describeClineMode('configured')).toContain('Cline Credits');
  });

  it('formats execution durations for finished and running tasks', () => {
    expect(formatTaskDuration({
      status: 'completed',
      startedAt: '2026-03-29T10:00:00.000Z',
      completedAt: '2026-03-29T10:03:12.000Z',
    })).toBe('3m 12s');

    expect(formatTaskDuration({
      status: 'running',
      startedAt: '2026-03-29T10:00:00.000Z',
    }, new Date('2026-03-29T10:00:42.000Z').getTime())).toBe('42s');
  });

  it('surfaces actionable failure suggestions', () => {
    expect(getTaskFailureSuggestion({
      error: 'Credit balance is too low to proceed.',
      output: '',
    })).toContain('top up credits');

    expect(getTaskFailureSuggestion({
      error: 'dial tcp 127.0.0.1:11434: connect: connection refused',
      output: '',
    })).toContain('local runtime is online');

    expect(getTaskFailureSuggestion({
      error: 'The number of tokens to keep from the initial prompt is greater than the context length (n_keep: 11779>= n_ctx: 4096).',
      output: '',
    })).toContain('context is too small for Cline');
  });

  it('describes daemon state clearly', () => {
    expect(describeDaemonStatus(null)).toEqual({
      tone: 'warning',
      value: 'stopped',
      detail: 'Start `hawkeye daemon` to execute queued tasks.',
    });

    expect(describeDaemonStatus({
      running: true,
      agent: 'claude',
      startedAt: '2026-03-29T10:00:00.000Z',
      lastHeartbeatAt: '2026-03-29T10:00:05.000Z',
      intervalSec: 15,
      currentTaskId: 'task-12345678',
      currentTaskPid: 42,
    }).detail).toContain('Running task-123');
  });
});
