export function isTestedNodeVersion(version: string = process.versions.node): boolean {
  const major = Number(version.split('.')[0]);
  return Number.isInteger(major) && major >= 20;
}

export function warnIfUntestedNodeVersion(): void {
  if (isTestedNodeVersion()) {
    return;
  }

  console.warn(
    [
      'Hawkeye requires Node.js 20 or newer.',
      `Current Node.js version: ${process.version}.`,
      'If Hawkeye fails to load native SQLite bindings, reinstall or rebuild dependencies with this Node version.',
    ].join('\n'),
  );
}

export function isNativeSqliteBindingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = `${error.message}\n${error.stack ?? ''}`;
  return message.includes('better-sqlite3') || message.includes('better_sqlite3.node');
}

export function printNativeSqliteHelp(): void {
  console.error(
    [
      'Hawkeye could not load its native SQLite dependency.',
      `Current Node.js version: ${process.version}.`,
      'Try one of these fixes:',
      '- reinstall hawkeye-ai with your current Node.js version',
      '- run npm rebuild better-sqlite3 if you installed from npm',
      '- reinstall the Homebrew formula so its bundled dependencies are rebuilt',
    ].join('\n'),
  );
}
