/**
 * hawkeye analyze <session-id> [--json] [--llm]
 * Root Cause Analysis for agent sessions.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  analyzeRootCause,
  buildRcaPrompt,
  parseRcaResponse,
  createLlmProvider,
  type RcaResult,
  type CausalStep,
} from '@mklamine/hawkeye-core';
import { loadConfig } from '../config.js';
import { formatAmbiguousSessionMessage, openTraceStorage, resolveSession, traceDbExists } from './storage-helpers.js';

const o = chalk.hex('#ff5f1f');

export const analyzeCommand = new Command('analyze')
  .argument('<session>', 'Session ID or prefix (min 4 chars)')
  .option('--json', 'Output as JSON')
  .option('--llm', 'Enhance analysis with LLM')
  .description('Root cause analysis — find why a session failed')
  .action(async (sessionArg: string, opts: { json?: boolean; llm?: boolean }) => {
    const cwd = process.cwd();
    if (!traceDbExists(cwd)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      process.exit(1);
    }

    const storage = openTraceStorage(cwd);

    const sessionMatch = resolveSession(storage, sessionArg);
    if (sessionMatch.kind === 'ambiguous') {
      console.error(chalk.yellow(formatAmbiguousSessionMessage(sessionMatch.matches)));
      storage.close();
      process.exit(1);
    }
    if (!sessionMatch.session) {
      console.error(chalk.red(`Session not found: ${sessionArg}`));
      storage.close();
      process.exit(1);
    }
    const match = sessionMatch.session;

    // Load events & drift
    const eventsResult = storage.getEvents(match.id);
    const events = eventsResult.ok && eventsResult.value ? eventsResult.value : [];

    const driftResult = storage.getDriftSnapshots(match.id);
    const driftSnapshots = driftResult.ok && driftResult.value ? driftResult.value : [];

    // Run heuristic analysis
    const rcaEvents = events.map((e) => ({
      id: e.id,
      sequence: e.sequence,
      timestamp: e.timestamp,
      type: e.type,
      data: e.data,
      drift_score: e.drift_score,
      drift_flag: e.drift_flag,
      cost_usd: e.cost_usd,
    }));

    const rcaSession = {
      id: match.id,
      objective: match.objective,
      agent: match.agent,
      status: match.status,
      started_at: match.started_at,
      ended_at: match.ended_at,
      total_cost_usd: match.total_cost_usd,
      final_drift_score: match.final_drift_score,
    };

    const result = analyzeRootCause(rcaSession, rcaEvents, driftSnapshots);

    // LLM enhancement
    let llmEnhanced: { summary: string; rootCause: string; suggestions: string[] } | null = null;
    if (opts.llm) {
      try {
        const config = loadConfig(cwd);
        const driftConfig = config.drift || {};
        const provider = driftConfig.provider || 'ollama';
        const model = driftConfig.model || 'llama3.2';
        const apiKey = (config.apiKeys as Record<string, string> | undefined)?.[provider] || '';
        const llm = createLlmProvider(provider, model, apiKey);

        process.stderr.write(chalk.gray(`  Analyzing with ${provider}/${model}...\n`));
        const prompt = buildRcaPrompt(rcaSession, rcaEvents, result);
        const response = await llm.complete(prompt, { maxTokens: 2000 });
        llmEnhanced = parseRcaResponse(response);
      } catch (err) {
        process.stderr.write(chalk.yellow(`  LLM analysis failed: ${err}\n`));
      }
    }

    // Output
    if (opts.json) {
      const output = llmEnhanced
        ? { ...result, llm: llmEnhanced }
        : result;
      console.log(JSON.stringify(output, null, 2));
    } else {
      printRcaReport(result, llmEnhanced, match.id);
    }

    storage.close();
  });

// ─── Pretty printer ───

function printRcaReport(
  result: RcaResult,
  llm: { summary: string; rootCause: string; suggestions: string[] } | null,
  sessionId: string,
) {
  const w = Math.min(process.stdout.columns || 80, 100);
  const hr = o('─'.repeat(w));

  console.log();
  console.log(hr);
  console.log(o('  Root Cause Analysis') + chalk.gray(` — session ${sessionId.slice(0, 8)}`));
  console.log(hr);

  // Outcome badge
  const outcomeBadge = result.outcome === 'success'
    ? chalk.bgGreen.black(' SUCCESS ')
    : result.outcome === 'failure'
      ? chalk.bgRed.white(' FAILURE ')
      : result.outcome === 'partial'
        ? chalk.bgYellow.black(' PARTIAL ')
        : chalk.bgGray.white(' UNKNOWN ');
  const confBadge = result.confidence === 'high'
    ? chalk.green(`confidence: ${result.confidence}`)
    : result.confidence === 'medium'
      ? chalk.yellow(`confidence: ${result.confidence}`)
      : chalk.red(`confidence: ${result.confidence}`);

  console.log();
  console.log(`  ${outcomeBadge}  ${confBadge}`);

  // Summary
  console.log();
  console.log(o('  SUMMARY'));
  console.log(chalk.white(`  ${llm?.summary || result.summary}`));

  // Primary Error
  if (result.primaryError) {
    console.log();
    console.log(o('  PRIMARY ERROR') + chalk.gray(` (event #${result.primaryError.sequence})`));
    console.log(chalk.red(`  ${result.primaryError.description}`));
    console.log(chalk.gray(`  at ${new Date(result.primaryError.timestamp).toLocaleTimeString()} — ${result.primaryError.type}`));
  }

  // LLM Root Cause
  if (llm?.rootCause && llm.rootCause !== 'N/A') {
    console.log();
    console.log(o('  ROOT CAUSE') + chalk.gray(' (LLM analysis)'));
    console.log(chalk.white(`  ${llm.rootCause}`));
  }

  // Causal Chain
  if (result.causalChain.length > 0) {
    console.log();
    console.log(o('  CAUSAL CHAIN'));
    for (const step of result.causalChain) {
      const icon = getRelevanceIcon(step);
      const seqStr = chalk.gray(`#${String(step.sequence).padStart(3)}`);
      const typeStr = getTypeColor(step.type)(step.type.toUpperCase().padEnd(6));
      const desc = chalk.white(step.description.slice(0, w - 25));
      console.log(`  ${seqStr} ${typeStr} ${icon} ${desc}`);
      if (step.explanation) {
        console.log(chalk.gray(`              ↳ ${step.explanation}`));
      }
    }
  }

  // Error Patterns
  if (result.errorPatterns.length > 0) {
    console.log();
    console.log(o('  ERROR PATTERNS'));
    for (const pat of result.errorPatterns.slice(0, 5)) {
      const count = chalk.red(`${pat.count}x`);
      console.log(`  ${count} ${chalk.white(pat.pattern)}`);
      console.log(chalk.gray(`     at events: ${pat.sequences.join(', ')}`));
    }
  }

  // Drift Analysis
  if (result.driftAnalysis) {
    console.log();
    console.log(o('  DRIFT ANALYSIS'));
    const da = result.driftAnalysis;
    const trendColor = da.trend === 'declining' ? chalk.red : da.trend === 'volatile' ? chalk.yellow : chalk.green;
    console.log(`  Trend: ${trendColor(da.trend)} — Score range: ${da.lowestScore} → ${da.highestScore}`);
    if (da.inflectionPoint) {
      console.log(chalk.yellow(`  Inflection at event #${da.inflectionPoint.sequence}: ${da.inflectionPoint.scoreBefore} → ${da.inflectionPoint.scoreAfter}`));
      console.log(chalk.gray(`  Trigger: ${da.inflectionPoint.triggerDescription}`));
    }
  }

  // Suggestions
  const allSuggestions = llm?.suggestions || result.suggestions;
  if (allSuggestions.length > 0) {
    console.log();
    console.log(o('  SUGGESTIONS'));
    allSuggestions.forEach((s, i) => {
      console.log(chalk.white(`  ${i + 1}. ${s}`));
    });
  }

  console.log();
  console.log(hr);
  console.log();
}

function getRelevanceIcon(step: CausalStep): string {
  switch (step.relevance) {
    case 'root_cause': return chalk.red('●');
    case 'contributing': return chalk.yellow('◐');
    case 'effect': return chalk.gray('○');
    case 'context': return chalk.blue('◇');
    default: return ' ';
  }
}

function getTypeColor(type: string): (s: string) => string {
  if (type === 'command') return chalk.blue;
  if (type.startsWith('file_')) return chalk.green;
  if (type === 'llm_call') return chalk.magenta;
  if (type.includes('guardrail')) return chalk.red;
  if (type.startsWith('git_')) return chalk.yellow;
  if (type === 'error') return chalk.red;
  return chalk.gray;
}
