#!/usr/bin/env node
/* global console, process */

const { spawnSync } = require('node:child_process');

const expectedVersion = '9.15.4';
const currentNodeMajor = Number(process.versions.node.split('.')[0]);

if (currentNodeMajor < 20) {
  console.error(
    [
      'Hawkeye requires Node.js 20 or newer.',
      `Current Node.js version: ${process.version}.`,
      'Upgrade Node before running this command.',
    ].join('\n'),
  );
  process.exit(1);
}

const result = spawnSync('pnpm', ['--version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.status === 0) {
  const actualVersion = result.stdout.trim();
  if (actualVersion !== expectedVersion) {
    console.warn(
      `Expected pnpm ${expectedVersion}, found ${actualVersion}. Continuing, but install mismatches may behave differently.`,
    );
  }
  process.exit(0);
}

console.error(
  [
    `This repository uses pnpm ${expectedVersion}, but the pnpm binary was not found.`,
    '',
    'Install it once, then rerun the command:',
    `  npm install -g pnpm@${expectedVersion}`,
    '',
    'Or, if your Node distribution includes Corepack:',
    '  corepack enable',
    `  corepack prepare pnpm@${expectedVersion} --activate`,
  ].join('\n'),
);

process.exit(1);
