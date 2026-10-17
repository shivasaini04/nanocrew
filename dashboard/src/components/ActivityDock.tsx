import { useState, useEffect } from 'react';
import { Search, FileText, Terminal } from 'lucide-react';
import { WEB_TOOLS, FILE_TOOLS, SHELL_TOOLS, PillStrip } from './ChatBubble';
import type { ActivityStep } from './ChatBubble';

type PanelId = 'web' | 'files' | 'shell';

// --- Helpers ---

function stepSummary(step: ActivityStep): string {
    try {
        const a = JSON.parse(step.input);
        if (step.tool === 'web_search') return `"${(a.query ?? '').slice(0, 80)}"`;
        if (step.tool === 'web_fetch' || step.tool === 'browser') return (a.url ?? step.input).slice(0, 80);
        if (step.tool === 'bash' || step.tool === 'shell') return (a.command ?? a.cmd ?? step.input).slice(0, 80);
        const path = a.path ?? a.file_path ?? null;
        if (path) return path;
        return Object.values(a).filter(Boolean).join(' · ').toString().slice(0, 80);
    } catch { return step.input.slice(0, 80); }
}

function fileIcon(name: string): string {
    if (name.endsWith('.md') || name.endsWith('.txt')) return '📄';
    if (name.endsWith('.csv'))  return '📊';
    if (name.endsWith('.json')) return '{}';
    if (name.endsWith('.pdf'))  return '📕';
    if (name.endsWith('.py'))   return '🐍';
    if (name.endsWith('.js') || name.endsWith('.ts')) return '⚡';
    return '📄';
}

// --- Dynamic Components ---

function WebPanel({ steps }: { steps: ActivityStep[] }) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    if (steps.length === 0) return (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--cr-muted)', fontSize: '12px', fontFamily: 'var(--cr-font-sans)' }}>
            No web activity this session
        </div>
    );

    return (
        <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column' }}>
            {steps.map(step => {
                const summary = stepSummary(step);
                const isOpen = expanded[step.id];
                return (
                    <div key={step.id} style={{ borderBottom: '1px solid var(--cr-border)' }}>
                        <div
                            style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', cursor: step.output ? 'pointer' : 'default' }}
                            onClick={() => step.output && setExpanded(p => ({ ...p, [step.id]: !p[step.id] }))}
                        >
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-accent)', fontWeight: 600, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                {step.tool.replace(/_/g, ' ')}
                            </span>
                            <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '12px', color: 'var(--cr-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                {summary}
                            </span>
                            {step.output && (
                                <span style={{ fontSize: '10px', color: 'var(--cr-muted)', flexShrink: 0, transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
                            )}
                        </div>
                        {isOpen && step.output && (
                            <div style={{
                                margin: '0 0 12px 12px', padding: '10px 12px',
                                background: 'var(--cr-well)', borderRadius: '6px',
                                border: '1px solid var(--cr-border)',
                                fontSize: '11px', color: 'var(--cr-muted)',
                                fontFamily: 'var(--cr-font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                maxHeight: '180px', overflowY: 'auto',
                            }}>
                                {step.output.slice(0, 800)}{step.output.length > 800 ? '…' : ''}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Extract the file path a file tool call operated on. Accept any of the path-like keys
// agents use; never fall back to step.input (which is the file's content blob).
function filePathOf(step: ActivityStep): string | undefined {
    try {
        const a = JSON.parse(step.input);
        const p = a.path ?? a.file_path ?? a.filepath ?? a.target_file ?? a.TargetFile;
        return typeof p === 'string' && p.trim() ? p : undefined;
    } catch { return undefined; }
}

// Count of DISTINCT files touched (deduped by path) — matches the rows the Files panel
// renders, so the dock badge agrees with the list instead of counting raw tool calls.
function distinctFileCount(steps: ActivityStep[]): number {
    const paths = new Set<string>();
    for (const s of steps) { const p = filePathOf(s); if (p) paths.add(p); }
    return paths.size;
}

function FilesPanel({ steps, onOpenFile }: { steps: ActivityStep[]; onOpenFile?: (containerPath: string) => void }) {
    const fileMap = new Map<string, Set<string>>();
    steps.forEach(step => {
        const path = filePathOf(step);
        // Skip malformed tool calls (agent forgot to pass a path) so the panel doesn't
        // render the raw content blob as if it were a filename.
        if (!path) return;
        const op = step.tool === 'read_file' ? 'read'
                 : step.tool === 'write_file' || step.tool === 'create_file' ? 'write'
                 : step.tool === 'append_file' ? 'append'
                 : step.tool === 'edit_file' || step.tool === 'str_replace_editor' ? 'edit'
                 : 'mod';
        if (!fileMap.has(path)) fileMap.set(path, new Set());
        fileMap.get(path)!.add(op);
    });

    const entries = [...fileMap.entries()].slice(0, 30);

    if (entries.length === 0) return (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--cr-muted)', fontSize: '12px' }}>
            No file activity this session
        </div>
    );

    return (
        <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column' }}>
            {entries.map(([path, opsSet]) => {
                const filename = path.split('/').pop() ?? path;
                const ops = [...opsSet];
                return (
                    <div key={path} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--cr-border)' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'var(--cr-tint-2)', border: '1px solid var(--cr-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', flexShrink: 0 }}>
                            {fileIcon(filename)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '12px', color: 'var(--cr-cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {filename}
                            </div>
                            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {path}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                            {onOpenFile && (ops.includes('write') || ops.includes('created') || ops.includes('mod')) ? (
                                <button
                                    onClick={() => onOpenFile(path)}
                                    style={{ 
                                        fontFamily: 'var(--cr-font-sans)', fontSize: '10px', color: 'var(--cr-accent)', 
                                        background: 'var(--cr-accent-low)', border: '1px solid var(--cr-accent-30)', 
                                        borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' 
                                    }}
                                >OPEN</button>
                            ) : (
                                ops.map(op => (
                                    <span key={op} style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)', border: '1px solid var(--cr-border)', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase' }}>{op}</span>
                                ))
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function ShellPanel({ steps }: { steps: ActivityStep[] }) {
    if (steps.length === 0) return (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--cr-muted)', fontSize: '12px' }}>
            No shell commands this session
        </div>
    );

    return (
        <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column' }}>
            {steps.map(step => {
                let cmd = step.input;
                try { cmd = JSON.parse(step.input).command ?? step.input; } catch { /**/ }
                return (
                    <div key={step.id} style={{ borderBottom: '1px solid var(--cr-border)', padding: '10px 0' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '11px', color: 'var(--cr-accent-warm)' }}>$</span>
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '11px', color: 'var(--cr-sub)', overflow: 'hidden', wordBreak: 'break-all' }}>
                                {cmd}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// --- Main Components ---


export interface ActivityDockProps {
    sessionSteps: ActivityStep[];
    liveSteps: ActivityStep[];
    isTyping: boolean;
    onOpenFile?: (path: string) => void;
    statusLabel?: React.ReactNode;
    /** Caps and centers the chip row to line up with a capped-width input box below it
     * (AgentProfilePage's merged pill is 760px). Omit for full-bleed (ProjectDetailPage). */
    maxWidth?: number;
    extraItems?: Array<{
        id: string;
        label: string;
        icon: React.ReactNode;
        count?: number;
        color?: string;
        active?: boolean;
        onClick: () => void;
    }>;
}

export function ActivityDock({ sessionSteps, liveSteps, isTyping, onOpenFile, statusLabel, extraItems, maxWidth }: ActivityDockProps) {
    const [activePanel, setActivePanel] = useState<PanelId | null>(null);

    useEffect(() => {
        const handler = (e: CustomEvent) => setActivePanel(e.detail as PanelId);
        window.addEventListener('open-dock-panel', handler as EventListener);
        return () => window.removeEventListener('open-dock-panel', handler as EventListener);
    }, []);

    const allSteps = [...sessionSteps, ...liveSteps];
    const counts = {
        web: allSteps.filter(s => WEB_TOOLS.has(s.tool)).length,
        files: distinctFileCount(allSteps.filter(s => FILE_TOOLS.has(s.tool))),
        shell: allSteps.filter(s => SHELL_TOOLS.has(s.tool)).length,
    };

    const hasCounts = Object.values(counts).some(c => c > 0);
    const hasExtra = extraItems && extraItems.length > 0;
    if (!hasCounts && !hasExtra) return null;

    return (
        <div style={{ flexShrink: 0, position: 'relative' }}>
            {activePanel && (
                <div style={{
                    position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 100,
                    background: 'var(--cr-bg-surf)', borderTop: '1px solid var(--cr-border)',
                    boxShadow: '0 -10px 30px var(--cr-shade-2)', maxHeight: '350px',
                    display: 'flex', flexDirection: 'column', animation: 'crewFadeUp 0.2s ease-out'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', borderBottom: '1px solid var(--cr-border)', background: 'var(--cr-well)' }}>
                        <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted-br)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                            {activePanel} Activity
                        </span>
                        <button onClick={() => setActivePanel(null)} style={{ background: 'none', border: 'none', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: '18px', padding: 0 }}>×</button>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                        {activePanel === 'web' && <WebPanel steps={allSteps.filter(s => WEB_TOOLS.has(s.tool))} />}
                        {activePanel === 'files' && <FilesPanel steps={allSteps.filter(s => FILE_TOOLS.has(s.tool))} onOpenFile={onOpenFile} />}
                        {activePanel === 'shell' && <ShellPanel steps={allSteps.filter(s => SHELL_TOOLS.has(s.tool))} />}
                    </div>
                </div>
            )}

            {/* Restyled 2026-08-15 to sit flush against the merged chat-input pill below:
                lucide icons instead of emoji, lighter weight, softer border — chips
                should read as a quiet row of shortcuts, not a second toolbar. When maxWidth
                is set, the row is capped and centered so it lines up over the pill instead
                of stretching full-bleed with the chips bunched at the left edge. */}
            <div style={{ display: 'flex', justifyContent: maxWidth ? 'center' : undefined, padding: '8px 18px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', maxWidth, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                {extraItems?.map(({ id, label, icon, count, color, active, onClick }) => (
                    <button key={id} onClick={() => { setActivePanel(null); onClick(); }}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 10px', borderRadius: '7px', flexShrink: 0, whiteSpace: 'nowrap',
                            background: active ? 'var(--cr-bg-surf)' : 'transparent',
                            border: `1px solid ${active ? (color || 'var(--cr-accent)') : 'var(--cr-border)'}`,
                            color: active ? 'var(--cr-cream)' : 'var(--cr-muted)',
                            fontFamily: 'var(--cr-font-sans)', fontSize: '11px', fontWeight: 500, cursor: 'pointer'
                        }}
                    >
                        <span style={{ display: 'flex' }}>{icon}</span>
                        <span>{label}</span>
                        {count !== undefined && count > 0 && (
                            <span style={{ fontSize: '9px', opacity: 0.6 }}>{count}</span>
                        )}
                    </button>
                ))}

                {[
                    { id: 'web',   icon: <Search size={12} />,   label: 'Web',   color: 'var(--cr-accent)' },
                    { id: 'files', icon: <FileText size={12} />, label: 'Files', color: 'var(--cr-green)' },
                    { id: 'shell', icon: <Terminal size={12} />, label: 'Shell', color: 'var(--cr-accent-warm)' },
                ].map(({ id, icon, label, color }) => (
                    counts[id as PanelId] > 0 && (
                        <button key={id} onClick={() => setActivePanel(p => p === id ? null : (id as PanelId))}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 10px', borderRadius: '7px', flexShrink: 0, whiteSpace: 'nowrap',
                                background: activePanel === id ? 'var(--cr-bg-surf)' : 'transparent',
                                border: `1px solid ${activePanel === id ? color : 'var(--cr-border)'}`,
                                color: activePanel === id ? 'var(--cr-cream)' : 'var(--cr-muted)',
                                fontFamily: 'var(--cr-font-sans)', fontSize: '11px', fontWeight: 500, cursor: 'pointer'
                            }}
                        >
                            <span style={{ display: 'flex' }}>{icon}</span>
                            <span>{label}</span>
                            <span style={{ fontSize: '9px', opacity: 0.6 }}>{counts[id as PanelId]}</span>
                        </button>
                    )
                ))}
                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted-br)', marginLeft: 'auto', letterSpacing: '0.05em', flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {statusLabel ?? 'SESSION ACTIVE'}
                </span>
            </div>
            </div>
        </div>
    );
}
