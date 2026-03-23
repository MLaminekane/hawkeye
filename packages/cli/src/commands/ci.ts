/**
 * hawkeye ci — Post session report to GitHub PR
 *
 * Creates a GitHub Check Run and/or PR comment with a full
 * Hawkeye session observability report (drift, risk, cost, flags).
 *
 * Usage:
 *   hawkeye ci --pr 42
 *   hawkeye ci --pr 42 --session abc123
 *   hawkeye ci --json                     # Output markdown only, no GitHub API calls
 *   GITHUB_TOKEN=... hawkeye ci --pr 42   # In CI
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { openTraceStorage, traceDbExists, resolveSession } from './storage-helpers.js';
import { generateCIReport } from './ci-report.js';

const o = chalk.hex('#ff5f1f');

// ── Git helpers ──────────────────────────────────────────────────

function detectRepo(): string | null {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf-8', timeout: 5000 }).trim();
    // git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    // https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/(.+?\/.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch {
    return null;
  }
}

function detectSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function detectBranch(): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

// ── GitHub API helpers ───────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

async function githubFetch(token: string, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createCheckRun(
  token: string,
  repo: string,
  sha: string,
  passed: boolean,
  title: string,
  summary: string,
  markdown: string,
): Promise<void> {
  const res = await githubFetch(token, `/repos/${repo}/check-runs`, 'POST', {
    name: 'Hawkeye',
    head_sha: sha,
    status: 'completed',
    conclusion: passed ? 'success' : 'failure',
    output: {
      title,
      summary,
      text: markdown.slice(0, 65000), // GitHub limit
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Check Run failed (${res.status}): ${text}`);
  }
}

async function upsertPrComment(
  token: string,
  repo: string,
  pr: number,
  markdown: string,
): Promise<void> {
  // Search for existing Hawkeye comment
  const listRes = await githubFetch(token, `/repos/${repo}/issues/${pr}/comments?per_page=100`, 'GET');
  if (listRes.ok) {
    const comments = (await listRes.json()) as Array<{ id: number; body: string }>;
    const existing = comments.find((c) => c.body.includes('<!-- hawkeye-ci-report -->'));
    if (existing) {
      // Update existing comment
      const updateRes = await githubFetch(token, `/repos/${repo}/issues/comments/${existing.id}`, 'PATCH', {
        body: markdown,
      });
      if (!updateRes.ok) {
        const text = await updateRes.text();
        throw new Error(`GitHub comment update failed (${updateRes.status}): ${text}`);
      }
      return;
    }
  }

  // Create new comment
  const createRes = await githubFetch(token, `/repos/${repo}/issues/${pr}/comments`, 'POST', {
    body: markdown,
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`GitHub comment create failed (${createRes.status}): ${text}`);
  }
}

// ── Command ──────────────────────────────────────────────────────

export const ciCommand = new Command('ci')
  .description('Post session report to GitHub PR as Check Run + comment')
  .option('--pr <number>', 'PR number')
  .option('--repo <owner/repo>', 'GitHub repository (auto-detected from git remote)')
  .option('--sha <commit>', 'Commit SHA (default: HEAD)')
  .option('--session <id>', 'Session ID or prefix (auto-detects from branch if omitted)')
  .option('--dashboard-url <url>', 'Dashboard URL for replay links')
  .option('--fail-on-critical', 'Exit with code 1 on critical risk (default: true)', true)
  .option('--no-fail-on-critical', 'Do not fail on critical risk')
  .option('--comment', 'Post PR comment (default: true)', true)
  .option('--no-comment', 'Skip PR comment')
  .option('--check', 'Create GitHub Check Run (default: true)', true)
  .option('--no-check', 'Skip Check Run')
  .option('--json', 'Output report as JSON (no GitHub API calls)')
  .option('--markdown', 'Output raw markdown (no GitHub API calls)')
  .action(async (options) => {
    const {
      pr,
      session: sessionArg,
      dashboardUrl,
      failOnCritical,
      comment: postComment,
      check: postCheck,
      json: jsonMode,
      markdown: markdownMode,
    } = options;
    let { repo, sha } = options;

    // ── Open storage ─────────────────────────────────────────
    if (!traceDbExists()) {
      console.error(o('✗'), 'No Hawkeye database found. Run hawkeye init or record a session first.');
      process.exit(1);
    }
    const storage = openTraceStorage();

    // ── Find session ─────────────────────────────────────────
    let session;
    if (sessionArg) {
      const res = resolveSession(storage, sessionArg);
      if (!res.session) {
        console.error(o('✗'), `Session not found: ${sessionArg}`);
        process.exit(1);
      }
      session = res.session;
    } else {
      // Auto-detect: find most recent session matching current branch
      const branch = detectBranch();
      const all = storage.listSessions({ limit: 50 });
      if (!all.ok || !all.value?.length) {
        console.error(o('✗'), 'No sessions found.');
        process.exit(1);
      }

      if (branch) {
        session = all.value.find((s) => s.git_branch === branch);
      }
      if (!session) {
        // Fallback: most recent completed/recording session
        session = all.value[0];
      }
    }

    console.error(o('⬤'), `Session: ${session.id.slice(0, 8)} — "${session.objective}"`);

    // ── Gather data ──────────────────────────────────────────
    const evResult = storage.getEvents(session.id);
    const events = evResult.ok ? evResult.value : [];

    const statsResult = storage.getSessionStats(session.id);
    const stats = statsResult.ok
      ? statsResult.value
      : { total_events: 0, command_count: 0, file_count: 0, llm_count: 0, api_count: 0, git_count: 0, error_count: 0, guardrail_count: 0, total_cost_usd: 0, total_duration_ms: 0 };

    const driftResult = storage.getDriftSnapshots(session.id);
    const driftSnapshots = driftResult.ok ? driftResult.value : [];

    const violResult = storage.getViolations(session.id);
    const violations = violResult.ok ? violResult.value : [];

    const costResult = storage.getCostByFile(session.id);
    const costByFile = costResult.ok ? costResult.value : [];

    // ── Generate report ──────────────────────────────────────
    const report = generateCIReport({
      session,
      events,
      stats,
      driftSnapshots,
      violations,
      costByFile,
      dashboardUrl,
    });

    // ── Output modes ─────────────────────────────────────────
    if (jsonMode) {
      console.log(JSON.stringify({
        session: { id: session.id, objective: session.objective, status: session.status },
        risk: report.overallRisk,
        passed: report.passed,
        flags: report.flags,
        sensitiveFiles: report.sensitiveFiles,
        dangerousCommands: report.dangerousCommands,
        failedCommands: report.failedCommands,
        markdown: report.markdown,
      }, null, 2));
      storage.close();
      process.exit(report.passed || !failOnCritical ? 0 : 1);
      return;
    }

    if (markdownMode) {
      console.log(report.markdown);
      storage.close();
      process.exit(report.passed || !failOnCritical ? 0 : 1);
      return;
    }

    // ── GitHub integration ───────────────────────────────────
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.error(o('✗'), 'GITHUB_TOKEN environment variable is required.');
      console.error('  Set it via: export GITHUB_TOKEN=ghp_...');
      console.error('  In GitHub Actions, use: ${{ secrets.GITHUB_TOKEN }}');
      storage.close();
      process.exit(1);
    }

    repo = repo || detectRepo();
    if (!repo) {
      console.error(o('✗'), 'Could not detect repository. Use --repo owner/name.');
      storage.close();
      process.exit(1);
    }

    sha = sha || detectSha();
    if (!sha) {
      console.error(o('✗'), 'Could not detect commit SHA. Use --sha.');
      storage.close();
      process.exit(1);
    }

    console.error(o('⬤'), `Repo: ${repo} | SHA: ${sha.slice(0, 7)}${pr ? ` | PR: #${pr}` : ''}`);
    console.error(o('⬤'), `Risk: ${report.overallRisk.toUpperCase()} | Drift: ${session.final_drift_score ?? 'N/A'} | Cost: $${session.total_cost_usd.toFixed(2)}`);

    // Post Check Run
    if (postCheck) {
      try {
        const title = report.passed
          ? `Session passed — ${report.overallRisk} risk`
          : `Session flagged — ${report.overallRisk} risk`;
        const summary = report.flags.length > 0
          ? report.flags.join('\n')
          : 'No issues detected';

        await createCheckRun(token, repo, sha, report.passed, title, summary, report.markdown);
        console.error(o('✓'), `Check Run created: ${report.passed ? 'passed' : 'failed'}`);
      } catch (err) {
        console.error(o('✗'), `Check Run failed: ${(err as Error).message}`);
      }
    }

    // Post PR comment
    if (postComment && pr) {
      try {
        await upsertPrComment(token, repo, parseInt(pr, 10), report.markdown);
        console.error(o('✓'), `PR #${pr} comment posted`);
      } catch (err) {
        console.error(o('✗'), `PR comment failed: ${(err as Error).message}`);
      }
    } else if (postComment && !pr) {
      console.error(o('–'), 'No --pr specified, skipping comment');
    }

    // Print summary
    if (report.flags.length > 0) {
      console.error('');
      for (const flag of report.flags) {
        console.error(`  ${flag}`);
      }
    }

    storage.close();
    if (!report.passed && failOnCritical) {
      process.exit(1);
    }
  });
