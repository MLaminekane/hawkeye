import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FileEvent } from '../types.js';
import { Logger } from '../logger.js';

const logger = new Logger('interceptor:filesystem');

const DEFAULT_IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.hawkeye/**',
  '**/.turbo/**',
  '**/dist/**',
  '**/*.db',
  '**/*.db-journal',
  '**/*.db-wal',
  '**/*.db-shm',
  // Agent internal files — not real user actions
  '**/.aider*',           // Aider chat history, input history, tags cache
  '**/.cursor/**',        // Cursor internal state
  '**/.claude/**',        // Claude Code internal state
  '**/.codex/**',         // Codex internal state
];

export type FileCallback = (event: FileEvent) => void;

export interface FilesystemInterceptor {
  start(): void;
  stop(): void;
}

function safeReadFile(filePath: string): string | undefined {
  try {
    const stat = statSync(filePath);
    if (stat.size > 1024 * 1024) return `[file too large: ${stat.size} bytes]`;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function safeStatSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function computeHash(content: string | undefined): string | undefined {
  if (!content) return undefined;
  return createHash('sha256').update(content).digest('hex');
}

function computeLineDiff(before: string | undefined, after: string | undefined): { linesAdded: number; linesRemoved: number; diff: string } {
  const beforeLines = before ? before.split('\n') : [];
  const afterLines = after ? after.split('\n') : [];
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of afterLines) {
    if (!beforeSet.has(line)) linesAdded++;
  }
  for (const line of beforeLines) {
    if (!afterSet.has(line)) linesRemoved++;
  }
  return { linesAdded, linesRemoved, diff: computeUnifiedDiff(beforeLines, afterLines) };
}

/**
 * Compute a simple unified-style diff string from two arrays of lines.
 * Produces hunks with context lines, prefixed with +/- markers.
 */
function computeUnifiedDiff(beforeLines: string[], afterLines: string[]): string {
  // Simple LCS-based diff
  const m = beforeLines.length;
  const n = afterLines.length;
  if (m === 0 && n === 0) return '';

  // Build edit script using Myers-like approach (simple O(mn) DP)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Generate diff lines
  const lines: string[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && beforeLines[i] === afterLines[j]) {
      lines.push(` ${beforeLines[i]}`);
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      lines.push(`+${afterLines[j]}`);
      j++;
    } else {
      lines.push(`-${beforeLines[i]}`);
      i++;
    }
  }

  // Truncate to max 200 diff lines to avoid storing huge diffs
  if (lines.length > 200) {
    return lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more lines)`;
  }
  return lines.join('\n');
}

export interface FilesystemInterceptorOptions {
  extraIgnored?: string[];
  extraBlockedSegments?: string[];
  extraBlockedExtensions?: string[];
}

export function createFilesystemInterceptor(
  watchDir: string,
  onEvent: FileCallback,
  extraIgnoredOrOptions?: string[] | FilesystemInterceptorOptions,
): FilesystemInterceptor {
  let watcher: FSWatcher | null = null;
  const fileSnapshots = new Map<string, string | undefined>();

  // Support both legacy array and new options object
  const opts: FilesystemInterceptorOptions = Array.isArray(extraIgnoredOrOptions)
    ? { extraIgnored: extraIgnoredOrOptions }
    : (extraIgnoredOrOptions ?? {});

  function snapshotFile(filePath: string): void {
    fileSnapshots.set(filePath, safeReadFile(filePath));
  }

  return {
    start() {
      const ignored = [...DEFAULT_IGNORED, ...(opts.extraIgnored ?? [])];

      const blockedSegments = [
        '.hawkeye', 'node_modules', '.git', '.turbo', 'dist',
        '.cursor', '.claude', '.codex',
        ...(opts.extraBlockedSegments ?? []),
      ];
      // File prefixes to ignore (e.g. .aider.chat.history.md)
      const blockedPrefixes = ['.aider'];
      const blockedExtensions = [
        '.db', '.db-journal', '.db-wal', '.db-shm',
        ...(opts.extraBlockedExtensions ?? []),
      ];

      watcher = watch(watchDir, {
        ignored: (filePath: string) => {
          for (const seg of blockedSegments) {
            if (filePath.includes(`/${seg}/`) || filePath.endsWith(`/${seg}`)) return true;
          }
          for (const ext of blockedExtensions) {
            if (filePath.endsWith(ext)) return true;
          }
          // Check file basename prefixes (e.g. .aider.chat.history.md)
          const basename = filePath.split('/').pop() || '';
          for (const prefix of blockedPrefixes) {
            if (basename.startsWith(prefix)) return true;
          }
          return false;
        },
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      watcher.on('add', (filePath) => {
        logger.debug(`File created: ${filePath}`);
        const content = safeReadFile(filePath);
        const { linesAdded, linesRemoved, diff } = computeLineDiff(undefined, content);
        onEvent({
          path: filePath,
          action: 'write',
          contentAfter: content,
          diff,
          linesAdded,
          linesRemoved,
          sizeBytes: safeStatSize(filePath),
          contentHash: computeHash(content),
        });
        snapshotFile(filePath);
      });

      watcher.on('change', (filePath) => {
        logger.debug(`File modified: ${filePath}`);
        const contentBefore = fileSnapshots.get(filePath);
        const contentAfter = safeReadFile(filePath);
        const { linesAdded, linesRemoved, diff } = computeLineDiff(contentBefore, contentAfter);

        onEvent({
          path: filePath,
          action: 'write',
          contentBefore,
          contentAfter,
          diff,
          linesAdded,
          linesRemoved,
          sizeBytes: safeStatSize(filePath),
          contentHash: computeHash(contentAfter),
        });
        snapshotFile(filePath);
      });

      watcher.on('unlink', (filePath) => {
        logger.debug(`File deleted: ${filePath}`);
        const contentBefore = fileSnapshots.get(filePath);
        onEvent({
          path: filePath,
          action: 'delete',
          contentBefore,
          sizeBytes: 0,
        });
        fileSnapshots.delete(filePath);
      });

      watcher.on('ready', () => {
        logger.info(`Watching ${watchDir}`);
      });

      watcher.on('error', (err) => {
        logger.error(`Watcher error: ${String(err)}`);
      });
    },

    stop() {
      if (watcher) {
        watcher.close();
        watcher = null;
        fileSnapshots.clear();
        logger.debug('Filesystem interceptor stopped');
      }
    },
  };
}
