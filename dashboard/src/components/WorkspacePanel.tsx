/**
 * WorkspacePanel — context-aware file panel (Step 6)
 * WorkspaceTree  — folder-tree variant used in drawers/overlays
 */

import React, { useState, useEffect, useRef } from 'react';
import { shouldSkipUploadPath } from '../lib/uploadFilter';
import { useAgentsStore } from '../stores/agentsStore';
import { isBinaryFile } from '../lib/file-preview';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
function isImageFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_EXTENSIONS.has(ext);
}

interface WorkspaceFile {
    id: string;
    context: string;
    contextId: string;
    path: string;
    filename: string;
    extension: string;
    sizeBytes: number;
    modifiedAt: string;
}

/** Folders the file browser hides by default (session dumps, memory, inbox, internal
 *  config) — see SKIP_DIRS in src/api/routes/files.ts, the source of truth this mirrors
 *  only for the tooltip text below. The server decides what's actually hidden. */
const HIDDEN_FOLDERS_HINT = 'sessions, logs, memory, inbox, .nanocrew, identity-history';

interface Props {
    context: 'job' | 'project' | 'main' | 'dashboard' | 'agent';
    contextId?: string;
    onOpen?: (filename: string, content: string, path?: string, context?: string, contextId?: string) => void;
    accentColor?: string;
    /** Collapsed by default? */
    defaultCollapsed?: boolean;
    /** Map of relative path → event type for the current cycle; renders CREATE/WRITE/DELETE badges. */
    eventsByPath?: Map<string, 'create' | 'write' | 'delete'>;
    /** Bump to force a refetch while mounted (e.g. a file-mutating tool call just completed live). */
    refreshSignal?: number;
}

const EVENT_BADGES: Record<string, { bg: string; color: string; border: string; label: string }> = {
    create: { bg: 'var(--cr-green-low)',  color: 'var(--cr-green)', border: 'var(--cr-green-line)', label: '+ CREATE' },
    write:  { bg: 'var(--cr-blue-low)',  color: 'var(--cr-blue)', border: 'var(--cr-blue-line)', label: '~ WRITE' },
    delete: { bg: 'var(--cr-error-low)', color: 'var(--cr-error)', border: 'var(--cr-error-line)', label: '✕ DELETE' },
};


// ─── WorkspaceTree ────────────────────────────────────────────────────────────
// Folder-tree variant for drawers. Self-fetches from the project workspace API.

type TreeNode =
    | { kind: 'file'; name: string; filename: string; sizeBytes: number; modifiedAt: string }
    | { kind: 'dir'; name: string; path: string; children: TreeNode[] };

/** `emptyDirs` are relative paths with nothing in them — the server only sends these when
 *  asked for hidden folders too, since a normal file walk has no reason to know they exist. */
function buildTree(files: { filename: string; sizeBytes: number; modifiedAt: string }[], emptyDirs: string[] = []): TreeNode[] {
    const roots: TreeNode[] = [];
    function ensureDir(parts: string[]): TreeNode[] {
        let level = roots;
        for (let i = 0; i < parts.length; i++) {
            const dirPath = parts.slice(0, i + 1).join('/');
            let dir = level.find(n => n.kind === 'dir' && n.name === parts[i]) as Extract<TreeNode, { kind: 'dir' }> | undefined;
            if (!dir) { dir = { kind: 'dir', name: parts[i], path: dirPath, children: [] }; level.push(dir); }
            level = dir.children;
        }
        return level;
    }
    for (const f of files) {
        const parts = f.filename.split('/').filter(Boolean);
        const level = ensureDir(parts.slice(0, -1));
        level.push({ kind: 'file', name: parts[parts.length - 1] || f.filename, filename: f.filename, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt });
    }
    for (const emptyPath of emptyDirs) {
        ensureDir(emptyPath.split('/').filter(Boolean));
    }
    const sort = (nodes: TreeNode[]) => {
        nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
        nodes.forEach(n => { if (n.kind === 'dir') sort(n.children); });
    };
    sort(roots);
    return roots;
}

/** Files at every depth, not just immediate children. Counting only direct children made a
 *  package directory read as harmless: Seeker's agent-installed `.pylibs` (1689 files, 137MB)
 *  rendered as "3 files", because its 3 loose top-level files were all that got counted and
 *  the rest sat inside 35 package subdirectories. */
function countFiles(nodes: TreeNode[]): number {
    return nodes.reduce((s, n) => s + (n.kind === 'file' ? 1 : countFiles(n.children)), 0);
}

function treeFileIcon(name: string) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (['md', 'txt'].includes(ext)) return '📄';
    if (['py', 'js', 'ts', 'tsx', 'jsx'].includes(ext)) return '🐍';
    if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '⚙️';
    if (['csv', 'tsv'].includes(ext)) return '📊';
    if (['pdf'].includes(ext)) return '📕';
    if (['html', 'css'].includes(ext)) return '🌐';
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
    return '📄';
}

function fmtSz(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
    return `${(bytes / 1024 / 1024).toFixed(1)}mb`;
}

/** Hover-visible rename/copy/delete icons — same actions as the Manage > Files tab,
 * against the same backend routes. Only wired up where a manage handler set is passed. */
function ManageActions({ path, isDir, onRename, onCopy, onDelete }: {
    path: string; isDir: boolean;
    onRename: (path: string) => void; onCopy: (path: string) => void; onDelete: (path: string, isDir: boolean) => void;
}) {
    const btnStyle: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: '3px 4px', borderRadius: 4, color: 'var(--cr-muted)', flexShrink: 0 };
    return (
        <div style={{ display: 'flex', gap: 1, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
            <button onClick={() => onRename(path)} title="Rename / move" style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--cr-cream)'; e.currentTarget.style.background = 'var(--cr-tint-4)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--cr-muted)'; e.currentTarget.style.background = 'none'; }}>✎</button>
            <button onClick={() => onCopy(path)} title="Duplicate" style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--cr-cream)'; e.currentTarget.style.background = 'var(--cr-tint-4)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--cr-muted)'; e.currentTarget.style.background = 'none'; }}>⧉</button>
            <button onClick={() => onDelete(path, isDir)} title="Delete" style={btnStyle}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--cr-error-str)'; e.currentTarget.style.background = 'var(--cr-error-low)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--cr-muted)'; e.currentTarget.style.background = 'none'; }}>🗑</button>
        </div>
    );
}

// Shared tree-item renderer — used by both WorkspaceTree (project workspace, with upload)
// and WorkspacePanel (any context: agent/job/dashboard/project, read-only). Same folder
// nesting + collapse behaviour everywhere files are shown, so a folder upload always
// displays as a folder, not a flattened file list.
function TreeNodes({ nodes, depth, collapsed, onToggleDir, onOpenFile, opening, accentColor, eventsByPath, canOpen, manage }: {
    nodes: TreeNode[];
    depth: number;
    collapsed: Set<string>;
    onToggleDir: (path: string) => void;
    onOpenFile: (filename: string) => void;
    opening: string | null;
    accentColor: string;
    eventsByPath?: Map<string, 'create' | 'write' | 'delete'>;
    canOpen: boolean;
    manage?: { onRename: (path: string) => void; onCopy: (path: string) => void; onDelete: (path: string, isDir: boolean) => void };
}) {
    return <>{nodes.map(node => {
        const pad = 8 + depth * 18;
        if (node.kind === 'dir') {
            const isOpen = !collapsed.has(node.path);
            return (
                <div key={'d:' + node.path}>
                    <div
                        onClick={() => onToggleDir(node.path)}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', paddingLeft: pad, cursor: 'pointer', borderRadius: 6, background: 'var(--cr-tint-1)', marginBottom: 2, userSelect: 'none' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-tint-4)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'var(--cr-tint-1)'}
                    >
                        <span style={{ fontSize: 9, color: 'var(--cr-muted)', width: 8, flexShrink: 0 }}>{isOpen ? '▾' : '▸'}</span>
                        <span style={{ fontSize: 13 }}>{isOpen ? '📂' : '📁'}</span>
                        <span style={{ flex: 1, fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: 'var(--cr-cream)' }}>{node.name}</span>
                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)' }}>{countFiles(node.children) === 0 ? '(empty)' : `${countFiles(node.children)} files`}</span>
                        {manage && <ManageActions path={node.path} isDir onRename={manage.onRename} onCopy={manage.onCopy} onDelete={manage.onDelete} />}
                    </div>
                    {isOpen && <div style={{ paddingLeft: 4 }}>
                        <TreeNodes nodes={node.children} depth={depth + 1} collapsed={collapsed} onToggleDir={onToggleDir} onOpenFile={onOpenFile} opening={opening} accentColor={accentColor} eventsByPath={eventsByPath} canOpen={canOpen} manage={manage} />
                    </div>}
                </div>
            );
        }
        const ev = eventsByPath?.get(node.filename);
        const badge = ev ? EVENT_BADGES[ev] : null;
        const isLoading = opening === node.filename;
        return (
            <div key={'f:' + node.filename}
                onClick={() => onOpenFile(node.filename)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', paddingLeft: pad, borderRadius: 6, cursor: canOpen ? 'pointer' : 'default', background: 'var(--cr-tint-1)', borderLeft: badge ? `3px solid ${badge.color}` : 'none', marginBottom: 2, opacity: isLoading ? 0.5 : 1 }}
                onMouseEnter={e => { if (canOpen) e.currentTarget.style.background = 'var(--cr-tint-4)'; }}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--cr-tint-1)'}
            >
                <span style={{ fontSize: 13, flexShrink: 0 }}>{treeFileIcon(node.name)}</span>
                <span style={{ flex: 1, fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: accentColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                {badge && (
                    <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: badge.bg, border: `1px solid ${badge.border}`, color: badge.color, letterSpacing: '0.06em', flexShrink: 0 }}>
                        {badge.label}
                    </span>
                )}
                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)', flexShrink: 0 }}>{fmtSz(node.sizeBytes)}</span>
                {manage && <ManageActions path={node.filename} isDir={false} onRename={manage.onRename} onCopy={manage.onCopy} onDelete={manage.onDelete} />}
                {canOpen && <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)', flexShrink: 0 }}>Open →</span>}
            </div>
        );
    })}</>;
}

interface WorkspaceTreeProps {
    projectId: string;
    onOpen?: (filename: string, content: string, path?: string, context?: string, contextId?: string) => void;
    accentColor?: string;
}

export function WorkspaceTree({ projectId, onOpen, accentColor = 'var(--cr-accent)' }: WorkspaceTreeProps) {
    type WsFile = { filename: string; sizeBytes: number; modifiedAt: string };
    const [files, setFiles] = useState<WsFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => {
        try { const s = localStorage.getItem(`ws-collapsed-${projectId}`); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
    });
    const [opening, setOpening] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    useEffect(() => { localStorage.setItem(`ws-collapsed-${projectId}`, JSON.stringify([...collapsed])); }, [collapsed, projectId]);

    function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2500); }

    useEffect(() => {
        setLoading(true);
        fetch(`/api/files?context=project&contextId=${encodeURIComponent(projectId)}`)
            .then(r => r.ok ? r.json() : { files: [] })
            .then((d: any) => setFiles(
                (d.files ?? [])
                    .filter((f: any) => f.path !== 'BULLETIN.md')
                    .map((f: any) => ({ filename: f.path, sizeBytes: f.sizeBytes ?? 0, modifiedAt: f.modifiedAt ?? '' }))
            ))
            .catch(() => setFiles([]))
            .finally(() => setLoading(false));
    }, [projectId]);

    async function handleOpen(filename: string) {
        if (!onOpen) return;
        if (isImageFile(filename)) {
            const imgUrl = `/api/files/content?context=project&contextId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filename)}`;
            onOpen(filename.split('/').pop() ?? filename, imgUrl, filename, 'project', projectId);
            return;
        }
        if (isBinaryFile(filename)) {
            // An .xlsx (or .docx, .zip, ...) fetched with r.text() and rendered into a
            // <pre> showed the raw ZIP-container bytes decoded as "text" — found
            // 2026-09-22. Never fetch a known-binary file as text. The URL, not fetched
            // content, IS what's passed as "content" here — same convention isImageFile
            // uses above — so xlsx/docx get a real in-app viewer (UniversalDrawer fetches
            // this URL itself) instead of a dead "no preview" end.
            const fileUrl = `/api/files/content?context=project&contextId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filename)}`;
            onOpen(filename.split('/').pop() ?? filename, fileUrl, filename, 'project', projectId);
            return;
        }
        setOpening(filename);
        try {
            const r = await fetch(`/api/files/content?context=project&contextId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filename)}`);
            const content = r.ok ? await r.text() : '';
            onOpen(filename.split('/').pop() ?? filename, content, filename, 'project', projectId);
        } catch { /* silent */ }
        setOpening(null);
    }

    async function uploadFiles(fl: FileList | null) {
        if (!fl || fl.length === 0) return;
        const fd = new FormData();
        const paths: string[] = [];
        for (const f of Array.from(fl)) {
            const rel = (f as any).webkitRelativePath || f.name;
            if (shouldSkipUploadPath(rel)) continue;
            paths.push(rel);
            fd.append('files', f, f.name);
        }
        if (paths.length === 0) { showToast('⚠  Nothing to upload (only generated/vendor files were selected)'); return; }
        fd.append('paths', JSON.stringify(paths));
        setUploading(true);
        try {
            const res = await fetch(`/api/projects/${projectId}/workspace/files`, { method: 'POST', body: fd });
            const d = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast(`✅ Added ${(d.added || []).length} file(s)`);
                setLoading(true);
                fetch(`/api/files?context=project&contextId=${encodeURIComponent(projectId)}`)
                    .then(r => r.ok ? r.json() : { files: [] })
                    .then((d: any) => setFiles(
                        (d.files ?? [])
                            .filter((f: any) => f.path !== 'BULLETIN.md')
                            .map((f: any) => ({ filename: f.path, sizeBytes: f.sizeBytes ?? 0, modifiedAt: f.modifiedAt ?? '' }))
                    ))
                    .catch(() => {})
                    .finally(() => setLoading(false));
            } else showToast(`⚠ ${d.error || 'Upload failed'}`);
        } catch { showToast('⚠ Upload failed'); }
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }

    if (loading) return <div style={{ padding: '24px 0', textAlign: 'center', fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: 'var(--cr-muted)' }}>Loading workspace…</div>;

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 10, color: 'var(--cr-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>
                    Workspace — {files.length} file{files.length !== 1 ? 's' : ''}
                </div>
                {toast && <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 11, color: 'var(--cr-sub)' }}>{toast}</span>}
                <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={e => uploadFiles(e.target.files)} />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, background: accentColor === 'var(--cr-accent)' ? 'var(--cr-accent)' : accentColor, border: 'none', color: 'var(--cr-on-accent)', cursor: uploading ? 'default' : 'pointer', fontFamily: 'var(--cr-font-mono)', fontSize: 10, padding: '4px 10px', borderRadius: 5 }}
                >
                    {uploading ? 'uploading…' : '+ Add Files'}
                </button>
            </div>
            {files.length === 0 ? (
                <div style={{ padding: '40px 0', textAlign: 'center', fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: 'var(--cr-muted)' }}>No files yet.</div>
            ) : (
                <div>
                    <TreeNodes nodes={buildTree(files)} depth={0} collapsed={collapsed}
                        onToggleDir={p => setCollapsed(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; })}
                        onOpenFile={handleOpen} opening={opening} accentColor={accentColor} canOpen={!!onOpen} />
                </div>
            )}
        </div>
    );
}

// ─── WorkspacePanel (flat list) ───────────────────────────────────────────────

export function WorkspacePanel({ context, contextId, onOpen, accentColor = 'var(--cr-cyan)', defaultCollapsed = false, eventsByPath, refreshSignal }: Props) {
    const [files, setFiles] = useState<WorkspaceFile[]>([]);
    const [emptyDirs, setEmptyDirs] = useState<string[]>([]);
    // Persisted per context+contextId, same pattern as dirCollapsed below — otherwise the
    // toggle silently resets to off on every remount (collapsing the panel, navigating away
    // and back, a page reload), which reads as "broken" rather than "off by default."
    const showHiddenKey = `ws-showHidden-${context}-${contextId ?? ''}`;
    const [showHidden, setShowHidden] = useState(() => {
        try { return localStorage.getItem(showHiddenKey) === '1'; } catch { return false; }
    });
    const [panelCollapsed, setPanelCollapsed] = useState(defaultCollapsed);
    const [loading, setLoading] = useState(false);
    // Set once a fetch has been pending for a while — surfaces a retry affordance
    // instead of leaving the header on an unbounded "…" if the backend is slow.
    const [slow, setSlow] = useState(false);
    // Per-folder collapse state, keyed by full relative path — same model as WorkspaceTree,
    // persisted the same way so reopening this panel remembers what was left open/closed.
    const storageKey = `ws-collapsed-${context}-${contextId ?? ''}`;
    const [dirCollapsed, setDirCollapsed] = useState<Set<string>>(() => {
        try { const s = localStorage.getItem(storageKey); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
    });
    const [opening, setOpening] = useState<string | null>(null);
    // Guards against an older, slower request landing after a newer one — without this,
    // an out-of-order response can flip `loading` back to true right after a fresher
    // request already cleared it, leaving the header stuck on "FILES …" forever even
    // though every individual fetch succeeded.
    const reqIdRef = useRef(0);

    const refetch = () => {
        const myId = ++reqIdRef.current;
        let url = `/api/files?context=${context}`;
        if (contextId) url += `&contextId=${encodeURIComponent(contextId)}`;
        if (showHidden) url += `&showHidden=true`;
        setLoading(true);
        setSlow(false);
        const slowTimer = setTimeout(() => { if (myId === reqIdRef.current) setSlow(true); }, 8000);
        fetch(url)
            .then(r => r.ok ? r.json() : { files: [], emptyDirs: [] })
            .then(d => { if (myId === reqIdRef.current) { setFiles(d.files ?? []); setEmptyDirs(d.emptyDirs ?? []); } })
            .catch(() => { if (myId === reqIdRef.current) { setFiles([]); setEmptyDirs([]); } })
            .finally(() => {
                clearTimeout(slowTimer);
                if (myId === reqIdRef.current) { setLoading(false); setSlow(false); }
            });
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(refetch, [context, contextId, refreshSignal, showHidden]);

    useEffect(() => { localStorage.setItem(storageKey, JSON.stringify([...dirCollapsed])); }, [dirCollapsed, storageKey]);
    useEffect(() => { try { localStorage.setItem(showHiddenKey, showHidden ? '1' : '0'); } catch { /* ignore */ } }, [showHidden, showHiddenKey]);

    // Rename/copy/delete are only wired for the agent context — that's the only one
    // with a corresponding /api/agents/:id/workspace/file route (same routes and
    // guard pattern as the Manage > Files tab in AgentProfilePage).
    //
    // Each handler refetches this panel's own local list AND invalidates the
    // agentsStore's `agentFiles` cache — a separate fetch of the same workspace
    // that powers the chat's `#` file-mention picker and the file-count badge.
    // Without this second call, deleting/renaming here leaves that cache stale:
    // the panel shows the change but `#` still offers the old path.
    const manage = context === 'agent' && contextId ? {
        onRename: async (fromPath: string) => {
            const to = window.prompt('Rename or move to (full path within the workspace):', fromPath);
            if (!to || to === fromPath) return;
            const res = await fetch(`/api/agents/${contextId}/workspace/file`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: fromPath, to }),
            }).catch(() => null);
            if (!res || !res.ok) { alert((await res?.json().catch(() => ({})))?.error || 'Rename failed'); return; }
            refetch();
            useAgentsStore.getState().fetchAgentFiles(contextId);
        },
        onCopy: async (fromPath: string) => {
            const parts = fromPath.split('/');
            const base = parts.pop()!;
            const dot = base.lastIndexOf('.');
            const suggested = dot > 0 ? `${base.slice(0, dot)} copy${base.slice(dot)}` : `${base} copy`;
            const to = window.prompt('Copy to (full path within the workspace):', [...parts, suggested].join('/'));
            if (!to || to === fromPath) return;
            const res = await fetch(`/api/agents/${contextId}/workspace/file/copy`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: fromPath, to }),
            }).catch(() => null);
            if (!res || !res.ok) { alert((await res?.json().catch(() => ({})))?.error || 'Copy failed'); return; }
            refetch();
            useAgentsStore.getState().fetchAgentFiles(contextId);
        },
        onDelete: async (targetPath: string, isDir: boolean) => {
            if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${targetPath}"${isDir ? ' and everything inside it' : ''}?`)) return;
            const res = await fetch(`/api/agents/${contextId}/workspace/file?path=${encodeURIComponent(targetPath)}`, { method: 'DELETE' }).catch(() => null);
            if (!res || !res.ok) { alert((await res?.json().catch(() => ({})))?.error || 'Delete failed'); return; }
            refetch();
            useAgentsStore.getState().fetchAgentFiles(contextId);
        },
    } : undefined;

    // TreeNodes only knows the file by its full relative path — look the real record up
    // by path (== node.filename, since the tree is built from f.path below).
    const handleOpen = (filename: string) => {
        if (!onOpen) return;
        const file = files.find(f => f.path === filename);
        if (!file) return;
        if (isImageFile(file.filename)) {
            const imgUrl = `/api/files/content?context=${file.context}&contextId=${encodeURIComponent(file.contextId)}&path=${encodeURIComponent(file.path)}`;
            onOpen(file.filename, imgUrl, file.path, file.context, file.contextId);
            return;
        }
        if (isBinaryFile(file.filename)) {
            // Same fix as handleOpen above — the URL, not fetched content, is the
            // "content", so xlsx/docx get a real viewer instead of a dead end.
            const fileUrl = `/api/files/content?context=${file.context}&contextId=${encodeURIComponent(file.contextId)}&path=${encodeURIComponent(file.path)}`;
            onOpen(file.filename, fileUrl, file.path, file.context, file.contextId);
            return;
        }
        setOpening(filename);
        const url = `/api/files/content?context=${file.context}&contextId=${encodeURIComponent(file.contextId)}&path=${encodeURIComponent(file.path)}`;
        fetch(url)
            .then(r => r.ok ? r.text() : '')
            .then(content => onOpen(file.filename, content, file.path, file.context, file.contextId))
            .catch(() => {})
            .finally(() => setOpening(null));
    };

    if (!loading && files.length === 0 && emptyDirs.length === 0) return null;

    // Tree nodes are keyed by full path (f.path), matching TreeNodes/eventsByPath's expectations.
    const tree = buildTree(files.map(f => ({ filename: f.path, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt })), emptyDirs);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
            {/* Header row */}
            <button
                onClick={() => setPanelCollapsed(c => !c)}
                style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '0 0 8px', textAlign: 'left',
                    color: 'var(--text-muted)', fontSize: '10px', fontWeight: 700,
                    letterSpacing: '0.08em',
                }}
            >
                <span>FILES {loading ? '…' : `(${files.length})`}</span>
                {loading && slow && (
                    <span
                        role="button"
                        onClick={e => { e.stopPropagation(); refetch(); }}
                        style={{ color: accentColor, cursor: 'pointer', textDecoration: 'underline' }}
                        title="This is taking longer than usual — click to retry"
                    >
                        taking a while… retry?
                    </span>
                )}
                <span
                    role="button"
                    onClick={e => { e.stopPropagation(); setShowHidden(h => !h); }}
                    title={showHidden
                        ? 'Hide internal folders again'
                        : `Show hidden folders (${HIDDEN_FOLDERS_HINT}) and empty ones`}
                    style={{
                        marginLeft: 'auto', fontSize: '12px', cursor: 'pointer',
                        opacity: showHidden ? 1 : 0.45, color: showHidden ? accentColor : 'var(--text-muted)',
                    }}
                >
                    {showHidden ? '👁' : '👁‍🗨'}
                </span>
                <span style={{ fontSize: '10px' }}>{panelCollapsed ? '▼' : '▲'}</span>
            </button>

            {/* File tree */}
            {!panelCollapsed && (
                <TreeNodes nodes={tree} depth={0} collapsed={dirCollapsed}
                    onToggleDir={p => setDirCollapsed(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; })}
                    onOpenFile={handleOpen} opening={opening} accentColor={accentColor} eventsByPath={eventsByPath} canOpen={!!onOpen} manage={manage} />
            )}
        </div>
    );
}
