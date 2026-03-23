/**
 * Impact Preview Engine
 *
 * Analyzes agent actions BEFORE execution to compute:
 * - What files/data will be affected
 * - Risk level (low / medium / high / critical)
 * - Human-readable impact summary
 *
 * This is the core of Hawkeye's "AI Agent Firewall" — see what
 * the agent will do before it does it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';

// ── Types ──

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ImpactPreview {
  risk: RiskLevel;
  summary: string;
  details: string[];
  affectedFiles: number;
  affectedLines: number;
  gitTracked: boolean;
  uncommittedChanges: boolean;
  category: ImpactCategory;
}

export type ImpactCategory =
  | 'file_delete'
  | 'file_write'
  | 'file_overwrite'
  | 'git_destructive'
  | 'git_push'
  | 'system_command'
  | 'package_publish'
  | 'database_destructive'
  | 'network_pipe'
  | 'permission_change'
  | 'process_kill'
  | 'docker_operation'
  | 'safe';

// ── Helpers ──

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

function countFilesRecursive(dirPath: string, limit = 1000): number {
  let count = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= limit) return count;
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        count += countFilesRecursive(resolve(dirPath, entry.name), limit - count);
      } else if (entry.isFile()) {
        count++;
      }
    }
  } catch {
    // Permission denied or doesn't exist
  }
  return count;
}

function isGitTracked(filePath: string): boolean {
  const result = git('ls-files', '--error-unmatch', filePath);
  return result.length > 0;
}

function hasUncommittedChanges(filePath: string): boolean {
  const status = git('status', '--porcelain', filePath);
  return status.length > 0;
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return p.replace('~', homedir());
  return resolve(p);
}

// Sensitive file patterns that increase risk
export const SENSITIVE_PATTERNS = [
  /\.env($|\.)/,
  /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /id_rsa/, /id_ed25519/, /\.ssh\//,
  /\.credentials/, /\.secret/,
  /config\.(json|ya?ml|toml)$/,
  /docker-compose/, /Dockerfile/,
  /\.github\/workflows/,
  /migrations?\//,
  /schema\.(sql|prisma|graphql)$/,
  /package\.json$/, /package-lock\.json$/,
  /Cargo\.lock$/, /go\.sum$/,
];

export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(filePath));
}

// ── Bash Command Analysis ──

interface CommandPattern {
  regex: RegExp;
  analyze: (match: RegExpMatchArray, fullCmd: string) => ImpactPreview;
}

function analyzeRmCommand(match: RegExpMatchArray, fullCmd: string): ImpactPreview {
  const flags = match[1] || '';
  const target = match[2] || '';
  const expanded = expandPath(target);
  const isRecursive = flags.includes('r') || flags.includes('R');
  const isForce = flags.includes('f');

  const details: string[] = [];
  let affectedFiles = 0;
  let affectedLines = 0;
  let risk: RiskLevel = 'medium';

  // Check what's being deleted
  if (existsSync(expanded)) {
    const stat = statSync(expanded);
    if (stat.isDirectory() && isRecursive) {
      affectedFiles = countFilesRecursive(expanded);
      details.push(`Deletes directory with ${affectedFiles} file${affectedFiles !== 1 ? 's' : ''}`);
      risk = affectedFiles > 50 ? 'critical' : affectedFiles > 10 ? 'high' : 'medium';
    } else if (stat.isFile()) {
      affectedFiles = 1;
      affectedLines = countLines(expanded);
      details.push(`Deletes file (${affectedLines} lines)`);
      risk = isSensitiveFile(expanded) ? 'high' : 'medium';
    }

    const tracked = isGitTracked(expanded);
    if (tracked) {
      details.push('File is git-tracked');
      if (hasUncommittedChanges(expanded)) {
        details.push('Has uncommitted changes that will be lost');
        risk = 'critical';
      }
    }
  } else {
    details.push('Target does not exist (no-op)');
    risk = 'low';
  }

  // Dangerous paths
  if (/^\/?$|^\/usr|^\/etc|^\/var|^\/sys|^\/boot|^~?\/?$/.test(target)) {
    risk = 'critical';
    details.push('Targets system-critical directory');
  }

  if (isForce) {
    details.push('Force flag (-f) suppresses confirmations');
    if (risk === 'medium') risk = 'high';
  }

  return {
    risk,
    summary: `rm ${flags ? `-${flags} ` : ''}${target}: ${details[0] || 'delete operation'}`,
    details,
    affectedFiles,
    affectedLines,
    gitTracked: existsSync(expanded) ? isGitTracked(expanded) : false,
    uncommittedChanges: existsSync(expanded) ? hasUncommittedChanges(expanded) : false,
    category: 'file_delete',
  };
}

function analyzeGitForce(match: RegExpMatchArray, fullCmd: string): ImpactPreview {
  const details: string[] = [];
  let risk: RiskLevel = 'critical';

  if (fullCmd.includes('push') && (fullCmd.includes('--force') || fullCmd.includes('-f'))) {
    // git push --force
    const currentBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const remoteBranch = git('rev-parse', '--abbrev-ref', '@{upstream}');

    if (remoteBranch) {
      const aheadBehind = git('rev-list', '--left-right', '--count', `${remoteBranch}...HEAD`);
      const [behind] = (aheadBehind || '0\t0').split('\t').map(Number);
      if (behind > 0) {
        details.push(`Overwrites ${behind} remote commit${behind !== 1 ? 's' : ''}`);
      }
    }

    // Check if pushing to main/master
    if (currentBranch === 'main' || currentBranch === 'master') {
      details.push('Force-pushing to main/master branch');
      risk = 'critical';
    }

    // Check collaborators
    const logOutput = git('log', '--format=%ae', '-20', remoteBranch || 'HEAD');
    const uniqueAuthors = new Set(logOutput.split('\n').filter(Boolean));
    if (uniqueAuthors.size > 1) {
      details.push(`Branch has commits from ${uniqueAuthors.size} contributors`);
    }

    return {
      risk,
      summary: `git push --force: overwrites remote history on ${currentBranch}`,
      details,
      affectedFiles: 0,
      affectedLines: 0,
      gitTracked: true,
      uncommittedChanges: false,
      category: 'git_destructive',
    };
  }

  if (fullCmd.includes('reset') && fullCmd.includes('--hard')) {
    const diffStat = git('diff', '--stat', '--shortstat');
    const stagedStat = git('diff', '--cached', '--shortstat');
    details.push('Discards ALL uncommitted changes');
    if (diffStat) details.push(`Unstaged changes: ${diffStat}`);
    if (stagedStat) details.push(`Staged changes: ${stagedStat}`);

    const filesChanged = git('diff', '--name-only');
    const stagedFiles = git('diff', '--cached', '--name-only');
    const allFiles = new Set([...filesChanged.split('\n'), ...stagedFiles.split('\n')].filter(Boolean));

    return {
      risk: allFiles.size > 0 ? 'critical' : 'low',
      summary: `git reset --hard: discards ${allFiles.size} uncommitted file change${allFiles.size !== 1 ? 's' : ''}`,
      details,
      affectedFiles: allFiles.size,
      affectedLines: 0,
      gitTracked: true,
      uncommittedChanges: allFiles.size > 0,
      category: 'git_destructive',
    };
  }

  if (fullCmd.includes('clean') && fullCmd.includes('-f')) {
    const dryRun = git('clean', '-n', fullCmd.includes('-d') ? '-d' : '');
    const filesToDelete = dryRun.split('\n').filter(Boolean).length;
    details.push(`Removes ${filesToDelete} untracked file${filesToDelete !== 1 ? 's' : ''}`);
    return {
      risk: filesToDelete > 10 ? 'high' : 'medium',
      summary: `git clean -f: permanently removes ${filesToDelete} untracked files`,
      details,
      affectedFiles: filesToDelete,
      affectedLines: 0,
      gitTracked: false,
      uncommittedChanges: false,
      category: 'git_destructive',
    };
  }

  return {
    risk: 'high',
    summary: `Destructive git operation: ${fullCmd.slice(0, 80)}`,
    details: ['This git command modifies history or discards changes'],
    affectedFiles: 0,
    affectedLines: 0,
    gitTracked: true,
    uncommittedChanges: false,
    category: 'git_destructive',
  };
}

function analyzeDbDestructive(_match: RegExpMatchArray, fullCmd: string): ImpactPreview {
  const upper = fullCmd.toUpperCase();
  let summary = 'Database destructive operation';
  const details: string[] = [];

  if (upper.includes('DROP TABLE')) {
    const tableMatch = fullCmd.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"']?(\w+)/i);
    summary = `DROP TABLE ${tableMatch?.[1] || 'unknown'}: permanently deletes table and all data`;
    details.push('All rows will be permanently deleted');
    details.push('Foreign key references may break');
  } else if (upper.includes('DROP DATABASE')) {
    const dbMatch = fullCmd.match(/DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?[`"']?(\w+)/i);
    summary = `DROP DATABASE ${dbMatch?.[1] || 'unknown'}: permanently deletes entire database`;
    details.push('ALL tables and data will be permanently deleted');
  } else if (upper.includes('TRUNCATE')) {
    const tableMatch = fullCmd.match(/TRUNCATE\s+(?:TABLE\s+)?[`"']?(\w+)/i);
    summary = `TRUNCATE ${tableMatch?.[1] || 'unknown'}: deletes all rows`;
    details.push('All rows will be removed (faster than DELETE, no rollback)');
  } else if (upper.includes('DELETE') && !upper.includes('WHERE')) {
    summary = 'DELETE without WHERE clause: deletes ALL rows';
    details.push('No WHERE clause — this will delete every row in the table');
  }

  return {
    risk: 'critical',
    summary,
    details,
    affectedFiles: 0,
    affectedLines: 0,
    gitTracked: false,
    uncommittedChanges: false,
    category: 'database_destructive',
  };
}

function analyzePipeExecution(_match: RegExpMatchArray, fullCmd: string): ImpactPreview {
  return {
    risk: 'critical',
    summary: 'Piping remote content to shell: executes arbitrary code from the internet',
    details: [
      'Downloads and executes code in a single step — no review possible',
      'Attacker-controlled servers could serve malicious payloads',
      `Full command: ${fullCmd.slice(0, 200)}`,
    ],
    affectedFiles: 0,
    affectedLines: 0,
    gitTracked: false,
    uncommittedChanges: false,
    category: 'network_pipe',
  };
}

function analyzeNpmPublish(_match: RegExpMatchArray, fullCmd: string): ImpactPreview {
  const details: string[] = [];
  // Check package.json for version
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    details.push(`Package: ${pkg.name}@${pkg.version}`);
    if (pkg.files) {
      details.push(`Publishes: ${pkg.files.join(', ')}`);
    }
  } catch {}

  return {
    risk: 'high',
    summary: 'npm publish: publishes package to the public registry',
    details: [
      ...details,
      'Published packages are publicly accessible',
      'Unpublishing has restrictions (72h window, name squatting policy)',
    ],
    affectedFiles: 0,
    affectedLines: 0,
    gitTracked: false,
    uncommittedChanges: false,
    category: 'package_publish',
  };
}

function analyzeChmod(_match: RegExpMatchArray, fullCmd: string): ImpactPreview {
  const is777 = fullCmd.includes('777');
  const isRecursive = fullCmd.includes('-R');
  const details: string[] = [];

  if (is777) {
    details.push('Sets world-readable + writable + executable');
    details.push('Any user on the system can read, modify, and execute these files');
  }

  return {
    risk: is777 ? 'high' : 'medium',
    summary: `chmod: changes file permissions${isRecursive ? ' recursively' : ''}`,
    details,
    affectedFiles: 0,
    affectedLines: 0,
    gitTracked: false,
    uncommittedChanges: false,
    category: 'permission_change',
  };
}

const BASH_PATTERNS: CommandPattern[] = [
  // File deletion
  {
    regex: /\brm\s+(?:-([a-zA-Z]*)\s+)?(.+?)(?:\s*[;&|]|$)/,
    analyze: analyzeRmCommand,
  },
  // Git destructive operations
  {
    regex: /\bgit\s+(?:push\s+.*--force|push\s+-f|reset\s+--hard|clean\s+-[fd]*f|rebase\s+-i|branch\s+-D)/,
    analyze: analyzeGitForce,
  },
  // Database destructive
  {
    regex: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE?|DELETE\s+FROM)\b/i,
    analyze: analyzeDbDestructive,
  },
  // Pipe to shell (curl|bash, wget|sh, etc.)
  {
    regex: /\b(?:curl|wget)\b.*\|\s*(?:bash|sh|zsh)\b/,
    analyze: analyzePipeExecution,
  },
  // npm/pnpm publish
  {
    regex: /\b(?:npm|pnpm|yarn)\s+publish\b/,
    analyze: analyzeNpmPublish,
  },
  // chmod 777 or recursive chmod
  {
    regex: /\bchmod\b/,
    analyze: analyzeChmod,
  },
  // Docker dangerous operations
  {
    regex: /\bdocker\s+(?:system\s+prune|rm\s+-f|rmi\s+-f|volume\s+rm)/,
    analyze: (_match, cmd) => ({
      risk: 'high' as RiskLevel,
      summary: `Docker cleanup: may remove containers, images, or volumes`,
      details: ['Docker resources will be permanently removed'],
      affectedFiles: 0,
      affectedLines: 0,
      gitTracked: false,
      uncommittedChanges: false,
      category: 'docker_operation' as ImpactCategory,
    }),
  },
  // Kill processes
  {
    regex: /\bkill(?:all)?\s+(?:-9\s+)?/,
    analyze: (_match, cmd) => ({
      risk: 'medium' as RiskLevel,
      summary: 'Process termination',
      details: ['Forcefully terminates process(es)'],
      affectedFiles: 0,
      affectedLines: 0,
      gitTracked: false,
      uncommittedChanges: false,
      category: 'process_kill' as ImpactCategory,
    }),
  },
];

// ── File Write/Edit Analysis ──

function analyzeFileWrite(filePath: string, content?: string): ImpactPreview {
  const expanded = expandPath(filePath);
  const details: string[] = [];
  let risk: RiskLevel = 'low';
  let affectedLines = 0;
  let affectedFiles = 1;
  const fileExists = existsSync(expanded);

  if (fileExists) {
    const existingLines = countLines(expanded);
    const existingSize = statSync(expanded).size;
    affectedLines = existingLines;
    details.push(`Overwrites existing file (${existingLines} lines, ${(existingSize / 1024).toFixed(1)}KB)`);
    risk = 'medium';

    if (isGitTracked(expanded)) {
      details.push('File is git-tracked');
      if (hasUncommittedChanges(expanded)) {
        details.push('Has uncommitted changes that will be overwritten');
        risk = 'high';
      }
    }
  } else {
    details.push('Creates new file');
    risk = 'low';
  }

  if (isSensitiveFile(filePath)) {
    details.push('Sensitive file type detected');
    risk = risk === 'low' ? 'medium' : 'high';
  }

  // Check if content is provided and seems large
  if (content) {
    const newLines = content.split('\n').length;
    if (fileExists) {
      details.push(`New content: ${newLines} lines`);
    }
    affectedLines = Math.max(affectedLines, newLines);
  }

  const category = fileExists ? 'file_overwrite' : 'file_write';
  const action = fileExists ? 'overwrites' : 'creates';
  const name = basename(filePath);

  return {
    risk,
    summary: `Write ${action} ${name}${fileExists ? ` (${affectedLines} lines)` : ''}`,
    details,
    affectedFiles,
    affectedLines,
    gitTracked: fileExists ? isGitTracked(expanded) : false,
    uncommittedChanges: fileExists ? hasUncommittedChanges(expanded) : false,
    category,
  };
}

function analyzeFileEdit(
  filePath: string,
  oldString?: string,
  newString?: string,
): ImpactPreview {
  const expanded = expandPath(filePath);
  const details: string[] = [];
  let risk: RiskLevel = 'low';
  const fileExists = existsSync(expanded);

  if (!fileExists) {
    return {
      risk: 'low',
      summary: `Edit targets non-existent file: ${basename(filePath)}`,
      details: ['File does not exist — edit will likely fail'],
      affectedFiles: 0,
      affectedLines: 0,
      gitTracked: false,
      uncommittedChanges: false,
      category: 'safe',
    };
  }

  const totalLines = countLines(expanded);
  const linesRemoved = oldString ? oldString.split('\n').length : 0;
  const linesAdded = newString ? newString.split('\n').length : 0;
  const percentAffected = totalLines > 0 ? Math.round((linesRemoved / totalLines) * 100) : 0;

  details.push(`File has ${totalLines} lines`);
  details.push(`Replaces ${linesRemoved} line${linesRemoved !== 1 ? 's' : ''} with ${linesAdded} line${linesAdded !== 1 ? 's' : ''} (${percentAffected}% of file)`);

  if (percentAffected > 50) {
    risk = 'high';
    details.push('Large replacement: modifies majority of file');
  } else if (percentAffected > 20) {
    risk = 'medium';
  }

  if (isSensitiveFile(filePath)) {
    details.push('Sensitive file type');
    risk = risk === 'low' ? 'medium' : risk;
  }

  if (hasUncommittedChanges(expanded)) {
    details.push('File has uncommitted changes');
  }

  return {
    risk,
    summary: `Edit ${basename(filePath)}: ${linesRemoved}→${linesAdded} lines (${percentAffected}% of file)`,
    details,
    affectedFiles: 1,
    affectedLines: linesRemoved,
    gitTracked: isGitTracked(expanded),
    uncommittedChanges: hasUncommittedChanges(expanded),
    category: 'file_overwrite',
  };
}

// ── Git Push Analysis (non-force) ──

function analyzeGitPush(fullCmd: string): ImpactPreview {
  const details: string[] = [];
  const currentBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const unpushed = git('log', '--oneline', '@{upstream}..HEAD');
  const commitCount = unpushed ? unpushed.split('\n').length : 0;

  details.push(`Branch: ${currentBranch}`);
  details.push(`${commitCount} unpushed commit${commitCount !== 1 ? 's' : ''}`);

  // Check if pushing to main/master
  let risk: RiskLevel = 'low';
  if (currentBranch === 'main' || currentBranch === 'master') {
    details.push('Pushing directly to main/master');
    risk = 'medium';
  }

  return {
    risk,
    summary: `git push: ${commitCount} commit${commitCount !== 1 ? 's' : ''} to ${currentBranch}`,
    details,
    affectedFiles: 0,
    affectedLines: 0,
    gitTracked: true,
    uncommittedChanges: false,
    category: 'git_push',
  };
}

// ── Main Entry Point ──

export function analyzeImpact(
  toolName: string,
  toolInput: Record<string, unknown>,
): ImpactPreview | null {
  // Bash commands
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '');
    if (!cmd) return null;

    // Check against dangerous patterns
    for (const pattern of BASH_PATTERNS) {
      const match = cmd.match(pattern.regex);
      if (match) {
        return pattern.analyze(match, cmd);
      }
    }

    // Non-force git push still gets a preview
    if (/\bgit\s+push\b/.test(cmd) && !cmd.includes('--force') && !/ -f\b/.test(cmd)) {
      return analyzeGitPush(cmd);
    }

    // Safe command — no impact preview needed
    return null;
  }

  // File write
  if (toolName === 'Write') {
    const filePath = String(toolInput.file_path || toolInput.path || '');
    if (!filePath) return null;
    const content = toolInput.content ? String(toolInput.content) : undefined;
    return analyzeFileWrite(filePath, content);
  }

  // File edit
  if (toolName === 'Edit') {
    const filePath = String(toolInput.file_path || toolInput.path || '');
    if (!filePath) return null;
    const oldStr = toolInput.old_string ? String(toolInput.old_string) : undefined;
    const newStr = toolInput.new_string ? String(toolInput.new_string) : undefined;
    return analyzeFileEdit(filePath, oldStr, newStr);
  }

  return null;
}

// ── Formatted Output ──

const RISK_ICONS: Record<RiskLevel, string> = {
  low: '\x1b[32m◉\x1b[0m',       // green
  medium: '\x1b[33m◉\x1b[0m',    // yellow
  high: '\x1b[38;5;208m◉\x1b[0m', // orange
  critical: '\x1b[31m◉\x1b[0m',  // red
};

const RISK_LABELS: Record<RiskLevel, string> = {
  low: '\x1b[32mLOW\x1b[0m',
  medium: '\x1b[33mMEDIUM\x1b[0m',
  high: '\x1b[38;5;208mHIGH\x1b[0m',
  critical: '\x1b[31mCRITICAL\x1b[0m',
};

export function formatImpactPreview(impact: ImpactPreview): string {
  const lines: string[] = [];
  lines.push(`${RISK_ICONS[impact.risk]}  \x1b[1m[hawkeye] Impact Preview\x1b[0m  risk: ${RISK_LABELS[impact.risk]}`);
  lines.push(`   ${impact.summary}`);
  for (const detail of impact.details) {
    lines.push(`   · ${detail}`);
  }
  return lines.join('\n');
}

// ── Risk-based Decision ──

export function shouldBlockAction(impact: ImpactPreview): boolean {
  return impact.risk === 'critical';
}

export function shouldWarnAction(impact: ImpactPreview): boolean {
  return impact.risk === 'high' || impact.risk === 'critical';
}
