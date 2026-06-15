/**
 * Package Scanner.
 *
 * Scans package.json, lockfiles, and node_modules for known compromised
 * packages using the IOC database. Designed to run:
 * - Before `npm install` (PreToolUse guardrail)
 * - As a standalone check (`hawkeye shield`)
 * - As a global npm preinstall hook
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../logger.js';
import type { IocDatabase, IocMatch } from './ioc.js';
import { matchPackage, matchHash, hashFile, loadIocDatabase } from './ioc.js';

const logger = new Logger('package-scanner');

export interface ScanTarget {
  name: string;
  version: string;
  source: 'package.json' | 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' | 'node_modules' | 'command';
}

export interface PackageScanResult {
  scanned: number;
  threats: IocMatch[];
  targets: ScanTarget[];
  duration: number;
  summary: string;
}

/** Extract packages from package.json dependencies */
function readPackageJson(dir: string): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const pkgPath = join(dir, 'package.json');

  if (!existsSync(pkgPath)) return targets;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };

    for (const [name, versionSpec] of Object.entries(allDeps)) {
      // Extract exact version from spec (^1.14.1 → 1.14.1, ~2.0.0 → 2.0.0)
      const version = String(versionSpec).replace(/^[\^~>=<\s]+/, '').split(' ')[0];
      targets.push({ name, version, source: 'package.json' });
    }
  } catch {
    logger.warn(`Failed to parse ${pkgPath}`);
  }

  return targets;
}

/** Extract resolved packages from package-lock.json (npm v7+) */
function readPackageLock(dir: string): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const lockPath = join(dir, 'package-lock.json');

  if (!existsSync(lockPath)) return targets;

  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));

    // npm v7+ format: { packages: { "node_modules/foo": { version: "..." } } }
    if (lock.packages) {
      for (const [path, info] of Object.entries(lock.packages)) {
        if (!path || path === '') continue; // root package
        const p = info as Record<string, unknown>;
        const name = path.replace(/^node_modules\//, '').replace(/^.*node_modules\//, '');
        const version = String(p.version || '');
        if (name && version) {
          targets.push({ name, version, source: 'package-lock.json' });
        }
      }
    }

    // npm v6 format: { dependencies: { foo: { version: "..." } } }
    if (lock.dependencies && !lock.packages) {
      const walk = (deps: Record<string, unknown>, prefix = '') => {
        for (const [name, info] of Object.entries(deps)) {
          const d = info as Record<string, unknown>;
          const fullName = prefix ? `${prefix}/${name}` : name;
          targets.push({
            name: fullName,
            version: String(d.version || ''),
            source: 'package-lock.json',
          });
          if (d.dependencies) {
            walk(d.dependencies as Record<string, unknown>, '');
          }
        }
      };
      walk(lock.dependencies);
    }
  } catch {
    logger.warn(`Failed to parse ${lockPath}`);
  }

  return targets;
}

/** Extract packages from pnpm-lock.yaml (simplified parsing — no YAML dep) */
function readPnpmLock(dir: string): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const lockPath = join(dir, 'pnpm-lock.yaml');

  if (!existsSync(lockPath)) return targets;

  try {
    const content = readFileSync(lockPath, 'utf-8');

    // Match patterns like: /axios@1.14.1: or axios@1.14.1(...)
    // pnpm v9: entries like  'axios@1.14.1':
    const patterns = [
      /['"]?\/?([^@\s'"]+)@(\d+\.\d+\.\d+[^'"\s:(]*)/g,
    ];

    const seen = new Set<string>();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1];
        const version = match[2];
        const key = `${name}@${version}`;
        if (!seen.has(key) && name && version) {
          seen.add(key);
          targets.push({ name, version, source: 'pnpm-lock.yaml' });
        }
      }
    }
  } catch {
    logger.warn(`Failed to parse ${lockPath}`);
  }

  return targets;
}

/** Extract packages from yarn.lock */
function readYarnLock(dir: string): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const lockPath = join(dir, 'yarn.lock');

  if (!existsSync(lockPath)) return targets;

  try {
    const content = readFileSync(lockPath, 'utf-8');

    // Yarn v1 format: name@version:\n  version "resolved.version"
    // Yarn berry: name@npm:version:\n  version: resolved.version
    const versionLine = /^\s+version:?\s+"?(\d+\.\d+\.\d+[^"'\s]*)"?/;
    const entryLine = /^"?([^@\s"]+)@/;

    let currentName = '';
    for (const line of content.split('\n')) {
      const entry = line.match(entryLine);
      if (entry && !line.startsWith(' ')) {
        currentName = entry[1];
      }
      const ver = line.match(versionLine);
      if (ver && currentName) {
        targets.push({
          name: currentName,
          version: ver[1],
          source: 'yarn.lock',
        });
        currentName = '';
      }
    }
  } catch {
    logger.warn(`Failed to parse ${lockPath}`);
  }

  return targets;
}

/** Parse a CLI install command for specific packages being installed */
export function parseInstallCommand(command: string): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const parts = command.trim().split(/\s+/);

  // Skip the package manager and install subcommand
  let i = 0;
  // Skip: npm/pnpm/yarn/bun
  if (['npm', 'pnpm', 'yarn', 'bun', 'npx'].includes(parts[0])) i++;
  // Skip: install/i/add/ci
  if (i < parts.length && ['install', 'i', 'add', 'ci'].includes(parts[i])) i++;

  for (; i < parts.length; i++) {
    const arg = parts[i];
    // Skip flags
    if (arg.startsWith('-')) {
      // Skip flag values for flags that take them
      if (['--save-dev', '--save-peer', '--save-optional', '-D', '-P', '-O', '-E', '--exact'].includes(arg)) continue;
      if (arg === '--registry' || arg === '--cache') { i++; continue; }
      continue;
    }

    // Parse package@version
    const atIdx = arg.lastIndexOf('@');
    if (atIdx > 0) {
      targets.push({
        name: arg.slice(0, atIdx),
        version: arg.slice(atIdx + 1),
        source: 'command',
      });
    } else if (arg && !arg.startsWith('.') && !arg.startsWith('/')) {
      // Package without version — check if it has a known compromised *latest* tag
      targets.push({ name: arg, version: 'latest', source: 'command' });
    }
  }

  return targets;
}

/** Scan installed node_modules for tarballs with known bad hashes */
function scanNodeModulesHashes(dir: string, db: IocDatabase): IocMatch[] {
  const matches: IocMatch[] = [];

  // Only check if we have hashes to match against
  if (db.hashes.length === 0) return matches;

  const nmDir = join(dir, 'node_modules');
  if (!existsSync(nmDir)) return matches;

  // Check package.json files in node_modules for integrity hashes
  try {
    const entries = readdirSync(nmDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      // Handle scoped packages (@org/pkg)
      if (entry.name.startsWith('@')) {
        try {
          const scopeDir = join(nmDir, entry.name);
          const scopeEntries = readdirSync(scopeDir, { withFileTypes: true });
          for (const se of scopeEntries) {
            if (!se.isDirectory()) continue;
            checkModuleIntegrity(join(scopeDir, se.name), db, matches);
          }
        } catch { continue; }
      } else {
        checkModuleIntegrity(join(nmDir, entry.name), db, matches);
      }
    }
  } catch {
    // Can't read node_modules — that's fine
  }

  return matches;
}

function checkModuleIntegrity(
  modulePath: string,
  db: IocDatabase,
  matches: IocMatch[],
): void {
  const pkgJsonPath = join(modulePath, 'package.json');
  if (!existsSync(pkgJsonPath)) return;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    // Check if there are any suspicious scripts
    const scripts = pkgJson.scripts || {};
    const suspiciousScripts = ['preinstall', 'postinstall', 'install'];
    for (const hook of suspiciousScripts) {
      const script = scripts[hook];
      if (!script) continue;
      // Check if the script references any known bad domains
      for (const iocDomain of db.domains) {
        if (script.includes(iocDomain.host)) {
          matches.push({
            type: 'domain',
            severity: iocDomain.severity,
            indicator: `${pkgJson.name}@${pkgJson.version} → ${hook}: ${iocDomain.host}`,
            description: `Package ${pkgJson.name} has a ${hook} script referencing known malicious host: ${iocDomain.description}`,
            reference: iocDomain.reference,
          });
        }
      }
    }
  } catch { /* ignore unreadable package.json */ }
}

/**
 * Full package scan: check all lockfiles + node_modules against IOC database.
 */
export function scanPackages(
  dir: string,
  db?: IocDatabase,
  extraTargets?: ScanTarget[],
): PackageScanResult {
  const start = Date.now();
  const iocDb = db || loadIocDatabase();
  const threats: IocMatch[] = [];

  // Collect all targets from all sources
  const allTargets: ScanTarget[] = [
    ...readPackageJson(dir),
    ...readPackageLock(dir),
    ...readPnpmLock(dir),
    ...readYarnLock(dir),
    ...(extraTargets || []),
  ];

  // Deduplicate
  const seen = new Set<string>();
  const uniqueTargets: ScanTarget[] = [];
  for (const t of allTargets) {
    const key = `${t.name}@${t.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTargets.push(t);
    }
  }

  // Check each target against IOC packages
  for (const target of uniqueTargets) {
    if (target.version === 'latest') {
      // For 'latest', check if any version of this package is compromised
      const pkg = iocDb.packages.find((p) => p.name === target.name);
      if (pkg) {
        threats.push({
          type: 'package',
          severity: pkg.severity,
          indicator: `${target.name}@latest (known compromised versions: ${pkg.versions.join(', ')})`,
          description: `Package "${target.name}" has known compromised versions. Verify resolved version is not: ${pkg.versions.join(', ')}. ${pkg.description}`,
          reference: pkg.reference,
          attribution: pkg.attribution,
        });
      }
    } else {
      const m = matchPackage(target.name, target.version, iocDb);
      if (m) {
        m.indicator = `${m.indicator} (found in ${target.source})`;
        threats.push(m);
      }
    }
  }

  // Scan node_modules for IOC domains in scripts and hash matches
  threats.push(...scanNodeModulesHashes(dir, iocDb));

  const duration = Date.now() - start;
  const critical = threats.filter((t) => t.severity === 'critical').length;
  const high = threats.filter((t) => t.severity === 'high').length;

  let summary: string;
  if (threats.length === 0) {
    summary = `Scanned ${uniqueTargets.length} packages in ${duration}ms — no known threats found.`;
  } else {
    summary = `THREAT DETECTED: ${threats.length} IOC match(es) in ${uniqueTargets.length} packages (${critical} critical, ${high} high). ` +
      threats.map((t) => `[${t.severity.toUpperCase()}] ${t.indicator}`).join('; ');
  }

  return {
    scanned: uniqueTargets.length,
    threats,
    targets: uniqueTargets,
    duration,
    summary,
  };
}
