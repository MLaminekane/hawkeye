/**
 * hawkeye memory cumulative          — cumulative memory across all sessions
 * hawkeye memory diff <s1> <s2>      — diff memories between two sessions
 * hawkeye memory hallucinations      — detect recurring hallucinations
 * hawkeye memory <session>           — extract memories from a session
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  extractMemories,
  diffMemories,
  detectHallucinations,
  buildCumulativeMemory,
  type MemoryItem,
  type MemoryDiffResult,
  type HallucinationItem,
} from '@mklamine/hawkeye-core';
import { type SessionRow, type Storage } from '@mklamine/hawkeye-core';
import { formatAmbiguousSessionMessage, openTraceStorage, resolveSession, traceDbExists } from './storage-helpers.js';

const o = chalk.hex('#ff5f1f');
const compareCommands = (left: Command, right: Command) => left.name().localeCompare(right.name());

function getStorage(): Storage {
  if (!traceDbExists()) {
    console.error(chalk.red('No database found. Run `hawkeye init` first.'));
    process.exit(1);
  }

  return openTraceStorage();
}

function loadOrExtract(storage: Storage, session: SessionRow): MemoryItem[] {
  // Check if memories already cached
  const cached = storage.getMemoryItems(session.id);
  if (cached.ok && cached.value && cached.value.length > 0) {
    return cached.value.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      sequence: r.sequence,
      timestamp: r.timestamp,
      category: r.category as MemoryItem['category'],
      key: r.key,
      content: r.content,
      evidence: r.evidence,
      confidence: r.confidence as MemoryItem['confidence'],
      supersedes: r.supersedes ?? undefined,
      contradicts: r.contradicts ?? undefined,
    }));
  }

  // Extract from events
  const eventsResult = storage.getEvents(session.id);
  const events = eventsResult.ok && eventsResult.value ? eventsResult.value : [];
  const memEvents = events.map((e) => ({
    id: e.id,
    sequence: e.sequence,
    timestamp: e.timestamp,
    type: e.type,
    data: e.data,
    drift_score: e.drift_score,
    cost_usd: e.cost_usd,
  }));

  const memSession = {
    id: session.id,
    objective: session.objective,
    agent: session.agent,
    status: session.status,
    started_at: session.started_at,
    ended_at: session.ended_at,
  };

  const memories = extractMemories(memSession, memEvents);

  // Cache in DB
  storage.upsertMemoryItems(
    session.id,
    memories.map((m) => ({
      id: m.id,
      session_id: m.sessionId,
      sequence: m.sequence,
      timestamp: m.timestamp,
      category: m.category,
      key: m.key,
      content: m.content,
      evidence: m.evidence,
      confidence: m.confidence,
      supersedes: m.supersedes ?? null,
      contradicts: m.contradicts ?? null,
    })),
  );

  return memories;
}

export const memoryCommand = new Command('memory')
  .description('Memory diff — compare what an agent remembers across sessions')
  .argument('[session]', 'Session ID or prefix (extracts memories)')
  .option('--json', 'Output as JSON')
  .action(async (sessionArg: string | undefined, opts: { json?: boolean }) => {
    const storage = getStorage();

    if (!sessionArg) {
      // Default: show cumulative memory
      printCumulative(storage, opts.json);
      storage.close();
      return;
    }

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
    const session = sessionMatch.session;

    const memories = loadOrExtract(storage, session);

    if (opts.json) {
      console.log(JSON.stringify(memories, null, 2));
    } else {
      printMemories(memories, session.id);
    }

    storage.close();
  });

memoryCommand.addCommand(
  new Command('diff')
    .argument('<sessionA>', 'First session ID or prefix')
    .argument('<sessionB>', 'Second session ID or prefix')
    .option('--json', 'Output as JSON')
    .description('Compare memories between two sessions')
    .action(async (argA: string, argB: string, opts: { json?: boolean }) => {
      const storage = getStorage();

      const sessionMatchA = resolveSession(storage, argA);
      const sessionMatchB = resolveSession(storage, argB);
      if (sessionMatchA.kind === 'ambiguous') {
        console.error(chalk.yellow(formatAmbiguousSessionMessage(sessionMatchA.matches)));
        storage.close();
        process.exit(1);
      }
      if (sessionMatchB.kind === 'ambiguous') {
        console.error(chalk.yellow(formatAmbiguousSessionMessage(sessionMatchB.matches)));
        storage.close();
        process.exit(1);
      }
      const sA = sessionMatchA.session;
      const sB = sessionMatchB.session;
      if (!sA) { console.error(chalk.red(`Session A not found: ${argA}`)); storage.close(); process.exit(1); }
      if (!sB) { console.error(chalk.red(`Session B not found: ${argB}`)); storage.close(); process.exit(1); }

      const memA = loadOrExtract(storage, sA);
      const memB = loadOrExtract(storage, sB);

      const memSessionA = { id: sA.id, objective: sA.objective, agent: sA.agent, status: sA.status, started_at: sA.started_at, ended_at: sA.ended_at };
      const memSessionB = { id: sB.id, objective: sB.objective, agent: sB.agent, status: sB.status, started_at: sB.started_at, ended_at: sB.ended_at };

      const result = diffMemories(memA, memB, memSessionA, memSessionB);

      // Add hallucination detection across these two sessions
      const memBySession = new Map<string, MemoryItem[]>();
      memBySession.set(sA.id, memA);
      memBySession.set(sB.id, memB);
      result.hallucinations = detectHallucinations(memBySession);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printDiffReport(result);
      }

      storage.close();
    }),
);

memoryCommand.addCommand(
  new Command('cumulative')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max sessions to include', '20')
    .description('Show cumulative memory across all sessions')
    .action(async (opts: { json?: boolean; limit?: string }) => {
      const storage = getStorage();
      printCumulative(storage, opts.json, parseInt(opts.limit || '20', 10));
      storage.close();
    }),
);

memoryCommand.addCommand(
  new Command('hallucinations')
    .option('--json', 'Output as JSON')
    .description('Detect recurring hallucinations across sessions')
    .action(async (opts: { json?: boolean }) => {
      const storage = getStorage();
      const sessions = storage.listSessions();
      if (!sessions.ok || !sessions.value) { console.error(chalk.red('No sessions')); storage.close(); return; }

      const memBySession = new Map<string, MemoryItem[]>();
      for (const s of sessions.value.slice(0, 30)) {
        const mems = loadOrExtract(storage, s);
        memBySession.set(s.id, mems);
      }

      const hallu = detectHallucinations(memBySession);

      if (opts.json) {
        console.log(JSON.stringify(hallu, null, 2));
      } else {
        printHallucinations(hallu);
      }

      storage.close();
    }),
);

(memoryCommand.commands as Command[]).sort(compareCommands);

// ─── Pretty printers ───

function printMemories(memories: MemoryItem[], sessionId: string): void {
  const w = Math.min(process.stdout.columns || 80, 100);
  const hr = o('─'.repeat(w));

  console.log();
  console.log(hr);
  console.log(o('  Agent Memory') + chalk.gray(` — session ${sessionId.slice(0, 8)}`));
  console.log(hr);
  console.log(chalk.gray(`  ${memories.length} memories extracted`));
  console.log();

  const byCategory = new Map<string, MemoryItem[]>();
  for (const m of memories) {
    const list = byCategory.get(m.category) || [];
    list.push(m);
    byCategory.set(m.category, list);
  }

  for (const [cat, items] of byCategory) {
    console.log(o(`  ${getCategoryLabel(cat)}`) + chalk.gray(` (${items.length})`));
    for (const item of items.slice(0, 10)) {
      const conf = item.confidence === 'high' ? chalk.green('●') : item.confidence === 'medium' ? chalk.yellow('◐') : chalk.red('○');
      console.log(`    ${conf} ${chalk.white(item.content)}`);
    }
    if (items.length > 10) console.log(chalk.gray(`    ... and ${items.length - 10} more`));
    console.log();
  }

  console.log(hr);
  console.log();
}

function printDiffReport(diff: MemoryDiffResult): void {
  const w = Math.min(process.stdout.columns || 80, 100);
  const hr = o('─'.repeat(w));

  console.log();
  console.log(hr);
  console.log(o('  Memory Diff'));
  console.log(chalk.gray(`  A: ${diff.sessionA.id.slice(0, 8)} — ${diff.sessionA.objective.slice(0, 50)}`));
  console.log(chalk.gray(`  B: ${diff.sessionB.id.slice(0, 8)} — ${diff.sessionB.objective.slice(0, 50)}`));
  console.log(hr);
  console.log();
  console.log(chalk.white(`  ${diff.summary}`));
  console.log();

  if (diff.learned.length > 0) {
    console.log(chalk.green(`  LEARNED (${diff.learned.length})`));
    for (const item of diff.learned.slice(0, 10)) {
      console.log(chalk.green(`    + `) + chalk.white(item.after?.content || ''));
    }
    console.log();
  }

  if (diff.forgotten.length > 0) {
    console.log(chalk.red(`  FORGOTTEN (${diff.forgotten.length})`));
    for (const item of diff.forgotten.slice(0, 10)) {
      console.log(chalk.red(`    - `) + chalk.white(item.before?.content || ''));
    }
    console.log();
  }

  if (diff.retained.length > 0) {
    console.log(chalk.gray(`  RETAINED (${diff.retained.length})`));
    for (const item of diff.retained.slice(0, 5)) {
      console.log(chalk.gray(`    = `) + chalk.white(item.before?.content || ''));
    }
    if (diff.retained.length > 5) console.log(chalk.gray(`    ... and ${diff.retained.length - 5} more`));
    console.log();
  }

  if (diff.evolved.length > 0) {
    console.log(chalk.hex('#f0a830')(`  EVOLVED (${diff.evolved.length})`));
    for (const item of diff.evolved.slice(0, 10)) {
      console.log(chalk.gray(`    Before: `) + chalk.white(item.before?.content || ''));
      console.log(chalk.hex('#f0a830')(`    After:  `) + chalk.white(item.after?.content || ''));
    }
    console.log();
  }

  if (diff.contradicted.length > 0) {
    console.log(chalk.red.bold(`  CONTRADICTED (${diff.contradicted.length})`));
    for (const item of diff.contradicted.slice(0, 10)) {
      console.log(chalk.red(`    ✗ `) + chalk.white(item.explanation));
    }
    console.log();
  }

  if (diff.hallucinations.length > 0) {
    console.log(chalk.magenta(`  HALLUCINATIONS (${diff.hallucinations.length})`));
    for (const h of diff.hallucinations.slice(0, 5)) {
      console.log(chalk.magenta(`    ⚠ [${h.type}] `) + chalk.white(h.claim));
      console.log(chalk.gray(`      ${h.evidence}`));
    }
    console.log();
  }

  console.log(hr);
  console.log();
}

function printCumulative(storage: Storage, json?: boolean, limit = 20): void {
  const sessions = storage.listSessions();
  if (!sessions.ok || !sessions.value || sessions.value.length === 0) {
    console.log(chalk.yellow('  No sessions found.'));
    return;
  }

  const sessionMemories: Array<{ session: { id: string; objective: string; agent: string | null; status: string; started_at: string; ended_at: string | null }; memories: MemoryItem[] }> = [];
  for (const s of sessions.value.slice(0, limit)) {
    const mems = loadOrExtract(storage, s);
    sessionMemories.push({
      session: { id: s.id, objective: s.objective, agent: s.agent, status: s.status, started_at: s.started_at, ended_at: s.ended_at },
      memories: mems,
    });
  }

  const cumulative = buildCumulativeMemory(sessionMemories);

  if (json) {
    console.log(JSON.stringify(cumulative, null, 2));
    return;
  }

  const w = Math.min(process.stdout.columns || 80, 100);
  const hr = o('─'.repeat(w));

  console.log();
  console.log(hr);
  console.log(o('  Cumulative Agent Memory'));
  console.log(hr);
  console.log(chalk.gray(`  ${cumulative.totalSessions} sessions, ${cumulative.stats.totalItems} unique memories`));
  console.log(chalk.gray(`  ${cumulative.stats.corrections} corrections, ${cumulative.stats.contradictions} contradictions`));
  console.log();

  // Stats by category
  for (const [cat, count] of Object.entries(cumulative.stats.byCategory)) {
    console.log(`  ${o(getCategoryLabel(cat))} ${chalk.white(String(count))}`);
  }
  console.log();

  // Top memories (most recent per category)
  const byCat = new Map<string, MemoryItem[]>();
  for (const item of cumulative.items) {
    const list = byCat.get(item.category) || [];
    list.push(item);
    byCat.set(item.category, list);
  }
  for (const [cat, items] of byCat) {
    console.log(o(`  ${getCategoryLabel(cat)}`));
    for (const item of items.slice(0, 5)) {
      const conf = item.confidence === 'high' ? chalk.green('●') : item.confidence === 'medium' ? chalk.yellow('◐') : chalk.red('○');
      console.log(`    ${conf} ${chalk.white(item.content)}`);
    }
    if (items.length > 5) console.log(chalk.gray(`    ... and ${items.length - 5} more`));
    console.log();
  }

  // Hallucinations
  if (cumulative.hallucinations.length > 0) {
    printHallucinations(cumulative.hallucinations);
  }

  console.log(hr);
  console.log();
}

function printHallucinations(hallu: HallucinationItem[]): void {
  if (hallu.length === 0) {
    console.log(chalk.green('  No hallucinations detected.'));
    return;
  }

  console.log(chalk.magenta(`  HALLUCINATIONS (${hallu.length})`));
  for (const h of hallu) {
    const typeLabel = h.type === 'recurring_error'
      ? chalk.red('recurring error')
      : h.type === 'contradicted_fact'
        ? chalk.yellow('contradicted fact')
        : h.type === 'nonexistent_file'
          ? chalk.red('phantom file')
          : chalk.gray(h.type);
    console.log(`    ${chalk.magenta('⚠')} ${typeLabel} — ${chalk.white(h.claim.slice(0, 80))}`);
    console.log(chalk.gray(`      ${h.evidence}`));
    console.log(chalk.gray(`      Across ${h.occurrences.length} sessions`));
  }
  console.log();
}

function getCategoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    file_knowledge: 'Files',
    error_lesson: 'Error Lessons',
    correction: 'Corrections',
    tool_pattern: 'Tool Patterns',
    decision: 'Decisions',
    dependency_fact: 'Dependencies',
    api_knowledge: 'API Knowledge',
  };
  return labels[cat] || cat;
}
