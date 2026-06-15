/**
 * Supply Chain Audit guardrail.
 *
 * Runs `npm audit` (or pnpm/yarn equivalent) before allowing package install
 * commands, and blocks if critical/high vulnerabilities are found.
 *
 * Designed to catch supply-chain attacks like the Axios npm compromise
 * (March 2026) where backdoored packages were published to the registry.
 */

import { execSync } from 'node:child_process';
import { Logger } from '../logger.js';

const logger = new Logger('guardrails:supply-chain');

export type VulnSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface AuditVulnerability {
  name: string;
  severity: VulnSeverity;
  title: string;
  url: string;
  range: string;
}

export interface AuditResult {
  passed: boolean;
  vulnerabilities: AuditVulnerability[];
  totalVulnerabilities: number;
  summary: string;
  rawOutput?: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

/** Detect which package manager a command is using */
export function detectPackageManager(command: string): 'npm' | 'pnpm' | 'yarn' | 'bun' | null {
  const trimmed = command.trim();
  if (/^(npx\s|npm\s)/.test(trimmed)) return 'npm';
  if (/^pnpm\s/.test(trimmed)) return 'pnpm';
  if (/^yarn\s/.test(trimmed)) return 'yarn';
  if (/^bun\s/.test(trimmed)) return 'bun';
  return null;
}

/** Check if the command is an install/add command that pulls packages */
export function isInstallCommand(command: string): boolean {
  const trimmed = command.trim();

  // npm install, npm i, npm ci, npm add
  if (/^npm\s+(install|i|ci|add)\b/.test(trimmed)) return true;
  // pnpm install, pnpm i, pnpm add
  if (/^pnpm\s+(install|i|add)\b/.test(trimmed)) return true;
  // yarn install, yarn add
  if (/^yarn\s+(install|add)?\s*$/.test(trimmed) || /^yarn\s+add\s/.test(trimmed)) return true;
  // bun install, bun add
  if (/^bun\s+(install|i|add)\b/.test(trimmed)) return true;

  return false;
}

/** Run npm/pnpm audit and parse the results */
export function runAudit(
  cwd: string,
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' = 'npm',
  blockSeverity: VulnSeverity = 'critical',
): AuditResult {
  const vulns: AuditVulnerability[] = [];

  try {
    let auditCmd: string;
    switch (packageManager) {
      case 'pnpm':
        auditCmd = 'pnpm audit --json 2>/dev/null';
        break;
      case 'yarn':
        auditCmd = 'yarn audit --json 2>/dev/null';
        break;
      case 'bun':
        // Bun doesn't have audit yet; fall back to npm
        auditCmd = 'npm audit --json 2>/dev/null';
        break;
      default:
        auditCmd = 'npm audit --json 2>/dev/null';
    }

    let rawOutput: string;
    try {
      rawOutput = execSync(auditCmd, {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (execErr: unknown) {
      // npm audit exits non-zero when vulnerabilities are found — that's expected
      const e = execErr as { stdout?: string; stderr?: string };
      rawOutput = e.stdout || '';
      if (!rawOutput) {
        return {
          passed: true,
          vulnerabilities: [],
          totalVulnerabilities: 0,
          summary: 'Audit command failed — allowing install (no data)',
          rawOutput: e.stderr || '',
        };
      }
    }

    // Parse npm audit JSON format
    try {
      const audit = JSON.parse(rawOutput);

      // npm v7+ format: { vulnerabilities: { [name]: { severity, ... } } }
      if (audit.vulnerabilities && typeof audit.vulnerabilities === 'object') {
        for (const [name, info] of Object.entries(audit.vulnerabilities)) {
          const v = info as Record<string, unknown>;
          vulns.push({
            name,
            severity: (v.severity as VulnSeverity) || 'moderate',
            title: String(v.title || v.name || name),
            url: String(v.url || ''),
            range: String(v.range || '*'),
          });
        }
      }

      // npm v6 format: { advisories: { [id]: { ... } } }
      if (audit.advisories && typeof audit.advisories === 'object') {
        for (const [, info] of Object.entries(audit.advisories)) {
          const v = info as Record<string, unknown>;
          vulns.push({
            name: String(v.module_name || ''),
            severity: (v.severity as VulnSeverity) || 'moderate',
            title: String(v.title || ''),
            url: String(v.url || ''),
            range: String(v.vulnerable_versions || '*'),
          });
        }
      }
    } catch {
      // Yarn outputs NDJSON — parse line by line
      for (const line of rawOutput.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'auditAdvisory' && entry.data?.advisory) {
            const adv = entry.data.advisory;
            vulns.push({
              name: adv.module_name || '',
              severity: adv.severity || 'moderate',
              title: adv.title || '',
              url: adv.url || '',
              range: adv.vulnerable_versions || '*',
            });
          }
        } catch {
          continue;
        }
      }
    }

    // Check if any vulnerability meets the block threshold
    const blockRank = SEVERITY_RANK[blockSeverity] ?? 4;
    const blocking = vulns.filter((v) => (SEVERITY_RANK[v.severity] ?? 0) >= blockRank);

    if (blocking.length > 0) {
      const severityCounts: Record<string, number> = {};
      for (const v of blocking) {
        severityCounts[v.severity] = (severityCounts[v.severity] || 0) + 1;
      }
      const countStr = Object.entries(severityCounts)
        .map(([s, c]) => `${c} ${s}`)
        .join(', ');

      return {
        passed: false,
        vulnerabilities: blocking,
        totalVulnerabilities: vulns.length,
        summary: `Supply chain audit FAILED: ${blocking.length} vulnerabilities at or above ${blockSeverity} severity (${countStr}). Packages: ${blocking.map((v) => v.name).join(', ')}`,
        rawOutput,
      };
    }

    return {
      passed: true,
      vulnerabilities: vulns,
      totalVulnerabilities: vulns.length,
      summary: vulns.length > 0
        ? `Audit passed (${vulns.length} vulnerabilities below ${blockSeverity} threshold)`
        : 'No known vulnerabilities found',
      rawOutput,
    };
  } catch (err) {
    logger.warn(`Supply chain audit failed: ${err}`);
    return {
      passed: true,
      vulnerabilities: [],
      totalVulnerabilities: 0,
      summary: `Audit unavailable: ${String(err)}`,
    };
  }
}
