/**
 * Memory Diff engine.
 * Extracts structured "memories" from agent session events,
 * diffs across sessions, detects recurring hallucinations,
 * and builds a cumulative knowledge base.
 */

// ─── Types ───

export type MemoryCategory =
  | 'file_knowledge'
  | 'error_lesson'
  | 'correction'
  | 'tool_pattern'
  | 'decision'
  | 'dependency_fact'
  | 'api_knowledge';

export interface MemoryItem {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  category: MemoryCategory;
  key: string;
  content: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  supersedes?: string;
  contradicts?: string;
}

export interface MemoryEvent {
  id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: string;
  drift_score: number | null;
  cost_usd: number;
}

export interface MemorySession {
  id: string;
  objective: string;
  agent: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
}

export interface MemoryDiffItem {
  status: 'learned' | 'forgotten' | 'retained' | 'evolved' | 'contradicted';
  category: MemoryCategory;
  key: string;
  before?: MemoryItem;
  after?: MemoryItem;
  explanation: string;
}

export interface HallucinationItem {
  key: string;
  category: MemoryCategory;
  claim: string;
  evidence: string;
  type: 'nonexistent_file' | 'contradicted_fact' | 'recurring_error' | 'phantom_api';
  occurrences: Array<{ sessionId: string; sequence: number; timestamp: string }>;
}

export interface MemoryDiffResult {
  sessionA: { id: string; objective: string; startedAt: string };
  sessionB: { id: string; objective: string; startedAt: string };
  learned: MemoryDiffItem[];
  forgotten: MemoryDiffItem[];
  retained: MemoryDiffItem[];
  evolved: MemoryDiffItem[];
  contradicted: MemoryDiffItem[];
  hallucinations: HallucinationItem[];
  summary: string;
}

export interface CumulativeMemory {
  items: MemoryItem[];
  totalSessions: number;
  firstSeen: string;
  lastUpdated: string;
  hallucinations: HallucinationItem[];
  stats: {
    byCategory: Record<string, number>;
    totalItems: number;
    contradictions: number;
    corrections: number;
  };
}

// ─── Memory Extraction ───

export function extractMemories(
  session: MemorySession,
  events: MemoryEvent[],
): MemoryItem[] {
  const memories: MemoryItem[] = [];
  let memId = 0;
  const makeId = () => `mem_${session.id.slice(0, 8)}_${++memId}`;

  // Phase 1: File knowledge
  const fileEvents = events.filter((e) =>
    ['file_write', 'file_read', 'file_delete', 'file_rename', 'file_create'].includes(e.type),
  );
  const fileMap = new Map<string, { reads: number; writes: number; lastSeq: number; lastTs: string; lastAction: string }>();
  for (const e of fileEvents) {
    const data = safeParse(e.data);
    const path = data?.path as string | undefined;
    if (!path) continue;
    const existing = fileMap.get(path) || { reads: 0, writes: 0, lastSeq: 0, lastTs: '', lastAction: '' };
    if (e.type === 'file_read') existing.reads++;
    else existing.writes++;
    existing.lastSeq = e.sequence;
    existing.lastTs = e.timestamp;
    existing.lastAction = e.type;
    fileMap.set(path, existing);
  }
  for (const [path, info] of fileMap) {
    const actions: string[] = [];
    if (info.reads > 0) actions.push(`read ${info.reads}x`);
    if (info.writes > 0) actions.push(`modified ${info.writes}x`);
    memories.push({
      id: makeId(),
      sessionId: session.id,
      sequence: info.lastSeq,
      timestamp: info.lastTs,
      category: 'file_knowledge',
      key: `file:${normalizePath(path)}`,
      content: `Agent worked with ${path} (${actions.join(', ')})`,
      evidence: `Last action: ${info.lastAction} at sequence ${info.lastSeq}`,
      confidence: info.writes > 0 ? 'high' : 'medium',
    });
  }

  // Phase 2: Error lessons
  const errorEvents = events.filter(
    (e) => e.type === 'error' || (e.type === 'command' && safeParse(e.data)?.exitCode !== 0 && safeParse(e.data)?.exitCode != null),
  );
  const errorPatterns = new Map<string, { count: number; sequences: number[]; timestamps: string[]; message: string }>();
  for (const e of errorEvents) {
    const data = safeParse(e.data);
    const message = data?.message || data?.stderr || data?.command || 'unknown error';
    const pattern = normalizeErrorPattern(String(message));
    const existing = errorPatterns.get(pattern) || { count: 0, sequences: [], timestamps: [], message: String(message) };
    existing.count++;
    existing.sequences.push(e.sequence);
    existing.timestamps.push(e.timestamp);
    errorPatterns.set(pattern, existing);
  }

  for (const [pattern, info] of errorPatterns) {
    // Check if the error was followed by a successful action (correction)
    const lastErrorSeq = info.sequences[info.sequences.length - 1];
    const successAfter = events.find(
      (e) => e.sequence > lastErrorSeq && e.type === 'command' && safeParse(e.data)?.exitCode === 0,
    );
    const resolved = !!successAfter;
    memories.push({
      id: makeId(),
      sessionId: session.id,
      sequence: lastErrorSeq,
      timestamp: info.timestamps[info.timestamps.length - 1],
      category: 'error_lesson',
      key: `error:${pattern}`,
      content: resolved
        ? `Error "${truncate(info.message, 100)}" occurred ${info.count}x, then resolved`
        : `Error "${truncate(info.message, 100)}" occurred ${info.count}x, unresolved`,
      evidence: `Sequences: ${info.sequences.join(', ')}`,
      confidence: info.count >= 3 ? 'high' : info.count >= 2 ? 'medium' : 'low',
    });
  }

  // Phase 3: Corrections (same file modified multiple times with errors in between)
  const fileWriteSeqs = events
    .filter((e) => e.type === 'file_write')
    .map((e) => ({ seq: e.sequence, ts: e.timestamp, path: safeParse(e.data)?.path as string | undefined }));
  const errorSeqs = new Set(errorEvents.map((e) => e.sequence));
  const correctedFiles = new Map<string, { seq: number; ts: string }>();
  for (let i = 1; i < fileWriteSeqs.length; i++) {
    const curr = fileWriteSeqs[i];
    const prev = fileWriteSeqs.find(
      (f) => f.path === curr.path && f.seq < curr.seq,
    );
    if (!prev || !curr.path) continue;
    // Check if there was an error between the two writes to the same file
    const hasErrorBetween = events.some(
      (e) => errorSeqs.has(e.sequence) && e.sequence > prev.seq && e.sequence < curr.seq,
    );
    if (hasErrorBetween && !correctedFiles.has(curr.path)) {
      correctedFiles.set(curr.path, { seq: curr.seq, ts: curr.ts });
    }
  }
  for (const [path, info] of correctedFiles) {
    memories.push({
      id: makeId(),
      sessionId: session.id,
      sequence: info.seq,
      timestamp: info.ts,
      category: 'correction',
      key: `correction:${normalizePath(path)}`,
      content: `Agent corrected ${path} after encountering an error`,
      evidence: `Re-wrote file at sequence ${info.seq} after error`,
      confidence: 'high',
    });
  }

  // Phase 4: Decisions
  const decisionEvents = events.filter((e) => e.type === 'decision');
  for (const e of decisionEvents) {
    const data = safeParse(e.data);
    const desc = data?.description || data?.reasoning || 'unspecified decision';
    memories.push({
      id: makeId(),
      sessionId: session.id,
      sequence: e.sequence,
      timestamp: e.timestamp,
      category: 'decision',
      key: `decision:${normalizeDecisionKey(String(desc))}`,
      content: truncate(String(desc), 200),
      evidence: data?.reasoning ? `Reasoning: ${truncate(String(data.reasoning), 100)}` : 'No reasoning recorded',
      confidence: data?.reasoning ? 'high' : 'medium',
    });
  }

  // Phase 5: Tool patterns
  const commandEvents = events.filter((e) => e.type === 'command');
  const toolCounts = new Map<string, { count: number; lastSeq: number; lastTs: string; examples: string[] }>();
  for (const e of commandEvents) {
    const data = safeParse(e.data);
    const cmd = data?.command || '';
    const base = extractToolBase(String(cmd));
    if (!base) continue;
    const existing = toolCounts.get(base) || { count: 0, lastSeq: 0, lastTs: '', examples: [] };
    existing.count++;
    existing.lastSeq = e.sequence;
    existing.lastTs = e.timestamp;
    if (existing.examples.length < 3) existing.examples.push(truncate(String(cmd), 80));
    toolCounts.set(base, existing);
  }
  for (const [tool, info] of toolCounts) {
    if (info.count < 2) continue; // Only track patterns, not one-offs
    memories.push({
      id: makeId(),
      sessionId: session.id,
      sequence: info.lastSeq,
      timestamp: info.lastTs,
      category: 'tool_pattern',
      key: `tool:${tool}`,
      content: `Agent used '${tool}' ${info.count} times`,
      evidence: `Examples: ${info.examples.join('; ')}`,
      confidence: info.count >= 5 ? 'high' : 'medium',
    });
  }

  // Phase 6: Dependency facts (from package.json reads/writes)
  for (const e of fileEvents) {
    const data = safeParse(e.data);
    const path = data?.path || '';
    if (typeof path === 'string' && (path.endsWith('package.json') || path.endsWith('requirements.txt') || path.endsWith('Cargo.toml') || path.endsWith('go.mod'))) {
      memories.push({
        id: makeId(),
        sessionId: session.id,
        sequence: e.sequence,
        timestamp: e.timestamp,
        category: 'dependency_fact',
        key: `dep:${normalizePath(String(path))}`,
        content: `Agent interacted with dependency manifest ${path}`,
        evidence: `Action: ${e.type} at sequence ${e.sequence}`,
        confidence: 'medium',
      });
    }
  }

  // Phase 7: API knowledge
  const apiEvents = events.filter((e) => e.type === 'api_call');
  const apiMap = new Map<string, { count: number; lastSeq: number; lastTs: string; methods: Set<string> }>();
  for (const e of apiEvents) {
    const data = safeParse(e.data);
    const url = data?.url || '';
    const method = data?.method || 'GET';
    const endpoint = normalizeApiEndpoint(String(url));
    if (!endpoint) continue;
    const existing = apiMap.get(endpoint) || { count: 0, lastSeq: 0, lastTs: '', methods: new Set() };
    existing.count++;
    existing.lastSeq = e.sequence;
    existing.lastTs = e.timestamp;
    existing.methods.add(String(method));
    apiMap.set(endpoint, existing);
  }
  for (const [endpoint, info] of apiMap) {
    memories.push({
      id: makeId(),
      sessionId: session.id,
      sequence: info.lastSeq,
      timestamp: info.lastTs,
      category: 'api_knowledge',
      key: `api:${endpoint}`,
      content: `Agent called API ${endpoint} ${info.count}x (${[...info.methods].join(', ')})`,
      evidence: `Last call at sequence ${info.lastSeq}`,
      confidence: info.count >= 3 ? 'high' : 'medium',
    });
  }

  return memories;
}

// ─── Memory Diff ───

export function diffMemories(
  memoriesA: MemoryItem[],
  memoriesB: MemoryItem[],
  sessionA: MemorySession,
  sessionB: MemorySession,
): MemoryDiffResult {
  const mapA = new Map(memoriesA.map((m) => [m.key, m]));
  const mapB = new Map(memoriesB.map((m) => [m.key, m]));

  const learned: MemoryDiffItem[] = [];
  const forgotten: MemoryDiffItem[] = [];
  const retained: MemoryDiffItem[] = [];
  const evolved: MemoryDiffItem[] = [];
  const contradicted: MemoryDiffItem[] = [];

  // Keys in B not in A → learned
  for (const [key, memB] of mapB) {
    if (!mapA.has(key)) {
      learned.push({
        status: 'learned',
        category: memB.category,
        key,
        after: memB,
        explanation: `New knowledge acquired in session B: ${memB.content}`,
      });
    }
  }

  // Keys in A not in B → forgotten
  for (const [key, memA] of mapA) {
    if (!mapB.has(key)) {
      forgotten.push({
        status: 'forgotten',
        category: memA.category,
        key,
        before: memA,
        explanation: `Knowledge from session A not referenced in session B: ${memA.content}`,
      });
    }
  }

  // Keys in both → retained, evolved, or contradicted
  for (const [key, memA] of mapA) {
    const memB = mapB.get(key);
    if (!memB) continue;

    if (contentsSimilar(memA.content, memB.content)) {
      retained.push({
        status: 'retained',
        category: memA.category,
        key,
        before: memA,
        after: memB,
        explanation: `Knowledge retained across sessions: ${memA.content}`,
      });
    } else if (isContradiction(memA, memB)) {
      contradicted.push({
        status: 'contradicted',
        category: memA.category,
        key,
        before: memA,
        after: memB,
        explanation: `Contradicting knowledge: "${truncate(memA.content, 60)}" vs "${truncate(memB.content, 60)}"`,
      });
    } else {
      evolved.push({
        status: 'evolved',
        category: memA.category,
        key,
        before: memA,
        after: memB,
        explanation: `Knowledge evolved: "${truncate(memA.content, 60)}" → "${truncate(memB.content, 60)}"`,
      });
    }
  }

  const total = learned.length + forgotten.length + retained.length + evolved.length + contradicted.length;
  const summary =
    `Compared ${memoriesA.length} memories (A) vs ${memoriesB.length} memories (B): ` +
    `${learned.length} learned, ${forgotten.length} forgotten, ${retained.length} retained, ` +
    `${evolved.length} evolved, ${contradicted.length} contradicted` +
    (total === 0 ? '. No memories to compare.' : '.');

  return {
    sessionA: { id: sessionA.id, objective: sessionA.objective, startedAt: sessionA.started_at },
    sessionB: { id: sessionB.id, objective: sessionB.objective, startedAt: sessionB.started_at },
    learned,
    forgotten,
    retained,
    evolved,
    contradicted,
    hallucinations: [],
    summary,
  };
}

// ─── Hallucination Detection ───

export function detectHallucinations(
  allMemoriesBySession: Map<string, MemoryItem[]>,
): HallucinationItem[] {
  const hallucinations: HallucinationItem[] = [];

  // 1. Recurring errors — same error key appears in 2+ sessions
  const errorOccurrences = new Map<string, Array<{ sessionId: string; mem: MemoryItem }>>();
  for (const [sessionId, memories] of allMemoriesBySession) {
    for (const mem of memories) {
      if (mem.category !== 'error_lesson') continue;
      const existing = errorOccurrences.get(mem.key) || [];
      existing.push({ sessionId, mem });
      errorOccurrences.set(mem.key, existing);
    }
  }
  for (const [key, occurrences] of errorOccurrences) {
    if (occurrences.length < 2) continue;
    hallucinations.push({
      key,
      category: 'error_lesson',
      claim: occurrences[0].mem.content,
      evidence: `Same error pattern recurred in ${occurrences.length} sessions — agent did not retain the lesson`,
      type: 'recurring_error',
      occurrences: occurrences.map((o) => ({
        sessionId: o.sessionId,
        sequence: o.mem.sequence,
        timestamp: o.mem.timestamp,
      })),
    });
  }

  // 2. Contradicted facts — same key has different content across sessions
  const factsByKey = new Map<string, Array<{ sessionId: string; mem: MemoryItem }>>();
  for (const [sessionId, memories] of allMemoriesBySession) {
    for (const mem of memories) {
      if (mem.category === 'error_lesson' || mem.category === 'tool_pattern') continue;
      const existing = factsByKey.get(mem.key) || [];
      existing.push({ sessionId, mem });
      factsByKey.set(mem.key, existing);
    }
  }
  for (const [key, instances] of factsByKey) {
    if (instances.length < 2) continue;
    // Check if any pair contradicts
    for (let i = 0; i < instances.length - 1; i++) {
      for (let j = i + 1; j < instances.length; j++) {
        if (isContradiction(instances[i].mem, instances[j].mem)) {
          hallucinations.push({
            key,
            category: instances[0].mem.category,
            claim: `Session ${instances[i].sessionId.slice(0, 8)}: "${truncate(instances[i].mem.content, 60)}" vs Session ${instances[j].sessionId.slice(0, 8)}: "${truncate(instances[j].mem.content, 60)}"`,
            evidence: 'Same knowledge key has contradicting content across sessions',
            type: 'contradicted_fact',
            occurrences: [instances[i], instances[j]].map((o) => ({
              sessionId: o.sessionId,
              sequence: o.mem.sequence,
              timestamp: o.mem.timestamp,
            })),
          });
          break; // One hallucination per key pair is enough
        }
      }
    }
  }

  return hallucinations;
}

// ─── Cumulative Memory ───

export function buildCumulativeMemory(
  sessionMemories: Array<{ session: MemorySession; memories: MemoryItem[] }>,
): CumulativeMemory {
  const latestByKey = new Map<string, MemoryItem>();
  let corrections = 0;
  let contradictions = 0;

  // Sort by session start time (oldest first) so later sessions overwrite
  const sorted = [...sessionMemories].sort(
    (a, b) => new Date(a.session.started_at).getTime() - new Date(b.session.started_at).getTime(),
  );

  for (const { memories } of sorted) {
    for (const mem of memories) {
      const existing = latestByKey.get(mem.key);
      if (existing) {
        if (isContradiction(existing, mem)) contradictions++;
        if (mem.category === 'correction') corrections++;
      }
      latestByKey.set(mem.key, mem);
    }
  }

  const items = [...latestByKey.values()];
  const byCategory: Record<string, number> = {};
  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  }

  // Detect hallucinations across all sessions
  const memBySession = new Map<string, MemoryItem[]>();
  for (const { session, memories } of sessionMemories) {
    memBySession.set(session.id, memories);
  }
  const hallucinations = detectHallucinations(memBySession);

  const firstSeen = sorted.length > 0 ? sorted[0].session.started_at : '';
  const lastUpdated = sorted.length > 0 ? sorted[sorted.length - 1].session.started_at : '';

  return {
    items,
    totalSessions: sessionMemories.length,
    firstSeen,
    lastUpdated,
    hallucinations,
    stats: {
      byCategory,
      totalItems: items.length,
      contradictions,
      corrections,
    },
  };
}

// ─── LLM Prompt Builder ───

export function buildMemoryDiffPrompt(diff: MemoryDiffResult): string {
  const sections: string[] = [];
  sections.push(`# Agent Memory Diff Analysis`);
  sections.push(`Session A: ${diff.sessionA.id.slice(0, 8)} — "${diff.sessionA.objective}"`);
  sections.push(`Session B: ${diff.sessionB.id.slice(0, 8)} — "${diff.sessionB.objective}"`);
  sections.push('');

  if (diff.learned.length > 0) {
    sections.push(`## Newly Learned (${diff.learned.length})`);
    for (const item of diff.learned.slice(0, 15)) {
      sections.push(`- [${item.category}] ${item.after?.content}`);
    }
    sections.push('');
  }

  if (diff.forgotten.length > 0) {
    sections.push(`## Forgotten (${diff.forgotten.length})`);
    for (const item of diff.forgotten.slice(0, 15)) {
      sections.push(`- [${item.category}] ${item.before?.content}`);
    }
    sections.push('');
  }

  if (diff.evolved.length > 0) {
    sections.push(`## Evolved Understanding (${diff.evolved.length})`);
    for (const item of diff.evolved.slice(0, 10)) {
      sections.push(`- Before: ${item.before?.content}`);
      sections.push(`  After:  ${item.after?.content}`);
    }
    sections.push('');
  }

  if (diff.contradicted.length > 0) {
    sections.push(`## Contradictions (${diff.contradicted.length})`);
    for (const item of diff.contradicted.slice(0, 10)) {
      sections.push(`- ${item.explanation}`);
    }
    sections.push('');
  }

  if (diff.hallucinations.length > 0) {
    sections.push(`## Hallucinations (${diff.hallucinations.length})`);
    for (const h of diff.hallucinations.slice(0, 10)) {
      sections.push(`- [${h.type}] ${h.claim}`);
      sections.push(`  Evidence: ${h.evidence}`);
    }
    sections.push('');
  }

  sections.push(`## Task`);
  sections.push(`Analyze this memory diff between two AI agent sessions.`);
  sections.push(`Provide: 1) A summary of how the agent's knowledge evolved, 2) Key insights about what the agent forgot and why it matters, 3) Recommendations to improve agent memory retention.`);
  sections.push(`Respond in JSON: { "summary": "...", "insights": ["..."], "recommendations": ["..."] }`);

  return sections.join('\n');
}

export interface MemoryDiffLlmResult {
  summary: string;
  insights: string[];
  recommendations: string[];
}

export function parseMemoryDiffResponse(text: string): MemoryDiffLlmResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.summary && Array.isArray(parsed.insights) && Array.isArray(parsed.recommendations)) {
      return parsed as MemoryDiffLlmResult;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Helpers ───

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
}

function normalizeErrorPattern(msg: string): string {
  return msg
    .replace(/\d+/g, 'N')
    .replace(/'[^']*'/g, "'...'")
    .replace(/"[^"]*"/g, '"..."')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .toLowerCase();
}

function normalizeDecisionKey(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function extractToolBase(cmd: string): string | null {
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;
  // Skip env vars (FOO=bar command ...)
  let base = parts[0];
  if (base.includes('=') && parts.length > 1) base = parts[1];
  return base.toLowerCase();
}

function normalizeApiEndpoint(url: string): string | null {
  try {
    const u = new URL(url);
    // Replace dynamic segments (UUIDs, numbers) with :id
    const path = u.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+/g, '/:id');
    return `${u.hostname}${path}`;
  } catch {
    return url.slice(0, 100);
  }
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 3) + '...' : s;
}

function contentsSimilar(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
  return normalize(a) === normalize(b);
}

function isContradiction(a: MemoryItem, b: MemoryItem): boolean {
  // Different categories can't contradict
  if (a.category !== b.category) return false;
  // Same content is not a contradiction
  if (contentsSimilar(a.content, b.content)) return false;

  const ca = a.content.toLowerCase();
  const cb = b.content.toLowerCase();

  // File knowledge: one says created, other says deleted
  if (a.category === 'file_knowledge') {
    if ((ca.includes('created') && cb.includes('deleted')) || (ca.includes('deleted') && cb.includes('created'))) {
      return true;
    }
  }

  // Error lesson: one says resolved, other says unresolved
  if (a.category === 'error_lesson') {
    if ((ca.includes('resolved') && cb.includes('unresolved')) || (ca.includes('unresolved') && cb.includes('resolved'))) {
      return true;
    }
  }

  // General: negation patterns
  const negationPairs = [
    [/\bshould\b/, /\bshould not\b/],
    [/\buse\b/, /\bdon't use\b/],
    [/\benable/, /\bdisable/],
    [/\badd/, /\bremove/],
  ];
  for (const [pos, neg] of negationPairs) {
    if ((pos.test(ca) && neg.test(cb)) || (neg.test(ca) && pos.test(cb))) return true;
  }

  return false;
}
