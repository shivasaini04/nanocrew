import React from 'react';
import { CR, withAlpha } from '../lib/cr';

/**
 * TurnFiles — inline file artifacts attached under a finished turn (image
 * thumbnails + type-aware chips). Shared by the agent chat and the project chat;
 * the only difference is the file-content `context` (agent vs project workspace).
 */

export interface TurnFile {
    id: string;
    filename: string;
    path: string;
    sizeBytes?: number;
}

interface TurnFilesProps {
    files: TurnFile[];
    context: 'agent' | 'project';
    contextId: string;
    accentColor?: string;
    /** Open handler for non-image files (e.g. an in-app viewer). Defaults to a new tab. */
    onOpenFile?: (f: TurnFile) => void;
    /** Cap the number of chips shown before collapsing the rest into a "+N more" pill. */
    maxVisible?: number;
    /** Click handler for the "+N more" pill (e.g. switch to the full workspace browser). */
    onShowMore?: () => void;
}

function iconFor(ext: string): string {
    if (ext === 'csv') return '📊';
    if (ext === 'json') return '🗂️';
    if (ext === 'pdf') return '📕';
    if (['js', 'ts', 'tsx', 'jsx'].includes(ext)) return '⚡';
    if (ext === 'py') return '🐍';
    if (['md', 'txt'].includes(ext)) return '📄';
    return '📄';
}

export function TurnFiles({ files, context, contextId, accentColor = CR.accent, onOpenFile, maxVisible, onShowMore }: TurnFilesProps) {
    if (!files || files.length === 0) return null;
    const cap = maxVisible && maxVisible > 0 ? maxVisible : files.length;
    const visible = files.slice(0, cap);
    const hidden = files.length - visible.length;
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {visible.map(f => {
                const ext = (f.filename.split('.').pop() || '').toLowerCase();
                const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
                const contentUrl = `/api/files/content?context=${context}&contextId=${encodeURIComponent(contextId)}&path=${encodeURIComponent(f.path)}`;
                const label = f.filename.split('/').pop() || f.filename;
                if (isImg) {
                    return (
                        <button key={f.id} onClick={() => window.open(contentUrl, '_blank')} title={f.filename}
                            style={{ padding: 0, border: `1px solid ${CR.border}`, borderRadius: 10, overflow: 'hidden', cursor: 'pointer', background: CR.bgSurf, maxWidth: 220 }}
                            onMouseEnter={e => e.currentTarget.style.borderColor = withAlpha(accentColor, 31)}
                            onMouseLeave={e => e.currentTarget.style.borderColor = CR.border}>
                            <img src={contentUrl} alt={f.filename} style={{ display: 'block', maxWidth: 220, maxHeight: 160, objectFit: 'cover' }} />
                            <div style={{ padding: '4px 8px', fontFamily: CR.mono, fontSize: 10, color: CR.sub, borderTop: `1px solid ${CR.border}` }}>🖼️ {label}</div>
                        </button>
                    );
                }
                return (
                    <button key={f.id} onClick={() => onOpenFile ? onOpenFile(f) : window.open(contentUrl, '_blank')}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, background: CR.bgSurf, border: `1px solid ${CR.border}`, cursor: 'pointer', color: CR.sub, fontFamily: CR.mono, fontSize: 11 }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = withAlpha(accentColor, 31); e.currentTarget.style.color = CR.cream; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.color = CR.sub; }}>
                        <span style={{ fontSize: 12 }}>{iconFor(ext)}</span>
                        <span>{label}</span>
                        {f.sizeBytes ? <span style={{ color: CR.muted }}>{(f.sizeBytes / 1024).toFixed(1)}kb</span> : null}
                    </button>
                );
            })}
            {hidden > 0 && (
                <button onClick={onShowMore} title={onShowMore ? 'Open in workspace' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, background: 'transparent', border: `1px dashed ${CR.border}`, cursor: onShowMore ? 'pointer' : 'default', color: CR.muted, fontFamily: CR.mono, fontSize: 11 }}
                    onMouseEnter={e => { if (onShowMore) { e.currentTarget.style.borderColor = withAlpha(accentColor, 31); e.currentTarget.style.color = CR.cream; } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = CR.border; e.currentTarget.style.color = CR.muted; }}>
                    +{hidden} more →
                </button>
            )}
        </div>
    );
}

