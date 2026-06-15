#!/usr/bin/env node
/* global console, process */

const execPath = process.env.npm_execpath || '';

if (execPath.includes('pnpm')) {
  process.exit(0);
}

console.error(
  [
    'Use pnpm publish for Hawkeye packages.',
    'pnpm converts workspace: dependency ranges to registry-safe semver ranges during publish.',
    'npm publish would leak workspace: ranges into the published package.',
  ].join('\n'),
);

process.exit(1);
