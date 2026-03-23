/**
 * Hawkeye Multi-agent Orchestration (Swarm) — CLI orchestrator.
 *
 * Coordinates multiple AI agents working on subtasks in parallel,
 * each in an isolated git worktree with enforced scope boundaries.
 *
 * Usage:
 *   hawkeye swarm --config swarm.json
 *   hawkeye swarm --list
 *   hawkeye swarm --show <id>
 *   hawkeye swarm init                    # Generate template config
 *   hawkeye swarm run --config swarm.json # Execute swarm
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { fireWebhooks } from '../webhooks.js';
import { buildAgentInvocation } from './agent-command.js';
import { ensureHawkeyeDir, getTraceDbPath } from './storage-helpers.js';
import {
  validateSwarmConfig,
  resolveDependencies,
  isInScope,
  generateSwarmTemplate,
} from '@mklamine/hawkeye-core';
import type {
  SwarmConfig,
  SwarmAgent,
  SwarmResult,
  AgentPersona,
  SwarmRow,
  SwarmAgentRow,
} from '@mklamine/hawkeye-core';
import { detectConflicts, suggestMergeOrder } from '@mklamine/hawkeye-core';
import { Storage } from '@mklamine/hawkeye-core';

const o = chalk.hex('#ff5f1f');

// ─── Known agents (shared with arena) ────────────────────────

// ─── Git worktree helpers ────────────────────────────────────

function createWorktree(cwd: string, path: string, branch: string): boolean {
  try {
    execSync(`git worktree add "${path}" -b "${branch}"`, { cwd, stdio: 'pipe', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

function removeWorktree(cwd: string, path: string, branch: string): void {
  try { execSync(`git worktree remove "${path}" --force`, { cwd, stdio: 'pipe', timeout: 10000 }); } catch {}
  try { execSync(`git branch -D "${branch}"`, { cwd, stdio: 'pipe', timeout: 5000 }); } catch {}
}

function getInitialHash(worktreePath: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function getDiffStats(worktreePath: string, initialHash: string): {
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  summary: string;
} {
  try {
    const numstat = execSync(`git diff --numstat ${initialHash}`, {
      cwd: worktreePath, encoding: 'utf-8', timeout: 10000,
    }).trim();

    const summary = execSync(`git diff --stat ${initialHash}`, {
      cwd: worktreePath, encoding: 'utf-8', timeout: 10000,
    }).trim();

    const filesChanged: string[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;

    if (numstat) {
      for (const line of numstat.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          linesAdded += parseInt(parts[0]) || 0;
          linesRemoved += parseInt(parts[1]) || 0;
          filesChanged.push(parts[2]);
        }
      }
    }

    return { filesChanged, linesAdded, linesRemoved, summary };
  } catch {
    return { filesChanged: [], linesAdded: 0, linesRemoved: 0, summary: '' };
  }
}

function runTests(worktreePath: string, testCmd: string): { passed: boolean; output: string } {
  try {
    const output = execSync(testCmd, { cwd: worktreePath, encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
    return { passed: true, output: output.slice(0, 5000) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { passed: false, output: (e.stdout || e.stderr || String(err)).slice(0, 5000) };
  }
}

// ─── Agent execution ─────────────────────────────────────────

function runAgent(
  persona: AgentPersona,
  task: string,
  worktreePath: string,
  timeoutMs: number,
  context?: string,
): Promise<{ exitCode: number; output: string; pid: number }> {
  return new Promise((resolve) => {
    // Build full prompt with scope + context
    const scopeNote = persona.scope.include.length > 0
      ? `\n\nIMPORTANT: You are ONLY allowed to modify files matching: ${persona.scope.include.join(', ')}` +
        (persona.scope.exclude?.length ? `\nDo NOT modify: ${persona.scope.exclude.join(', ')}` : '')
      : '';
    const contextNote = context ? `\n\nContext: ${context}` : '';
    const fullPrompt = task + scopeNote + contextNote;
    const { cmd, args } = buildAgentInvocation(persona.command, fullPrompt, {
      extraArgs: persona.args || [],
    });

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn(cmd, args, {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    const pid = proc.pid || 0;

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        output: (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).slice(0, 50000),
        pid,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: `Failed to start ${persona.command}: ${err.message}`, pid: 0 });
    });
  });
}

// ─── Merge helpers ───────────────────────────────────────────

function mergeAgent(cwd: string, branch: string, agentName: string): { success: boolean; output: string } {
  try {
    const output = execSync(`git merge "${branch}" --no-ff -m "swarm: merge ${agentName}"`, {
      cwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
    });
    return { success: true, output: output.slice(0, 5000) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    // Abort the failed merge
    try { execSync('git merge --abort', { cwd, stdio: 'pipe', timeout: 5000 }); } catch {}
    return { success: false, output: (e.stdout || e.stderr || String(err)).slice(0, 5000) };
  }
}

function getConflictFiles(cwd: string): string[] {
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd, encoding: 'utf-8', timeout: 5000,
    }).trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

// ─── Terminal display ────────────────────────────────────────

function tw(): number { return Math.min(process.stdout.columns || 80, 120); }
function hr(ch: string): string { return ch.repeat(Math.max(tw() - 4, 20)); }

function pad(str: string, width: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, width - stripped.length));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function agentIcon(status: string, exitCode?: number): string {
  switch (status) {
    case 'running': return chalk.cyan('●');
    case 'completed': return exitCode === 0 ? chalk.green('✓') : chalk.red('✗');
    case 'merged': return chalk.green('⚡');
    case 'failed': return chalk.red('✗');
    case 'blocked': return chalk.yellow('⏸');
    case 'waiting': return chalk.dim('○');
    default: return chalk.dim('○');
  }
}

function printBanner(config: SwarmConfig): number {
  console.log('');
  console.log(chalk.dim(`  ${hr('═')}`));
  console.log(`  ${o.bold('🐝 HAWKEYE SWARM')}`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log(`  ${chalk.dim('Name:')}      ${chalk.white(config.name)}`);
  console.log(`  ${chalk.dim('Objective:')} ${chalk.white(config.objective.length > 70 ? config.objective.slice(0, 67) + '...' : config.objective)}`);
  console.log(`  ${chalk.dim('Agents:')}    ${config.agents.map((a) => {
    const color = a.color ? chalk.hex(a.color) : o;
    return color.bold(a.name) + chalk.dim(` (${a.role})`);
  }).join(chalk.dim(', '))}`);
  console.log(`  ${chalk.dim('Strategy:')}  ${config.mergeStrategy} merge${config.testCommand ? chalk.dim(` + test: ${config.testCommand}`) : ''}`);
  console.log(chalk.dim(`  ${hr('─')}`));
  console.log('');

  let lines = 0;
  for (const agent of config.agents) {
    const color = agent.color ? chalk.hex(agent.color) : o;
    console.log(`  ${chalk.dim('○')} ${pad(color.bold(agent.name), 20)} ${chalk.dim(`${agent.role} — waiting...`)}`);
    lines++;
  }
  console.log('');
  lines++;
  console.log(chalk.dim(`  Phase: preparing  |  Elapsed: 0s  |  Cost: $0.00`));
  lines++;

  return lines;
}

function updateProgress(agents: SwarmAgent[], lineCount: number, phase: string, totalCost: number): void {
  process.stdout.write(`\x1b[${lineCount}A`);

  for (const a of agents) {
    const icon = agentIcon(a.status, a.exitCode);
    const color = a.persona.color ? chalk.hex(a.persona.color) : o;

    let detail = '';
    if (a.status === 'running' && a.startedAt) {
      const sec = Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000);
      detail = chalk.cyan(formatDuration(sec));
      if (a.costUsd) detail += chalk.dim(` $${a.costUsd.toFixed(2)}`);
    } else if (a.status === 'completed' || a.status === 'merged') {
      detail = a.exitCode === 0
        ? chalk.green(formatDuration(a.durationSeconds || 0))
        : chalk.red(`failed (exit ${a.exitCode})`);
      if (a.filesChanged?.length) {
        detail += chalk.dim(` ${a.filesChanged.length} files +${a.linesAdded || 0}/-${a.linesRemoved || 0}`);
      }
      if (a.costUsd) detail += chalk.dim(` $${a.costUsd.toFixed(2)}`);
      if (a.mergeStatus === 'merged') detail += chalk.green(' merged');
      if (a.mergeStatus === 'conflict') detail += chalk.red(' conflict');
    } else if (a.status === 'failed') {
      detail = chalk.red(`failed (exit ${a.exitCode ?? '?'})`);
    } else if (a.status === 'blocked') {
      detail = chalk.yellow('waiting for dependencies...');
    } else {
      detail = chalk.dim('waiting...');
    }

    process.stdout.write(`\x1b[2K  ${icon} ${pad(color.bold(a.name), 20)} ${detail}\n`);
  }

  const elapsed = agents
    .filter((a) => a.startedAt)
    .reduce((max, a) => {
      const t = Date.now() - new Date(a.startedAt!).getTime();
      return t > max ? t : max;
    }, 0);

  process.stdout.write(`\x1b[2K\n`);
  process.stdout.write(`\x1b[2K  ${chalk.dim('Phase:')} ${o(phase)}  ${chalk.dim('|  Elapsed:')} ${formatDuration(Math.round(elapsed / 1000))}  ${chalk.dim('|  Cost:')} ${chalk.cyan('$' + totalCost.toFixed(2))}\n`);
}

function printResults(result: SwarmResult): void {
  console.log('');
  console.log(chalk.dim(`  ${hr('═')}`));
  console.log(`  ${o.bold('🐝 SWARM RESULTS')}  ${chalk.dim(result.id)}`);
  console.log(chalk.dim(`  ${hr('─')}`));

  // Agent summary table
  console.log(`  ${pad(chalk.dim('Agent'), 18)}${pad(chalk.dim('Status'), 12)}${pad(chalk.dim('Time'), 10)}${pad(chalk.dim('Files'), 8)}${pad(chalk.dim('Cost'), 10)}${pad(chalk.dim('Merge'), 10)}`);
  console.log(chalk.dim(`  ${hr('─')}`));

  for (const a of result.agents) {
    const color = a.persona.color ? chalk.hex(a.persona.color) : o;
    const statusStr = a.status === 'completed' || a.status === 'merged'
      ? chalk.green(a.status)
      : a.status === 'failed' ? chalk.red('failed') : chalk.dim(a.status);
    const timeStr = a.durationSeconds ? formatDuration(a.durationSeconds) : '-';
    const filesStr = a.filesChanged?.length ? String(a.filesChanged.length) : '0';
    const costStr = a.costUsd ? `$${a.costUsd.toFixed(2)}` : '$0.00';
    const mergeStr = a.mergeStatus === 'merged' ? chalk.green('✓ merged')
      : a.mergeStatus === 'conflict' ? chalk.red('✗ conflict')
      : a.mergeStatus === 'skipped' ? chalk.dim('skipped') : chalk.dim('pending');

    console.log(`  ${pad(color.bold(a.name), 18)}${pad(statusStr, 12)}${pad(timeStr, 10)}${pad(filesStr, 8)}${pad(costStr, 10)}${pad(mergeStr, 10)}`);
  }

  // Conflicts
  if (result.conflicts.length > 0) {
    console.log('');
    console.log(`  ${chalk.red.bold('Conflicts detected:')}`);
    for (const c of result.conflicts) {
      const status = c.resolved ? chalk.green('resolved') : chalk.red('unresolved');
      console.log(`    ${chalk.red('•')} ${chalk.white(c.path)} ${chalk.dim('(')}${c.agents.join(chalk.dim(', '))}${chalk.dim(')')} ${status}`);
    }
  }

  // Summary
  console.log('');
  console.log(`  ${chalk.dim('Total cost:')}  ${chalk.cyan('$' + result.totalCostUsd.toFixed(2))}`);
  console.log(`  ${chalk.dim('Tokens:')}      ${chalk.cyan(result.totalTokens.toLocaleString())}`);
  if (result.testsPassed !== undefined) {
    console.log(`  ${chalk.dim('Tests:')}       ${result.testsPassed ? chalk.green('passed') : chalk.red('failed')}`);
  }
  if (result.mergeCommit) {
    console.log(`  ${chalk.dim('Merge:')}       ${chalk.cyan(result.mergeCommit.slice(0, 8))}`);
  }

  const statusColor = result.status === 'completed' ? chalk.green : chalk.red;
  console.log(`  ${chalk.dim('Status:')}      ${statusColor.bold(result.status)}`);
  console.log(chalk.dim(`  ${hr('═')}`));
  console.log('');
}

// ─── Storage helpers ─────────────────────────────────────────

function getStorage(cwd: string): Storage {
  ensureHawkeyeDir(cwd);
  return new Storage(getTraceDbPath(cwd));
}

function swarmAgentToRow(swarmId: string, agent: SwarmAgent): SwarmAgentRow {
  return {
    id: randomUUID(),
    swarm_id: swarmId,
    agent_name: agent.name,
    persona: JSON.stringify(agent.persona),
    task_prompt: agent.task.prompt,
    task_id: agent.task.id,
    status: agent.status,
    session_id: agent.sessionId || null,
    worktree_path: agent.worktreePath || null,
    branch: agent.branch || null,
    pid: agent.pid || null,
    started_at: agent.startedAt || null,
    finished_at: agent.finishedAt || null,
    duration_seconds: agent.durationSeconds || null,
    exit_code: agent.exitCode ?? null,
    output: agent.output?.slice(0, 10000) || null,
    files_changed: agent.filesChanged ? JSON.stringify(agent.filesChanged) : null,
    lines_added: agent.linesAdded ?? null,
    lines_removed: agent.linesRemoved ?? null,
    cost_usd: agent.costUsd ?? null,
    tokens_used: agent.tokensUsed ?? null,
    final_drift_score: agent.finalDriftScore ?? null,
    error_count: agent.errorCount ?? null,
    merge_status: agent.mergeStatus || null,
    merge_conflicts: agent.mergeConflicts ? JSON.stringify(agent.mergeConflicts) : null,
  };
}

function swarmResultToRow(result: SwarmResult): SwarmRow {
  return {
    id: result.id,
    name: result.config.name,
    objective: result.config.objective,
    config: JSON.stringify(result.config),
    status: result.status,
    created_at: result.createdAt,
    started_at: result.startedAt || null,
    completed_at: result.completedAt || null,
    total_cost_usd: result.totalCostUsd,
    total_tokens: result.totalTokens,
    tests_passed: result.testsPassed !== undefined ? (result.testsPassed ? 1 : 0) : null,
    test_output: result.testOutput || null,
    merge_commit: result.mergeCommit || null,
    summary: result.summary || null,
  };
}

function persistSwarm(cwd: string, result: SwarmResult): void {
  const storage = getStorage(cwd);
  try {
    // Upsert swarm
    const existing = storage.getSwarm(result.id);
    if (existing.ok && existing.value) {
      storage.updateSwarm(result.id, swarmResultToRow(result));
    } else {
      storage.createSwarm(swarmResultToRow(result));
    }

    // Upsert agents
    const existingAgents = storage.getSwarmAgents(result.id);
    if (existingAgents.ok && existingAgents.value.length > 0) {
      for (const agent of result.agents) {
        const existingRow = existingAgents.value.find((r) => r.agent_name === agent.name);
        if (existingRow) {
          storage.updateSwarmAgent(existingRow.id, swarmAgentToRow(result.id, agent));
        } else {
          storage.insertSwarmAgent(swarmAgentToRow(result.id, agent));
        }
      }
    } else {
      for (const agent of result.agents) {
        storage.insertSwarmAgent(swarmAgentToRow(result.id, agent));
      }
    }

    // Persist conflicts
    for (const conflict of result.conflicts) {
      storage.insertSwarmConflict({
        id: randomUUID(),
        swarm_id: result.id,
        path: conflict.path,
        agents: JSON.stringify(conflict.agents),
        type: conflict.type,
        resolved: conflict.resolved ? 1 : 0,
        resolved_by: conflict.resolvedBy || null,
        resolution: conflict.resolution || null,
      });
    }
  } finally {
    storage.close();
  }
}

// ─── WebSocket broadcast helper ──────────────────────────────

let wsBroadcast: ((msg: Record<string, unknown>) => void) | null = null;

export function setSwarmBroadcast(fn: (msg: Record<string, unknown>) => void): void {
  wsBroadcast = fn;
}

function broadcast(type: string, data: Record<string, unknown>): void {
  if (wsBroadcast) {
    wsBroadcast({ type: 'swarm', event: type, ...data });
  }
}

// ─── Main orchestrator ──────────────────────────────────────

export async function runSwarm(config: SwarmConfig, cwd: string): Promise<SwarmResult> {
  const swarmId = randomUUID().slice(0, 12);
  const swarmDir = join(cwd, '.hawkeye', `swarm-${swarmId}`);
  mkdirSync(swarmDir, { recursive: true });

  const result: SwarmResult = {
    id: swarmId,
    config,
    status: 'pending',
    agents: [],
    conflicts: [],
    createdAt: new Date().toISOString(),
    totalCostUsd: 0,
    totalTokens: 0,
  };

  // Build task map
  const taskMap = new Map(config.tasks.map((t) => [t.id, t]));
  const personaMap = new Map(config.agents.map((a) => [a.name, a]));

  // Resolve execution order
  let executionOrder: string[];
  try {
    executionOrder = resolveDependencies(config.tasks);
  } catch (e: unknown) {
    console.log(`  ${chalk.red('✗')} ${(e as Error).message}`);
    result.status = 'failed';
    return result;
  }

  // Initialize agents from tasks
  for (const taskId of executionOrder) {
    const task = taskMap.get(taskId)!;
    const persona = personaMap.get(task.agent);
    if (!persona) {
      console.log(`  ${chalk.red('✗')} Task "${taskId}" references unknown agent "${task.agent}"`);
      result.status = 'failed';
      return result;
    }

    result.agents.push({
      name: persona.name,
      persona,
      task,
      status: task.dependsOn?.length ? 'blocked' : 'waiting',
    });
  }

  // Validate agent commands exist
  const checkedCommands = new Set<string>();
  for (const persona of config.agents) {
    const cmdName = persona.command.split(/\s+/)[0];
    if (checkedCommands.has(cmdName)) continue;
    checkedCommands.add(cmdName);
    try {
      execSync(`command -v ${cmdName}`, { stdio: 'pipe', timeout: 3000, shell: '/bin/sh' });
    } catch {
      console.log(`  ${chalk.red('✗')} Agent command ${chalk.bold(cmdName)} not found in PATH`);
      result.status = 'failed';
      return result;
    }
  }

  // Create worktrees
  console.log(chalk.dim('  Setting up worktrees...'));
  for (const agent of result.agents) {
    const branch = `swarm-${swarmId}-${agent.name}`;
    const worktreePath = join(swarmDir, agent.name);

    if (!createWorktree(cwd, worktreePath, branch)) {
      console.log(`  ${chalk.red('✗')} Failed to create worktree for ${agent.name}`);
      // Clean up already created worktrees
      for (const a of result.agents) {
        if (a.worktreePath) removeWorktree(cwd, a.worktreePath, a.branch!);
      }
      try { rmSync(swarmDir, { recursive: true }); } catch {}
      result.status = 'failed';
      return result;
    }

    agent.worktreePath = worktreePath;
    agent.branch = branch;
  }

  // Persist initial state
  result.status = 'running';
  result.startedAt = new Date().toISOString();
  persistSwarm(cwd, result);
  broadcast('swarm_created', { swarmId, config: config.name, agents: result.agents.map((a) => a.name) });

  // Print banner
  const lineCount = printBanner(config);

  // Track initial hashes
  const initialHashes = new Map<string, string>();
  for (const agent of result.agents) {
    initialHashes.set(agent.name, getInitialHash(agent.worktreePath!));
  }

  // ─── Execute agents respecting dependency order ────────

  const completedTasks = new Set<string>();
  const agentByTask = new Map(result.agents.map((a) => [a.task.id, a]));
  const runningAgents = new Set<string>();

  // Progress update interval
  const progressInterval = setInterval(() => {
    updateProgress(result.agents, lineCount, result.status, result.totalCostUsd);
  }, 1000);

  // Process agents in waves
  while (completedTasks.size < result.agents.length) {
    // Find agents that are ready (all deps satisfied)
    const ready: SwarmAgent[] = [];
    for (const agent of result.agents) {
      if (agent.status !== 'waiting' && agent.status !== 'blocked') continue;
      const deps = agent.task.dependsOn || [];
      const allDepsMet = deps.every((d) => completedTasks.has(d));
      if (allDepsMet && !runningAgents.has(agent.name)) {
        ready.push(agent);
        agent.status = 'waiting'; // unblock
      }
    }

    if (ready.length === 0 && runningAgents.size === 0) {
      // Deadlock — shouldn't happen after topo sort, but safety net
      console.log(`  ${chalk.red('✗')} Deadlock detected — no agents can proceed`);
      result.status = 'failed';
      break;
    }

    // Start all ready agents in parallel
    const promises: Promise<void>[] = [];
    for (const agent of ready) {
      runningAgents.add(agent.name);
      agent.status = 'running';
      agent.startedAt = new Date().toISOString();

      broadcast('agent_started', { swarmId, agent: agent.name, task: agent.task.id });

      const timeoutMs = (agent.persona.timeout || config.timeout || 3600) * 1000;

      // Build context from completed dependency outputs
      let depContext = '';
      if (agent.task.dependsOn?.length) {
        const depOutputs = agent.task.dependsOn
          .map((d) => agentByTask.get(d))
          .filter((a) => a && a.status === 'completed')
          .map((a) => `[${a!.name}] changed: ${(a!.filesChanged || []).join(', ')}`)
          .join('\n');
        if (depOutputs) {
          depContext = `Previous agents completed:\n${depOutputs}`;
        }
      }

      const promise = (async () => {
        const result = await runAgent(
          agent.persona,
          agent.task.prompt,
          agent.worktreePath!,
          timeoutMs,
          (agent.task.context || '') + (depContext ? '\n' + depContext : ''),
        );

        agent.finishedAt = new Date().toISOString();
        agent.exitCode = result.exitCode;
        agent.output = result.output.slice(0, 10000);
        agent.pid = result.pid;
        agent.status = result.exitCode === 0 ? 'completed' : 'failed';
        agent.durationSeconds = Math.round(
          (new Date(agent.finishedAt).getTime() - new Date(agent.startedAt!).getTime()) / 1000,
        );

        // Get diff stats
        const hash = initialHashes.get(agent.name) || '';
        if (hash) {
          const diff = getDiffStats(agent.worktreePath!, hash);
          agent.filesChanged = diff.filesChanged;
          agent.linesAdded = diff.linesAdded;
          agent.linesRemoved = diff.linesRemoved;
          agent.diffSummary = diff.summary;
        }

        // Check scope violations
        if (agent.filesChanged) {
          const violations = agent.filesChanged.filter((f) => !isInScope(f, agent.persona.scope));
          if (violations.length > 0) {
            agent.errorCount = (agent.errorCount || 0) + violations.length;
            broadcast('agent_progress', {
              swarmId,
              agent: agent.name,
              warning: `Scope violations: ${violations.join(', ')}`,
            });
          }
        }

        runningAgents.delete(agent.name);
        completedTasks.add(agent.task.id);

        broadcast(agent.status === 'completed' ? 'agent_completed' : 'agent_failed', {
          swarmId,
          agent: agent.name,
          exitCode: agent.exitCode,
          filesChanged: agent.filesChanged?.length || 0,
          duration: agent.durationSeconds,
        });
      })();

      promises.push(promise);
    }

    // Wait for this wave of agents
    if (promises.length > 0) {
      await Promise.all(promises);
    } else {
      // Wait a bit for running agents to finish
      await new Promise<void>((resolve) => {
        const check = () => {
          if (runningAgents.size === 0) { resolve(); return; }
          setTimeout(check, 500);
        };
        check();
      });
    }

    // Update total cost
    result.totalCostUsd = result.agents.reduce((sum, a) => sum + (a.costUsd || 0), 0);
    persistSwarm(cwd, result);
  }

  clearInterval(progressInterval);
  updateProgress(result.agents, lineCount, 'analyzing', result.totalCostUsd);

  // ─── Conflict detection ────────────────────────────────

  const completedAgents = result.agents.filter((a) => a.status === 'completed');
  result.conflicts = detectConflicts(completedAgents);

  if (result.conflicts.length > 0) {
    broadcast('conflict_detected', {
      swarmId,
      conflicts: result.conflicts.map((c) => ({ path: c.path, agents: c.agents })),
    });
  }

  // ─── Merge phase ───────────────────────────────────────

  if (completedAgents.length > 0 && (config.autoMerge || result.conflicts.length === 0)) {
    result.status = 'merging';
    broadcast('merge_started', { swarmId, strategy: config.mergeStrategy });
    updateProgress(result.agents, lineCount, 'merging', result.totalCostUsd);

    // Determine merge order
    const mergeOrder = config.mergeStrategy === 'sequential'
      ? suggestMergeOrder(completedAgents, result.conflicts)
      : completedAgents.map((a) => a.name);

    for (const agentName of mergeOrder) {
      const agent = result.agents.find((a) => a.name === agentName);
      if (!agent || !agent.branch) continue;

      const mergeResult = mergeAgent(cwd, agent.branch, agentName);
      if (mergeResult.success) {
        agent.mergeStatus = 'merged';
        broadcast('merge_completed', { swarmId, agent: agentName, success: true });
      } else {
        agent.mergeStatus = 'conflict';
        agent.mergeConflicts = result.conflicts
          .filter((c) => c.agents.includes(agentName))
          .map((c) => ({ ...c }));
        broadcast('merge_completed', { swarmId, agent: agentName, success: false });
      }
    }

    // Get merge commit
    try {
      result.mergeCommit = execSync('git rev-parse HEAD', {
        cwd, encoding: 'utf-8', timeout: 5000,
      }).trim();
    } catch {}
  }

  // ─── Test phase ────────────────────────────────────────

  if (config.testCommand && result.agents.some((a) => a.mergeStatus === 'merged')) {
    result.status = 'testing';
    broadcast('test_started', { swarmId });
    updateProgress(result.agents, lineCount, 'testing', result.totalCostUsd);

    const testResult = runTests(cwd, config.testCommand);
    result.testsPassed = testResult.passed;
    result.testOutput = testResult.output;

    broadcast('test_completed', { swarmId, passed: testResult.passed });
  }

  // ─── Finalize ──────────────────────────────────────────

  const allMerged = completedAgents.every((a) => a.mergeStatus === 'merged');
  const testOk = result.testsPassed !== false;
  result.status = allMerged && testOk ? 'completed' : 'failed';
  result.completedAt = new Date().toISOString();
  result.totalCostUsd = result.agents.reduce((sum, a) => sum + (a.costUsd || 0), 0);
  result.totalTokens = result.agents.reduce((sum, a) => sum + (a.tokensUsed || 0), 0);

  // Build summary
  result.summary = result.agents
    .map((a) => `${a.name} (${a.status}): ${a.filesChanged?.length || 0} files, ${a.durationSeconds || 0}s`)
    .join('; ');

  persistSwarm(cwd, result);
  broadcast(result.status === 'completed' ? 'swarm_completed' : 'swarm_failed', { swarmId });

  // Final display
  updateProgress(result.agents, lineCount, result.status, result.totalCostUsd);
  printResults(result);

  // Clean up worktrees
  console.log(chalk.dim('  Cleaning up worktrees...'));
  for (const a of result.agents) {
    if (a.worktreePath && a.branch) removeWorktree(cwd, a.worktreePath, a.branch);
  }
  try { rmSync(swarmDir, { recursive: true }); } catch {}

  // Fire webhook
  try {
    const hawkeyeConfig = loadConfig(cwd);
    if (hawkeyeConfig.webhooks?.length) {
      fireWebhooks(hawkeyeConfig.webhooks, 'swarm_complete', {
        swarm_id: result.id,
        name: config.name,
        status: result.status,
        agents: result.agents.map((a) => ({
          name: a.name, status: a.status, filesChanged: a.filesChanged?.length,
          duration: a.durationSeconds, cost: a.costUsd,
        })),
        conflicts: result.conflicts.length,
        totalCost: result.totalCostUsd,
      });
    }
  } catch {}

  console.log(chalk.dim(`  Swarm ${o(result.id)} ${result.status}. Run ${o(`hawkeye swarm --show ${result.id}`)} to review.`));
  console.log('');

  return result;
}

// ─── List swarms ─────────────────────────────────────────────

function listSwarms(cwd: string): void {
  const storage = getStorage(cwd);
  try {
    const result = storage.listSwarms({ limit: 20 });
    if (!result.ok || result.value.length === 0) {
      console.log(chalk.dim('  No swarms yet. Run: hawkeye swarm --config swarm.json'));
      console.log('');
      return;
    }

    console.log('');
    console.log(`  ${o.bold('🐝 Past Swarms')}`);
    console.log(chalk.dim(`  ${hr('─')}`));

    for (const swarm of result.value) {
      const statusColor = swarm.status === 'completed' ? chalk.green
        : swarm.status === 'running' ? chalk.cyan
        : swarm.status === 'failed' ? chalk.red : chalk.dim;
      const date = new Date(swarm.created_at).toLocaleDateString();
      const cost = swarm.total_cost_usd > 0 ? chalk.dim(` $${swarm.total_cost_usd.toFixed(2)}`) : '';

      console.log(`  ${o.bold(swarm.id.slice(0, 8))}  ${statusColor(swarm.status.padEnd(10))}  ${chalk.white(swarm.name)}${cost}`);
      console.log(`    ${chalk.dim(date)}  ${chalk.dim(swarm.objective.slice(0, 60))}${swarm.objective.length > 60 ? '...' : ''}`);
      console.log('');
    }
  } finally {
    storage.close();
  }
}

// ─── Show swarm detail ───────────────────────────────────────

function showSwarm(cwd: string, swarmId: string): void {
  const storage = getStorage(cwd);
  try {
    const result = storage.getSwarm(swarmId);
    if (!result.ok || !result.value) {
      console.log(`  ${chalk.red('✗')} Swarm "${swarmId}" not found`);
      return;
    }

    const swarm = result.value;
    const agentsResult = storage.getSwarmAgents(swarm.id);
    const agents = agentsResult.ok ? agentsResult.value : [];
    const conflictsResult = storage.getSwarmConflicts(swarm.id);
    const conflicts = conflictsResult.ok ? conflictsResult.value : [];

    console.log('');
    console.log(chalk.dim(`  ${hr('═')}`));
    console.log(`  ${o.bold('🐝 SWARM')}  ${chalk.dim(swarm.id)}`);
    console.log(chalk.dim(`  ${hr('─')}`));
    console.log(`  ${chalk.dim('Name:')}       ${chalk.white(swarm.name)}`);
    console.log(`  ${chalk.dim('Objective:')}  ${chalk.white(swarm.objective)}`);
    console.log(`  ${chalk.dim('Status:')}     ${swarm.status === 'completed' ? chalk.green(swarm.status) : swarm.status === 'failed' ? chalk.red(swarm.status) : chalk.cyan(swarm.status)}`);
    console.log(`  ${chalk.dim('Created:')}    ${new Date(swarm.created_at).toLocaleString()}`);
    if (swarm.completed_at) {
      console.log(`  ${chalk.dim('Completed:')}  ${new Date(swarm.completed_at).toLocaleString()}`);
    }
    console.log(`  ${chalk.dim('Cost:')}       ${chalk.cyan('$' + (swarm.total_cost_usd || 0).toFixed(2))}`);
    console.log('');

    // Agents
    console.log(`  ${chalk.dim('Agents:')}`);
    for (const agent of agents) {
      const statusColor = agent.status === 'completed' || agent.status === 'merged' ? chalk.green
        : agent.status === 'failed' ? chalk.red : chalk.dim;
      const time = agent.duration_seconds ? formatDuration(agent.duration_seconds) : '-';
      const files = agent.files_changed ? JSON.parse(agent.files_changed).length : 0;
      const merge = agent.merge_status === 'merged' ? chalk.green('merged')
        : agent.merge_status === 'conflict' ? chalk.red('conflict') : chalk.dim(agent.merge_status || '-');

      console.log(`    ${statusColor('●')} ${o.bold(agent.agent_name)}  ${statusColor(agent.status)}  ${chalk.dim(time)}  ${chalk.dim(`${files} files`)}  ${merge}`);
    }

    // Conflicts
    if (conflicts.length > 0) {
      console.log('');
      console.log(`  ${chalk.dim('Conflicts:')}`);
      for (const c of conflicts) {
        const agents = JSON.parse(c.agents).join(', ');
        console.log(`    ${c.resolved ? chalk.green('✓') : chalk.red('✗')} ${chalk.white(c.path)} ${chalk.dim(`(${agents})`)}`);
      }
    }

    console.log(chalk.dim(`  ${hr('═')}`));
    console.log('');
  } finally {
    storage.close();
  }
}

// ─── Command ─────────────────────────────────────────────────

export const swarmCommand = new Command('swarm')
  .description('Multi-agent Orchestration — coordinate multiple AI agents on parallel tasks')
  .option('-c, --config <path>', 'Path to swarm config file (JSON)')
  .option('--list', 'List past swarm runs')
  .option('--show <id>', 'Show details of a specific swarm run')
  .option('--init', 'Generate a template swarm config file')
  .option('--json', 'Output results as JSON')
  .action(async (options) => {
    const cwd = process.cwd();

    if (options.list) {
      listSwarms(cwd);
      return;
    }

    if (options.show) {
      if (options.json) {
        const storage = getStorage(cwd);
        try {
          const swarm = storage.getSwarm(options.show);
          const agents = storage.getSwarmAgents(swarm.ok && swarm.value ? swarm.value.id : options.show);
          const conflicts = storage.getSwarmConflicts(swarm.ok && swarm.value ? swarm.value.id : options.show);
          console.log(JSON.stringify({ swarm: swarm.ok ? swarm.value : null, agents: agents.ok ? agents.value : [], conflicts: conflicts.ok ? conflicts.value : [] }, null, 2));
        } finally {
          storage.close();
        }
      } else {
        showSwarm(cwd, options.show);
      }
      return;
    }

    if (options.init) {
      const outPath = join(cwd, '.hawkeye', 'swarm.json');
      const dir = join(cwd, '.hawkeye');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outPath, generateSwarmTemplate());
      console.log(`  ${chalk.green('✓')} Template written to ${o('.hawkeye/swarm.json')}`);
      console.log(chalk.dim(`  Edit the file and run: hawkeye swarm --config .hawkeye/swarm.json`));
      return;
    }

    if (!options.config) {
      // Try default location
      const defaultPath = join(cwd, '.hawkeye', 'swarm.json');
      if (existsSync(defaultPath)) {
        options.config = defaultPath;
      } else {
        console.log(`  ${chalk.red('✗')} Missing --config. Usage: hawkeye swarm --config swarm.json`);
        console.log(chalk.dim(`  Or run: hawkeye swarm --init  to generate a template`));
        return;
      }
    }

    // Read and validate config
    let configPath = options.config.startsWith('/') ? options.config : join(cwd, options.config);
    // Also try .hawkeye/ prefix if not found
    if (!existsSync(configPath)) {
      const altPath = join(cwd, '.hawkeye', options.config);
      if (existsSync(altPath)) {
        configPath = altPath;
      } else {
        console.log(`  ${chalk.red('✗')} Config file not found: ${configPath}`);
        console.log(chalk.dim(`  Run: hawkeye swarm --init  to generate a template at .hawkeye/swarm.json`));
        return;
      }
    }

    let config: SwarmConfig;
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      config = validateSwarmConfig(raw);
    } catch (e: unknown) {
      console.log(`  ${chalk.red('✗')} Invalid swarm config: ${(e as Error).message}`);
      return;
    }

    // Check git repo
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
    } catch {
      console.log(`  ${chalk.red('✗')} Not a git repository. Swarm requires git for isolated worktrees.`);
      return;
    }

    // Warn about uncommitted changes
    try {
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
      if (status) {
        console.log(`  ${chalk.yellow('⚠')} Uncommitted changes detected. Agents will start from the last commit.`);
        console.log(chalk.dim('    Commit your changes first for consistent results.'));
        console.log('');
      }
    } catch {}

    const result = await runSwarm(config, cwd);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  });
