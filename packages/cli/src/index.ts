#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { analyzeCommand } from './commands/analyze.js';
import { approveCommand } from './commands/approve.js';
import { autocorrectCommand } from './commands/autocorrect.js';
import { initCommand } from './commands/init.js';
import { compareCommand } from './commands/compare.js';
import { daemonCommand } from './commands/daemon.js';
import { endCommand } from './commands/end.js';
import { exportCommand } from './commands/export.js';
import { hookHandlerCommand } from './commands/hook-handler.js';
import { hooksCommand } from './commands/hooks.js';
import { inspectCommand } from './commands/inspect.js';
import { mcpCommand } from './commands/mcp.js';
import { memoryCommand } from './commands/memory.js';
import { otelExportCommand } from './commands/otel-export.js';
import { overnightCommand } from './commands/overnight.js';
import { policyCommand } from './commands/policy.js';
import { recordCommand } from './commands/record.js';
import { replayCommand } from './commands/replay.js';
import { reportCommand } from './commands/report.js';
import { restartCommand } from './commands/restart.js';
import { revertCommand } from './commands/revert.js';
import { serveCommand } from './commands/serve.js';
import { sessionsCommand } from './commands/sessions.js';
import { statsCommand } from './commands/stats.js';
import { swarmCommand } from './commands/swarm.js';
import { startInteractive } from './interactive.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as { version?: string };
const cliVersion = packageJson.version ?? '0.1.13';

const program = new Command();
const compareCommands = (left: Command, right: Command) => left.name().localeCompare(right.name());

program
  .name('hawkeye')
  .description('The flight recorder for AI agents')
  .version(cliVersion);

[
  analyzeCommand,
  approveCommand,
  autocorrectCommand,
  compareCommand,
  daemonCommand,
  endCommand,
  exportCommand,
  hookHandlerCommand,
  hooksCommand,
  initCommand,
  inspectCommand,
  mcpCommand,
  memoryCommand,
  otelExportCommand,
  overnightCommand,
  policyCommand,
  recordCommand,
  replayCommand,
  reportCommand,
  restartCommand,
  revertCommand,
  serveCommand,
  sessionsCommand,
  statsCommand,
  swarmCommand,
]
  .sort(compareCommands)
  .forEach((command) => program.addCommand(command));

// If no subcommand is given, launch interactive mode
const knownCommands = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
const userArgs = process.argv.slice(2);
const hasSubcommand =
  userArgs.length > 0 &&
  (knownCommands.includes(userArgs[0]) || userArgs[0] === '--help' || userArgs[0] === '-h' || userArgs[0] === '--version' || userArgs[0] === '-V');

if (hasSubcommand) {
  program.parse();
} else {
  startInteractive();
}
