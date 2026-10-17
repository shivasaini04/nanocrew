import React, { useState, useEffect, useMemo, useRef } from 'react';
import { socket } from '../lib/socket';
import { withAlpha } from '../lib/cr';
import {
    Folder, FileText, ChevronRight, Search, ArrowLeft,
    MoreVertical, HardDrive, Cpu, Terminal, Shield,
    Database, Activity, FileCode2, FlaskConical
} from 'lucide-react';
import MarkdownViewer from '../components/MarkdownViewer';
import { JsonViewer } from '../components/JsonViewer';
import CodeViewer, { isCodeFile, isPythonFile, isHtmlFile, isJsOrTsFile, isSqlFile, isSvgFile, isCssFile } from '../components/CodeViewer';
import PythonRunner from '../components/PythonRunner';
import HtmlPreview from '../components/HtmlPreview';
import JsRunner from '../components/JsRunner';
import SqlRunner from '../components/SqlRunner';
import SvgPreview from '../components/SvgPreview';
import CssPreview from '../components/CssPreview';
import { useIsMobile } from '../hooks/useIsMobile';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContextCard {
    context: string;
    contextId: string;
    name: string;
    subtitle?: string;
    fileCount: number;
    lastModified: string | null;
    status?: string;
    projectId?: string;
    projectName?: string;
}

interface TreeNode {
    name: string;
    type: 'file' | 'dir';
    path: string;
    extension?: string;
    sizeBytes?: number;
    modifiedAt?: string;
    children?: TreeNode[];
    fileCount?: number;
}

interface PreviewFile {
    filename: string;
    content: string;
    extension: string;
    context: string;
    contextId: string;
    path: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileIcon(ext = ''): React.ReactNode {
    if (ext === 'md') return <FileText size={14} color="var(--cr-accent)" />;
    if (ext === 'py') return <Terminal size={14} color="var(--cr-green)" />;
    if (ext === 'js' || ext === 'ts') return <FileCode2 size={14} color="var(--cr-warn)" />;
    if (ext === 'json') return <Database size={14} color="var(--cr-purple)" />;
    if (ext === 'css') return <FileCode2 size={14} color="var(--cr-cyan)" />;
    if (ext === 'sql') return <Database size={14} color="var(--cr-error)" />;
    return <FileText size={14} color="var(--cr-muted)" />;
}

function fmtSize(bytes?: number): string {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(iso?: string | null): string {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const CONTEXT_THEMES: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    job: { color: 'var(--cr-accent)', icon: <Activity size={20} />, label: 'SEQUENCE' },
    project: { color: 'var(--cr-purple)', icon: <Folder size={20} />, label: 'MISSION' },
    main: { color: 'var(--cr-green)', icon: <Terminal size={20} />, label: 'CORE' },
    dashboard: { color: 'var(--cr-warn)', icon: <HardDrive size={20} />, label: 'STATION' },
    agent: { color: 'var(--cr-pink)', icon: <Shield size={20} />, label: 'OPERATIVE' },
};

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
    if (!query) return nodes;
    const q = query.toLowerCase();
    function match(node: TreeNode): TreeNode | null {
        if (node.type === 'file') {
            return node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q) ? node : null;
        }
        const matchedChildren = (node.children ?? []).map(match).filter(Boolean) as TreeNode[];
        if (matchedChildren.length === 0) return null;
        return { ...node, children: matchedChildren, fileCount: matchedChildren.reduce((s, c) => s + (c.type === 'file' ? 1 : (c.fileCount ?? 0)), 0) };
    }
    return nodes.map(match).filter(Boolean) as TreeNode[];
}

// ─── Tree Components ─────────────────────────────────────────────────────────

function TreeNodeRow({ node, depth, context, contextId, onOpen, searchActive }: {
    node: TreeNode;
    depth: number;
    context: string;
    contextId: string;
    onOpen: (node: TreeNode) => void;
    searchActive: boolean;
}) {
    const [open, setOpen] = useState(searchActive || depth === 0);
    useEffect(() => { if (searchActive) setOpen(true); }, [searchActive]);

    const indent = depth * 16;
    const theme = CONTEXT_THEMES[context] || { color: 'var(--cr-muted)' };

    if (node.type === 'file') {
        return (
            <div
                onClick={() => onOpen(node)}
                style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 12px', cursor: 'pointer',
                    marginLeft: `${indent + 12}px`,
                    borderRadius: '8px', transition: 'all 0.15s',
                    marginBottom: '2px'
                }}
                className="crew-file-row"
            >
                {fileIcon(node.extension)}
                <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '13.5px', color: 'var(--cr-cream)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {node.name}
                </span>
                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', opacity: 0.7 }}>
                    {fmtSize(node.sizeBytes)}
                </span>
            </div>
        );
    }

    return (
        <div>
            <div
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 12px', cursor: 'pointer',
                    marginLeft: `${indent}px`,
                    borderRadius: '8px', transition: 'all 0.15s',
                    marginBottom: '2px'
                }}
                className="crew-dir-row"
            >
                <div style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', display: 'flex' }}>
                    <ChevronRight size={14} color="var(--cr-muted)" />
                </div>
                <Folder size={15} color={theme.color} fill={`${withAlpha(theme.color, 13)}`} />
                <span style={{ fontFamily: 'var(--cr-font-sans)', fontWeight: 600, fontSize: '14px', color: 'var(--cr-cream)', flex: 1 }}>
                    {node.name}
                </span>
                {node.fileCount !== undefined && (
                    <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', background: 'var(--cr-tint-2)', padding: '2px 6px', borderRadius: '4px' }}>
                        {node.fileCount}
                    </span>
                )}
            </div>
            {open && node.children && (
                <div>
                    {node.children.map(child => (
                        <TreeNodeRow key={child.path} node={child} depth={depth + 1} context={context} contextId={contextId} onOpen={onOpen} searchActive={searchActive} />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Preview Panel ────────────────────────────────────────────────────────────

function PreviewPanel({ file, onClose, workspaceFiles = [] }: { file: PreviewFile; onClose: () => void; workspaceFiles?: { filename: string; content: string }[] }) {
    const htmlFile = isHtmlFile(file.filename);
    const svgFile = isSvgFile(file.filename);
    const cssFile = isCssFile(file.filename);
    const pyFile = isPythonFile(file.filename);
    const jsFile = isJsOrTsFile(file.filename);
    const sqlFile = isSqlFile(file.filename);
    type TabId = 'preview' | 'code' | 'raw' | 'run';
    const tabs: TabId[] = (htmlFile || svgFile || cssFile)
        ? ['preview', 'code', 'raw']
        : (pyFile || jsFile || sqlFile)
            ? ['preview', 'raw', 'run']
            : ['preview', 'raw'];

    const [tab, setTab] = useState<TabId>(tabs[0]);
    useEffect(() => { setTab(tabs[0]); }, [file.filename]);

    const tabLabel = (t: TabId) => {
        if (t === 'preview') return htmlFile ? 'RENDER' : (file.extension === 'json' || file.extension === 'jsonl' ? 'DATA' : 'PREVIEW');
        if (t === 'code') return 'SOURCE';
        if (t === 'run') return 'RUN (CLIENT)';
        return 'RAW';
    };

    const noScroll = tab === 'run' || (tab === 'preview' && (htmlFile || cssFile));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderLeft: '1px solid var(--cr-border)' }}>
            <div style={{
                height: '60px', padding: '0 24px', borderBottom: '1px solid var(--cr-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'var(--cr-tint-1)'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '15px', color: 'var(--cr-cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {file.filename}
                    </div>
                </div>
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: '20px' }}>×</button>
            </div>

            <div style={{
                height: '40px', display: 'flex', background: 'var(--cr-well)',
                borderBottom: '1px solid var(--cr-border)',
                overflowX: 'auto', WebkitOverflowScrolling: 'touch',
            }}>
                {tabs.map(t => (
                    <button key={t} onClick={() => setTab(t)} style={{
                        flexShrink: 0,
                        padding: '0 20px', fontSize: '10px', fontFamily: 'var(--cr-font-mono)', fontWeight: 700,
                        letterSpacing: '0.08em', background: 'none', border: 'none', cursor: 'pointer',
                        color: tab === t ? 'var(--cr-accent)' : 'var(--cr-muted)',
                        borderBottom: `2px solid ${tab === t ? 'var(--cr-accent)' : 'transparent'}`,
                        transition: 'all 0.2s', height: '100%'
                    }}>
                        {tabLabel(t)}
                    </button>
                ))}
            </div>

            <div style={{ flex: 1, overflowY: noScroll ? 'hidden' : 'auto', padding: tab === 'preview' && !htmlFile ? '24px' : '0' }}>
                {tab === 'run' && pyFile ? <PythonRunner code={file.content} filename={file.filename} workspaceFiles={workspaceFiles} /> :
                        tab === 'run' && jsFile ? <JsRunner code={file.content} filename={file.filename} /> :
                            tab === 'run' && sqlFile ? <SqlRunner code={file.content} /> :
                                tab === 'preview' && htmlFile ? <HtmlPreview content={file.content} agentId={file.context === 'agent' ? file.contextId : undefined} filePath={file.path} /> :
                                    tab === 'preview' && svgFile ? <SvgPreview content={file.content} /> :
                                        tab === 'preview' && cssFile ? <CssPreview content={file.content} /> :
                                            tab === 'code' ? <CodeViewer filename={file.filename} code={file.content} /> :
                                                tab === 'preview' ? (
                                                    file.extension === 'md' ? <MarkdownViewer content={file.content} /> :
                                                        file.extension === 'json' ? (() => {
                                                            try { return <JsonViewer data={JSON.parse(file.content)} />; }
                                                            catch { return <pre style={{ fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-muted)', fontSize: '12px' }}>{file.content}</pre>; }
                                                        })() :
                                                        file.extension === 'jsonl' ? (() => {
                                                            try {
                                                                const rows = file.content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
                                                                return <JsonViewer data={rows} />;
                                                            }
                                                            catch { return <pre style={{ fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-muted)', fontSize: '12px' }}>{file.content}</pre>; }
                                                        })() :
                                                            isCodeFile(file.filename) ? <CodeViewer filename={file.filename} code={file.content} /> : (
                                                                <pre style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.8, color: 'var(--cr-sub)', whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)' }}>{file.content}</pre>
                                                            )
                                                ) : (
                                                    <pre style={{ padding: '24px', margin: 0, fontSize: '12.5px', lineHeight: 1.8, color: 'var(--cr-sub)', whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)' }}>{file.content}</pre>
                                                )}
            </div>
        </div>
    );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function FilesPage() {
    const isMobile = useIsMobile();
    const [cards, setCards] = useState<ContextCard[]>([]);
    const [loadingCards, setLoadingCards] = useState(true);
    const [selected, setSelected] = useState<ContextCard | null>(null);
    const [tree, setTree] = useState<TreeNode[]>([]);
    const [loadingTree, setLoadingTree] = useState(false);
    // Persisted (not per-workspace — it's "I want to see internals," a standing preference,
    // not something scoped to one agent) so it survives switching cards, reloading the page,
    // or navigating away and back. An unpersisted toggle reads as broken, not "off by default."
    const [showHidden, setShowHidden] = useState(() => {
        try { return localStorage.getItem('files-library-show-hidden') === '1'; } catch { return false; }
    });
    useEffect(() => {
        try { localStorage.setItem('files-library-show-hidden', showHidden ? '1' : '0'); } catch { /* ignore */ }
    }, [showHidden]);
    const [preview, setPreview] = useState<PreviewFile | null>(null);
    const [siblingFiles, setSiblingFiles] = useState<{ filename: string; content: string }[]>([]);
    const [search, setSearch] = useState('');
    const [previewWidth, setPreviewWidth] = useState(450);
    const isResizing = useRef(false);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!isResizing.current) return;
            const delta = window.innerWidth - e.clientX;
            setPreviewWidth(Math.max(350, Math.min(window.innerWidth * 0.7, delta)));
        };
        const onUp = () => isResizing.current = false;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, []);

    useEffect(() => {
        fetch('/api/files/contexts').then(r => r.ok ? r.json() : { contexts: [] })
            .then(d => setCards(d.contexts ?? [])).catch(() => { }).finally(() => setLoadingCards(false));
    }, []);

    useEffect(() => {
        if (!selected) return;
        setLoadingTree(true); setTree([]); setPreview(null); setSearch('');
        const hiddenParam = showHidden ? '&showHidden=true' : '';
        fetch(`/api/files/tree?context=${selected.context}&contextId=${encodeURIComponent(selected.contextId)}${hiddenParam}`)
            .then(r => r.ok ? r.json() : { tree: [] }).then(d => setTree(d.tree ?? [])).catch(() => { }).finally(() => setLoadingTree(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, showHidden]);

    const openFile = (node: TreeNode) => {
        if (!selected) return;
        fetch(`/api/files/content?context=${selected.context}&contextId=${encodeURIComponent(selected.contextId)}&path=${encodeURIComponent(node.path)}`)
            .then(r => r.ok ? r.text() : '(load error)').then(content => {
                setPreview({ filename: node.name, content, extension: node.extension ?? '', context: selected.context, contextId: selected.contextId, path: node.path });
                if (node.extension === 'py') {
                    const siblings: TreeNode[] = [];
                    const collect = (ns: TreeNode[]) => { for (const n of ns) { if (n.type === 'file' && n.path !== node.path) siblings.push(n); if (n.children) collect(n.children); } };
                    collect(tree);
                    Promise.all(siblings.map(s => fetch(`/api/files/content?context=${selected.context}&contextId=${encodeURIComponent(selected.contextId)}&path=${encodeURIComponent(s.path)}`).then(r => r.ok ? r.text() : null).then(c => c ? { filename: s.name, content: c } : null)))
                        .then(res => setSiblingFiles(res.filter(Boolean) as any));
                } else setSiblingFiles([]);
            });
    };

    const filteredCards = useMemo(() => {
        if (!search) return cards;
        const q = search.toLowerCase();
        return cards.filter(c => c.name.toLowerCase().includes(q) || c.context.includes(q));
    }, [cards, search]);

    if (!selected) {
        return (
            <div style={{ height: '100%', background: 'var(--cr-bg-main)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: isMobile ? '20px 16px 20px' : 'var(--cr-page-padding-v) var(--cr-page-padding-h) 24px', borderBottom: '1px solid var(--cr-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                        <div style={{ width: '12px', height: '12px', background: 'var(--cr-accent)', borderRadius: '2px' }} />
                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted-br)', letterSpacing: '0.15em' }}>DATA ARCHIVES</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? '14px' : 0 }}>
                        <h1 style={{ fontFamily: 'var(--cr-font-serif)', fontSize: isMobile ? '28px' : '42px', color: 'var(--cr-cream)', margin: 0, fontWeight: 400 }}>Library</h1>
                        <div style={{ position: 'relative' }}>
                            <Search size={16} color="var(--cr-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                            <input
                                placeholder="Filter workspaces..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                style={{
                                    background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderRadius: '10px',
                                    padding: '10px 16px 10px 40px', color: 'var(--cr-cream)', fontSize: '14px',
                                    fontFamily: 'var(--cr-font-sans)', width: isMobile ? '100%' : undefined, minWidth: isMobile ? 0 : '280px',
                                    boxSizing: 'border-box', outline: 'none'
                                }}
                            />
                        </div>
                    </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '20px 16px 40px' : '40px var(--cr-page-padding-h) var(--cr-page-padding-bottom)' }}>
                    {loadingCards ? (
                        <div style={{ textAlign: 'center', padding: '60px', fontFamily: 'var(--cr-font-mono)', fontSize: '12px', color: 'var(--cr-muted)' }}>SYNCHRONIZING WORKSPACES...</div>
                    ) : filteredCards.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '60px', fontFamily: 'var(--cr-font-serif)', fontSize: '18px', color: 'var(--cr-muted)' }}>No records matching current parameters.</div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '24px' }}>
                            {filteredCards.map(card => {
                                const theme = CONTEXT_THEMES[card.context] || { color: 'var(--cr-muted)', icon: <Folder /> };
                                return (
                                    <div
                                        key={`${card.context}:${card.contextId}`}
                                        onClick={() => setSelected(card)}
                                        style={{
                                            background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderRadius: '16px',
                                            padding: '24px', cursor: 'pointer', transition: 'all 0.2s',
                                            display: 'flex', flexDirection: 'column', gap: '20px'
                                        }}
                                        className="crew-context-card"
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                                                <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: `${withAlpha(theme.color, 8)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.color }}>
                                                    {theme.icon}
                                                </div>
                                                <div>
                                                    <div style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '17px', color: 'var(--cr-cream)' }}>{card.name}</div>
                                                    <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: theme.color, letterSpacing: '0.1em', marginTop: '2px' }}>{CONTEXT_THEMES[card.context]?.label || card.context.toUpperCase()}</div>
                                                </div>
                                            </div>
                                            {card.projectId && (
                                                <div title={card.projectName} style={{ background: 'var(--cr-tint-2)', border: '1px solid var(--cr-border)', padding: '4px 8px', borderRadius: '6px' }}>
                                                    <FlaskConical size={12} color="var(--cr-purple)" />
                                                </div>
                                            )}
                                        </div>

                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                                            <div>
                                                <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '24px', color: 'var(--cr-accent)', fontWeight: 300 }}>{card.fileCount}</div>
                                                <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '11px', color: 'var(--cr-muted)' }}>RECORDS</div>
                                            </div>
                                            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', background: 'var(--cr-well)', padding: '3px 8px', borderRadius: '6px' }}>
                                                ACT {timeAgo(card.lastModified).toUpperCase()}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const theme = CONTEXT_THEMES[selected.context] || { color: 'var(--cr-muted)' };
    // On mobile there's no room for tree + preview side by side — show one pane at a
    // time, same pattern as the drawer: opening a file navigates to a full-width preview
    // with its own back button instead of squeezing a 450px pane into a 360px viewport.
    const showTreeMobile = isMobile && !preview;
    const showPreviewMobile = isMobile && !!preview;
    return (
        <div style={{ height: '100%', background: 'var(--cr-bg-main)', display: 'flex', flexDirection: 'column' }}>
            {!showPreviewMobile && (
            <div style={{ height: isMobile ? 'auto' : '60px', minHeight: isMobile ? '52px' : undefined, padding: isMobile ? '10px 14px' : '0 24px', borderBottom: '1px solid var(--cr-border)', display: 'flex', alignItems: 'center', gap: isMobile ? '10px' : '16px', flexShrink: 0, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <button
                    onClick={() => { setSelected(null); setPreview(null); }}
                    style={{ background: 'none', border: 'none', color: 'var(--cr-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--cr-font-mono)', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}
                >
                    <ArrowLeft size={16} /> RETURN
                </button>
                {!isMobile && <div style={{ width: '1px', height: '24px', background: 'var(--cr-border)' }} />}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: isMobile ? '1 1 auto' : undefined }}>
                    <div style={{ color: theme.color }}>{theme.icon}</div>
                    <span style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '17px', color: 'var(--cr-cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.name}</span>
                    {!isMobile && <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', background: `${withAlpha(theme.color, 13)}`, color: theme.color, padding: '2px 8px', borderRadius: '100px', fontWeight: 700, flexShrink: 0 }}>{CONTEXT_THEMES[selected.context]?.label || selected.context.toUpperCase()}</span>}
                </div>
                {!isMobile && <div style={{ flex: 1 }} />}
                <div style={{ position: 'relative', width: isMobile ? '100%' : undefined, order: isMobile ? 3 : undefined }}>
                    <Search size={14} color="var(--cr-muted)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                    <input
                        placeholder="Search workspace..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{
                            background: 'var(--cr-tint-2)', border: '1px solid var(--cr-border)', borderRadius: '8px',
                            padding: '6px 12px 6px 32px', color: 'var(--cr-cream)', fontSize: '12.5px',
                            fontFamily: 'var(--cr-font-sans)', width: isMobile ? '100%' : '220px', boxSizing: 'border-box', outline: 'none'
                        }}
                    />
                </div>
                <button
                    onClick={() => setShowHidden(h => !h)}
                    title={showHidden ? 'Hide internal folders (memory, inbox, sessions, logs)' : 'Show hidden and empty folders'}
                    style={{
                        display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
                        background: showHidden ? withAlpha('var(--cr-accent)', 13) : 'var(--cr-tint-2)',
                        border: `1px solid ${showHidden ? 'var(--cr-accent)' : 'var(--cr-border)'}`,
                        borderRadius: '8px', padding: '6px 10px', cursor: 'pointer',
                        color: showHidden ? 'var(--cr-accent)' : 'var(--cr-muted)',
                        fontFamily: 'var(--cr-font-mono)', fontSize: '10px', fontWeight: 700,
                    }}
                >
                    {showHidden ? '👁' : '👁‍🗨'} {isMobile ? '' : 'HIDDEN'}
                </button>
            </div>
            )}

            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {(!isMobile || showTreeMobile) && (
                <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px' : '24px 32px' }}>
                    {loadingTree ? <div style={{ textAlign: 'center', padding: '40px', fontFamily: 'var(--cr-font-mono)', fontSize: '12px', color: 'var(--cr-muted)' }}>INDEXING RECORDS...</div> :
                        tree.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', fontFamily: 'var(--cr-font-serif)', fontSize: '18px', color: 'var(--cr-muted)' }}>Workspace contains no files.</div> :
                            filterTree(tree, search).map(node => (
                                <TreeNodeRow key={node.path} node={node} depth={0} context={selected.context} contextId={selected.contextId} onOpen={openFile} searchActive={!!search} />
                            ))}
                </div>
                )}

                {preview && !isMobile && (
                    <div
                        onMouseDown={() => isResizing.current = true}
                        style={{ width: '4px', cursor: 'col-resize', background: 'transparent', transition: 'background 0.2s', zIndex: 10, borderLeft: '1px solid var(--cr-border)', marginLeft: '-1px' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-accent)'}
                        onMouseLeave={e => !isResizing.current && (e.currentTarget.style.background = 'transparent')}
                    />
                )}

                {preview && (
                    <div style={{ width: isMobile ? '100%' : `${previewWidth}px`, flexShrink: 0, background: 'var(--cr-bg-main)', overflow: 'hidden' }}>
                        <PreviewPanel file={preview} onClose={() => setPreview(null)} workspaceFiles={siblingFiles} />
                    </div>
                )}
            </div>

            <style>{`
                .crew-file-row:hover { background: var(--cr-tint-3) !important; color: var(--cr-accent) !important; }
                .crew-dir-row:hover { background: var(--cr-tint-3) !important; }
                .crew-context-card:hover { border-color: var(--cr-accent) !important; transform: translateY(-4px); box-shadow: 0 8px 32px var(--cr-shade-2); }
            `}</style>
        </div>
    );
}
