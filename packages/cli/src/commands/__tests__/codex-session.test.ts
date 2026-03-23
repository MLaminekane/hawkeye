import { describe, expect, it } from 'vitest';
import {
  buildCommandEventFromCodexOutput,
  consumeCodexJsonLine,
  createCodexLineState,
} from '../codex-session.js';

describe('codex-session', () => {
  it('converts exec_command calls into Hawkeye command events', () => {
    const state = createCodexLineState();

    expect(consumeCodexJsonLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({
          cmd: 'pwd',
          workdir: '/tmp/project',
        }),
      },
    }), state)).toEqual([]);

    const events = consumeCodexJsonLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Command: /bin/zsh -lc pwd\nChunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 11\nOutput:\n/tmp/project\n',
      },
    }), state);

    expect(events).toEqual([{
      command: 'pwd',
      args: [],
      cwd: '/tmp/project',
      exitCode: 0,
      stdout: '/tmp/project',
    }]);
  });

  it('ignores unrelated lines and unknown call ids', () => {
    const state = createCodexLineState();

    expect(consumeCodexJsonLine('not json', state)).toEqual([]);
    expect(consumeCodexJsonLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'missing',
        output: 'Command: /bin/zsh -lc ls',
      },
    }), state)).toEqual([]);
  });

  it('extracts exit code and stdout from function output text', () => {
    const event = buildCommandEventFromCodexOutput(
      {
        command: 'rg --files',
        cwd: '/Users/test/project',
      },
      'Command: /bin/zsh -lc "rg --files"\nChunk ID: def456\nWall time: 0.1000 seconds\nProcess exited with code 1\nOriginal token count: 42\nOutput:\nREADME.md\npackage.json\n',
    );

    expect(event).toEqual({
      command: 'rg --files',
      args: [],
      cwd: '/Users/test/project',
      exitCode: 1,
      stdout: 'README.md\npackage.json',
    });
  });
});
