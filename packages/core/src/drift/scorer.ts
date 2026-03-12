import type { TraceEvent, DriftFlag } from '../types.js';
import { Logger } from '../logger.js';

const logger = new Logger('drift:scorer');

export interface DriftResult {
  score: number;
  flag: DriftFlag;
  reason: string;
}

interface ScoringContext {
  objective: string;
  workingDir: string;
}

// Dangerous command patterns that trigger immediate alerts
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+-rf\s+[/~]/, reason: 'Destructive recursive delete on root or home' },
  { pattern: /sudo\s+rm/, reason: 'Elevated privilege file deletion' },
  { pattern: /curl\s+.*\|\s*(ba)?sh/, reason: 'Piping remote script to shell' },
  { pattern: /wget\s+.*\|\s*(ba)?sh/, reason: 'Piping remote script to shell' },
  { pattern: /DROP\s+TABLE/i, reason: 'Database table drop detected' },
  { pattern: /DROP\s+DATABASE/i, reason: 'Database drop detected' },
  { pattern: /mkfs\./, reason: 'Filesystem format command' },
  { pattern: /dd\s+if=.*of=\/dev\//, reason: 'Raw disk write detected' },
  { pattern: /chmod\s+777/, reason: 'Overly permissive file permissions' },
  { pattern: />\s*\/etc\//, reason: 'Writing to system config directory' },
];

// Paths that are suspicious if modified outside project scope
const SUSPICIOUS_PATHS = [
  '/etc/',
  '/usr/',
  '/var/',
  '/tmp/',
  '~/.ssh/',
  '~/.bashrc',
  '~/.zshrc',
  '~/.profile',
  '~/.aws/',
  '~/.config/',
];

function flagFromScore(score: number): DriftFlag {
  if (score >= 70) return 'ok';
  if (score >= 40) return 'warning';
  return 'critical';
}

export function scoreHeuristic(
  events: TraceEvent[],
  context: ScoringContext,
): DriftResult {
  if (events.length === 0) {
    return { score: 100, flag: 'ok', reason: 'No actions to evaluate' };
  }

  let score = 100;
  const issues: string[] = [];

  // Check each event for concerning patterns
  for (const event of events) {
    const data = event.data;

    // Check commands for dangerous patterns
    if (event.type === 'command' && 'command' in data) {
      const fullCmd = `${data.command} ${(data.args as string[]).join(' ')}`;

      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(fullCmd)) {
          score -= 40;
          issues.push(reason);
          logger.warn(`Dangerous command detected: ${reason}`);
        }
      }

      // High error rate
      if ('exitCode' in data && data.exitCode !== 0 && data.exitCode != null) {
        score -= 5;
        issues.push(`Command failed (exit ${data.exitCode}): ${data.command}`);
      }
    }

    // Check file operations for scope violations
    if ((event.type === 'file_write' || event.type === 'file_delete') && 'path' in data) {
      const filePath = data.path as string;

      // Files outside the working directory
      if (!filePath.startsWith(context.workingDir)) {
        score -= 15;
        issues.push(`File modified outside project: ${filePath}`);
      }

      // Suspicious system paths
      for (const suspPath of SUSPICIOUS_PATHS) {
        if (filePath.includes(suspPath) || filePath.startsWith(suspPath.replace('~', ''))) {
          score -= 25;
          issues.push(`Sensitive path modified: ${filePath}`);
        }
      }

      // Sensitive file types
      if (filePath.match(/\.(pem|key|env|credentials|secret)$/i)) {
        score -= 20;
        issues.push(`Sensitive file modified: ${filePath}`);
      }
    }
  }

  // Check for repetitive errors (possible infinite loop)
  const recentErrors = events
    .slice(-10)
    .filter((e) => e.type === 'error' || (e.type === 'command' && 'exitCode' in e.data && (e.data as { exitCode?: number }).exitCode !== 0));

  if (recentErrors.length >= 5) {
    score -= 15;
    issues.push(`High error rate: ${recentErrors.length}/10 recent actions failed`);
  }

  // Check for no file modifications in a long sequence (tokenBurnWithoutProgress)
  const recentFileChanges = events
    .slice(-15)
    .filter((e) => e.type === 'file_write');

  if (events.length >= 15 && recentFileChanges.length === 0) {
    score -= 15;
    issues.push('No file modifications in last 15 actions — possible token burn without progress');
  }

  // Check for unrelated file types being modified
  const modifiedExtensions = events
    .filter((e) => (e.type === 'file_write' || e.type === 'file_delete') && 'path' in e.data)
    .map((e) => {
      const path = (e.data as { path: string }).path;
      const ext = path.split('.').pop()?.toLowerCase() || '';
      return ext;
    });

  const uniqueExtensions = new Set(modifiedExtensions);
  if (uniqueExtensions.size > 8) {
    score -= 10;
    issues.push(`Too many file types modified (${uniqueExtensions.size}) — may be off-track`);
  }

  // Check for dependency explosion (many dependency file changes)
  const depFileChanges = events.filter((e) => {
    if (e.type !== 'file_write' || !('path' in e.data)) return false;
    const path = (e.data as { path: string }).path;
    return path.includes('package.json') || path.includes('requirements.txt') ||
           path.includes('Cargo.toml') || path.includes('go.mod') ||
           path.includes('Gemfile') || path.includes('pom.xml');
  });

  if (depFileChanges.length > 5) {
    score -= 10;
    issues.push(`Dependency explosion: ${depFileChanges.length} dependency file changes`);
  }

  // Check for unexpected config file modifications
  const configFiles = events.filter((e) => {
    if (e.type !== 'file_write' || !('path' in e.data)) return false;
    const path = (e.data as { path: string }).path.toLowerCase();
    return path.includes('.eslintrc') || path.includes('.prettierrc') ||
           path.includes('tsconfig') || path.includes('.babelrc') ||
           path.includes('webpack.config') || path.includes('vite.config') ||
           path.includes('docker') || path.includes('.github/') ||
           path.includes('nginx.conf');
  });

  if (configFiles.length > 3) {
    score -= 10;
    issues.push(`Unexpected config changes: ${configFiles.length} config files modified`);
  }

  // Check for high LLM cost without proportional file changes (tokenBurnWithoutProgress v2)
  const totalLlmCost = events
    .filter((e) => e.type === 'llm_call')
    .reduce((sum, e) => sum + (e.costUsd || 0), 0);
  const totalFileWrites = events.filter((e) => e.type === 'file_write').length;

  if (totalLlmCost > 1.0 && totalFileWrites < 3) {
    score -= 15;
    issues.push(`High LLM cost ($${totalLlmCost.toFixed(2)}) with only ${totalFileWrites} file changes`);
  }

  score = Math.max(0, Math.min(100, score));
  const flag = flagFromScore(score);

  const reason = issues.length > 0
    ? issues.slice(0, 3).join('. ')
    : 'Actions appear consistent with objective';

  return { score, flag, reason };
}

/**
 * Compute a weighted sliding average of drift scores.
 * Recent scores weigh more than older ones.
 */
export function slidingDriftScore(scores: number[]): number {
  if (scores.length === 0) return 100;
  if (scores.length === 1) return scores[0];

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < scores.length; i++) {
    const weight = i + 1; // More recent = higher weight
    weightedSum += scores[i] * weight;
    totalWeight += weight;
  }

  return Math.round(weightedSum / totalWeight);
}
