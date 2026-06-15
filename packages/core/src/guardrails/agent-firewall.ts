/**
 * Agent Firewall — runtime security checks for AI agent actions.
 *
 * Detects:
 * - Code exfiltration (sending source/secrets to external hosts)
 * - Malicious code in git push diffs (secrets, obfuscation, reverse shells)
 * - Tool output injection (prompt injection hiding in file content / command output)
 *
 * These functions are called from the hook-handler during PreToolUse and PostToolUse.
 */

import { execSync } from 'node:child_process';
import { scanContent } from './content-scanner.js';

// ── Exfiltration Detection ──

export interface ExfiltrationPattern {
  name: string;
  pattern: RegExp;
}

export const EXFILTRATION_PATTERNS: ExfiltrationPattern[] = [
  { name: 'curl_post_data', pattern: /\bcurl\b.*(?:-d\b|--data\b|--data-raw\b|--data-binary\b|--upload-file\b).*(?:https?:\/\/)/i },
  { name: 'curl_file_upload', pattern: /\bcurl\b.*(?:@\S+|<\s*\S+).*(?:https?:\/\/)/i },
  { name: 'pipe_to_curl', pattern: /\b(?:cat|base64|tar|gzip|zip)\b.*\|.*\b(?:curl|wget|nc|ncat)\b/i },
  { name: 'base64_exfil', pattern: /\bbase64\b.*\|.*\b(?:curl|wget|nc)\b/i },
  { name: 'archive_exfil', pattern: /\b(?:tar|zip|gzip)\b.*\|.*\b(?:curl|wget|nc)\b/i },
  { name: 'netcat_exfil', pattern: /\b(?:nc|ncat)\b.*<\s*\S+/i },
  { name: 'scp_exfil', pattern: /\b(?:scp|rsync)\b.*\S+@(?!localhost|127\.0\.0\.1)\S+:/i },
  { name: 'env_exfil', pattern: /\b(?:env|printenv|set)\b.*\|.*\b(?:curl|wget|nc)\b/i },
  { name: 'source_encode', pattern: /\b(?:cat|head|tail)\b.*\.(?:ts|js|py|go|rs|java|rb|php|env|key|pem)\b.*\|.*\b(?:base64|xxd|od)\b/i },
];

/**
 * Detect potential code/data exfiltration in a shell command.
 */
export function detectExfiltration(command: string): string | null {
  if (!command) return null;

  for (const { name, pattern } of EXFILTRATION_PATTERNS) {
    if (pattern.test(command)) {
      return `Potential code exfiltration detected (${name}): command appears to send file content to an external host`;
    }
  }

  // Detect reading sensitive files and sending to external URLs in same command
  const readsSensitiveFile = /\b(?:cat|less|head|tail|xxd)\b.*(?:\.env|\.key|\.pem|id_rsa|credentials|\.secret|\.aws)/i.test(command);
  const sendsExternal = /\b(?:curl|wget|nc|ncat|scp|rsync)\b/i.test(command);
  if (readsSensitiveFile && sendsExternal) {
    return 'Potential secret exfiltration: command reads sensitive files and uses a network tool';
  }

  return null;
}

// ── Git Push Content Inspection ──

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'AWS key', pattern: /AKIA[A-Z0-9]{16}/ },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'API key (generic)', pattern: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/i },
  { name: 'GitHub token', pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'Slack token', pattern: /xox[bprs]-[a-zA-Z0-9-]+/ },
  { name: 'JWT', pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/ },
];

export const SUSPICIOUS_CODE_PATTERNS: SecretPattern[] = [
  { name: 'eval/exec injection', pattern: /\beval\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent)\b/i },
  { name: 'obfuscated code', pattern: /\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i },
  { name: 'hardcoded C2-style IP', pattern: /['"]https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\/[a-z]/i },
  { name: 'reverse shell', pattern: /\b(?:nc|ncat|bash)\b.*(?:-e\s*\/bin\/(?:sh|bash)|\/dev\/tcp\/)/i },
  { name: 'environment variable theft', pattern: /process\.env\b.*(?:fetch|axios|http|request)\b/i },
  { name: 'suspicious postinstall', pattern: /"(?:pre|post)install"\s*:\s*".*(?:curl|wget|node\s+-e|eval)/i },
];

/**
 * Scan diff content (added lines only) for secrets and suspicious code.
 * Returns an array of warnings. Empty = clean.
 */
export function scanDiffContent(diffContent: string): string[] {
  const warnings: string[] = [];
  if (!diffContent) return warnings;

  // Only check added lines (lines starting with +, excluding +++ header)
  const addedLines = diffContent.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const addedContent = addedLines.join('\n');

  if (!addedContent) return warnings;

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(addedContent)) {
      warnings.push(`Secret detected in commit diff: ${name}`);
    }
  }

  for (const { name, pattern } of SUSPICIOUS_CODE_PATTERNS) {
    if (pattern.test(addedContent)) {
      warnings.push(`Suspicious code in commit: ${name}`);
    }
  }

  return warnings;
}

/**
 * Inspect git push content by running git diff on unpushed commits.
 * Returns null if clean, or a warning string if threats found.
 */
export function checkGitPushContent(command: string, cwd?: string): string | null {
  if (!/\bgit\s+push\b/.test(command)) return null;

  try {
    const diffContent = execSync(
      'git diff @{push}..HEAD --diff-filter=ACMR 2>/dev/null || git diff origin/HEAD..HEAD --diff-filter=ACMR 2>/dev/null || echo ""',
      {
        encoding: 'utf-8',
        timeout: 10000,
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).slice(0, 50000);

    const warnings = scanDiffContent(String(diffContent));

    if (warnings.length > 0) {
      return `Git push content inspection: ${warnings.join('; ')}`;
    }
  } catch {
    // git diff failed — don't block
  }

  return null;
}

// ── Tool Output Injection Detection ──

/**
 * Scan tool output for prompt injection patterns.
 * This catches injections hiding in file content, API responses,
 * and command output that will be fed back to the LLM context.
 */
export function scanToolOutput(
  toolName: string,
  toolOutput: string | undefined,
): { injected: boolean; patterns: string[] } {
  if (!toolOutput) return { injected: false, patterns: [] };

  // Only scan tools whose output enters the LLM context
  const contextTools = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
  if (!contextTools.includes(toolName)) return { injected: false, patterns: [] };

  const result = scanContent(toolOutput);
  return {
    injected: result.promptInjection,
    patterns: result.injectionPatterns,
  };
}
