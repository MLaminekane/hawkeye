#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isNativeSqliteBindingError,
  printNativeSqliteHelp,
  warnIfUntestedNodeVersion,
} from './node-version.js';

function readCliVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as {
    version?: string;
  };
  return packageJson.version ?? '0.3.0';
}

function printBootstrapHelp(): void {
  console.log(`Usage: hawkeye [options] [command]

The flight recorder for AI agents

Options:
  -V, --version     output the version number
  -h, --help        display help for command

Commands:
  analyze           analyze a recorded session
  approve           manage approval records
  autocorrect       run autocorrection workflows
  ci                run CI guardrail checks
  compare           compare recorded sessions
  daemon            manage background task execution
  end               end an active session
  export            export session data
  hooks             manage agent hooks
  init              initialize Hawkeye in this repo
  inspect           inspect a session
  mcp               start the MCP server
  memory            inspect session memory
  otel-export       export OpenTelemetry data
  overnight         run overnight automation
  policy            manage policies
  record            record a command
  replay            replay a session
  report            generate reports
  restart           restart a session
  revert            revert session changes
  serve             serve the dashboard
  sessions          list sessions
  shield            run supply-chain and firewall checks
  stats             show statistics
  swarm             coordinate multi-agent work

Run hawkeye <command> --help for command-specific options.`);
}

const userArgs = process.argv.slice(2);
if (userArgs.includes('--version') || userArgs.includes('-V')) {
  console.log(readCliVersion());
  process.exit(0);
}

if (userArgs[0] === '--help' || userArgs[0] === '-h') {
  printBootstrapHelp();
  process.exit(0);
}

warnIfUntestedNodeVersion();

try {
  await import('./main.js');
} catch (error) {
  if (isNativeSqliteBindingError(error)) {
    printNativeSqliteHelp();
    process.exit(1);
  }

  throw error;
}
