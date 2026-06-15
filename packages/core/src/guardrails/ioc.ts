/**
 * IOC (Indicators of Compromise) database.
 *
 * A local threat intelligence feed for detecting known-compromised npm packages,
 * malicious domains/IPs, and suspicious file hashes.
 *
 * Inspired by the Axios supply chain attack (March 2026) where backdoored
 * packages were published with a RAT that phoned home to C2 servers.
 *
 * The IOC database can be:
 * - Seeded with built-in known threats
 * - Updated from a remote feed URL
 * - Extended manually via CLI
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Logger } from '../logger.js';

const logger = new Logger('ioc');

// ── Types ──

export interface IocPackage {
  /** Package name (e.g. "axios") */
  name: string;
  /** Compromised versions (e.g. ["1.14.1", "0.30.4"]) */
  versions: string[];
  /** Severity: critical = known malware, high = suspected, moderate = vuln */
  severity: 'critical' | 'high' | 'moderate';
  /** Short description */
  description: string;
  /** Reference URL (advisory, blog post) */
  reference?: string;
  /** Date added (ISO 8601) */
  addedAt: string;
  /** Attribution (e.g. "UNC1069", "Lazarus Group") */
  attribution?: string;
}

export interface IocDomain {
  /** Hostname or IP (e.g. "evil-c2.example.com" or "185.100.87.174") */
  host: string;
  /** Why it's flagged */
  type: 'c2' | 'exfiltration' | 'phishing' | 'malware_host';
  severity: 'critical' | 'high' | 'moderate';
  description: string;
  reference?: string;
  addedAt: string;
  /** Related package compromise (if applicable) */
  relatedPackage?: string;
}

export interface IocHash {
  /** SHA-256 hash */
  sha256: string;
  /** What it identifies (e.g. "axios-1.14.1.tgz backdoored tarball") */
  description: string;
  severity: 'critical' | 'high' | 'moderate';
  /** File type: tarball, binary, script */
  fileType: 'tarball' | 'binary' | 'script' | 'unknown';
  reference?: string;
  addedAt: string;
  relatedPackage?: string;
}

export interface IocDatabase {
  version: number;
  lastUpdated: string;
  feedUrl?: string;
  packages: IocPackage[];
  domains: IocDomain[];
  hashes: IocHash[];
}

// ── Built-in IOC seed ──
// Known threats from real incidents. This ships with Hawkeye and is always checked.

const BUILTIN_IOCS: IocDatabase = {
  version: 1,
  lastUpdated: '2026-03-31T00:00:00Z',
  packages: [
    {
      name: 'axios',
      versions: ['1.14.1', '0.30.4'],
      severity: 'critical',
      description: 'Supply chain attack: backdoored with cross-platform RAT via postinstall hook. Compromised npm maintainer account.',
      reference: 'https://snyk.io/blog/axios-npm-package-compromised-supply-chain-attack-delivers-cross-platform/',
      addedAt: '2026-03-31T03:30:00Z',
      attribution: 'UNC1069 (suspected DPRK)',
    },
    {
      name: 'event-stream',
      versions: ['3.3.6'],
      severity: 'critical',
      description: 'Backdoor targeting copay-dash bitcoin wallet. Malicious flatmap-stream dependency.',
      reference: 'https://blog.npmjs.org/post/180565383195/details-about-the-event-stream-incident',
      addedAt: '2018-11-26T00:00:00Z',
    },
    {
      name: 'ua-parser-js',
      versions: ['0.7.29', '0.8.0', '1.0.0'],
      severity: 'critical',
      description: 'Hijacked npm account. Malicious versions contained a cryptominer and credential stealer.',
      reference: 'https://github.com/nicedreamland/event-source-polyfill/issues/1',
      addedAt: '2021-10-22T00:00:00Z',
    },
    {
      name: 'coa',
      versions: ['2.0.3', '2.0.4', '2.1.1', '2.1.3', '3.0.1', '3.1.3'],
      severity: 'critical',
      description: 'Hijacked npm account. Compromised versions deployed credential-stealing malware.',
      addedAt: '2021-11-04T00:00:00Z',
    },
    {
      name: 'rc',
      versions: ['1.2.9', '1.3.9', '2.3.9'],
      severity: 'critical',
      description: 'Hijacked npm account. Malicious postinstall script.',
      addedAt: '2021-11-04T00:00:00Z',
    },
    {
      name: 'colors',
      versions: ['1.4.1', '1.4.2'],
      severity: 'high',
      description: 'Maintainer protest: infinite loop injected. Not malware but destructive.',
      addedAt: '2022-01-08T00:00:00Z',
    },
    {
      name: 'faker',
      versions: ['6.6.6'],
      severity: 'high',
      description: 'Maintainer protest: all functionality replaced with ENDMOTTIER output.',
      addedAt: '2022-01-05T00:00:00Z',
    },
    {
      name: 'node-ipc',
      versions: ['10.1.1', '10.1.2', '10.1.3'],
      severity: 'critical',
      description: 'Protestware: peacenotwar dependency overwrites files on systems with Russian/Belarusian IP.',
      addedAt: '2022-03-16T00:00:00Z',
    },
  ],
  domains: [
    // Axios attack C2 infrastructure
    {
      host: '159.100.13.190',
      type: 'c2',
      severity: 'critical',
      description: 'Axios RAT C2 server — payload delivery endpoint.',
      addedAt: '2026-03-31T03:30:00Z',
      relatedPackage: 'axios',
    },
  ],
  hashes: [
    {
      sha256: 'placeholder_axios_1_14_1_tarball_hash',
      description: 'axios@1.14.1 backdoored npm tarball',
      severity: 'critical',
      fileType: 'tarball',
      addedAt: '2026-03-31T03:30:00Z',
      relatedPackage: 'axios',
    },
  ],
};

// ── IOC Database operations ──

export function getIocPath(hawkeyeDir?: string): string {
  const dir = hawkeyeDir || join(process.env.HOME || '', '.hawkeye');
  return join(dir, 'ioc.json');
}

export function loadIocDatabase(hawkeyeDir?: string): IocDatabase {
  const iocPath = getIocPath(hawkeyeDir);

  // Start with builtins
  const db: IocDatabase = {
    ...BUILTIN_IOCS,
    packages: [...BUILTIN_IOCS.packages],
    domains: [...BUILTIN_IOCS.domains],
    hashes: [...BUILTIN_IOCS.hashes],
  };

  // Merge user/feed IOCs from disk
  if (existsSync(iocPath)) {
    try {
      const custom = JSON.parse(readFileSync(iocPath, 'utf-8')) as IocDatabase;
      // Merge packages (dedupe by name+version)
      for (const pkg of custom.packages || []) {
        const existing = db.packages.find((p) => p.name === pkg.name);
        if (existing) {
          // Merge versions
          for (const v of pkg.versions) {
            if (!existing.versions.includes(v)) existing.versions.push(v);
          }
        } else {
          db.packages.push(pkg);
        }
      }
      // Merge domains (dedupe by host)
      for (const d of custom.domains || []) {
        if (!db.domains.some((x) => x.host === d.host)) {
          db.domains.push(d);
        }
      }
      // Merge hashes (dedupe by sha256)
      for (const h of custom.hashes || []) {
        if (!db.hashes.some((x) => x.sha256 === h.sha256)) {
          db.hashes.push(h);
        }
      }
      if (custom.feedUrl) db.feedUrl = custom.feedUrl;
      if (custom.lastUpdated > db.lastUpdated) db.lastUpdated = custom.lastUpdated;
    } catch (err) {
      logger.warn(`Failed to load IOC database: ${err}`);
    }
  }

  return db;
}

export function saveIocDatabase(db: IocDatabase, hawkeyeDir?: string): void {
  const iocPath = getIocPath(hawkeyeDir);
  const dir = hawkeyeDir || join(process.env.HOME || '', '.hawkeye');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db.lastUpdated = new Date().toISOString();
  writeFileSync(iocPath, JSON.stringify(db, null, 2));
}

// ── IOC Matching ──

export interface IocMatch {
  type: 'package' | 'domain' | 'hash';
  severity: 'critical' | 'high' | 'moderate';
  indicator: string;
  description: string;
  reference?: string;
  attribution?: string;
}

/** Check if a package name@version is in the IOC database */
export function matchPackage(
  name: string,
  version: string,
  db: IocDatabase,
): IocMatch | null {
  for (const pkg of db.packages) {
    if (pkg.name === name && pkg.versions.includes(version)) {
      return {
        type: 'package',
        severity: pkg.severity,
        indicator: `${name}@${version}`,
        description: pkg.description,
        reference: pkg.reference,
        attribution: pkg.attribution,
      };
    }
  }
  return null;
}

/** Check if a hostname/IP is in the IOC database */
export function matchDomain(
  host: string,
  db: IocDatabase,
): IocMatch | null {
  const lower = host.toLowerCase();
  for (const d of db.domains) {
    if (d.host.toLowerCase() === lower || lower.endsWith('.' + d.host.toLowerCase())) {
      return {
        type: 'domain',
        severity: d.severity,
        indicator: host,
        description: d.description,
        reference: d.reference,
      };
    }
  }
  return null;
}

/** Check if a file hash is in the IOC database */
export function matchHash(
  sha256: string,
  db: IocDatabase,
): IocMatch | null {
  const lower = sha256.toLowerCase();
  for (const h of db.hashes) {
    if (h.sha256.toLowerCase() === lower) {
      return {
        type: 'hash',
        severity: h.severity,
        indicator: sha256,
        description: h.description,
        reference: h.reference,
      };
    }
  }
  return null;
}

/** Compute SHA-256 of a file */
export function hashFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/** Check all IOC types at once */
export function matchAll(
  db: IocDatabase,
  checks: {
    packages?: Array<{ name: string; version: string }>;
    domains?: string[];
    hashes?: string[];
  },
): IocMatch[] {
  const matches: IocMatch[] = [];

  if (checks.packages) {
    for (const { name, version } of checks.packages) {
      const m = matchPackage(name, version, db);
      if (m) matches.push(m);
    }
  }

  if (checks.domains) {
    for (const host of checks.domains) {
      const m = matchDomain(host, db);
      if (m) matches.push(m);
    }
  }

  if (checks.hashes) {
    for (const hash of checks.hashes) {
      const m = matchHash(hash, db);
      if (m) matches.push(m);
    }
  }

  return matches;
}

// ── Feed update ──

export async function updateFromFeed(
  feedUrl: string,
  hawkeyeDir?: string,
): Promise<{ added: number; error?: string }> {
  try {
    const res = await fetch(feedUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { added: 0, error: `Feed returned ${res.status}: ${res.statusText}` };
    }

    const feed = (await res.json()) as Partial<IocDatabase>;
    const db = loadIocDatabase(hawkeyeDir);
    let added = 0;

    // Merge packages
    for (const pkg of feed.packages || []) {
      if (!pkg.name || !Array.isArray(pkg.versions)) continue;
      const existing = db.packages.find((p) => p.name === pkg.name);
      if (existing) {
        for (const v of pkg.versions) {
          if (!existing.versions.includes(v)) {
            existing.versions.push(v);
            added++;
          }
        }
      } else {
        db.packages.push({
          ...pkg,
          severity: pkg.severity || 'high',
          description: pkg.description || `Compromised package from feed: ${pkg.name}`,
          addedAt: pkg.addedAt || new Date().toISOString(),
        });
        added++;
      }
    }

    // Merge domains
    for (const d of feed.domains || []) {
      if (!d.host) continue;
      if (!db.domains.some((x) => x.host === d.host)) {
        db.domains.push({
          ...d,
          type: d.type || 'c2',
          severity: d.severity || 'high',
          description: d.description || `Malicious host from feed: ${d.host}`,
          addedAt: d.addedAt || new Date().toISOString(),
        });
        added++;
      }
    }

    // Merge hashes
    for (const h of feed.hashes || []) {
      if (!h.sha256) continue;
      if (!db.hashes.some((x) => x.sha256 === h.sha256)) {
        db.hashes.push({
          ...h,
          severity: h.severity || 'high',
          description: h.description || `Malicious hash from feed`,
          fileType: h.fileType || 'unknown',
          addedAt: h.addedAt || new Date().toISOString(),
        });
        added++;
      }
    }

    db.feedUrl = feedUrl;
    saveIocDatabase(db, hawkeyeDir);
    return { added };
  } catch (err) {
    return { added: 0, error: String(err) };
  }
}

// ── Add IOC manually ──

export function addIocPackage(pkg: IocPackage, hawkeyeDir?: string): void {
  const db = loadIocDatabase(hawkeyeDir);
  const existing = db.packages.find((p) => p.name === pkg.name);
  if (existing) {
    for (const v of pkg.versions) {
      if (!existing.versions.includes(v)) existing.versions.push(v);
    }
    existing.severity = pkg.severity;
    existing.description = pkg.description;
  } else {
    db.packages.push(pkg);
  }
  saveIocDatabase(db, hawkeyeDir);
}

export function addIocDomain(domain: IocDomain, hawkeyeDir?: string): void {
  const db = loadIocDatabase(hawkeyeDir);
  if (!db.domains.some((d) => d.host === domain.host)) {
    db.domains.push(domain);
  }
  saveIocDatabase(db, hawkeyeDir);
}

export function addIocHash(hash: IocHash, hawkeyeDir?: string): void {
  const db = loadIocDatabase(hawkeyeDir);
  if (!db.hashes.some((h) => h.sha256 === hash.sha256)) {
    db.hashes.push(hash);
  }
  saveIocDatabase(db, hawkeyeDir);
}

/** Summary stats */
export function iocStats(db: IocDatabase): {
  totalPackages: number;
  totalVersions: number;
  totalDomains: number;
  totalHashes: number;
  critical: number;
  lastUpdated: string;
} {
  const allVersions = db.packages.reduce((s, p) => s + p.versions.length, 0);
  const critical =
    db.packages.filter((p) => p.severity === 'critical').length +
    db.domains.filter((d) => d.severity === 'critical').length +
    db.hashes.filter((h) => h.severity === 'critical').length;

  return {
    totalPackages: db.packages.length,
    totalVersions: allVersions,
    totalDomains: db.domains.length,
    totalHashes: db.hashes.length,
    critical,
    lastUpdated: db.lastUpdated,
  };
}
