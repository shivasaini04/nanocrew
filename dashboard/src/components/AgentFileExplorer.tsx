import { useEffect, useState, useMemo } from 'react';
import { Folder, FolderOpen, FileText, ChevronRight, ChevronDown, Trash2 } from 'lucide-react';
import CsvViewer from './CsvViewer';
import MarkdownViewer from './MarkdownViewer';
import { JsonViewer } from './JsonViewer';
import { DiffViewer } from './DiffViewer';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
function isImageFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_EXTENSIONS.has(ext);
}

interface WorkspaceFile {
    path: string;
    size: number;
    modified: string;
    type: 'file' | 'dir';
}

export interface FileEvent {
    id: string;
    event_type: 'create' | 'write' | 'delete' | 'read';
    file_path: string;
    diff_patch?: string | null;
}

// ─── AgentFileExplorer props ──────────────────────────────────────────────────

interface AgentFileExplorerProps {
    agentId: string;
    cycleId?: string | null;
    selectedPath: string | null;
    onSelect: (path: string | null) => void;
}


// ─── File viewer ─────────────────────────────────────────────────────────────

export function FileViewer({ agentId, filePath, fileEvents, onClose }: {
    agentId: string;
    filePath: string;
    fileEvents: FileEvent[];
    onClose: () => void;
}) {
    const [content, setContent] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [showDiff, setShowDiff] = useState(false);

    const event = fileEvents.find(e => e.file_path === filePath || e.file_path.endsWith('/' + filePath.split('/').pop()));
    const hasDiff = event?.diff_patch;
    const isIdentity = filePath.includes('IDENTITY.md');

    useEffect(() => {
        setLoading(true);
        setShowDiff(false);
        if (isImageFile(filePath)) {
            // For image files, store the URL for rendering via <img> tag
            const imgUrl = `/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(filePath)}&raw=1`;
            setContent(imgUrl);
            setLoading(false);
            return;
        }
        fetch(`/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(filePath)}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { setContent(d?.content ?? null); setLoading(false); })
            .catch(() => { setContent(null); setLoading(false); });
    }, [agentId, filePath]);

    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)', overflow: 'hidden' }}>
            {/* Tab-style header */}
            <div style={{
                height: '36px', flexShrink: 0,
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '0 12px',
                background: 'var(--bg-elevated)',
                borderBottom: '1px solid var(--border-subtle)',
            }}>
                <FileText size={13} color="var(--text-muted)" />
                <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {filePath}
                </span>
                {hasDiff && !showDiff && (
                    <button onClick={() => setShowDiff(true)} style={{ fontSize: '11px', color: 'var(--accent-amber)', cursor: 'pointer', background: 'none', border: 'none', flexShrink: 0 }}>
                        View Diff
                    </button>
                )}
                <button
                    onClick={onClose}
                    title="Close file"
                    style={{ fontSize: '14px', color: 'var(--text-muted)', cursor: 'pointer', background: 'none', border: 'none', flexShrink: 0, lineHeight: 1 }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                >
                    ✕
                </button>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {loading ? (
                    <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace' }}>Loading…</div>
                ) : content === null ? (
                    <div style={{ padding: '20px', color: 'var(--accent-red)', fontSize: '12px' }}>File not found or unreadable.</div>
                ) : showDiff && hasDiff ? (
                    <DiffViewer patch={event!.diff_patch!} onBack={() => setShowDiff(false)} />
                ) : ext === 'csv' ? (
                    <CsvViewer filename={filePath.split('/').pop()!} csvText={content} />
                ) : isIdentity ? (
                    <IdentityViewer content={content} />
                ) : ext === 'json' ? (
                    <JsonViewerComponent content={content} />
                ) : ext === 'md' ? (
                    <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
                        <MarkdownViewer content={content} context="agent" contextId={agentId} basePath={filePath.split('/').slice(0, -1).join('/')} />
                    </div>
                ) : isImageFile(filePath) ? (
                    <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: 'var(--cr-well)' }}>
                        <img
                            src={content}
                            alt={filePath.split('/').pop() ?? filePath}
                            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 4px 24px var(--cr-shade-2)' }}
                        />
                    </div>
                ) : (
                    <PlainViewer content={content} />
                )}
            </div>
        </div>
    );
}

function IdentityViewer({ content }: { content: string }) {
    const coreMatch = content.match(/## CORE([\s\S]*?)(?=## LEARNED|$)/);
    const learnedMatch = content.match(/## LEARNED([\s\S]*)/);
    return (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {coreMatch && (
                <div style={{ background: 'var(--cr-cyan-low)', border: '1px solid var(--cr-cyan-line)', borderRadius: 'var(--radius-md)', padding: '10px 16px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--accent-cyan)', letterSpacing: '0.1em', marginBottom: '8px' }}>CORE IDENTITY</div>
                    <MarkdownViewer content={coreMatch[1].trim()} />
                </div>
            )}
            {learnedMatch && (
                <div style={{ background: 'var(--cr-purple-low)', border: '1px solid var(--cr-purple-line)', borderRadius: 'var(--radius-md)', padding: '10px 16px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--accent-purple)', letterSpacing: '0.1em', marginBottom: '8px' }}>LEARNED EXPERIENCE</div>
                    <MarkdownViewer content={learnedMatch[1].trim() || '(nothing learned yet)'} />
                </div>
            )}
        </div>
    );
}

function JsonViewerComponent({ content }: { content: string }) {
    try {
        const parsed = JSON.parse(content);
        return <JsonViewer data={parsed} />;
    } catch {
        return <PlainViewer content={content} />;
    }
}

function PlainViewer({ content }: { content: string }) {
    const lines = content.split('\n');
    return (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
            {lines.map((line, i) => (
                <div key={i} style={{ display: 'flex', gap: '12px', padding: '1px 12px', fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.7 }}>
                    <span style={{ color: 'var(--text-muted)', minWidth: '32px', textAlign: 'right', userSelect: 'none', flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</span>
                </div>
            ))}
        </div>
    );
}

// ─── Tree types ───────────────────────────────────────────────────────────────

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'dir';
    size?: number;
    children: TreeNode[];
}

function buildTree(files: WorkspaceFile[]): TreeNode[] {
    const root: TreeNode[] = [];
    const map: Record<string, TreeNode> = {};

    const sorted = [...files].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.path.localeCompare(b.path);
    });

    for (const f of sorted) {
        const parts = f.path.split('/');
        const name = parts[parts.length - 1];
        const node: TreeNode = { name, path: f.path, type: f.type, size: f.size, children: [] };
        map[f.path] = node;

        if (parts.length === 1) {
            root.push(node);
        } else {
            const parentPath = parts.slice(0, -1).join('/');
            if (map[parentPath]) map[parentPath].children.push(node);
            else root.push(node);
        }
    }
    return root;
}

const BADGE_CONFIG = {
    create: { label: '+', color: 'var(--accent-green)', bg: 'var(--cr-green-low)' },
    write:  { label: '~', color: 'var(--accent-amber)', bg: 'var(--cr-amber-low)' },
    delete: { label: '-', color: 'var(--accent-red)',   bg: 'var(--cr-error-low)'  },
    read:   { label: '',  color: '',                    bg: ''                        },
};

function DeleteBtn({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
    return (
        <span
            role="button"
            onClick={onClick}
            title="Delete"
            style={{
                display: 'flex', alignItems: 'center', flexShrink: 0, padding: 3, borderRadius: 4,
                color: 'var(--text-muted)', opacity: 0.55, transition: 'color 0.1s, background 0.1s, opacity 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent-red)'; e.currentTarget.style.background = 'var(--cr-error-low)'; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'none'; e.currentTarget.style.opacity = '0.55'; }}
        >
            <Trash2 size={12} />
        </span>
    );
}

function TreeNodeView({ node, depth, changedPaths, onSelect, selectedPath, onDelete }: {
    node: TreeNode;
    depth: number;
    changedPaths: Record<string, 'create' | 'write' | 'delete' | 'read'>;
    onSelect: (path: string) => void;
    selectedPath: string | null;
    onDelete: (path: string, isDir: boolean) => void;
}) {
    const [open, setOpen] = useState(depth < 2);
    const indent = depth * 14;
    const changeBadge = changedPaths[node.path];
    const badge = changeBadge ? BADGE_CONFIG[changeBadge] : null;

    if (node.type === 'dir') {
        return (
            <div>
                <div
                    onClick={() => setOpen(o => !o)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: '4px',
                        padding: `4px 8px 4px ${indent + 8}px`, width: '100%', textAlign: 'left',
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-secondary)', fontSize: '12px',
                        borderRadius: 'var(--radius-sm)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--cr-tint-3)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {open ? <FolderOpen size={13} color="var(--accent-amber)" /> : <Folder size={13} color="var(--accent-amber)" />}
                    <span style={{ flex: 1 }}>{node.name}</span>
                    <DeleteBtn onClick={e => { e.stopPropagation(); onDelete(node.path, true); }} />
                </div>
                {open && node.children.map(child => (
                    <TreeNodeView key={child.path} node={child} depth={depth + 1}
                        changedPaths={changedPaths} onSelect={onSelect} selectedPath={selectedPath} onDelete={onDelete} />
                ))}
            </div>
        );
    }

    const isSelected = selectedPath === node.path;
    return (
        <div
            onClick={() => onSelect(node.path)}
            style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: `4px 8px 4px ${indent + 8}px`, width: '100%', textAlign: 'left',
                background: isSelected ? 'var(--cr-cyan-low)' : 'none',
                border: isSelected ? '1px solid var(--cr-cyan-line)' : '1px solid transparent',
                cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontSize: '12px',
                color: isSelected ? 'var(--accent-cyan)' : 'var(--text-secondary)',
            }}
            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--cr-tint-3)'; }}
            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'none'; }}
        >
            <FileText size={12} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
            {badge?.label && (
                <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px',
                    background: badge.bg, color: badge.color, flexShrink: 0,
                }}>
                    {badge.label}
                </span>
            )}
            <DeleteBtn onClick={e => { e.stopPropagation(); onDelete(node.path, false); }} />
        </div>
    );
}

// ─── Main component — tree only, no embedded viewer ───────────────────────────

export default function AgentFileExplorer({ agentId, cycleId, selectedPath, onSelect }: AgentFileExplorerProps) {
    const [files, setFiles] = useState<WorkspaceFile[]>([]);
    const [fileEvents, setFileEvents] = useState<FileEvent[]>([]);
    const [loading, setLoading] = useState(true);

    const loadFiles = () => {
        setLoading(true);
        fetch(`/api/agents/${agentId}/workspace/files`)
            .then(r => r.ok ? r.json() : [])
            .then(d => { setFiles(d); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(loadFiles, [agentId]);

    async function handleDelete(nodePath: string, isDir: boolean) {
        if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${nodePath}"${isDir ? ' and everything inside it' : ''}?`)) return;
        try {
            const res = await fetch(`/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(nodePath)}`, { method: 'DELETE' });
            if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Delete failed'); return; }
            if (selectedPath === nodePath || (isDir && selectedPath?.startsWith(nodePath + '/'))) onSelect(null);
            loadFiles();
        } catch { alert('Delete failed'); }
    }

    useEffect(() => {
        if (!cycleId) { setFileEvents([]); return; }
        fetch(`/api/agents/${agentId}/cycles/${cycleId}/file-events`)
            .then(r => r.ok ? r.json() : [])
            .then(setFileEvents)
            .catch(() => {});
    }, [agentId, cycleId]);

    const tree = useMemo(() => buildTree(files.filter(f => f.type === 'file' || f.type === 'dir')), [files]);

    const changedPaths = useMemo(() => {
        const map: Record<string, 'create' | 'write' | 'delete' | 'read'> = {};
        for (const e of fileEvents) {
            if (e.event_type !== 'read') map[e.file_path] = e.event_type;
        }
        return map;
    }, [fileEvents]);

    const changedFiles = fileEvents.filter(e => e.event_type !== 'read');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 4px' }}>
                {loading ? (
                    <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace' }}>Loading…</div>
                ) : tree.length === 0 ? (
                    <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>Workspace empty.</div>
                ) : (
                    tree.map(node => (
                        <TreeNodeView key={node.path} node={node} depth={0}
                            changedPaths={changedPaths} onSelect={onSelect} selectedPath={selectedPath} onDelete={handleDelete} />
                    ))
                )}

                {changedFiles.length > 0 && (
                    <div style={{ marginTop: '12px', borderTop: '1px solid var(--border-subtle)', paddingTop: '8px' }}>
                        <div style={{ padding: '4px 8px', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                            CHANGES ({changedFiles.length})
                        </div>
                        {changedFiles.map(e => {
                            const badge = BADGE_CONFIG[e.event_type];
                            return (
                                <button
                                    key={e.id}
                                    onClick={() => onSelect(e.file_path)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px', width: '100%',
                                        background: 'none', border: 'none', cursor: 'pointer', color: badge.color, fontSize: '11px', textAlign: 'left',
                                    }}
                                >
                                    <span style={{ fontWeight: 700, flexShrink: 0 }}>{badge.label}</span>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {e.file_path.split('/').pop()}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
