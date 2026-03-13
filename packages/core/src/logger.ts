export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Global log level override — set via HAWKEYE_LOG_LEVEL env or Logger.setGlobalLevel(). */
let globalLevel: LogLevel | null = null;

function resolveGlobalLevel(): LogLevel | null {
  if (globalLevel) return globalLevel;
  const env = process.env.HAWKEYE_LOG_LEVEL;
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return null;
}

export class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix: string, level: LogLevel = 'info') {
    this.prefix = prefix;
    this.level = level;
  }

  /** Set log level globally for all Logger instances. */
  static setGlobalLevel(level: LogLevel): void {
    globalLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const effective = resolveGlobalLevel() ?? this.level;
    return LEVEL_ORDER[level] >= LEVEL_ORDER[effective];
  }

  private format(level: LogLevel, msg: string): string {
    const time = new Date().toISOString().slice(11, 23);
    return `[${time}] [${level.toUpperCase()}] [${this.prefix}] ${msg}`;
  }

  debug(msg: string): void {
    if (this.shouldLog('debug')) process.stderr.write(this.format('debug', msg) + '\n');
  }

  info(msg: string): void {
    if (this.shouldLog('info')) process.stderr.write(this.format('info', msg) + '\n');
  }

  warn(msg: string): void {
    if (this.shouldLog('warn')) process.stderr.write(this.format('warn', msg) + '\n');
  }

  error(msg: string): void {
    if (this.shouldLog('error')) process.stderr.write(this.format('error', msg) + '\n');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}
