import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import chalk from 'chalk';

interface PendingReview {
  id: string;
  timestamp: string;
  sessionId: string;
  claudeSessionId: string;
  command: string;
  matchedPattern: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface ReviewApproval {
  pattern: string;
  scope: 'session' | 'always';
  sessionId?: string;
  approvedAt: string;
  approvedCommand: string;
}

export const approveCommand = new Command('approve')
  .description('Approve pending review gate actions')
  .option('-a, --all', 'Approve all pending reviews (session scope)')
  .option('-p, --permanent', 'Approve with permanent scope (use with --all or pattern)')
  .option('--deny', 'Deny all pending reviews')
  .option('--list', 'List pending reviews without acting')
  .argument('[pattern]', 'Approve a specific pattern')
  .action((pattern, options) => {
    const cwd = process.cwd();
    const hawkDir = join(cwd, '.hawkeye');
    const pendingFile = join(hawkDir, 'pending-reviews.json');
    const approvalsFile = join(hawkDir, 'review-approvals.json');

    if (!existsSync(hawkDir)) {
      mkdirSync(hawkDir, { recursive: true });
    }

    // Load pending reviews
    let pending: PendingReview[] = [];
    try {
      if (existsSync(pendingFile)) {
        pending = JSON.parse(readFileSync(pendingFile, 'utf-8'));
      }
    } catch {}

    if (pending.length === 0) {
      console.log(chalk.dim('  No pending review gate actions.'));
      return;
    }

    // List mode
    if (options.list) {
      console.log('');
      console.log(chalk.hex('#ff5f1f')('  Pending Review Gate Actions'));
      console.log(chalk.dim('  ' + '-'.repeat(50)));
      for (const p of pending) {
        const ts = new Date(p.timestamp).toLocaleTimeString();
        console.log(`  ${chalk.yellow(p.command.slice(0, 80))}`);
        console.log(chalk.dim(`    Pattern: "${p.matchedPattern}"  |  ${ts}  |  ID: ${p.id.slice(0, 8)}`));
      }
      console.log('');
      return;
    }

    // Load approvals
    let approvals: ReviewApproval[] = [];
    try {
      if (existsSync(approvalsFile)) {
        approvals = JSON.parse(readFileSync(approvalsFile, 'utf-8'));
      }
    } catch {}

    const scope: 'session' | 'always' = options.permanent ? 'always' : 'session';

    if (options.deny) {
      // Deny all — just clear pending
      writeFileSync(pendingFile, '[]');
      console.log(chalk.red(`  Denied ${pending.length} pending review(s).`));
      return;
    }

    if (pattern) {
      // Approve a specific pattern
      const matching = pending.filter((p) => p.matchedPattern === pattern || p.matchedPattern.includes(pattern));
      if (matching.length === 0) {
        console.log(chalk.yellow(`  No pending reviews match pattern: "${pattern}"`));
        console.log(chalk.dim('  Pending patterns:'));
        for (const p of pending) {
          console.log(chalk.dim(`    - "${p.matchedPattern}"`));
        }
        return;
      }

      for (const m of matching) {
        approvals.push({
          pattern: m.matchedPattern,
          scope,
          sessionId: scope === 'session' ? m.claudeSessionId : undefined,
          approvedAt: new Date().toISOString(),
          approvedCommand: m.command,
        });
        console.log(chalk.green(`  Approved (${scope}): "${m.matchedPattern}"`));
      }

      const matchedIds = new Set(matching.map((m) => m.id));
      const remaining = pending.filter((p) => !matchedIds.has(p.id));
      writeFileSync(pendingFile, JSON.stringify(remaining, null, 2));
      writeFileSync(approvalsFile, JSON.stringify(approvals, null, 2));
      return;
    }

    if (options.all) {
      // Approve all pending
      for (const p of pending) {
        approvals.push({
          pattern: p.matchedPattern,
          scope,
          sessionId: scope === 'session' ? p.claudeSessionId : undefined,
          approvedAt: new Date().toISOString(),
          approvedCommand: p.command,
        });
        console.log(chalk.green(`  Approved (${scope}): "${p.matchedPattern}"`));
      }

      writeFileSync(pendingFile, '[]');
      writeFileSync(approvalsFile, JSON.stringify(approvals, null, 2));
      return;
    }

    // Default: list with instructions
    console.log('');
    console.log(chalk.hex('#ff5f1f')('  Pending Review Gate Actions'));
    console.log(chalk.dim('  ' + '-'.repeat(50)));
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const ts = new Date(p.timestamp).toLocaleTimeString();
      console.log(`  ${chalk.bold(String(i + 1))}. ${chalk.yellow(p.command.slice(0, 80))}`);
      console.log(chalk.dim(`     Pattern: "${p.matchedPattern}"  |  ${ts}`));
    }
    console.log('');
    console.log(chalk.dim('  Usage:'));
    console.log(chalk.dim('    hawkeye approve --all              Approve all (session scope)'));
    console.log(chalk.dim('    hawkeye approve --all --permanent  Approve all (permanent)'));
    console.log(chalk.dim('    hawkeye approve "git push"         Approve matching pattern'));
    console.log(chalk.dim('    hawkeye approve --deny             Deny all'));
    console.log('');
  });
