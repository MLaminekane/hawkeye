/**
 * Post-mortem prompt template and response parser.
 * Generates an LLM-powered summary of a completed agent session.
 */

export interface PostMortemInput {
  objective: string;
  agent: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number;
  totalActions: number;
  totalCostUsd: number;
  totalTokens: number;
  finalDriftScore: number | null;
  eventSummary: string;
  filesSummary: string;
  driftHistory: string;
  violations: string;
  errors: string;
}

export interface PostMortemResult {
  summary: string;
  outcome: 'success' | 'partial' | 'failure' | 'abandoned';
  keyActions: string[];
  issues: string[];
  driftAnalysis: string;
  costAssessment: string;
  recommendations: string[];
}

export function buildPostMortemPrompt(input: PostMortemInput): string {
  return `You are an AI session analyst. Generate a structured post-mortem report for a completed AI agent coding session.

SESSION METADATA:
- Objective: "${input.objective}"
- Agent: ${input.agent}
- Status: ${input.status}
- Started: ${input.startedAt}
- Ended: ${input.endedAt || 'still running'}
- Duration: ${input.durationMinutes} minutes
- Total actions: ${input.totalActions}
- Total cost: $${input.totalCostUsd.toFixed(4)}
- Total tokens: ${input.totalTokens}
- Final drift score: ${input.finalDriftScore !== null ? `${input.finalDriftScore}/100` : 'N/A'}

EVENT SUMMARY (by type):
${input.eventSummary}

FILES MODIFIED:
${input.filesSummary || 'No files modified'}

DRIFT HISTORY:
${input.driftHistory || 'No drift checks recorded'}

GUARDRAIL VIOLATIONS:
${input.violations || 'None'}

ERRORS ENCOUNTERED:
${input.errors || 'None'}

INSTRUCTIONS:
Analyze this session and produce a JSON post-mortem. Be specific — reference actual files, commands, and patterns from the data above.

Respond ONLY in JSON:
{
  "summary": "<2-3 sentence executive summary of what happened in this session>",
  "outcome": "success" | "partial" | "failure" | "abandoned",
  "keyActions": ["<3-5 most significant actions or milestones>"],
  "issues": ["<problems encountered: errors, drift episodes, blocked actions, wasted effort>"],
  "driftAnalysis": "<1-2 sentences: did the agent stay on track? When/why did it drift?>",
  "costAssessment": "<1 sentence: was the cost reasonable for what was accomplished?>",
  "recommendations": ["<2-4 actionable suggestions for improving future sessions>"]
}

OUTCOME GUIDE:
- "success": Objective clearly achieved, no major issues
- "partial": Some progress toward objective but incomplete or with significant detours
- "failure": Objective not achieved, major errors or drift
- "abandoned": Session aborted or ended prematurely`;
}

export function parsePostMortemResponse(raw: string): PostMortemResult | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (
      typeof parsed.summary !== 'string' ||
      !['success', 'partial', 'failure', 'abandoned'].includes(parsed.outcome)
    ) {
      return null;
    }

    return {
      summary: parsed.summary,
      outcome: parsed.outcome,
      keyActions: Array.isArray(parsed.keyActions) ? parsed.keyActions : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      driftAnalysis: parsed.driftAnalysis || '',
      costAssessment: parsed.costAssessment || '',
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    };
  } catch {
    return null;
  }
}
