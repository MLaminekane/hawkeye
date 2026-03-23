/**
 * Swarm conflict detection — identifies file conflicts between agents.
 */

import type { FileConflict, SwarmAgent } from './types.js';

/**
 * Detect file conflicts between agents that have completed their work.
 * Compares the lists of files each agent modified.
 */
export function detectConflicts(agents: SwarmAgent[]): FileConflict[] {
  const fileMap = new Map<string, string[]>();

  for (const agent of agents) {
    if (!agent.filesChanged) continue;
    for (const file of agent.filesChanged) {
      const existing = fileMap.get(file) || [];
      existing.push(agent.name);
      fileMap.set(file, existing);
    }
  }

  const conflicts: FileConflict[] = [];
  for (const [path, agentNames] of fileMap) {
    if (agentNames.length > 1) {
      conflicts.push({
        path,
        agents: agentNames,
        type: 'both_modified',
        resolved: false,
      });
    }
  }

  return conflicts.sort((a, b) => b.agents.length - a.agents.length);
}

/**
 * Detect conflicts between two specific agents using git diff.
 * More precise than file-list comparison — checks actual content overlap.
 */
export function detectDetailedConflicts(
  agent1: SwarmAgent,
  agent2: SwarmAgent,
  agent1Files: Map<string, { added: Set<number>; removed: Set<number> }>,
  agent2Files: Map<string, { added: Set<number>; removed: Set<number> }>,
): FileConflict[] {
  const conflicts: FileConflict[] = [];

  for (const [path, changes1] of agent1Files) {
    const changes2 = agent2Files.get(path);
    if (!changes2) continue;

    // Check if they touched overlapping line ranges
    const hasOverlap =
      hasLineOverlap(changes1.added, changes2.added) ||
      hasLineOverlap(changes1.added, changes2.removed) ||
      hasLineOverlap(changes1.removed, changes2.added) ||
      hasLineOverlap(changes1.removed, changes2.removed);

    if (hasOverlap) {
      conflicts.push({
        path,
        agents: [agent1.name, agent2.name],
        type: 'both_modified',
        resolved: false,
      });
    }
  }

  return conflicts;
}

/**
 * Check if two sets of line numbers overlap (within a proximity window).
 */
function hasLineOverlap(lines1: Set<number>, lines2: Set<number>, proximity = 3): boolean {
  for (const line1 of lines1) {
    for (const line2 of lines2) {
      if (Math.abs(line1 - line2) <= proximity) return true;
    }
  }
  return false;
}

/**
 * Score conflict severity (0-100). Higher = more severe.
 */
export function scoreConflict(conflict: FileConflict): number {
  let score = 0;

  // More agents = worse
  score += Math.min(conflict.agents.length * 20, 60);

  // Config/lock files = critical
  const criticalPatterns = [
    /package\.json$/,
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /yarn\.lock$/,
    /tsconfig.*\.json$/,
    /\.env/,
    /Cargo\.lock$/,
    /go\.sum$/,
  ];
  if (criticalPatterns.some((p) => p.test(conflict.path))) {
    score += 30;
  }

  // Type: modify_delete is worse than both_modified
  if (conflict.type === 'modify_delete') score += 20;
  if (conflict.type === 'add_add') score += 10;

  return Math.min(score, 100);
}

/**
 * Suggest a merge order that minimizes conflicts.
 * Agents with fewer conflicts should merge first.
 */
export function suggestMergeOrder(
  agents: SwarmAgent[],
  conflicts: FileConflict[],
): string[] {
  const conflictCount = new Map<string, number>();

  for (const agent of agents) {
    conflictCount.set(agent.name, 0);
  }

  for (const conflict of conflicts) {
    for (const agentName of conflict.agents) {
      conflictCount.set(agentName, (conflictCount.get(agentName) || 0) + 1);
    }
  }

  return agents
    .map((a) => a.name)
    .sort((a, b) => (conflictCount.get(a) || 0) - (conflictCount.get(b) || 0));
}
