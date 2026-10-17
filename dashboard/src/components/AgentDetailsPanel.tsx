import { useEffect, useState } from 'react';
import type { Agent, AgentCycle } from '../stores/agentsStore';

interface AgentDetailsPanelProps {
    agent: Agent;
    onChat: () => void;
    onViewMemory?: () => void;
}

interface WeekStats {
    label: string;
    value: string | number;
}

const WEEK_METRICS: Record<string, (cycles: AgentCycle[]) => WeekStats[]> = {
    lead_hunter: (c) => [
        { label: 'Leads found', value: c.reduce((s, x) => s + (x.tasks_done ?? 0), 0) },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
    outreach: (c) => [
        { label: 'Messages sent', value: c.reduce((s, x) => s + (x.tasks_done ?? 0), 0) },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
    followup: (c) => [
        { label: 'Follow-ups sent', value: c.reduce((s, x) => s + (x.tasks_done ?? 0), 0) },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
    market_research: (c) => [
        { label: 'Reports generated', value: c.filter(x => x.status === 'completed').length },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
    analytics: (c) => [
        { label: 'Dashboards updated', value: c.reduce((s, x) => s + (x.tasks_done ?? 0), 0) },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
    content: (c) => [
        { label: 'Posts published', value: c.reduce((s, x) => s + (x.tasks_done ?? 0), 0) },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
    custom: (c) => [
        { label: 'Tasks done', value: c.reduce((s, x) => s + (x.tasks_done ?? 0), 0) },
        { label: 'Cycles run', value: c.length },
        { label: 'Total cost', value: `$${c.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2)}` },
    ],
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: '10px' }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontSize: '13px', fontWeight: 600, color: color ?? 'var(--text-primary)', fontFamily: 'monospace' }}>{value}</span>
        </div>
    );
}

export default function AgentDetailsPanel({ agent, onChat, onViewMemory }: AgentDetailsPanelProps) {
    const [cycles, setCycles] = useState<AgentCycle[]>([]);
    const [memory, setMemory] = useState<{ count: number }>({ count: 0 });

    useEffect(() => {
        fetch(`/api/agents/${agent.id}/cycles?limit=50`)
            .then(r => r.ok ? r.json() : [])
            .then((all: AgentCycle[]) => {
                const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                setCycles(all.filter(c => new Date(c.started_at).getTime() > weekAgo));
            })
            .catch(() => {});
        fetch(`/api/agents/${agent.id}/memory`)
            .then(r => r.ok ? r.json() : [])
            .then((m: any[]) => setMemory({ count: m.length }))
            .catch(() => {});
    }, [agent.id]);

    const lastCycle = cycles[0];
    const metricsFn = WEEK_METRICS[agent.type] ?? WEEK_METRICS.custom;
    const weekStats = metricsFn(cycles);

    // Elapsed time for running cycle
    const elapsed = lastCycle?.status === 'running'
        ? Math.floor((Date.now() - new Date(lastCycle.started_at).getTime()) / 1000)
        : null;

    function formatElapsed(s: number): string {
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60), sec = s % 60;
        return `${m}m ${sec}s`;
    }

    return (
        <div style={{ padding: '16px', overflowY: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>

            {/* Current Task */}
            {agent.status === 'running' && lastCycle?.status === 'running' && (
                <Section title="CURRENT TASK">
                    <div style={{
                        padding: '10px 12px', background: 'var(--cr-cyan-low)',
                        border: '1px solid var(--cr-cyan-line)', borderRadius: 'var(--radius-md)',
                        fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5,
                    }}>
                        <div style={{ fontWeight: 600, color: 'var(--accent-cyan)', marginBottom: '4px', textTransform: 'capitalize' }}>
                            {lastCycle.cycle_type.replace('_', ' ')} cycle
                        </div>
                        <div>{agent.config.goals}</div>
                    </div>
                </Section>
            )}

            {/* Cycle Stats */}
            {lastCycle && (
                <Section title="CYCLE STATS">
                    <Stat label="Tasks done" value={lastCycle.tasks_done ?? 0} color="var(--accent-cyan)" />
                    <Stat label="Cost" value={`$${(lastCycle.cost ?? 0).toFixed(4)}`} />
                    {elapsed !== null && (
                        <Stat label="Elapsed" value={formatElapsed(elapsed)} />
                    )}
                    <Stat label="Status" value={lastCycle.status}
                        color={lastCycle.status === 'completed' ? 'var(--accent-green)' : lastCycle.status === 'failed' ? 'var(--accent-red)' : 'var(--accent-amber)'} />
                    {lastCycle.summary && (
                        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5, fontStyle: 'italic' }}>
                            "{lastCycle.summary}"
                        </div>
                    )}
                </Section>
            )}

            {/* This Week */}
            <Section title="THIS WEEK">
                {weekStats.length === 0 ? (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No cycles this week.</div>
                ) : weekStats.map(s => (
                    <Stat key={s.label} label={s.label} value={s.value} />
                ))}
            </Section>

            {/* Memory Activity */}
            <Section title="MEMORY">
                <Stat label="Stored patterns" value={memory.count} />
                <Stat label="Identity version" value={`v${agent.identity_version}`} />
                <div style={{ marginTop: '8px' }}>
                    {onViewMemory && (
                        <button onClick={onViewMemory} style={{ fontSize: '11px', color: 'var(--accent-cyan)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                            View all memory →
                        </button>
                    )}
                </div>
            </Section>

            {/* Config summary */}
            <Section title="CONFIG">
                <Stat label="Daily budget" value={`$${agent.config.budget.daily}`} />
                <Stat label="Monthly budget" value={`$${agent.config.budget.monthly}`} />
                <Stat label="On exhaust" value={agent.config.budget.onExhaust} />
                {/* `|| 'None'` guards the RESULT, not the ACCESS: an agent whose config
                    has no `tools` throws on .join before `||` is ever reached. No agent
                    trips it today, but it is the same shape as the `config.goals.slice`
                    crash that took the Command Center down on 2026-09-04. */}
                <Stat label="Tools" value={agent.config.tools?.join(', ') || 'None'} />
            </Section>

            {/* Actions */}
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)' }}>
                <button
                    onClick={onChat}
                    style={{
                        padding: '9px', borderRadius: 'var(--radius-md)', width: '100%',
                        background: 'var(--cr-cyan-low)', border: '1px solid var(--cr-cyan-line)',
                        color: 'var(--accent-cyan)', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                    }}
                >
                    💬 Chat with Agent
                </button>
            </div>
        </div>
    );
}
