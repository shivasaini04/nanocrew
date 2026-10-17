import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsStore } from '../stores/agentsStore';
import { Plus, Trash2, ArrowRight, Zap, ZapOff, Play, Clock, ChevronDown, RotateCw } from 'lucide-react';
import { withAlpha } from '../lib/cr'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Pipeline {
    id: string;
    name: string;
    enabled: boolean;
    source_agent_id: string | null;
    trigger_cycle_type: string | null;
    trigger_status: 'completed' | 'failed';
    target_agent_id: string;
    target_cycle_type: string;
    inject_output: boolean;
    project_id: string | null;
    created_at: string;
}

interface PipelineRun {
    id: string;
    pipeline_id: string;
    source_cycle_id: string | null;
    target_cycle_id: string | null;
    source_agent_id: string | null;
    source_cycle_type: string | null;
    source_status: 'completed' | 'failed' | null;
    target_agent_id: string;
    target_cycle_type: string;
    project_id: string | null;
    trigger_kind: 'auto' | 'manual';
    status: 'fired' | 'failed' | 'skipped';
    reason: string | null;
    fired_at: string;
}

interface Project {
    id: string;
    name: string;
    status: 'active' | 'archived';
}

// Real CycleType union from src/types.ts — keep in sync.
const CYCLE_TYPES = ['custom', 'work', 'self_improve', 'checkin', 'handoff', 'job_done', 'lead_search', 'send_outreach', 'followup'];

const COLORS = {
    chipBg:    'var(--cr-purple-low)',
    chipBd:    'var(--cr-purple-line)',
    chipFg:    'var(--cr-purple)',
    green:     'var(--cr-green)',
    greenBd:   'var(--cr-green-line)',
    greenBg:   'var(--cr-green-low)',
    red:       'var(--cr-error)',
    redBd:     'var(--cr-error-line)',
    redBg:     'var(--cr-error-low)',
    amber:     'var(--cr-warn)',
    amberBd:   'var(--cr-amber-line)',
    amberBg:   'var(--cr-amber-low)',
};

// ─── Themed dropdown (replaces native <select>) ───────────────────────────────

interface DropdownOption {
    value: string;
    label: string;
    sublabel?: string;
    icon?: string;
}

function Dropdown({ value, options, placeholder, onChange, accent = 'var(--cr-accent)' }: {
    value: string;
    options: DropdownOption[];
    placeholder?: string;
    onChange: (v: string) => void;
    accent?: string;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const picked = options.find(o => o.value === value);

    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [open]);

    return (
        <div ref={ref} style={{ position: 'relative' }}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', borderRadius: 6,
                    background: 'var(--cr-tint-2)',
                    border: `1px solid ${open ? accent : 'var(--cr-border)'}`,
                    color: picked ? 'var(--cr-cream)' : 'var(--cr-muted)',
                    fontFamily: 'var(--cr-font-sans)', fontSize: 13, cursor: 'pointer',
                    transition: 'border 0.15s',
                }}>
                {picked?.icon && <span style={{ fontSize: 13 }}>{picked.icon}</span>}
                <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {picked?.label ?? placeholder ?? 'Select...'}
                </span>
                <ChevronDown size={13} style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none', flexShrink: 0 }} />
            </button>
            {open && (
                <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 200,
                    background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border-bright)',
                    borderRadius: 8, padding: 4, maxHeight: 220, overflowY: 'auto', overflowX: 'hidden',
                    boxShadow: '0 8px 24px var(--cr-shade-3)',
                }}>
                    {options.length === 0 ? (
                        <div style={{ padding: '8px 12px', fontFamily: 'var(--cr-font-sans)', fontSize: 12, color: 'var(--cr-muted)' }}>
                            No options
                        </div>
                    ) : options.map(opt => {
                        const active = opt.value === value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => { onChange(opt.value); setOpen(false); }}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                    padding: '7px 10px', borderRadius: 5, cursor: 'pointer',
                                    background: active ? `${withAlpha(accent, 8)}` : 'transparent',
                                    border: 'none', textAlign: 'left',
                                    fontFamily: 'var(--cr-font-sans)', fontSize: 12.5,
                                    color: active ? 'var(--cr-cream)' : 'var(--cr-text)',
                                }}
                                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--cr-tint-3)'; }}
                                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                                {opt.icon && <span style={{ fontSize: 13 }}>{opt.icon}</span>}
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
                                {opt.sublabel && (
                                    <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)' }}>{opt.sublabel}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Create Modal ─────────────────────────────────────────────────────────────

interface CreateModalProps {
    agents: Array<{ id: string; name: string; emoji?: string }>;
    projects: Project[];
    onClose: () => void;
    onCreated: (p: Pipeline) => void;
}

function CreatePipelineModal({ agents, projects, onClose, onCreated }: CreateModalProps) {
    const [name, setName] = useState('');
    const [sourceAgentId, setSourceAgentId] = useState('');
    const [triggerCycleType, setTriggerCycleType] = useState('');
    const [triggerStatus, setTriggerStatus] = useState<'completed' | 'failed'>('completed');
    const [targetAgentId, setTargetAgentId] = useState('');
    const [targetCycleType, setTargetCycleType] = useState('custom');
    const [projectId, setProjectId] = useState('');
    const [injectOutput, setInjectOutput] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const canSave = name.trim() && targetAgentId;

    const handleSubmit = async () => {
        if (!canSave) return;
        setSaving(true);
        setError('');
        try {
            const r = await fetch('/api/pipelines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    source_agent_id: sourceAgentId || null,
                    trigger_cycle_type: triggerCycleType || null,
                    trigger_status: triggerStatus,
                    target_agent_id: targetAgentId,
                    target_cycle_type: targetCycleType,
                    inject_output: injectOutput,
                    project_id: projectId || null,
                }),
            });
            if (!r.ok) throw new Error((await r.json()).error);
            onCreated(await r.json());
        } catch (e: any) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    const labelStyle: React.CSSProperties = {
        fontFamily: 'var(--cr-font-mono)', fontSize: 9, color: 'var(--cr-muted)',
        textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
        marginBottom: 6, display: 'block',
    };
    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '8px 10px', borderRadius: 6,
        border: '1px solid var(--cr-border)', background: 'var(--cr-tint-2)',
        color: 'var(--cr-cream)', fontFamily: 'var(--cr-font-sans)', fontSize: 13, boxSizing: 'border-box',
    };

    const agentOptions: DropdownOption[] = agents.map(a => ({ value: a.id, label: a.name, icon: a.emoji ?? '🤖' }));
    const cycleOptions: DropdownOption[] = CYCLE_TYPES.map(t => ({ value: t, label: t }));
    const projectOptions: DropdownOption[] = projects.filter(p => p.status !== 'archived').map(p => ({ value: p.id, label: p.name }));

    return (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--cr-scrim)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, backdropFilter: 'blur(4px)' }} onClick={onClose}>
            <div style={{
                background: 'linear-gradient(180deg, var(--cr-bg-card-hov) 0%, var(--cr-bg-card-hov) 100%)',
                border: '1px solid var(--cr-border-bright)', borderRadius: 16,
                width: '100%', maxWidth: 520, padding: 0,
                boxShadow: '0 24px 64px var(--cr-shade-3)',
                display: 'flex', flexDirection: 'column', overflow: 'visible',
            }} onClick={e => e.stopPropagation()}>

                <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--cr-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: COLORS.chipBg, border: `1px solid ${COLORS.chipBd}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Zap size={16} color={COLORS.chipFg} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, color: COLORS.chipFg, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700 }}>New Pipeline</div>
                        <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: 17, color: 'var(--cr-cream)' }}>Automate a workflow</div>
                    </div>
                </div>

                <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                        <label style={labelStyle}>Pipeline Name</label>
                        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Research → Outreach" style={inputStyle} />
                    </div>

                    {/* Trigger section */}
                    <div style={{ padding: 14, borderRadius: 10, border: '1px solid var(--cr-border-sub)', background: 'var(--cr-tint-1)' }}>
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, color: 'var(--cr-accent)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12, fontWeight: 700 }}>When...</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                            <div>
                                <label style={labelStyle}>Source Agent</label>
                                <Dropdown value={sourceAgentId} placeholder="Any agent" onChange={setSourceAgentId}
                                    options={[{ value: '', label: 'Any agent' }, ...agentOptions]} />
                            </div>
                            <div>
                                <label style={labelStyle}>Cycle Type</label>
                                <Dropdown value={triggerCycleType} placeholder="Any type" onChange={setTriggerCycleType}
                                    options={[{ value: '', label: 'Any type' }, ...cycleOptions]} />
                            </div>
                        </div>
                        <div>
                            <label style={labelStyle}>Cycle Status</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                {(['completed', 'failed'] as const).map(s => (
                                    <button key={s} onClick={() => setTriggerStatus(s)} style={{
                                        padding: '5px 14px', borderRadius: 100,
                                        border: '1px solid',
                                        borderColor: triggerStatus === s ? (s === 'completed' ? COLORS.green : COLORS.red) : 'var(--cr-border)',
                                        background: triggerStatus === s ? (s === 'completed' ? COLORS.greenBg : COLORS.redBg) : 'transparent',
                                        color: triggerStatus === s ? (s === 'completed' ? COLORS.green : COLORS.red) : 'var(--cr-muted)',
                                        fontFamily: 'var(--cr-font-mono)', fontSize: 11, cursor: 'pointer', textTransform: 'capitalize',
                                    }}>{s}</button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Arrow */}
                    <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--cr-muted)' }}>
                        <ArrowRight size={18} />
                    </div>

                    {/* Action section */}
                    <div style={{ padding: 14, borderRadius: 10, border: '1px solid var(--cr-border-sub)', background: 'var(--cr-tint-1)' }}>
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, color: COLORS.chipFg, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12, fontWeight: 700 }}>Then trigger...</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                            <div>
                                <label style={labelStyle}>Target Agent *</label>
                                <Dropdown value={targetAgentId} placeholder="Select agent..." onChange={setTargetAgentId}
                                    options={agentOptions} accent={COLORS.chipFg} />
                            </div>
                            <div>
                                <label style={labelStyle}>Cycle Type</label>
                                <Dropdown value={targetCycleType} placeholder="custom" onChange={setTargetCycleType}
                                    options={cycleOptions} accent={COLORS.chipFg} />
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input type="checkbox" id="injectOutput" checked={injectOutput} onChange={e => setInjectOutput(e.target.checked)} style={{ accentColor: 'var(--cr-accent)', width: 14, height: 14 }} />
                            <label htmlFor="injectOutput" style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 12.5, color: 'var(--cr-sub)', cursor: 'pointer' }}>
                                Pass source output as context to target agent
                            </label>
                        </div>
                    </div>

                    {/* Project scope */}
                    <div>
                        <label style={labelStyle}>Project scope (optional)</label>
                        <Dropdown value={projectId} placeholder="Any project — fire regardless of project context" onChange={setProjectId}
                            options={[{ value: '', label: 'Any project — fire regardless of context' }, ...projectOptions]} />
                        <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 11, color: 'var(--cr-muted)', marginTop: 6 }}>
                            When set, this pipeline only fires for source cycles that ran in this specific project.
                        </div>
                    </div>

                    {error && <p style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: COLORS.red, margin: 0 }}>{error}</p>}
                </div>

                {/* Footer */}
                <div style={{ padding: '14px 24px 18px', borderTop: '1px solid var(--cr-border)', display: 'flex', gap: 10, justifyContent: 'flex-end', background: 'var(--cr-well)' }}>
                    <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid var(--cr-border)', background: 'var(--cr-tint-3)', color: 'var(--cr-sub)', fontFamily: 'var(--cr-font-sans)', fontSize: 13, cursor: 'pointer' }}>
                        Cancel
                    </button>
                    <button onClick={handleSubmit} disabled={!canSave || saving} style={{
                        padding: '8px 20px', borderRadius: 8, border: 'none',
                        background: canSave ? 'linear-gradient(135deg, var(--cr-accent), var(--cr-accent-warm))' : 'var(--cr-tint-4)',
                        color: canSave ? 'var(--cr-on-accent)' : 'var(--cr-muted)',
                        fontFamily: 'var(--cr-font-sans)', fontSize: 13, fontWeight: 600,
                        cursor: canSave && !saving ? 'pointer' : 'default',
                        boxShadow: canSave ? '0 4px 14px var(--cr-accent-60)' : 'none',
                    }}>
                        {saving ? 'Creating...' : 'Create Pipeline'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Pipeline Card ────────────────────────────────────────────────────────────

interface PipelineCardProps {
    pipeline: Pipeline;
    agentMap: Record<string, { name: string; emoji?: string }>;
    projectMap: Record<string, { name: string }>;
    onToggle: () => void;
    onDelete: () => void;
    onNavigate: (id: string) => void;
}

function fmtRel(iso: string): string {
    const delta = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

function PipelineCard({ pipeline, agentMap, projectMap, onToggle, onDelete, onNavigate }: PipelineCardProps) {
    const sourceAgent = pipeline.source_agent_id ? agentMap[pipeline.source_agent_id] : null;
    const targetAgent = agentMap[pipeline.target_agent_id];
    const project = pipeline.project_id ? projectMap[pipeline.project_id] : null;
    const [runsOpen, setRunsOpen] = useState(false);
    const [runs, setRuns] = useState<PipelineRun[] | null>(null);
    const [firing, setFiring] = useState(false);
    const [fireMsg, setFireMsg] = useState<string | null>(null);

    const loadRuns = useCallback(async () => {
        try {
            const r = await fetch(`/api/pipelines/${pipeline.id}/runs?limit=20`);
            if (r.ok) setRuns(await r.json());
        } catch { /* silent */ }
    }, [pipeline.id]);

    useEffect(() => {
        if (runsOpen && !runs) loadRuns();
    }, [runsOpen, runs, loadRuns]);

    async function handleFire() {
        if (firing) return;
        setFiring(true); setFireMsg(null);
        try {
            const r = await fetch(`/api/pipelines/${pipeline.id}/fire`, { method: 'POST' });
            if (r.ok) {
                setFireMsg('✓ Fired — see runs below');
                if (runsOpen) await loadRuns();
                else setRunsOpen(true);
            } else {
                const err = (await r.json()).error;
                setFireMsg(`⚠ ${err}`);
            }
        } catch (e: any) {
            setFireMsg(`⚠ ${e.message}`);
        } finally {
            setFiring(false);
            setTimeout(() => setFireMsg(null), 4000);
        }
    }

    return (
        <div style={{
            background: 'var(--cr-bg-card)',
            border: `1px solid ${pipeline.enabled ? 'var(--cr-border)' : 'var(--cr-border-sub)'}`,
            borderRadius: 12, padding: '18px 22px',
            opacity: pipeline.enabled ? 1 : 0.6,
            transition: 'all 0.2s',
        }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: pipeline.enabled ? COLORS.greenBg : 'var(--cr-tint-3)',
                    border: `1px solid ${pipeline.enabled ? COLORS.greenBd : 'var(--cr-border)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    {pipeline.enabled ? <Zap size={15} color={COLORS.green} /> : <ZapOff size={15} color="var(--cr-muted)" />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--cr-font-serif)', fontSize: 16, color: 'var(--cr-cream)' }}>{pipeline.name}</span>
                        {project && (
                            <span title={`Scoped to project: ${project.name}`} style={{
                                fontFamily: 'var(--cr-font-mono)', fontSize: 9, fontWeight: 600,
                                color: COLORS.chipFg, background: COLORS.chipBg, border: `1px solid ${COLORS.chipBd}`,
                                padding: '1px 7px', borderRadius: 100, letterSpacing: '0.05em',
                            }}>🟣 {project.name}</span>
                        )}
                    </div>
                    <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)', marginTop: 2 }}>
                        Created {fmtRel(pipeline.created_at)}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={handleFire} disabled={firing || !pipeline.enabled}
                        title={!pipeline.enabled ? 'Enable the pipeline first' : 'Fire this pipeline as a manual test'}
                        style={{
                            padding: '5px 10px', borderRadius: 6, cursor: pipeline.enabled && !firing ? 'pointer' : 'default',
                            border: `1px solid ${COLORS.chipBd}`, background: COLORS.chipBg,
                            color: COLORS.chipFg, fontFamily: 'var(--cr-font-mono)', fontSize: 10, fontWeight: 700,
                            display: 'flex', alignItems: 'center', gap: 4, opacity: pipeline.enabled && !firing ? 1 : 0.4,
                        }}>
                        <Play size={11} /> {firing ? 'firing…' : 'fire now'}
                    </button>
                    <button onClick={onToggle} style={{
                        padding: '5px 12px', borderRadius: 6, border: '1px solid var(--cr-border)',
                        background: 'transparent', color: pipeline.enabled ? COLORS.green : 'var(--cr-muted)',
                        fontFamily: 'var(--cr-font-mono)', fontSize: 10, cursor: 'pointer', fontWeight: 700, letterSpacing: '0.05em',
                    }}>
                        {pipeline.enabled ? 'ON' : 'OFF'}
                    </button>
                    <button onClick={onDelete} style={{
                        padding: '5px 8px', borderRadius: 6, border: '1px solid var(--cr-border)',
                        background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer',
                        display: 'flex', alignItems: 'center',
                    }}>
                        <Trash2 size={13} />
                    </button>
                </div>
            </div>

            {/* Flow */}
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 10 }}>
                {/* Source */}
                <div
                    onClick={() => pipeline.source_agent_id && onNavigate(pipeline.source_agent_id)}
                    style={{ flex: 1, padding: '10px 14px', borderRadius: 8, background: 'var(--cr-tint-2)', border: '1px solid var(--cr-border-sub)', cursor: pipeline.source_agent_id ? 'pointer' : 'default' }}
                >
                    <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, fontWeight: 600 }}>Trigger</div>
                    <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 13, color: 'var(--cr-cream)' }}>
                        {sourceAgent ? `${sourceAgent.emoji ?? '🤖'} ${sourceAgent.name}` : 'Any agent'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, padding: '2px 7px', borderRadius: 4, background: 'var(--cr-tint-4)', color: 'var(--cr-sub)' }}>
                            {pipeline.trigger_cycle_type ?? 'any cycle type'}
                        </span>
                        <span style={{
                            fontFamily: 'var(--cr-font-mono)', fontSize: 9, padding: '2px 7px', borderRadius: 4,
                            background: pipeline.trigger_status === 'completed' ? COLORS.greenBg : COLORS.redBg,
                            color: pipeline.trigger_status === 'completed' ? COLORS.green : COLORS.red,
                        }}>{pipeline.trigger_status}</span>
                    </div>
                </div>

                {/* Arrow */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, padding: '0 4px' }}>
                    <ArrowRight size={20} color="var(--cr-muted)" />
                    {pipeline.inject_output && (
                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 8, color: 'var(--cr-muted)', textAlign: 'center', letterSpacing: '0.05em' }}>+ output</div>
                    )}
                </div>

                {/* Target */}
                <div
                    onClick={() => onNavigate(pipeline.target_agent_id)}
                    style={{ flex: 1, padding: '10px 14px', borderRadius: 8, background: COLORS.chipBg, border: `1px solid ${COLORS.chipBd}`, cursor: 'pointer' }}
                >
                    <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, color: COLORS.chipFg, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, fontWeight: 600 }}>Fire</div>
                    <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 13, color: 'var(--cr-cream)' }}>
                        {targetAgent ? `${targetAgent.emoji ?? '🤖'} ${targetAgent.name}` : pipeline.target_agent_id}
                    </div>
                    <div style={{ marginTop: 6 }}>
                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 9, padding: '2px 7px', borderRadius: 4, background: 'var(--cr-purple-line)', color: COLORS.chipFg }}>
                            {pipeline.target_cycle_type}
                        </span>
                    </div>
                </div>
            </div>

            {/* Fire feedback */}
            {fireMsg && (
                <div style={{
                    marginTop: 10, padding: '6px 12px', borderRadius: 6,
                    background: fireMsg.startsWith('✓') ? COLORS.greenBg : COLORS.amberBg,
                    border: `1px solid ${fireMsg.startsWith('✓') ? COLORS.greenBd : COLORS.amberBd}`,
                    color: fireMsg.startsWith('✓') ? COLORS.green : COLORS.amber,
                    fontFamily: 'var(--cr-font-mono)', fontSize: 11,
                }}>{fireMsg}</div>
            )}

            {/* Runs section — collapsible */}
            <div style={{ marginTop: 12, borderTop: '1px solid var(--cr-border-sub)', paddingTop: 10 }}>
                <button onClick={() => setRunsOpen(v => !v)} style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                    color: 'var(--cr-muted)', fontFamily: 'var(--cr-font-mono)', fontSize: 10,
                    letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600,
                }}>
                    <Clock size={11} />
                    <span>Run history</span>
                    {runs && <span style={{ color: 'var(--cr-sub)' }}>· {runs.length}</span>}
                    <span style={{ flex: 1 }} />
                    <ChevronDown size={11} style={{ transform: runsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                </button>
                {runsOpen && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
                        <button onClick={loadRuns} title="Refresh"
                            style={{ alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 5, background: 'transparent', border: '1px solid var(--cr-border)', color: 'var(--cr-muted)', cursor: 'pointer', fontFamily: 'var(--cr-font-mono)', fontSize: 9, marginBottom: 2 }}>
                            <RotateCw size={9} /> refresh
                        </button>
                        {runs === null && <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 11, color: 'var(--cr-muted)', padding: '8px 0' }}>Loading…</div>}
                        {runs && runs.length === 0 && (
                            <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 12, color: 'var(--cr-muted)', padding: '12px 0', textAlign: 'center', fontStyle: 'italic' }}>
                                No runs yet. Fire it manually or wait for a matching source cycle.
                            </div>
                        )}
                        {runs && runs.map(r => {
                            const statusColor = r.status === 'fired' ? COLORS.green : r.status === 'failed' ? COLORS.red : COLORS.amber;
                            return (
                                <div key={r.id} style={{
                                    padding: '6px 10px', borderRadius: 6,
                                    background: 'var(--cr-tint-1)', border: '1px solid var(--cr-border-sub)',
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    fontFamily: 'var(--cr-font-mono)', fontSize: 10,
                                }}>
                                    <span style={{ color: statusColor, minWidth: 50, fontWeight: 700 }}>{r.status.toUpperCase()}</span>
                                    <span style={{ color: 'var(--cr-muted)' }}>{fmtRel(r.fired_at)}</span>
                                    <span style={{ color: r.trigger_kind === 'manual' ? COLORS.chipFg : 'var(--cr-sub)' }}>{r.trigger_kind}</span>
                                    {r.target_cycle_id && (
                                        <span title={r.target_cycle_id} style={{ color: 'var(--cr-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                                            → {r.target_cycle_id.slice(0, 8)}…
                                        </span>
                                    )}
                                    {r.reason && (
                                        <span style={{ color: 'var(--cr-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
                                            {r.reason}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PipelinesPage() {
    const navigate = useNavigate();
    const { agents, fetchAgents } = useAgentsStore();
    const [pipelines, setPipelines] = useState<Pipeline[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);

    const agentMap = Object.fromEntries(agents.map(a => [a.id, { name: a.name, emoji: a.emoji }]));
    const projectMap = Object.fromEntries(projects.map(p => [p.id, { name: p.name }]));

    const fetchPipelines = useCallback(async () => {
        try {
            setLoading(true);
            const r = await fetch('/api/pipelines');
            setPipelines(await r.json());
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchProjects = useCallback(async () => {
        try {
            const r = await fetch('/api/projects');
            if (r.ok) setProjects(await r.json());
        } catch { /* silent */ }
    }, []);

    useEffect(() => {
        fetchAgents();
        fetchPipelines();
        fetchProjects();
    }, [fetchAgents, fetchPipelines, fetchProjects]);

    const handleToggle = async (p: Pipeline) => {
        await fetch(`/api/pipelines/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !p.enabled }) });
        setPipelines(prev => prev.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x));
    };

    const handleDelete = async (p: Pipeline) => {
        if (!confirm(`Delete pipeline "${p.name}"?`)) return;
        await fetch(`/api/pipelines/${p.id}`, { method: 'DELETE' });
        setPipelines(prev => prev.filter(x => x.id !== p.id));
    };

    const enabled = pipelines.filter(p => p.enabled);
    const disabled = pipelines.filter(p => !p.enabled);

    return (
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 32 }}>
                <div>
                    <h1 style={{ fontFamily: 'var(--cr-font-serif)', fontSize: 26, color: 'var(--cr-cream)', margin: '0 0 6px' }}>Pipelines</h1>
                    <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 14, color: 'var(--cr-muted)', margin: 0 }}>
                        Automate agent workflows — trigger a cycle on one agent when another completes.
                    </p>
                </div>
                <button onClick={() => setShowCreate(true)} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '9px 18px', borderRadius: 8, border: 'none',
                    background: 'linear-gradient(135deg, var(--cr-accent), var(--cr-accent-warm))',
                    color: 'var(--cr-on-accent)', fontFamily: 'var(--cr-font-sans)', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', boxShadow: '0 4px 14px var(--cr-accent-60)',
                }}>
                    <Plus size={15} /> New Pipeline
                </button>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '60px 0', fontFamily: 'var(--cr-font-mono)', fontSize: 13, color: 'var(--cr-muted)' }}>Loading...</div>
            ) : pipelines.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '80px 0' }}>
                    <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>⚡</div>
                    <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 15, color: 'var(--cr-muted)', marginBottom: 20 }}>No pipelines yet.</p>
                    <button onClick={() => setShowCreate(true)} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', fontFamily: 'var(--cr-font-sans)', fontSize: 13, cursor: 'pointer' }}>
                        Create your first pipeline
                    </button>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {/* Summary bar */}
                    <div style={{ display: 'flex', gap: 20, padding: '12px 16px', borderRadius: 8, background: 'var(--cr-tint-1)', border: '1px solid var(--cr-border-sub)' }}>
                        <div>
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 18, color: 'var(--cr-cream)' }}>{enabled.length}</span>
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)', marginLeft: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Active</span>
                        </div>
                        <div style={{ width: 1, background: 'var(--cr-border)' }} />
                        <div>
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 18, color: 'var(--cr-muted)' }}>{disabled.length}</span>
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)', marginLeft: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Disabled</span>
                        </div>
                    </div>

                    {pipelines.map(p => (
                        <PipelineCard
                            key={p.id}
                            pipeline={p}
                            agentMap={agentMap}
                            projectMap={projectMap}
                            onToggle={() => handleToggle(p)}
                            onDelete={() => handleDelete(p)}
                            onNavigate={id => navigate(`/agents/${id}`)}
                        />
                    ))}
                </div>
            )}

            {showCreate && (
                <CreatePipelineModal
                    agents={agents}
                    projects={projects}
                    onClose={() => setShowCreate(false)}
                    onCreated={p => { setPipelines(prev => [p, ...prev]); setShowCreate(false); }}
                />
            )}
        </div>
    );
}
