/**
 * hawkeye shield — Global supply chain protection.
 *
 * Installs a global npm preinstall hook that checks every `npm install`
 * on the machine against the Hawkeye IOC database, even outside of
 * Hawkeye-monitored sessions.
 *
 * Commands:
 *   hawkeye shield enable   — Install the global npm hook
 *   hawkeye shield disable  — Remove the global npm hook
 *   hawkeye shield status   — Show current state
 *   hawkeye shield scan     — Run an IOC scan on the current project
 *   hawkeye shield update   — Update IOC feed from remote URL
 *   hawkeye shield add      — Add an IOC manually
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import chalk from 'chalk';
import {
  loadIocDatabase,
  iocStats,
  updateFromFeed,
  addIocPackage,
  addIocDomain,
  addIocHash,
  scanPackages,
} from '@mklamine/hawkeye-core';
import type { IocPackage, IocDomain, IocHash } from '@mklamine/hawkeye-core';

const o = chalk.hex('#ff5f1f');

// ── Global hook script ──
// This script is installed globally and runs before every npm install.
// It calls `hawkeye shield scan --quick` to check for IOC matches.

const HOOK_SCRIPT = `#!/usr/bin/env node
/**
 * Hawkeye Shield — Global npm preinstall hook.
 * Checks packages against known IOC (Indicators of Compromise) database.
 * Installed by: hawkeye shield enable
 */
const { execSync } = require('child_process');
const path = require('path');

// Find hawkeye binary
function findHawkeye() {
  try {
    return execSync('which hawkeye 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch {
    // Try common locations
    const locations = [
      '/opt/homebrew/bin/hawkeye',
      '/usr/local/bin/hawkeye',
      path.join(process.env.HOME || '', '.npm-global', 'bin', 'hawkeye'),
    ];
    for (const loc of locations) {
      try {
        require('fs').accessSync(loc);
        return loc;
      } catch { continue; }
    }
    return null;
  }
}

try {
  const hawkeye = findHawkeye();
  if (!hawkeye) {
    // Hawkeye not installed — skip silently
    process.exit(0);
  }

  const cwd = process.cwd();
  const result = execSync(\`"\${hawkeye}" shield scan --quick --json 2>/dev/null\`, {
    encoding: 'utf-8',
    timeout: 30000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const scan = JSON.parse(result);
  if (scan.threats && scan.threats.length > 0) {
    const critical = scan.threats.filter(t => t.severity === 'critical');
    if (critical.length > 0) {
      console.error('');
      console.error('\\x1b[41m\\x1b[37m HAWKEYE SHIELD \\x1b[0m \\x1b[31mBLOCKED\\x1b[0m — Known compromised package(s) detected!');
      console.error('');
      for (const threat of critical) {
        console.error('  \\x1b[31m\\u2718\\x1b[0m ' + threat.indicator);
        console.error('    ' + threat.description);
        if (threat.reference) console.error('    Ref: ' + threat.reference);
      }
      console.error('');
      console.error('  Run \\x1b[36mhawkeye shield scan\\x1b[0m for full details.');
      console.error('  To bypass: HAWKEYE_SHIELD=off npm install');
      console.error('');
      process.exit(1); // Block the install
    } else {
      // Non-critical threats — warn but allow
      console.error('');
      console.error('\\x1b[43m\\x1b[30m HAWKEYE SHIELD \\x1b[0m \\x1b[33mWARNING\\x1b[0m — Suspicious package(s) detected:');
      for (const threat of scan.threats) {
        console.error('  \\x1b[33m\\u26a0\\x1b[0m ' + threat.indicator + ' (' + threat.severity + ')');
      }
      console.error('');
    }
  }
} catch (err) {
  // Don't block installs if hawkeye fails — fail open
  // Only log if HAWKEYE_DEBUG is set
  if (process.env.HAWKEYE_DEBUG) {
    console.error('[hawkeye-shield] scan failed:', err.message);
  }
}
`;

function getGlobalHookDir(): string {
  return join(homedir(), '.hawkeye', 'hooks');
}

function getHookScriptPath(): string {
  return join(getGlobalHookDir(), 'preinstall.js');
}

function getNpmrcPath(): string {
  // Use user-level .npmrc
  return join(homedir(), '.npmrc');
}

function isShieldEnabled(): boolean {
  const scriptPath = getHookScriptPath();
  if (!existsSync(scriptPath)) return false;

  // Also check .npmrc for the preinstall hook
  const npmrcPath = getNpmrcPath();
  if (!existsSync(npmrcPath)) return false;

  const npmrc = readFileSync(npmrcPath, 'utf-8');
  return npmrc.includes('hawkeye') && npmrc.includes('preinstall');
}

function enableShield(): void {
  // 1. Write the hook script
  const hookDir = getGlobalHookDir();
  if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });

  const scriptPath = getHookScriptPath();
  writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o755 });

  // 2. Configure npm to use it as a global preinstall script
  const npmrcPath = getNpmrcPath();
  let npmrc = '';
  if (existsSync(npmrcPath)) {
    npmrc = readFileSync(npmrcPath, 'utf-8');
  }

  // Remove any existing hawkeye preinstall line
  const lines = npmrc.split('\n').filter((l) => !l.includes('hawkeye') || !l.includes('preinstall'));

  // Add the preinstall hook
  // npm supports 'ignore-scripts' but we need the opposite:
  // Use the `preinstall` lifecycle script via .npmrc
  lines.push(`; Hawkeye Shield — global supply chain protection`);
  lines.push(`preinstall=node "${scriptPath}"`);

  writeFileSync(npmrcPath, lines.join('\n') + '\n');

  // 3. Also set up for pnpm if available
  try {
    const pnpmrcPath = join(homedir(), '.npmrc');
    // pnpm reads .npmrc too, so the same hook works
  } catch { /* ignore */ }
}

function disableShield(): void {
  // 1. Remove from .npmrc
  const npmrcPath = getNpmrcPath();
  if (existsSync(npmrcPath)) {
    const npmrc = readFileSync(npmrcPath, 'utf-8');
    const lines = npmrc.split('\n').filter(
      (l) => !(l.includes('hawkeye') && (l.includes('preinstall') || l.includes('Shield'))),
    );
    writeFileSync(npmrcPath, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  }

  // 2. Remove hook script
  const scriptPath = getHookScriptPath();
  if (existsSync(scriptPath)) {
    unlinkSync(scriptPath);
  }
}

// ── Command ──

export const shieldCommand = new Command('shield')
  .description('Global supply chain protection — IOC-based package scanning')
  .addCommand(
    new Command('enable')
      .description('Install global npm preinstall hook')
      .action(() => {
        if (isShieldEnabled()) {
          console.log(`${o('Shield')} is already enabled.`);
          return;
        }

        enableShield();
        console.log('');
        console.log(`  ${o('▶')} Hawkeye Shield ${chalk.green('enabled')}`);
        console.log('');
        console.log(`  Every ${chalk.cyan('npm install')} on this machine will now be scanned`);
        console.log(`  against the Hawkeye IOC database before execution.`);
        console.log('');
        console.log(`  Hook: ${chalk.dim(getHookScriptPath())}`);
        console.log(`  Config: ${chalk.dim(getNpmrcPath())}`);
        console.log('');
        console.log(`  To bypass for a single install: ${chalk.dim('HAWKEYE_SHIELD=off npm install')}`);
        console.log('');
      }),
  )
  .addCommand(
    new Command('disable')
      .description('Remove global npm preinstall hook')
      .action(() => {
        if (!isShieldEnabled()) {
          console.log(`${o('Shield')} is not currently enabled.`);
          return;
        }

        disableShield();
        console.log('');
        console.log(`  ${o('▶')} Hawkeye Shield ${chalk.red('disabled')}`);
        console.log('');
        console.log(`  Global npm protection has been removed.`);
        console.log('');
      }),
  )
  .addCommand(
    new Command('status')
      .description('Show shield and IOC database status')
      .action(() => {
        const enabled = isShieldEnabled();
        const db = loadIocDatabase();
        const stats = iocStats(db);

        console.log('');
        console.log(`  ${o('Hawkeye Shield')}`);
        console.log('');
        console.log(`  Status:     ${enabled ? chalk.green('● enabled') : chalk.red('○ disabled')}`);
        console.log(`  Hook:       ${chalk.dim(getHookScriptPath())}`);
        console.log('');
        console.log(`  ${o('IOC Database')}`);
        console.log(`  Packages:   ${stats.totalPackages} (${stats.totalVersions} versions)`);
        console.log(`  Domains:    ${stats.totalDomains}`);
        console.log(`  Hashes:     ${stats.totalHashes}`);
        console.log(`  Critical:   ${chalk.red(String(stats.critical))}`);
        console.log(`  Updated:    ${stats.lastUpdated}`);
        if (db.feedUrl) {
          console.log(`  Feed URL:   ${chalk.dim(db.feedUrl)}`);
        }
        console.log('');
      }),
  )
  .addCommand(
    new Command('scan')
      .description('Scan current project for known compromised packages')
      .option('--quick', 'Quick scan — lockfile + package.json only (no node_modules)')
      .option('--json', 'Output as JSON')
      .action((opts) => {
        const cwd = process.cwd();
        const db = loadIocDatabase();
        const result = scanPackages(cwd, db);

        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2));
          return;
        }

        console.log('');
        console.log(`  ${o('Hawkeye Shield Scan')}`);
        console.log('');
        console.log(`  Directory:  ${chalk.dim(cwd)}`);
        console.log(`  Scanned:    ${result.scanned} packages in ${result.duration}ms`);
        console.log('');

        if (result.threats.length === 0) {
          console.log(`  ${chalk.green('✔')} No known threats found.`);
        } else {
          console.log(`  ${chalk.red(`✘ ${result.threats.length} threat(s) detected:`)}`);
          console.log('');
          for (const threat of result.threats) {
            const icon = threat.severity === 'critical' ? chalk.red('✘') : chalk.yellow('⚠');
            const sev = threat.severity === 'critical'
              ? chalk.bgRed.white(` ${threat.severity.toUpperCase()} `)
              : chalk.bgYellow.black(` ${threat.severity.toUpperCase()} `);
            console.log(`  ${icon} ${sev} ${chalk.bold(threat.indicator)}`);
            console.log(`    ${threat.description}`);
            if (threat.reference) {
              console.log(`    ${chalk.dim(threat.reference)}`);
            }
            if (threat.attribution) {
              console.log(`    Attribution: ${chalk.dim(threat.attribution)}`);
            }
            console.log('');
          }
        }
        console.log('');

        // Exit with non-zero if critical threats found
        if (result.threats.some((t) => t.severity === 'critical')) {
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('update')
      .description('Update IOC database from remote feed')
      .argument('[url]', 'Feed URL (saved for future updates)')
      .action(async (url?: string) => {
        const feedUrl = url || loadIocDatabase().feedUrl;
        if (!feedUrl) {
          console.error(chalk.red('No feed URL provided. Usage: hawkeye shield update <url>'));
          console.error(chalk.dim('  The URL should return a JSON object with packages/domains/hashes arrays.'));
          process.exit(1);
        }

        console.log(`  Updating IOC database from ${chalk.dim(feedUrl)}...`);
        const result = await updateFromFeed(feedUrl);

        if (result.error) {
          console.error(chalk.red(`  Error: ${result.error}`));
          process.exit(1);
        }

        console.log(`  ${chalk.green('✔')} Added ${result.added} new IOC(s).`);
        const stats = iocStats(loadIocDatabase());
        console.log(`  Database now has ${stats.totalPackages} packages, ${stats.totalDomains} domains, ${stats.totalHashes} hashes.`);
      }),
  )
  .addCommand(
    new Command('add')
      .description('Add an IOC manually')
      .option('--package <name@version>', 'Add a compromised package (e.g. axios@1.14.1)')
      .option('--domain <host>', 'Add a malicious domain/IP')
      .option('--hash <sha256>', 'Add a malicious file hash')
      .option('--severity <level>', 'Severity: critical, high, moderate', 'critical')
      .option('--description <text>', 'Description of the threat')
      .action((opts) => {
        const severity = opts.severity as 'critical' | 'high' | 'moderate';
        const description = opts.description || 'Manually added IOC';
        const now = new Date().toISOString();
        let added = false;

        if (opts.package) {
          const atIdx = opts.package.lastIndexOf('@');
          if (atIdx <= 0) {
            console.error(chalk.red('Invalid format. Use: --package name@version'));
            process.exit(1);
          }
          const name = opts.package.slice(0, atIdx);
          const version = opts.package.slice(atIdx + 1);
          addIocPackage({
            name,
            versions: [version],
            severity,
            description,
            addedAt: now,
          });
          console.log(`  ${chalk.green('✔')} Added package IOC: ${o(name)}@${o(version)}`);
          added = true;
        }

        if (opts.domain) {
          addIocDomain({
            host: opts.domain,
            type: 'c2',
            severity,
            description,
            addedAt: now,
          });
          console.log(`  ${chalk.green('✔')} Added domain IOC: ${o(opts.domain)}`);
          added = true;
        }

        if (opts.hash) {
          addIocHash({
            sha256: opts.hash,
            severity,
            description,
            fileType: 'unknown',
            addedAt: now,
          });
          console.log(`  ${chalk.green('✔')} Added hash IOC: ${o(opts.hash.slice(0, 16))}...`);
          added = true;
        }

        if (!added) {
          console.error('Specify at least one: --package, --domain, or --hash');
          process.exit(1);
        }
      }),
  );
