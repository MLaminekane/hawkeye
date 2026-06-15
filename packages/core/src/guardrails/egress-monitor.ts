/**
 * OS-level Network Egress Monitor.
 *
 * Uses `lsof` (macOS/Linux) or `ss` (Linux) to detect outbound network
 * connections from child processes spawned during agent sessions.
 *
 * This catches connections that monkey-patching Node's http module cannot:
 * - Postinstall scripts from npm packages (like the Axios RAT)
 * - Native binaries spawned by commands
 * - Any subprocess that opens sockets independently
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { Logger } from '../logger.js';

const logger = new Logger('guardrails:egress-monitor');

export interface EgressConnection {
  pid: number;
  process: string;
  remoteHost: string;
  remotePort: number;
  protocol: string;
  state: string;
}

export interface EgressScanResult {
  connections: EgressConnection[];
  suspicious: EgressConnection[];
  summary: string;
  timestamp: string;
}

const LOCALHOST = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '*',
  '[::1]',
  '0:0:0:0:0:0:0:1',
]);

/** Well-known hosts that are typically safe for dev environments */
const KNOWN_SAFE_HOSTS = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  'crates.io',
  'pkg.go.dev',
  'proxy.golang.org',
]);

/** Well-known safe IP ranges (simplified — just common CDN/registry IPs) */
function isPrivateOrLocalIP(ip: string): boolean {
  if (LOCALHOST.has(ip)) return true;
  // Private ranges
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('172.') && parseInt(ip.split('.')[1]) >= 16 && parseInt(ip.split('.')[1]) <= 31) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0' || ip === '::' || ip === '*') return true;
  return false;
}

/**
 * Scan for outbound network connections using OS tools.
 * Returns all non-localhost connections from any process.
 */
export function scanEgressConnections(
  filterPids?: number[],
): EgressConnection[] {
  const os = platform();
  const connections: EgressConnection[] = [];

  try {
    if (os === 'darwin' || os === 'linux') {
      // lsof -i -n -P: list all internet connections, no DNS resolution, numeric ports
      const pidFilter = filterPids && filterPids.length > 0
        ? filterPids.map((p) => `-p ${p}`).join(' ')
        : '';
      const cmd = `lsof -i -n -P ${pidFilter} 2>/dev/null || true`;

      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      for (const line of output.split('\n')) {
        if (!line.trim() || line.startsWith('COMMAND')) continue;

        // Parse lsof output: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;

        const processName = parts[0];
        const pid = parseInt(parts[1]);
        const type = parts[4]; // IPv4/IPv6
        const node = parts[7]; // TCP/UDP
        const name = parts[parts.length - 1]; // e.g., 192.168.1.1:443->10.0.0.1:54321

        // Only interested in TCP/UDP connections
        if (node !== 'TCP' && node !== 'UDP') continue;

        // Parse the connection string
        const arrowMatch = name.match(/->(.+)/);
        if (!arrowMatch) continue;

        const remote = arrowMatch[1];
        // Extract state if present (e.g., "(ESTABLISHED)")
        const stateMatch = remote.match(/\((\w+)\)/);
        const state = stateMatch ? stateMatch[1] : 'UNKNOWN';
        const cleanRemote = remote.replace(/\s*\(\w+\)/, '');

        // Parse host:port
        const lastColon = cleanRemote.lastIndexOf(':');
        if (lastColon === -1) continue;
        const remoteHost = cleanRemote.slice(0, lastColon);
        const remotePort = parseInt(cleanRemote.slice(lastColon + 1));

        if (isNaN(pid) || isNaN(remotePort)) continue;

        connections.push({
          pid,
          process: processName,
          remoteHost,
          remotePort,
          protocol: node,
          state,
        });
      }
    }

    if (os === 'linux') {
      // Also try ss as a fallback/supplement
      try {
        const ssOutput = execSync('ss -tnp 2>/dev/null || true', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        for (const line of ssOutput.split('\n')) {
          if (!line.trim() || line.startsWith('State')) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) continue;

          const state = parts[0];
          const peer = parts[4]; // remote addr:port

          // Parse users:((process,pid,fd))
          const usersMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
          const processName = usersMatch ? usersMatch[1] : 'unknown';
          const pid = usersMatch ? parseInt(usersMatch[2]) : 0;

          const lastColon = peer.lastIndexOf(':');
          if (lastColon === -1) continue;
          const remoteHost = peer.slice(0, lastColon);
          const remotePort = parseInt(peer.slice(lastColon + 1));

          if (filterPids && filterPids.length > 0 && !filterPids.includes(pid)) continue;

          // Avoid duplicates from lsof
          const exists = connections.some(
            (c) => c.pid === pid && c.remoteHost === remoteHost && c.remotePort === remotePort,
          );
          if (exists) continue;

          connections.push({
            pid,
            process: processName,
            remoteHost,
            remotePort,
            protocol: 'TCP',
            state,
          });
        }
      } catch {
        // ss not available — that's fine, lsof already ran
      }
    }
  } catch (err) {
    logger.warn(`Egress scan failed: ${err}`);
  }

  return connections;
}

/**
 * Analyze egress connections and flag suspicious ones.
 */
export function analyzeEgress(
  connections: EgressConnection[],
  allowedHosts: string[] = [],
): EgressScanResult {
  const allowedSet = new Set(allowedHosts.map((h) => h.toLowerCase()));

  // Merge known safe hosts with user-specified allowed hosts
  const safeHosts = new Set([...KNOWN_SAFE_HOSTS, ...allowedSet]);

  const suspicious: EgressConnection[] = [];

  for (const conn of connections) {
    const host = conn.remoteHost.toLowerCase();

    // Skip localhost and private IPs
    if (LOCALHOST.has(host) || isPrivateOrLocalIP(host)) continue;

    // Skip known safe hosts
    if (safeHosts.has(host)) continue;

    // Check if any allowed pattern matches (supports suffix matching)
    const isSafe = [...safeHosts].some((safe) => host === safe || host.endsWith('.' + safe));
    if (isSafe) continue;

    // This connection is to an unknown host — flag it
    suspicious.push(conn);
  }

  const summary = suspicious.length > 0
    ? `Egress monitor: ${suspicious.length} suspicious outbound connection(s) detected — ${[...new Set(suspicious.map((c) => `${c.process}(${c.pid})→${c.remoteHost}:${c.remotePort}`))].join(', ')}`
    : `Egress monitor: ${connections.length} connections scanned, all clear`;

  return {
    connections,
    suspicious,
    summary,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get child PIDs of a process (for scoped scanning).
 */
export function getChildPids(parentPid: number): number[] {
  try {
    const os = platform();
    let output: string;

    if (os === 'darwin') {
      output = execSync(`pgrep -P ${parentPid} 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
    } else {
      output = execSync(`ps --ppid ${parentPid} -o pid= 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
    }

    return output
      .split('\n')
      .map((l) => parseInt(l.trim()))
      .filter((n) => !isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * One-shot scan: scan for suspicious egress after a command runs.
 * Call this after a Bash command completes to check what connections it made.
 */
export function postCommandEgressScan(
  commandPid: number | undefined,
  allowedHosts: string[] = [],
): EgressScanResult {
  // Get all child PIDs for scoped scanning
  const pids = commandPid ? [commandPid, ...getChildPids(commandPid)] : undefined;
  const connections = scanEgressConnections(pids);
  return analyzeEgress(connections, allowedHosts);
}
