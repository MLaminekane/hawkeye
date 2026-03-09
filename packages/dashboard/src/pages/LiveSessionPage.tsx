import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, hawkeyeWs, type SessionData, type EventData, type DriftSnapshot } from '../api';

export function LiveSessionPage() {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventData[]>([]);
  const [driftSnapshots, setDriftSnapshots] = useState<DriftSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [driftDismissed, setDriftDismissed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch active sessions (recording or paused)
  useEffect(() => {
    api.listSessions().then((all) => {
      const active = all.filter((s) => s.status === 'recording' || s.status === 'paused');
      setSessions(active);
      if (active.length > 0 && !selectedId) {
        setSelectedId(active[0].id);
        setIsPaused(active[0].status === 'paused');
      }
      setLoading(false);
    }).catch(() => setLoading(false));

    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'event' || msg.type === 'drift_update' || msg.type === 'session_pause' || msg.type === 'session_resume' || msg.type === 'session_end') {
        api.listSessions().then((all) => {
          const active = all.filter((s) => s.status === 'recording' || s.status === 'paused');
          setSessions(active);
        });
      }
    });
    return () => { unsub(); };
  }, []);

  // Load events for selected session
  useEffect(() => {
    if (!selectedId) return;
    api.getEvents(selectedId).then(setEvents);
    api.getDriftSnapshots(selectedId).then(setDriftSnapshots);
  }, [selectedId]);

  // Subscribe to real-time events for selected session
  useEffect(() => {
    if (!selectedId) return;

    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'event' && msg.sessionId === selectedId) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === msg.event.id)) return prev;
          return [...prev, msg.event];
        });
      }
      if (msg.type === 'drift_update' && msg.sessionId === selectedId) {
        setDriftSnapshots((prev) => [
          ...prev,
          { id: `ws-${Date.now()}`, score: msg.score, flag: msg.flag, reason: msg.reason, created_at: new Date().toISOString() },
        ]);
      }
    });

    return () => { unsub(); };
  }, [selectedId]);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const latestDrift = useMemo(() => {
    if (driftSnapshots.length === 0) return null;
    return driftSnapshots[driftSnapshots.length - 1];
  }, [driftSnapshots]);

  const totalCost = useMemo(() => events.reduce((sum, e) => sum + (e.cost_usd || 0), 0), [events]);

  // Show drift alert when score drops to warning or critical
  const showDriftAlert = latestDrift && !driftDismissed && (latestDrift.flag === 'warning' || latestDrift.flag === 'critical');

  // Session controls
  const handlePause = useCallback(async () => {
    if (!selectedId) return;
    await api.pauseSession(selectedId);
    setIsPaused(true);
  }, [selectedId]);

  const handleResume = useCallback(async () => {
    if (!selectedId) return;
    await api.resumeSession(selectedId);
    setIsPaused(false);
    setDriftDismissed(true);
  }, [selectedId]);

  const handleAbort = useCallback(async () => {
    if (!selectedId) return;
    await api.endSession(selectedId, 'aborted');
    setSessions((prev) => prev.filter((s) => s.id !== selectedId));
    setSelectedId(null);
    setEvents([]);
    setDriftSnapshots([]);
  }, [selectedId]);

  if (loading) return <div className="text-hawk-text3 font-mono text-sm p-8">Loading...</div>;

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 text-5xl opacity-30">●</div>
        <h2 className="font-display text-xl font-semibold text-hawk-text mb-2">No active sessions</h2>
        <p className="text-hawk-text3 text-sm max-w-md mb-4">
          Start recording a session to see live events here.
        </p>
        <Link to="/" className="rounded-lg border border-hawk-border-subtle bg-hawk-surface px-3 py-1.5 text-hawk-orange font-mono text-xs transition-colors hover:bg-hawk-surface2">← Back to sessions</Link>
      </div>
    );
  }

  const selected = sessions.find((s) => s.id === selectedId);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="font-mono text-xs text-hawk-text3 hover:text-hawk-orange transition-colors">← Sessions</Link>
          <h1 className="font-display text-2xl font-bold text-hawk-text flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-hawk-orange opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-hawk-orange"></span>
            </span>
            Live
          </h1>
        </div>
      </div>

      {/* Session tabs for multi-session */}
      {sessions.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2 rounded-xl border border-hawk-border-subtle bg-hawk-surface/80 p-2">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => { setSelectedId(s.id); setEvents([]); setDriftSnapshots([]); }}
              className={`rounded-lg px-3 py-1.5 font-mono text-xs transition-all ${
                selectedId === s.id ? 'bg-hawk-orange text-black font-bold shadow-sm' : 'bg-hawk-surface2/70 text-hawk-text3 hover:bg-hawk-surface2'
              }`}
            >
              {s.id.slice(0, 8)} — {s.objective.slice(0, 30)}
            </button>
          ))}
        </div>
      )}

      {/* Stats bar + Controls */}
      {selected && (
        <div className="mb-4 flex items-center gap-6 rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/60 px-5 py-3 font-mono text-xs shadow-sm">
          <div className="flex items-center gap-2">
            {isPaused ? (
              <>
                <span className="h-2.5 w-2.5 rounded-full bg-hawk-amber"></span>
                <span className="text-hawk-amber font-bold">Paused</span>
              </>
            ) : (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-hawk-orange opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-hawk-orange"></span>
                </span>
                <span className="text-hawk-orange font-bold">Recording</span>
              </>
            )}
          </div>
          <div><span className="text-hawk-text3">Actions:</span> <span className="text-hawk-text font-semibold">{events.length}</span></div>
          <div><span className="text-hawk-text3">Cost:</span> <span className="text-hawk-amber">${totalCost.toFixed(4)}</span></div>
          {latestDrift && (
            <div>
              <span className="text-hawk-text3">Drift:</span>{' '}
              <span className={latestDrift.flag === 'critical' ? 'text-hawk-red' : latestDrift.flag === 'warning' ? 'text-hawk-amber' : 'text-hawk-green'}>
                {latestDrift.score}/100
              </span>
            </div>
          )}

          {/* Session Controls */}
          <div className="ml-auto flex items-center gap-2">
            {selected.agent && (
              <span className="rounded bg-hawk-surface3 px-1.5 py-0.5 text-hawk-text3 mr-2">{selected.agent}</span>
            )}
            {isPaused ? (
              <button
                onClick={handleResume}
                className="rounded-lg bg-hawk-green/15 px-3 py-1.5 text-hawk-green font-bold text-[10px] uppercase hover:bg-hawk-green/25 transition-colors"
              >
                ▶ Resume
              </button>
            ) : (
              <button
                onClick={handlePause}
                className="rounded-lg bg-hawk-amber/15 px-3 py-1.5 text-hawk-amber font-bold text-[10px] uppercase hover:bg-hawk-amber/25 transition-colors"
              >
                ⏸ Pause
              </button>
            )}
            <button
              onClick={handleAbort}
              className="rounded-lg bg-hawk-red/15 px-3 py-1.5 text-hawk-red font-bold text-[10px] uppercase hover:bg-hawk-red/25 transition-colors"
            >
              ✗ Abort
            </button>
          </div>
        </div>
      )}

      {/* ─── Drift Alert Banner ─── */}
      {showDriftAlert && latestDrift && (
        <div className={`mb-4 rounded-xl border p-4 ${
          latestDrift.flag === 'critical'
            ? 'border-hawk-red/40 bg-hawk-red/10'
            : 'border-hawk-amber/40 bg-hawk-amber/10'
        }`}>
          <div className="flex items-start gap-3">
            <span className={`text-2xl mt-0.5 ${latestDrift.flag === 'critical' ? 'text-hawk-red' : 'text-hawk-amber'}`}>
              {latestDrift.flag === 'critical' ? '⚠' : '⚡'}
            </span>
            <div className="flex-1">
              <h3 className={`font-display font-bold text-base mb-1 ${latestDrift.flag === 'critical' ? 'text-hawk-red' : 'text-hawk-amber'}`}>
                {latestDrift.flag === 'critical' ? 'DRIFT CRITICAL' : 'DRIFT WARNING'} — Score: {latestDrift.score}/100
              </h3>
              <p className="text-sm text-hawk-text2 mb-3">{latestDrift.reason}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setDriftDismissed(true)}
                  className="rounded-lg bg-hawk-surface2 px-4 py-1.5 font-mono text-xs text-hawk-text hover:bg-hawk-surface3 transition-colors"
                >
                  [C] Continue
                </button>
                <button
                  onClick={handlePause}
                  className="rounded-lg bg-hawk-amber/20 px-4 py-1.5 font-mono text-xs text-hawk-amber hover:bg-hawk-amber/30 transition-colors"
                >
                  [P] Pause
                </button>
                <button
                  onClick={handleAbort}
                  className="rounded-lg bg-hawk-red/20 px-4 py-1.5 font-mono text-xs text-hawk-red hover:bg-hawk-red/30 transition-colors"
                >
                  [A] Abort
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live event stream */}
      <div className="overflow-hidden rounded-xl border border-hawk-border-subtle bg-gradient-to-b from-hawk-surface to-hawk-surface2/45 shadow-sm">
        <div className="flex items-center justify-between border-b border-hawk-border-subtle bg-hawk-surface2/70 px-4 py-2">
          <span className="font-mono text-xs text-hawk-text3">Live Event Stream</span>
          <span className="font-mono text-[10px] text-hawk-text3">{events.length} events</span>
        </div>
        <div className="max-h-[60vh] space-y-0.5 overflow-y-auto p-2">
          {events.map((e, i) => (
            <LiveEventRow key={e.id} event={e} index={i} />
          ))}
          {events.length === 0 && (
            <div className="text-center py-8 text-hawk-text3 text-sm">Waiting for events...</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

const TYPE_STYLES: Record<string, { icon: string; color: string }> = {
  command:           { icon: '$', color: 'text-blue-400' },
  file_write:        { icon: '✎', color: 'text-hawk-green' },
  file_delete:       { icon: '✗', color: 'text-hawk-red' },
  file_read:         { icon: '◉', color: 'text-hawk-text3' },
  llm_call:          { icon: '⚡', color: 'text-purple-400' },
  api_call:          { icon: '→', color: 'text-cyan-400' },
  git_commit:        { icon: '●', color: 'text-hawk-green' },
  git_checkout:      { icon: '⎇', color: 'text-blue-400' },
  git_push:          { icon: '↑', color: 'text-cyan-400' },
  git_pull:          { icon: '↓', color: 'text-cyan-400' },
  git_merge:         { icon: '⑂', color: 'text-purple-400' },
  guardrail_trigger: { icon: '⛔', color: 'text-hawk-red' },
  guardrail_block:   { icon: '⛔', color: 'text-hawk-red' },
  drift_alert:       { icon: '⚠', color: 'text-hawk-amber' },
  error:             { icon: '!', color: 'text-hawk-red' },
};

function LiveEventRow({ event, index }: { event: EventData; index: number }) {
  const style = TYPE_STYLES[event.type] || { icon: '·', color: 'text-hawk-text3' };
  const time = new Date(event.timestamp).toLocaleTimeString();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(event.data); } catch {}

  let summary = event.type;
  if (event.type === 'command') summary = `${data.command} ${((data.args as string[]) || []).join(' ')}`;
  else if (event.type === 'file_write' || event.type === 'file_delete' || event.type === 'file_read') summary = String(data.path || '');
  else if (event.type === 'llm_call') summary = `${data.provider}/${data.model} (${data.totalTokens} tok)`;
  else if (event.type === 'git_commit') summary = `commit ${String(data.commitHash || '').slice(0, 7)} ${data.message || ''}`.trim();
  else if (event.type === 'git_checkout') summary = `checkout ${data.branch || ''}`;
  else if (event.type === 'git_push') summary = `push ${data.branch || ''}`.trim();
  else if (event.type === 'git_pull') summary = `pull`;
  else if (event.type === 'git_merge') summary = `merge ${data.targetBranch || ''}`;
  else if (event.type === 'error') summary = String(data.message || 'Error');

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded font-mono text-xs hover:bg-hawk-surface2 transition-colors ${index % 2 === 0 ? '' : 'bg-hawk-surface2/30'}`}>
      <span className={`w-4 text-center ${style.color}`}>{style.icon}</span>
      <span className="text-hawk-text3 w-16 shrink-0">{time}</span>
      <span className={`uppercase text-[10px] font-bold w-12 shrink-0 ${style.color}`}>{event.type.replace(/_/g, ' ').slice(0, 6)}</span>
      <span className="text-hawk-text truncate flex-1">{summary}</span>
      {event.cost_usd > 0 && <span className="text-hawk-amber shrink-0">${event.cost_usd.toFixed(4)}</span>}
      {event.drift_score != null && (
        <span className={`shrink-0 ${event.drift_flag === 'critical' ? 'text-hawk-red' : event.drift_flag === 'warning' ? 'text-hawk-amber' : 'text-hawk-green'}`}>
          {event.drift_score}
        </span>
      )}
    </div>
  );
}
