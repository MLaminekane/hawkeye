import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from 'recharts';
import { api, hawkeyeWs, type SessionData, type EventData, type DriftSnapshot, type RcaResult } from '../../api';
import { TimelineBar } from '../../components/TimelineBar';
import { CostBreakdown, EventBadge, EventRow, FilesChanged, MetaPill, MiniStat } from './components';
import {
  formatFullTimestamp,
  formatRelativeTimestamp,
  getDriftColor,
  getDriftLabel,
  getDuration,
  truncateMiddle,
} from './utils';

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionData | null>(null);
  const [events, setEvents] = useState<EventData[]>([]);
  const [driftSnapshots, setDriftSnapshots] = useState<DriftSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [replayMode, setReplayMode] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [breakpoints, setBreakpoints] = useState<Set<number>>(new Set());
  const [forkLoading, setForkLoading] = useState(false);
  const [rcaResult, setRcaResult] = useState<RcaResult | null>(null);
  const [rcaLoading, setRcaLoading] = useState(false);
  const [incidentLoading, setIncidentLoading] = useState(false);
  const [ciReport, setCiReport] = useState<{ markdown: string; risk: string; passed: boolean; flags: string[] } | null>(null);
  const [ciReportLoading, setCiReportLoading] = useState(false);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    // Initial fetch
    Promise.all([
      api.getSession(id),
      api.getEvents(id),
      api.getDriftSnapshots(id),
    ]).then(([s, e, d]) => {
      setSession(s);
      setEvents(e);
      setDriftSnapshots(d);
      setLoading(false);
    }).catch(() => setLoading(false));

    // Real-time via WebSocket
    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'event' && msg.sessionId === id) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === msg.event.id)) return prev;
          return [...prev, msg.event];
        });
      }
      if (msg.type === 'drift_update' && msg.sessionId === id) {
        setDriftSnapshots((prev) => [
          ...prev,
          { id: `ws-${Date.now()}`, score: msg.score, flag: msg.flag, reason: msg.reason, created_at: new Date().toISOString() },
        ]);
      }
    });

    return () => { unsub(); };
  }, [id]);

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  // Replay: auto-advance when playing (breakpoint-aware)
  useEffect(() => {
    if (!isPlaying || !replayMode || events.length === 0) return;
    if (replayIndex >= events.length) {
      setIsPlaying(false);
      return;
    }

    // Pause at breakpoints
    if (breakpoints.has(replayIndex) && replayIndex > 0) {
      setIsPlaying(false);
      return;
    }

    // Compute delay from actual event timestamps for realistic pacing
    let delayMs = 500;
    if (replayIndex + 1 < events.length) {
      const curr = new Date(events[replayIndex].timestamp).getTime();
      const next = new Date(events[replayIndex + 1].timestamp).getTime();
      delayMs = Math.min(Math.max((next - curr) / playbackSpeed, 100), 2000);
    }

    playTimerRef.current = setTimeout(() => {
      setReplayIndex((i) => Math.min(i + 1, events.length));
    }, delayMs);

    return () => {
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
    };
  }, [isPlaying, replayIndex, replayMode, events, playbackSpeed, breakpoints]);

  // Auto-expand current event during step-through
  useEffect(() => {
    if (replayMode && replayIndex > 0 && replayIndex <= events.length) {
      const currentEvent = events[replayIndex - 1];
      if (currentEvent) setExpandedEvent(currentEvent.id);
    }
  }, [replayMode, replayIndex, events]);

  // Keyboard shortcuts for replay
  useEffect(() => {
    if (!replayMode) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          setIsPlaying(false);
          setReplayIndex((i) => Math.min(i + 1, events.length));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setIsPlaying(false);
          setReplayIndex((i) => Math.max(i - 1, 0));
          break;
        case ' ':
          e.preventDefault();
          setIsPlaying((p) => !p);
          break;
        case 'b':
        case 'B':
          // Toggle breakpoint at current position
          if (replayIndex > 0 && replayIndex <= events.length) {
            setBreakpoints((prev) => {
              const next = new Set(prev);
              if (next.has(replayIndex - 1)) next.delete(replayIndex - 1);
              else next.add(replayIndex - 1);
              return next;
            });
          }
          break;
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [replayMode, events.length, replayIndex]);

  const toggleReplay = useCallback(() => {
    if (replayMode) {
      setReplayMode(false);
      setIsPlaying(false);
      setReplayIndex(0);
    } else {
      setReplayMode(true);
      setReplayIndex(0);
      setIsPlaying(false);
    }
  }, [replayMode]);

  // Toggle breakpoint
  const handleToggleBreakpoint = useCallback((index: number) => {
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Replay from a specific event
  const handleReplayFromHere = useCallback((index: number) => {
    setReplayMode(true);
    setReplayIndex(index + 1);
    setIsPlaying(true);
  }, []);

  // Fork session from a specific event (uses event.sequence for precision)
  const handleForkFromHere = useCallback(async (index: number) => {
    if (!session || forkLoading || !events[index]) return;
    setForkLoading(true);
    try {
      const result = await api.forkSession(session.id, events[index].sequence);
      if (result.ok && result.forkedSessionId) {
        navigate(`/session/${result.forkedSessionId}`);
      }
    } catch {
      // silent
    } finally {
      setForkLoading(false);
    }
  }, [session, forkLoading, navigate, events]);

  const handleAnalyze = useCallback(async () => {
    if (!session || rcaLoading) return;
    setRcaLoading(true);
    try {
      const result = await api.analyzeSession(session.id);
      setRcaResult(result);
    } catch {
      // silent
    } finally {
      setRcaLoading(false);
    }
  }, [session, rcaLoading]);

  const handleCIReport = useCallback(async () => {
    if (!session || ciReportLoading) return;
    setCiReportLoading(true);
    try {
      const result = await api.getCIReport(session.id);
      setCiReport(result);
    } catch {
      // silent
    } finally {
      setCiReportLoading(false);
    }
  }, [session, ciReportLoading]);

  // Events visible in replay mode (up to replayIndex)
  const visibleEvents = useMemo(() => {
    if (!replayMode) return events;
    return events.slice(0, replayIndex);
  }, [events, replayMode, replayIndex]);

  // Filtered events
  const filteredEvents = useMemo(() => {
    let result = visibleEvents;
    if (typeFilter) {
      result = result.filter((e) => e.type === typeFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((e) => {
        const data = e.data.toLowerCase();
        return data.includes(q) || e.type.includes(q);
      });
    }
    return result;
  }, [visibleEvents, typeFilter, search]);

  if (loading) return <div className="text-hawk-text3 font-mono text-sm p-8">Loading...</div>;
  if (!session) return <div className="text-hawk-red font-mono text-sm p-8">Session not found</div>;

  const duration = getDuration(session.started_at, session.ended_at);
  const isRecording = session.status === 'recording';

  // Compute event type counts (from visible events in replay mode)
  const typeCounts: Record<string, number> = {};
  visibleEvents.forEach((e) => { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });

  // Compute total cost from visible events
  const totalCost = visibleEvents.reduce((sum, e) => sum + (e.cost_usd || 0), 0);

  // Find critical drift alerts
  const criticalDrifts = driftSnapshots.filter((d) => d.flag === 'critical');
  const llmCallCount = typeCounts['llm_call'] || 0;
  const fileChangeCount = (typeCounts['file_write'] || 0) + (typeCounts['file_delete'] || 0);
  const blockedCount = (typeCounts['guardrail_trigger'] || 0) + (typeCounts['guardrail_block'] || 0);
  const liveDriftScore = driftSnapshots.length > 0
    ? driftSnapshots[driftSnapshots.length - 1].score
    : session.final_drift_score;
  const latestEventTime = visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1].timestamp : null;

  // Export as JSON
  const handleExportJSON = () => {
    const data = {
      session,
      events: events.map((e) => { try { return { ...e, data: JSON.parse(e.data) }; } catch { return { ...e, data: {} }; } }),
      driftSnapshots,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hawkeye-${session.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setFeedback({ tone: 'success', message: 'JSON exported' });
  };

  // Export as PDF (server-side generation)
  const handleExportPDF = async () => {
    setPdfLoading(true);
    try {
      const res = await fetch(`/api/sessions/${session.id}/export-pdf`);
      if (!res.ok) throw new Error('PDF export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hawkeye-${session.id.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setFeedback({ tone: 'success', message: 'PDF exported' });
    } catch {
      setFeedback({ tone: 'error', message: 'PDF export failed' });
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/" className="inline-flex items-center gap-1 font-mono text-xs text-hawk-text3 hover:text-hawk-orange transition-colors">
          ← Sessions
        </Link>
        <span className="rounded-full border border-hawk-border-subtle bg-hawk-surface/60 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
          {session.id.slice(0, 8)}
        </span>
      </div>

      <section className="relative overflow-hidden rounded-[22px] border border-hawk-border-subtle bg-hawk-surface/72 p-3.5 shadow-[0_28px_80px_-45px_rgba(0,0,0,0.95)] sm:p-4">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-12 top-0 h-52 w-52 rounded-full bg-hawk-orange/10 blur-3xl" />
          <div className="absolute right-[-40px] top-8 h-56 w-56 rounded-full bg-cyan-400/8 blur-3xl" />
          <div className="absolute bottom-[-70px] left-1/3 h-56 w-56 rounded-full bg-emerald-400/8 blur-3xl" />
        </div>

        <div className="relative grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-hawk-text3">
              <span className={`inline-block h-2 w-2 rounded-full ${isRecording ? 'bg-hawk-orange' : session.status === 'completed' ? 'bg-hawk-green' : 'bg-hawk-red'}`} />
              Session Detail
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <MetaPill
                tone={isRecording ? 'live' : session.status === 'completed' ? 'good' : 'danger'}
              >
                {isRecording ? 'Recording' : session.status === 'completed' ? 'Completed' : 'Aborted'}
              </MetaPill>
              <MetaPill>{session.agent || 'unknown agent'}</MetaPill>
              {session.developer && <MetaPill tone="accent">{session.developer}</MetaPill>}
              {session.model && <MetaPill>{session.model}</MetaPill>}
              {session.git_branch && <MetaPill>{session.git_branch}</MetaPill>}
            </div>

            <div className="max-w-3xl">
              <h1 className="font-display text-xl font-semibold tracking-tight text-hawk-text sm:text-2xl">
                {session.objective}
              </h1>
              <p className="mt-2 text-sm leading-6 text-hawk-text2">
                {isRecording
                  ? `Live session started ${formatRelativeTimestamp(session.started_at)} and still collecting events.`
                  : `Session ${session.status} after ${duration}. Started ${formatRelativeTimestamp(session.started_at)}.`}
                {latestEventTime ? ` Last event arrived ${formatRelativeTimestamp(latestEventTime)}.` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-hawk-text2">
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1">
                {truncateMiddle(session.working_dir, 34)}
              </span>
              <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1">
                Started {formatFullTimestamp(session.started_at)}
              </span>
              {session.ended_at && (
                <span className="rounded-full border border-hawk-border-subtle bg-hawk-bg/55 px-2.5 py-1">
                  Ended {formatFullTimestamp(session.ended_at)}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
              <button
                onClick={handleExportPDF}
                disabled={pdfLoading}
                className="rounded-[16px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] text-hawk-orange hover:bg-hawk-orange/20 transition-colors disabled:opacity-50"
              >
                {pdfLoading ? 'Generating...' : 'Export PDF'}
              </button>
              <button
                onClick={handleExportJSON}
                className="rounded-[16px] border border-hawk-border-subtle bg-hawk-bg/55 px-3 py-1.5 font-mono text-[10px] text-hawk-text3 hover:text-hawk-orange hover:border-hawk-orange/30 transition-colors"
              >
                Export JSON
              </button>
              <button
                onClick={handleAnalyze}
                disabled={rcaLoading}
                className="rounded-[16px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] text-hawk-orange hover:bg-hawk-orange/20 transition-colors disabled:opacity-50"
              >
                {rcaLoading ? 'Analyzing...' : 'Analyze'}
              </button>
              <button
                onClick={handleCIReport}
                disabled={ciReportLoading}
                className="rounded-[16px] border border-hawk-orange/30 bg-hawk-orange/10 px-3 py-1.5 font-mono text-[10px] text-hawk-orange hover:bg-hawk-orange/20 transition-colors disabled:opacity-50"
              >
                {ciReportLoading ? 'Generating...' : 'CI Report'}
              </button>
              {isRecording && (
                <button
                  onClick={async () => {
                    if (!session) return;
                    setIncidentLoading(true);
                    try {
                      await fetch(`/api/sessions/${session.id}/incident`, { method: 'POST' });
                      setSession({ ...session, status: 'paused' });
                    } catch {}
                    setIncidentLoading(false);
                  }}
                  disabled={incidentLoading}
                  className="rounded-[16px] border border-red-500/40 bg-red-500/15 px-3 py-1.5 font-mono text-[10px] font-bold text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-50"
                >
                  {incidentLoading ? 'Freezing...' : 'Incident freeze'}
                </button>
              )}
            </div>

            {feedback && (
              <div className={`rounded-[14px] border px-3 py-2 font-mono text-[11px] ${
                feedback.tone === 'error'
                  ? 'border-red-400/20 bg-red-400/8 text-red-400'
                  : 'border-hawk-green/20 bg-hawk-green/8 text-hawk-green'
              }`}>
                {feedback.message}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <MiniStat label="Duration" value={duration} meta={isRecording ? 'Still running' : 'Run length'} />
              <MiniStat label="Actions" value={String(events.length)} meta="Captured events" />
              <MiniStat label="Cost" value={`$${(totalCost || session.total_cost_usd).toFixed(4)}`} meta="Tracked spend" toneClass="text-hawk-amber" />
              <MiniStat
                label="Drift"
                value={liveDriftScore != null ? `${liveDriftScore}/100` : '--'}
                meta={liveDriftScore != null ? getDriftLabel(liveDriftScore) : 'No drift snapshot'}
                toneClass={getDriftColor(liveDriftScore)}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <MetaPill>LLM calls {llmCallCount}</MetaPill>
              <MetaPill>Files changed {fileChangeCount}</MetaPill>
              <MetaPill tone={blockedCount > 0 ? 'danger' : 'muted'}>Blocked {blockedCount}</MetaPill>
              <MetaPill>Commands {typeCounts['command'] || 0}</MetaPill>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Time Travel Debugger ─── */}
      {events.length > 1 && !isRecording && (
        <div className="mb-6 overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/70">
          <div className="border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-display text-base font-semibold text-hawk-text">Time Travel Debugger</h2>
                <p className="text-xs text-hawk-text2">
                  Step through the session chronologically, pause on breakpoints, and fork from an exact moment.
                </p>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-hawk-text3">
                {events.length} events
              </span>
            </div>
          </div>
          <div className="px-4 py-3 space-y-3">
            {/* Top bar: toggle + transport controls */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Toggle replay mode */}
              <button
                onClick={toggleReplay}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition-all ${
                  replayMode
                    ? 'bg-hawk-orange/20 text-hawk-orange border border-hawk-orange/30'
                    : 'bg-hawk-surface2 text-hawk-text3 hover:text-hawk-text border border-hawk-border'
                }`}
              >
                {replayMode ? 'Exit Replay' : 'Time Travel'}
              </button>

              {replayMode && (
                <>
                  {/* Step Back */}
                  <button
                    onClick={() => { setIsPlaying(false); setReplayIndex((i) => Math.max(i - 1, 0)); }}
                    className="rounded-lg bg-hawk-surface2 px-2 py-1.5 font-mono text-xs text-hawk-text hover:bg-hawk-surface3 transition-colors border border-hawk-border"
                    title="Step back (←)"
                  >
                    ⏮
                  </button>

                  {/* Play/Pause */}
                  <button
                    onClick={() => {
                      if (replayIndex >= events.length) setReplayIndex(0);
                      setIsPlaying(!isPlaying);
                    }}
                    className="rounded-lg bg-hawk-surface2 px-3 py-1.5 font-mono text-xs text-hawk-text hover:bg-hawk-surface3 transition-colors border border-hawk-border"
                    title="Play/Pause (Space)"
                  >
                    {isPlaying ? '⏸ Pause' : '▶ Play'}
                  </button>

                  {/* Step Forward */}
                  <button
                    onClick={() => { setIsPlaying(false); setReplayIndex((i) => Math.min(i + 1, events.length)); }}
                    className="rounded-lg bg-hawk-surface2 px-2 py-1.5 font-mono text-xs text-hawk-text hover:bg-hawk-surface3 transition-colors border border-hawk-border"
                    title="Step forward (→)"
                  >
                    ⏭
                  </button>

                  {/* Speed control */}
                  <div className="flex items-center gap-1 font-mono text-[10px] text-hawk-text3">
                    {[1, 2, 5, 10].map((s) => (
                      <button
                        key={s}
                        onClick={() => setPlaybackSpeed(s)}
                        className={`rounded px-1.5 py-0.5 transition-colors ${
                          playbackSpeed === s ? 'bg-hawk-orange/20 text-hawk-orange' : 'hover:bg-hawk-surface3'
                        }`}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>

                  {/* Breakpoint count */}
                  {breakpoints.size > 0 && (
                    <span className="font-mono text-[10px] text-hawk-red flex items-center gap-1">
                      <span className="inline-block w-1.5 h-1.5 bg-hawk-red rounded-sm rotate-45" />
                      {breakpoints.size} breakpoint{breakpoints.size > 1 ? 's' : ''}
                    </span>
                  )}

                  {/* Fork button */}
                  {replayIndex > 0 && (
                    <button
                      onClick={() => handleForkFromHere(replayIndex - 1)}
                      disabled={forkLoading}
                    className="ml-auto rounded-[16px] border border-hawk-border bg-hawk-surface2 px-3 py-1.5 font-mono text-xs text-hawk-text3 hover:text-hawk-orange hover:border-hawk-orange/30 transition-colors disabled:opacity-50"
                      title="Fork session from this point"
                    >
                      {forkLoading ? 'Forking...' : 'Fork from here'}
                    </button>
                  )}

                  {/* Current time */}
                  {replayIndex > 0 && replayIndex <= events.length && (
                    <span className="font-mono text-[10px] text-hawk-text3 shrink-0">
                      {new Date(events[Math.min(replayIndex - 1, events.length - 1)].timestamp).toLocaleTimeString()}
                    </span>
                  )}
                </>
              )}
            </div>

            {/* Interactive SVG Timeline */}
            {replayMode && (
              <div className="border-t border-hawk-border/50 pt-3">
                <TimelineBar
                  events={events}
                  currentIndex={replayIndex > 0 ? replayIndex - 1 : 0}
                  breakpoints={breakpoints}
                  onSeek={(i) => { setReplayIndex(i + 1); setIsPlaying(false); }}
                  onToggleBreakpoint={handleToggleBreakpoint}
                  onReplayFromHere={handleReplayFromHere}
                  onForkFromHere={handleForkFromHere}
                />
                <div className="flex items-center justify-between mt-1.5 font-mono text-[9px] text-hawk-text3">
                  <span>← / → step &nbsp; Space play/pause &nbsp; B toggle breakpoint &nbsp; Right-click for menu</span>
                  <span>{replayIndex} / {events.length}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Drift Alert Banner ─── */}
      {criticalDrifts.length > 0 && (
        <div className="mb-6 rounded-[18px] border border-hawk-red/30 bg-hawk-red/5 p-3">
          <div className="flex items-start gap-3">
            <span className="text-hawk-red text-lg mt-0.5">⚠</span>
            <div className="flex-1">
              <h3 className="font-display font-semibold text-hawk-red mb-1">
                DriftDetect — Critical Divergence
              </h3>
              <p className="text-sm text-hawk-text2">{criticalDrifts[criticalDrifts.length - 1].reason}</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Root Cause Analysis ─── */}
      {rcaResult && (
        <div className="mb-6 overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
          <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-base font-semibold text-hawk-text">Root Cause Analysis</h2>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                rcaResult.outcome === 'success' ? 'bg-hawk-green/15 text-hawk-green' :
                rcaResult.outcome === 'failure' ? 'bg-hawk-red/15 text-hawk-red' :
                rcaResult.outcome === 'partial' ? 'bg-hawk-amber/15 text-hawk-amber' :
                'bg-hawk-text3/15 text-hawk-text3'
              }`}>
                {rcaResult.outcome}
              </span>
              <span className={`font-mono text-[10px] ${
                rcaResult.confidence === 'high' ? 'text-hawk-green' :
                rcaResult.confidence === 'medium' ? 'text-hawk-amber' : 'text-hawk-red'
              }`}>
                {rcaResult.confidence} confidence
              </span>
            </div>
            <button onClick={() => setRcaResult(null)} className="text-hawk-text3 hover:text-hawk-text text-xs">✕</button>
          </div>

          <div className="px-4 py-4 space-y-4">
            {/* Summary */}
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Summary</div>
              <p className="text-sm text-hawk-text2 font-mono">{rcaResult.summary}</p>
            </div>

            {/* Primary Error */}
            {rcaResult.primaryError && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">
                  Primary Error <span className="text-hawk-text3">— event #{rcaResult.primaryError.sequence}</span>
                </div>
                <div className="rounded bg-hawk-red/5 border border-hawk-red/20 px-3 py-2">
                  <span className="text-sm text-hawk-red font-mono">{rcaResult.primaryError.description}</span>
                  <div className="text-[10px] text-hawk-text3 mt-1">
                    {new Date(rcaResult.primaryError.timestamp).toLocaleTimeString()} — {rcaResult.primaryError.type}
                  </div>
                </div>
              </div>
            )}

            {/* Causal Chain */}
            {rcaResult.causalChain.length > 0 && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Causal Chain</div>
                <div className="space-y-1">
                  {rcaResult.causalChain.map((step, i) => (
                    <div key={i} className="flex items-start gap-2 font-mono text-xs">
                      <span className={`shrink-0 mt-0.5 w-2 h-2 rounded-full ${
                        step.relevance === 'root_cause' ? 'bg-hawk-red' :
                        step.relevance === 'contributing' ? 'bg-hawk-amber' :
                        step.relevance === 'effect' ? 'bg-hawk-text3' : 'bg-blue-400'
                      }`} />
                      <span className="text-hawk-text3 shrink-0 w-8">#{step.sequence}</span>
                      <span className="text-hawk-text">{step.description}</span>
                      {step.explanation && <span className="text-hawk-text3 ml-auto shrink-0">— {step.explanation}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error Patterns */}
            {rcaResult.errorPatterns.length > 0 && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Error Patterns</div>
                <div className="space-y-1">
                  {rcaResult.errorPatterns.slice(0, 5).map((pat, i) => (
                    <div key={i} className="flex items-center gap-2 font-mono text-xs">
                      <span className="text-hawk-red font-bold shrink-0">{pat.count}x</span>
                      <span className="text-hawk-text">{pat.pattern}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Drift Analysis */}
            {rcaResult.driftAnalysis && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Drift Analysis</div>
                <div className="font-mono text-xs text-hawk-text2">
                  Trend: <span className={
                    rcaResult.driftAnalysis.trend === 'declining' ? 'text-hawk-red' :
                    rcaResult.driftAnalysis.trend === 'volatile' ? 'text-hawk-amber' : 'text-hawk-green'
                  }>{rcaResult.driftAnalysis.trend}</span>
                  {' · '}Score: {rcaResult.driftAnalysis.lowestScore} – {rcaResult.driftAnalysis.highestScore}
                  {rcaResult.driftAnalysis.inflectionPoint && (
                    <span className="text-hawk-text3"> · Inflection at #{rcaResult.driftAnalysis.inflectionPoint.sequence} ({rcaResult.driftAnalysis.inflectionPoint.scoreBefore} → {rcaResult.driftAnalysis.inflectionPoint.scoreAfter})</span>
                  )}
                </div>
              </div>
            )}

            {/* Suggestions */}
            {rcaResult.suggestions.length > 0 && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Suggestions</div>
                <ol className="list-decimal list-inside space-y-1">
                  {rcaResult.suggestions.map((s, i) => (
                    <li key={i} className="text-sm text-hawk-text2 font-mono">{s}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── CI Report ─── */}
      {ciReport && (
        <div className="mb-6 overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
          <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-bg/35 px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-base font-semibold text-hawk-text">CI Report</h2>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                ciReport.passed ? 'bg-hawk-green/15 text-hawk-green' : 'bg-hawk-red/15 text-hawk-red'
              }`}>
                {ciReport.passed ? 'passed' : 'failed'}
              </span>
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                ciReport.risk === 'critical' ? 'bg-hawk-red/15 text-hawk-red' :
                ciReport.risk === 'high' ? 'bg-hawk-amber/15 text-hawk-amber' :
                ciReport.risk === 'medium' ? 'bg-blue-500/15 text-blue-400' :
                'bg-hawk-green/15 text-hawk-green'
              }`}>
                {ciReport.risk} risk
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(ciReport.markdown).then(
                    () => { /* copied */ },
                    () => { /* fallback: user can select text manually */ },
                  );
                }}
                className="rounded-[12px] border border-hawk-border-subtle bg-hawk-bg/55 px-2 py-1 font-mono text-[10px] text-hawk-text3 hover:text-hawk-orange hover:border-hawk-orange/30 transition-colors"
              >
                Copy Markdown
              </button>
              <button onClick={() => setCiReport(null)} className="text-hawk-text3 hover:text-hawk-text text-xs">✕</button>
            </div>
          </div>

          <div className="px-4 py-4 space-y-3">
            {/* Flags */}
            {ciReport.flags.length > 0 && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Flags</div>
                <div className="flex flex-wrap gap-1.5">
                  {ciReport.flags.map((flag) => (
                    <span key={flag} className="rounded-full bg-hawk-amber/15 border border-hawk-amber/30 px-2 py-0.5 font-mono text-[10px] text-hawk-amber">
                      {flag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Markdown Preview */}
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-hawk-orange mb-1">Report Preview</div>
              <pre className="max-h-[400px] overflow-auto rounded-lg bg-hawk-bg/60 border border-hawk-border-subtle p-3 font-mono text-xs text-hawk-text2 whitespace-pre-wrap">{ciReport.markdown}</pre>
            </div>
          </div>
        </div>
      )}

      {/* ─── Drift Chart ─── */}
      {driftSnapshots.length > 0 && (
        <div className="mb-6 rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72 p-3">
          <h2 className="font-display text-base font-semibold text-hawk-text mb-3">Drift Score</h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={driftSnapshots.map((s, i) => ({ ...s, idx: i + 1 }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1E1E2A" />
              <XAxis dataKey="idx" tick={{ fontSize: 10, fill: '#5A5A6E' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#5A5A6E' }} />
              <Tooltip
                contentStyle={{ background: '#111117', border: '1px solid #242430', borderRadius: 8, fontSize: 12, fontFamily: 'monospace' }}
                formatter={(value: number) => [`${value}/100`, 'Score']}
              />
              <ReferenceArea y1={0} y2={40} fill="#ef4444" fillOpacity={0.06} />
              <ReferenceArea y1={40} y2={70} fill="#f0a830" fillOpacity={0.06} />
              <ReferenceArea y1={70} y2={100} fill="#22c55e" fillOpacity={0.06} />
              <Line type="monotone" dataKey="score" stroke="#ff5f1f" strokeWidth={2} dot={{ fill: '#ff5f1f', r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ─── Cost Breakdown + Files Changed ─── */}
      {visibleEvents.length > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Cost Breakdown */}
          <CostBreakdown events={visibleEvents} />
          {/* Files Changed */}
          <FilesChanged events={visibleEvents} onToggle={(id) => setExpandedEvent(expandedEvent === id ? null : id)} />
        </div>
      )}

      {/* ─── Timeline ─── */}
      <div className="overflow-hidden rounded-[20px] border border-hawk-border-subtle bg-hawk-surface/72">
        {/* Header with search + filter */}
        <div className="border-b border-hawk-border-subtle px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-display text-base font-semibold text-hawk-text">Timeline</h2>
            <span className="font-mono text-[10px] text-hawk-text3">
              {replayMode
                ? `${filteredEvents.length} / ${events.length} events (replay)`
                : filteredEvents.length === events.length
                  ? `${events.length} events`
                  : `${filteredEvents.length} / ${events.length} events`}
            </span>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {/* Search bar */}
            <input
              type="text"
              placeholder="Search events..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 rounded bg-hawk-surface2 border border-hawk-border px-3 py-1.5 font-mono text-xs text-hawk-text placeholder-hawk-text3 outline-none focus:border-hawk-orange/50 transition-colors"
            />
            {/* Type filter badges */}
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
              {Object.entries(typeCounts).map(([type, count]) => (
                <button
                  key={type}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                  className={`flex items-center gap-1 rounded px-1.5 py-1 transition-all ${
                    typeFilter === type ? 'ring-1 ring-hawk-orange' : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  <EventBadge type={type} />
                  <span className="font-mono text-[10px] text-hawk-text3">{count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Event list */}
        {filteredEvents.length === 0 ? (
          <div className="px-5 py-8 text-center text-hawk-text3 text-sm">
            {events.length === 0
              ? (isRecording ? 'Waiting for events...' : 'No events recorded.')
              : 'No events match your filter.'}
          </div>
        ) : (
          <div className="divide-y divide-hawk-border/50">
            {filteredEvents.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                expanded={expandedEvent === event.id}
                onToggle={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
