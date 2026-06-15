/**
 * Agent Behavior Fingerprinting.
 *
 * Builds a behavioral profile of an AI agent's normal activity patterns,
 * then detects anomalies that may indicate compromise or manipulation.
 *
 * Normal agent behavior: read files → edit files → run tests → commit
 * Anomalous behavior:   sudden credential access, network exfil, rm -rf
 *
 * The profiler works in two modes:
 * 1. Learning: builds a baseline from observed events
 * 2. Detection: compares new events against the baseline and flags anomalies
 */

// ── Types ──

export type ActionCategory =
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'command_safe'
  | 'command_test'
  | 'command_build'
  | 'command_git'
  | 'command_install'
  | 'command_network'
  | 'command_dangerous'
  | 'credential_access'
  | 'api_call'
  | 'llm_call';

export interface BehaviorProfile {
  sessionId: string;
  /** Total events analyzed */
  totalEvents: number;
  /** Distribution of action categories (counts) */
  actionDistribution: Record<ActionCategory, number>;
  /** Unique files accessed */
  filesAccessed: Set<string> | string[];
  /** Unique directories touched */
  directoriesAccessed: Set<string> | string[];
  /** Unique commands run */
  commandPatterns: Set<string> | string[];
  /** Unique external hosts contacted */
  externalHosts: Set<string> | string[];
  /** Credential files accessed (.env, .key, .pem, ssh keys) */
  credentialAccesses: string[];
  /** Sequence of last N action categories (for pattern matching) */
  recentSequence: ActionCategory[];
  /** Timestamps of key transitions */
  phaseTimeline: Array<{ phase: string; startedAt: string; eventCount: number }>;
  /** Anomaly score: 0 = normal, 100 = highly anomalous */
  anomalyScore: number;
  /** Detected anomalies */
  anomalies: BehaviorAnomaly[];
  /** Last updated */
  updatedAt: string;
}

export interface BehaviorAnomaly {
  type: AnomalyType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string;
  detectedAt: string;
}

export type AnomalyType =
  | 'credential_access_spike'
  | 'network_activity_spike'
  | 'dangerous_command'
  | 'unusual_file_access'
  | 'phase_violation'
  | 'exfiltration_pattern'
  | 'lateral_movement'
  | 'privilege_escalation';

// ── Event classification ──

const CREDENTIAL_PATTERNS = [
  '.env', '.env.local', '.env.production',
  '.key', '.pem', '.p12', '.pfx', '.jks',
  'id_rsa', 'id_ed25519', 'id_ecdsa',
  '.credentials', '.secret', '.secrets',
  'credentials.json', 'serviceaccount.json',
  '.aws/credentials', '.ssh/config',
  '.npmrc', '.pypirc', '.docker/config.json',
];

const TEST_COMMANDS = /\b(test|jest|vitest|mocha|pytest|cargo test|go test|npm test|pnpm test|yarn test)\b/i;
const BUILD_COMMANDS = /\b(build|compile|tsc|webpack|vite|esbuild|rollup|make|cargo build|go build)\b/i;
const GIT_COMMANDS = /\b(git)\b/;
const INSTALL_COMMANDS = /\b(npm install|npm i|npm ci|pnpm install|pnpm add|yarn install|yarn add|bun install|pip install|cargo add)\b/i;
const NETWORK_COMMANDS = /\b(curl|wget|nc|ncat|ssh|scp|rsync|telnet|ftp)\b/i;
const DANGEROUS_COMMANDS = /\b(rm -rf|chmod 777|sudo|mkfs|dd if=|shutdown|reboot|kill -9)\b/i;

export function classifyAction(
  eventType: string,
  data: Record<string, unknown>,
): ActionCategory {
  if (eventType === 'file_read') {
    const path = String(data.path || '');
    if (isCredentialFile(path)) return 'credential_access';
    return 'file_read';
  }
  if (eventType === 'file_write') return 'file_write';
  if (eventType === 'file_delete') return 'file_delete';
  if (eventType === 'api_call') return 'api_call';
  if (eventType === 'llm_call') return 'llm_call';

  if (eventType === 'command') {
    const cmd = String(data.command || '') + ' ' + (Array.isArray(data.args) ? data.args.join(' ') : '');

    if (DANGEROUS_COMMANDS.test(cmd)) return 'command_dangerous';
    if (isCredentialFile(cmd)) return 'credential_access';
    if (NETWORK_COMMANDS.test(cmd)) return 'command_network';
    if (GIT_COMMANDS.test(cmd)) return 'command_git';
    if (TEST_COMMANDS.test(cmd)) return 'command_test';
    if (BUILD_COMMANDS.test(cmd)) return 'command_build';
    if (INSTALL_COMMANDS.test(cmd)) return 'command_install';
    return 'command_safe';
  }

  // Git events
  if (eventType.startsWith('git_')) return 'command_git';

  return 'command_safe';
}

function isCredentialFile(path: string): boolean {
  const lower = path.toLowerCase();
  return CREDENTIAL_PATTERNS.some((p) => lower.includes(p));
}

// ── Profile building ──

const SEQUENCE_WINDOW = 50;

export function createEmptyProfile(sessionId: string): BehaviorProfile {
  return {
    sessionId,
    totalEvents: 0,
    actionDistribution: {
      file_read: 0,
      file_write: 0,
      file_delete: 0,
      command_safe: 0,
      command_test: 0,
      command_build: 0,
      command_git: 0,
      command_install: 0,
      command_network: 0,
      command_dangerous: 0,
      credential_access: 0,
      api_call: 0,
      llm_call: 0,
    },
    filesAccessed: [],
    directoriesAccessed: [],
    commandPatterns: [],
    externalHosts: [],
    credentialAccesses: [],
    recentSequence: [],
    phaseTimeline: [],
    anomalyScore: 0,
    anomalies: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update a behavior profile with a new event.
 * Returns the updated profile and any new anomalies detected.
 */
export function updateProfile(
  profile: BehaviorProfile,
  eventType: string,
  data: Record<string, unknown>,
): { profile: BehaviorProfile; newAnomalies: BehaviorAnomaly[] } {
  const category = classifyAction(eventType, data);
  const now = new Date().toISOString();
  const newAnomalies: BehaviorAnomaly[] = [];

  // Update distribution
  profile.actionDistribution[category]++;
  profile.totalEvents++;

  // Update sequence
  profile.recentSequence.push(category);
  if (profile.recentSequence.length > SEQUENCE_WINDOW) {
    profile.recentSequence = profile.recentSequence.slice(-SEQUENCE_WINDOW);
  }

  // Track files
  const path = String(data.path || '');
  if (path) {
    const files = ensureArray(profile.filesAccessed);
    if (!files.includes(path)) files.push(path);
    profile.filesAccessed = files;

    const dir = path.split('/').slice(0, -1).join('/');
    if (dir) {
      const dirs = ensureArray(profile.directoriesAccessed);
      if (!dirs.includes(dir)) dirs.push(dir);
      profile.directoriesAccessed = dirs;
    }
  }

  // Track commands
  if (eventType === 'command') {
    const cmd = String(data.command || '');
    const baseCmd = cmd.split(/\s+/)[0];
    if (baseCmd) {
      const cmds = ensureArray(profile.commandPatterns);
      if (!cmds.includes(baseCmd)) cmds.push(baseCmd);
      profile.commandPatterns = cmds;
    }
  }

  // Track credential accesses
  if (category === 'credential_access') {
    const target = path || String(data.command || '');
    profile.credentialAccesses.push(target);
  }

  // Track external hosts
  if (eventType === 'api_call') {
    const url = String(data.url || '');
    try {
      const hostname = new URL(url).hostname;
      const hosts = ensureArray(profile.externalHosts);
      if (!hosts.includes(hostname)) hosts.push(hostname);
      profile.externalHosts = hosts;
    } catch { /* invalid URL */ }
  }

  // ── Anomaly detection ──
  const anomalies = detectAnomalies(profile, category, data, now);
  newAnomalies.push(...anomalies);
  profile.anomalies.push(...anomalies);

  // Compute anomaly score
  profile.anomalyScore = computeAnomalyScore(profile);
  profile.updatedAt = now;

  return { profile, newAnomalies };
}

// ── Anomaly Detection Rules ──

function detectAnomalies(
  profile: BehaviorProfile,
  category: ActionCategory,
  data: Record<string, unknown>,
  now: string,
): BehaviorAnomaly[] {
  const anomalies: BehaviorAnomaly[] = [];
  const seq = profile.recentSequence;
  const total = profile.totalEvents;

  // Rule 1: Credential access spike
  // Normal agents rarely touch credential files. 2+ accesses is suspicious.
  if (category === 'credential_access' && profile.credentialAccesses.length >= 2) {
    anomalies.push({
      type: 'credential_access_spike',
      severity: profile.credentialAccesses.length >= 4 ? 'critical' : 'high',
      description: `Agent accessed ${profile.credentialAccesses.length} credential files — unusual for a coding agent`,
      evidence: profile.credentialAccesses.slice(-3).join(', '),
      detectedAt: now,
    });
  }

  // Rule 2: Network activity spike
  // If the agent suddenly starts making lots of network calls after a file-editing phase
  if (category === 'command_network') {
    const recentNet = seq.slice(-10).filter((a) => a === 'command_network').length;
    if (recentNet >= 3) {
      anomalies.push({
        type: 'network_activity_spike',
        severity: 'high',
        description: `${recentNet} network commands in last 10 actions — possible exfiltration`,
        evidence: `Recent sequence: ${seq.slice(-10).join(' → ')}`,
        detectedAt: now,
      });
    }
  }

  // Rule 3: Dangerous commands
  if (category === 'command_dangerous') {
    anomalies.push({
      type: 'dangerous_command',
      severity: 'critical',
      description: 'Agent executed a dangerous system command',
      evidence: `Command: ${String(data.command || '')} ${Array.isArray(data.args) ? data.args.join(' ') : ''}`.trim(),
      detectedAt: now,
    });
  }

  // Rule 4: Phase violation — network after credential access (exfil pattern)
  if (category === 'command_network' || category === 'api_call') {
    const recentCreds = seq.slice(-5).filter((a) => a === 'credential_access').length;
    if (recentCreds > 0) {
      anomalies.push({
        type: 'exfiltration_pattern',
        severity: 'critical',
        description: 'Network activity immediately after credential file access — classic exfiltration pattern',
        evidence: `Sequence: ${seq.slice(-5).join(' → ')}`,
        detectedAt: now,
      });
    }
  }

  // Rule 5: Unusual file access — outside normal directories
  if (category === 'file_read' || category === 'file_write') {
    const path = String(data.path || '');
    const sensitiveAreas = ['/etc/', '/usr/', '/var/', '/.ssh/', '/.aws/', '/.gnupg/'];
    for (const area of sensitiveAreas) {
      if (path.includes(area)) {
        anomalies.push({
          type: 'unusual_file_access',
          severity: 'high',
          description: `Agent accessed file in sensitive system area: ${area}`,
          evidence: path,
          detectedAt: now,
        });
        break;
      }
    }
  }

  // Rule 6: Privilege escalation
  if (inferEventType(data) === 'command') {
    const cmd = String(data.command || '') + ' ' + (Array.isArray(data.args) ? data.args.join(' ') : '');
    if (/\bsudo\b|\bsu\s+-\b|\bchmod\s+[47]77\b|\bchown\b/i.test(cmd)) {
      anomalies.push({
        type: 'privilege_escalation',
        severity: 'critical',
        description: 'Agent attempted privilege escalation',
        evidence: cmd.slice(0, 200),
        detectedAt: now,
      });
    }
  }

  return anomalies;
}

// Helper to infer event type from data context
function inferEventType(data: Record<string, unknown>): string {
  if (data.command !== undefined) return 'command';
  if (data.path !== undefined) return 'file';
  if (data.url !== undefined) return 'api_call';
  return 'unknown';
}

// ── Anomaly scoring ──

const SEVERITY_WEIGHT: Record<string, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
};

function computeAnomalyScore(profile: BehaviorProfile): number {
  if (profile.anomalies.length === 0) return 0;

  // Weight by severity and recency
  let score = 0;
  const recentAnomalies = profile.anomalies.slice(-20);
  for (const a of recentAnomalies) {
    score += SEVERITY_WEIGHT[a.severity] || 10;
  }

  return Math.min(100, score);
}

// ── Serialization helpers ──

function ensureArray(val: Set<string> | string[]): string[] {
  if (val instanceof Set) return [...val];
  return val;
}

/** Serialize profile for JSON storage (convert Sets to arrays) */
export function serializeProfile(profile: BehaviorProfile): Record<string, unknown> {
  return {
    ...profile,
    filesAccessed: ensureArray(profile.filesAccessed),
    directoriesAccessed: ensureArray(profile.directoriesAccessed),
    commandPatterns: ensureArray(profile.commandPatterns),
    externalHosts: ensureArray(profile.externalHosts),
  };
}

/** Generate a human-readable summary of the behavior profile */
export function profileSummary(profile: BehaviorProfile): string {
  const dist = profile.actionDistribution;
  const totalActions = profile.totalEvents;
  const files = ensureArray(profile.filesAccessed).length;
  const dirs = ensureArray(profile.directoriesAccessed).length;

  const lines: string[] = [];
  lines.push(`Behavior Profile (${totalActions} events, score: ${profile.anomalyScore}/100)`);

  // Top action categories
  const sorted = Object.entries(dist)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);
  if (sorted.length > 0) {
    lines.push(`  Actions: ${sorted.map(([k, v]) => `${k}(${v})`).join(', ')}`);
  }
  lines.push(`  Scope: ${files} files across ${dirs} directories`);

  if (profile.credentialAccesses.length > 0) {
    lines.push(`  Credential accesses: ${profile.credentialAccesses.length}`);
  }

  if (profile.anomalies.length > 0) {
    lines.push(`  Anomalies: ${profile.anomalies.length}`);
    for (const a of profile.anomalies.slice(-3)) {
      lines.push(`    [${a.severity.toUpperCase()}] ${a.description}`);
    }
  }

  return lines.join('\n');
}
