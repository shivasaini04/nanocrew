import { useEffect, useRef, useState } from 'react';
import { CR, withAlpha } from '../lib/cr';
import { useIsMobile } from '../hooks/useIsMobile';

interface McpServer {
    id: string;
    name: string;
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    enabled: boolean;
    agentIds?: string[];
}

interface CatalogEntry {
    name: string;
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
}

interface TestResult {
    status: 'connected' | 'error';
    toolCount?: number;
    tools?: string[];
    error?: string;
}

const EMPTY_FORM: Omit<McpServer, 'id' | 'enabled'> = {
    name: '', transport: 'stdio', command: '', args: [], env: {}, url: '',
};

export default function McpPage() {
    const isMobile = useIsMobile();
    const [servers, setServers]         = useState<McpServer[]>([]);
    const [catalog, setCatalog]         = useState<CatalogEntry[]>([]);
    const [loading, setLoading]         = useState(true);
    const [showForm, setShowForm]       = useState(false);
    const [editingId, setEditingId]     = useState<string | null>(null);
    const [form, setForm]               = useState({ ...EMPTY_FORM, envRaw: '', argsRaw: '' });
    const [saving, setSaving]           = useState(false);
    const [testResults, setTestResults] = useState<Record<string, TestResult | 'testing'>>({});
    const [error, setError]             = useState<string | null>(null);
    const formRef = useRef<HTMLDivElement>(null);

    // Add/edit/apply-template all open the form, which renders above the server list
    // and catalog — easy to miss if the click happened lower on the page (e.g. a
    // catalog card) and nothing visibly changed in view. Scroll it into frame instead
    // of leaving the user to notice a form opened somewhere off-screen.
    useEffect(() => {
        if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [showForm]);

    async function load() {
        setLoading(true);
        try {
            const [sv, cat] = await Promise.all([
                fetch('/api/mcp/servers').then(r => r.json()),
                fetch('/api/mcp/servers/catalog').then(r => r.json()),
            ]);
            setServers(sv);
            setCatalog(cat);
        } catch { setError('Failed to load MCP servers'); }
        finally { setLoading(false); }
    }

    useEffect(() => { load(); }, []);

    function openNew() {
        setEditingId(null);
        setForm({ ...EMPTY_FORM, envRaw: '', argsRaw: '' });
        setShowForm(true);
    }

    function openEdit(s: McpServer) {
        setEditingId(s.id);
        setForm({
            name: s.name,
            transport: s.transport,
            command: s.command ?? '',
            args: s.args ?? [],
            env: s.env ?? {},
            url: s.url ?? '',
            agentIds: s.agentIds ?? [],
            argsRaw: (s.args ?? []).join(' '),
            envRaw: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        });
        setShowForm(true);
    }

    function applyTemplate(t: CatalogEntry) {
        setEditingId(null);
        setForm({
            name: t.name,
            transport: t.transport,
            command: t.command ?? '',
            args: t.args ?? [],
            env: t.env ?? {},
            url: t.url ?? '',
            argsRaw: (t.args ?? []).join(' '),
            envRaw: Object.entries(t.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        });
        setShowForm(true);
    }

    async function save() {
        setSaving(true);
        setError(null);
        try {
            const args = form.argsRaw.trim() ? form.argsRaw.trim().split(/\s+/) : [];
            const env: Record<string, string> = {};
            for (const line of form.envRaw.split('\n')) {
                const eq = line.indexOf('=');
                if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
            }
            const body: any = {
                name: form.name, transport: form.transport,
                args, env,
                ...(form.transport === 'stdio' ? { command: form.command } : { url: form.url }),
                enabled: true,
            };
            const url = editingId ? `/api/mcp/servers/${editingId}` : '/api/mcp/servers';
            const method = editingId ? 'PATCH' : 'POST';
            const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
            setShowForm(false);
            await load();
        } catch (e: any) { setError(e.message); }
        finally { setSaving(false); }
    }

    async function toggleEnabled(s: McpServer) {
        await fetch(`/api/mcp/servers/${s.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...s, enabled: !s.enabled }),
        });
        await load();
    }

    async function remove(id: string) {
        if (!confirm('Delete this MCP server?')) return;
        await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE' });
        await load();
    }

    async function test(id: string) {
        setTestResults(r => ({ ...r, [id]: 'testing' }));
        try {
            const res = await fetch(`/api/mcp/servers/${id}/test`, { method: 'POST' });
            const data = await res.json();
            setTestResults(r => ({ ...r, [id]: data }));
        } catch (e: any) {
            setTestResults(r => ({ ...r, [id]: { status: 'error', error: e.message } }));
        }
    }

    return (
        <div style={{ fontFamily: CR.sans }}>
            {/* Header — embedded in Account, so no page-level h1/background here */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 16 }}>
                <button onClick={openNew} style={{
                    padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
                    background: 'var(--cr-accent-25)', border: '1px solid var(--cr-accent-60)',
                    color: 'var(--cr-accent)', fontFamily: CR.sans, fontSize: 12, fontWeight: 600,
                }}>+ Add Server</button>
            </div>

            {error && (
                <div style={{ background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--cr-error)', fontSize: 13, marginBottom: 20 }}>
                    {error}
                </div>
            )}

            {/* Add / Edit form */}
            {showForm && (
                <div ref={formRef} style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 28, scrollMarginTop: 16 }}>
                    <h3 style={{ fontFamily: CR.serif, fontSize: 16, fontWeight: 400, color: CR.cream, margin: '0 0 20px' }}>
                        {editingId ? 'Edit Server' : 'Add Server'}
                    </h3>
                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
                        <Field label="Name">
                            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                placeholder="e.g. GitHub" style={inputStyle} />
                        </Field>
                        <Field label="Transport">
                            <select value={form.transport} onChange={e => setForm(f => ({ ...f, transport: e.target.value as any }))} style={inputStyle}>
                                <option value="stdio">stdio (local process)</option>
                                <option value="sse">SSE (remote URL)</option>
                            </select>
                        </Field>
                        {form.transport === 'stdio' ? (
                            <>
                                <Field label="Command">
                                    <input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                                        placeholder="e.g. npx" style={inputStyle} />
                                </Field>
                                <Field label="Args (space-separated)">
                                    <input value={form.argsRaw} onChange={e => setForm(f => ({ ...f, argsRaw: e.target.value }))}
                                        placeholder="-y @modelcontextprotocol/server-github" style={inputStyle} />
                                </Field>
                                <Field label="Env vars (optional — only if this server needs a key/token)" style={{ gridColumn: '1 / -1' }}>
                                    <textarea value={form.envRaw} onChange={e => setForm(f => ({ ...f, envRaw: e.target.value }))}
                                        rows={3} placeholder="Leave blank unless the server needs one, e.g. GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..." style={{ ...inputStyle, resize: 'vertical' }} />
                                </Field>
                            </>
                        ) : (
                            <Field label="URL" style={{ gridColumn: '1 / -1' }}>
                                <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                                    placeholder="https://your-mcp-server.example.com/sse" style={inputStyle} />
                            </Field>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                        <button onClick={save} disabled={saving || !form.name} style={{
                            padding: '7px 18px', borderRadius: 7, cursor: saving ? 'default' : 'pointer',
                            background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)',
                            color: CR.green, fontFamily: CR.sans, fontSize: 12, fontWeight: 600, opacity: saving ? 0.6 : 1,
                        }}>{saving ? 'Saving…' : 'Save'}</button>
                        <button onClick={() => setShowForm(false)} style={{
                            padding: '7px 18px', borderRadius: 7, cursor: 'pointer',
                            background: 'transparent', border: `1px solid ${CR.border}`,
                            color: CR.muted, fontFamily: CR.sans, fontSize: 12,
                        }}>Cancel</button>
                    </div>
                </div>
            )}

            {/* Server list */}
            {loading ? (
                <div style={{ color: CR.muted, fontSize: 13 }}>Loading…</div>
            ) : servers.length === 0 ? (
                <div style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 12, padding: 40, textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>🔌</div>
                    <div style={{ color: CR.cream, fontSize: 15, marginBottom: 6 }}>No MCP servers registered</div>
                    <div style={{ color: CR.muted, fontSize: 13, marginBottom: 20 }}>Add a server above or pick one from the catalog below</div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
                    {servers.map(s => {
                        const tr = testResults[s.id];
                        return (
                            <div key={s.id} style={{
                                background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 10, padding: isMobile ? '14px' : '14px 18px',
                                display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'flex-start', gap: isMobile ? 10 : 16, opacity: s.enabled ? 1 : 0.5,
                            }}>
                                {/* Status dot — inline with mobile's stacked layout, standalone leading column on desktop */}
                                {!isMobile && <div style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: s.enabled ? CR.green : CR.muted }} />}

                                {/* Info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                                        {isMobile && <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: s.enabled ? CR.green : CR.muted }} />}
                                        <span style={{ color: CR.cream, fontSize: 14, fontWeight: 600 }}>{s.name}</span>
                                        <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'var(--cr-tint-4)', color: CR.muted, textTransform: 'uppercase' }}>{s.transport}</span>
                                        {!s.enabled && <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'var(--cr-error-low)', color: 'var(--cr-error)', textTransform: 'uppercase' }}>disabled</span>}
                                    </div>
                                    <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, marginBottom: tr ? 8 : 0 }}>
                                        {s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}
                                    </div>
                                    {tr && tr !== 'testing' && (
                                        <div style={{
                                            marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 12,
                                            background: tr.status === 'connected' ? 'var(--cr-green-low)' : 'var(--cr-error-low)',
                                            border: `1px solid ${tr.status === 'connected' ? 'var(--cr-green-line)' : 'var(--cr-error-line)'}`,
                                            color: tr.status === 'connected' ? CR.green : 'var(--cr-error)',
                                        }}>
                                            {tr.status === 'connected'
                                                ? `Connected — ${tr.toolCount} tool${tr.toolCount !== 1 ? 's' : ''}: ${(tr.tools ?? []).join(', ')}`
                                                : `Error: ${tr.error}`}
                                        </div>
                                    )}
                                </div>

                                {/* Actions */}
                                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center', flexWrap: 'wrap' }}>
                                    <ActionBtn onClick={() => test(s.id)} disabled={tr === 'testing'} color={CR.muted}>
                                        {tr === 'testing' ? '⏳' : '⚡ Test'}
                                    </ActionBtn>
                                    <ActionBtn onClick={() => openEdit(s)} color={CR.muted}>Edit</ActionBtn>
                                    <ActionBtn onClick={() => toggleEnabled(s)} color={s.enabled ? 'var(--cr-amber)' : CR.green}>
                                        {s.enabled ? 'Disable' : 'Enable'}
                                    </ActionBtn>
                                    <ActionBtn onClick={() => remove(s.id)} color='var(--cr-error)'>Delete</ActionBtn>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Catalog */}
            <div>
                <h2 style={{ fontFamily: CR.serif, fontSize: 17, fontWeight: 400, color: CR.cream, margin: '0 0 14px' }}>Well-known servers</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                    {catalog.map((t, i) => (
                        <div key={i} onClick={() => applyTemplate(t)} style={{
                            background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 10,
                            padding: '14px 16px', cursor: 'pointer', transition: 'border-color 0.15s',
                        }}
                            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--cr-accent-60)'}
                            onMouseLeave={e => e.currentTarget.style.borderColor = CR.border}>
                            <div style={{ color: CR.cream, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t.name}</div>
                            <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {t.transport === 'stdio' ? `${t.command} ${(t.args ?? []).join(' ')}` : t.url}
                            </div>
                            <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '2px 7px', borderRadius: 4, background: 'var(--cr-accent-15)', color: 'var(--cr-accent)', textTransform: 'uppercase' }}>
                                {t.transport}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
    return (
        <div style={style}>
            <label style={{ display: 'block', fontSize: 11, color: CR.muted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
            {children}
        </div>
    );
}

function ActionBtn({ onClick, disabled, color, children }: { onClick: () => void; disabled?: boolean; color: string; children: React.ReactNode }) {
    return (
        <button onClick={onClick} disabled={disabled} style={{
            padding: '4px 10px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
            background: 'transparent', border: `1px solid ${withAlpha(color, 19)}`,
            color, fontFamily: CR.sans, fontSize: 11, opacity: disabled ? 0.5 : 1,
        }}>{children}</button>
    );
}

const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 7, boxSizing: 'border-box',
    background: 'var(--cr-tint-3)', border: '1px solid var(--cr-tint-6)',
    color: 'var(--cr-text)', fontFamily: 'monospace', fontSize: 12, outline: 'none',
};

