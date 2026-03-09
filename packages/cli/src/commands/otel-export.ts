/**
 * hawkeye otel-export <session-id>
 *
 * Exports a Hawkeye session as OpenTelemetry-compatible JSON (OTLP format).
 * Can be imported by Grafana Tempo, Jaeger, Datadog, Honeycomb, etc.
 *
 * Also supports pushing directly to an OTLP HTTP endpoint:
 *   hawkeye otel-export <session-id> --endpoint http://localhost:4318/v1/traces
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { Storage } from '@hawkeye/core';

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number } }>;
  status: { code: number; message?: string };
}

function hexId(length: number): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toNano(iso: string): string {
  return String(new Date(iso).getTime() * 1_000_000);
}

function attr(key: string, value: string | number): OtlpSpan['attributes'][0] {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { key, value: { intValue: String(value) } };
    }
    return { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

export const otelExportCommand = new Command('otel-export')
  .description('Export session as OpenTelemetry traces (OTLP JSON)')
  .argument('<session-id>', 'Session ID to export')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .option('--endpoint <url>', 'Push to OTLP HTTP endpoint (e.g. http://localhost:4318/v1/traces)')
  .option('--service-name <name>', 'Service name for traces', 'hawkeye')
  .action(async (sessionId: string, options) => {
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      process.exit(1);
    }

    const storage = new Storage(dbPath);
    const sessionResult = storage.getSession(sessionId);

    if (!sessionResult.ok || !sessionResult.value) {
      console.error(chalk.red(`Session not found: ${sessionId}`));
      storage.close();
      process.exit(1);
    }

    const session = sessionResult.value;
    const eventsResult = storage.getEvents(sessionId);

    if (!eventsResult.ok) {
      console.error(chalk.red('Failed to load events'));
      storage.close();
      process.exit(1);
    }

    const events = eventsResult.value;
    const driftResult = storage.getDriftSnapshots(sessionId);
    const driftSnapshots = driftResult.ok ? driftResult.value : [];
    storage.close();

    // Generate trace + span IDs
    const traceId = hexId(16); // 32 hex chars
    const rootSpanId = hexId(8); // 16 hex chars

    // Root span = the session
    const sessionStart = toNano(session.started_at);
    const sessionEnd = session.ended_at
      ? toNano(session.ended_at)
      : String(Date.now() * 1_000_000);

    const rootSpan: OtlpSpan = {
      traceId,
      spanId: rootSpanId,
      name: `session: ${session.objective}`,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: sessionStart,
      endTimeUnixNano: sessionEnd,
      attributes: [
        attr('hawkeye.session.id', session.id),
        attr('hawkeye.session.objective', session.objective),
        attr('hawkeye.session.status', session.status),
        attr('hawkeye.agent', session.agent || 'unknown'),
        attr('hawkeye.total_actions', session.total_actions),
        attr('hawkeye.total_cost_usd', session.total_cost_usd),
      ],
      status: {
        code: session.status === 'completed' ? 1 : session.status === 'aborted' ? 2 : 0,
        message: session.status,
      },
    };

    if (session.final_drift_score != null) {
      rootSpan.attributes.push(attr('hawkeye.drift.final_score', session.final_drift_score));
    }

    // Child spans = events
    const childSpans: OtlpSpan[] = events.map((event) => {
      const spanId = hexId(8);
      const startNano = toNano(event.timestamp);
      const endNano = String(
        new Date(event.timestamp).getTime() * 1_000_000 + (event.duration_ms || 1) * 1_000_000,
      );

      let eventData: Record<string, unknown> = {};
      try {
        eventData = JSON.parse(event.data);
      } catch {}

      const spanName = getSpanName(event.type, eventData);

      const spanAttrs: OtlpSpan['attributes'] = [
        attr('hawkeye.event.type', event.type),
        attr('hawkeye.event.sequence', event.sequence),
      ];

      if (event.cost_usd > 0) {
        spanAttrs.push(attr('hawkeye.cost_usd', event.cost_usd));
      }
      if (event.drift_score != null) {
        spanAttrs.push(attr('hawkeye.drift.score', event.drift_score));
        if (event.drift_flag) {
          spanAttrs.push(attr('hawkeye.drift.flag', event.drift_flag));
        }
      }

      // Type-specific attributes
      if (event.type === 'command') {
        spanAttrs.push(attr('process.command', String(eventData.command || '')));
      } else if (event.type === 'file_write' || event.type === 'file_read' || event.type === 'file_delete') {
        spanAttrs.push(attr('file.path', String(eventData.path || '')));
        spanAttrs.push(attr('file.action', String(eventData.action || '')));
      } else if (event.type === 'llm_call') {
        spanAttrs.push(attr('gen_ai.system', String(eventData.provider || '')));
        spanAttrs.push(attr('gen_ai.request.model', String(eventData.model || '')));
        if (eventData.promptTokens) spanAttrs.push(attr('gen_ai.usage.prompt_tokens', Number(eventData.promptTokens)));
        if (eventData.completionTokens) spanAttrs.push(attr('gen_ai.usage.completion_tokens', Number(eventData.completionTokens)));
      } else if (event.type === 'api_call') {
        spanAttrs.push(attr('http.url', String(eventData.url || '')));
        spanAttrs.push(attr('http.method', String(eventData.method || '')));
      } else if (event.type === 'guardrail_trigger' || event.type === 'guardrail_block') {
        spanAttrs.push(attr('hawkeye.guardrail.triggered', 'true'));
        if (eventData.ruleName) spanAttrs.push(attr('hawkeye.guardrail.rule', String(eventData.ruleName)));
      } else if (event.type.startsWith('git_')) {
        spanAttrs.push(attr('vcs.operation', String(eventData.operation || event.type.replace('git_', ''))));
        if (eventData.branch) spanAttrs.push(attr('vcs.branch', String(eventData.branch)));
        if (eventData.targetBranch) spanAttrs.push(attr('vcs.target_branch', String(eventData.targetBranch)));
        if (eventData.commitHash) spanAttrs.push(attr('vcs.commit.id', String(eventData.commitHash)));
        if (eventData.message) spanAttrs.push(attr('vcs.commit.message', String(eventData.message)));
        if (eventData.filesChanged) spanAttrs.push(attr('vcs.files_changed', Number(eventData.filesChanged)));
        if (eventData.linesAdded) spanAttrs.push(attr('vcs.lines_added', Number(eventData.linesAdded)));
        if (eventData.linesRemoved) spanAttrs.push(attr('vcs.lines_removed', Number(eventData.linesRemoved)));
      } else if (event.type === 'error') {
        spanAttrs.push(attr('exception.message', String(eventData.message || '')));
        if (eventData.code) spanAttrs.push(attr('exception.type', String(eventData.code)));
        if (eventData.source) spanAttrs.push(attr('hawkeye.error.source', String(eventData.source)));
      }

      return {
        traceId,
        spanId,
        parentSpanId: rootSpanId,
        name: spanName,
        kind: 1,
        startTimeUnixNano: startNano,
        endTimeUnixNano: endNano,
        attributes: spanAttrs,
        status: {
          code: event.type === 'guardrail_trigger' || event.type === 'guardrail_block' || event.type === 'error' ? 2 : 1,
        },
      };
    });

    // Add drift snapshot spans
    const driftSpans: OtlpSpan[] = driftSnapshots.map((d) => {
      const spanId = hexId(8);
      const nano = toNano(d.created_at);
      return {
        traceId,
        spanId,
        parentSpanId: rootSpanId,
        name: `drift-check: ${d.flag} (${d.score})`,
        kind: 1,
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: [
          attr('hawkeye.drift.score', d.score),
          attr('hawkeye.drift.flag', d.flag),
          attr('hawkeye.drift.reason', d.reason),
        ],
        status: {
          code: d.flag === 'critical' ? 2 : d.flag === 'warning' ? 0 : 1,
        },
      };
    });

    // Build OTLP JSON
    const otlpPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr('service.name', options.serviceName),
              attr('service.version', '0.1.0'),
              attr('telemetry.sdk.name', 'hawkeye'),
              attr('telemetry.sdk.language', 'nodejs'),
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: 'hawkeye',
                version: '0.1.0',
              },
              spans: [rootSpan, ...childSpans, ...driftSpans],
            },
          ],
        },
      ],
    };

    // Push to OTLP endpoint if specified
    if (options.endpoint) {
      try {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(otlpPayload),
        });
        if (response.ok) {
          console.log(chalk.green(`  Exported ${events.length + driftSpans.length + 1} spans to ${options.endpoint}`));
        } else {
          console.error(chalk.red(`  OTLP push failed: ${response.status} ${response.statusText}`));
          const body = await response.text();
          if (body) console.error(chalk.dim(`  ${body}`));
        }
      } catch (err) {
        console.error(chalk.red(`  OTLP push error: ${String(err)}`));
      }
      return;
    }

    // Write to file or stdout
    const json = JSON.stringify(otlpPayload, null, 2);
    if (options.output) {
      writeFileSync(options.output, json);
      console.log(chalk.green(`  Exported ${events.length + driftSpans.length + 1} spans to ${options.output}`));
      console.log(chalk.dim('  Compatible with: Grafana Tempo, Jaeger, Datadog, Honeycomb'));
    } else {
      process.stdout.write(json + '\n');
    }
  });

function getSpanName(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'command':
      return `cmd: ${String(data.command || '').slice(0, 80)}`;
    case 'file_write':
      return `write: ${String(data.path || '').split('/').pop()}`;
    case 'file_read':
      return `read: ${String(data.path || '').split('/').pop()}`;
    case 'file_delete':
      return `delete: ${String(data.path || '').split('/').pop()}`;
    case 'llm_call':
      return `llm: ${data.provider}/${data.model}`;
    case 'api_call':
      return `${data.method} ${data.url}`;
    case 'git_commit':
      return `git commit: ${String(data.message || data.commitHash || '').slice(0, 60)}`;
    case 'git_checkout':
      return `git checkout: ${data.branch || ''}`;
    case 'git_push':
      return `git push${data.branch ? ': ' + data.branch : ''}`;
    case 'git_pull':
      return `git pull`;
    case 'git_merge':
      return `git merge: ${data.targetBranch || ''}`;
    case 'error':
      return `error: ${String(data.message || '').slice(0, 80)}`;
    case 'guardrail_trigger':
    case 'guardrail_block':
      return `guardrail: ${data.ruleName || 'blocked'}`;
    default:
      return type;
  }
}
