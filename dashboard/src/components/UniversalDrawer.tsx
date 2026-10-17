import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, X, Globe } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { extractArtifact } from './ChatBubble';
import { useIsMobile } from '../hooks/useIsMobile';
import { artifactViewPath } from './ArtifactFrame';
import { isBinaryFile, isDocxFile, isSpreadsheetFile, toAbsoluteUrl } from '../lib/file-preview';
import XlsxViewer from './XlsxViewer';
import DocxViewer from './DocxViewer';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
function isImageFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_EXTENSIONS.has(ext);
}

function injectResizeScript(html: string): string {
    const script = `<script>(function(){function send(){var h=document.body?document.body.scrollHeight:document.documentElement.scrollHeight;window.parent.postMessage({type:'artifact:resize',height:h},'*');}window.addEventListener('load',function(){send();setTimeout(send,400);});})();<\/script>`;
    const bodyClose = html.lastIndexOf('</body>');
    if (bodyClose !== -1) return html.slice(0, bodyClose) + script + html.slice(bodyClose);
    return html + script;
}
import { WorkspacePanel, WorkspaceTree } from './WorkspacePanel';
import MarkdownViewer from './MarkdownViewer';
import { JsonViewer } from './JsonViewer';
import CsvViewer from './CsvViewer';
import CodeViewer, {
    isCodeFile, isPythonFile, isHtmlFile, isJsOrTsFile,
    isSqlFile, isSvgFile, isCssFile, isShellFile
} from './CodeViewer';
import PythonRunner from './PythonRunner';
import HtmlPreview from './HtmlPreview';
import JsRunner from './JsRunner';
import SqlRunner from './SqlRunner';
import SvgPreview from './SvgPreview';
import CssPreview from './CssPreview';

export type DrawerJobStep =
    | { type: 'thinking'; id: string; content: string }
    | { type: 'tool_call'; id: string; tool: string; input: string; output: string | null };

export interface UniversalDrawerProps {
    /** Job/cycle ID — not required when opening a file directly via initialFile */
    jobId?: string;
    title?: string;
    resultText?: string;
    isSuccess?: boolean;
    width?: number;
    agentId?: string;
    /** Which top tabs to show. Defaults to all. */
    tabs?: Array<'output' | 'files' | 'activity'>;
    /** Open directly to a specific file without showing Output/Activity tabs.
     *  Used by ProjectDetailPage to replace the old FileViewerDrawer. */
    initialFile?: { filename: string; content: string; path?: string; context?: string; contextId?: string };
    /** Force position:fixed overlay rendering (use when not inside an AgentProfilePage flex layout) */
    overlay?: boolean;
    /** Open directly to the project workspace files (no job/activity tabs needed) */
    workspaceProjectId?: string;
    /** Extra tabs injected after built-in tabs (e.g. Team / Bulletin from ProjectDetailPage). */
    // `content` can be a plain node (Browser tab: nothing in it ever needs this drawer's
    // own preview), or a function of `openInDrawer` (Artifacts/Outputs: clicking an item
    // should show it IN this same drawer, not pop a second modal on top of it — found
    // 2026-09-22, an artifact "Preview" click opened a whole separate overlay instead of
    // using the file-preview area three lines away). The callback takes exactly the
    // shape setOpenFile already uses everywhere else in this file — filename plus either
    // fetched text content or, for anything binary/xlsx/docx/image, the file's own URL.
    extraTabs?: Array<{
        id: string;
        label: string;
        content: React.ReactNode | ((openInDrawer: (file: {
            filename: string; content: string; path?: string; context?: string; contextId?: string;
        }) => void) => React.ReactNode);
    }>;
    /** Override which tab is active on first render. */
    initialTab?: string;
    /** 'manage' → neutral header styling (orange accent, ⚙️ icon). */
    mode?: 'manage';
    /** Bump to force the workspace file tree to refetch while this drawer is open
     *  (e.g. a write_file/edit_file/append_file tool call just completed live). */
    refreshSignal?: number;
    onClose: () => void;
}

export default function UniversalDrawer({
    jobId = '', title = '', resultText = '', isSuccess = true,
    width: initialWidth = 420, agentId, tabs, initialFile, overlay, workspaceProjectId,
    extraTabs, initialTab, mode, refreshSignal, onClose
}: UniversalDrawerProps) {
    const navigate = useNavigate();
    type FileMode = 'preview' | 'code' | 'raw' | 'run';
    type MainTab = string;

    const isMobile = useIsMobile();

    const fileOnlyMode = !!initialFile;
    // A dedicated workspace browser: project workspace, or an agent drawer scoped to just the files tab.
    const isWorkspaceDrawer = !fileOnlyMode && (!!workspaceProjectId || (!!tabs && tabs.length === 1 && tabs[0] === 'files'));

    const [width, setWidth] = useState(() => {
        const saved = localStorage.getItem('universal_drawer_width');
        return saved ? parseInt(saved, 10) : initialWidth;
    });
    const [isResizing, setIsResizing] = useState(false);
    const dragStartXRef = useRef(0);
    const dragStartWidthRef = useRef(0);

    const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
        setIsResizing(true);
        dragStartXRef.current = e.clientX;
        dragStartWidthRef.current = width;
    }, [width]);

    useEffect(() => {
        if (!isResizing) return;
        const onMove = (e: MouseEvent) => {
            const delta = dragStartXRef.current - e.clientX;
            const next = Math.max(320, Math.min(900, dragStartWidthRef.current + delta));
            setWidth(next);
        };
        const onUp = () => {
            setIsResizing(false);
            setWidth(w => { localStorage.setItem('universal_drawer_width', String(w)); return w; });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [isResizing]);

    const [steps, setSteps] = useState<DrawerJobStep[] | null>(null);
    const [activityLegacy, setActivityLegacy] = useState(false);
    const [mainTab, setMainTab] = useState<MainTab>(() => {
        if (initialTab) return initialTab;
        return tabs && tabs.length > 0 ? tabs[0] : 'output';
    });
    const [resultMode, setResultMode] = useState<'preview' | 'raw'>('preview');
    const [htmlIframeHeight, setHtmlIframeHeight] = useState(520);
    const [htmlFiles, setHtmlFiles] = useState<Array<{
        filename: string;
        path: string;
        sizeBytes: number;
        contextId: string;
        eventType?: 'create' | 'write' | 'delete';
        source: 'cycle' | 'project';
    }>>([]);
    const [htmlFilesLoading, setHtmlFilesLoading] = useState(true);
    const [cycleEventMap, setCycleEventMap] = useState<Map<string, 'create' | 'write' | 'delete'>>(new Map());
    const [openFile, setOpenFile] = useState<{ filename: string; content: string; path?: string; context?: string; contextId?: string } | null>(
        initialFile ?? null
    );
    const [fileMode, setFileMode] = useState<FileMode>('preview');
    const [siblingFiles, setSiblingFiles] = useState<{ filename: string; content: string }[]>([]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (e.data?.type === 'artifact:resize' && typeof e.data.height === 'number') {
                setHtmlIframeHeight(Math.max(300, e.data.height + 32));
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    useEffect(() => {
        if (fileOnlyMode || !jobId || jobId === 'dock') { setHtmlFilesLoading(false); return; }
        setHtmlFilesLoading(true);

        const ARTIFACT_EXTS = new Set([
            'html', 'csv', 'md', 'json', 'jsonl',
            'png', 'jpg', 'jpeg', 'svg', 'pdf',
            'txt', 'tsv', 'xml', 'yaml', 'yml',
        ]);

        type FileRow = {
            filename: string; path: string; sizeBytes: number; contextId: string;
            eventType?: 'create' | 'write' | 'delete'; source: 'cycle' | 'project';
        };
        const finish = (files: FileRow[]) => { setHtmlFiles(files); setHtmlFilesLoading(false); };

        if (agentId) {
            Promise.all([
                fetch(`/api/agents/${encodeURIComponent(agentId)}/cycles/${encodeURIComponent(jobId)}/file-events`)
                    .then(r => r.ok ? r.json() : []).catch(() => []),
                fetch(`/api/agents/${encodeURIComponent(agentId)}/cycles?limit=20`)
                    .then(r => r.ok ? r.json() : []).catch(() => []),
            ]).then(([eventsRaw, cyclesRaw]) => {
                const events = Array.isArray(eventsRaw) ? eventsRaw : (eventsRaw?.events ?? []);
                const cycles = Array.isArray(cyclesRaw) ? cyclesRaw : (cyclesRaw?.cycles ?? []);
                const thisCycle = cycles.find((c: any) => c.id === jobId);
                const pid = thisCycle?.project_id ?? null;

                const seen = new Set<string>();
                const files: FileRow[] = [];

                const eventByPath = new Map<string, any>();
                for (const e of events) {
                    const filePath = e.path ?? e.file_path ?? e.filename;
                    if (!filePath) continue;
                    eventByPath.set(filePath, e);
                }
                const evMap = new Map<string, 'create' | 'write' | 'delete'>();
                for (const [filePath, e] of eventByPath) {
                    const t = (e.event_type ?? e.eventType ?? 'write') as 'create' | 'write' | 'delete';
                    evMap.set(filePath, t);
                }
                setCycleEventMap(evMap);
                for (const [filePath, e] of eventByPath) {
                    if (seen.has(filePath)) continue;
                    const ext = (filePath.split('.').pop() ?? '').toLowerCase();
                    if (!ARTIFACT_EXTS.has(ext)) continue;
                    seen.add(filePath);
                    const evType = (e.event_type ?? e.eventType ?? 'write') as 'create' | 'write' | 'delete';
                    files.push({ filename: filePath.split('/').pop() ?? filePath, path: filePath, sizeBytes: e.size ?? e.size_bytes ?? 0, contextId: agentId, eventType: evType, source: 'cycle' });
                }

                if (pid) {
                    fetch(`/api/files?context=project&contextId=${encodeURIComponent(pid)}`)
                        .then(r => r.ok ? r.json() : { files: [] })
                        .then(d => {
                            for (const f of (d.files ?? [])) {
                                if (seen.has(f.path)) continue;
                                const ext = String(f.extension ?? '').toLowerCase();
                                if (!ARTIFACT_EXTS.has(ext)) continue;
                                seen.add(f.path);
                                files.push({ filename: f.filename, path: f.path, sizeBytes: f.sizeBytes ?? 0, contextId: pid, source: 'project' });
                            }
                            finish(files);
                        })
                        .catch(() => finish(files));
                } else {
                    finish(files);
                }
            }).catch(() => finish([]));
            return;
        }

        // Without an agent there is no cycle to read files from. (This branch used to
        // read a background job's workspace; jobs were removed in stage 57.)
        finish([]);
    }, [jobId, agentId, fileOnlyMode]);

    useEffect(() => {
        if (fileOnlyMode || !jobId) return;
        setActivityLegacy(false);
        if (agentId) {
            fetch(`/api/agents/${agentId}/cycles/${encodeURIComponent(jobId)}/activity-trace`)
                .then(r => r.ok ? r.json() : { steps: [] })
                .then(d => {
                    const mapped: DrawerJobStep[] = (d.steps ?? []).map((s: any, i: number) =>
                        s.type === 'thinking'
                            ? { type: 'thinking', id: `t_${i}`, content: s.content }
                            : { type: 'tool_call', id: `tc_${i}`, tool: s.tool, input: typeof s.input === 'string' ? s.input : JSON.stringify(s.input ?? {}), output: s.output ?? null }
                    );
                    setSteps(mapped);
                    setActivityLegacy(!!d._legacy);
                })
                .catch(() => setSteps([]));
        } else {
            setSteps([]);
        }
    }, [jobId, agentId, fileOnlyMode]);

    const toolCallCount = steps?.filter(s => s.type === 'tool_call').length ?? 0;

    const lastAgentMessage = useMemo(() => {
        if (!steps) return '';
        const messageCalls = steps.filter(
            s => s.type === 'tool_call' && (s as Extract<DrawerJobStep, { type: 'tool_call' }>).tool === 'message'
        ) as Extract<DrawerJobStep, { type: 'tool_call' }>[];
        if (messageCalls.length === 0) return '';
        try {
            const input = JSON.parse(messageCalls[messageCalls.length - 1].input);
            return input.content ?? input.message ?? '';
        } catch { return ''; }
    }, [steps]);

    const displayResult = resultText || lastAgentMessage;

    /**
     * The single named tab this drawer was opened onto, when that is all it has.
     *
     * A drawer with one tab is not a tabbed surface — it is a panel with a name, and
     * showing that name twice (once as the header, once as a lone tab underneath) was
     * just noise. Knowing which one it is also lets the header stop calling an Artifacts
     * panel an "operation".
     */
    const namedSurface = useMemo(() => {
        const built = [
            { id: 'output', label: 'Output' },
            { id: 'files', label: isWorkspaceDrawer ? 'Workspace' : 'Files' },
            { id: 'activity', label: 'Activity' },
        ].filter(t => !tabs || tabs.includes(t.id as never));
        const all = built.concat((extraTabs ?? []).map(t => ({ id: t.id, label: t.label })));
        return all.length === 1 ? all[0] : null;
    }, [tabs, extraTabs, isWorkspaceDrawer]);

    const renderTabs = () => {
        // One tab needs no tab bar. The header already says what this is.
        if (namedSurface) return null;

        const builtInTabs = [
            { id: 'output', label: 'Output' },
            { id: 'files', label: isWorkspaceDrawer ? 'Workspace' : 'Files' },
            { id: 'activity', label: 'Activity' },
        ].filter(t => !tabs || tabs.includes(t.id as any));
        const allTabs = builtInTabs.concat((extraTabs ?? []).map(t => ({ id: t.id, label: t.label })));
        return (
            <div style={{ display: 'flex', borderBottom: '1px solid var(--cr-border)', flexShrink: 0, background: 'var(--cr-well)', overflowX: 'auto' }}>
                {allTabs.map(t => (
                    <button
                        key={t.id}
                        onClick={() => { setMainTab(t.id); setOpenFile(null); }}
                        style={{
                            flex: '1 0 auto', padding: '12px 8px', fontFamily: 'var(--cr-font-sans)', fontSize: '12px',
                            fontWeight: mainTab === t.id ? 700 : 400,
                            color: mainTab === t.id ? 'var(--cr-accent)' : 'var(--cr-muted)',
                            background: 'none', border: 'none',
                            borderBottom: mainTab === t.id ? '2px solid var(--cr-accent)' : '2px solid transparent',
                            cursor: 'pointer', transition: 'all 0.15s', letterSpacing: '0.02em', whiteSpace: 'nowrap'
                        }}
                    >
                        {t.label}
                        {t.id === 'activity' && steps && ` (${toolCallCount})`}
                    </button>
                ))}
            </div>
        );
    };

    const renderFileViewer = () => {
        if (!openFile) return null;
        const ext = openFile.filename.split('.').pop()?.toLowerCase() ?? '';
        const htmlFile  = isHtmlFile(openFile.filename);
        // Whose file this is, for the page's saved state. A cycle's file events arrive
        // with no context at all, only the agent id; a project or job file belongs to no
        // single agent, so it previews without storage.
        const fileAgentId = openFile.context === 'agent'
            ? openFile.contextId
            : (!openFile.context ? (openFile.contextId ?? agentId) : undefined);
        const svgFile   = isSvgFile(openFile.filename);
        const cssFile   = isCssFile(openFile.filename);
        const pyFile    = isPythonFile(openFile.filename);
        const jsFile    = isJsOrTsFile(openFile.filename);
        const sqlFile   = isSqlFile(openFile.filename);
        const shellFile = isShellFile(openFile.filename);
        // A binary file (.xlsx, .docx, .zip, ...) has no text content to show in
        // "Raw" mode — found 2026-09-22 rendering the ZIP-container bytes of an .xlsx
        // as if they were text. `content` holds the file's own URL for any binary file
        // (same convention isImageFile already used), never fetched-as-text bytes.
        const binaryFile = isBinaryFile(openFile.filename);
        // A binary format that also has a real renderer — XlsxViewer, DocxViewer — as
        // opposed to every other binary type, which only ever gets the download state.
        const spreadsheetFile = isSpreadsheetFile(openFile.filename);
        const docxFile = isDocxFile(openFile.filename);
        const downloadUrl = binaryFile && openFile.content
            ? toAbsoluteUrl(openFile.content, window.location.origin)
            : null;

        const modes: FileMode[] = binaryFile
            ? ['preview']
            : (htmlFile || svgFile || cssFile)
                ? ['preview', 'code', 'raw']
                : (pyFile || jsFile || sqlFile)
                    ? ['preview', 'raw', 'run']
                    : ['preview', 'raw'];

        const modeLabel = (m: FileMode) => {
            if (m === 'run')    return '▶ Run';
            if (m === 'code')   return 'Code';
            return 'Preview';
        };

        const noScroll = fileMode === 'run' || (fileMode === 'preview' && (htmlFile || cssFile));
        const noPad    = fileMode === 'run' || (fileMode === 'preview' && (htmlFile || cssFile)) || fileMode === 'code'
            || (fileMode === 'preview' && svgFile)
            || (fileMode === 'preview' && (ext === 'csv' || isCodeFile(openFile.filename)));

        return (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px', height: '38px', borderBottom: '1px solid var(--cr-border)', background: 'var(--cr-well)' }}>
                    {!fileOnlyMode && (
                        <button
                            onClick={() => setOpenFile(null)}
                            style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--cr-sub)', fontSize: '11px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '6px' }}
                        >
                            <ArrowLeft size={13} /> Back
                        </button>
                    )}
                    <span style={{ flex: 1, fontSize: '10px', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {openFile.filename}
                    </span>
                    <button
                        title="Open in new tab"
                        onClick={() => {
                            if (binaryFile && downloadUrl) {
                                // NOT a blob: URL here, on purpose. Every window.open in
                                // this app is handed to shell.openExternal (see the
                                // comment on the html branch below) — a blob: URL is only
                                // valid inside the renderer process that created it and
                                // means nothing to the OS, which is a second, separate
                                // reason the old generic "open in new tab" branch could
                                // never have worked for a non-html file here. A real
                                // absolute https:// URL is something the OS can actually
                                // fetch.
                                window.open(downloadUrl, '_blank');
                            } else if (isImageFile(openFile.filename)) {
                                window.open(openFile.content, '_blank');
                            } else if (htmlFile && fileAgentId && openFile.path) {
                                // In-app, not a new window: the desktop app hands every
                                // new-window request to Windows, which has no app for the
                                // about:blank this used to open. The full page also keeps what
                                // the page saved (see ArtifactFrame).
                                navigate(artifactViewPath(fileAgentId, openFile.path));
                            } else if (htmlFile) {
                                const w = window.open('', '_blank');
                                if (w) { w.document.write(openFile.content); w.document.close(); }
                            } else {
                                const blob = new Blob([openFile.content], { type: 'text/plain' });
                                const url = URL.createObjectURL(blob);
                                window.open(url, '_blank');
                                setTimeout(() => URL.revokeObjectURL(url), 10000);
                            }
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 9px', borderRadius: '6px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-muted)', fontSize: '9px', fontWeight: 600, fontFamily: 'var(--cr-font-sans)', cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--cr-accent)'; e.currentTarget.style.color = 'var(--cr-accent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--cr-border)'; e.currentTarget.style.color = 'var(--cr-muted)'; }}
                    >↗ New tab</button>
                    <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--cr-border)', flexShrink: 0 }}>
                        {modes.map((m: FileMode) => (
                            <button
                                key={m}
                                onClick={() => setFileMode(m)}
                                style={{
                                    padding: '3px 10px', fontSize: '9px', fontWeight: 600, border: 'none', cursor: 'pointer', transition: 'all 0.15s',
                                    background: fileMode === m ? 'var(--cr-accent-15)' : 'transparent',
                                    color: fileMode === m ? 'var(--cr-accent)' : 'var(--cr-muted)',
                                    fontFamily: 'var(--cr-font-sans)'
                                }}
                            >{modeLabel(m)}</button>
                        ))}
                    </div>
                </div>
                <div style={{ flex: 1, overflowY: noScroll ? 'hidden' : 'auto', padding: noPad ? '0' : '16px' }}>
                    {spreadsheetFile && openFile.content ? (
                        <XlsxViewer filename={openFile.filename} url={openFile.content} />
                    ) : docxFile && openFile.content ? (
                        <DocxViewer filename={openFile.filename} url={openFile.content} />
                    ) : binaryFile ? (
                        // Mirrors ArtifactPreviewBody's fallback state — same message,
                        // same shape — so a file looks the same whether it was opened
                        // from Artifacts or from the Workspace panel. Reached by any
                        // binary format WITHOUT a real renderer above (zip, pdf, media,
                        // .xls/.doc — SheetJS/mammoth read those old formats too, but
                        // this app has never verified that path against a real file, so
                        // they stay here rather than claim support that isn't tested).
                        <div style={{ textAlign: 'center', padding: 40 }}>
                            <div style={{ fontSize: 32, marginBottom: 12 }}>📁</div>
                            <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 13, color: 'var(--cr-muted)' }}>
                                Preview not available for this file type.
                            </p>
                            {downloadUrl && (
                                <a
                                    href={downloadUrl}
                                    download={openFile.filename}
                                    style={{ display: 'inline-block', marginTop: 12, padding: '8px 20px', borderRadius: 8, background: 'var(--cr-accent-15)', border: '1px solid var(--cr-accent)', color: 'var(--cr-accent)', fontFamily: 'var(--cr-font-sans)', fontSize: 12, textDecoration: 'none', fontWeight: 600 }}
                                >
                                    Download file
                                </a>
                            )}
                        </div>
                    ) : fileMode === 'run' && pyFile ? (
                        <PythonRunner code={openFile.content} filename={openFile.filename} workspaceFiles={siblingFiles} />
                    ) : fileMode === 'run' && jsFile ? (
                        <JsRunner code={openFile.content} filename={openFile.filename} />
                    ) : fileMode === 'run' && sqlFile ? (
                        <SqlRunner code={openFile.content} />
                    ) : fileMode === 'preview' && htmlFile ? (
                        <HtmlPreview content={openFile.content} agentId={fileAgentId} filePath={openFile.path} />
                    ) : fileMode === 'preview' && svgFile ? (
                        <SvgPreview content={openFile.content} />
                    ) : fileMode === 'preview' && cssFile ? (
                        <CssPreview content={openFile.content} />
                    ) : fileMode === 'code' ? (
                        <CodeViewer filename={openFile.filename} code={openFile.content} />
                    ) : fileMode === 'raw' ? (
                        <pre style={{ margin: 0, padding: '16px', fontSize: '12px', lineHeight: 1.7, color: 'var(--cr-sub)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--cr-font-mono)' }}>
                            {openFile.content}
                        </pre>
                    ) : ext === 'csv' ? (
                        <CsvViewer filename={openFile.filename} csvText={openFile.content} />
                    ) : ext === 'md' ? (
                        <MarkdownViewer
                            content={openFile.content}
                            context={openFile.context}
                            contextId={openFile.contextId}
                            basePath={openFile.path ? openFile.path.split('/').slice(0, -1).join('/') : undefined}
                        />
                    ) : ext === 'json' ? (
                        (() => { try { return <JsonViewer data={JSON.parse(openFile.content)} />; } catch { return <pre style={{ margin: 0, padding: '16px', fontSize: '12px', color: 'var(--cr-sub)', whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)' }}>{openFile.content}</pre>; } })()
                    ) : isCodeFile(openFile.filename) ? (
                        <CodeViewer filename={openFile.filename} code={openFile.content} />
                    ) : isImageFile(openFile.filename) ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', height: '100%', background: 'var(--cr-well)' }}>
                            <img
                                src={openFile.content}
                                alt={openFile.filename}
                                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 4px 24px var(--cr-shade-2)' }}
                            />
                        </div>
                    ) : (
                        <pre style={{ margin: 0, padding: '16px', fontSize: '12px', lineHeight: 1.7, color: 'var(--cr-sub)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--cr-font-mono)' }}>
                            {openFile.content}
                        </pre>
                    )}
                </div>
            </div>
        );
    };

    // On mobile there's no room to push or overlay a 420px-wide panel beside content —
    // it either eats the whole screen sideways or clips against `.page-content`'s
    // overflow-x:hidden. Always render as a full-width fixed overlay instead.
    const useFixed = fileOnlyMode || overlay || isMobile;
    const containerStyle: React.CSSProperties = useFixed
        ? {
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: isMobile ? '100%' : `${width}px`,
            background: 'var(--cr-bg-sidebar)', borderLeft: isMobile ? 'none' : '1px solid var(--cr-border)',
            display: 'flex', flexDirection: 'column', zIndex: 400,
            boxShadow: '-8px 0 32px var(--cr-shade-2)',
            userSelect: isResizing ? 'none' : undefined,
        }
        : {
            width: `${width}px`, flexShrink: 0, display: 'flex', flexDirection: 'column',
            borderLeft: '1px solid var(--cr-border)', background: 'var(--cr-bg-sidebar)',
            overflow: 'hidden', height: '100%', position: 'relative', zIndex: 1000,
            userSelect: isResizing ? 'none' : undefined,
        };

    return (
        <>
        {useFixed && <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--cr-scrim)', zIndex: 399, backdropFilter: 'blur(2px)' }} />}
        <div style={containerStyle}>
            {/* Resize handle — not applicable on mobile (full-width, nothing to resize against) */}
            {!isMobile && <div
                onMouseDown={handleResizeMouseDown}
                style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px',
                    cursor: 'ew-resize', zIndex: 10,
                    background: isResizing ? 'var(--cr-accent)' : 'transparent',
                    transition: 'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--cr-accent-60)'; }}
                onMouseLeave={e => { if (!isResizing) e.currentTarget.style.background = 'transparent'; }}
            />}

            {/* Header — file-themed for file-only mode, job-themed for normal mode, manage-themed for mode='manage' */}
            <div style={{
                flexShrink: 0, padding: '16px 20px',
                background: fileOnlyMode || isWorkspaceDrawer || mode === 'manage'
                    ? 'linear-gradient(135deg, var(--cr-accent-15), transparent)'
                    : isSuccess
                        ? 'linear-gradient(135deg, var(--cr-green-low), transparent)'
                        : 'linear-gradient(135deg, var(--cr-error-low), transparent)',
                borderBottom: `1px solid ${fileOnlyMode || isWorkspaceDrawer || mode === 'manage' ? 'var(--cr-accent-25)' : isSuccess ? 'var(--cr-green-line)' : 'var(--cr-error-line)'}`,
                display: 'flex', alignItems: 'flex-start', gap: '14px',
            }}>
                <div style={{ fontSize: '20px', marginTop: '2px' }}>
                    {fileOnlyMode ? '📄' : isWorkspaceDrawer ? '📁' : mode === 'manage' ? '⚙️'
                        : namedSurface ? '🗂' : isSuccess ? '✅' : '❌'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                        fontFamily: 'var(--cr-font-mono)', fontSize: '9px', fontWeight: 700,
                        color: fileOnlyMode || isWorkspaceDrawer || mode === 'manage' ? 'var(--cr-accent)' : isSuccess ? 'var(--cr-green)' : 'var(--cr-error-str)',
                        letterSpacing: '0.08em', textTransform: 'uppercase'
                    }}>
                        {/* "OPERATION SUCCESS" is the right eyebrow for a job result and
                            the wrong one for everything else. A drawer opened straight
                            onto a named tab — Artifacts, Browser, Output — is not
                            reporting on an operation at all, and saying so was both
                            meaningless and slightly alarming. */}
                        {fileOnlyMode ? 'FILE'
                            : isWorkspaceDrawer ? 'WORKSPACE'
                            : mode === 'manage' ? 'MANAGE'
                            : namedSurface ? namedSurface.label.toUpperCase()
                            : isSuccess ? 'OPERATION SUCCESS' : 'OPERATION FAILED'}
                    </div>
                    <div style={{
                        fontFamily: 'var(--cr-font-serif)', fontSize: '16px', color: 'var(--cr-cream)',
                        marginTop: '4px', lineHeight: 1.3,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {fileOnlyMode ? (openFile?.filename ?? '')
                            : isWorkspaceDrawer ? 'Workspace'
                            : namedSurface ? namedSurface.label
                            : (title || jobId)}
                    </div>
                </div>
                <button
                    onClick={onClose}
                    style={{ background: 'none', border: 'none', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: '18px', padding: '4px' }}
                ><X size={18} /></button>
            </div>

            {openFile ? renderFileViewer() : (
                        <>
                            {renderTabs()}
                            <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
                                {mainTab === 'output' && (
                                    <div style={{ animation: 'crewFadeUp 0.3s ease-out' }}>
                                        {(htmlFilesLoading || htmlFiles.length > 0) && (
                                            <div style={{ marginBottom: '24px' }}>
                                                <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', fontWeight: 600, color: 'var(--cr-muted-br)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '10px' }}>
                                                    {htmlFilesLoading ? 'Artifacts' : `Artifacts · ${htmlFiles.length}`}
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                    {htmlFilesLoading ? (
                                                        <div style={{ height: '56px', borderRadius: '10px', background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', opacity: 0.5 }} />
                                                    ) : htmlFiles.map(f => {
                                                        const eventColors: Record<string, { bg: string; color: string; border: string; label: string }> = {
                                                            create: { bg: 'var(--cr-green-low)',  color: 'var(--cr-green)', border: 'var(--cr-green-line)', label: '+ CREATE' },
                                                            write:  { bg: 'var(--cr-blue-low)',  color: 'var(--cr-blue)', border: 'var(--cr-blue-line)', label: '~ WRITE' },
                                                            delete: { bg: 'var(--cr-error-low)', color: 'var(--cr-error)', border: 'var(--cr-error-line)', label: '✕ DELETE' },
                                                        };
                                                        const badge = f.eventType ? eventColors[f.eventType] : null;
                                                        const projectBadge = f.source === 'project'
                                                            ? { bg: 'var(--cr-purple-low)', color: 'var(--cr-purple)', border: 'var(--cr-purple-line)', label: 'IN PROJECT' }
                                                            : null;
                                                        return (
                                                            <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderLeft: `3px solid ${badge?.color ?? projectBadge?.color ?? 'var(--cr-border)'}`, borderRadius: '10px' }}>
                                                                <div style={{ width: '32px', height: '32px', borderRadius: '8px', flexShrink: 0, background: 'var(--cr-accent-25)', border: '1px solid var(--cr-accent-40)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                                    <Globe size={14} color="var(--cr-accent)" />
                                                                </div>
                                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '2px' }}>
                                                                        <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '13px', color: 'var(--cr-cream)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '300px' }}>{f.filename}</span>
                                                                        {badge && (
                                                                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '8px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', background: badge.bg, border: `1px solid ${badge.border}`, color: badge.color, letterSpacing: '0.06em' }}>
                                                                                {badge.label}
                                                                            </span>
                                                                        )}
                                                                        {projectBadge && (
                                                                            <span title="Pre-existing file in this project's shared workspace" style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '8px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px', background: projectBadge.bg, border: `1px solid ${projectBadge.border}`, color: projectBadge.color, letterSpacing: '0.06em' }}>
                                                                                {projectBadge.label}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)' }}>
                                                                        {(f.filename.split('.').pop() ?? 'FILE').toUpperCase()} · {f.sizeBytes > 0 ? `${(f.sizeBytes / 1024).toFixed(1)} KB` : '—'}
                                                                        {f.path !== f.filename && <> · <span style={{ opacity: 0.7 }}>{f.path}</span></>}
                                                                    </div>
                                                                </div>
                                                                <button
                                                                    onClick={() => {
                                                                        const ctx = f.contextId === agentId ? 'agent' : 'project';
                                                                        if (isImageFile(f.filename)) {
                                                                            // For images, store the URL as content — rendered via <img> tag
                                                                            const imgUrl = `/api/files/content?context=${ctx}&contextId=${encodeURIComponent(f.contextId)}&path=${encodeURIComponent(f.path)}`;
                                                                            setFileMode('preview');
                                                                            setOpenFile({ filename: f.filename, content: imgUrl, path: f.path, context: ctx, contextId: f.contextId });
                                                                            return;
                                                                        }
                                                                        if (isBinaryFile(f.filename)) {
                                                                            // An .xlsx (or .docx, .zip, ...) fetched with r.text() and
                                                                            // rendered into a <pre> showed the raw ZIP-container bytes as
                                                                            // decoded "text" — found 2026-09-22. Never fetch a known-binary
                                                                            // file as text. Same convention as the image branch above: the
                                                                            // URL is the "content", and the render layer decides what to do
                                                                            // with it (a real viewer for xlsx/docx, download-only for
                                                                            // anything else) — this handler does not need to know which.
                                                                            const fileUrl = `/api/files/content?context=${ctx}&contextId=${encodeURIComponent(f.contextId)}&path=${encodeURIComponent(f.path)}`;
                                                                            setFileMode('preview');
                                                                            setOpenFile({ filename: f.filename, content: fileUrl, path: f.path, context: ctx, contextId: f.contextId });
                                                                            return;
                                                                        }
                                                                        fetch(`/api/files/content?context=${ctx}&contextId=${encodeURIComponent(f.contextId)}&path=${encodeURIComponent(f.path)}`)
                                                                            .then(r => r.ok ? r.text() : '')
                                                                            .then(content => { setFileMode('preview'); setOpenFile({ filename: f.filename, content, path: f.path, context: ctx, contextId: f.contextId }); })
                                                                            .catch(() => {});
                                                                    }}
                                                                    style={{ padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', background: 'linear-gradient(135deg, var(--cr-accent), var(--cr-accent-warm))', border: 'none', color: 'var(--cr-on-accent)', fontFamily: 'var(--cr-font-sans)', fontSize: '12px', fontWeight: 600, flexShrink: 0, boxShadow: '0 2px 8px var(--cr-accent-40)' }}
                                                                >
                                                                    Preview →
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                                            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', fontWeight: 600, color: 'var(--cr-muted-br)', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1 }}>Mission Results</div>
                                            <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--cr-border)' }}>
                                                {(['preview', 'raw'] as const).map(m => (
                                                    <button key={m} onClick={() => setResultMode(m)} style={{ padding: '3px 10px', fontSize: '9px', fontWeight: 700, border: 'none', cursor: 'pointer', transition: 'all 0.15s', background: resultMode === m ? 'var(--cr-accent-15)' : 'transparent', color: resultMode === m ? 'var(--cr-accent)' : 'var(--cr-muted)', textTransform: 'uppercase' }}>{m}</button>
                                                ))}
                                            </div>
                                        </div>

                                        {displayResult ? (() => {
                                            const isHtmlResult = /<!doctype\s+html/i.test(displayResult);
                                            return (
                                                <div style={{ background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderRadius: '12px', padding: '18px', overflow: 'hidden', boxShadow: 'inset 0 0 40px var(--cr-shade-1)' }}>
                                                    {resultMode === 'preview' ? (() => {
                                                        if (isHtmlResult) {
                                                            const { text: surroundText } = extractArtifact(displayResult);
                                                            const textToShow = surroundText.trim();
                                                            if (!textToShow) return null;
                                                            return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{textToShow}</ReactMarkdown></div>;
                                                        }
                                                        try {
                                                            const parsed = JSON.parse(displayResult);
                                                            return <JsonViewer data={parsed} />;
                                                        } catch {
                                                            return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{displayResult}</ReactMarkdown></div>;
                                                        }
                                                    })() : (
                                                        <pre style={{ margin: 0, fontSize: '12px', lineHeight: 1.7, color: 'var(--cr-sub)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--cr-font-mono)' }}>
                                                            {displayResult}
                                                        </pre>
                                                    )}
                                                </div>
                                            );
                                        })() : (
                                            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--cr-muted)', fontSize: '12px' }}>
                                                No textual output available.
                                            </div>
                                        )}
                                    </div>
                                )}

                                {mainTab === 'files' && (
                                    <div style={{ animation: 'crewFadeUp 0.3s ease-out' }}>
                                        {agentId ? (
                                            <WorkspacePanel
                                                context="agent"
                                                contextId={agentId}
                                                accentColor="var(--cr-accent)"
                                                defaultCollapsed={false}
                                                eventsByPath={cycleEventMap}
                                                refreshSignal={refreshSignal}
                                                onOpen={(filename, content, path, context, contextId) => {
                                                    setFileMode('preview');
                                                    setOpenFile({ filename, content, path, context, contextId });
                                                }}
                                            />
                                        ) : workspaceProjectId ? (
                                            <WorkspaceTree
                                                projectId={workspaceProjectId}
                                                accentColor="var(--cr-accent)"
                                                onOpen={(filename, content, path, context, contextId) => {
                                                    setFileMode('preview');
                                                    setOpenFile({ filename, content, path, context, contextId });
                                                }}
                                            />
                                        ) : (
                                            <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: 12, color: 'var(--cr-muted)', padding: '12px 0' }}>
                                                No workspace files for this view.
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Extra tabs injected by the parent (e.g. Team / Bulletin) */}
                                {mainTab !== 'output' && mainTab !== 'files' && mainTab !== 'activity' && (
                                    <div style={{ animation: 'crewFadeUp 0.3s ease-out' }}>
                                        {(() => {
                                            const found = (extraTabs ?? []).find(t => t.id === mainTab)?.content ?? null;
                                            if (typeof found === 'function') {
                                                return found((file) => { setFileMode('preview'); setOpenFile(file); });
                                            }
                                            return found;
                                        })()}
                                    </div>
                                )}

                                {mainTab === 'activity' && (
                                    <div style={{ animation: 'crewFadeUp 0.3s ease-out' }}>
                                        <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted-br)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '16px' }}>Operational Timeline</div>
                                        {activityLegacy && (
                                            <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: 'var(--cr-amber-low)', border: '1px solid var(--cr-amber-line)', fontFamily: 'var(--cr-font-sans)', fontSize: 11, color: 'var(--cr-warn)', lineHeight: 1.5 }}>
                                                ⚠ This cycle ran before per-cycle activity capture was enabled. Showing the most recent cycle's trace as a fallback — it may not be from this cycle.
                                            </div>
                                        )}
                                        {steps && steps.length > 0 ? (
                                            <div style={{ position: 'relative', paddingLeft: '8px' }}>
                                                <div style={{ position: 'absolute', left: '12px', top: '8px', bottom: '8px', width: '1px', borderLeft: '1px solid var(--cr-border)', zIndex: 0 }} />
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                                    {steps.map((s, i) => {
                                                        if (s.type === 'thinking') {
                                                            return (
                                                                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', position: 'relative', zIndex: 1 }}>
                                                                    <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--cr-bg-sidebar)', border: '2px solid var(--cr-muted)', flexShrink: 0, marginTop: '3px' }} />
                                                                    <div style={{ fontSize: '11px', color: 'var(--cr-muted)', fontStyle: 'italic' }}>{s.content}</div>
                                                                </div>
                                                            );
                                                        }
                                                        const tc = s as Extract<DrawerJobStep, { type: 'tool_call' }>;
                                                        return (
                                                            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', position: 'relative', zIndex: 1 }}>
                                                                <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--cr-bg-sidebar)', border: `2px solid var(--cr-accent)`, flexShrink: 0, marginTop: '3px' }} />
                                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                                    <div style={{ fontSize: '9px', fontWeight: 800, color: 'var(--cr-accent)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--cr-font-mono)' }}>
                                                                        {tc.tool.replace(/_/g, ' ')}
                                                                    </div>
                                                                    <div style={{ fontSize: '10.5px', fontFamily: 'var(--cr-font-mono)', background: 'var(--cr-well)', border: '1px solid var(--cr-border)', padding: '6px 10px', borderRadius: '6px', marginTop: '4px', color: 'var(--cr-sub)', wordBreak: 'break-all' }}>
                                                                        {tc.input.slice(0, 500)}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ) : (
                                            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--cr-muted)', fontSize: '12px' }}>
                                                No activity logs recorded.
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
        </div>
        </>
    );
}
