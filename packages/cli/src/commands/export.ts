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
  page: '#FFFDF8',
  paper: '#FFFFFF',
  paperMuted: '#FBF6EF',
  border: '#DDD4C8',
  text: '#202434',
  text2: '#5E677D',
  text3: '#8B93A7',
  orange: '#F97316',
  orangeSoft: '#FFF1E6',
  green: '#16A34A',
  greenSoft: '#EAF8EF',
  amber: '#D97706',
  amberSoft: '#FFF6E7',
  red: '#DC2626',
  redSoft: '#FEECEC',
  blue: '#2563EB',
  blueSoft: '#EAF1FF',
  purple: '#7C3AED',
  purpleSoft: '#F2EBFF',
  cyan: '#0891B2',
  cyanSoft: '#E8F9FC',
  stripe: '#F7F1E8',
};

type PdfDriftSnapshot = { score: number; flag: string; reason: string; created_at: string };
type PdfCostByFile = { path: string; cost: number; edits: number };
type PdfEventRecord = {
  row: EventRow;
  data: Record<string, unknown>;
  elapsed: string;
  label: string;
  color: string;
  summary: string;
  cost: number;
  drift: number | null;
};
type PdfInsight = { label: string; value: string; detail: string; tone: 'accent' | 'good' | 'warn' | 'info' | 'muted' };

const PDF_MARGIN = 40;
const PDF_TOP = 36;
const PDF_BOTTOM = 44;
const PDF_NOTABLE_EVENT_LIMIT = 34;
const PDF_TOP_FILE_LIMIT = 10;

export async function generatePdfReport(
  outputPath: string,
  session: SessionRow,
  events: EventRow[],
  drifts: PdfDriftSnapshot[],
  costByFile: PdfCostByFile[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PDF_TOP, bottom: PDF_BOTTOM, left: PDF_MARGIN, right: PDF_MARGIN },
      bufferPages: true,
    });

    const stream = createWriteStream(outputPath);
    doc.pipe(stream);

    const pageW = doc.page.width - PDF_MARGIN * 2;
    const startTime = new Date(session.started_at).getTime();
    const parsedEvents = events.map((event) => {
      const data = safeParseJson(event.data);
      const { label, color } = getTypeStyle(event.type);
      return {
        row: event,
        data,
        elapsed: formatElapsed(new Date(event.timestamp).getTime() - startTime),
        label,
        color,
        summary: getPdfEventSummary(event.type, data, event as unknown as Record<string, unknown>),
        cost: event.cost_usd || 0,
        drift: event.drift_score == null ? null : Math.round(event.drift_score),
      } satisfies PdfEventRecord;
    });

    const report = buildPdfReportModel(session, parsedEvents, drifts, costByFile);
    const metadata = [
      { label: 'Session', value: session.id.slice(0, 8) },
      { label: 'Agent', value: session.agent || 'unknown' },
      { label: 'Developer', value: session.developer || 'unknown' },
      { label: 'Model', value: session.model || 'unknown' },
      { label: 'Branch', value: session.git_branch || 'unknown' },
      { label: 'Working dir', value: truncateMiddle(session.working_dir || 'unknown', 70) },
      { label: 'Started', value: formatPdfTimestamp(session.started_at) },
      { label: 'Ended', value: session.ended_at ? formatPdfTimestamp(session.ended_at) : 'Still running' },
    ];
    const metricCards = [
      { label: 'Status', value: session.status.toUpperCase(), detail: session.ended_at ? 'Run finished' : 'Live snapshot', tone: statusTone(session.status) },
      { label: 'Duration', value: formatDuration(session.started_at, session.ended_at), detail: `${events.length} events captured`, tone: 'accent' as const },
      { label: 'Cost', value: formatCurrency(session.total_cost_usd || report.totalCost, ((session.total_cost_usd || report.totalCost) >= 1 ? 2 : 4)), detail: report.topCostEvent ? `Top action ${formatCurrency(report.topCostEvent.cost, 4)}` : 'No billable events', tone: 'warn' as const },
      { label: 'Tokens', value: formatNumber(session.total_tokens || 0), detail: `${report.llmCalls} LLM call${report.llmCalls === 1 ? '' : 's'}`, tone: 'info' as const },
      { label: 'Drift', value: session.final_drift_score != null ? `${Math.round(session.final_drift_score)}/100` : 'N/A', detail: report.latestDrift ? `${report.latestDrift.flag} drift signal` : 'No drift snapshot', tone: driftTone(session.final_drift_score) },
      { label: 'Files', value: String(report.changedFiles), detail: report.topFile ? `${formatCurrency(report.topFile.cost, 2)} on ${truncateMiddle(shortenPath(report.topFile.path, 38), 38)}` : 'No file cost captured', tone: 'muted' as const },
    ];

    let y = PDF_TOP;
    const pageBottom = () => doc.page.height - PDF_BOTTOM;
    const newPage = () => {
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(PDF_COLORS.page);
      y = PDF_TOP;
    };
    const ensureSpace = (height: number) => {
      if (y + height > pageBottom()) newPage();
    };
    const drawDivider = () => {
      doc.moveTo(PDF_MARGIN, y).lineTo(PDF_MARGIN + pageW, y).strokeColor(PDF_COLORS.border).stroke();
      y += 14;
    };
    const drawSectionHeader = (title: string, subtitle?: string) => {
      ensureSpace(subtitle ? 36 : 26);
      doc.fontSize(14).fillColor(PDF_COLORS.text);
      doc.text(title, PDF_MARGIN, y, { width: pageW });
      y += 18;
      if (subtitle) {
        doc.fontSize(8).fillColor(PDF_COLORS.text2);
        doc.text(subtitle, PDF_MARGIN, y, { width: pageW });
        y += 14;
      }
    };

    doc.rect(0, 0, doc.page.width, doc.page.height).fill(PDF_COLORS.page);
    drawPdfCard(doc, PDF_MARGIN, y, pageW, 94, PDF_COLORS.paper, PDF_COLORS.border, 18);
    doc.rect(PDF_MARGIN + 18, y + 16, 6, 40).fill(PDF_COLORS.orange);
    doc.fontSize(8).fillColor(PDF_COLORS.text2);
    doc.text('HAWKEYE SESSION REPORT', PDF_MARGIN + 34, y + 14, { width: pageW - 150 });
    doc.fontSize(23).fillColor(PDF_COLORS.text);
    doc.text(truncateMiddle(session.objective || 'Untitled session', 84), PDF_MARGIN + 34, y + 28, { width: pageW - 160 });
    doc.fontSize(8).fillColor(PDF_COLORS.text2);
    doc.text(
      `Session ${session.id.slice(0, 8)} • ${formatPdfTimestamp(new Date().toISOString())}`,
      PDF_MARGIN + 34,
      y + 70,
      { width: pageW - 180 },
    );
    drawTonePill(doc, PDF_MARGIN + pageW - 108, y + 18, 88, 24, session.status.toUpperCase(), statusFill(session.status), statusText(session.status));
    y += 112;

    drawSectionHeader('Overview');
    const cardGap = 10;
    const cardW = (pageW - cardGap) / 2;
    const cardH = 56;
    for (let index = 0; index < metricCards.length; index += 2) {
      ensureSpace(cardH + 12);
      const row = metricCards.slice(index, index + 2);
      row.forEach((card, offset) => {
        const x = PDF_MARGIN + offset * (cardW + cardGap);
        drawPdfCard(doc, x, y, cardW, cardH, toneFill(card.tone), PDF_COLORS.border, 14);
        doc.fontSize(7).fillColor(PDF_COLORS.text2);
        doc.text(card.label.toUpperCase(), x + 12, y + 10, { width: cardW - 24 });
        doc.fontSize(15).fillColor(toneText(card.tone));
        doc.text(card.value, x + 12, y + 22, { width: cardW - 24 });
        doc.fontSize(7).fillColor(PDF_COLORS.text2);
        doc.text(card.detail, x + 12, y + 42, { width: cardW - 24 });
      });
      y += cardH + 10;
    }

    drawDivider();
    drawSectionHeader('Highlights');
    report.insights.forEach((insight) => {
      doc.fontSize(8);
      const detailHeight = Math.max(12, doc.heightOfString(insight.detail, { width: pageW - 84, align: 'left' }));
      ensureSpace(detailHeight + 18);
      doc.circle(PDF_MARGIN + 6, y + 6, 3).fill(toneText(insight.tone));
      doc.fontSize(8).fillColor(PDF_COLORS.text);
      doc.text(`${insight.label}: ${insight.value}`, PDF_MARGIN + 16, y, { width: pageW - 20 });
      y += 10;
      doc.fontSize(8).fillColor(PDF_COLORS.text2);
      doc.text(insight.detail, PDF_MARGIN + 16, y, { width: pageW - 16 });
      y += detailHeight + 4;
    });

    drawDivider();
    drawSectionHeader('Session context');
    const metaRowH = 28;
    const metaColGap = 12;
    const metaColW = (pageW - metaColGap) / 2;
    for (let index = 0; index < metadata.length; index += 2) {
      ensureSpace(metaRowH + 6);
      const row = metadata.slice(index, index + 2);
      row.forEach((item, offset) => {
        const x = PDF_MARGIN + offset * (metaColW + metaColGap);
        drawPdfCard(doc, x, y, metaColW, metaRowH, PDF_COLORS.paper, PDF_COLORS.border, 12);
        doc.fontSize(7).fillColor(PDF_COLORS.text3);
        doc.text(item.label.toUpperCase(), x + 10, y + 7, { width: metaColW - 20 });
        doc.fontSize(8).fillColor(PDF_COLORS.text);
        doc.text(item.value, x + 10, y + 15, { width: metaColW - 20 });
      });
      y += metaRowH + 8;
    }

    if (costByFile.length > 0) {
      drawDivider();
      drawSectionHeader('Top cost files', 'The biggest spend concentrations, trimmed to the most expensive files.');
      const fileRows = costByFile.slice(0, PDF_TOP_FILE_LIMIT);
      const maxFileCost = fileRows[0]?.cost || 1;
      fileRows.forEach((file, index) => {
        ensureSpace(30);
        drawPdfCard(doc, PDF_MARGIN, y, pageW, 24, index % 2 === 0 ? PDF_COLORS.paperMuted : PDF_COLORS.paper, PDF_COLORS.border, 12);
        doc.fontSize(7).fillColor(PDF_COLORS.text3);
        doc.text(String(index + 1).padStart(2, '0'), PDF_MARGIN + 10, y + 8, { width: 18 });
        doc.fontSize(8).fillColor(PDF_COLORS.text);
        doc.text(shortenPath(file.path, 62), PDF_MARGIN + 28, y + 8, { width: pageW - 180 });
        const barX = PDF_MARGIN + pageW - 146;
        const barW = 64;
        drawPdfCard(doc, barX, y + 8, barW, 8, PDF_COLORS.orangeSoft, PDF_COLORS.orangeSoft, 5);
        drawPdfCard(doc, barX, y + 8, Math.max(4, (file.cost / maxFileCost) * barW), 8, PDF_COLORS.orange, PDF_COLORS.orange, 5);
        doc.fontSize(8).fillColor(PDF_COLORS.amber);
        doc.text(`${formatCurrency(file.cost, 4)} • ${file.edits} edit${file.edits === 1 ? '' : 's'}`, PDF_MARGIN + pageW - 74, y + 8, { width: 64, align: 'right' });
        y += 30;
      });
    }

    if (drifts.length > 0) {
      drawDivider();
      drawSectionHeader('Drift history', 'Score trend across recorded snapshots.');
      ensureSpace(128);
      const chartX = PDF_MARGIN;
      const chartY = y;
      const chartW = pageW;
      const chartH = 84;

      drawPdfCard(doc, chartX, chartY, chartW, chartH + 22, PDF_COLORS.paper, PDF_COLORS.border, 16);
      const innerX = chartX + 18;
      const innerY = chartY + 14;
      const innerW = chartW - 36;
      const innerH = chartH - 8;

      [0, 50, 100].forEach((tick) => {
        const tickY = innerY + innerH * (1 - tick / 100);
        doc.moveTo(innerX, tickY).lineTo(innerX + innerW, tickY).strokeColor(PDF_COLORS.border).stroke();
        doc.fontSize(6).fillColor(PDF_COLORS.text3);
        doc.text(String(tick), innerX - 20, tickY - 3, { width: 16, align: 'right' });
      });

      if (drifts.length === 1) {
        const pointY = innerY + innerH * (1 - drifts[0].score / 100);
        doc.circle(innerX + innerW / 2, pointY, 4).fill(flagColor(drifts[0].flag));
      } else {
        const stepX = innerW / Math.max(1, drifts.length - 1);
        doc.moveTo(innerX, innerY + innerH * (1 - drifts[0].score / 100));
        for (let index = 1; index < drifts.length; index++) {
          const pointX = innerX + index * stepX;
          const pointY = innerY + innerH * (1 - drifts[index].score / 100);
          doc.lineTo(pointX, pointY);
        }
        doc.strokeColor(PDF_COLORS.orange).lineWidth(1.6).stroke();
        doc.lineWidth(1);
        for (let index = 0; index < drifts.length; index++) {
          const pointX = innerX + index * stepX;
          const pointY = innerY + innerH * (1 - drifts[index].score / 100);
          doc.circle(pointX, pointY, 3).fill(flagColor(drifts[index].flag));
        }
      }

      const recentDrifts = drifts.slice(-3);
      recentDrifts.forEach((drift, index) => {
        const baseX = chartX + 18 + index * ((chartW - 36) / Math.max(1, recentDrifts.length));
        doc.fontSize(7).fillColor(PDF_COLORS.text);
        doc.text(`${Math.round(drift.score)}/100`, baseX, chartY + chartH + 4, { width: 42 });
        doc.fontSize(6).fillColor(PDF_COLORS.text2);
        doc.text(truncateMiddle(drift.reason || drift.flag, 28), baseX, chartY + chartH + 13, { width: 86 });
      });
      y += chartH + 34;
    }

    drawDivider();
    drawSectionHeader(
      'Notable timeline',
      report.timelineNote,
    );
    const cols = [
      { label: 'TIME', w: 52 },
      { label: 'TYPE', w: 52 },
      { label: 'EVENT', w: pageW - 214 },
      { label: 'COST', w: 62 },
      { label: 'DRIFT', w: 48 },
    ];
    const drawTimelineHeader = () => {
      ensureSpace(20);
      drawPdfCard(doc, PDF_MARGIN, y, pageW, 16, PDF_COLORS.paperMuted, PDF_COLORS.border, 8);
      let x = PDF_MARGIN + 10;
      cols.forEach((col) => {
        doc.fontSize(6).fillColor(PDF_COLORS.text3);
        doc.text(col.label, x, y + 5, { width: col.w });
        x += col.w;
      });
      y += 20;
    };
    drawTimelineHeader();

    report.notableEvents.forEach((event, index) => {
      ensureSpace(20);
      if (y + 20 > pageBottom()) {
        newPage();
        drawSectionHeader('Notable timeline', report.timelineNote);
        drawTimelineHeader();
      }
      drawPdfCard(doc, PDF_MARGIN, y, pageW, 16, index % 2 === 0 ? PDF_COLORS.paper : PDF_COLORS.paperMuted, PDF_COLORS.border, 8);
      let x = PDF_MARGIN + 10;
      doc.fontSize(7).fillColor(PDF_COLORS.text2);
      doc.text(event.elapsed, x, y + 5, { width: cols[0].w });
      x += cols[0].w;
      doc.fillColor(event.color);
      doc.text(event.label, x, y + 5, { width: cols[1].w });
      x += cols[1].w;
      doc.fillColor(PDF_COLORS.text);
      doc.text(truncateMiddle(event.summary, 96), x, y + 5, { width: cols[2].w });
      x += cols[2].w;
      doc.fillColor(event.cost > 0 ? PDF_COLORS.amber : PDF_COLORS.text3);
      doc.text(event.cost > 0 ? formatCurrency(event.cost, 4) : '—', x, y + 5, { width: cols[3].w, align: 'right' });
      x += cols[3].w;
      doc.fillColor(event.drift != null ? driftTextColor(event.drift) : PDF_COLORS.text3);
      doc.text(event.drift != null ? `${event.drift}` : '—', x, y + 5, { width: cols[4].w, align: 'right' });
      y += 20;
    });

    // ── Footer ──
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(6).fillColor(PDF_COLORS.text3);
      doc.text(
        `Hawkeye Session Report • ${session.id.slice(0, 8)} • ${new Date().toLocaleDateString()} • Page ${i + 1}/${pages.count}`,
        PDF_MARGIN,
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
  drifts: PdfDriftSnapshot[],
  costByFile: PdfCostByFile[],
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

function buildPdfReportModel(
  _session: SessionRow,
  events: PdfEventRecord[],
  drifts: PdfDriftSnapshot[],
  costByFile: PdfCostByFile[],
): {
  totalCost: number;
  llmCalls: number;
  changedFiles: number;
  topFile: PdfCostByFile | null;
  topCostEvent: PdfEventRecord | null;
  latestDrift: PdfDriftSnapshot | null;
  notableEvents: PdfEventRecord[];
  timelineNote: string;
  insights: PdfInsight[];
} {
  const totalCost = events.reduce((sum, event) => sum + event.cost, 0);
  const llmCalls = events.filter((event) => event.row.type === 'llm_call').length;
  const changedFiles = new Set(
    events
      .filter((event) => event.row.type === 'file_write' || event.row.type === 'file_delete' || event.row.type === 'file_rename')
      .map((event) => String(event.data.path || event.data.to || ''))
      .filter(Boolean),
  ).size;
  const guardrails = events.filter((event) => event.row.type === 'guardrail_trigger' || event.row.type === 'guardrail_block').length;
  const errors = events.filter((event) => event.row.type === 'error').length;
  const topCostEvent = [...events].sort((left, right) => right.cost - left.cost)[0] || null;
  const latestDrift = drifts[drifts.length - 1] || null;
  const dominantType = getDominantEventType(events);
  const topFile = costByFile[0] || null;
  const notableEvents = selectNotablePdfEvents(events);
  const omittedEvents = Math.max(0, events.length - notableEvents.length);
  const insights: PdfInsight[] = [
    {
      label: 'Dominant activity',
      value: dominantType.label,
      detail: `${dominantType.count} matching event${dominantType.count === 1 ? '' : 's'} across the run.`,
      tone: 'info',
    },
    {
      label: 'Guardrails',
      value: guardrails === 0 ? 'No blocks' : `${guardrails} intervention${guardrails === 1 ? '' : 's'}`,
      detail: guardrails === 0 ? 'No guardrail trigger or block was recorded.' : 'Guardrail activity should be reviewed alongside the timeline.',
      tone: guardrails === 0 ? 'good' : 'warn',
    },
    {
      label: 'Errors',
      value: String(errors),
      detail: errors === 0 ? 'No explicit error events were recorded.' : 'Errors are included in the notable timeline below.',
      tone: errors === 0 ? 'good' : 'warn',
    },
  ];

  if (topCostEvent) {
    insights.push({
      label: 'Most expensive action',
      value: formatCurrency(topCostEvent.cost, 4),
      detail: truncateMiddle(topCostEvent.summary, 88),
      tone: 'accent',
    });
  }

  if (topFile) {
    insights.push({
      label: 'Top file spend',
      value: formatCurrency(topFile.cost, 4),
      detail: `${shortenPath(topFile.path, 58)} • ${topFile.edits} edit${topFile.edits === 1 ? '' : 's'}`,
      tone: 'muted',
    });
  }

  if (latestDrift) {
    insights.push({
      label: 'Latest drift signal',
      value: `${Math.round(latestDrift.score)}/100`,
      detail: truncateMiddle(latestDrift.reason || latestDrift.flag, 88),
      tone: latestDrift.flag === 'critical' ? 'warn' : latestDrift.flag === 'warning' ? 'accent' : 'good',
    });
  }

  return {
    totalCost,
    llmCalls,
    changedFiles,
    topFile,
    topCostEvent,
    latestDrift,
    notableEvents,
    timelineNote:
      omittedEvents > 0
        ? `High-signal actions only. ${omittedEvents} lower-signal event${omittedEvents === 1 ? '' : 's'} omitted from the PDF. Use JSON export for the full trace.`
        : 'Chronological high-signal timeline of the session.',
    insights,
  };
}

function selectNotablePdfEvents(events: PdfEventRecord[]): PdfEventRecord[] {
  if (events.length <= PDF_NOTABLE_EVENT_LIMIT) return events;

  const first = events[0];
  const last = events[events.length - 1];
  const scored = events
    .map((event, index) => ({ event, index, score: pdfEventPriority(event, index, events.length) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, PDF_NOTABLE_EVENT_LIMIT - 2))
    .map((entry) => entry.event);

  const deduped = dedupeEvents([first, ...scored, last]);
  return deduped
    .sort((left, right) => new Date(left.row.timestamp).getTime() - new Date(right.row.timestamp).getTime())
    .slice(0, PDF_NOTABLE_EVENT_LIMIT);
}

function pdfEventPriority(event: PdfEventRecord, index: number, total: number): number {
  let score = 0;
  if (index === 0 || index === total - 1) score += 120;
  if (event.row.type === 'guardrail_trigger' || event.row.type === 'guardrail_block') score += 100;
  if (event.row.type === 'error') score += 95;
  if (event.row.type === 'command') score += 80;
  if (event.row.type === 'file_write' || event.row.type === 'file_delete' || event.row.type === 'file_rename') score += 72;
  if (event.row.type === 'llm_call') score += 54;
  if (event.drift != null) score += 46 + Math.max(0, 100 - event.drift);
  score += Math.min(40, event.cost * 20);
  return score;
}

function dedupeEvents(events: PdfEventRecord[]): PdfEventRecord[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.row.id)) return false;
    seen.add(event.row.id);
    return true;
  });
}

function getDominantEventType(events: PdfEventRecord[]): { label: string; count: number } {
  const counts = new Map<string, number>();
  events.forEach((event) => counts.set(event.row.type, (counts.get(event.row.type) || 0) + 1));
  const [type, count] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || ['unknown', 0];
  return { label: getTypeStyle(type).label, count };
}

function drawPdfCard(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  width: number,
  height: number,
  fillColor: string,
  strokeColor: string,
  radius: number,
): void {
  doc.save();
  doc.roundedRect(x, y, width, height, radius).fill(fillColor);
  doc.restore();
  doc.roundedRect(x, y, width, height, radius).strokeColor(strokeColor).stroke();
}

function drawTonePill(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  fillColor: string,
  textColor: string,
): void {
  drawPdfCard(doc, x, y, width, height, fillColor, fillColor, height / 2);
  doc.fontSize(8).fillColor(textColor);
  doc.text(text, x, y + 8, { width, align: 'center' });
}

function toneFill(tone: PdfInsight['tone']): string {
  switch (tone) {
    case 'good': return PDF_COLORS.greenSoft;
    case 'warn': return PDF_COLORS.amberSoft;
    case 'info': return PDF_COLORS.blueSoft;
    case 'accent': return PDF_COLORS.orangeSoft;
    default: return PDF_COLORS.paperMuted;
  }
}

function toneText(tone: PdfInsight['tone']): string {
  switch (tone) {
    case 'good': return PDF_COLORS.green;
    case 'warn': return PDF_COLORS.amber;
    case 'info': return PDF_COLORS.blue;
    case 'accent': return PDF_COLORS.orange;
    default: return PDF_COLORS.text;
  }
}

function statusTone(status: string): PdfInsight['tone'] {
  if (status === 'completed') return 'good';
  if (status === 'recording') return 'accent';
  if (status === 'paused') return 'warn';
  if (status === 'aborted') return 'warn';
  return 'muted';
}

function statusFill(status: string): string {
  if (status === 'completed') return PDF_COLORS.greenSoft;
  if (status === 'recording') return PDF_COLORS.orangeSoft;
  if (status === 'paused') return PDF_COLORS.amberSoft;
  if (status === 'aborted') return PDF_COLORS.redSoft;
  return PDF_COLORS.paperMuted;
}

function statusText(status: string): string {
  if (status === 'completed') return PDF_COLORS.green;
  if (status === 'recording') return PDF_COLORS.orange;
  if (status === 'paused') return PDF_COLORS.amber;
  if (status === 'aborted') return PDF_COLORS.red;
  return PDF_COLORS.text2;
}

function driftTone(score: number | null): PdfInsight['tone'] {
  if (score == null) return 'muted';
  if (score < 40) return 'warn';
  if (score < 70) return 'accent';
  return 'good';
}

function driftTextColor(score: number): string {
  if (score < 40) return PDF_COLORS.red;
  if (score < 70) return PDF_COLORS.amber;
  return PDF_COLORS.green;
}

function flagColor(flag: string): string {
  if (flag === 'critical') return PDF_COLORS.red;
  if (flag === 'warning') return PDF_COLORS.amber;
  return PDF_COLORS.green;
}

function formatCurrency(value: number, digits = 2): string {
  return `$${value.toFixed(digits)}`;
}

function formatPdfTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getPdfEventSummary(type: string, data: Record<string, unknown>, event: Record<string, unknown>): string {
  switch (type) {
    case 'command':
      return truncateMiddle(
        `${String(data.command || '')} ${((data.args as string[]) || []).join(' ')}`.trim(),
        120,
      );
    case 'file_write':
      return `Modified ${shortenPath(String(data.path || 'unknown file'), 84)}`;
    case 'file_delete':
      return `Deleted ${shortenPath(String(data.path || 'unknown file'), 84)}`;
    case 'file_read':
      return `Read ${shortenPath(String(data.path || 'unknown file'), 84)}`;
    case 'file_rename':
      return `Renamed ${shortenPath(String(data.from || ''), 42)} -> ${shortenPath(String(data.to || ''), 42)}`;
    case 'llm_call':
      return truncateMiddle(
        `${compactModelName(String(data.provider || 'llm'))}/${compactModelName(String(data.model || 'model'))} • ${formatNumber(Number(data.totalTokens || data.total_tokens || 0))} tokens`,
        120,
      );
    case 'git_commit':
      return truncateMiddle(`Commit ${String(data.commitHash || '').slice(0, 8)} ${String(data.message || '').trim()}`, 120);
    case 'git_checkout':
      return `Checkout ${String(data.branch || 'branch')}`;
    case 'git_push':
      return `Push ${String(data.branch || 'branch')}`;
    case 'git_pull':
      return 'Git pull';
    case 'git_merge':
      return `Merge ${String(data.targetBranch || 'branch')}`;
    case 'error':
      return truncateMiddle(String(data.message || 'Error'), 120);
    case 'guardrail_trigger':
    case 'guardrail_block':
      return truncateMiddle(`${data.ruleName ? `[${String(data.ruleName)}] ` : ''}${String(data.description || 'Guardrail intervention')}`, 120);
    default:
      return truncateMiddle(getEventSummary(type, data, event), 120);
  }
}

function compactModelName(name: string): string {
  return name
    .replace(/^anthropic\//, '')
    .replace(/^openai\//, '')
    .replace(/^google\//, '')
    .replace(/^meta\//, '');
}

function shortenPath(path: string, maxLength = 60): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= maxLength) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 3) {
    const tail = parts.slice(-3).join('/');
    if (`.../${tail}`.length <= maxLength) return `.../${tail}`;
  }
  return truncateMiddle(normalized, maxLength);
}

function truncateMiddle(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  const visible = maxLength - 3;
  const left = Math.ceil(visible / 2);
  const right = Math.floor(visible / 2);
  return `${value.slice(0, left)}...${value.slice(-right)}`;
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
