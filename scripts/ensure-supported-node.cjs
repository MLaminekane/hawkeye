#!/usr/bin/env node
/* global console, process */

const currentMajor = Number(process.versions.node.split('.')[0]);

if (currentMajor >= 20) {
  process.exit(0);
}

console.error(
  [
    'Hawkeye requires Node.js 20 or newer.',
    `Current Node.js version: ${process.version}.`,
    'Upgrade Node before installing, building, or testing Hawkeye.',
  ].join('\n'),
);

process.exit(1);
