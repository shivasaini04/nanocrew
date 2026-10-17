/**
 * Stage 57 phase 5 — the run view. What an agent's workers are doing, what was accepted and
 * why the rest was not. Replaces the old Jobs page (/jobs redirects here).
 *
 * Worker output is web-derived: it is rendered as text only, and only http(s) URLs are
 * linked — a `javascript:` link in a poisoned page must not become a clickable one here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

interface Counts { total: number; accepted: number; dead: number; cancelled: number; unverified: number }
interface AgentBrief { id: string; name: string; emoji: string }
interface RunListItem {
    id: string; goal: string; status: string; agent: AgentBrief; created_at: string; finished_at: string | null;
    spent_usd: number; budget_usd: number; counts: Counts; wall_s: number; work_s: number;
}
interface Check { kind: string; ok: boolean; detail?: string }
interface Attempt { id: string; n: number; model: string | null; status: string; started_at: string; finished_at: string | null; cost_usd: number; run_s: number | null; error: string | null }
interface Task {
    idx: number; objective: string; tools: string; status: string; reason: string | null; depends_on: number[]; cost_usd: number;
    checks_planned: string[]; checks: Check[]; unverified: boolean; result?: unknown; summary?: string; evidence: string[]; attempts: Attempt[];
}
interface HealthFlag { kind: string; severity: 'problem' | 'note'; message: string }
interface RunDetail {
    run: { id: string; goal: string; status: string; agent: AgentBrief; created_at: string; finished_at: string | null; stop_reason: string | null; budget_usd: number; spent_usd: number; max_parallel: number };
    counts: Counts; timing: { wall_s: number; work_s: number; critical_s: number }; health: HealthFlag[]; tasks: Task[];
    events: Array<{ at: string; type: string; attempt: string | null; data: unknown }>;
}
interface Step { type: string; tool?: string; input: string; output: string; content: string }

const RUN_STATUS: Record<string, { label: string; color: string; bg: string }> = {
    awaiting_approval: { label: 'Awaiting your approval', color: 'var(--cr-purple)', bg: 'var(--cr-purple-low)' },
    running: { label: 'Running', color: 'var(--cr-accent)', bg: 'var(--cr-accent-low)' },
    done: { label: 'Done', color: 'var(--cr-green)', bg: 'var(--cr-green-low)' },
    partial: { label: 'Partly done', color: 'var(--cr-amber)', bg: 'var(--cr-amber-low)' },
    failed: { label: 'Failed', color: 'var(--cr-error-str)', bg: 'var(--cr-error-low)' },
    cancelled: { label: 'Cancelled', color: 'var(--cr-muted)', bg: 'var(--cr-surface3)' },
    budget_stopped: { label: 'Budget reached', color: 'var(--cr-amber)', bg: 'var(--cr-amber-low)' },
};
const TASK_STATUS: Record<string, { label: string; color: string; bg: string }> = {
    blocked: { label: 'Waiting on another task', color: 'var(--cr-muted)', bg: 'var(--cr-surface3)' },
    pending: { label: 'Queued', color: 'var(--cr-muted)', bg: 'var(--cr-surface3)' },
    leased: { label: 'Working', color: 'var(--cr-accent)', bg: 'var(--cr-accent-low)' },
    verifying: { label: 'Checking', color: 'var(--cr-blue)', bg: 'var(--cr-blue-low)' },
    accepted: { label: 'Accepted', color: 'var(--cr-green)', bg: 'var(--cr-green-low)' },
    dead: { label: 'Failed', color: 'var(--cr-error-str)', bg: 'var(--cr-error-low)' },
    cancelled: { label: 'Cancelled', color: 'var(--cr-muted)', bg: 'var(--cr-surface3)' },
};
const CHECK_LABEL: Record<string, string> = {
    injection_screen: 'no planted instructions', schema: 'right shape', evidence_urls: 'sources re-opened', judge: 'reviewers agreed',
    email: 'address deliverable', dedupe: 'not a duplicate', command: 'check passed', none: 'not checked', contract: 'result reported', verifier: 'checking',
};

function Chip({ spec }: { spec: { label: string; color: string; bg: string } }) {
    return <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, color: spec.color, background: spec.bg, whiteSpace: 'nowrap' }}>{spec.label}</span>;
}

const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const isWebUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

const card = { background: 'var(--cr-surface2)', border: '1px solid var(--cr-border)', borderRadius: 12, padding: '16px 20px' } as const;

// ── list ─────────────────────────────────────────────────────────────────────

function RunsList() {
    const navigate = useNavigate();
    const [runs, setRuns] = useState<RunListItem[] | null>(null);
    const load = useCallback(async () => {
        try { setRuns((await (await fetch('/api/runs')).json()).runs ?? []); } catch { setRuns([]); }
    }, []);
    useEffect(() => {
        void load();
        const t = setInterval(load, 10_000);
        return () => clearInterval(t);
    }, [load]);

    return (
        <div style={{ padding: 32, maxWidth: 900, margin: '0 auto', fontFamily: 'var(--cr-font-sans)' }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--cr-text)', margin: '0 0 6px' }}>Runs</h1>
            <p style={{ fontSize: 13, color: 'var(--cr-muted)', margin: '0 0 24px' }}>
                Work your agents handed to parallel workers. Each result is checked before it counts.
            </p>
            {runs === null && <div style={{ color: 'var(--cr-muted)', fontSize: 13 }}>Loading…</div>}
            {runs?.length === 0 && (
                <div style={{ textAlign: 'center', padding: '70px 0', color: 'var(--cr-muted)', fontSize: 14 }}>
                    No runs yet. Ask an agent for work that splits into independent parts — "research these five companies" — and it runs them here, in parallel.
                </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {runs?.map(r => (
                    <div key={r.id} onClick={() => navigate(`/runs/${r.id}`)} style={{ ...card, cursor: 'pointer', display: 'flex', gap: 14, alignItems: 'center' }}>
                        <div style={{ fontSize: 20 }}>{r.agent.emoji || '🤖'}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.goal}</div>
                            <div style={{ fontSize: 12, color: 'var(--cr-muted)', marginTop: 3 }}>
                                {r.agent.name} · {when(r.created_at)} · {r.counts.accepted} of {r.counts.total} accepted
                                {r.counts.dead ? ` · ${r.counts.dead} failed` : ''} · {money(r.spent_usd)}
                                {r.finished_at ? ` · ${dur(r.wall_s)}` : ''}
                            </div>
                        </div>
                        <Chip spec={RUN_STATUS[r.status] ?? RUN_STATUS.running} />
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── detail ───────────────────────────────────────────────────────────────────

function Transcript({ runId, attemptId }: { runId: string; attemptId: string }) {
    const [steps, setSteps] = useState<Step[] | null>(null);
    useEffect(() => {
        fetch(`/api/runs/${runId}/attempts/${attemptId}/transcript`).then(r => r.json()).then(d => setSteps(d.steps ?? [])).catch(() => setSteps([]));
    }, [runId, attemptId]);
    if (steps === null) return <div style={{ fontSize: 12, color: 'var(--cr-muted)', padding: 8 }}>Loading…</div>;
    if (!steps.length) return <div style={{ fontSize: 12, color: 'var(--cr-muted)', padding: 8 }}>No steps were recorded for this attempt.</div>;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {steps.map((s, i) => (
                <div key={i} style={{ fontSize: 12, borderLeft: '2px solid var(--cr-border)', paddingLeft: 10 }}>
                    <div style={{ color: 'var(--cr-muted)', fontWeight: 600 }}>{s.type === 'tool_call' ? `⚙ ${s.tool ?? 'tool'}` : s.type === 'thinking' ? '💭 thinking' : s.type}</div>
                    {s.input && <pre style={pre}>{s.input}</pre>}
                    {s.output && <pre style={{ ...pre, maxHeight: 160 }}>{s.output}</pre>}
                    {s.content && <div style={{ color: 'var(--cr-text)', whiteSpace: 'pre-wrap' }}>{s.content}</div>}
                </div>
            ))}
        </div>
    );
}
const pre = { fontFamily: 'var(--cr-font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--cr-well)', borderRadius: 6, padding: '6px 8px', margin: '4px 0', maxHeight: 100, overflow: 'auto', color: 'var(--cr-text)' } as const;

function TaskCard({ runId, task }: { runId: string; task: Task }) {
    const [open, setOpen] = useState<string | null>(null);
    const spec = TASK_STATUS[task.status] ?? TASK_STATUS.pending;
    return (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 12, color: 'var(--cr-muted)', fontFamily: 'var(--cr-font-mono)', paddingTop: 2 }}>#{task.idx}</span>
                <div style={{ flex: 1, fontSize: 13, color: 'var(--cr-text)', lineHeight: 1.5 }}>{task.objective}</div>
                <Chip spec={spec} />
            </div>

            {(task.checks.length > 0 || task.status === 'leased' || task.status === 'pending') && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(task.checks.length ? task.checks : task.checks_planned.map(k => ({ kind: k, ok: false, detail: 'pending' } as Check))).map((c, i) => (
                        <span key={i} title={c.detail} style={{
                            fontSize: 11, padding: '2px 7px', borderRadius: 5,
                            color: task.checks.length ? (c.ok ? 'var(--cr-green)' : 'var(--cr-error-str)') : 'var(--cr-muted)',
                            background: task.checks.length ? (c.ok ? 'var(--cr-green-low)' : 'var(--cr-error-low)') : 'var(--cr-surface3)',
                        }}>{task.checks.length ? (c.ok ? '✓ ' : '✕ ') : '○ '}{CHECK_LABEL[c.kind] ?? c.kind}</span>
                    ))}
                </div>
            )}

            {task.reason && task.status !== 'accepted' && (
                <div style={{ fontSize: 12, color: task.status === 'dead' ? 'var(--cr-error-str)' : 'var(--cr-muted)', lineHeight: 1.5 }}>
                    {task.status === 'dead' ? 'Why it failed: ' : 'Last attempt: '}{task.reason}
                </div>
            )}

            {task.status === 'accepted' && (
                <div>
                    {task.summary && <div style={{ fontSize: 13, color: 'var(--cr-text)', lineHeight: 1.5, marginBottom: 6 }}>{task.summary}</div>}
                    <pre style={{ ...pre, maxHeight: 220 }}>{JSON.stringify(task.result, null, 2)}</pre>
                    {task.evidence.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--cr-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {task.evidence.map((e, i) => isWebUrl(e)
                                ? <a key={i} href={e} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--cr-accent)', wordBreak: 'break-all' }}>{e}</a>
                                : <span key={i} style={{ wordBreak: 'break-all' }}>{e}</span>)}
                        </div>
                    )}
                </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {task.attempts.map(a => (
                    <div key={a.id}>
                        <div style={{ fontSize: 12, color: 'var(--cr-muted)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span>Attempt {a.n}</span>
                            <span>{a.model?.split('/').pop()}</span>
                            <span>{a.status === 'running' ? 'running…' : a.status}</span>
                            {a.run_s !== null && <span>{dur(a.run_s)}</span>}
                            <span>{money(a.cost_usd)}</span>
                            <button onClick={() => setOpen(open === a.id ? null : a.id)} style={{ fontSize: 11, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-accent)', borderRadius: 5, padding: '1px 7px', cursor: 'pointer' }}>
                                {open === a.id ? 'Hide steps' : 'Show steps'}
                            </button>
                        </div>
                        {a.error && <div style={{ fontSize: 11, color: 'var(--cr-error-str)' }}>{a.error}</div>}
                        {open === a.id && <Transcript runId={runId} attemptId={a.id} />}
                    </div>
                ))}
            </div>
        </div>
    );
}

function RunDetailView({ runId }: { runId: string }) {
    const [data, setData] = useState<RunDetail | null>(null);
    const [missing, setMissing] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/runs/${runId}`);
            if (res.status === 404) { setMissing(true); return; }
            setData(await res.json());
        } catch { /* keep the last view */ }
    }, [runId]);
    const live = data?.run.status === 'running';
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        if (!live) return;
        const t = setInterval(load, 3000);
        return () => clearInterval(t);
    }, [live, load]);

    if (missing) return <div style={{ padding: 32, color: 'var(--cr-muted)' }}>This run doesn't exist, or isn't yours. <Link to="/runs">All runs</Link></div>;
    if (!data) return <div style={{ padding: 32, color: 'var(--cr-muted)', fontSize: 13 }}>Loading…</div>;
    const { run, counts, timing, health, tasks } = data;
    const speedup = timing.wall_s > 0 && timing.work_s > 0 ? timing.work_s / timing.wall_s : 0;

    async function cancel() {
        if (!confirm('Stop this run? Workers are stopped and nothing more is spent.')) return;
        setCancelling(true);
        try { await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' }); await load(); } finally { setCancelling(false); }
    }

    return (
        <div style={{ padding: 32, maxWidth: 900, margin: '0 auto', fontFamily: 'var(--cr-font-sans)' }}>
            <Link to="/runs" style={{ fontSize: 12, color: 'var(--cr-muted)' }}>← All runs</Link>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: '10px 0 6px' }}>
                <h1 style={{ flex: 1, fontSize: 20, fontWeight: 700, color: 'var(--cr-text)', margin: 0, lineHeight: 1.35 }}>{run.goal}</h1>
                <Chip spec={RUN_STATUS[run.status] ?? RUN_STATUS.running} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--cr-muted)', marginBottom: 18, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <Link to={`/agents/${run.agent.id}`} style={{ color: 'var(--cr-accent)' }}>{run.agent.emoji} {run.agent.name}</Link>
                <span>· {when(run.created_at)}</span>
                <span>· {counts.accepted} of {counts.total} accepted{counts.dead ? `, ${counts.dead} failed` : ''}{counts.cancelled ? `, ${counts.cancelled} cancelled` : ''}</span>
                <span>· {money(run.spent_usd)} of {money(run.budget_usd)}</span>
                {timing.wall_s > 0 && <span>· {dur(timing.wall_s)}{speedup >= 1.2 ? ` (${speedup.toFixed(1)}× faster than one after another)` : ''}</span>}
                {live && (
                    <button onClick={cancel} disabled={cancelling} style={{ marginLeft: 'auto', fontSize: 12, border: '1px solid var(--cr-error-str)', color: 'var(--cr-error-str)', background: 'transparent', borderRadius: 7, padding: '4px 10px', cursor: 'pointer' }}>
                        {cancelling ? 'Stopping…' : 'Stop run'}
                    </button>
                )}
            </div>

            {run.status === 'awaiting_approval' && (
                <div style={{ fontSize: 13, padding: '10px 14px', borderRadius: 8, marginBottom: 16, color: 'var(--cr-purple)', background: 'var(--cr-purple-low)', border: '1px solid var(--cr-purple-line)' }}>
                    Nothing has started: this run can spend up to {money(run.budget_usd)}, over the $1 you approve runs above.{' '}
                    <Link to={`/agents/${run.agent.id}`} style={{ color: 'var(--cr-purple)', fontWeight: 600 }}>Approve or reject it in {run.agent.name}'s approvals →</Link>
                </div>
            )}

            {health.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                    {health.map((h, i) => (
                        <div key={i} style={{
                            fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            color: h.severity === 'problem' ? 'var(--cr-error-str)' : 'var(--cr-muted)',
                            background: h.severity === 'problem' ? 'var(--cr-error-low)' : 'var(--cr-surface3)',
                        }}>{h.severity === 'problem' ? '⚠ ' : 'ℹ '}{h.message}</div>
                    ))}
                </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {tasks.map(t => <TaskCard key={t.idx} runId={run.id} task={t} />)}
            </div>
        </div>
    );
}

export default function RunsPage() {
    const { runId } = useParams();
    return runId ? <RunDetailView runId={runId} /> : <RunsList />;
}
