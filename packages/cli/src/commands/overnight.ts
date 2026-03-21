/**
 * Hawkeye Overnight Mode — run agents overnight with strict guardrails,
 * then generate a consolidated morning report on shutdown.
 *
 * Usage:
 *   hawkeye overnight                            # Default budget $5
 *   hawkeye overnight --budget 10                # $10 budget
 *   hawkeye overnight --task "fix all lint errors" --agent aider
 *   hawkeye overnight --tunnel                   # Enable remote access
 *   hawkeye overnight --report-llm               # LLM post-mortem on Ctrl+C
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import chalk from 'chalk';
import { loadConfig, saveConfig, type HawkeyeConfig } from '../config.js';
import { fireWebhooks } from '../webhooks.js';
import { createTask } from './daemon.js';
import { generateMorningReport, renderTerminalReport } from './report.js';

const o = chalk.hex('#ff5f1f');

// ─── Strict guardrails ──────────────────────────────────────

function applyStrictGuardrails(cwd: string, budgetUsd: number): void {
  const config = loadConfig(cwd);

  // Ensure cost_limit rule
  const costRule = config.guardrails.find((r) => r.type === 'cost_limit');
  if (costRule) {
    costRule.enabled = true;
    costRule.action = 'block';
    costRule.config = {
      maxUsdPerSession: budgetUsd,
      maxUsdPerHour: Math.max(budgetUsd / 8, 0.5),
    };
  } else {
    config.guardrails.push({
      name: 'overnight_cost_limit',
      type: 'cost_limit',
      enabled: true,
      action: 'block',
      config: { maxUsdPerSession: budgetUsd, maxUsdPerHour: Math.max(budgetUsd / 8, 0.5) },
    });
  }

  // Ensure file_protect for sensitive files
  const fileProtect = config.guardrails.find((r) => r.type === 'file_protect');
  if (fileProtect) {
    fileProtect.enabled = true;
    // Merge default sensitive patterns
    const existing = (fileProtect.config.paths as string[]) || [];
    const required = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519'];
    for (const p of required) {
      if (!existing.includes(p)) existing.push(p);
    }
    fileProtect.config.paths = existing;
  }

  // Ensure command_block for destructive ops
  const cmdBlock = config.guardrails.find((r) => r.type === 'command_block');
  if (cmdBlock) {
    cmdBlock.enabled = true;
  }

  // Enable auto-pause on critical drift
  config.drift.autoPause = true;

  saveConfig(cwd, config);
}

// ─── Overnight state ────────────────────────────────────────

interface OvernightState {
  startedAt: string;
  budgetUsd: number;
  agent: string;
  port: number;
}

function getOvernightFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'overnight.json');
}

function getConfigBackupFile(cwd: string): string {
  return join(cwd, '.hawkeye', 'overnight-config-backup.json');
}

// ─── Command ────────────────────────────────────────────────

export const overnightCommand = new Command('overnight')
  .description('Run overnight mode — strict guardrails + morning report on shutdown')
  .option('--budget <usd>', 'Maximum cost budget in USD', '5')
  .option('--agent <command>', 'Agent CLI command', 'claude')
  .option('--task <prompt>', 'Submit a task to the daemon queue')
  .option('--tunnel', 'Enable Cloudflare tunnel for remote access')
  .option('--port <number>', 'Dashboard port', '4242')
  .option('--report-llm', 'Run LLM post-mortem per session on shutdown')
  .action(async (options) => {
    const cwd = process.cwd();
    const budgetUsd = parseFloat(options.budget) || 5;
    const agentCmd = options.agent || 'claude';
    const port = parseInt(options.port, 10) || 4242;
    const hawkDir = join(cwd, '.hawkeye');

    if (!existsSync(hawkDir)) mkdirSync(hawkDir, { recursive: true });

    // Check for already-running overnight
    const overnightFile = getOvernightFile(cwd);
    if (existsSync(overnightFile)) {
      try {
        const existing = JSON.parse(readFileSync(overnightFile, 'utf-8'));
        if (existing.startedAt) {
          console.log('');
          console.log(
            `  ${chalk.yellow('⚠')} Overnight mode appears to already be running (started ${existing.startedAt}).`,
          );
          console.log(chalk.dim('  Delete .hawkeye/overnight.json to force restart.'));
          console.log('');
          return;
        }
      } catch {}
    }

    // 1. Backup current config
    const backupFile = getConfigBackupFile(cwd);
    const currentConfig = loadConfig(cwd);
    writeFileSync(backupFile, JSON.stringify(currentConfig, null, 2));

    // 2. Apply strict guardrails
    applyStrictGuardrails(cwd, budgetUsd);

    // 3. Write overnight state
    const startedAt = new Date().toISOString();
    const state: OvernightState = { startedAt, budgetUsd, agent: agentCmd, port };
    writeFileSync(overnightFile, JSON.stringify(state, null, 2));

    // 4. Start serve (detached)
    const serveChild = spawn(process.execPath, [process.argv[1], 'serve', '-p', String(port)], {
      cwd,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env },
    });
    serveChild.unref();

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 1500));

    // 5. Start daemon (detached)
    const daemonEnv = { ...process.env };
    delete daemonEnv.CLAUDECODE;
    const daemonChild = spawn(
      process.execPath,
      [process.argv[1], 'daemon', '--agent', agentCmd, '--interval', '10'],
      {
        cwd,
        stdio: 'ignore',
        detached: true,
        env: daemonEnv,
      },
    );
    daemonChild.unref();

    // 6. Tunnel (optional)
    let tunnelUrl = '';
    if (options.tunnel) {
      let hasCloudflared = false;
      try {
        execSync('which cloudflared', { encoding: 'utf-8', timeout: 3000 });
        hasCloudflared = true;
      } catch {}

      if (hasCloudflared) {
        const tunnelChild = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env: { ...process.env },
        });
        tunnelChild.unref();

        tunnelUrl = await new Promise<string>((resolve) => {
          let output = '';
          const timeout = setTimeout(() => resolve(''), 20000);
          const onData = (chunk: Buffer) => {
            output += chunk.toString();
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match) {
              clearTimeout(timeout);
              resolve(match[0]);
            }
          };
          tunnelChild.stderr?.on('data', onData);
          tunnelChild.stdout?.on('data', onData);
          tunnelChild.on('error', () => {
            clearTimeout(timeout);
            resolve('');
          });
        });

        if (tunnelUrl) {
          const tunnelFile = join(hawkDir, 'tunnel.json');
          writeFileSync(
            tunnelFile,
            JSON.stringify({ url: tunnelUrl, pid: tunnelChild.pid, port, startedAt }, null, 2),
          );
        }
      }
    }

    // 7. Submit initial task (optional)
    if (options.task) {
      createTask(cwd, options.task, agentCmd);
    }

    // 8. Print banner
    const w = Math.min(process.stdout.columns || 80, 120);
    const hr = (ch: string) => ch.repeat(Math.max(w - 4, 20));
    console.log('');
    console.log(`  ${o.bold('Hawkeye Overnight Mode')}`);
    console.log(chalk.dim(`  ${hr('─')}`));
    console.log(`  ${chalk.dim('Budget:')}    ${chalk.cyan('$' + budgetUsd.toFixed(2))}`);
    console.log(`  ${chalk.dim('Agent:')}     ${chalk.cyan(agentCmd)}`);
    console.log(`  ${chalk.dim('Dashboard:')} ${chalk.cyan(`http://localhost:${port}`)}`);
    if (tunnelUrl) {
      console.log(`  ${chalk.dim('Remote:')}    ${chalk.cyan(tunnelUrl)}`);
    }
    if (options.task) {
      console.log(`  ${chalk.dim('Task:')}      ${chalk.white(options.task.slice(0, 60))}`);
    }
    console.log('');
    console.log(chalk.dim('  Strict guardrails active. Auto-pause on critical drift.'));
    console.log(chalk.dim('  Submit tasks via dashboard or POST /api/tasks'));
    console.log('');
    console.log(`  ${chalk.dim('Press')} ${o.bold('Ctrl+C')} ${chalk.dim('to stop and generate morning report.')}`);
    console.log('');

    // 9. Block on SIGINT/SIGTERM → generate report and clean up
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        console.log('');
        console.log(chalk.dim('  Shutting down overnight mode...'));
        console.log('');

        // Generate morning report
        try {
          const report = await generateMorningReport(cwd, startedAt, {
            runPostMortem: options.reportLlm,
          });
          renderTerminalReport(report);

          // Fire webhook
          const cfg = loadConfig(cwd);
          if (cfg.webhooks && cfg.webhooks.length > 0) {
            fireWebhooks(cfg.webhooks, 'overnight_report', {
              totalSessions: report.totalSessions,
              totalCostUsd: report.totalCostUsd,
              totalDurationMinutes: report.totalDurationMinutes,
              tasksCompleted: report.tasksCompleted,
              tasksFailed: report.tasksFailed,
              sessionSummaries: report.sessions.map((s) => ({
                sessionId: s.sessionId,
                objective: s.objective,
                status: s.status,
                costUsd: s.stats.totalCostUsd,
                driftScore: s.driftSummary.finalScore,
                errors: s.stats.errors,
                outcome: s.postMortem?.outcome || null,
              })),
            });
          }
        } catch (err) {
          console.log(`  ${chalk.red('Failed to generate report:')} ${String(err)}`);
        }

        // Restore config from backup
        try {
          if (existsSync(backupFile)) {
            const backup = JSON.parse(readFileSync(backupFile, 'utf-8')) as HawkeyeConfig;
            saveConfig(cwd, backup);
            unlinkSync(backupFile);
            console.log(chalk.dim('  Config restored from backup.'));
          }
        } catch {}

        // Kill daemon
        try {
          execSync('pkill -f "hawkeye daemon" 2>/dev/null || true', { timeout: 3000 });
        } catch {}

        // Kill tunnel
        try {
          const tunnelFile = join(hawkDir, 'tunnel.json');
          if (existsSync(tunnelFile)) {
            const data = JSON.parse(readFileSync(tunnelFile, 'utf-8'));
            if (data.pid) {
              try {
                process.kill(data.pid, 'SIGTERM');
              } catch {}
            }
            writeFileSync(tunnelFile, '{}');
          }
          execSync('pkill -f "cloudflared tunnel" 2>/dev/null || true', { timeout: 3000 });
        } catch {}

        // Clean up overnight state
        try {
          if (existsSync(overnightFile)) unlinkSync(overnightFile);
        } catch {}

        console.log(chalk.dim('  Dashboard left running for review.'));
        console.log('');

        resolve();
      };

      process.on('SIGINT', () => {
        shutdown().then(() => process.exit(0));
      });
      process.on('SIGTERM', () => {
        shutdown().then(() => process.exit(0));
      });
    });
  });
