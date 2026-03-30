import type { ClineMode } from '../tasks/runtime-utils';
import type { AgentStatusFilter, CommandOption, QuickStart, RoleOption } from './types';

export const COMMAND_OPTIONS: CommandOption[] = [
  {
    value: 'claude',
    label: 'Claude',
    kicker: 'Strategic',
    summary: 'Great for planning, debugging, and narrative reasoning.',
    detail: 'Use when you want deliberate investigation, structured decisions, and strong follow-up guidance.',
    badgeClass: 'text-hawk-orange',
    borderClass: 'border-orange-500/30',
    surfaceClass: 'from-orange-500/20 via-orange-500/7 to-transparent',
  },
  {
    value: 'cline',
    label: 'Cline',
    kicker: 'Versatile',
    summary: 'Multi-provider agent — route through Ollama, DeepSeek, Anthropic, OpenAI, or Cline Credits.',
    detail: 'Use when you want provider flexibility or want to leverage Cline Credits and local models.',
    badgeClass: 'text-emerald-600 dark:text-emerald-400',
    borderClass: 'border-emerald-500/30',
    surfaceClass: 'from-emerald-500/20 via-emerald-500/7 to-transparent',
  },
  {
    value: 'codex',
    label: 'Codex',
    kicker: 'Builder',
    summary: 'Strong fit for implementation-heavy tasks and test-backed changes.',
    detail: 'Use when the mission is to ship code, fix bugs, and verify outcomes fast.',
    badgeClass: 'text-sky-600 dark:text-sky-400',
    borderClass: 'border-sky-500/30',
    surfaceClass: 'from-sky-500/20 via-sky-500/7 to-transparent',
  },
];

export const FALLBACK_COMMAND: CommandOption = {
  value: 'agent',
  label: 'Agent',
  kicker: 'Runtime',
  summary: 'Connected runtime',
  detail: 'Attached via Hawkeye',
  badgeClass: 'text-hawk-text',
  borderClass: 'border-hawk-border',
  surfaceClass: 'from-hawk-surface2 via-hawk-surface2 to-transparent',
};

export const ROLE_OPTIONS: RoleOption[] = [
  {
    value: 'lead',
    label: 'Lead',
    summary: 'Frames the plan, keeps the task on track, and coordinates the next move.',
    badgeClass: 'text-amber-600 dark:text-amber-300 bg-amber-500/10 border-amber-500/20',
    borderClass: 'border-amber-500/30',
    surfaceClass: 'from-amber-500/18 via-amber-500/6 to-transparent',
  },
  {
    value: 'worker',
    label: 'Worker',
    summary: 'Executes the task directly and turns intent into concrete code or output.',
    badgeClass: 'text-cyan-600 dark:text-cyan-300 bg-cyan-500/10 border-cyan-500/20',
    borderClass: 'border-cyan-500/30',
    surfaceClass: 'from-cyan-500/18 via-cyan-500/6 to-transparent',
  },
  {
    value: 'reviewer',
    label: 'Reviewer',
    summary: 'Looks for regressions, weak assumptions, and missing validation before merge.',
    badgeClass: 'text-violet-600 dark:text-violet-300 bg-violet-500/10 border-violet-500/20',
    borderClass: 'border-violet-500/30',
    surfaceClass: 'from-violet-500/18 via-violet-500/6 to-transparent',
  },
];

export const QUICK_STARTS: QuickStart[] = [
  {
    id: 'fix-regression',
    label: 'Fix a regression',
    kicker: 'Repair',
    summary: 'Trace the failure, patch it safely, and prove the fix.',
    command: 'codex',
    role: 'worker',
    prompt:
      'Investigate the regression, identify the root cause, implement the smallest safe fix, and verify the result with targeted checks.',
    personality:
      'Work in small safe diffs. Prefer the minimum change that restores correct behavior. Add or update tests when they make the fix safer.',
    namePrefix: 'regression-fix',
  },
  {
    id: 'review-changes',
    label: 'Review a change',
    kicker: 'Audit',
    summary: 'Hunt for bugs, regressions, and blind spots before shipping.',
    command: 'claude',
    role: 'reviewer',
    prompt:
      'Review the current changes for bugs, behavioral regressions, risky assumptions, and missing tests. Prioritize findings by severity and include exact file references.',
    personality:
      'Be skeptical, concise, and evidence-driven. Lead with findings, not summary. Prefer high-signal issues over stylistic comments.',
    namePrefix: 'review-pass',
  },
  {
    id: 'ship-feature',
    label: 'Ship a feature',
    kicker: 'Build',
    summary: 'Implement a scoped feature with tests and a clean closeout.',
    command: 'codex',
    role: 'worker',
    prompt:
      'Implement the requested feature end-to-end, keep the UX polished, add the right validation, and verify the result with tests or targeted checks.',
    personality:
      'Optimize for readable code, polished UX, and confidence in the final result. Prefer direct implementation over long speculation.',
    namePrefix: 'feature-build',
  },
  {
    id: 'stabilize-flow',
    label: 'Stabilize a flow',
    kicker: 'Triage',
    summary: 'Observe the system, narrow the problem, and recommend the next safest step.',
    command: 'cline',
    role: 'lead',
    prompt:
      'Map the failing flow, identify the highest-risk points, and propose the safest next step before making broad changes. If a fix is obvious, apply it carefully.',
    personality:
      'Move deliberately. Clarify tradeoffs, keep a short feedback loop, and avoid risky changes until the path is clear.',
    namePrefix: 'stability-lead',
  },
];

export const STATUS_FILTERS: Array<{ id: AgentStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Live' },
  { id: 'failed', label: 'Needs attention' },
  { id: 'completed', label: 'Finished' },
];

export const CLINE_PROVIDER_OPTIONS: Array<{ value: ClineMode; label: string }> = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'deepseek', label: 'DeepSeek API' },
  { value: 'anthropic', label: 'Anthropic API' },
  { value: 'openai', label: 'OpenAI API' },
  { value: 'configured', label: 'Cline default' },
];
