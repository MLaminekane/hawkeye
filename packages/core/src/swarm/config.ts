/**
 * Swarm configuration — YAML parsing, validation, and dependency resolution.
 */

import type { SwarmConfig, SwarmTask, AgentPersona } from './types.js';

// ─── YAML parsing (simple — no dependency) ───────────────────

/**
 * Parse a swarm YAML config string into a SwarmConfig.
 * We use a lightweight YAML subset parser to avoid adding a dep.
 * For full YAML, users can JSON-ify first.
 */
export function parseSwarmYaml(yamlContent: string): SwarmConfig {
  // We accept JSON as a superset (YAML is a superset of JSON)
  try {
    const parsed = JSON.parse(yamlContent);
    return validateSwarmConfig(parsed);
  } catch {
    // Fall through to YAML-like parsing
  }

  // Simple YAML parser for swarm configs
  const lines = yamlContent.split('\n');
  const result: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> | unknown[] }> = [
    { indent: -1, obj: result },
  ];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith('- ')) {
      // Array item
      const value = trimmed.slice(2).trim();
      if (Array.isArray(parent)) {
        if (value.includes(':')) {
          const obj: Record<string, unknown> = {};
          const [k, ...rest] = value.split(':');
          obj[k.trim()] = parseYamlValue(rest.join(':').trim());
          parent.push(obj);
          stack.push({ indent, obj });
        } else {
          parent.push(parseYamlValue(value));
        }
      }
    } else if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      const valueStr = trimmed.slice(colonIdx + 1).trim();

      if (!Array.isArray(parent)) {
        if (valueStr === '' || valueStr === '|') {
          // Check if next non-empty line is an array or object
          const nextIdx = lines.indexOf(rawLine) + 1;
          const nextLine = nextIdx < lines.length ? lines[nextIdx] : '';
          const nextTrimmed = nextLine.trim();

          if (nextTrimmed.startsWith('- ')) {
            const arr: unknown[] = [];
            parent[key] = arr;
            stack.push({ indent, obj: arr });
          } else {
            const obj: Record<string, unknown> = {};
            parent[key] = obj;
            stack.push({ indent, obj });
          }
        } else {
          parent[key] = parseYamlValue(valueStr);
        }
      }
    }
  }

  return validateSwarmConfig(result);
}

function parseYamlValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // Strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // JSON array
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

// ─── Validation ──────────────────────────────────────────────

export function validateSwarmConfig(raw: Record<string, unknown>): SwarmConfig {
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error('Swarm config must have a "name" field');
  }
  if (!raw.objective || typeof raw.objective !== 'string') {
    throw new Error('Swarm config must have an "objective" field');
  }
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error('Swarm config must have at least one agent');
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error('Swarm config must have at least one task');
  }

  const agents: AgentPersona[] = (raw.agents as Record<string, unknown>[]).map((a, i) => {
    if (!a.name) throw new Error(`Agent #${i + 1} must have a name`);
    if (!a.command) throw new Error(`Agent "${a.name}" must have a command`);
    return {
      name: a.name as string,
      role: (a.role as AgentPersona['role']) || 'worker',
      description: (a.description as string) || '',
      command: a.command as string,
      args: (a.args as string[]) || [],
      scope: {
        include: ((a.scope as Record<string, unknown>)?.include as string[]) || ['**/*'],
        exclude: ((a.scope as Record<string, unknown>)?.exclude as string[]) || [],
        readRestricted: ((a.scope as Record<string, unknown>)?.readRestricted as boolean) || false,
      },
      timeout: (a.timeout as number) || undefined,
      maxCostUsd: (a.maxCostUsd as number) || undefined,
      model: (a.model as string) || undefined,
      color: (a.color as string) || undefined,
    };
  });

  const agentNames = new Set(agents.map((a) => a.name));

  const tasks: SwarmTask[] = (raw.tasks as Record<string, unknown>[]).map((t, i) => {
    if (!t.id && !t.agent) throw new Error(`Task #${i + 1} must have an id or agent name`);
    const agentName = t.agent as string;
    if (agentName && !agentNames.has(agentName)) {
      throw new Error(`Task "${t.id || i + 1}" references unknown agent "${agentName}"`);
    }
    return {
      id: (t.id as string) || `task-${i + 1}`,
      agent: agentName,
      prompt: (t.prompt as string) || '',
      dependsOn: (t.dependsOn as string[]) || [],
      priority: (t.priority as number) || 0,
      context: (t.context as string) || undefined,
    };
  });

  return {
    name: raw.name as string,
    description: (raw.description as string) || undefined,
    objective: raw.objective as string,
    agents,
    tasks,
    mergeStrategy: (raw.mergeStrategy as SwarmConfig['mergeStrategy']) || 'sequential',
    testCommand: (raw.testCommand as string) || undefined,
    timeout: (raw.timeout as number) || 3600,
    autoMerge: (raw.autoMerge as boolean) ?? true,
  };
}

// ─── Dependency Resolution (Topological Sort) ─────────────────

/**
 * Returns task IDs in dependency-safe execution order.
 * Tasks with no dependencies come first. Circular deps throw.
 */
export function resolveDependencies(tasks: SwarmTask[]): string[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const t of tasks) {
    graph.set(t.id, []);
    inDegree.set(t.id, 0);
  }

  for (const t of tasks) {
    if (t.dependsOn) {
      for (const dep of t.dependsOn) {
        if (!graph.has(dep)) {
          throw new Error(`Task "${t.id}" depends on unknown task "${dep}"`);
        }
        graph.get(dep)!.push(t.id);
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // Sort by priority within same level
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  queue.sort((a, b) => (taskMap.get(a)?.priority || 0) - (taskMap.get(b)?.priority || 0));

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const neighbor of graph.get(current) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        queue.push(neighbor);
        queue.sort((a, b) => (taskMap.get(a)?.priority || 0) - (taskMap.get(b)?.priority || 0));
      }
    }
  }

  if (result.length !== tasks.length) {
    const missing = tasks.filter((t) => !result.includes(t.id)).map((t) => t.id);
    throw new Error(`Circular dependency detected among tasks: ${missing.join(', ')}`);
  }

  return result;
}

// ─── Scope Validation ────────────────────────────────────────

/**
 * Check if a file path is within an agent's allowed scope.
 * Uses simple glob matching (*, **, ?).
 */
export function isInScope(filePath: string, scope: AgentPersona['scope']): boolean {
  const normalPath = filePath.replace(/\\/g, '/');

  // Check excludes first
  if (scope.exclude) {
    for (const pattern of scope.exclude) {
      if (matchGlob(normalPath, pattern)) return false;
    }
  }

  // Check includes
  for (const pattern of scope.include) {
    if (matchGlob(normalPath, pattern)) return true;
  }

  return false;
}

function matchGlob(path: string, pattern: string): boolean {
  // Convert glob to regex
  let regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]');

  // If pattern doesn't start with /, match anywhere
  if (!pattern.startsWith('/')) {
    regex = '(^|/)' + regex;
  }

  return new RegExp(regex + '(/|$)').test(path);
}

// ─── Template Generation ─────────────────────────────────────

/**
 * Generate a sample swarm YAML config.
 */
export function generateSwarmTemplate(): string {
  return JSON.stringify(
    {
      name: 'my-swarm',
      description: 'Multi-agent task',
      objective: 'Build feature X with frontend and backend components',
      mergeStrategy: 'sequential',
      autoMerge: true,
      testCommand: 'npm test',
      timeout: 3600,
      agents: [
        {
          name: 'backend-agent',
          role: 'worker',
          description: 'Handles API and database work',
          command: 'claude',
          scope: {
            include: ['src/api/**', 'src/db/**', 'src/models/**'],
            exclude: ['src/api/**/*.test.ts'],
          },
          timeout: 1800,
          color: '#3b82f6',
        },
        {
          name: 'frontend-agent',
          role: 'worker',
          description: 'Handles UI components and pages',
          command: 'claude',
          scope: {
            include: ['src/components/**', 'src/pages/**', 'src/styles/**'],
          },
          timeout: 1800,
          color: '#8b5cf6',
        },
        {
          name: 'reviewer',
          role: 'reviewer',
          description: 'Reviews and validates the work',
          command: 'claude',
          scope: { include: ['**/*'] },
          timeout: 600,
          color: '#22c55e',
        },
      ],
      tasks: [
        {
          id: 'backend',
          agent: 'backend-agent',
          prompt: 'Create the REST API endpoints for feature X',
          priority: 0,
        },
        {
          id: 'frontend',
          agent: 'frontend-agent',
          prompt: 'Build the UI components for feature X',
          dependsOn: [],
          priority: 0,
        },
        {
          id: 'review',
          agent: 'reviewer',
          prompt: 'Review the backend and frontend changes, run tests, fix any issues',
          dependsOn: ['backend', 'frontend'],
          priority: 1,
        },
      ],
    },
    null,
    2,
  );
}
