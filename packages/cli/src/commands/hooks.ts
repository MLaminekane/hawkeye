/**
 * hawkeye hooks install   — Configure Claude Code hooks for automatic event capture
 * hawkeye hooks uninstall — Remove Hawkeye hooks from Claude Code settings
 * hawkeye hooks status    — Check if hooks are installed
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import chalk from 'chalk';

function getClaudeSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.json');
}

function getLocalClaudeSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.local.json');
}

function readSettings(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(filePath: string, settings: Record<string, unknown>): void {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
}

// Resolve the hawkeye binary path (works with npm link, global install, etc.)
function getHawkeyeBin(): string {
  // Use the same binary that's currently running
  const argv0 = process.argv[1];
  if (argv0 && argv0.includes('hawkeye')) {
    // Running as `hawkeye` — use the binary name directly
    return 'hawkeye';
  }
  // Fallback: use node + script path
  return `node ${argv0}`;
}

function buildHookConfig(guardrailsOnly?: boolean) {
  const bin = getHawkeyeBin();

  const config: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {
    PreToolUse: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${bin} hook-handler --event PreToolUse`,
          },
        ],
      },
    ],
  };

  if (!guardrailsOnly) {
    config.PostToolUse = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${bin} hook-handler --event PostToolUse`,
          },
        ],
      },
    ];
    config.Stop = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${bin} hook-handler --event Stop`,
          },
        ],
      },
    ];
  }

  return config;
}

function isHawkeyeHook(hook: Record<string, unknown>): boolean {
  const cmd = String(hook.command || '');
  return cmd.includes('hawkeye') && cmd.includes('hook-handler');
}

const installCommand = new Command('install')
  .description('Install Claude Code hooks for automatic event capture & guardrails')
  .option('--local', 'Write to settings.local.json instead of settings.json')
  .option('--guardrails-only', 'Only install PreToolUse guardrail hooks')
  .action((options) => {
    const settingsPath = options.local
      ? getLocalClaudeSettingsPath()
      : getClaudeSettingsPath();

    const settings = readSettings(settingsPath);
    const hookConfig = buildHookConfig(options.guardrailsOnly);

    // Merge with existing hooks (don't overwrite non-Hawkeye hooks)
    const existing = (settings.hooks || {}) as Record<string, unknown[]>;

    for (const [eventType, newHooks] of Object.entries(hookConfig)) {
      const existingForType = (existing[eventType] || []) as Array<Record<string, unknown>>;

      // Remove any existing Hawkeye hooks
      const filtered = existingForType.filter((entry) => {
        const entryHooks = (entry.hooks || []) as Array<Record<string, unknown>>;
        return !entryHooks.some(isHawkeyeHook);
      });

      // Add our hooks
      filtered.push(...(newHooks as Array<Record<string, unknown>>));
      existing[eventType] = filtered;
    }

    settings.hooks = existing;
    writeSettings(settingsPath, settings);

    console.log('');
    console.log(chalk.green('  Hawkeye hooks installed'));
    console.log(chalk.dim('  ─'.repeat(25)));
    console.log(`  ${chalk.dim('Config:')} ${chalk.cyan(settingsPath)}`);
    console.log('');

    console.log(`  ${chalk.green('●')} ${chalk.bold('PreToolUse')}   — Guardrails block dangerous actions`);
    if (!options.guardrailsOnly) {
      console.log(`  ${chalk.green('●')} ${chalk.bold('PostToolUse')}  — Records actions + LLM cost estimation`);
      console.log(`  ${chalk.green('●')} ${chalk.bold('Stop')}         — Closes session with drift score`);
    }
    console.log('');
    console.log(chalk.dim('  Captures: commands, file ops, git operations, errors, LLM costs, drift detection'));
    console.log(chalk.dim('  Guards:   .env, *.pem, *.key | rm -rf, sudo rm, DROP TABLE'));
    console.log('');
    console.log(chalk.dim('  Sessions auto-created per Claude Code session.'));
    console.log(chalk.dim('  View: hawkeye serve'));
    console.log('');
  });

const uninstallCommand = new Command('uninstall')
  .description('Remove Hawkeye hooks from Claude Code settings')
  .option('--local', 'Remove from settings.local.json')
  .action((options) => {
    const settingsPath = options.local
      ? getLocalClaudeSettingsPath()
      : getClaudeSettingsPath();

    const settings = readSettings(settingsPath);
    const hooks = (settings.hooks || {}) as Record<string, unknown[]>;

    let removed = 0;
    for (const [eventType, entries] of Object.entries(hooks)) {
      const filtered = (entries as Array<Record<string, unknown>>).filter((entry) => {
        const entryHooks = (entry.hooks || []) as Array<Record<string, unknown>>;
        const hasHawkeye = entryHooks.some(isHawkeyeHook);
        if (hasHawkeye) removed++;
        return !hasHawkeye;
      });
      hooks[eventType] = filtered;

      // Clean up empty arrays
      if (filtered.length === 0) {
        delete hooks[eventType];
      }
    }

    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    } else {
      settings.hooks = hooks;
    }

    writeSettings(settingsPath, settings);

    if (removed > 0) {
      console.log(chalk.green(`  Removed ${removed} Hawkeye hook(s) from ${settingsPath}`));
    } else {
      console.log(chalk.dim('  No Hawkeye hooks found to remove.'));
    }
  });

const statusCommand = new Command('status')
  .description('Check if Hawkeye hooks are installed')
  .action(() => {
    const settingsPath = getClaudeSettingsPath();
    const localPath = getLocalClaudeSettingsPath();

    const checkFile = (path: string, label: string) => {
      const settings = readSettings(path);
      const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
      let found = 0;

      for (const entries of Object.values(hooks)) {
        for (const entry of entries as Array<Record<string, unknown>>) {
          const entryHooks = (entry.hooks || []) as Array<Record<string, unknown>>;
          if (entryHooks.some(isHawkeyeHook)) found++;
        }
      }

      if (found > 0) {
        console.log(`  ${chalk.green('●')} ${label}: ${found} hook(s) active`);
      } else {
        console.log(`  ${chalk.dim('○')} ${label}: no hooks`);
      }
    };

    console.log('');
    checkFile(settingsPath, 'settings.json');
    checkFile(localPath, 'settings.local.json');
    console.log('');
  });

export const hooksCommand = new Command('hooks')
  .description('Manage Claude Code hooks integration')
  .addCommand(installCommand)
  .addCommand(uninstallCommand)
  .addCommand(statusCommand);
