import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CR } from '../lib/cr';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
    id: string;
    name: string;
    chat_jid: string;
    status: 'active' | 'archived';
    created_at: string;
    updated_at: string;
}

interface ProjectAgent {
    id: string;
    name: string;
    emoji?: string;
    status: string;
}

interface SharedFile {
    filename: string;
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api';

async function fetchProjects(): Promise<Project[]> {
    const r = await fetch(`${API}/projects`);
    return r.ok ? r.json() : [];
}

async function fetchProjectAgents(projectId: string): Promise<ProjectAgent[]> {
    const r = await fetch(`${API}/projects/${projectId}/agents`);
    return r.ok ? r.json() : [];
}

async function fetchSharedFileCount(projectId: string): Promise<number> {
    const r = await fetch(`${API}/projects/${projectId}/workspace`);
    if (!r.ok) return 0;
    const files: SharedFile[] = await r.json();
    return files.filter(f => f.filename !== 'BULLETIN.md').length;
}

async function createProject(name: string): Promise<Project | null> {
    const r = await fetch(`${API}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    return r.ok ? r.json() : null;
}

// ─── Project row card ─────────────────────────────────────────────────────────

function ProjectRow({ project }: { project: Project }) {
    const navigate = useNavigate();
    const [agents, setAgents] = useState<ProjectAgent[]>([]);
    const [fileCount, setFileCount] = useState(0);
    const [hovered, setHovered] = useState(false);

    useEffect(() => {
        Promise.all([fetchProjectAgents(project.id), fetchSharedFileCount(project.id)])
            .then(([ag, fc]) => { setAgents(ag); setFileCount(fc); });
    }, [project.id]);

    const runningCount = agents.filter(a => a.status === 'running').length;
    const isArchived = project.status === 'archived';

    return (
        <div
            onClick={() => navigate(`/projects/${project.id}`)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: '18px 22px',
                background: hovered ? 'var(--cr-tint-2)' : CR.bgCard,
                border: `1px solid ${hovered ? CR.borderBright : CR.border}`,
                borderRadius: 12, cursor: 'pointer', transition: 'all 0.15s',
                opacity: isArchived ? 0.65 : 1,
            }}
        >
            {/* Avatar */}
            <div style={{
                width: 42, height: 42, borderRadius: 11, flexShrink: 0,
                background: CR.accentLow, border: `1px solid ${CR.borderBright}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: CR.serif, fontSize: 18, color: CR.accent,
            }}>
                {project.name.slice(0, 1).toUpperCase()}
            </div>

            {/* Name + meta */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontFamily: CR.sans, fontSize: 15, fontWeight: 600, color: CR.cream }}>
                        {project.name}
                    </span>
                    {isArchived && (
                        <span style={{
                            fontFamily: CR.mono, fontSize: 9, color: 'var(--cr-warn)',
                            background: 'var(--cr-amber-low)', border: '1px solid var(--cr-amber-line)',
                            padding: '2px 8px', borderRadius: 100, letterSpacing: '0.08em', textTransform: 'uppercase',
                        }}>Archived</span>
                    )}
                    {runningCount > 0 && (
                        <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.green }}>
                            ● {runningCount} active
                        </span>
                    )}
                </div>
                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted }}>
                    {agents.length} agent{agents.length !== 1 ? 's' : ''} · {fileCount} shared file{fileCount !== 1 ? 's' : ''} · created {project.created_at.slice(0, 10)}
                </div>
            </div>

            {/* Agent avatars */}
            {agents.length > 0 && (
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                    {agents.slice(0, 5).map(a => (
                        <div key={a.id}
                            title={a.name}
                            style={{
                                width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                                background: CR.bgElevated,
                                border: `1px solid ${a.status === 'running' ? CR.green : CR.border}`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 12,
                                boxShadow: a.status === 'running' ? `0 0 5px ${CR.greenLine}` : undefined,
                            }}>
                            {a.emoji ?? '🤖'}
                        </div>
                    ))}
                    {agents.length > 5 && (
                        <div style={{
                            width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                            background: CR.bgElevated, border: `1px solid ${CR.border}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: CR.mono, fontSize: 9, color: CR.muted,
                        }}>+{agents.length - 5}</div>
                    )}
                </div>
            )}

            {/* Chevron */}
            <div style={{ fontFamily: CR.mono, fontSize: 20, color: hovered ? CR.accent : CR.muted, transition: 'color 0.15s', flexShrink: 0 }}>
                ›
            </div>
        </div>
    );
}

// ─── Create modal ─────────────────────────────────────────────────────────────

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');

    const handleCreate = async () => {
        if (!name.trim()) return;
        setSaving(true);
        const p = await createProject(name.trim());
        if (p) { onCreated(p.id); onClose(); }
        else { setErr('Failed to create project'); setSaving(false); }
    };

    return (
        <div
            style={{ position: 'fixed', inset: 0, background: 'var(--cr-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={onClose}
        >
            <div onClick={e => e.stopPropagation()} style={{
                background: CR.bgCard, border: `1px solid ${CR.borderBright}`,
                borderRadius: 14, padding: '32px 36px', width: 420,
                boxShadow: '0 24px 60px var(--cr-shade-3)',
            }}>
                <div style={{ fontFamily: CR.serif, fontSize: 22, color: CR.cream, marginBottom: 20 }}>
                    New Project
                </div>
                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
                    Project Name
                </div>
                <input
                    autoFocus
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                    placeholder="e.g. Crypto Dashboard"
                    style={{
                        width: '100%', boxSizing: 'border-box',
                        background: CR.bgSurf, border: `1px solid ${CR.border}`,
                        color: CR.cream, fontFamily: CR.sans, fontSize: 14,
                        padding: '10px 14px', borderRadius: 7, outline: 'none', marginBottom: 6,
                    }}
                    onFocus={e => e.target.style.borderColor = CR.accent}
                    onBlur={e => e.target.style.borderColor = CR.border}
                />
                {err && <div style={{ fontFamily: CR.mono, fontSize: 11, color: 'var(--cr-error)', marginBottom: 8 }}>{err}</div>}
                <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
                    <button onClick={onClose} style={{
                        background: 'none', border: `1px solid ${CR.border}`, color: CR.sub,
                        fontFamily: CR.mono, fontSize: 12, padding: '8px 20px', borderRadius: 6, cursor: 'pointer',
                    }}>cancel</button>
                    <button onClick={handleCreate} disabled={!name.trim() || saving} style={{
                        background: name.trim() ? CR.accent : CR.muted, border: 'none', color: 'var(--cr-on-accent)',
                        fontFamily: CR.mono, fontSize: 12, padding: '8px 20px', borderRadius: 6,
                        cursor: name.trim() ? 'pointer' : 'not-allowed',
                    }}>
                        {saving ? 'creating…' : 'create project'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
    const navigate = useNavigate();
    const [projects, setProjects] = useState<Project[]>([]);
    const [showCreate, setShowCreate] = useState(false);
    const [filter, setFilter] = useState<'active' | 'all'>('active');

    const reload = useCallback(async () => {
        const all = await fetchProjects();
        setProjects(all);
    }, []);

    useEffect(() => { reload(); }, [reload]);

    const activeCount = projects.filter(p => p.status === 'active').length;
    const visible = filter === 'active' ? projects.filter(p => p.status === 'active') : projects;

    return (
        <div style={{ flex: 1, overflowY: 'auto', background: CR.bgMain, display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{
                padding: '44px 48px 32px',
                background: `linear-gradient(180deg, var(--cr-bg-card-hov) 0%, ${CR.bgMain} 100%)`,
                borderBottom: `1px solid ${CR.border}`,
            }}>
                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>
                    PROJECTS
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                    <div>
                        <h1 style={{ fontFamily: CR.serif, fontSize: 40, fontWeight: 400, color: CR.cream, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
                            Projects
                        </h1>
                        <p style={{ fontFamily: CR.sans, fontSize: 14, color: CR.sub, margin: 0 }}>
                            {activeCount} active · assign agents, view shared workspace, monitor team state
                        </p>
                    </div>
                    <button
                        onClick={() => setShowCreate(true)}
                        style={{
                            background: CR.accent, border: 'none', color: 'var(--cr-on-accent)',
                            fontFamily: CR.mono, fontSize: 12, padding: '10px 20px',
                            borderRadius: 7, cursor: 'pointer', flexShrink: 0,
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = CR.accentWarm}
                        onMouseLeave={e => e.currentTarget.style.background = CR.accent}
                    >
                        + New Project
                    </button>
                </div>
            </div>

            {/* Filter bar */}
            <div style={{ padding: '16px 48px 0', display: 'flex', gap: 8 }}>
                {(['active', 'all'] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)} style={{
                        background: filter === f ? CR.accentLow : 'transparent',
                        border: `1px solid ${filter === f ? CR.borderBright : CR.border}`,
                        color: filter === f ? CR.cream : CR.sub,
                        fontFamily: CR.mono, fontSize: 11, padding: '5px 14px',
                        borderRadius: 5, cursor: 'pointer',
                    }}>
                        {f === 'active' ? `active (${activeCount})` : `all (${projects.length})`}
                    </button>
                ))}
            </div>

            {/* Project list */}
            <div style={{ padding: '24px 48px 40px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visible.length === 0 && (
                    <div style={{ fontFamily: CR.mono, fontSize: 12, color: CR.muted, padding: '48px 0', textAlign: 'center' }}>
                        {filter === 'active' ? 'No active projects — create one to get started.' : 'No projects found.'}
                    </div>
                )}
                {visible.map(p => <ProjectRow key={p.id} project={p} />)}
            </div>

            {showCreate && (
                <CreateProjectModal
                    onClose={() => setShowCreate(false)}
                    onCreated={id => { reload(); navigate(`/projects/${id}`); }}
                />
            )}
        </div>
    );
}

