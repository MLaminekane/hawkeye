import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';
import type { CommandEvent } from '../types.js';
import { Logger } from '../logger.js';

const logger = new Logger('interceptor:terminal');

const SENSITIVE_PATTERNS = [
  /--token[= ]\S+/gi,
  /--password[= ]\S+/gi,
  /--secret[= ]\S+/gi,
  /[A-Z_]*API_KEY[= ]\S+/gi,
  /[A-Z_]*SECRET[= ]\S+/gi,
  /Bearer\s+\S+/gi,
];

function sanitize(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function truncate(text: string, maxBytes: number = 10240): string {
  if (text.length <= maxBytes) return text;
  return text.slice(0, maxBytes) + `\n... [truncated, ${text.length} bytes total]`;
}

export type CommandCallback = (event: CommandEvent) => void;

export interface TerminalInterceptor {
  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
  destroy(): void;
}

export interface TerminalInterceptorOptions {
  maxStdoutBytes?: number;
}

export function createTerminalInterceptor(onEvent: CommandCallback, options?: TerminalInterceptorOptions): TerminalInterceptor {
  const maxBytes = options?.maxStdoutBytes ?? 10240;
  return {
    spawn(command: string, args: string[], spawnOptions?: SpawnOptions): ChildProcess {
      const startTime = Date.now();
      const cwd = (spawnOptions?.cwd as string) ?? process.cwd();
      const requestedStdio = spawnOptions?.stdio;
      const stdio: StdioOptions = Array.isArray(requestedStdio)
        ? [
            requestedStdio[0] ?? 'inherit',
            requestedStdio[1] ?? 'pipe',
            requestedStdio[2] ?? 'pipe',
            ...requestedStdio.slice(3),
          ]
        : ['inherit', 'pipe', 'pipe'];

      logger.debug(`Spawning: ${command} ${args.join(' ')}`);

      const child: ChildProcess = spawn(command, args, {
        ...spawnOptions,
        stdio,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(chunk);
      });

      child.on('close', (exitCode: number | null) => {
        const event: CommandEvent = {
          command: sanitize(command),
          args: args.map(sanitize),
          cwd,
          exitCode: exitCode ?? undefined,
          stdout: truncate(sanitize(stdout), maxBytes),
          stderr: truncate(sanitize(stderr), maxBytes),
        };

        logger.debug(`Command exited with code ${exitCode}: ${command}`);
        onEvent(event);
      });

      return child;
    },

    destroy() {
      logger.debug('Terminal interceptor destroyed');
    },
  };
}
