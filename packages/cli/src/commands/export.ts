import { Command } from 'commander';
import { join } from 'node:path';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import PDFDocument from 'pdfkit';
import { Storage, type SessionRow, type EventRow } from '@mklamine/hawkeye-core';

export const exportCommand = new Command('export')
  .description('Export a session report')
  .argument('<session-id>', 'Session ID (or prefix)')
  .option('-f, --format <type>', 'Output format: json, html, or pdf', 'html')
  .option('-o, --output <file>', 'Output file path')
  .action(async (sessionIdPrefix: string, options) => {
    const cwd = process.cwd();
    const dbPath = join(cwd, '.hawkeye', 'traces.db');

    if (!existsSync(dbPath)) {
      console.error(chalk.red('No database found. Run `hawkeye init` first.'));
      return;
    }

    const storage = new Storage(dbPath);

    // Find session by prefix
    const result = storage.listSessions({});
    if (!result.ok) {
      console.error(chalk.red('Failed to list sessions.'));
      storage.close();
      return;
    }

    const session = result.value.find((s) => s.id.startsWith(sessionIdPrefix));
    if (!session) {
      console.error(chalk.red(`No session found matching "${sessionIdPrefix}"`));
      storage.close();
      return;
    }

    const eventsResult = storage.getEvents(session.id);
    const driftResult = storage.getDriftSnapshots(session.id);
    const costByFileResult = storage.getCostByFile(session.id);
    storage.close();

    if (!eventsResult.ok) {
      console.error(chalk.red('Failed to get events.'));
      return;
    }

    const events = eventsResult.value;
    const drifts = driftResult.ok ? driftResult.value : [];
    const costByFile = costByFileResult.ok ? costByFileResult.value : [];
    const format = options.format || 'html';
    const extMap: Record<string, string> = { json: '.json', html: '.html', pdf: '.pdf' };
    const defaultExt = extMap[format] || '.html';
    const outputPath = options.output || `hawkeye-${session.id.slice(0, 8)}${defaultExt}`;

    if (format === 'json') {
      const data = {
        session,
        events: events.map((e) => ({
          ...e,
          data: JSON.parse(e.data),
        })),
        driftSnapshots: drifts,
        exportedAt: new Date().toISOString(),
        generator: 'hawkeye-cli',
      };
      writeFileSync(outputPath, JSON.stringify(data, null, 2));
    } else if (format === 'pdf') {
      await generatePdfReport(outputPath, session, events, drifts, costByFile);
    } else {
      const html = generateHtmlReport(
        session as unknown as Record<string, unknown>,
        events as unknown as Array<Record<string, unknown>>,
        drifts as unknown as Array<Record<string, unknown>>,
      );
      writeFileSync(outputPath, html);
    }

    console.log(chalk.green(`✓ Exported to ${chalk.bold(outputPath)}`));
    console.log(chalk.dim(`  Format: ${format}`));
    console.log(chalk.dim(`  Session: ${session.id.slice(0, 8)} — ${session.objective}`));
    console.log(chalk.dim(`  Events: ${events.length}`));
  });

// ─── PDF Report ──────────────────────────────────────────────

const PDF_COLORS = {
  bg: '#09090B',
  surface: '#111117',
  surface2: '#18181F',
  border: '#242430',
  text: '#E0E0EA',
  text2: '#9898A8',
  text3: '#5A5A6E',
  orange: '#FF5F1F',
  green: '#22C55E',
  amber: '#F0A830',
  red: '#EF4444',
  blue: '#3B82F6',
  purple: '#A78BFA',
  cyan: '#06B6D4',
};

export async function generatePdfReport(
  outputPath: string,
  session: SessionRow,
  events: EventRow[],
  drifts: Array<{ score: number; flag: string; reason: string; created_at: string }>,
  costByFile: Array<{ path: string; cost: number; edits: number }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
      bufferPages: true,
    });

    const stream = createWriteStream(outputPath);
    doc.pipe(stream);

    const pageW = doc.page.width - 80; // usable width
    const startTime = new Date(session.started_at).getTime();

    // ── Header ──
    doc.rect(0, 0, doc.page.width, 110).fill(PDF_COLORS.surface);
    doc.rect(40, 30, 4, 50).fill(PDF_COLORS.orange);

    doc.fontSize(20).fillColor(PDF_COLORS.text);
    doc.text('Hawkeye Session Report', 54, 32, { width: pageW - 14 });

    doc.fontSize(11).fillColor(PDF_COLORS.text2);
    doc.text(session.objective, 54, 56, { width: pageW - 14 });

    // Status badge
    const statusColors: Record<string, string> = {
      completed: PDF_COLORS.green,
      aborted: PDF_COLORS.red,
      recording: PDF_COLORS.orange,
      paused: PDF_COLORS.amber,
    };
    const statusColor = statusColors[session.status] || PDF_COLORS.text3;
    doc.fontSize(8).fillColor(statusColor);
    doc.text(session.status.toUpperCase(), 54, 78);

    // ── Stats bar ──
    doc.y = 120;
    const stats = [
      { label: 'Session', value: session.id.slice(0, 8) },
      { label: 'Agent', value: session.agent || 'unknown' },
      { label: 'Developer', value: session.developer || 'unknown' },
      { label: 'Duration', value: formatDuration(session.started_at, session.ended_at) },
      { label: 'Actions', value: String(session.total_actions || events.length) },
      { label: 'Cost', value: `$${(session.total_cost_usd || 0).toFixed(4)}` },
      { label: 'Tokens', value: formatNumber(session.total_tokens || 0) },
    ];
    if (session.final_drift_score != null) {
      stats.push({ label: 'Drift', value: `${session.final_drift_score}/100` });
    }

    const statW = pageW / stats.length;
    stats.forEach((s, i) => {
      const x = 40 + i * statW;
      doc.fontSize(7).fillColor(PDF_COLORS.text3);
      doc.text(s.label.toUpperCase(), x, 120, { width: statW });
      doc.fontSize(9).fillColor(PDF_COLORS.text);
      doc.text(s.value, x, 132, { width: statW });
    });

    // ── Separator ──
    doc.moveTo(40, 150).lineTo(40 + pageW, 150).strokeColor(PDF_COLORS.border).stroke();
    doc.y = 160;

    // ── Event Timeline Table ──
    doc.fontSize(13).fillColor(PDF_COLORS.orange);
    doc.text('Event Timeline', 40, doc.y);
    doc.y += 8;

    // Table header
    const cols = [
      { label: 'TIME', w: 50 },
      { label: 'TYPE', w: 55 },
      { label: 'EVENT', w: pageW - 185 },
      { label: 'COST', w: 50 },
      { label: 'DRIFT', w: 30 },
    ];

    let y = doc.y;

    function drawTableHeader() {
      doc.rect(40, y, pageW, 16).fill(PDF_COLORS.surface2);
      let x = 44;
      for (const col of cols) {
        doc.fontSize(6).fillColor(PDF_COLORS.text3);
        doc.text(col.label, x, y + 5, { width: col.w });
        x += col.w;
      }
      y += 18;
    }

    drawTableHeader();

    // Table rows
    const maxEvents = Math.min(events.length, 200); // Cap for very long sessions
    for (let i = 0; i < maxEvents; i++) {
      const e = events[i];
      const data = JSON.parse(e.data);
      const elapsed = formatElapsed(new Date(e.timestamp).getTime() - startTime);
      const { label, color } = getTypeStyle(e.type);
      const summary = getEventSummary(e.type, data, e as unknown as Record<string, unknown>);
      const cost = e.cost_usd > 0 ? `$${e.cost_usd.toFixed(4)}` : '';
      const drift = e.drift_score != null ? String(Math.round(e.drift_score)) : '';

      // Check page break
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = 50;
        drawTableHeader();
      }

      // Alternating row bg
      if (i % 2 === 0) {
        doc.rect(40, y, pageW, 14).fill('#0D0D12');
      }

      let x = 44;
      doc.fontSize(7).fillColor(PDF_COLORS.text3);
      doc.text(elapsed, x, y + 4, { width: cols[0].w });
      x += cols[0].w;

      doc.fillColor(color);
      doc.text(label, x, y + 4, { width: cols[1].w });
      x += cols[1].w;

      doc.fillColor(PDF_COLORS.text);
      doc.text(summary.slice(0, 80), x, y + 4, { width: cols[2].w });
      x += cols[2].w;

      doc.fillColor(PDF_COLORS.amber);
      doc.text(cost, x, y + 4, { width: cols[3].w });
      x += cols[3].w;

      doc.fillColor(PDF_COLORS.text2);
      doc.text(drift, x, y + 4, { width: cols[4].w });

      y += 14;
    }

    if (events.length > maxEvents) {
      doc.fontSize(7).fillColor(PDF_COLORS.text3);
      doc.text(`... and ${events.length - maxEvents} more events`, 44, y + 4);
      y += 18;
    }

    // ── Cost by File ──
    if (costByFile.length > 0) {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 50;
      }

      y += 10;
      doc.moveTo(40, y).lineTo(40 + pageW, y).strokeColor(PDF_COLORS.border).stroke();
      y += 12;

      doc.fontSize(13).fillColor(PDF_COLORS.orange);
      doc.text('Cost by File', 40, y);
      y += 22;

      const topFiles = costByFile.slice(0, 15);
      for (const f of topFiles) {
        if (y > doc.page.height - 60) {
          doc.addPage();
          y = 50;
        }
        const barWidth = Math.max(2, (f.cost / (costByFile[0].cost || 1)) * (pageW * 0.4));
        doc.rect(40, y, barWidth, 10).fill(PDF_COLORS.orange + '30');
        doc.rect(40, y, barWidth, 10).strokeColor(PDF_COLORS.orange + '60').stroke();

        const shortPath = f.path.length > 60 ? '...' + f.path.slice(-57) : f.path;
        doc.fontSize(7).fillColor(PDF_COLORS.text);
        doc.text(shortPath, 44, y + 2, { width: pageW * 0.6 });
        doc.fillColor(PDF_COLORS.amber);
        doc.text(`$${f.cost.toFixed(4)}  (${f.edits} edits)`, 40 + pageW * 0.7, y + 2, { width: pageW * 0.3, align: 'right' });
        y += 16;
      }
    }

    // ── Drift History ──
    if (drifts.length > 0) {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 50;
      }

      y += 10;
      doc.moveTo(40, y).lineTo(40 + pageW, y).strokeColor(PDF_COLORS.border).stroke();
      y += 12;

      doc.fontSize(13).fillColor(PDF_COLORS.orange);
      doc.text('Drift Score History', 40, y);
      y += 22;

      // Simple text-based drift timeline
      const chartH = 60;
      const chartW = pageW;

      // Draw chart axes
      doc.moveTo(40, y).lineTo(40, y + chartH).strokeColor(PDF_COLORS.border).stroke();
      doc.moveTo(40, y + chartH).lineTo(40 + chartW, y + chartH).strokeColor(PDF_COLORS.border).stroke();

      // Y-axis labels
      doc.fontSize(6).fillColor(PDF_COLORS.text3);
      doc.text('100', 20, y - 2);
      doc.text('50', 24, y + chartH / 2 - 4);
      doc.text('0', 28, y + chartH - 2);

      // Threshold lines
      const warnY = y + chartH * (1 - 60 / 100);
      const critY = y + chartH * (1 - 30 / 100);
      doc.moveTo(40, warnY).lineTo(40 + chartW, warnY).dash(3, { space: 3 }).strokeColor(PDF_COLORS.amber + '60').stroke();
      doc.moveTo(40, critY).lineTo(40 + chartW, critY).dash(3, { space: 3 }).strokeColor(PDF_COLORS.red + '60').stroke();
      doc.undash();

      // Plot points
      if (drifts.length > 1) {
        const stepX = chartW / (drifts.length - 1);
        doc.moveTo(40, y + chartH * (1 - drifts[0].score / 100));
        for (let i = 1; i < drifts.length; i++) {
          const px = 40 + i * stepX;
          const py = y + chartH * (1 - drifts[i].score / 100);
          doc.lineTo(px, py);
        }
        doc.strokeColor(PDF_COLORS.orange).lineWidth(1.5).stroke();
        doc.lineWidth(1);

        // Draw dots
        for (let i = 0; i < drifts.length; i++) {
          const px = 40 + i * stepX;
          const py = y + chartH * (1 - drifts[i].score / 100);
          const flagColor = drifts[i].flag === 'critical' ? PDF_COLORS.red : drifts[i].flag === 'warning' ? PDF_COLORS.amber : PDF_COLORS.green;
          doc.circle(px, py, 2.5).fill(flagColor);
        }
      }

      y += chartH + 20;

      // Drift reasons (last few)
      const recentDrifts = drifts.slice(-5);
      for (const d of recentDrifts) {
        if (y > doc.page.height - 50) {
          doc.addPage();
          y = 50;
        }
        const flagColor = d.flag === 'critical' ? PDF_COLORS.red : d.flag === 'warning' ? PDF_COLORS.amber : PDF_COLORS.green;
        doc.rect(40, y, 3, 10).fill(flagColor);
        doc.fontSize(7).fillColor(PDF_COLORS.text2);
        doc.text(`${Math.round(d.score)}/100`, 48, y + 1, { width: 40 });
        doc.fillColor(PDF_COLORS.text3);
        doc.text((d.reason || '').slice(0, 100), 92, y + 1, { width: pageW - 52 });
        y += 14;
      }
    }

    // ── Footer ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(6).fillColor(PDF_COLORS.text3);
      doc.text(
        `Hawkeye Report — ${session.id.slice(0, 8)} — ${new Date().toLocaleDateString()} — Page ${i + 1}/${pages.count}`,
        40,
        doc.page.height - 35,
        { width: pageW, align: 'center' },
      );
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/** Generate PDF and return as Buffer (for HTTP responses). */
export async function generatePdfBuffer(
  session: SessionRow,
  events: EventRow[],
  drifts: Array<{ score: number; flag: string; reason: string; created_at: string }>,
  costByFile: Array<{ path: string; cost: number; edits: number }>,
): Promise<Buffer> {
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { readFileSync, unlinkSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const tmpPath = joinPath(tmpdir(), `hawkeye-${randomUUID()}.pdf`);
  await generatePdfReport(tmpPath, session, events, drifts, costByFile);
  const buf = readFileSync(tmpPath);
  try { unlinkSync(tmpPath); } catch {}
  return buf;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── HTML Report ─────────────────────────────────────────────

function generateHtmlReport(
  session: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
  drifts: Array<Record<string, unknown>>,
): string {
  const startTime = new Date(session.started_at as string).getTime();

  const eventRows = events.map((e, i) => {
    const data = JSON.parse(e.data as string);
    const elapsed = formatElapsed(new Date(e.timestamp as string).getTime() - startTime);
    const type = e.type as string;
    const { label, color } = getTypeStyle(type);
    const summary = getEventSummary(type, data, e);
    const cost = (e.cost_usd as number) > 0 ? `$${(e.cost_usd as number).toFixed(4)}` : '';
    const drift = e.drift_score != null ? `${e.drift_score}/100` : '';

    return `<tr>
      <td class="time">${elapsed}</td>
      <td><span class="badge" style="background:${color}20;color:${color}">${label}</span></td>
      <td class="summary">${escapeHtml(summary)}</td>
      <td class="cost">${cost}</td>
      <td class="drift">${drift}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hawkeye Report — ${escapeHtml(session.objective as string)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: #09090B; color: #E0E0EA; padding: 2rem; }
  .header { background: #16161D; border: 1px solid #2A2A3A; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .header h1 { font-family: system-ui; font-size: 1.25rem; margin-bottom: 0.5rem; }
  .stats { display: flex; gap: 1.5rem; margin-top: 1rem; font-size: 0.75rem; }
  .stats span { color: #9898A8; }
  .stats strong { color: #E0E0EA; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; }
  .status.completed { background: #22c55e20; color: #22c55e; }
  .status.aborted { background: #ef444420; color: #ef4444; }
  .status.recording { background: #ff5f1f20; color: #ff5f1f; }
  table { width: 100%; border-collapse: collapse; background: #111117; border: 1px solid #242430; border-radius: 8px; overflow: hidden; }
  th { text-align: left; padding: 0.5rem 0.75rem; background: #18181f; font-size: 0.65rem; text-transform: uppercase; color: #555568; letter-spacing: 0.05em; }
  td { padding: 0.4rem 0.75rem; border-top: 1px solid #1E1E2A; font-size: 0.75rem; }
  .time { color: #5A5A6E; white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary { max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cost { color: #FFB443; text-align: right; }
  .drift { color: #9898A8; text-align: right; }
  .footer { margin-top: 1.5rem; text-align: center; font-size: 0.6rem; color: #5A5A6E; }
  @media print { body { background: white; color: black; } .header, table { border-color: #ddd; background: #fafafa; } }
</style>
</head>
<body>
  <div class="header">
    <span class="status ${session.status}">${session.status}</span>
    <h1>${escapeHtml(session.objective as string)}</h1>
    <div class="stats">
      <div><span>Agent:</span> <strong>${escapeHtml(String(session.agent || 'unknown'))}</strong></div>
      <div><span>Duration:</span> <strong>${formatDuration(session.started_at as string, session.ended_at as string | null)}</strong></div>
      <div><span>Actions:</span> <strong>${events.length}</strong></div>
      <div><span>Cost:</span> <strong>$${((session.total_cost_usd as number) || 0).toFixed(4)}</strong></div>
      ${session.final_drift_score != null ? `<div><span>Drift:</span> <strong>${session.final_drift_score}/100</strong></div>` : ''}
      <div><span>Session:</span> <strong>${(session.id as string).slice(0, 8)}</strong></div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Time</th><th>Type</th><th>Event</th><th>Cost</th><th>Drift</th></tr>
    </thead>
    <tbody>
      ${eventRows}
    </tbody>
  </table>

  <div class="footer">
    Exported by Hawkeye on ${new Date().toLocaleString()} — ${events.length} events
  </div>
</body>
</html>`;
}

// ─── Shared helpers ──────────────────────────────────────────

function getTypeStyle(type: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    command:           { label: 'CMD',   color: '#3B82F6' },
    file_write:        { label: 'FILE',  color: '#2ECC71' },
    file_delete:       { label: 'DEL',   color: '#FF4757' },
    file_read:         { label: 'READ',  color: '#6B7280' },
    llm_call:          { label: 'LLM',   color: '#A78BFA' },
    api_call:          { label: 'API',   color: '#06B6D4' },
    git_commit:        { label: 'GIT',   color: '#22c55e' },
    git_checkout:      { label: 'GIT',   color: '#3B82F6' },
    git_push:          { label: 'GIT',   color: '#06B6D4' },
    git_pull:          { label: 'GIT',   color: '#06B6D4' },
    git_merge:         { label: 'GIT',   color: '#A78BFA' },
    guardrail_trigger: { label: 'BLOCK', color: '#FF4757' },
    guardrail_block:   { label: 'BLOCK', color: '#FF4757' },
    error:             { label: 'ERR',   color: '#FF4757' },
  };
  return map[type] || { label: type.toUpperCase(), color: '#5A5A6E' };
}

function getEventSummary(type: string, data: Record<string, unknown>, event: Record<string, unknown>): string {
  switch (type) {
    case 'command': return `${data.command || ''} ${((data.args as string[]) || []).join(' ')}`.trim();
    case 'file_write': return `Modified ${data.path || ''}`;
    case 'file_delete': return `Deleted ${data.path || ''}`;
    case 'file_read': return `Read ${data.path || ''}`;
    case 'llm_call': return `${data.provider}/${data.model} → ${data.totalTokens} tokens`;
    case 'git_commit': return `commit ${data.commitHash || ''} ${data.message || ''}`.trim();
    case 'git_checkout': return `checkout ${data.branch || ''}`;
    case 'git_push': return `push ${data.branch || ''}`;
    case 'git_pull': return `pull`;
    case 'git_merge': return `merge ${data.targetBranch || ''}`;
    case 'error': return String(data.message || 'Error');
    case 'guardrail_trigger': return `${data.ruleName ? '[' + data.ruleName + '] ' : ''}${data.description || ''}`;
    default: return type;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
}

function formatDuration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
