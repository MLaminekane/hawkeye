import { Command } from 'commander';
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { Storage } from '@mklamine/hawkeye-core';
import { getDefaultConfig } from '../config.js';

export const initCommand = new Command('init')
  .description('Initialize Hawkeye in the current project')
  .action(() => {
    const cwd = process.cwd();
    const hawkDir = join(cwd, '.hawkeye');
    const cfgPath = join(hawkDir, 'config.json');

    if (existsSync(hawkDir)) {
      console.log(chalk.yellow('⚠ .hawkeye/ already exists. Skipping.'));
      return;
    }

    // Create directory, config, and database
    mkdirSync(hawkDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(getDefaultConfig(), null, 2), 'utf-8');

    const dbPath = join(hawkDir, 'traces.db');
    const storage = new Storage(dbPath);
    storage.close();
    console.log(chalk.dim('  Database: traces.db'));

    // Add to .gitignore
    const gitignorePath = join(cwd, '.gitignore');
    const entry = '\n# Hawkeye\n.hawkeye/\n';

    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.hawkeye')) {
        appendFileSync(gitignorePath, entry);
        console.log(chalk.dim('  Added .hawkeye/ to .gitignore'));
      }
    } else {
      writeFileSync(gitignorePath, entry.trimStart(), 'utf-8');
      console.log(chalk.dim('  Created .gitignore'));
    }

    console.log(chalk.green('✓ Hawkeye initialized'));
    console.log(chalk.dim(`  Config: ${cfgPath}`));
    console.log('');
    console.log(
      `  Next: ${chalk.cyan('hawkeye record -o "your objective" -- <agent-command>')}`,
    );
  });
