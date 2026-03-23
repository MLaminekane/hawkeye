import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { EventData } from '../api';

// ─── Color mapping by event type ───

function getEventColor(type: string): string {
  if (type === 'command' || type === 'terminal') return '#3b82f6';
  if (type === 'file_write' || type === 'file_read' || type === 'file_delete') return '#22c55e';
  if (type === 'llm_call') return '#a855f7';
  if (type === 'guardrail_block' || type === 'guardrail_trigger') return '#ef4444';
  if (type.startsWith('git_')) return '#f59e0b';
  if (type === 'error') return '#ef4444';
  if (type === 'network' || type === 'api_call') return '#06b6d4';
  return '#6b7280';
}

function getDriftColor(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#f0a830';
  return '#ef4444';
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

function getEventSummary(event: EventData): string {
  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (data.command) return String(data.command).slice(0, 60);
    if (data.path) return String(data.path).split('/').pop() || String(data.path);
    if (data.file_path) return String(data.file_path).split('/').pop() || String(data.file_path);
    if (data.model) return String(data.model);
    if (data.message) return String(data.message).slice(0, 60);
    if (data.summary) return String(data.summary).slice(0, 60);
  } catch {
    // data might not be valid JSON
  }
  return event.type;
}

// ─── Constants ───

const DOT_SPACING = 8;
const DOT_RADIUS = 4;
const SVG_HEIGHT = 56;
const PADDING_X = 16;
const DOT_Y = 22;
const BREAKPOINT_Y = 38;
const DRIFT_Y = 10;
const OVERFLOW_THRESHOLD = 200;

// ─── Props ───

interface TimelineBarProps {
  events: EventData[];
  currentIndex: number;
  breakpoints: Set<number>;
  onSeek: (index: number) => void;
  onToggleBreakpoint: (index: number) => void;
  onReplayFromHere: (index: number) => void;
  onForkFromHere: (index: number) => void;
}

// ─── Context menu state ───

interface ContextMenuState {
  x: number;
  y: number;
  eventIndex: number;
}

export function TimelineBar({
  events,
  currentIndex,
  breakpoints,
  onSeek,
  onToggleBreakpoint,
  onReplayFromHere,
  onForkFromHere,
}: TimelineBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const totalEvents = events.length;
  const useScroll = totalEvents > OVERFLOW_THRESHOLD;

  // When scrolling: fixed spacing. When fitting: distribute across measured container width.
  const scrollWidth = PADDING_X * 2 + Math.max(totalEvents - 1, 0) * DOT_SPACING;
  const svgWidth = useScroll ? scrollWidth : containerWidth;

  // Measure container width via ResizeObserver for the non-scroll mode
  useEffect(() => {
    const el = containerRef.current;
    if (!el || useScroll) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [useScroll]);

  // Close context menu on Escape or click-outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const handleClick = () => setContextMenu(null);
    document.addEventListener('keydown', handleKey);
    document.addEventListener('click', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('click', handleClick);
    };
  }, [contextMenu]);

  // Get X position for an event index (always returns pixel value)
  const getX = useCallback(
    (index: number): number => {
      if (totalEvents <= 1) return svgWidth / 2;
      if (useScroll) {
        return PADDING_X + index * DOT_SPACING;
      }
      const usable = svgWidth - PADDING_X * 2;
      return PADDING_X + (index / (totalEvents - 1)) * usable;
    },
    [totalEvents, svgWidth, useScroll],
  );

  // Build drift overlay line segments
  const driftSegments = useMemo(() => {
    const segments: Array<{ x1: number; x2: number; color: string }> = [];
    let prevIdx: number | null = null;

    for (let i = 0; i < events.length; i++) {
      const score = events[i].drift_score;
      if (score != null) {
        if (prevIdx != null) {
          segments.push({
            x1: getX(prevIdx),
            x2: getX(i),
            color: getDriftColor(score),
          });
        }
        prevIdx = i;
      }
    }
    return segments;
  }, [events, getX]);

  // Auto-scroll to keep current position visible
  useEffect(() => {
    if (!useScroll || !scrollRef.current) return;
    const cx = getX(Math.min(currentIndex, totalEvents - 1));
    const el = scrollRef.current;
    const visible = el.clientWidth;
    const scrollLeft = el.scrollLeft;
    if (cx < scrollLeft + 40 || cx > scrollLeft + visible - 40) {
      el.scrollTo({ left: cx - visible / 2, behavior: 'smooth' });
    }
  }, [currentIndex, getX, totalEvents, useScroll]);

  // ─── Event handlers ───

  const handleDotClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.stopPropagation();
      onSeek(index);
    },
    [onSeek],
  );

  const handleContextMenu = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setContextMenu({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        eventIndex: index,
      });
    },
    [],
  );

  const handleDotEnter = useCallback(
    (index: number, e: React.MouseEvent) => {
      setHoveredIndex(index);
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setTooltipPos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    [],
  );

  const handleDotLeave = useCallback(() => {
    setHoveredIndex(null);
    setTooltipPos(null);
  }, []);

  // ─── Render ───

  if (totalEvents === 0) {
    return (
      <div className="w-full h-14 flex items-center justify-center text-hawk-text3 text-xs font-mono">
        No events
      </div>
    );
  }

  const currentX = getX(Math.min(currentIndex, totalEvents - 1));

  return (
    <div ref={containerRef} className="relative w-full select-none">
      {/* Scrollable wrapper */}
      <div
        ref={scrollRef}
        className={useScroll ? 'overflow-x-auto scrollbar-hide' : ''}
        style={{ width: '100%' }}
      >
        <svg
          width={svgWidth}
          height={SVG_HEIGHT}
          viewBox={`0 0 ${svgWidth} ${SVG_HEIGHT}`}
          className="block"
          style={{ minWidth: useScroll ? svgWidth : undefined }}
        >
          {/* Background track line */}
          <line
            x1={PADDING_X}
            y1={DOT_Y}
            x2={svgWidth - PADDING_X}
            y2={DOT_Y}
            stroke="#242430"
            strokeWidth={1}
          />

          {/* Drift overlay lines */}
          {driftSegments.map((seg, i) => (
            <line
              key={`drift-${i}`}
              x1={seg.x1}
              y1={DRIFT_Y}
              x2={seg.x2}
              y2={DRIFT_Y}
              stroke={seg.color}
              strokeWidth={1.5}
              strokeOpacity={0.6}
            />
          ))}

          {/* Event dots */}
          {events.map((event, i) => {
            const x = getX(i);
            const isHovered = hoveredIndex === i;
            const isCurrent = i === currentIndex;
            const isPast = i <= currentIndex;

            return (
              <g key={event.id || `evt-${i}`}>
                {/* Hit area — larger invisible circle for easier clicking */}
                <circle
                  cx={x}
                  cy={DOT_Y}
                  r={DOT_RADIUS + 4}
                  fill="transparent"
                  cursor="pointer"
                  onClick={(e) => handleDotClick(i, e)}
                  onContextMenu={(e) => handleContextMenu(i, e)}
                  onMouseEnter={(e) => handleDotEnter(i, e)}
                  onMouseLeave={handleDotLeave}
                />
                {/* Visible dot */}
                <circle
                  cx={x}
                  cy={DOT_Y}
                  r={isHovered || isCurrent ? DOT_RADIUS + 1.5 : DOT_RADIUS}
                  fill={getEventColor(event.type)}
                  opacity={isPast ? 1 : 0.25}
                  style={{ transition: 'r 0.1s ease, opacity 0.15s ease' }}
                />
              </g>
            );
          })}

          {/* Breakpoint diamonds */}
          {Array.from(breakpoints).map((bpIdx) => {
            if (bpIdx < 0 || bpIdx >= totalEvents) return null;
            const x = getX(bpIdx);
            const d = 4; // half-size of diamond
            return (
              <polygon
                key={`bp-${bpIdx}`}
                points={`${x},${BREAKPOINT_Y - d} ${x + d},${BREAKPOINT_Y} ${x},${BREAKPOINT_Y + d} ${x - d},${BREAKPOINT_Y}`}
                fill="#ef4444"
                opacity={0.9}
              />
            );
          })}

          {/* Current position: orange vertical line + triangle marker */}
          <line
            x1={currentX}
            y1={6}
            x2={currentX}
            y2={SVG_HEIGHT - 6}
            stroke="#ff5f1f"
            strokeWidth={2}
            opacity={0.85}
          />
          <polygon
            points={`${currentX - 5},0 ${currentX + 5},0 ${currentX},7`}
            fill="#ff5f1f"
          />
        </svg>
      </div>

      {/* Tooltip */}
      {hoveredIndex != null && tooltipPos && events[hoveredIndex] && (
        <div
          className="absolute z-50 pointer-events-none px-2.5 py-1.5 rounded border border-hawk-border bg-hawk-surface2 shadow-lg font-mono text-[11px] leading-tight"
          style={{
            left: Math.max(4, Math.min(tooltipPos.x - 8, (containerRef.current?.clientWidth ?? 300) - 230)),
            top: tooltipPos.y - 64,
            maxWidth: 220,
          }}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: getEventColor(events[hoveredIndex].type) }}
            />
            <span className="text-hawk-text font-semibold uppercase tracking-wide text-[10px]">
              {events[hoveredIndex].type.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="text-hawk-text3 truncate">{getEventSummary(events[hoveredIndex])}</div>
          <div className="text-hawk-text3 mt-0.5">{formatTimestamp(events[hoveredIndex].timestamp)}</div>
          {events[hoveredIndex].drift_score != null && (
            <div className="mt-0.5">
              <span className="text-hawk-text3">Drift: </span>
              <span style={{ color: getDriftColor(events[hoveredIndex].drift_score!) }}>
                {events[hoveredIndex].drift_score}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="absolute z-[60] rounded border border-hawk-border bg-hawk-surface2 shadow-xl py-1 min-w-[180px] font-mono text-xs"
          style={{
            left: Math.max(0, Math.min(contextMenu.x, (containerRef.current?.clientWidth ?? 300) - 190)),
            top: Math.max(0, contextMenu.y),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-hawk-text hover:bg-hawk-surface3 transition-colors"
            onClick={() => {
              onToggleBreakpoint(contextMenu.eventIndex);
              setContextMenu(null);
            }}
          >
            {breakpoints.has(contextMenu.eventIndex) ? 'Remove breakpoint' : 'Toggle breakpoint'}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-hawk-text hover:bg-hawk-surface3 transition-colors"
            onClick={() => {
              onReplayFromHere(contextMenu.eventIndex);
              setContextMenu(null);
            }}
          >
            Replay from here
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-hawk-text hover:bg-hawk-surface3 transition-colors"
            onClick={() => {
              onForkFromHere(contextMenu.eventIndex);
              setContextMenu(null);
            }}
          >
            Fork from here
          </button>
          <div className="border-t border-hawk-border my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-hawk-text3 hover:bg-hawk-surface3 transition-colors"
            onClick={() => {
              onSeek(contextMenu.eventIndex);
              setContextMenu(null);
            }}
          >
            Jump to event #{contextMenu.eventIndex + 1}
          </button>
        </div>
      )}

      {/* Event position counter */}
      <div className="absolute bottom-0 right-1 text-[10px] text-hawk-text3 font-mono tabular-nums">
        {Math.min(currentIndex + 1, totalEvents)} / {totalEvents}
      </div>
    </div>
  );
}
