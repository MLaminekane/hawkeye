/**
 * hawkeye autocorrect — Autonomous Control Layer CLI
 *
 * Usage:
 *   hawkeye autocorrect enable [--dry-run]
 *   hawkeye autocorrect disable
 *   hawkeye autocorrect status
 *   hawkeye autocorrect history [session-id]
 *   hawkeye autocorrect clear
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { Storage } from '@mklamine/hawkeye-core';
import { loadConfig, saveConfig } from '../config.js';

const o = chalk.hex('#ff5f1f');

export const autocorrectCommand = new Command('autocorrect')
  .description('Autonomous Control Layer — auto-correct agent behavior')
  .argument('[action]', 'enable, disable, status, history, clear')
  .argument('[sessionId]', 'Session ID for history command')
  .option('--dry-run', 'Enable in dry-run mode (log but don\'t execute)', false)
  .option('--json', 'JSON output', false)
  .action(async (action: string | undefined, sessionId: string | undefined, options: { dryRun?: boolean; json?: boolean }) => {
    const cwd = process.cwd();
    const config = loadConfig(cwd);

    if (!action || action === 'status') {
      const ac = config.autocorrect;
      if (options.json) {
        console.log(JSON.stringify(ac || { enabled: false }));
        return;
      }
      console.log(o('\n  ⚡ Hawkeye Autocorrect'));
      console.log(chalk.gray('  ─────────────────────'));
      if (!ac || !ac.enabled) {
        console.log(chalk.gray('  Status: ') + chalk.red('disabled'));
        console.log(chalk.gray('\n  Enable with: ') + chalk.white('hawkeye autocorrect enable'));
      } else {
        console.log(chalk.gray('  Status: ') + chalk.green('enabled') + (ac.dryRun ? chalk.yellow(' (dry run)') : ''));
        console.log(chalk.gray('  Triggers:'));
        console.log(`    Drift critical: ${ac.triggers.driftCritical ? chalk.green('✓') : chalk.red('✗')}`);
        console.log(`    Error repeat:   ${ac.triggers.errorRepeat > 0 ? chalk.green(`≥ ${ac.triggers.errorRepeat}`) : chalk.red('off')}`);
        console.log(`    Cost threshold: ${ac.triggers.costThreshold > 0 ? chalk.green(`${ac.triggers.costThreshold}%`) : chalk.red('off')}`);
        console.log(chalk.gray('  Actions:'));
        console.log(`    Rollback files: ${ac.actions.rollbackFiles ? chalk.green('✓') : chalk.red('✗')}`);
        console.log(`    Pause session:  ${ac.actions.pauseSession ? chalk.green('✓') : chalk.red('✗')}`);
        console.log(`    Inject hint:    ${ac.actions.injectHint ? chalk.green('✓') : chalk.red('✗')}`);
        console.log(`    Block pattern:  ${ac.actions.blockPattern ? chalk.green('✓') : chalk.red('✗')}`);
      }

      // Show active correction if any
      const hintPath = join(cwd, '.hawkeye', 'active-correction.json');
      if (existsSync(hintPath)) {
        try {
          const hint = JSON.parse(readFileSync(hintPath, 'utf-8'));
          console.log(chalk.yellow('\n  ⚠ Active correction:'));
          console.log(`    Trigger:  ${hint.trigger}`);
          console.log(`    Urgency:  ${hint.urgency}`);
          console.log(`    Diagnosis: ${hint.diagnosis}`);
          if (hint.corrections?.length) {
            for (const c of hint.corrections) {
              const icon = c.executed ? chalk.green('✓') : chalk.gray('○');
              console.log(`    ${icon} ${c.type}: ${c.description}`);
            }
          }
        } catch {}
      }
      console.log();
      return;
    }

    if (action === 'enable') {
      config.autocorrect = {
        enabled: true,
        dryRun: options.dryRun || false,
        triggers: config.autocorrect?.triggers || { driftCritical: true, errorRepeat: 3, costThreshold: 85 },
        actions: config.autocorrect?.actions || { rollbackFiles: true, pauseSession: true, injectHint: true, blockPattern: true },
      };
      saveConfig(cwd, config);
      console.log(o('⚡ Autocorrect enabled') + (options.dryRun ? chalk.yellow(' (dry run)') : ''));
      console.log(chalk.gray('Hawkeye will now autonomously correct agent drift, errors, and cost overruns.'));
      return;
    }

    if (action === 'disable') {
      if (config.autocorrect) {
        config.autocorrect.enabled = false;
      }
      saveConfig(cwd, config);
      // Clear active correction
      try {
        const hintPath = join(cwd, '.hawkeye', 'active-correction.json');
        if (existsSync(hintPath)) unlinkSync(hintPath);
      } catch {}
      console.log(chalk.gray('Autocorrect disabled.'));
      return;
    }

    if (action === 'clear') {
      try {
        const hintPath = join(cwd, '.hawkeye', 'active-correction.json');
        if (existsSync(hintPath)) unlinkSync(hintPath);
        console.log(chalk.gray('Active correction cleared.'));
      } catch {
        console.log(chalk.gray('No active correction.'));
      }
      return;
    }

    if (action === 'history') {
      const dbPath = join(cwd, '.hawkeye', 'traces.db');
      if (!existsSync(dbPath)) {
        console.log(chalk.gray('No database found.'));
        return;
      }
      const storage = new Storage(dbPath);
      try {
        const result = sessionId
          ? storage.getCorrections(sessionId)
          : storage.getAllCorrections(20);
        const rows = result.ok ? result.value : [];

        if (options.json) {
          console.log(JSON.stringify(rows.map((r) => ({
            id: r.id,
            sessionId: r.session_id,
            timestamp: r.timestamp,
            trigger: r.trigger,
            assessment: JSON.parse(r.assessment),
            corrections: JSON.parse(r.corrections),
            dryRun: r.dry_run === 1,
          }))));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.gray('No corrections recorded.'));
          return;
        }

        console.log(o(`\n  ⚡ Correction History (${rows.length} records)\n`));
        for (const r of rows) {
          const corrections = (() => { try { return JSON.parse(r.corrections); } catch { return []; } })() as Array<{ type: string; description: string; executed: boolean; result: string }>;
          const assessment = (() => { try { return JSON.parse(r.assessment); } catch { return {}; } })() as { driftScore?: number; driftFlag?: string };
          const ts = new Date(r.timestamp).toLocaleString();
          const dryTag = r.dry_run ? chalk.yellow(' [dry run]') : '';

          console.log(`  ${chalk.white(ts)} ${o(r.trigger)}${dryTag} ${chalk.gray(`session:${r.session_id.slice(0, 8)}`)}`);
          if (assessment.driftScore !== undefined) {
            console.log(`    Drift: ${assessment.driftScore}/100 (${assessment.driftFlag})`);
          }
          for (const c of corrections) {
            const icon = c.result === 'success' ? chalk.green('✓') : c.result === 'failed' ? chalk.red('✗') : chalk.gray('○');
            console.log(`    ${icon} ${c.type}: ${c.description}`);
          }
          console.log();
        }
      } finally {
        storage.close();
      }
      return;
    }

    console.log(chalk.gray('Usage: hawkeye autocorrect [enable|disable|status|history|clear]'));
  });
