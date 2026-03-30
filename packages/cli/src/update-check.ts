import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

const PACKAGE_NAME = 'hawkeye-ai';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_DIR = join(homedir(), '.hawkeye');
const CACHE_FILE = join(CACHE_DIR, 'update-check.json');

interface CacheEntry {
  latestVersion: string;
  checkedAt: number;
}

function readCache(): CacheEntry | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } catch {
    // non-critical
  }
}

function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

function showNotification(current: string, latest: string): void {
  const o = chalk.hex('#ff5f1f');
  const msg = [
    '',
    o('  ╭─────────────────────────────────────────────╮'),
    o('  │') + `  Update available: ${chalk.dim(current)} → ${chalk.bold.white(latest)}` + o('  │'),
    o('  │') + `  Run: ${chalk.cyan('npm i -g hawkeye-ai')}` + ' '.repeat(20) + o('│'),
    o('  ╰─────────────────────────────────────────────╯'),
    '',
  ].join('\n');
  process.stderr.write(msg + '\n');
}

export function checkForUpdate(currentVersion: string): void {
  // Show cached notification first (from previous check)
  const cache = readCache();
  if (cache && isNewerVersion(currentVersion, cache.latestVersion)) {
    showNotification(currentVersion, cache.latestVersion);
  }

  // Skip fetch if cache is still fresh
  if (cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) return;

  // Fetch latest version in the background (non-blocking)
  fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(3000) })
    .then((res) => res.json())
    .then((data: unknown) => {
      const latest = (data as { version?: string }).version;
      if (typeof latest === 'string') {
        writeCache({ latestVersion: latest, checkedAt: Date.now() });
      }
    })
    .catch(() => {
      // network unavailable — silent fail
    });
}
