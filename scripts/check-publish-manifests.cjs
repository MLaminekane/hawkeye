#!/usr/bin/env node
/* global __dirname, console, process */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const manifests = ['packages/core/package.json', 'packages/cli/package.json'];
const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const supportedNodeRange = '>=20';
const failures = [];
const loadedManifests = new Map();

function readManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  loadedManifests.set(manifestPath, manifest);
  return manifest;
}

for (const manifestPath of manifests) {
  const manifest = readManifest(manifestPath);

  if (manifest.private) {
    continue;
  }

  if (manifest.engines?.node !== supportedNodeRange) {
    failures.push(`${manifestPath}: engines.node must be ${supportedNodeRange}`);
  }

  for (const section of dependencySections) {
    const deps = manifest[section] || {};
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        const allowedInternalCore =
          manifestPath === 'packages/cli/package.json' &&
          section === 'dependencies' &&
          name === '@mklamine/hawkeye-core' &&
          range === 'workspace:^';

        if (!allowedInternalCore) {
          failures.push(`${manifestPath}: ${section}.${name} uses ${range}`);
        }
      }
    }
  }
}

const cli = loadedManifests.get('packages/cli/package.json');
const actualCoreRange = cli.dependencies?.['@mklamine/hawkeye-core'];

if (actualCoreRange !== 'workspace:^') {
  failures.push(
    `packages/cli/package.json: dependencies.@mklamine/hawkeye-core must be workspace:^ for local linking and pnpm publish conversion, got ${actualCoreRange}`,
  );
}

if (failures.length > 0) {
  console.error('Publish manifest checks failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Publish manifests are registry-compatible.');
