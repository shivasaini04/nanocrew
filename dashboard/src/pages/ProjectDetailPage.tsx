import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CR, withAlpha } from '../lib/cr';
import { BrowserLanePicker, useBrowserLane } from '../components/BrowserLanePicker';
import { shouldSkipUploadPath } from '../lib/uploadFilter';
import { useAgentsStore } from '../stores/agentsStore';
import { ArrowLeft, RefreshCw, Trash2, Upload, FolderOpen, X, Users } from 'lucide-react';
import { socket } from '../lib/socket';
import { ChatBubble, type ActivityStep } from '../components/ChatBubble';
import { ActivityDock } from '../components/ActivityDock';
import UniversalDrawer from '../components/UniversalDrawer';
import { StreamingTurn } from '../components/StreamingTurn';
import { TurnFiles, type TurnFile } from '../components/TurnFiles';
import { useIsMobile } from '../hooks/useIsMobile';
import { useConversationEvents } from '../hooks/useConversationEvents';
import { ConversationView } from '../components/ConversationView';
import { FLAGS } from '../lib/flags';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
    id: string;
    name: string;
    chat_jid: string;
    status: 'active' | 'archived';
    lead_agent_id?: string | null;
    created_at: string;
    updated_at: string;
}

interface ProjectAgent {
    id: string;
    name: string;
    emoji?: string;
    status: string;
    role?: string;
    last_active?: string;
}

interface SharedFile {
    filename: string;
    content: string;
    sizeBytes: number;
    modifiedAt: string;
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api';

async function fetchProject(id: string): Promise<Project | null> {
    const r = await fetch(`${API}/projects/${id}`);
    return r.ok ? r.json() : null;
}

async function fetchProjectAgents(id: string): Promise<ProjectAgent[]> {
    const r = await fetch(`${API}/projects/${id}/agents`);
    return r.ok ? r.json() : [];
}

async function fetchWorkspace(id: string): Promise<SharedFile[]> {
    const r = await fetch(`${API}/projects/${id}/workspace`);
    return r.ok ? r.json() : [];
}

async function assignAgent(projectId: string, agentId: string, role: string) {
    await fetch(`${API}/projects/${projectId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, role: role.trim() || undefined }),
    });
}

async function removeAgent(projectId: string, agentId: string) {
    await fetch(`${API}/projects/${projectId}/agents/${agentId}`, { method: 'DELETE' });
}

async function patchProject(id: string, body: object): Promise<Project | null> {
    const r = await fetch(`${API}/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return r.ok ? r.json() : null;
}

async function deleteFile(projectId: string, filePath: string) {
    return fetch(`${API}/projects/${projectId}/workspace/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
}

// ─── File tree ────────────────────────────────────────────────────────────────

type ProjNode =
    | { kind: 'file'; name: string; file: SharedFile }
    | { kind: 'dir'; name: string; path: string; children: ProjNode[] };

function buildTree(files: SharedFile[]): ProjNode[] {
    const roots: ProjNode[] = [];
    for (const f of files) {
        const parts = String(f.filename).split('/').filter(Boolean);
        let level = roots;
        for (let i = 0; i < parts.length - 1; i++) {
            const dirPath = parts.slice(0, i + 1).join('/');
            let dir = level.find(n => n.kind === 'dir' && n.name === parts[i]) as Extract<ProjNode, { kind: 'dir' }> | undefined;
            if (!dir) { dir = { kind: 'dir', name: parts[i], path: dirPath, children: [] }; level.push(dir); }
            level = dir.children;
        }
        level.push({ kind: 'file', name: parts[parts.length - 1] || f.filename, file: f });
    }
    const sort = (nodes: ProjNode[]) => {
        nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
        nodes.forEach(n => { if (n.kind === 'dir') sort(n.children); });
    };
    sort(roots);
    return roots;
}

function fileExt(name: string) { return name.split('.').pop()?.toLowerCase() ?? ''; }

function fileIcon(name: string) {
    const ext = fileExt(name);
    if (['md', 'txt'].includes(ext)) return '📄';
    if (['py', 'js', 'ts', 'tsx', 'jsx'].includes(ext)) return '🐍';
    if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '⚙️';
    if (['csv', 'tsv'].includes(ext)) return '📊';
    if (['pdf'].includes(ext)) return '📕';
    if (['html', 'css'].includes(ext)) return '🌐';
    return '📄';
}

// ─── Workspace Tab ────────────────────────────────────────────────────────────

function WorkspaceTab({ projectId, files, onRefresh, onOpenFile }: { projectId: string; files: SharedFile[]; onRefresh: () => void; onOpenFile: (file: SharedFile) => void }) {
    const isMobile = useIsMobile();
    const [collapsed, setCollapsed] = useState<Set<string>>(() => {
        try { const s = localStorage.getItem(`ws-collapsed-${projectId}`); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
    });
    useEffect(() => { localStorage.setItem(`ws-collapsed-${projectId}`, JSON.stringify([...collapsed])); }, [collapsed, projectId]);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const workspaceFiles = files.filter(f => f.filename !== 'BULLETIN.md');

    async function handleDelete(filename: string, isDir = false) {
        if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${filename}"${isDir ? ' and everything inside it' : ''}?`)) return;
        setDeleting(filename);
        const r = await deleteFile(projectId, filename);
        if (r.ok) { showToast('🗑 Deleted'); onRefresh(); } else showToast('⚠  Delete failed');
        setDeleting(null);
    }
    function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3000); }
    async function uploadFiles(fl: FileList | null) {
        if (!fl || fl.length === 0) return;
        const fd = new FormData();
        const paths: string[] = [];
        for (const f of Array.from(fl)) {
            const rel = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath || f.name;
            if (shouldSkipUploadPath(rel)) continue;
            paths.push(rel);
            fd.append('files', f, f.name);
        }
        if (paths.length === 0) { showToast('⚠  Nothing to upload (only generated/vendor files were selected)'); return; }
        fd.append('paths', JSON.stringify(paths));
        setUploading(true);
        try {
            const res = await fetch(`${API}/projects/${projectId}/workspace/files`, { method: 'POST', body: fd });
            const d = await res.json().catch(() => ({}));
            if (res.ok) { showToast(`✅ Added ${(d.added || []).length} file(s)`); onRefresh(); } else showToast(`⚠  ${d.error || 'Upload failed'}`);
        } catch { showToast('⚠  Upload failed'); }
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (folderInputRef.current) folderInputRef.current.value = '';
    }

    const renderNodes = (nodes: ProjNode[], depth: number): React.ReactNode =>
        nodes.map(node => {
            const indentPad = 12 + depth * 20;
            if (node.kind === 'dir') {
                const isOpen = !collapsed.has(node.path);
                return (
                    <div key={'d:' + node.path} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div onClick={() => setCollapsed(prev => { const n = new Set(prev); if (isOpen) n.add(node.path); else n.delete(node.path); return n; })}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', paddingLeft: indentPad, cursor: 'pointer', borderRadius: 7, background: 'var(--cr-tint-1)', border: `1px solid ${CR.border}` }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-tint-3)'} onMouseLeave={e => e.currentTarget.style.background = 'var(--cr-tint-1)'}>
                            <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted, width: 9 }}>{isOpen ? '▾' : '▸'}</span>
                            <span style={{ fontSize: 13 }}>{isOpen ? '📂' : '📁'}</span>
                            <span style={{ flex: 1, fontFamily: CR.mono, fontSize: 12, color: CR.text }}>{node.name}</span>
                            <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted }}>{node.children.reduce((s, c) => s + (c.kind === 'file' ? 1 : 0), 0)} files</span>
                            <button onClick={e => { e.stopPropagation(); handleDelete(node.path, true); }} disabled={deleting === node.path} title="Delete folder"
                                style={{ background: 'none', border: '1px solid transparent', color: CR.muted, cursor: 'pointer', padding: '2px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: deleting === node.path ? 0.4 : 0.6, transition: 'all 0.12s' }}
                                onMouseEnter={e => { e.currentTarget.style.color = 'var(--cr-error)'; e.currentTarget.style.borderColor = 'var(--cr-error)'; e.currentTarget.style.opacity = '1'; }}
                                onMouseLeave={e => { e.currentTarget.style.color = CR.muted; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.opacity = '0.6'; }}><Trash2 size={12} /></button>
                        </div>
                        {isOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 8 }}>{renderNodes(node.children, depth + 1)}</div>}
                    </div>
                );
            }
            const f = node.file;
            return (
                <div key={'f:' + f.filename} onClick={() => onOpenFile(f)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', paddingLeft: indentPad, borderRadius: 7, cursor: 'pointer', background: 'var(--cr-tint-1)', border: `1px solid ${CR.border}`, transition: 'all 0.12s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-tint-4)'} onMouseLeave={e => e.currentTarget.style.background = 'var(--cr-tint-1)'}>
                    <span style={{ fontSize: 13 }}>{fileIcon(node.name)}</span>
                    <span style={{ flex: 1, minWidth: 0, fontFamily: CR.mono, fontSize: 12, color: CR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, flexShrink: 0 }}>{f.sizeBytes < 1024 ? `${f.sizeBytes}B` : `${(f.sizeBytes / 1024).toFixed(1)}kb`}</span>
                    {!isMobile && <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, minWidth: 110, textAlign: 'right', flexShrink: 0 }}>{f.modifiedAt.slice(0, 16).replace('T', ' ')}</span>}
                    <button onClick={e => { e.stopPropagation(); handleDelete(f.filename); }} disabled={deleting === f.filename} title="Delete file"
                        style={{ background: 'none', border: '1px solid transparent', color: CR.muted, cursor: 'pointer', padding: '2px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: deleting === f.filename ? 0.4 : 0.6, transition: 'all 0.12s' }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--cr-error)'; e.currentTarget.style.borderColor = 'var(--cr-error)'; e.currentTarget.style.opacity = '1'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = CR.muted; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.opacity = '0.6'; }}><Trash2 size={12} /></button>
                </div>
            );
        });

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1, minWidth: 140 }}>Shared Workspace — {workspaceFiles.length} file{workspaceFiles.length !== 1 ? 's' : ''}</div>
                {toast && <span style={{ fontFamily: CR.mono, fontSize: 11, color: CR.sub }}>{toast}</span>}
                <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={e => uploadFiles(e.target.files)} />
                <input ref={folderInputRef} type="file" multiple style={{ display: 'none' }} {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={e => uploadFiles(e.target.files)} />
                <button onClick={() => folderInputRef.current?.click()} disabled={uploading} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${CR.border}`, color: CR.sub, cursor: uploading ? 'default' : 'pointer', fontFamily: CR.mono, fontSize: 11, padding: '5px 12px', borderRadius: 6 }} onMouseEnter={e => { e.currentTarget.style.borderColor = CR.borderBright; e.currentTarget.style.color = CR.cream; }} onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.color = CR.sub; }}><FolderOpen size={12} /> + Folder</button>
                <button onClick={() => fileInputRef.current?.click()} disabled={uploading} style={{ display: 'flex', alignItems: 'center', gap: 6, background: CR.accent, border: 'none', color: 'var(--cr-on-accent)', cursor: uploading ? 'default' : 'pointer', fontFamily: CR.mono, fontSize: 11, padding: '5px 12px', borderRadius: 6 }} onMouseEnter={e => e.currentTarget.style.background = CR.accentWarm} onMouseLeave={e => e.currentTarget.style.background = CR.accent}><Upload size={12} /> {uploading ? 'uploading…' : '+ Add Files'}</button>
            </div>
            {workspaceFiles.length === 0 ? (
                <div style={{ padding: '48px 0', textAlign: 'center', fontFamily: CR.mono, fontSize: 12, color: CR.muted }}>No files yet — upload above or agents write to /workspace/shared/</div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{renderNodes(buildTree(workspaceFiles), 0)}</div>
            )}
        </div>
    );
}

interface ProjectWaInfo {
    state: string;
    connected: boolean;
    number: string | null;
    groups: Array<{ id: string; jid: string; name: string; enabled: boolean; triggerMode: 'mention' | 'all' }>;
    availableGroups: Array<{ jid: string; name: string }>;
}

function ProjectChannelsTab({ projectId }: { projectId: string }) {
    const [info, setInfo] = useState<ProjectWaInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');
    const [selectedGroupJid, setSelectedGroupJid] = useState('');

    const load = () => fetch(`/api/projects/${projectId}/channels/whatsapp/groups`)
        .then(r => r.ok ? r.json() : null)
        .then(setInfo)
        .catch(() => {})
        .finally(() => setLoading(false));

    useEffect(() => { setLoading(true); load(); }, [projectId]);

    async function addGroup() {
        if (!selectedGroupJid) return;
        setSaving(true); setErr('');
        try {
            const res = await fetch(`/api/projects/${projectId}/channels/whatsapp/groups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ groupJid: selectedGroupJid }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to link group'); }
            setSelectedGroupJid('');
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally { setSaving(false); }
    }

    async function toggleGroup(groupJid: string, enabled: boolean, triggerMode?: 'mention' | 'all') {
        setSaving(true); setErr('');
        setInfo(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                groups: prev.groups.map(g => g.jid === groupJid ? { ...g, enabled, triggerMode: triggerMode || g.triggerMode } : g)
            };
        });
        try {
            const res = await fetch(`/api/projects/${projectId}/channels/whatsapp/groups/${groupJid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, triggerMode }),
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to toggle group'); }
        } catch (e: any) {
            setErr(e.message);
            await load();
        } finally { setSaving(false); }
    }

    async function removeGroup(groupJid: string) {
        if (!confirm('Are you sure you want to unlink this group from the project?')) return;
        setSaving(true); setErr('');
        try {
            const res = await fetch(`/api/projects/${projectId}/channels/whatsapp/groups/${groupJid}`, {
                method: 'DELETE',
            });
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to unlink group'); }
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally { setSaving(false); }
    }

    if (loading) return <div style={{ padding: '20px 40px', fontSize: 13, color: CR.muted }}>Loading…</div>;

    const connected = !!info?.connected;

    return (
        <div style={{ padding: '20px 40px' }}>
            <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, color: CR.sub, maxWidth: 560 }}>
                    Link WhatsApp groups to this project. All agents assigned to this project can be mentioned in the linked groups and will work in this project's shared workspace.
                </div>
            </div>

            {/* WhatsApp */}
            <div style={{ borderRadius: 12, background: CR.bgSurf, border: `1px solid ${CR.border}`, padding: 20, marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                    <span style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(37,211,102,0.12)', border: '1px solid rgba(37,211,102,0.30)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>💬</span>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: CR.cream }}>WhatsApp Integration</div>
                        <div style={{ fontSize: 11.5, color: connected ? 'var(--cr-brand-whatsapp)' : CR.muted }}>
                            {connected ? `Connected — ${info?.number ?? ''}` : 'Not connected'}
                        </div>
                    </div>
                </div>

                {!connected ? (
                    <div style={{ fontSize: 12, color: CR.sub, lineHeight: 1.6 }}>
                        Link your WhatsApp once in <strong style={{ color: CR.cream }}>Account → WhatsApp</strong> to manage project groups.
                    </div>
                ) : (
                    <>
                        <div style={{ fontSize: 13, fontWeight: 600, color: CR.cream, marginBottom: 12, borderTop: `1px solid ${CR.border}`, paddingTop: 16 }}>Linked Groups</div>
                        
                        {info?.groups && info.groups.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                                {info.groups.map(g => (
                                    <div key={g.jid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 8, background: CR.bgCard, border: `1px solid ${CR.border}` }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <span style={{ fontSize: 16 }}>👥</span>
                                            <div>
                                                <div style={{ fontSize: 12.5, fontWeight: 600, color: CR.cream }}>{g.name}</div>
                                                <div style={{ fontSize: 10.5, color: CR.muted, fontFamily: CR.mono }}>{g.jid}</div>
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                            {g.enabled && (
                                                <select
                                                    value={g.triggerMode || 'mention'}
                                                    onChange={(e) => toggleGroup(g.jid, true, e.target.value as 'mention' | 'all')}
                                                    disabled={saving}
                                                    style={{
                                                        height: 24, borderRadius: 4, background: CR.bgCard, border: `1px solid ${CR.border}`,
                                                        color: CR.cream, fontSize: 11.5, padding: '0 4px', outline: 'none', cursor: 'pointer'
                                                    }}
                                                >
                                                    <option value="mention">Mentions Only</option>
                                                    <option value="all">All Messages</option>
                                                </select>
                                            )}
                                            <button
                                                onClick={() => toggleGroup(g.jid, !g.enabled)}
                                                disabled={saving}
                                                aria-label={`Toggle group ${g.name}`}
                                                style={{
                                                    width: 36, height: 20, borderRadius: 10, border: 'none', cursor: saving ? 'default' : 'pointer',
                                                    background: g.enabled ? 'var(--cr-brand-whatsapp)' : CR.border, position: 'relative', transition: 'background 0.18s', opacity: saving ? 0.6 : 1,
                                                }}
                                            >
                                                <span style={{ position: 'absolute', top: 2, left: g.enabled ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'var(--cr-cream)', transition: 'left 0.18s' }} />
                                            </button>
                                            <button
                                                onClick={() => removeGroup(g.jid)}
                                                disabled={saving}
                                                aria-label={`Remove group ${g.name}`}
                                                style={{
                                                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--cr-error-str)', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    opacity: saving ? 0.5 : 0.8,
                                                }}
                                            >
                                                🗑️
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ fontSize: 12, color: CR.muted, marginBottom: 16 }}>No WhatsApp groups are linked to this project yet.</div>
                        )}

                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: `1px solid ${CR.border}`, paddingTop: 16 }}>
                            {info?.availableGroups && info.availableGroups.length > 0 ? (
                                <>
                                    <select
                                        value={selectedGroupJid}
                                        onChange={(e) => setSelectedGroupJid(e.target.value)}
                                        style={{
                                            flex: 1, height: 32, borderRadius: 6, background: CR.bgCard, border: `1px solid ${CR.border}`,
                                            color: CR.cream, fontSize: 12.5, padding: '0 8px', outline: 'none', cursor: 'pointer'
                                        }}
                                    >
                                        <option value="">-- Link a WhatsApp group --</option>
                                        {info.availableGroups
                                            .filter(g => !info.groups.some(bg => bg.jid === g.jid))
                                            .map(g => (
                                                <option key={g.jid} value={g.jid}>{g.name}</option>
                                            ))
                                        }
                                    </select>
                                    <button
                                        onClick={addGroup}
                                        disabled={saving || !selectedGroupJid}
                                        style={{
                                            height: 32, padding: '0 14px', borderRadius: 6, background: selectedGroupJid ? 'var(--cr-brand-whatsapp)' : CR.border,
                                            color: selectedGroupJid ? '#000' : CR.muted, fontSize: 12.5, fontWeight: 600, border: 'none',
                                            cursor: (saving || !selectedGroupJid) ? 'default' : 'pointer', opacity: (saving || !selectedGroupJid) ? 0.6 : 1
                                        }}
                                    >
                                        Link Group
                                    </button>
                                </>
                            ) : (
                                <div style={{ fontSize: 12, color: CR.muted }}>No WhatsApp groups found to link.</div>
                            )}
                        </div>
                    </>
                )}

                {err && <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--cr-error-str)' }}>{err}</div>}
            </div>
        </div>
    );
}

// ─── Agents Tab ───────────────────────────────────────────────────────────────

function AgentsTab({ projectId, agents, leadAgentId, onLeadSet, onRefresh }: { projectId: string; agents: ProjectAgent[]; leadAgentId?: string | null; onLeadSet: (agentId: string | null) => void; onRefresh: () => void }) {
    const navigate = useNavigate();
    const { agents: allAgents } = useAgentsStore();
    const [selectedId, setSelectedId] = useState('');
    const [role, setRole] = useState('');
    const [saving, setSaving] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);
    const [settingLead, setSettingLead] = useState<string | null>(null);
    const [leadError, setLeadError] = useState<string | null>(null);

    async function handleSetLead(agentId: string | null) {
        setSettingLead(agentId ?? 'clear');
        setLeadError(null);
        try {
            const r = await fetch(`${API}/projects/${projectId}/lead-agent`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) });
            if (r.ok) {
                onLeadSet(agentId ?? null);
            } else {
                const body = await r.json().catch(() => ({}));
                setLeadError(body.error ?? `Error ${r.status}`);
            }
        } catch (err: any) {
            setLeadError(err.message ?? 'Network error');
        } finally {
            setSettingLead(null);
        }
    }
    const existingIds = new Set(agents.map(a => a.id));
    const available = allAgents.filter(a => !existingIds.has(a.id));
    async function handleAssign() {
        if (!selectedId) return; setSaving(true);
        await assignAgent(projectId, selectedId, role); setSelectedId(''); setRole(''); setSaving(false); onRefresh();
    }
    async function handleRemove(agentId: string) {
        setRemoving(agentId); await removeAgent(projectId, agentId); setRemoving(null); onRefresh();
    }

    return (
        <div>
            <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 14 }}>Assigned Agents — {agents.length}</div>
            {agents.length === 0 ? (
                <div style={{ fontFamily: CR.mono, fontSize: 12, color: CR.muted, padding: '20px 0', marginBottom: 24 }}>No agents assigned yet.</div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
                    {agents.map(agent => (
                        <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--cr-tint-1)', borderRadius: 9, border: `1px solid ${CR.border}` }}>
                            <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: CR.accentLow, border: `1px solid ${CR.borderBright}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{agent.emoji ?? '🤖'}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontFamily: CR.sans, fontSize: 14, color: CR.cream, fontWeight: 500 }}>{agent.name}</div>
                                {agent.role && <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.sub, marginTop: 2 }}>{agent.role}</div>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 7, height: 7, borderRadius: '50%', background: agent.status === 'running' ? CR.green : agent.status === 'error' ? 'var(--cr-error)' : CR.muted, boxShadow: agent.status === 'running' ? `0 0 6px ${CR.green}` : undefined }} />
                                <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.sub }}>{agent.status}</span>
                            </div>
                            {leadAgentId === agent.id ? (
                                <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.accent, background: CR.accentLow, border: `1px solid ${CR.borderBright}`, padding: '3px 8px', borderRadius: 5 }}>★ lead</span>
                            ) : (
                                <button onClick={() => handleSetLead(agent.id)} disabled={!!settingLead}
                                    style={{ background: 'none', border: `1px solid ${leadError ? 'var(--cr-error)' : CR.border}`, color: leadError ? 'var(--cr-error)' : CR.muted, fontFamily: CR.mono, fontSize: 10, padding: '4px 10px', borderRadius: 5, cursor: settingLead ? 'not-allowed' : 'pointer', opacity: settingLead ? 0.5 : 1 }}
                                    onMouseEnter={e => { if (!settingLead) { e.currentTarget.style.borderColor = CR.accent; e.currentTarget.style.color = CR.accent; } }}
                                    onMouseLeave={e => { if (!settingLead) { e.currentTarget.style.borderColor = leadError ? 'var(--cr-error)' : CR.border; e.currentTarget.style.color = leadError ? 'var(--cr-error)' : CR.muted; } }}
                                >{settingLead === agent.id ? '…' : leadError ? '✗' : 'set lead'}</button>
                            )}
                            <button onClick={() => navigate(`/chat?agent=${agent.id}`)} style={{ background: 'none', border: `1px solid ${CR.border}`, color: CR.sub, fontFamily: CR.mono, fontSize: 10, padding: '4px 10px', borderRadius: 5, cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.borderColor = CR.accent; e.currentTarget.style.color = CR.cream; }} onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.color = CR.sub; }}>chat →</button>
                            <button onClick={() => handleRemove(agent.id)} disabled={removing === agent.id} style={{ background: 'none', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.mono, fontSize: 10, padding: '4px 10px', borderRadius: 5, cursor: removing === agent.id ? 'not-allowed' : 'pointer', opacity: removing === agent.id ? 0.5 : 1 }} onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--cr-error)'; e.currentTarget.style.color = 'var(--cr-error)'; }} onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.color = CR.muted; }}>{removing === agent.id ? '…' : 'remove'}</button>
                        </div>
                    ))}
                </div>
            )}
            <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>Add Agent</div>
            {available.length === 0 ? (
                <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted }}>All agents are already assigned to this project.</div>
            ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select value={selectedId} onChange={e => setSelectedId(e.target.value)} style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, color: CR.text, fontFamily: CR.mono, fontSize: 12, padding: '7px 12px', borderRadius: 6, flex: '1 1 180px', minWidth: 0 }}>
                        <option value="">— select agent —</option>
                        {available.map(a => <option key={a.id} value={a.id}>{a.emoji ?? '🤖'} {a.name}</option>)}
                    </select>
                    <input value={role} onChange={e => setRole(e.target.value)} placeholder="role (optional)" style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, color: CR.text, fontFamily: CR.mono, fontSize: 12, padding: '7px 12px', borderRadius: 6, flex: '1 1 140px', minWidth: 0, outline: 'none' }} onFocus={e => e.target.style.borderColor = CR.accent} onBlur={e => e.target.style.borderColor = CR.border} />
                    <button onClick={handleAssign} disabled={!selectedId || saving} style={{ background: selectedId ? CR.accent : CR.muted, color: 'var(--cr-on-accent)', border: 'none', fontFamily: CR.mono, fontSize: 11, padding: '7px 16px', borderRadius: 6, cursor: selectedId ? 'pointer' : 'not-allowed', flexShrink: 0 }} onMouseEnter={e => { if (selectedId) e.currentTarget.style.background = CR.accentWarm; }} onMouseLeave={e => { if (selectedId) e.currentTarget.style.background = CR.accent; }}>{saving ? 'adding…' : 'add to project'}</button>
                </div>
            )}
        </div>
    );
}

// ─── Bulletin Tab ─────────────────────────────────────────────────────────────

function BulletinTab({ bulletin, onRefresh }: { bulletin: string | null; onRefresh: () => void }) {
    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>BULLETIN.md — Project Status Board</div>
                <button onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.mono, fontSize: 11, padding: '5px 12px', borderRadius: 6, cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.color = CR.cream; e.currentTarget.style.borderColor = CR.borderBright; }} onMouseLeave={e => { e.currentTarget.style.color = CR.muted; e.currentTarget.style.borderColor = CR.border; }}><RefreshCw size={11} /> refresh</button>
            </div>
            {!bulletin ? (
                <div style={{ padding: '48px 0', textAlign: 'center', fontFamily: CR.mono, fontSize: 12, color: CR.muted, lineHeight: 1.7 }}>No bulletin yet.<br />Written automatically after the first agent cycle.</div>
            ) : (
                <div style={{ background: CR.bgSurf, border: `1px solid ${CR.border}`, borderRadius: 10, padding: '20px 24px', maxHeight: 520, overflowY: 'auto' }}>
                    <div className="md-prose" style={{ fontFamily: CR.sans, fontSize: 13, color: CR.text, lineHeight: 1.65 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{bulletin}</ReactMarkdown></div>
                </div>
            )}
        </div>
    );
}

// ─── Unified Drawer state ────────────────────────────────────────────────────

type InlineDrawerState =
    | null
    | { kind: 'files' }
    | { kind: 'manage'; initialTab?: 'team' | 'bulletin' };

// ─── ManageDrawer removed (#11) — Team + Bulletin now live in UniversalDrawer via extraTabs ───

// ─── Slash commands ───────────────────────────────────────────────────────────

const SLASH_COMMANDS: Array<{ cmd: string; label: string; description: string; category: string; icon: string; action: 'execute' | 'fill'; fillText?: string }> = [
    { cmd: 'bulletin', label: 'Bulletin Board', description: 'Open the project bulletin.', icon: '📋', action: 'execute', category: 'Views' },
    { cmd: 'files', label: 'Shared Workspace', description: 'Browse shared workspace files.', icon: '📁', action: 'execute', category: 'Views' },
    { cmd: 'team', label: 'Team', description: 'View project team members.', icon: '👥', action: 'execute', category: 'Views' },
    { cmd: 'broadcast', label: 'Broadcast to All', description: 'Send a message to all project agents.', icon: '📢', action: 'fill', fillText: '@all ', category: 'Actions' },
    { cmd: 'manage', label: 'Manage Project', description: 'Open the project management panel.', icon: '⚙️', action: 'execute', category: 'Actions' },
    { cmd: 'clear', label: 'Clear Chat', description: 'Clear this project chat history.', icon: '🧹', action: 'execute', category: 'Actions' },
    { cmd: 'help', label: 'Help', description: 'Show available project commands.', icon: '❓', action: 'execute', category: 'Info' },
];

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    const [project, setProject] = useState<Project | null>(null);
    const [agents, setAgents] = useState<ProjectAgent[]>([]);
    const [files, setFiles] = useState<SharedFile[]>([]);
    const [bulletin, setBulletin] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [drawerFile, setDrawerFile] = useState<SharedFile | null>(null);
    const [inlineDrawer, setInlineDrawer] = useState<InlineDrawerState>(null);

    const { fetchAgents, interruptAgent } = useAgentsStore();

    // Chat
    const [messages, setMessages] = useState<any[]>([]);
    const [agentTyping, setAgentTyping] = useState<{ name: string; emoji?: string } | null>(null);
    const [liveTools, setLiveTools] = useState<Array<{ id: string; name: string; args: string; result?: string }>>([]);
    const [liveProgress, setLiveProgress] = useState<Array<{ total_tokens?: number }>>([]);
    const [messageTraces, setMessageTraces] = useState<Record<string, ActivityStep[]>>({});
    // Inline file artifacts written during a turn — diffed from the project workspace
    // when the turn settles, then attached to the latest agent message (gap E parity).
    const [turnFiles, setTurnFiles] = useState<Record<string, TurnFile[]>>({});
    const prevWsFilesRef = useRef<Set<string>>(new Set());
    const messagesRef = useRef<typeof messages>([]);
    // Last non-empty live-stream snapshot — seeds a completed message's trace instantly (no blink).
    const liveStepsRef = useRef<ActivityStep[]>([]);
    const fetchedTracesRef = useRef<Set<string>>(new Set());
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatBodyRef = useRef<HTMLDivElement>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const isAtBottomRef = useRef(true);
    const prevMsgCountRef = useRef(0);

    // Rich input
    const [chatInput, setChatInput] = useState('');
    const [pendingImages, setPendingImages] = useState<string[]>([]);  // base64 data URLs (multiple)
    // Stage 60 phase 1: Cloud or This computer, chosen next to the message box.
    const [browserLane, setBrowserLane] = useBrowserLane(id ? `project:${id}` : undefined);
    const chatInputRef = useRef<HTMLTextAreaElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);

    // Read image File(s) → base64 data URLs, appended (supports multiple paste/upload).
    function loadImageFile(file: File | null | undefined) {
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === 'string') setPendingImages(prev => [...prev, reader.result as string]); };
        reader.readAsDataURL(file);
    }
    function onChatPaste(e: React.ClipboardEvent) {
        const imgs = Array.from(e.clipboardData?.items ?? []).filter(i => i.type.startsWith('image/'));
        if (imgs.length) { e.preventDefault(); imgs.forEach(i => loadImageFile(i.getAsFile())); }
    }
    const [slashQuery, setSlashQuery] = useState<string | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [mentionIndex, setMentionIndex] = useState(0);
    const mentionStartRef = useRef<number>(-1);
    const [fileQuery, setFileQuery] = useState<string | null>(null);
    const [fileIndex, setFileIndex] = useState(0);
    const fileStartRef = useRef<number>(-1);

    // Dock
    const [dockPanel, setDockPanel] = useState<'bulletin' | 'team' | null>(null);
    const dockRef = useRef<HTMLDivElement>(null);

    const reload = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        const [proj, ag] = await Promise.all([fetchProject(id), fetchProjectAgents(id)]);
        setProject(proj); setAgents(ag);
        setLoading(false);
        // Workspace loads in background — doesn't block the page from rendering
        fetchWorkspace(id).then(fl => {
            setFiles(fl);
            setBulletin(fl.find(f => f.filename === 'BULLETIN.md')?.content ?? null);
        });
    }, [id]);

    // Extra tabs injected into UniversalDrawer for project-aware surfaces (Team, Bulletin).
    const drawerExtraTabs = useMemo(() => {
        if (!project) return [];
        return [
            {
                id: 'team',
                label: `Team (${agents.length})`,
                content: (
                    <AgentsTab
                        projectId={project.id}
                        agents={agents}
                        leadAgentId={project.lead_agent_id}
                        onLeadSet={(agentId) => setProject(p => p ? { ...p, lead_agent_id: agentId } : p)}
                        onRefresh={reload}
                    />
                ),
            },
            {
                id: 'bulletin',
                label: 'Bulletin',
                content: <BulletinTab bulletin={bulletin} onRefresh={reload} />,
            },
            {
                id: 'channels',
                label: 'Channels',
                content: <ProjectChannelsTab projectId={project.id} />,
            },
        ];
    }, [project, agents, bulletin, reload]);

    useEffect(() => { fetchAgents(); reload(); }, [reload]);

    useEffect(() => {
        if (!id) return;
        fetch(`/api/messages/project:${id}?limit=100`).then(r => r.ok ? r.json() : { messages: [] }).then(d => setMessages(d.messages ?? []));
        const onMsg = (data: { id: string; chatJid: string; text: string; timestamp: string; sender: string }) => {
            if (data.chatJid !== `project:${id}`) return;
            // Seed the trace from the live stream the moment a completed cycle message arrives,
            // so it renders as the thread instantly instead of flashing a plain bubble until the
            // refetch lands. The hydration effect still fetches to reconcile with the DB.
            if (/^cyc-.+-result-/.test(data.id) && liveStepsRef.current.length > 0) {
                const seeded = liveStepsRef.current;
                setMessageTraces(prev => prev[data.id] ? prev : { ...prev, [data.id]: seeded });
            }
            setMessages(prev => {
                const idx = prev.findIndex(m => m.id === data.id);
                if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], content: data.text }; return u; }
                return [...prev, { id: data.id, chat_jid: data.chatJid, content: data.text, timestamp: data.timestamp, sender: data.sender, sender_name: data.sender, is_from_me: data.sender === 'User' || data.sender === 'user', is_bot_message: data.sender !== 'User' && data.sender !== 'user' }];
            });
        };
        const onTyping = (data: { chatJid: string; isTyping: boolean; agentName?: string; agentEmoji?: string }) => {
            if (data.chatJid !== `project:${id}`) return;
            setAgentTyping(data.isTyping ? { name: data.agentName ?? 'Agent', emoji: data.agentEmoji } : null);
            // Turn settled — diff the workspace for files written this turn and attach them
            // as chips under the latest agent message (gap E parity with the agent chat).
            if (!data.isTyping) {
                setTimeout(async () => {
                    const fl = await fetchWorkspace(id);
                    setFiles(fl);
                    const before = prevWsFilesRef.current;
                    const fresh = fl.filter(f => f.filename !== 'BULLETIN.md' && !before.has(f.filename));
                    prevWsFilesRef.current = new Set(fl.map(f => f.filename));
                    if (fresh.length === 0) return;
                    const lastBot = [...messagesRef.current].reverse().find(m => !m.is_from_me);
                    if (!lastBot) return;
                    setTurnFiles(tf => {
                        const merged = [...(tf[lastBot.id] ?? [])];
                        for (const f of fresh) {
                            const tfile: TurnFile = { id: f.filename, filename: f.filename.split('/').pop() || f.filename, path: f.filename, sizeBytes: f.sizeBytes };
                            if (!merged.some(x => x.id === tfile.id)) merged.push(tfile);
                        }
                        return { ...tf, [lastBot.id]: merged };
                    });
                }, 1500);
            }
        };
        const onActivity = (d: { chatJid: string; type: string; callId?: string; tool?: string; input?: string; output?: string; content?: string }) => {
            if (d.chatJid !== `project:${id}`) return;
            if (d.type === 'start') setLiveTools([]);
            else if (d.type === 'thinking') {
                setLiveTools(prev => [...prev, { id: `th-${Date.now()}`, name: 'thinking', args: '{}', result: d.content || '…' }]);
            } else if (d.type === 'tool_call' && d.tool) {
                setLiveTools(prev => [...prev, { id: d.callId ?? `${Date.now()}`, name: d.tool!, args: d.input ?? '{}' }]);
            } else if (d.type === 'tool_result' && d.callId) {
                setLiveTools(prev => prev.map(t => t.id === d.callId ? { ...t, result: d.output } : t));
            } else if (d.type === 'done') {
                setLiveTools([]);
            }
        };
        socket.on('chat:message', onMsg);
        socket.on('chat:typing', onTyping);
        socket.on('chat:activity', onActivity);
        return () => { socket.off('chat:message', onMsg); socket.off('chat:typing', onTyping); socket.off('chat:activity', onActivity); };
    }, [id]);

    // While an agent is streaming, subscribe to its cycle stream for the live token
    // count — the same data the agent chat shows, so the streaming turn is identical.
    useEffect(() => {
        if (!agentTyping) { setLiveProgress([]); return; }
        const running = agents.find(a => a.name === agentTyping.name)
            ?? agents.find(a => agentTyping.name.includes(a.name) || a.name.includes(agentTyping.name));
        if (!running) return;
        setLiveProgress([]);
        const es = new EventSource(`/api/agents/${running.id}/cycle/stream`);
        es.onmessage = (e) => {
            try { const data = JSON.parse(e.data); if (data.type === 'cycle_progress') setLiveProgress(prev => [...prev.slice(-49), data.event]); } catch { /* ignore */ }
        };
        return () => es.close();
    }, [agentTyping, agents]);

    const liveTokens = useMemo(() => [...liveProgress].reverse().find(ev => typeof ev.total_tokens === 'number')?.total_tokens, [liveProgress]);

    // Stage 35 Phase 3 — the same single read path the agent chat uses. A project thread
    // is where the old model hurt most: several agents' turns interleaved in one thread,
    // reconstructed from message history plus a per-cycle trace fetch plus a 1.5s-delayed
    // workspace-listing diff to guess which files belonged to which turn. Here it's one
    // ordered log. Declared above the scroll effect below, which depends on its events.
    const {
        events: conversationEvents,
        loading: conversationLoading,
        error: conversationError,
        hasOlder: conversationHasOlder,
        loadingOlder: conversationLoadingOlder,
        loadOlder: conversationLoadOlder,
    } = useConversationEvents(id ? `project:${id}` : null, FLAGS.conversationEvents);

    // Must watch whatever is actually RENDERED: under the event stream the thread comes
    // from `conversationEvents` and `messages` stays empty, so keying this on `messages`
    // alone left the view parked at the first message. See AgentProfilePage — same fix.
    useEffect(() => {
        const el = chatBodyRef.current;
        if (!el) return;
        const count = FLAGS.conversationEvents ? conversationEvents.length : messages.length;
        const isFirstLoad = prevMsgCountRef.current === 0 && count > 0;
        prevMsgCountRef.current = count;
        if (isFirstLoad || isAtBottomRef.current) {
            el.scrollTop = el.scrollHeight;
            isAtBottomRef.current = true;
            setIsAtBottom(true);
        }
    }, [messages, conversationEvents]);

    // Follow the live turn: while the user is pinned to the bottom, keep the view stuck
    // to the latest as streaming content grows (tools/tokens/typing). `messages` doesn't
    // change during a turn, so the effect above won't fire — this one tracks the stream.
    // Bails out the moment the user scrolls up (isAtBottomRef), so it never hijacks reading.
    useEffect(() => {
        if (!isAtBottomRef.current) return;
        const el = chatBodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [liveTools, liveTokens, agentTyping]);

    const handleChatScroll = useCallback(() => {
        const el = chatBodyRef.current;
        if (!el) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        isAtBottomRef.current = nearBottom;
        setIsAtBottom(nearBottom);
    }, []);

    const scrollToBottom = useCallback(() => {
        const el = chatBodyRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        isAtBottomRef.current = true;
        setIsAtBottom(true);
    }, []);

    // Hydrate cycle-result messages with their persisted activity trace so tool
    // calls render inline in the bubble (same as AgentProfilePage).
    //
    // Legacy path ONLY: this feeds `messageTraces`, which only the legacy ChatBubble
    // reads. Under the event stream the trace is already in the log, so leaving this
    // ungated fired one /activity-trace request per cycle on every page load and threw
    // the results away.
    useEffect(() => {
        if (!agents.length || FLAGS.conversationEvents) return;
        for (const m of messages) {
            const cid = (m.id as string)?.match(/^cyc-(.+)-result-/)?.[1];
            if (!cid || fetchedTracesRef.current.has(m.id)) continue;
            fetchedTracesRef.current.add(m.id);
            const senderAgent = agents.find(a => m.sender_name?.includes(a.name));
            if (!senderAgent) continue;
            (async () => {
                try {
                    const r = await fetch(`/api/agents/${senderAgent.id}/cycles/${cid}/activity-trace`);
                    if (!r.ok) return;
                    const d = await r.json();
                    const steps: any[] = Array.isArray(d?.steps) ? d.steps : [];
                    const trace: ActivityStep[] = steps
                        .filter((s: any) => s.type === 'tool_call' || s.type === 'thinking')
                        .map((s: any, i: number) => s.type === 'thinking'
                            ? { id: `th-${i}`, type: 'tool_call' as const, tool: 'thinking', input: '{}', output: typeof s.content === 'string' ? s.content : JSON.stringify(s.content ?? ''), done: true }
                            : { id: s.id ?? `tc-${i}`, type: 'tool_call' as const, tool: s.tool ?? 'tool', input: typeof s.input === 'string' ? s.input : JSON.stringify(s.input ?? {}), output: s.output ?? undefined, done: true });
                    if (trace.length) setMessageTraces(prev => ({ ...prev, [m.id]: trace }));
                } catch { /* trace stays absent */ }
            })();
        }
    }, [messages, agents]);

    useEffect(() => {
        if (!dockPanel) return;
        const h = (e: MouseEvent) => { if (dockRef.current && !dockRef.current.contains(e.target as Node)) setDockPanel(null); };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [dockPanel]);

    useEffect(() => {
        const h = (data: { projectId: string; agentId: string | null }) => { if (data.projectId === id) setProject(p => p ? { ...p, lead_agent_id: data.agentId } : p); };
        socket.on('project:lead_agent_changed', h);
        return () => { socket.off('project:lead_agent_changed', h); };
    }, [id]);

    async function handleToggleArchive() {
        if (!project || busy) return;
        setBusy(true);
        const updated = await patchProject(project.id, { status: project.status === 'archived' ? 'active' : 'archived' });
        if (updated) setProject(updated);
        setBusy(false);
    }

    function sendMsg(text: string) {
        const imgs = pendingImages;
        if ((!text.trim() && imgs.length === 0) || !id) return;
        const tempId = `temp_${Date.now()}`;
        socket.emit('chat:send', { chatJid: `project:${id}`, message: text.trim(), clientId: tempId, projectId: id, browser: browserLane, ...(imgs.length ? { images: imgs } : {}) });
        const content = text.trim() || `🖼️ (${imgs.length} image${imgs.length > 1 ? 's' : ''})`;
        setMessages(prev => [...prev, { id: tempId, chat_jid: `project:${id}`, content, sender: 'User', sender_name: 'User', timestamp: new Date().toISOString(), is_from_me: true }]);
        setPendingImages([]);
    }

    function sysMsg(content: string) {
        setMessages(prev => [...prev, { id: `sys_${Date.now()}`, chat_jid: `project:${id}`, content, sender: 'System', sender_name: 'System', timestamp: new Date().toISOString(), is_from_me: false, is_bot_message: true }]);
    }

    function executeSlash(cmd: string) {
        switch (cmd) {
            case 'bulletin': setDockPanel(p => p === 'bulletin' ? null : 'bulletin'); break;
            case 'files':    setInlineDrawer(d => d?.kind === 'files' ? null : { kind: 'files' }); break;
            case 'team':     setDockPanel(p => p === 'team' ? null : 'team'); break;
            case 'manage':   setInlineDrawer({ kind: 'manage', initialTab: 'team' }); break;
            case 'clear':    setMessages([]); break;
            case 'broadcast': setChatInput('@all '); setTimeout(() => chatInputRef.current?.focus(), 0); break;
            case 'help':
                sysMsg('**Project commands:**\n\n- `/bulletin` — bulletin board\n- `/files` — shared workspace\n- `/team` — team panel\n- `/manage` — management panel\n- `/broadcast` — broadcast to all agents (`@all`)\n- `/clear` — clear chat history\n\n**Mentions:** `@AgentName` routes to that agent · `@all` broadcasts\n**Files:** `#filename` references a workspace file');
                break;
        }
    }

    useEffect(() => { messagesRef.current = messages; }, [messages]);
    // Mirror live tools into a ref (in ActivityStep shape) so the result message can seed from it.
    useEffect(() => {
        if (liveTools.length > 0) {
            liveStepsRef.current = liveTools.map(t => t.name === 'thinking'
                ? { id: t.id, type: 'thinking', tool: 'thinking', input: '{}', content: t.result, output: t.result, done: t.result !== undefined }
                : { id: t.id, type: 'tool_call', tool: t.name, input: t.args, output: t.result, done: t.result !== undefined });
        }
    }, [liveTools]);

    function handleSend() {
        const text = chatInput.trim();
        if ((!text && pendingImages.length === 0) || !id) return;
        // Snapshot current workspace so we can detect files written during this turn.
        prevWsFilesRef.current = new Set(files.map(f => f.filename));
        if (text.startsWith('/')) {
            const cmdName = text.slice(1).toLowerCase().split(' ')[0];
            const matched = SLASH_COMMANDS.find(c => c.cmd === cmdName);
            if (matched) {
                setChatInput('');
                if (chatInputRef.current) chatInputRef.current.style.height = 'auto';
                if (matched.action === 'fill' && matched.fillText) { setChatInput(matched.fillText); return; }
                executeSlash(matched.cmd);
                return;
            }
        }
        sendMsg(text);
        setChatInput('');
        if (chatInputRef.current) chatInputRef.current.style.height = 'auto';
    }

    // Memoize the whole rendered message list. Typing in the composer updates `chatInput`
    // (and slash/mention state) which re-renders this page — but none of those are deps here,
    // so the cached element array is reused and React skips the (memoized) bubbles entirely.
    // Result: typing cost is independent of conversation length.
    //
    // INVARIANT (do not break): every value in the dep array below must be referentially
    // stable across a keystroke render. State/derived objects are fine; any *function* dep
    // must be a useState setter or wrapped in useCallback. A fresh closure here (e.g. an
    // inline closure) silently invalidates this memo every render and brings
    // the lag back — that exact bug hit the agent page via an unmemoized `viewFile`.

    const renderedMessages = useMemo(() => {
        return messages.map(msg => {
            if (!msg.is_from_me) {
                const c = (msg.content || '').replace(/^_+|_+$/g, '').trim();
                const isAck = /^On it\b/.test(c)
                    || /^Dispatching to /.test(c)
                    || /^(⚙️|⌛)/.test(c)
                    || /^Running .* cycle…?$/.test(c)
                    || /^Still working on the previous/.test(c);
                if (isAck && !messageTraces[msg.id]?.length) return null;
            }
            return <ChatBubble key={msg.id} message={msg} activity={messageTraces[msg.id]}
                turnFiles={project && turnFiles[msg.id]?.length ? <TurnFiles files={turnFiles[msg.id]} context="project" contextId={project.id} accentColor={CR.accent} maxVisible={8} /> : undefined}
            />;
        });
    }, [messages, messageTraces, turnFiles, project]);

    if (loading) return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: CR.bgMain }}>
            <span style={{ fontFamily: CR.mono, fontSize: 12, color: CR.muted }}>loading…</span>
        </div>
    );

    if (!project) return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: CR.bgMain, gap: 12 }}>
            <div style={{ fontFamily: CR.mono, fontSize: 13, color: CR.muted }}>Project not found</div>
            <button onClick={() => navigate('/projects')} style={{ fontFamily: CR.mono, fontSize: 12, color: CR.sub, background: 'none', border: `1px solid ${CR.border}`, padding: '6px 16px', borderRadius: 6, cursor: 'pointer' }}>← Back to Projects</button>
        </div>
    );

    const isArchived = project.status === 'archived';
    const runningCount = agents.filter(a => a.status === 'running').length;
    const workspaceFileCount = files.filter(f => f.filename !== 'BULLETIN.md').length;

    // @ mention options: @all + project agents
    const mentionOptions: Array<{ id: string; name: string; emoji?: string; role?: string }> = mentionQuery === null ? [] : [
        ...('all'.includes((mentionQuery ?? '').toLowerCase()) || mentionQuery === '' ? [{ id: '__all__', name: 'all', emoji: '📢', role: 'broadcast to everyone' }] : []),
        ...agents.filter(a => mentionQuery === '' || a.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 7),
    ];

    // # file options
    const fq = (fileQuery ?? '').toLowerCase();
    const fileOptions = fileQuery === null ? [] : files.filter(f => f.filename !== 'BULLETIN.md' && (fq === '' || f.filename.toLowerCase().includes(fq))).slice(0, 10);

    // / slash filtered
    const sq = (slashQuery ?? '').toLowerCase();
    const slashFiltered = slashQuery === null ? [] : SLASH_COMMANDS.filter(c => sq === '' || c.cmd.includes(sq) || c.label.toLowerCase().includes(sq));
    const slashCategories = [...new Set(slashFiltered.map(c => c.category))];

    const insertMention = (name: string) => {
        const cursor = chatInputRef.current?.selectionStart ?? chatInput.length;
        const before = chatInput.slice(0, mentionStartRef.current);
        const after = chatInput.slice(cursor);
        setChatInput(`${before}@${name} ${after}`);
        setMentionQuery(null);
        setTimeout(() => {
            const pos = before.length + name.length + 2;
            if (chatInputRef.current) { chatInputRef.current.focus(); chatInputRef.current.setSelectionRange(pos, pos); chatInputRef.current.style.height = 'auto'; chatInputRef.current.style.height = Math.min(chatInputRef.current.scrollHeight, 120) + 'px'; }
        }, 0);
    };

    const insertFileRef = (filename: string) => {
        const cursor = chatInputRef.current?.selectionStart ?? chatInput.length;
        const before = chatInput.slice(0, fileStartRef.current);
        const after = chatInput.slice(cursor);
        setChatInput(`${before}#${filename} ${after}`);
        setFileQuery(null);
        setTimeout(() => {
            const pos = before.length + filename.length + 2;
            if (chatInputRef.current) { chatInputRef.current.focus(); chatInputRef.current.setSelectionRange(pos, pos); chatInputRef.current.style.height = 'auto'; chatInputRef.current.style.height = Math.min(chatInputRef.current.scrollHeight, 120) + 'px'; }
        }, 0);
    };

    const onInputChange = (v: string) => {
        setChatInput(v);
        if (chatInputRef.current) { chatInputRef.current.style.height = 'auto'; chatInputRef.current.style.height = Math.min(chatInputRef.current.scrollHeight, 120) + 'px'; }
        const cursor = chatInputRef.current?.selectionStart ?? v.length;
        const before = v.slice(0, cursor);
        const atMatch = before.match(/@([\w\-]*)$/);
        if (atMatch) { mentionStartRef.current = before.lastIndexOf('@'); setMentionQuery(atMatch[1] ?? ''); setMentionIndex(0); setSlashQuery(null); setFileQuery(null); return; }
        setMentionQuery(null);
        const slashMatch = v.match(/^\/([a-z0-9_-]*)$/i);
        if (slashMatch) { setSlashQuery(slashMatch[1] ?? ''); setSlashIndex(0); setFileQuery(null); return; }
        setSlashQuery(null);
        const hashMatch = before.match(/#([\w\-./]*)$/);
        if (hashMatch) { fileStartRef.current = before.lastIndexOf('#'); setFileQuery(hashMatch[1] ?? ''); setFileIndex(0); return; }
        setFileQuery(null);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (mentionQuery !== null && mentionOptions.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % mentionOptions.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => (i - 1 + mentionOptions.length) % mentionOptions.length); return; }
            if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertMention(mentionOptions[mentionIndex].name); return; }
        }
        if (fileQuery !== null && fileOptions.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setFileIndex(i => (i + 1) % fileOptions.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setFileIndex(i => (i - 1 + fileOptions.length) % fileOptions.length); return; }
            if (e.key === 'Escape') { e.preventDefault(); setFileQuery(null); return; }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertFileRef(fileOptions[fileIndex].filename); return; }
        }
        if (slashQuery !== null && slashFiltered.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, slashFiltered.length - 1)); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
            if (e.key === 'Escape') { e.preventDefault(); setSlashQuery(null); return; }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                const chosen = slashFiltered[slashIndex];
                if (!chosen) return;
                setSlashQuery(null);
                if (chosen.action === 'fill' && chosen.fillText) { setChatInput(chosen.fillText); setTimeout(() => chatInputRef.current?.focus(), 0); }
                else { setChatInput(''); if (chatInputRef.current) chatInputRef.current.style.height = 'auto'; executeSlash(chosen.cmd); }
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    };

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: CR.bgMain }}>

            {/* ── Header ────────────────────────────────────────────────── */}
            <div style={{ flexShrink: 0, padding: isMobile ? '10px 14px' : '12px 24px', background: `linear-gradient(180deg, var(--cr-bg-card-hov) 0%, ${CR.bgMain} 100%)`, borderBottom: `1px solid ${CR.border}`, display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                {!isMobile && <button onClick={() => navigate('/projects')} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: CR.muted, fontFamily: CR.mono, fontSize: 11, cursor: 'pointer', padding: 0, flexShrink: 0 }} onMouseEnter={e => e.currentTarget.style.color = CR.cream} onMouseLeave={e => e.currentTarget.style.color = CR.muted}><ArrowLeft size={12} /> Projects</button>}
                {isMobile && <button onClick={() => navigate('/projects')} style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', color: CR.muted, cursor: 'pointer', padding: 0, flexShrink: 0 }}><ArrowLeft size={16} /></button>}

                <div style={{ width: isMobile ? 30 : 36, height: isMobile ? 30 : 36, borderRadius: 9, flexShrink: 0, background: CR.accentLow, border: `1.5px solid ${CR.borderBright}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: CR.serif, fontSize: isMobile ? 14 : 16, color: CR.accent }}>{project.name.slice(0, 1).toUpperCase()}</div>

                <div style={{ flex: 1, minWidth: isMobile ? 100 : 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: CR.serif, fontSize: isMobile ? 15 : 18, color: CR.cream, fontWeight: 400, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{project.name}</span>
                        {isArchived && <span style={{ fontFamily: CR.mono, fontSize: 9, color: 'var(--cr-warn)', background: 'var(--cr-amber-low)', border: '1px solid var(--cr-amber-line)', padding: '2px 8px', borderRadius: 100, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Archived</span>}
                        {runningCount > 0 && <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.green, background: `${CR.greenLow}`, border: `1px solid ${CR.greenLine}`, padding: '2px 8px', borderRadius: 100 }}>● {runningCount} active</span>}
                    </div>
                    {!isMobile && <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, marginTop: 2 }}>
                        {agents.length} agent{agents.length !== 1 ? 's' : ''} · {workspaceFileCount} file{workspaceFileCount !== 1 ? 's' : ''}
                        {project.lead_agent_id && (() => { const lead = agents.find(a => a.id === project.lead_agent_id); return lead ? <span style={{ color: CR.sub }}> · ★ {lead.emoji ?? '🤖'} {lead.name}</span> : null; })()}
                    </div>}
                </div>

                {!isMobile && agents.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        {agents.slice(0, 6).map(a => (
                            <div key={a.id} title={a.name} style={{ width: 26, height: 26, borderRadius: 6, background: CR.bgElevated, border: `1px solid ${a.status === 'running' ? CR.green : CR.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>{a.emoji ?? '🤖'}</div>
                        ))}
                        {agents.length > 6 && <div style={{ width: 26, height: 26, borderRadius: 6, background: CR.bgElevated, border: `1px solid ${CR.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: CR.mono, fontSize: 9, color: CR.muted }}>+{agents.length - 6}</div>}
                    </div>
                )}

                <button onClick={() => setInlineDrawer({ kind: 'manage', initialTab: 'team' })} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '6px 10px' : '7px 14px', borderRadius: 8, border: `1px solid ${CR.border}`, background: 'var(--cr-tint-2)', color: CR.sub, fontFamily: CR.mono, fontSize: 11, cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' }} onMouseEnter={e => { e.currentTarget.style.borderColor = CR.accent60; e.currentTarget.style.color = CR.cream; }} onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.color = CR.sub; }}><Users size={12} /> {!isMobile && 'Manage'}</button>

                <button onClick={handleToggleArchive} disabled={busy} title={isArchived ? 'Restore project' : 'Archive project'} style={{ padding: isMobile ? '6px 10px' : '7px 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer', flexShrink: 0, background: isArchived ? `${CR.greenLow}` : 'var(--cr-amber-low)', border: `1px solid ${isArchived ? `${CR.greenLine}` : 'var(--cr-amber-line)'}`, color: isArchived ? CR.green : 'var(--cr-warn)', fontFamily: CR.sans, fontSize: 11, fontWeight: 600, opacity: busy ? 0.5 : 1 }}>{busy ? '…' : isArchived ? '↺' : '🗄'}{!isMobile && (isArchived ? ' Restore' : ' Archive')}</button>
            </div>

            {/* ── Body: chat column + push drawer ────────────────────────── */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 }}>

            {/* Chat + Dock + Input */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

                {/* Messages */}
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                <div ref={chatBodyRef} onScroll={handleChatScroll} style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: isMobile ? '16px 14px' : '20px 40px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {FLAGS.conversationEvents ? (
                        <ConversationView
                            events={conversationEvents}
                            loading={conversationLoading}
                            error={conversationError}
                            agentColor={CR.accent}
                            agentName="Crew"
                            liveTokenCount={liveTokens}
                            hasOlder={conversationHasOlder}
                            loadingOlder={conversationLoadingOlder}
                            onLoadOlder={conversationLoadOlder}
                        />
                    ) : messages.length === 0 && !agentTyping ? (
                        <div style={{ margin: 'auto', textAlign: 'center', color: CR.muted, fontFamily: CR.mono, fontSize: 12, lineHeight: 1.8 }}>
                            No messages yet.<br />
                            <span style={{ color: CR.sub }}>Send a message · <span style={{ color: CR.accent }}>@AgentName</span> to route · <span style={{ color: CR.accent }}>@all</span> to broadcast</span>
                        </div>
                    ) : renderedMessages}
                    {/* The live turn still comes from the typing/activity sockets on the
                        legacy path. Under the event stream the running turn is already in
                        the log (its steps arrive as events), so a second live renderer
                        would double it. */}
                    {!FLAGS.conversationEvents && agentTyping && (
                        <StreamingTurn agentName={agentTyping.name} agentEmoji={agentTyping.emoji} agentColor={CR.accent} liveTools={liveTools} tokenCount={liveTokens} />
                    )}
                </div>
                {!isAtBottom && (
                    <button onClick={scrollToBottom} title="Scroll to bottom" style={{ position: 'absolute', bottom: 16, right: 20, width: 34, height: 34, borderRadius: '50%', background: CR.bgElevated, border: `1px solid ${CR.border}`, color: CR.cream, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, boxShadow: '0 4px 16px var(--cr-shade-3)', zIndex: 10, transition: 'border-color 0.15s' }} onMouseEnter={e => { e.currentTarget.style.borderColor = CR.accent; }} onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; }}>↓</button>
                )}
                </div>

                {/* Dock */}
                <div ref={dockRef} style={{ flexShrink: 0, position: 'relative' }}>
                    {/* Bulletin panel */}
                    {dockPanel === 'bulletin' && (
                        <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 100, background: CR.bgCard, borderTop: `1px solid ${CR.border}`, boxShadow: '0 -8px 32px var(--cr-shade-2)', maxHeight: 420, overflowY: 'auto', padding: '16px 24px' }}>
                            <BulletinTab bulletin={bulletin} onRefresh={reload} />
                        </div>
                    )}
                    {/* Team panel */}
                    {dockPanel === 'team' && (
                        <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 100, background: CR.bgCard, borderTop: `1px solid ${CR.border}`, boxShadow: '0 -8px 32px var(--cr-shade-2)', maxHeight: 360, overflowY: 'auto', padding: '16px 24px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>Team — {agents.length} agent{agents.length !== 1 ? 's' : ''}</div>
                                <button onClick={() => { setDockPanel(null); setInlineDrawer({ kind: 'manage', initialTab: 'team' }); }} style={{ fontFamily: CR.mono, fontSize: 11, color: CR.sub, background: 'none', border: `1px solid ${CR.border}`, padding: '4px 10px', borderRadius: 6, cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.color = CR.cream; e.currentTarget.style.borderColor = CR.borderBright; }} onMouseLeave={e => { e.currentTarget.style.color = CR.sub; e.currentTarget.style.borderColor = CR.border; }}>Manage team →</button>
                            </div>
                            {agents.length === 0 ? (
                                <div style={{ fontFamily: CR.mono, fontSize: 12, color: CR.muted, padding: '12px 0' }}>No agents assigned yet.</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    {agents.map(a => (
                                        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--cr-tint-1)', border: `1px solid ${CR.border}`, borderRadius: 8 }}>
                                            <div style={{ width: 28, height: 28, borderRadius: 7, background: CR.accentLow, border: `1px solid ${CR.borderBright}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>{a.emoji ?? '🤖'}</div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontFamily: CR.sans, fontSize: 13, color: CR.cream }}>{a.name}</div>
                                                {a.role && <div style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted }}>{a.role}</div>}
                                            </div>
                                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: a.status === 'running' ? CR.green : CR.muted, boxShadow: a.status === 'running' ? `0 0 6px ${CR.green}` : undefined, flexShrink: 0 }} />
                                            {project.lead_agent_id === a.id && <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.accent, background: CR.accentLow, border: `1px solid ${CR.borderBright}`, padding: '2px 6px', borderRadius: 4 }}>★ lead</span>}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Single combined strip — project buttons + live session tools */}
                    <ActivityDock
                        sessionSteps={[]}
                        liveSteps={liveTools.map(t => ({ id: t.id, type: 'tool_call' as const, tool: t.name, input: t.args, output: t.result, done: t.result !== undefined }))}
                        isTyping={!!agentTyping}
                        onOpenFile={(path) => {
                            const normalizedPath = path.replace(/\\/g, '/');
                            const filename = normalizedPath.split('/').pop() || normalizedPath;
                            const found = files.find(f => {
                                const fNorm = f.filename.replace(/\\/g, '/');
                                return fNorm === normalizedPath || 
                                       fNorm.endsWith('/' + normalizedPath) || 
                                       normalizedPath.endsWith('/' + fNorm) ||
                                       fNorm === filename;
                            });
                            if (found) {
                                setDrawerFile(found);
                            }
                        }}
                        statusLabel={
                            runningCount > 0
                                ? <span style={{ color: CR.green }}>● {runningCount} WORKING</span>
                                : isArchived
                                    ? <span style={{ color: 'var(--cr-warn)' }}>ARCHIVED</span>
                                    : <span style={{ color: CR.muted }}>PROJECT ACTIVE</span>
                        }
                        extraItems={[
                            { id: 'bulletin', label: 'Bulletin', icon: '📋', active: dockPanel === 'bulletin', onClick: () => setDockPanel(p => p === 'bulletin' ? null : 'bulletin') },
                            { id: 'files', label: 'Workspace', icon: '📁', count: workspaceFileCount > 0 ? workspaceFileCount : undefined, active: inlineDrawer?.kind === 'files', onClick: () => setInlineDrawer(d => d?.kind === 'files' ? null : { kind: 'files' }) },
                            { id: 'team', label: 'Team', icon: '👥', count: agents.length > 0 ? agents.length : undefined, active: dockPanel === 'team', onClick: () => setDockPanel(p => p === 'team' ? null : 'team') },
                        ]}
                    />
                </div>

                {/* Rich input */}
                <div style={{ flexShrink: 0, background: CR.bgMain }}>
                    <div style={{ padding: isMobile ? '10px 14px 14px' : '10px 40px 16px', display: 'flex', gap: 10, position: 'relative' }}>

                        {/* / Slash palette */}
                        {slashQuery !== null && slashFiltered.length > 0 && (
                            <div style={{ position: 'absolute', bottom: 'calc(100% - 8px)', left: isMobile ? 14 : 40, right: isMobile ? 14 : 40, background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 14, maxHeight: 360, overflowY: 'auto', boxShadow: '0 -8px 32px var(--cr-shade-2)', zIndex: 200 }}>
                                <div style={{ padding: '8px 14px', borderBottom: `1px solid ${CR.border}`, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--cr-tint-1)' }}>
                                    <span style={{ fontFamily: CR.mono, fontSize: 12, color: CR.muted }}>/</span>
                                    <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted, letterSpacing: '0.08em' }}>PROJECT COMMANDS</span>
                                    <span style={{ fontFamily: CR.mono, fontSize: 8, color: CR.muted, marginLeft: 'auto' }}>↑↓ · Enter run · Esc close</span>
                                </div>
                                {slashCategories.map(cat => (
                                    <div key={cat}>
                                        <div style={{ padding: '6px 14px 4px', fontFamily: CR.mono, fontSize: 8, color: CR.muted, letterSpacing: '0.1em', textTransform: 'uppercase', borderTop: `1px solid ${CR.border}` }}>{cat}</div>
                                        {slashFiltered.filter(c => c.category === cat).map(cmd => {
                                            const gIdx = slashFiltered.indexOf(cmd);
                                            const active = gIdx === slashIndex;
                                            return (
                                                <div key={cmd.cmd}
                                                    onMouseDown={e => { e.preventDefault(); setSlashQuery(null); if (cmd.action === 'fill' && cmd.fillText) { setChatInput(cmd.fillText); setTimeout(() => chatInputRef.current?.focus(), 0); } else { setChatInput(''); if (chatInputRef.current) chatInputRef.current.style.height = 'auto'; executeSlash(cmd.cmd); } }}
                                                    onMouseEnter={() => setSlashIndex(gIdx)}
                                                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px', cursor: 'pointer', background: active ? `${CR.accent15}` : 'transparent', borderLeft: `2px solid ${active ? CR.accent : 'transparent'}` }}>
                                                    <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: active ? `${CR.accent25}` : 'var(--cr-tint-3)', border: `1px solid ${active ? `${CR.accent40}` : CR.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>{cmd.icon}</div>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                                            <span style={{ fontFamily: CR.sans, fontSize: 13, fontWeight: active ? 600 : 400, color: active ? CR.cream : CR.sub }}>{cmd.label}</span>
                                                            <span style={{ fontFamily: CR.mono, fontSize: 9, color: active ? CR.accent : CR.muted }}>/{cmd.cmd}</span>
                                                        </div>
                                                        <div style={{ fontFamily: CR.sans, fontSize: 11, color: CR.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cmd.description}</div>
                                                    </div>
                                                    <div style={{ flexShrink: 0, fontFamily: CR.mono, fontSize: 8, color: cmd.action === 'execute' ? 'var(--cr-green)' : 'var(--cr-amber)', background: cmd.action === 'execute' ? 'var(--cr-green-low)' : 'var(--cr-amber-low)', border: `1px solid ${cmd.action === 'execute' ? 'var(--cr-green-line)' : 'var(--cr-amber-line)'}`, padding: '2px 7px', borderRadius: 10 }}>{cmd.action === 'execute' ? 'RUN' : 'FILL'}</div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* @ Mention picker */}
                        {mentionQuery !== null && mentionOptions.length > 0 && (
                            <div style={{ position: 'absolute', bottom: 'calc(100% - 8px)', left: isMobile ? 14 : 40, right: isMobile ? 14 : 40, maxHeight: 280, overflowY: 'auto', background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 14, boxShadow: '0 -8px 32px var(--cr-shade-2)', zIndex: 200 }}>
                                <div style={{ padding: '8px 14px', borderBottom: `1px solid ${CR.border}`, fontFamily: CR.mono, fontSize: 9, color: CR.muted, letterSpacing: '0.08em' }}>@ ROUTE TO AGENT · @all broadcasts to everyone</div>
                                {mentionOptions.map((a, i) => (
                                    <div key={a.id} onMouseDown={e => { e.preventDefault(); insertMention(a.name); }} onMouseEnter={() => setMentionIndex(i)}
                                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer', background: i === mentionIndex ? `${CR.accent15}` : 'transparent', borderLeft: `2px solid ${i === mentionIndex ? CR.accent : 'transparent'}` }}>
                                        <span style={{ fontSize: 15 }}>{a.emoji ?? '🤖'}</span>
                                        <span style={{ fontFamily: CR.sans, fontSize: 13, color: i === mentionIndex ? CR.cream : CR.sub, flex: 1 }}>{a.name}</span>
                                        {a.role && <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted }}>{a.role}</span>}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* # File picker */}
                        {fileQuery !== null && fileOptions.length > 0 && (
                            <div style={{ position: 'absolute', bottom: 'calc(100% - 8px)', left: isMobile ? 14 : 40, right: isMobile ? 14 : 40, maxHeight: 280, overflowY: 'auto', background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 14, boxShadow: '0 -8px 32px var(--cr-shade-2)', zIndex: 200 }}>
                                <div style={{ padding: '8px 14px', borderBottom: `1px solid ${CR.border}`, fontFamily: CR.mono, fontSize: 9, color: CR.muted, letterSpacing: '0.08em' }}># ATTACH SHARED FILE · content injected as context</div>
                                {fileOptions.map((f, i) => (
                                    <div key={f.filename} onMouseDown={e => { e.preventDefault(); insertFileRef(f.filename); }} onMouseEnter={() => setFileIndex(i)}
                                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer', background: i === fileIndex ? `${CR.accent15}` : 'transparent', borderLeft: `2px solid ${i === fileIndex ? CR.accent : 'transparent'}` }}>
                                        <span style={{ fontSize: 13 }}>{fileIcon(f.filename)}</span>
                                        <span style={{ fontFamily: CR.mono, fontSize: 12, color: i === fileIndex ? CR.cream : CR.sub, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</span>
                                        <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted, flexShrink: 0 }}>{f.sizeBytes < 1024 ? `${f.sizeBytes}B` : `${(f.sizeBytes / 1024).toFixed(1)}kb`}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Image attachment previews (multiple) */}
                        {pendingImages.length > 0 && (
                            <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: isMobile ? 14 : 40, right: isMobile ? 14 : 40, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 10, padding: 6, zIndex: 200 }}>
                                {pendingImages.map((img, i) => (
                                    <div key={i} style={{ position: 'relative' }}>
                                        <img src={img} alt={`attachment ${i + 1}`} style={{ height: 48, borderRadius: 6, display: 'block' }} />
                                        <button onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))} title="Remove"
                                            style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: CR.bgCard, border: `1px solid ${CR.border}`, color: CR.muted, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <input ref={imageInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
                            onChange={e => { Array.from(e.target.files ?? []).forEach(f => loadImageFile(f)); e.currentTarget.value = ''; }} />
                        <button onClick={() => imageInputRef.current?.click()} title="Attach image(s)"
                            style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: 'var(--cr-tint-4)', border: `1px solid ${CR.border}`, color: pendingImages.length ? CR.accent : CR.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>🖼️</button>
                        <div style={{ alignSelf: 'center' }}>
                            <BrowserLanePicker lane={browserLane} onChange={setBrowserLane} />
                        </div>
                        <textarea
                            ref={chatInputRef}
                            value={chatInput}
                            onChange={e => onInputChange(e.target.value)}
                            onKeyDown={onKeyDown}
                            onPaste={onChatPaste}
                            rows={1}
                            placeholder="Message the team — /commands · @agent · #file · paste an image"
                            style={{ flex: 1, background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 12, padding: '11px 16px', color: CR.text, fontFamily: CR.sans, fontSize: 13, outline: 'none', transition: 'border-color 0.15s, box-shadow 0.15s', resize: 'none', height: 'auto', maxHeight: 120, lineHeight: 1.5 }}
                            onFocus={e => { e.target.style.borderColor = CR.accent; e.target.style.boxShadow = `0 0 0 3px ${CR.accent15}`; }}
                            onBlur={e => { e.target.style.borderColor = CR.border; e.target.style.boxShadow = 'none'; }}
                        />
                        {agentTyping ? (() => {
                            const runningAgent = agents.find(a => a.name === agentTyping.name)
                                ?? agents.find(a => agentTyping.name.includes(a.name) || a.name.includes(agentTyping.name));
                            return (
                                <button onClick={() => runningAgent && interruptAgent(runningAgent.id)}
                                    title={`Stop ${agentTyping.name}'s current cycle`}
                                    style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)', color: 'var(--cr-error)', cursor: 'pointer', fontSize: 18, lineHeight: 1, transition: 'all 0.15s' }}>
                                    ⏹
                                </button>
                            );
                        })() : (() => { const canSend = !!chatInput.trim() || pendingImages.length > 0; return (
                        <button onClick={handleSend} disabled={!canSend}
                            style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: canSend ? `linear-gradient(135deg, ${CR.accent}, ${CR.accentWarm})` : 'var(--cr-tint-4)', border: `1px solid ${canSend ? 'transparent' : CR.border}`, color: canSend ? 'var(--cr-on-accent)' : CR.muted, cursor: canSend ? 'pointer' : 'default', fontSize: 20, lineHeight: 1, transition: 'all 0.15s', boxShadow: canSend ? `0 4px 14px ${CR.accent40}` : 'none' }}>›</button>
                        ); })()}
                    </div>
                </div>
            </div>

            {/* Unified push drawer — workspace files / project management */}
            {inlineDrawer && (
                inlineDrawer.kind === 'files' ? (
                    <UniversalDrawer
                        key="drawer-files"
                        workspaceProjectId={project.id}
                        tabs={['files']}
                        initialTab="files"
                        extraTabs={drawerExtraTabs}
                        onClose={() => setInlineDrawer(null)}
                    />
                ) : (
                    <UniversalDrawer
                        key="drawer-manage"
                        tabs={[]}
                        mode="manage"
                        title={project.name}
                        initialTab={inlineDrawer.initialTab ?? 'team'}
                        extraTabs={drawerExtraTabs}
                        onClose={() => setInlineDrawer(null)}
                    />
                )
            )}

            </div>

            {/* File Viewer (overlay — single-file quick-peek) */}
            {drawerFile && <UniversalDrawer initialFile={drawerFile} onClose={() => setDrawerFile(null)} />}
        </div>
    );
}

