import { useEffect, useState, useCallback } from 'react';
import { withAlpha } from '../lib/cr';

interface ToolSummary {
    name: string;
    version: string;
    description: string;
    jobId: string | null;
    status: 'healthy' | 'degraded' | 'failed';
    tags: string[];
    createdAt: string;
    lastUsed: string | null;
    usageCount: number;
}

type Tab = 'all' | 'global' | 'stale' | 'degraded';

const STATUS_COLOR: Record<string, string> = {
    healthy: 'var(--cr-green)',
    degraded: 'var(--cr-amber)',
    failed: 'var(--cr-error-str)',
};

function statusBadge(status: string) {
    return (
        <span style={{
            fontSize: '10px',
            fontWeight: 600,
            padding: '2px 7px',
            borderRadius: '999px',
            background: withAlpha(STATUS_COLOR[status], 13),
            color: STATUS_COLOR[status],
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
        }}>{status}</span>
    );
}

function relTime(iso: string | null): string {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

export default function ToolsLibraryPage() {
    const [tab, setTab] = useState<Tab>('all');
    const [tools, setTools] = useState<ToolSummary[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [promoting, setPromoting] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    const fetchTools = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            let url = '/api/tools';
            if (tab === 'global') url = '/api/tools/global';
            else if (tab === 'stale') url = '/api/tools/stale';
            else if (tab === 'degraded') url = '/api/tools/degraded';
            const res = await fetch(url);
            const data = await res.json();
            setTools(data.tools ?? []);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [tab]);

    useEffect(() => { fetchTools(); }, [fetchTools]);

    const filtered = search.trim()
        ? tools.filter(t =>
            t.name.toLowerCase().includes(search.toLowerCase()) ||
            t.description?.toLowerCase().includes(search.toLowerCase()) ||
            t.tags?.some(tag => tag.toLowerCase().includes(search.toLowerCase()))
        )
        : tools;

    async function promote(tool: ToolSummary) {
        if (!tool.jobId) return;
        const key = `${tool.jobId}:${tool.name}`;
        setPromoting(key);
        try {
            const res = await fetch(`/api/tools/${tool.jobId}/${encodeURIComponent(tool.name)}/promote`, { method: 'POST' });
            if (!res.ok) {
                const d = await res.json();
                alert(d.error ?? 'Promote failed');
            } else {
                await fetchTools();
            }
        } finally {
            setPromoting(null);
        }
    }

    async function deleteTool(tool: ToolSummary) {
        if (!tool.jobId) return;
        if (!confirm(`Delete tool "${tool.name}"?`)) return;
        const key = `${tool.jobId}:${tool.name}`;
        setDeleting(key);
        try {
            await fetch(`/api/tools/${tool.jobId}/${encodeURIComponent(tool.name)}`, { method: 'DELETE' });
            await fetchTools();
        } finally {
            setDeleting(null);
        }
    }

    const TABS: { id: Tab; label: string }[] = [
        { id: 'all', label: 'All' },
        { id: 'global', label: 'Global' },
        { id: 'stale', label: 'Stale' },
        { id: 'degraded', label: 'Degraded' },
    ];

    return (
        <div style={{ padding: '32px', maxWidth: '960px', margin: '0 auto', fontFamily: 'var(--cr-font-sans)' }}>
            {/* Header */}
            <div style={{ marginBottom: '24px' }}>
                <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--cr-text)', margin: 0 }}>Tools Library</h1>
                <p style={{ fontSize: '13px', color: 'var(--cr-muted)', marginTop: '4px' }}>
                    Inspect, promote, and manage tools across all agents and jobs.
                </p>
            </div>

            {/* Tabs + Search row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                    {TABS.map(t => (
                        <button
                            key={t.id}
                            onClick={() => { setTab(t.id); setSearch(''); }}
                            style={{
                                padding: '6px 14px',
                                borderRadius: '6px',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: '13px',
                                fontWeight: tab === t.id ? 600 : 400,
                                background: tab === t.id ? 'var(--cr-accent)' : 'var(--cr-surface2)',
                                color: tab === t.id ? 'var(--cr-on-accent)' : 'var(--cr-muted)',
                                transition: 'all 0.15s',
                            }}
                        >{t.label}</button>
                    ))}
                </div>
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search by name, tag…"
                    style={{
                        flex: 1,
                        minWidth: '180px',
                        padding: '7px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--cr-border)',
                        background: 'var(--cr-surface2)',
                        color: 'var(--cr-text)',
                        fontSize: '13px',
                        outline: 'none',
                    }}
                />
                <button
                    onClick={fetchTools}
                    style={{
                        padding: '7px 14px',
                        borderRadius: '6px',
                        border: '1px solid var(--cr-border)',
                        background: 'var(--cr-surface2)',
                        color: 'var(--cr-muted)',
                        cursor: 'pointer',
                        fontSize: '13px',
                    }}
                >Refresh</button>
            </div>

            {/* Content */}
            {loading && (
                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--cr-muted)', fontSize: '13px' }}>Loading…</div>
            )}
            {error && (
                <div style={{ padding: '16px', background: 'var(--cr-error-low)', borderRadius: '8px', color: 'var(--cr-error-str)', fontSize: '13px' }}>{error}</div>
            )}
            {!loading && !error && filtered.length === 0 && (
                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--cr-muted)', fontSize: '13px' }}>
                    No tools found{search ? ` matching "${search}"` : ''}.
                </div>
            )}
            {!loading && !error && filtered.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {filtered.map(tool => {
                        const key = `${tool.jobId ?? 'global'}:${tool.name}`;
                        const isGlobal = tool.jobId === null;
                        const isPromoting = promoting === `${tool.jobId}:${tool.name}`;
                        const isDeleting = deleting === `${tool.jobId}:${tool.name}`;

                        return (
                            <div key={key} style={{
                                background: 'var(--cr-surface2)',
                                borderRadius: '10px',
                                border: '1px solid var(--cr-border)',
                                padding: '16px 20px',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '16px',
                            }}>
                                {/* Left: info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
                                        <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--cr-text)' }}>{tool.name}</span>
                                        <span style={{ fontSize: '11px', color: 'var(--cr-muted)', fontFamily: 'monospace' }}>v{tool.version}</span>
                                        {statusBadge(tool.status)}
                                        {isGlobal && (
                                            <span style={{
                                                fontSize: '10px',
                                                fontWeight: 600,
                                                padding: '2px 7px',
                                                borderRadius: '999px',
                                                background: withAlpha('var(--cr-accent)', 13),
                                                color: 'var(--cr-accent)',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.04em',
                                            }}>global</span>
                                        )}
                                    </div>

                                    {tool.description && (
                                        <p style={{ margin: '0 0 6px', fontSize: '12px', color: 'var(--cr-muted)', lineHeight: 1.5 }}>{tool.description}</p>
                                    )}

                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--cr-muted-br)' }}>
                                        {!isGlobal && (
                                            <span>Job: <code style={{ fontFamily: 'monospace', fontSize: '11px' }}>{tool.jobId}</code></span>
                                        )}
                                        <span>Used {tool.usageCount}×</span>
                                        <span>Last used: {relTime(tool.lastUsed)}</span>
                                        <span>Created: {relTime(tool.createdAt)}</span>
                                    </div>

                                    {tool.tags?.length > 0 && (
                                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' }}>
                                            {tool.tags.map(tag => (
                                                <span key={tag} style={{
                                                    fontSize: '10px',
                                                    padding: '2px 7px',
                                                    borderRadius: '999px',
                                                    background: 'var(--cr-surface3)',
                                                    color: 'var(--cr-muted)',
                                                    border: '1px solid var(--cr-border)',
                                                }}>#{tag}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Right: actions */}
                                {!isGlobal && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flexShrink: 0 }}>
                                        <button
                                            onClick={() => promote(tool)}
                                            disabled={isPromoting}
                                            title="Promote to global — makes this tool available to all agents"
                                            style={{
                                                padding: '5px 12px',
                                                borderRadius: '6px',
                                                border: '1px solid var(--cr-accent)',
                                                background: 'transparent',
                                                color: 'var(--cr-accent)',
                                                fontSize: '12px',
                                                cursor: isPromoting ? 'default' : 'pointer',
                                                opacity: isPromoting ? 0.5 : 1,
                                                whiteSpace: 'nowrap',
                                            }}
                                        >{isPromoting ? 'Promoting…' : '↑ Promote'}</button>
                                        <button
                                            onClick={() => deleteTool(tool)}
                                            disabled={isDeleting}
                                            title="Delete this tool"
                                            style={{
                                                padding: '5px 12px',
                                                borderRadius: '6px',
                                                border: '1px solid var(--cr-error-str)',
                                                background: 'transparent',
                                                color: 'var(--cr-error-str)',
                                                fontSize: '12px',
                                                cursor: isDeleting ? 'default' : 'pointer',
                                                opacity: isDeleting ? 0.5 : 1,
                                                whiteSpace: 'nowrap',
                                            }}
                                        >{isDeleting ? 'Deleting…' : '✕ Delete'}</button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Footer count */}
            {!loading && filtered.length > 0 && (
                <div style={{ marginTop: '16px', fontSize: '12px', color: 'var(--cr-muted)', textAlign: 'right' }}>
                    {filtered.length} tool{filtered.length !== 1 ? 's' : ''}
                    {search ? ` matching "${search}"` : ''}
                </div>
            )}
        </div>
    );
}
