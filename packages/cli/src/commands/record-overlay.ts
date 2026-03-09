import chalk from 'chalk';

const o = chalk.hex('#ff5f1f');

export interface OverlayState {
  sessionId: string;
  objective: string;
  agent: string;
  eventCount: number;
  costUsd: number;
  driftScore: number | null;
  driftFlag: 'ok' | 'warning' | 'critical' | null;
  lastEventType: string | null;
  lastEventSummary: string | null;
  paused: boolean;
}

/**
 * Recording status overlay.
 * Renders a one-time banner to stderr on start, then updates the terminal
 * title bar for live status. This avoids cursor-position conflicts with
 * child process output (which shares the same terminal).
 */
export class RecordOverlay {
  private state: OverlayState;
  private interval: ReturnType<typeof setInterval> | null = null;
  private bannerShown = false;

  constructor(init: Pick<OverlayState, 'sessionId' | 'objective' | 'agent'>) {
    this.state = {
      ...init,
      eventCount: 0,
      costUsd: 0,
      driftScore: null,
      driftFlag: null,
      lastEventType: null,
      lastEventSummary: null,
      paused: false,
    };
  }

  start(): void {
    if (!this.bannerShown) {
      this.renderBanner();
      this.bannerShown = true;
    }
    this.updateTitle();
    this.interval = setInterval(() => this.updateTitle(), 1000);
  }

  update(partial: Partial<OverlayState>): void {
    Object.assign(this.state, partial);
    this.updateTitle();
  }

  /** One-time static banner printed at the start of recording. */
  private renderBanner(): void {
    const s = this.state;
    const W = 64;
    const sid = s.sessionId.slice(0, 8);

    const title = ` Hawkeye Recording `;
    const topPad = W - title.length - 1;
    const top = o(`┌─${title}${'─'.repeat(topPad)}┐`);
    const row1 = padLine(`Session: ${chalk.cyan(sid)}  │  Agent: ${chalk.white(s.agent)}  │  ${o('● REC')}`, W);
    const row2 = padLine(`Objective: ${chalk.dim(truncate(s.objective, W - 14))}`, W);
    const row3 = padLine(chalk.dim('Live status in terminal title bar ↑'), W);
    const bottom = o(`└${'─'.repeat(W + 2)}┘`);

    for (const line of [top, row1, row2, row3, bottom]) {
      process.stderr.write(`${line}\n`);
    }
    process.stderr.write('\n');
  }

  /** Update terminal title bar with live status (no cursor conflicts). */
  private updateTitle(): void {
    const s = this.state;
    const sid = s.sessionId.slice(0, 8);
    const status = s.paused ? '⏸ Paused' : '● REC';
    const drift = s.driftScore !== null
      ? `Drift: ${s.driftScore}/100 ${(s.driftFlag || 'ok').toUpperCase()}`
      : '';
    const parts = [
      `🔴 Hawkeye ${status}`,
      `${s.eventCount} actions`,
      `$${s.costUsd.toFixed(4)}`,
      drift,
      sid,
    ].filter(Boolean);

    // OSC 0 = set window title (supported by all modern terminals)
    process.stderr.write(`\x1B]0;${parts.join(' | ')}\x07`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Reset terminal title
    process.stderr.write('\x1B]0;\x07');
  }
}

function padLine(content: string, width: number): string {
  // Strip ANSI for length calculation
  const stripped = content.replace(/\x1B\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - stripped.length);
  return `${o('│')} ${content}${' '.repeat(pad)} ${o('│')}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}


