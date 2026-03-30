import chalk from 'chalk';
import type { SessionRow } from '@mklamine/hawkeye-core';
import { COMMANDS } from './interactive-constants.js';

export const o = chalk.hex('#ff5f1f');

export function tw(): number {
  return Math.min(process.stdout.columns || 80, 120);
}

export function hr(ch = '─', indent = 2): string {
  return ch.repeat(Math.max(10, tw() - indent));
}

export function dur(startedAt: string, endedAt: string | null): string {
  const ms = (endedAt ? new Date(endedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function badge(status: string): string {
  if (status === 'recording') return o('● REC');
  if (status === 'completed') return chalk.green('● END');
  return chalk.red('● ABR');
}

export function printBanner(version: string): void {
  console.log('');
  console.log(`   ${o('██╗  ██╗')}`);
  console.log(`   ${o('██║  ██║')}`);
  console.log(`   ${o('███████║')}  ${chalk.bold.white('Hawkeye')} ${chalk.dim(`v${version}`)}`);
  console.log(`   ${o('██╔══██║')}  ${chalk.dim('The flight recorder for AI agents')}`);
  console.log(`   ${o('██║  ██║')}  ${chalk.dim(process.cwd())}`);
  console.log(`   ${o('╚═╝  ╚═╝')}`);
  console.log('');
}

export function printSession(index: number, session: SessionRow): void {
  const width = tw();
  const maxObjective = Math.max(15, width - 55);
  const objectiveText =
    session.objective.length > maxObjective
      ? session.objective.slice(0, maxObjective - 1) + '…'
      : session.objective.padEnd(maxObjective);
  const cost =
    session.total_cost_usd > 0 ? chalk.hex('#FFB443')(`$${session.total_cost_usd.toFixed(2)}`) : '';

  console.log(
    `  ${o.bold(`${index})`)} ${badge(session.status)} ${chalk.dim(session.id.slice(0, 8))}  ${chalk.white(objectiveText)}  ${chalk.dim(dur(session.started_at, session.ended_at).padEnd(7))} ${chalk.dim(String(session.total_actions).padStart(3))}a ${cost} ${chalk.dim(timeAgo(session.started_at))}`,
  );
}

export function printCommands(): void {
  console.log('');
  for (const command of COMMANDS) {
    console.log(`    ${o(`/${command.name.padEnd(14)}`)} ${chalk.dim(command.desc)}`);
  }
  console.log('');
}
