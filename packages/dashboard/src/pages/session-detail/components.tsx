import { useState, type ReactNode } from 'react';
import { api, type EventData } from '../../api';
import {
  EVENT_TYPE_CONFIG,
  computeSimpleDiff,
  formatBytes,
  getDriftColor,
  getEventInfo,
  parseDiffText,
  shortenPath,
  type DiffLine,
} from './utils';

export function MiniStat({
  label,
  value,
  meta,
  toneClass,
}: {
  label: string;
  value: string;
  meta?: string;
  toneClass?: string;
}) {
  return (
    <div className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/50 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">{label}</div>
      <div className={`mt-1 font-mono text-sm font-semibold ${toneClass || 'text-hawk-text'}`}>
        {value}
      </div>
      {meta && <div className="mt-1 text-[11px] text-hawk-text3">{meta}</div>}
    </div>
  );
}

export function MetaPill({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'accent' | 'live' | 'good' | 'danger';
}) {
  const toneClass =
    tone === 'accent' || tone === 'live'
      ? 'border-hawk-orange/25 bg-hawk-orange/10 text-hawk-orange'
      : tone === 'good'
        ? 'border-hawk-green/25 bg-hawk-green/10 text-hawk-green'
        : tone === 'danger'
          ? 'border-hawk-red/25 bg-hawk-red/10 text-hawk-red'
          : 'border-hawk-border-subtle bg-hawk-bg/55 text-hawk-text2';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${toneClass}`}>
      {children}
    </span>
  );
}

export function EventBadge({ type }: { type: string }) {
  const config = EVENT_TYPE_CONFIG[type] || { label: type.toUpperCase(), bg: 'bg-hawk-surface3', text: 'text-hawk-text3' };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
}

function DriftBar({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-hawk-green' : score >= 40 ? 'bg-hawk-amber' : 'bg-hawk-red';
  return (
    <div className="flex w-24 shrink-0 items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hawk-surface3">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className={`w-6 text-right font-mono text-[10px] ${getDriftColor(score)}`}>{score}</span>
    </div>
  );
}

export function EventRow({
  event,
  expanded,
  onToggle,
}: {
  event: EventData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const eventTime = new Date(event.timestamp);
  const timeStr = eventTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(event.data);
  } catch {}

  const { summary, detail } = getEventInfo(event.type, parsed, event);
  const hasDiff = (event.type === 'file_write' || event.type === 'guardrail_trigger')
    && (parsed.contentBefore != null || parsed.contentAfter != null || parsed.diff != null);
  const isGuardrail = event.type === 'guardrail_trigger' || event.type === 'guardrail_block';
  const canRevert = event.type === 'file_write' && parsed.path != null;

  const driftFlag = event.drift_flag;
  const rowBg =
    driftFlag === 'critical' ? 'bg-hawk-red/5' :
    driftFlag === 'warning' ? 'bg-hawk-amber/5' : '';

  return (
    <div className={`${rowBg} transition-colors hover:bg-hawk-surface2/50`}>
      <div className="flex cursor-pointer items-center gap-3 px-4 py-2.5" onClick={onToggle}>
        <span className="hidden shrink-0 font-mono text-[10px] text-hawk-text3 sm:block sm:w-16 sm:text-xs">{timeStr}</span>
        <EventBadge type={event.type} />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-hawk-text">{summary}</span>
        {event.cost_usd > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-hawk-amber">${event.cost_usd.toFixed(4)}</span>
        )}
        {event.drift_score != null && <DriftBar score={event.drift_score} />}
        <span className="text-xs text-hawk-text3">{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded && (
        <div className="ml-4 px-4 pb-3 sm:ml-[5.5rem]">
          {isGuardrail && <GuardrailDetail parsed={parsed} />}
          {hasDiff ? (
            <FileDiffSideBySide
              before={parsed.contentBefore as string | undefined}
              after={parsed.contentAfter as string | undefined}
              diffText={parsed.diff as string | undefined}
              path={String(parsed.path || '')}
              eventId={event.id}
              canRevert={canRevert}
            />
          ) : detail ? (
            <div className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-hawk-border/50 bg-hawk-surface3/50 px-3 py-2 font-mono text-xs text-hawk-text2">
              {detail}
            </div>
          ) : !isGuardrail ? (
            <div className="rounded border border-hawk-border/50 bg-hawk-surface3/50 px-3 py-2 font-mono text-xs text-hawk-text3">
              No additional details
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function CostBreakdown({ events }: { events: EventData[] }) {
  const llmEvents = events.filter((e) => e.type === 'llm_call' && e.cost_usd > 0);
  if (llmEvents.length === 0) {
    return (
      <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
        <h3 className="mb-3 font-display text-sm font-semibold text-hawk-text">Cost Breakdown</h3>
        <p className="font-mono text-xs text-hawk-text3">No LLM costs recorded</p>
      </div>
    );
  }

  const byModel: Record<string, { cost: number; tokens: number; calls: number }> = {};
  llmEvents.forEach((e) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(e.data);
    } catch {}
    const key = `${data.provider || 'unknown'}/${data.model || 'unknown'}`;
    if (!byModel[key]) byModel[key] = { cost: 0, tokens: 0, calls: 0 };
    byModel[key].cost += e.cost_usd;
    byModel[key].tokens += Number(data.totalTokens) || 0;
    byModel[key].calls += 1;
  });

  const totalCost = Object.values(byModel).reduce((s, v) => s + v.cost, 0);
  const colors = ['#a78bfa', '#ff5f1f', '#22c55e', '#3B82F6', '#f0a830', '#06b6d4'];

  return (
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <h3 className="mb-3 font-display text-sm font-semibold text-hawk-text">Cost Breakdown</h3>

      <div className="mb-4 flex h-3 overflow-hidden rounded-full bg-hawk-surface3">
        {Object.entries(byModel).map(([model, data], i) => (
          <div
            key={model}
            className="h-full transition-all"
            style={{ width: `${(data.cost / totalCost) * 100}%`, backgroundColor: colors[i % colors.length] }}
            title={`${model}: $${data.cost.toFixed(4)}`}
          />
        ))}
      </div>

      <div className="space-y-2">
        {Object.entries(byModel).map(([model, data], i) => (
          <div key={model} className="flex items-center gap-2 font-mono text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colors[i % colors.length] }} />
            <span className="flex-1 truncate text-hawk-text">{model}</span>
            <span className="text-hawk-text3">{data.calls} calls</span>
            <span className="text-hawk-text3">{data.tokens.toLocaleString()} tok</span>
            <span className="font-semibold text-hawk-amber">${data.cost.toFixed(4)}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-hawk-border/50 pt-2 font-mono text-xs">
          <span className="flex-1 font-semibold text-hawk-text">Total</span>
          <span className="font-semibold text-hawk-amber">${totalCost.toFixed(4)}</span>
        </div>
      </div>
    </div>
  );
}

export function FilesChanged({
  events,
  onToggle,
}: {
  events: EventData[];
  onToggle: (id: string) => void;
}) {
  const fileEvents = events.filter((e) => e.type === 'file_write' || e.type === 'file_delete');
  if (fileEvents.length === 0) {
    return (
      <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
        <h3 className="mb-3 font-display text-sm font-semibold text-hawk-text">Files Changed</h3>
        <p className="font-mono text-xs text-hawk-text3">No file changes recorded</p>
      </div>
    );
  }

  const fileMap: Record<string, { event: EventData; data: Record<string, unknown> }> = {};
  fileEvents.forEach((e) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(e.data);
    } catch {}
    const path = String(data.path || '');
    if (path) fileMap[path] = { event: e, data };
  });

  return (
    <div className="rounded-[18px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
      <h3 className="mb-3 font-display text-sm font-semibold text-hawk-text">
        Files Changed <span className="font-normal text-hawk-text3">({Object.keys(fileMap).length})</span>
      </h3>
      <div className="max-h-60 space-y-1 overflow-auto">
        {Object.entries(fileMap).map(([path, { event, data }]) => {
          const isDelete = event.type === 'file_delete';
          return (
            <button
              key={path}
              onClick={() => onToggle(event.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-hawk-surface2"
            >
              <span className={`shrink-0 ${isDelete ? 'text-hawk-red' : 'text-hawk-green'}`}>
                {isDelete ? '−' : '+'}
              </span>
              <span className="flex-1 truncate text-hawk-text">{shortenPath(path)}</span>
              {typeof data.sizeAfter === 'number' && (
                <span className="shrink-0 text-hawk-text3">{formatBytes(data.sizeAfter)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GuardrailDetail({ parsed }: { parsed: Record<string, unknown> }) {
  const ruleName = String(parsed.ruleName || 'unknown');
  const severity = String(parsed.severity || parsed.actionTaken || 'block');
  const description = String(parsed.description || 'Guardrail triggered');
  const blockedAction = String(parsed.blockedAction || parsed.originalType || '');
  const filePath = parsed.path ? String(parsed.path) : null;

  return (
    <div className="mb-2 rounded border border-hawk-red/30 bg-hawk-red/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-bold text-hawk-red">⛔</span>
        <span className="font-mono text-xs font-bold uppercase text-hawk-red">
          {severity === 'block' ? 'BLOCKED' : 'WARNING'}
        </span>
        <span className="rounded bg-hawk-red/10 px-1.5 py-0.5 font-mono text-[10px] text-hawk-red">{ruleName}</span>
      </div>
      <p className="mb-1 font-mono text-xs text-hawk-text2">{description}</p>
      {blockedAction && (
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-[10px] text-hawk-text3">Original action:</span>
          <span className="font-mono text-[10px] text-hawk-amber">{blockedAction}</span>
        </div>
      )}
      {filePath && (
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[10px] text-hawk-text3">File:</span>
          <span className="font-mono text-[10px] text-hawk-text2">{shortenPath(filePath)}</span>
        </div>
      )}
    </div>
  );
}

function FileDiffSideBySide({
  before,
  after,
  diffText,
  path,
  eventId,
  canRevert,
}: {
  before?: string;
  after?: string;
  diffText?: string;
  path: string;
  eventId: string;
  canRevert: boolean;
}) {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [revertStatus, setRevertStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [revertMsg, setRevertMsg] = useState('');

  const hasSideBySide = before != null || after != null;
  const beforeLines = (before || '').split('\n');
  const afterLines = (after || '').split('\n');
  const diff = hasSideBySide ? computeSimpleDiff(beforeLines, afterLines) : parseDiffText(diffText || '');
  const added = diff.filter((d) => d.type === 'add').length;
  const removed = diff.filter((d) => d.type === 'remove').length;

  const handleRevert = async () => {
    setRevertStatus('loading');
    try {
      const result = await api.revertFile(eventId);
      if (result.ok) {
        setRevertStatus('done');
        setRevertMsg(`Reverted ${shortenPath(path)}`);
      } else {
        setRevertStatus('error');
        setRevertMsg(result.error || 'Revert failed');
      }
    } catch (err) {
      setRevertStatus('error');
      const msg = String(err);
      if (msg.includes('404') || msg.includes('Failed to fetch')) {
        setRevertMsg('Server not running — start hawkeye serve first');
      } else {
        setRevertMsg(msg);
      }
    }
  };

  return (
    <div className="overflow-hidden rounded border border-hawk-border/50">
      <div className="flex items-center justify-between border-b border-hawk-border/50 bg-hawk-surface3/80 px-3 py-1.5">
        <span className="font-mono text-[10px] text-hawk-text2">{shortenPath(path)}</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-mono text-[10px]">
            {added > 0 && <span className="text-hawk-green">+{added}</span>}
            {removed > 0 && <span className="text-hawk-red">-{removed}</span>}
          </div>
          {hasSideBySide && (
            <div className="flex overflow-hidden rounded border border-hawk-border/50">
              <button
                onClick={() => setViewMode('split')}
                className={`px-2 py-0.5 font-mono text-[9px] transition-colors ${viewMode === 'split' ? 'bg-hawk-orange/20 text-hawk-orange' : 'text-hawk-text3 hover:text-hawk-text2'}`}
              >
                Split
              </button>
              <button
                onClick={() => setViewMode('unified')}
                className={`px-2 py-0.5 font-mono text-[9px] transition-colors ${viewMode === 'unified' ? 'bg-hawk-orange/20 text-hawk-orange' : 'text-hawk-text3 hover:text-hawk-text2'}`}
              >
                Unified
              </button>
            </div>
          )}
          {canRevert && revertStatus === 'idle' && (
            <button
              onClick={handleRevert}
              className="flex items-center gap-1 rounded border border-hawk-amber/30 px-2 py-0.5 font-mono text-[9px] text-hawk-amber transition-colors hover:bg-hawk-amber/10"
            >
              ↩ Revert
            </button>
          )}
          {revertStatus === 'loading' && <span className="font-mono text-[9px] text-hawk-text3">Reverting...</span>}
          {revertStatus === 'done' && <span className="font-mono text-[9px] text-hawk-green">✓ {revertMsg}</span>}
          {revertStatus === 'error' && <span className="font-mono text-[9px] text-hawk-red">✗ {revertMsg}</span>}
        </div>
      </div>

      {viewMode === 'unified' || !hasSideBySide ? (
        <UnifiedDiffView diff={diff} />
      ) : (
        <SplitDiffView beforeLines={beforeLines} afterLines={afterLines} />
      )}
    </div>
  );
}

function UnifiedDiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="max-h-96 overflow-auto">
      {diff.slice(0, 300).map((line, i) => (
        <div
          key={i}
          className={`flex font-mono text-[11px] leading-5 ${
            line.type === 'add' ? 'bg-hawk-green/8 text-hawk-green' :
            line.type === 'remove' ? 'bg-hawk-red/8 text-hawk-red' :
            'text-hawk-text3'
          }`}
        >
          <span className="w-8 shrink-0 select-none pr-2 text-right opacity-40">
            {line.lineNum || ''}
          </span>
          <span className="w-4 shrink-0 select-none text-center opacity-60">
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
          </span>
          <span className="flex-1 break-all whitespace-pre-wrap pr-2">{line.content}</span>
        </div>
      ))}
      {diff.length > 300 && (
        <div className="bg-hawk-surface3/50 px-3 py-1 font-mono text-[10px] text-hawk-text3">
          ... {diff.length - 300} more lines
        </div>
      )}
    </div>
  );
}

function SplitDiffView({ beforeLines, afterLines }: { beforeLines: string[]; afterLines: string[] }) {
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  const limit = Math.min(maxLines, 300);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  return (
    <div className="max-h-96 overflow-auto">
      <div className="flex">
        <div className="min-w-0 flex-1 border-r border-hawk-border/30">
          <div className="border-b border-hawk-border/30 bg-hawk-red/5 px-2 py-1 font-mono text-[9px] font-bold text-hawk-text3">
            Before
          </div>
          {beforeLines.slice(0, limit).map((line, i) => {
            const isRemoved = !afterSet.has(line);
            return (
              <div key={i} className={`flex font-mono text-[11px] leading-5 ${isRemoved ? 'bg-hawk-red/8' : ''}`}>
                <span className="w-8 shrink-0 select-none pr-2 text-right text-hawk-text3 opacity-40">
                  {i + 1}
                </span>
                <span className={`flex-1 break-all whitespace-pre-wrap pr-2 ${isRemoved ? 'text-hawk-red' : 'text-hawk-text3'}`}>
                  {line}
                </span>
              </div>
            );
          })}
        </div>
        <div className="min-w-0 flex-1">
          <div className="border-b border-hawk-border/30 bg-hawk-green/5 px-2 py-1 font-mono text-[9px] font-bold text-hawk-text3">
            After
          </div>
          {afterLines.slice(0, limit).map((line, i) => {
            const isAdded = !beforeSet.has(line);
            return (
              <div key={i} className={`flex font-mono text-[11px] leading-5 ${isAdded ? 'bg-hawk-green/8' : ''}`}>
                <span className="w-8 shrink-0 select-none pr-2 text-right text-hawk-text3 opacity-40">
                  {i + 1}
                </span>
                <span className={`flex-1 break-all whitespace-pre-wrap pr-2 ${isAdded ? 'text-hawk-green' : 'text-hawk-text3'}`}>
                  {line}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {maxLines > limit && (
        <div className="bg-hawk-surface3/50 px-3 py-1 font-mono text-[10px] text-hawk-text3">
          ... {maxLines - limit} more lines
        </div>
      )}
    </div>
  );
}
