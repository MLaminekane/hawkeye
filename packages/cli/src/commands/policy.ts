/**
 * hawkeye policy — Declarative security policy management
 *
 * Subcommands:
 *   init     Generate a default policies.yml template
 *   check    Validate the current policies.yml
 *   show     Display current policies
 *   export   Export current config.json guardrails as policies.yml
 *   import   Import a policies.yml from a file or URL
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  generateTemplate,
  loadPolicy,
  savePolicy,
  validatePolicy,
  policyToYaml,
  yamlToPolicy,
  configToPolicy,
  policyExists,
  getPolicyPath,
} from '../policy.js';
import { loadConfig } from '../config.js';

const o = chalk.hex('#ff5f1f');

export const policyCommand = new Command('policy')
  .description('Manage declarative security policies (.hawkeye/policies.yml)')
  .addCommand(
    new Command('init')
      .description('Generate a default policies.yml template')
      .option('--force', 'Overwrite existing policies.yml')
      .action((opts) => {
        const cwd = process.cwd();

        if (policyExists(cwd) && !opts.force) {
          console.log(chalk.yellow('  policies.yml already exists. Use --force to overwrite.'));
          console.log(chalk.dim(`  ${getPolicyPath(cwd)}`));
          return;
        }

        // If config.json has guardrails, offer to convert them
        const config = loadConfig(cwd);
        let policy;
        if (config.guardrails && config.guardrails.length > 0) {
          policy = configToPolicy(config as any);
          policy.name = 'project';
          policy.description = 'Converted from .hawkeye/config.json guardrails';
          console.log(o('  ✓ Converted existing guardrails to policies.yml'));
        } else {
          policy = generateTemplate();
          console.log(o('  ✓ Generated default policies.yml'));
        }

        savePolicy(cwd, policy);
        console.log(chalk.dim(`  ${getPolicyPath(cwd)}`));
        console.log();

        // Show summary
        const enabled = policy.rules.filter((r) => r.enabled);
        const disabled = policy.rules.filter((r) => !r.enabled);
        console.log(`  ${chalk.green(String(enabled.length))} rules enabled, ${chalk.dim(String(disabled.length))} disabled`);
        console.log();
        for (const rule of policy.rules) {
          const status = rule.enabled ? chalk.green('●') : chalk.dim('○');
          const action = rule.action === 'block' ? chalk.red('block') : chalk.yellow('warn');
          console.log(`  ${status} ${rule.name} ${chalk.dim(`(${rule.type}, ${action})`)}`);
          if (rule.description) console.log(`    ${chalk.dim(rule.description)}`);
        }
        console.log();
        console.log(chalk.dim('  Edit the file to customize, then run `hawkeye policy check` to validate.'));
      }),
  )
  .addCommand(
    new Command('check')
      .description('Validate the current policies.yml')
      .action(() => {
        const cwd = process.cwd();
        if (!policyExists(cwd)) {
          console.log(chalk.yellow('  No policies.yml found. Run `hawkeye policy init` first.'));
          return;
        }

        const policy = loadPolicy(cwd);
        if (!policy) {
          console.log(chalk.red('  ✗ Failed to parse policies.yml — check YAML syntax'));
          return;
        }

        const errors = validatePolicy(policy);
        if (errors.length === 0) {
          console.log(o('  ✓ policies.yml is valid'));
          console.log();
          const enabled = policy.rules.filter((r) => r.enabled);
          console.log(`  ${chalk.green(String(enabled.length))} rules enabled out of ${policy.rules.length}`);
          for (const rule of enabled) {
            const action = rule.action === 'block' ? chalk.red('block') : chalk.yellow('warn');
            console.log(`  ${chalk.green('●')} ${rule.name} ${chalk.dim(`→ ${action}`)}`);
          }
        } else {
          console.log(chalk.red(`  ✗ ${errors.length} validation error${errors.length !== 1 ? 's' : ''}:`));
          console.log();
          for (const err of errors) {
            console.log(`  ${chalk.red('✗')} ${chalk.bold(err.rule)}.${err.field}: ${err.message}`);
          }
          console.log();
          console.log(chalk.dim('  Fix the errors above and run `hawkeye policy check` again.'));
        }
      }),
  )
  .addCommand(
    new Command('show')
      .description('Display current policies')
      .action(() => {
        const cwd = process.cwd();
        if (!policyExists(cwd)) {
          console.log(chalk.yellow('  No policies.yml found. Run `hawkeye policy init` first.'));
          return;
        }

        const policy = loadPolicy(cwd);
        if (!policy) {
          console.log(chalk.red('  ✗ Failed to parse policies.yml'));
          return;
        }

        console.log();
        console.log(o(`  ${policy.name}`));
        if (policy.description) console.log(chalk.dim(`  ${policy.description}`));
        console.log();

        for (const rule of policy.rules) {
          const status = rule.enabled ? chalk.green('●') : chalk.dim('○');
          const action = rule.action === 'block' ? chalk.red('BLOCK') : chalk.yellow('WARN');
          console.log(`  ${status} ${chalk.bold(rule.name)} [${rule.type}] → ${action}`);
          if (rule.description) console.log(`    ${chalk.dim(rule.description)}`);

          // Show config details
          const cfg = rule.config;
          if (Array.isArray(cfg.paths)) {
            console.log(`    paths: ${chalk.dim((cfg.paths as string[]).join(', '))}`);
          }
          if (Array.isArray(cfg.patterns)) {
            const patterns = cfg.patterns as string[];
            if (patterns.length <= 4) {
              console.log(`    patterns: ${chalk.dim(patterns.join(', '))}`);
            } else {
              console.log(`    patterns: ${chalk.dim(patterns.slice(0, 3).join(', '))} ${chalk.dim(`+${patterns.length - 3} more`)}`);
            }
          }
          if (Array.isArray(cfg.blockedDirs)) {
            console.log(`    blocked: ${chalk.dim((cfg.blockedDirs as string[]).join(', '))}`);
          }
          if (Array.isArray(cfg.allowedHosts)) {
            console.log(`    allowed hosts: ${chalk.dim((cfg.allowedHosts as string[]).join(', '))}`);
          }
          if (Array.isArray(cfg.blockedHosts)) {
            console.log(`    blocked hosts: ${chalk.dim((cfg.blockedHosts as string[]).join(', '))}`);
          }
          if (cfg.maxUsdPerSession) {
            console.log(`    max: $${cfg.maxUsdPerSession}/session${cfg.maxUsdPerHour ? `, $${cfg.maxUsdPerHour}/hour` : ''}`);
          }
          if (cfg.blockAbove || cfg.warnAbove) {
            console.log(`    block: ${chalk.dim(String(cfg.blockAbove || '-'))}, warn: ${chalk.dim(String(cfg.warnAbove || '-'))}`);
          }
          console.log();
        }
      }),
  )
  .addCommand(
    new Command('export')
      .description('Export current config.json guardrails as YAML')
      .option('-o, --output <file>', 'Output file (default: stdout)')
      .action((opts) => {
        const cwd = process.cwd();
        const config = loadConfig(cwd);
        const policy = configToPolicy(config as any);
        policy.name = 'exported';
        policy.description = `Exported from ${join(cwd, '.hawkeye', 'config.json')}`;

        const yaml = policyToYaml(policy);

        if (opts.output) {
          writeFileSync(resolve(opts.output), yaml);
          console.log(o(`  ✓ Exported to ${opts.output}`));
        } else {
          process.stdout.write(yaml);
        }
      }),
  )
  .addCommand(
    new Command('import')
      .description('Import a policies.yml from a file')
      .argument('<file>', 'Path to policies.yml file')
      .option('--force', 'Overwrite existing policies.yml')
      .action((file, opts) => {
        const cwd = process.cwd();

        if (policyExists(cwd) && !opts.force) {
          console.log(chalk.yellow('  policies.yml already exists. Use --force to overwrite.'));
          return;
        }

        const filePath = resolve(file);
        if (!existsSync(filePath)) {
          console.log(chalk.red(`  ✗ File not found: ${filePath}`));
          return;
        }

        try {
          const raw = readFileSync(filePath, 'utf-8');
          const policy = yamlToPolicy(raw);
          const errors = validatePolicy(policy);

          if (errors.length > 0) {
            console.log(chalk.red(`  ✗ ${errors.length} validation error${errors.length !== 1 ? 's' : ''}:`));
            for (const err of errors) {
              console.log(`    ${chalk.red('✗')} ${err.rule}.${err.field}: ${err.message}`);
            }
            return;
          }

          savePolicy(cwd, policy);
          const enabled = policy.rules.filter((r) => r.enabled);
          console.log(o(`  ✓ Imported "${policy.name}" — ${enabled.length} rules enabled`));
          console.log(chalk.dim(`  ${getPolicyPath(cwd)}`));
        } catch (e) {
          console.log(chalk.red(`  ✗ Failed to parse: ${String(e)}`));
        }
      }),
  );
