import { Command } from 'commander';
import chalk from 'chalk';
import { type EventRow } from '@mklamine/hawkeye-core';
import { formatAmbiguousSessionMessage, openTraceStorage, resolveSession, traceDbExists } from './storage-helpers.js';

export const replayCommand = new Command('replay')
  .description('Replay a recorded session action by action')
  .argument('<session-id>', 'Session ID (full or prefix)')
  .option('--speed <multiplier>', 'Playback speed multiplier', '1')
  .option('--no-delay', 'Show all events immediately without delay')
  .option('-i, --interactive', 'Interactive mode with keyboard navigation')
  .action(async (sessionId: string, options) => {
    if (!traceDbExists()) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      return;
    }

    const storage = openTraceStorage();

    const sessionMatch = resolveSession(storage, sessionId);
    if (sessionMatch.kind === 'ambiguous') {
      console.error(chalk.yellow(formatAmbiguousSessionMessage(sessionMatch.matches)));
      storage.close();
      return;
    }
    if (!sessionMatch.session) {
      console.error(chalk.red(`Session not found: ${sessionId}`));
      storage.close();
      return;
    }
    const resolved = sessionMatch.session.id;

    const sessionResult = storage.getSession(resolved);
    const eventsResult = storage.getEvents(resolved);
    storage.close();

    if (!sessionResult.ok || !sessionResult.value) {
      console.error(chalk.red('Failed to load session.'));
      return;
    }

    const session = sessionResult.value;
    const events = eventsResult.ok ? eventsResult.value : [];

    if (events.length === 0) {
      console.log(chalk.dim('No events to replay.'));
      return;
    }

    const speed = parseFloat(options.speed);
    const useDelay = options.delay !== false;

    console.log('');
    console.log(chalk.bold(`▶ Replaying session ${chalk.cyan(resolved.slice(0, 8))}`));
    console.log(chalk.dim(`  Objective: ${session.objective}`));
    console.log(chalk.dim(`  Events: ${events.length}`));
    console.log(chalk.dim('─'.repeat(60)));
    console.log('');

    if (options.interactive) {
      await interactiveReplay(events, session);
      return;
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const nextEvent = events[i + 1];

      printEvent(event, i + 1, events.length);

      // Delay between events based on original timing
      if (useDelay && nextEvent) {
        const gap = new Date(nextEvent.timestamp).getTime() - new Date(event.timestamp).getTime();
        const delay = Math.min(Math.max(gap / speed, 50), 3000); // Cap between 50ms and 3s
        await sleep(delay);
      }
    }

    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.green('▶ Replay complete'));
    console.log('');
  });

function printEvent(event: EventRow, index: number, total: number): void {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const counter = chalk.dim(`[${String(index).padStart(String(total).length)}/${total}]`);
  const data = JSON.parse(event.data);

  let icon: string;
  let summary: string;

  switch (event.type) {
    case 'command':
      icon = chalk.blue('$');
      summary = `${data.command} ${(data.args || []).join(' ')}`;
      if (data.exitCode != null && data.exitCode !== 0) {
        summary += chalk.red(` (exit ${data.exitCode})`);
      }
      break;
    case 'file_write':
      icon = chalk.green('✎');
      summary = `Modified ${data.path}`;
      if (data.sizeBytes) summary += chalk.dim(` (${formatBytes(data.sizeBytes)})`);
      break;
    case 'file_delete':
      icon = chalk.red('✗');
      summary = `Deleted ${data.path}`;
      break;
    case 'file_read':
      icon = chalk.dim('◉');
      summary = `Read ${data.path}`;
      break;
    case 'llm_call':
      icon = chalk.magenta('⚡');
      summary = `${data.provider}/${data.model} (${data.totalTokens} tokens, $${data.costUsd?.toFixed(4) || '0'})`;
      break;
    case 'api_call':
      icon = chalk.cyan('→');
      summary = `${data.method} ${data.url} ${data.statusCode ? `(${data.statusCode})` : ''}`;
      break;
    case 'error':
      icon = chalk.red('!');
      summary = data.message || data.description || 'Error';
      break;
    case 'git_commit':
      icon = chalk.green('●');
      summary = `git commit ${data.commitHash || ''} ${data.message || ''}`.trim();
      break;
    case 'git_checkout':
      icon = chalk.blue('⎇');
      summary = `git checkout ${data.branch || ''}`;
      break;
    case 'git_push':
      icon = chalk.cyan('↑');
      summary = `git push ${data.branch || ''}`;
      break;
    case 'git_pull':
      icon = chalk.cyan('↓');
      summary = `git pull`;
      break;
    case 'git_merge':
      icon = chalk.magenta('⑂');
      summary = `git merge ${data.targetBranch || ''}`;
      break;
    case 'guardrail_trigger':
      icon = chalk.red('⛔');
      summary = data.description || 'Guardrail triggered';
      break;
    default:
      icon = chalk.dim('·');
      summary = event.type;
  }

  const driftStr = event.drift_score != null
    ? ` ${driftBadge(event.drift_score, event.drift_flag)}`
    : '';

  console.log(`  ${counter} ${chalk.dim(time)} ${icon} ${summary}${driftStr}`);
}

function driftBadge(score: number, flag: string | null): string {
  const text = `drift:${score.toFixed(0)}`;
  if (flag === 'critical') return chalk.red(text);
  if (flag === 'warning') return chalk.yellow(text);
  return chalk.green(text);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Interactive Replay ──────────────────────────────────────

async function interactiveReplay(events: EventRow[], session: { objective: string; id: string }): Promise<void> {
  let cursor = 0;

  const renderCurrent = () => {
    // Clear screen
    process.stdout.write('\x1B[2J\x1B[H');

    console.log(chalk.bold(`▶ Interactive Replay — ${chalk.cyan(session.id.slice(0, 8))}`));
    console.log(chalk.dim(`  ${session.objective}`));
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.dim(`  ← → navigate  │  q quit  │  d show diff`));
    console.log(chalk.dim('─'.repeat(60)));
    console.log('');

    // Show context: 2 events before, current (highlighted), 2 after
    const start = Math.max(0, cursor - 2);
    const end = Math.min(events.length, cursor + 3);

    for (let i = start; i < end; i++) {
      const isCurrent = i === cursor;
      const event = events[i];
      const prefix = isCurrent ? chalk.hex('#ff5f1f')('▸ ') : '  ';
      const line = formatEventLine(event, i + 1, events.length);
      console.log(prefix + (isCurrent ? chalk.white.bold(line) : chalk.dim(line)));
    }

    console.log('');

    // Show detail for current event
    const current = events[cursor];
    const data = JSON.parse(current.data);
    console.log(chalk.bold('  Event Detail'));
    console.log(chalk.dim('  ' + '─'.repeat(56)));
    console.log(`  Type:      ${current.type}`);
    console.log(`  Time:      ${new Date(current.timestamp).toLocaleTimeString()}`);
    if (current.cost_usd > 0) console.log(`  Cost:      $${current.cost_usd.toFixed(4)}`);
    if (current.drift_score != null) console.log(`  Drift:     ${driftBadge(current.drift_score, current.drift_flag)}`);
    console.log('');

    // Show relevant detail based on type
    if (current.type === 'command') {
      console.log(chalk.dim('  Command:'));
      console.log(`  ${chalk.cyan('$')} ${data.command} ${(data.args || []).join(' ')}`);
      if (data.exitCode != null) console.log(`  ${data.exitCode === 0 ? chalk.green('exit 0') : chalk.red(`exit ${data.exitCode}`)}`);
    } else if (current.type === 'file_write' || current.type === 'file_read' || current.type === 'file_delete') {
      console.log(chalk.dim(`  File: ${data.path}`));
      if (data.diff) {
        console.log('');
        printColoredDiff(data.diff);
      }
    } else if (current.type === 'llm_call') {
      console.log(chalk.dim(`  Provider: ${data.provider}/${data.model}`));
      console.log(chalk.dim(`  Tokens: ${data.totalTokens} (in: ${data.promptTokens}, out: ${data.completionTokens})`));
    }

    console.log('');
    console.log(chalk.dim(`  [${cursor + 1}/${events.length}]`));
  };

  renderCurrent();

  return new Promise<void>((resolve) => {
    if (!process.stdin.isTTY) {
      // Fallback: dump all events and exit
      for (let i = 0; i < events.length; i++) {
        printEvent(events[i], i + 1, events.length);
      }
      resolve();
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (key: string) => {
      if (key === 'q' || key === '\x03') {
        // q or Ctrl+C
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\x1B[2J\x1B[H');
        console.log(chalk.green('▶ Replay ended'));
        resolve();
        return;
      }

      if (key === '\x1B[C' || key === 'l' || key === ' ') {
        // Right arrow, l, or space → next
        if (cursor < events.length - 1) {
          cursor++;
          renderCurrent();
        }
      } else if (key === '\x1B[D' || key === 'h') {
        // Left arrow or h → previous
        if (cursor > 0) {
          cursor--;
          renderCurrent();
        }
      } else if (key === '\x1B[A' || key === 'k') {
        // Up arrow or k → previous
        if (cursor > 0) {
          cursor--;
          renderCurrent();
        }
      } else if (key === '\x1B[B' || key === 'j') {
        // Down arrow or j → next
        if (cursor < events.length - 1) {
          cursor++;
          renderCurrent();
        }
      } else if (key === 'g') {
        cursor = 0;
        renderCurrent();
      } else if (key === 'G') {
        cursor = events.length - 1;
        renderCurrent();
      } else if (key === 'd') {
        // Show full diff if this is a file event
        const data = JSON.parse(events[cursor].data);
        if (data.diff) {
          process.stdout.write('\x1B[2J\x1B[H');
          console.log(chalk.bold(`  Diff — ${data.path}`));
          console.log(chalk.dim('─'.repeat(60)));
          printColoredDiff(data.diff);
          console.log('');
          console.log(chalk.dim('  Press any key to go back...'));
        } else if (data.path) {
          process.stdout.write('\x1B[2J\x1B[H');
          console.log(chalk.dim(`  No diff data for ${data.path}`));
          console.log(chalk.dim('  (recorded before diff capture was enabled)'));
          console.log('');
          console.log(chalk.dim('  Press any key to go back...'));
        }
      } else {
        // Any other key returns to navigator from diff view
        renderCurrent();
      }
    };

    process.stdin.on('data', onData);
  });
}

function formatEventLine(event: EventRow, index: number, total: number): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const counter = `[${String(index).padStart(String(total).length)}/${total}]`;
  const data = JSON.parse(event.data);

  let summary: string;
  switch (event.type) {
    case 'command':
      summary = `$ ${data.command} ${(data.args || []).join(' ')}`;
      break;
    case 'file_write':
      summary = `✎ ${data.path}`;
      break;
    case 'file_delete':
      summary = `✗ ${data.path}`;
      break;
    case 'llm_call':
      summary = `⚡ ${data.provider}/${data.model}`;
      break;
    default:
      summary = event.type;
  }

  return `${counter} ${time} ${summary}`;
}

function printColoredDiff(diff: string): void {
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) {
      console.log(chalk.green(`  ${line}`));
    } else if (line.startsWith('-')) {
      console.log(chalk.red(`  ${line}`));
    } else {
      console.log(chalk.dim(`  ${line}`));
    }
  }
}
