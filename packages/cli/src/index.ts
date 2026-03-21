#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { recordCommand } from './commands/record.js';
import { sessionsCommand } from './commands/sessions.js';
import { statsCommand } from './commands/stats.js';
import { replayCommand } from './commands/replay.js';
import { serveCommand } from './commands/serve.js';
import { exportCommand } from './commands/export.js';
import { hooksCommand } from './commands/hooks.js';
import { hookHandlerCommand } from './commands/hook-handler.js';
import { otelExportCommand } from './commands/otel-export.js';
import { endCommand } from './commands/end.js';
import { restartCommand } from './commands/restart.js';
import { inspectCommand } from './commands/inspect.js';
import { compareCommand } from './commands/compare.js';
import { revertCommand } from './commands/revert.js';
import { approveCommand } from './commands/approve.js';
import { mcpCommand } from './commands/mcp.js';
import { daemonCommand } from './commands/daemon.js';
import { overnightCommand } from './commands/overnight.js';
import { reportCommand } from './commands/report.js';
import { policyCommand } from './commands/policy.js';
import { startInteractive } from './interactive.js';

const program = new Command();

program
  .name('hawkeye')
  .description('The flight recorder for AI agents')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(recordCommand);
program.addCommand(sessionsCommand);
program.addCommand(statsCommand);
program.addCommand(replayCommand);
program.addCommand(serveCommand);
program.addCommand(exportCommand);
program.addCommand(hooksCommand);
program.addCommand(hookHandlerCommand);
program.addCommand(otelExportCommand);
program.addCommand(endCommand);
program.addCommand(restartCommand);
program.addCommand(inspectCommand);
program.addCommand(compareCommand);
program.addCommand(revertCommand);
program.addCommand(approveCommand);
program.addCommand(mcpCommand);
program.addCommand(daemonCommand);
program.addCommand(overnightCommand);
program.addCommand(reportCommand);
program.addCommand(policyCommand);

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
