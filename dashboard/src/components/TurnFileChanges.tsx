import { useEffect, useRef, useState } from 'react';
import { CR } from '../lib/cr';
import { DiffViewer, diffLineCounts } from './DiffViewer';

/**
 * TurnFileChanges — Codex/Antigravity-style "files changed" summary for a chat turn.
 *
 * Unlike the old TurnFiles (a live, in-memory before/after diff of the whole workspace
 * that never survives a page reload), this reads from `agent_file_events` — a table
 * already populated for every cycle by FileTracker (src/agents/file-tracker.ts), with
 * a precomputed unified diff per file. Fetching by cycleId means the exact same data is
 * available whether the turn just finished live or you're looking at old scrollback
 * after a reload — no separate live/historical code path needed.
 */

// Internal bookkeeping the agent maintains for itself (telemetry logs, memory
// consolidation, identity/self-improve state, bytecode/test caches) — never
// work product a user asked for. A Codex-style summary should only show the latter.
const NOISE_PATH_PREFIXES = ['.nanocrew/', 'memory/', '__pycache__/', '.pytest_cache/', '.git/', 'node_modules/', '.venv/', 'venv/'];
const NOISE_EXACT_PATHS = new Set(['activity.json']);
function isNoisePath(p: string): boolean {
    if (NOISE_EXACT_PATHS.has(p)) return true;
    if (p.endsWith('.pyc')) return true;
    return NOISE_PATH_PREFIXES.some(prefix => p.startsWith(prefix) || p.includes('/' + prefix));
}

/** Longest shared directory prefix across a set of paths (empty if they don't share one). */
function commonDirPrefix(paths: string[]): string {
    if (paths.length < 2) return '';
    const parts = paths.map(p => p.split('/').slice(0, -1));
    const first = parts[0];
    let shared: string[] = [];
    for (let i = 0; i < first.length; i++) {
        const seg = first[i];
        if (parts.every(p => p[i] === seg)) shared.push(seg);
        else break;
    }
    return shared.length ? shared.join('/') + '/' : '';
}

interface FileEvent {
    id: string;
    event_type: 'read' | 'write' | 'create' | 'delete';
    file_path: string;
    diff_patch?: string;
}

const EVENT_META: Record<string, { icon: string; color: string }> = {
    create: { icon: '+', color: CR.green },
    write: { icon: '~', color: CR.amber },
    delete: { icon: '−', color: 'var(--cr-error)' },
};

// Module-level (NOT useRef) — a per-instance ref resets whenever the component
// unmounts and remounts, and in a long-lived chat page that can happen for
// reasons that have nothing to do with this component (a parent re-key, a
// remount triggered by live chat/socket churn elsewhere in the tree). A ref
// reset silently re-armed the fetch and re-hit the server for the same cycle
// over and over for as long as the tab stayed open — the actual source of a
// reported multi-hundred-MB, multi-minute-long network tab. This cache lives
// outside React entirely, keyed by agent+cycle, so it can only be cleared by
// an actual page reload — no remount, however it's triggered, can reset it.
const fileEventsCache = new Map<string, FileEvent[]>();
const fileEventsInFlight = new Set<string>();

interface Props {
    agentId: string;
    cycleId: string;
    accentColor?: string;
    /**
     * Supply the events instead of fetching them. The conversation event stream
     * already carries a turn's file changes (diff_patch included), so its caller has
     * them in hand and there is nothing to go and get — no request, no module cache,
     * no "eager vs manual" hydration. The fetch path below stays for the legacy chat
     * row and dies with it.
     */
    events?: FileEvent[];
    /** False for older chat history — avoids firing one file-events query per historical
     * cycle the instant the page loads (this component is mounted once per cycle-result
     * message; on an agent with a long history that's dozens of synchronous DB reads at
     * once). Shows a manual "Check for file changes" link instead until clicked. */
    eager?: boolean;
    /** Delay (ms) before firing the eager fetch — spaces out the N eagerly-hydrated
     * cycles' requests instead of all of them landing on the server in the same tick. */
    staggerMs?: number;
}

export function TurnFileChanges({ agentId, cycleId, accentColor = CR.accent, eager = true, staggerMs = 0, events: providedEvents }: Props) {
    const cacheKey = `${agentId}:${cycleId}`;
    const [fetchedEvents, setEvents] = useState<FileEvent[] | null>(() => fileEventsCache.get(cacheKey) ?? null);
    // Provided events win outright — when the caller has them, the fetch below never runs.
    const events = providedEvents ?? fetchedEvents;
    const [expanded, setExpanded] = useState(false);
    const [openPath, setOpenPath] = useState<string | null>(null);
    const [manuallyRequested, setManuallyRequested] = useState(false);
    // staggerMs read via a ref (not a dependency) — its VALUE shifts as the
    // parent's chat history grows (later messages push every earlier cycle's
    // stagger slot back by one); it should only affect the delay before the
    // one-and-only fetch, not re-trigger the effect.
    const staggerMsRef = useRef(staggerMs);
    staggerMsRef.current = staggerMs;

    useEffect(() => {
        if (providedEvents) return;   // caller supplied them — nothing to fetch
        const cached = fileEventsCache.get(cacheKey);
        if (cached) { setEvents(cached); return; }
        if (!eager && !manuallyRequested) return;
        if (fileEventsInFlight.has(cacheKey)) return;
        fileEventsInFlight.add(cacheKey);
        let cancelled = false;
        const delay = manuallyRequested ? 0 : staggerMsRef.current;
        const timer = setTimeout(() => {
            if (cancelled) return;
            fetch(`/api/agents/${agentId}/cycles/${cycleId}/file-events`)
                .then(r => r.ok ? r.json() : [])
                .then((d: FileEvent[]) => {
                    const filtered = Array.isArray(d) ? d.filter(e => e.event_type !== 'read' && !isNoisePath(e.file_path)) : [];
                    fileEventsCache.set(cacheKey, filtered);
                    if (!cancelled) setEvents(filtered);
                })
                .catch(() => { fileEventsCache.set(cacheKey, []); if (!cancelled) setEvents([]); })
                .finally(() => { fileEventsInFlight.delete(cacheKey); });
        }, delay);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [agentId, cycleId, cacheKey, eager, manuallyRequested]);

    if (!eager && !manuallyRequested) {
        return (
            <button
                onClick={() => setManuallyRequested(true)}
                style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', fontFamily: CR.mono, fontSize: 10.5, color: CR.muted, textDecoration: 'underline', padding: 0 }}
            >Check for file changes</button>
        );
    }
    if (!events || events.length === 0) return null;

    let totalAdded = 0, totalRemoved = 0;
    for (const e of events) {
        if (!e.diff_patch) continue;
        const { added, removed } = diffLineCounts(e.diff_patch);
        totalAdded += added; totalRemoved += removed;
    }

    // Strip the shared parent directory (e.g. a project checkout root repeated on
    // every single row) so what's left reads like a normal repo-relative path list.
    const prefix = commonDirPrefix(events.map(e => e.file_path));

    return (
        <div style={{ marginTop: 6, width: '100%', alignSelf: 'stretch', border: `1px solid ${CR.border}`, borderRadius: 8, background: CR.bgSurf, overflow: 'hidden' }}>
            <button onClick={() => setExpanded(e => !e)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', color: CR.sub, fontFamily: CR.mono, fontSize: 11, textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.color = CR.cream}
                onMouseLeave={e => e.currentTarget.style.color = CR.sub}>
                <span style={{ fontSize: 10, color: CR.muted, flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>▸</span>
                <span style={{ flexShrink: 0 }}>{events.length} file{events.length !== 1 ? 's' : ''} changed</span>
                {prefix && <span style={{ flex: 1, color: CR.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>in {prefix}</span>}
                {!prefix && <span style={{ flex: 1 }} />}
                {totalAdded > 0 && <span style={{ color: CR.green, flexShrink: 0 }}>+{totalAdded}</span>}
                {totalRemoved > 0 && <span style={{ color: 'var(--cr-error)', flexShrink: 0 }}>−{totalRemoved}</span>}
            </button>
            {expanded && (
                <div style={{ borderTop: `1px solid ${CR.border}`, maxHeight: 320, overflowY: 'auto' }}>
                    {events.map(e => {
                        const meta = EVENT_META[e.event_type] ?? EVENT_META.write;
                        const counts = e.diff_patch ? diffLineCounts(e.diff_patch) : null;
                        const isOpen = openPath === e.file_path;
                        const rel = prefix && e.file_path.startsWith(prefix) ? e.file_path.slice(prefix.length) : e.file_path;
                        const slash = rel.lastIndexOf('/');
                        const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
                        const base = slash >= 0 ? rel.slice(slash + 1) : rel;
                        return (
                            <div key={e.id}>
                                <button onClick={() => setOpenPath(p => p === e.file_path ? null : e.file_path)}
                                    disabled={!e.diff_patch}
                                    title={e.file_path}
                                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 12px 6px 28px', background: isOpen ? 'var(--cr-tint-3)' : 'none', border: 'none', cursor: e.diff_patch ? 'pointer' : 'default', fontFamily: CR.mono, fontSize: 11, textAlign: 'left' }}
                                    onMouseEnter={ev => { if (e.diff_patch && !isOpen) ev.currentTarget.style.background = 'var(--cr-tint-2)'; }}
                                    onMouseLeave={ev => { if (!isOpen) ev.currentTarget.style.background = 'none'; }}>
                                    <span style={{ color: meta.color, fontWeight: 700, width: 10, flexShrink: 0, textAlign: 'center' }}>{meta.icon}</span>
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {dir && <span style={{ color: CR.muted }}>{dir}</span>}
                                        <span style={{ color: accentColor }}>{base}</span>
                                    </span>
                                    {counts && counts.added > 0 && <span style={{ color: CR.green, flexShrink: 0 }}>+{counts.added}</span>}
                                    {counts && counts.removed > 0 && <span style={{ color: 'var(--cr-error)', flexShrink: 0 }}>−{counts.removed}</span>}
                                </button>
                                {isOpen && e.diff_patch && (
                                    <div style={{ height: 240, borderTop: `1px solid ${CR.border}`, borderBottom: `1px solid ${CR.border}` }}>
                                        <DiffViewer patch={e.diff_patch} />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
