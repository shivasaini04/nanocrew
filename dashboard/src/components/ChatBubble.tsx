import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { format } from 'date-fns';
import { Search, FileText, Terminal, Globe } from 'lucide-react';
import { CR, withAlpha } from '../lib/cr';
import { CycleTimeline, type TimelineStep } from './CycleTimeline';
import { useNavigate } from 'react-router-dom';
import ArtifactFrame, { artifactViewPath } from './ArtifactFrame';

export interface ActivityStep {
    id: string;
    type?: 'tool_call' | 'thinking';
    tool: string;
    input: string;
    output?: string;
    content?: string;
    done: boolean;
}

export interface TurnFile {
    id: string;
    filename: string;
    content: string;
    type?: string;
}

export interface ChatBubbleProps {
    message: {
        id: string;
        content: string;
        sender: string;
        sender_name: string;
        timestamp: string;
        is_from_me: boolean;
        is_bot_message?: boolean;
        failed?: boolean;
    };
    onOpenArtifact?: (jobId: string, filename: string, content: string) => void;
    isThread?: boolean;
    activity?: ActivityStep[];
    /** Inline file artifacts written this turn (rendered under the answer). */
    turnFiles?: React.ReactNode;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const WEB_TOOLS        = new Set(['web_search', 'web_fetch', 'browser']);
export const FILE_TOOLS       = new Set(['read_file', 'write_file', 'create_file', 'append_file', 'edit_file', 'list_files', 'str_replace_editor', 'view']);
export const FILE_WRITE_TOOLS = new Set(['write_file', 'create_file', 'append_file', 'edit_file', 'str_replace_editor']);
export const SHELL_TOOLS      = new Set(['bash', 'shell', 'execute_code']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Renders message text with @mentions, #files, and /commands color-coded inline. */
function renderMentions(text: string, onDark = false): React.ReactNode[] {
    const regex = /(@[\w][\w\-]*|#[\w\-.]+\/[\w\-./]+|\/[\w\-]+)/g;
    const nodes: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index));
        const val = m[0];
        const color = onDark
            ? (val.startsWith('@') ? 'var(--cr-cream)' : val.startsWith('#') ? 'var(--cr-blue)' : 'var(--cr-purple)')
            : (val.startsWith('@') ? 'var(--cr-accent)' : val.startsWith('#') ? 'var(--cr-blue)' : 'var(--cr-purple)');
        nodes.push(
            <span key={m.index} style={{ color, fontWeight: 600 }}>{val}</span>
        );
        last = regex.lastIndex;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
}

function parseSenderName(senderName: string): { emoji: string; name: string } {
    const spaceIdx = senderName.indexOf(' ');
    if (spaceIdx > 0) {
        const possibleEmoji = senderName.slice(0, spaceIdx);
        // spread gives grapheme count — emoji are typically 1-2 code points
        if ([...possibleEmoji].length <= 2) {
            return { emoji: possibleEmoji, name: senderName.slice(spaceIdx + 1) };
        }
    }
    return { emoji: '🤖', name: senderName || 'Assistant' };
}

// ─── Code Block ───────────────────────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
    const [copied, setCopied] = useState(false);

    const copy = () => {
        navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
    };

    const langColors: Record<string, string> = {
        python: 'var(--cr-warn)', py: 'var(--cr-warn)',
        javascript: 'var(--cr-amber)', js: 'var(--cr-amber)',
        typescript: 'var(--cr-cyan)', ts: 'var(--cr-cyan)',
        bash: 'var(--cr-orange)', sh: 'var(--cr-orange)', shell: 'var(--cr-orange)',
        json: 'var(--cr-syntax-key)',
        html: 'var(--cr-error)',
        css: 'var(--cr-green)',
        sql: 'var(--cr-blue)',
        markdown: 'var(--cr-blue)', md: 'var(--cr-blue)',
    };
    const langColor = langColors[lang.toLowerCase()] ?? 'var(--cr-muted-br)';

    return (
        <div style={{
            margin: '12px 0',
            borderRadius: '10px',
            overflow: 'hidden',
            border: '1px solid var(--cr-border)',
            background: 'var(--cr-well-str)',
        }}>
            {/* Header row */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '7px 14px',
                background: 'var(--cr-tint-1)',
                borderBottom: '1px solid var(--cr-border)',
            }}>
                <span style={{
                    fontFamily: 'var(--cr-font-mono)', fontSize: '9px',
                    color: langColor, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700,
                }}>
                    {lang || 'text'}
                </span>
                <button
                    onClick={copy}
                    style={{
                        fontFamily: 'var(--cr-font-mono)', fontSize: '9px',
                        color: copied ? 'var(--cr-green)' : 'var(--cr-muted)',
                        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                        transition: 'color 0.15s', letterSpacing: '0.04em',
                    }}
                >
                    {copied ? '✓ copied' : 'copy'}
                </button>
            </div>
            {/* Code area */}
            <pre style={{
                margin: 0,
                padding: '14px 16px',
                overflowX: 'auto',
                fontSize: '12.5px',
                fontFamily: 'var(--cr-font-mono)',
                lineHeight: 1.65,
                color: 'var(--cr-sub)',
                whiteSpace: 'pre',
            }}>
                <code>{code}</code>
            </pre>
        </div>
    );
}

// ─── Prose Renderer ───────────────────────────────────────────────────────────

export const proseComponents: Components = {
    p({ children }) {
        return <p style={{ margin: '0 0 14px', lineHeight: 1.7, color: 'var(--cr-text)', fontSize: '13.5px', fontFamily: 'var(--cr-font-sans)' }}>{children}</p>;
    },
    strong({ children }) {
        return <strong style={{ color: 'var(--cr-cream)', fontWeight: 600 }}>{children}</strong>;
    },
    em({ children }) {
        return <em style={{ color: 'var(--cr-sub)', fontStyle: 'italic' }}>{children}</em>;
    },
    h1({ children }) {
        return <h1 style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '19px', fontWeight: 400, color: 'var(--cr-cream)', margin: '22px 0 10px', borderBottom: '1px solid var(--cr-border)', paddingBottom: '8px' }}>{children}</h1>;
    },
    h2({ children }) {
        return <h2 style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '16px', fontWeight: 400, color: 'var(--cr-cream)', margin: '18px 0 8px' }}>{children}</h2>;
    },
    h3({ children }) {
        return <h3 style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', fontWeight: 700, color: 'var(--cr-accent)', margin: '14px 0 6px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{children}</h3>;
    },
    ul({ children }) {
        return <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 14px' }}>{children}</ul>;
    },
    ol({ children }) {
        return <ol style={{ paddingLeft: '20px', margin: '6px 0 14px', color: 'var(--cr-text)', fontSize: '13.5px', lineHeight: 1.7 }}>{children}</ol>;
    },
    li({ children }) {
        return (
            <li style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '6px', fontSize: '13.5px', color: 'var(--cr-text)', lineHeight: 1.65 }}>
                <span style={{ color: 'var(--cr-accent)', marginTop: '3px', flexShrink: 0, fontSize: '10px' }}>▸</span>
                <span style={{ flex: 1 }}>{children}</span>
            </li>
        );
    },
    table({ children }) {
        return (
            <div style={{ overflowX: 'auto', margin: '12px 0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', fontFamily: 'var(--cr-font-sans)' }}>
                    {children}
                </table>
            </div>
        );
    },
    thead({ children }) {
        return <thead style={{ background: 'var(--cr-well)', borderBottom: '1px solid var(--cr-border)' }}>{children}</thead>;
    },
    th({ children }) {
        return <th style={{ padding: '7px 12px', textAlign: 'left', fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-sub)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</th>;
    },
    td({ children }) {
        return <td style={{ padding: '7px 12px', color: 'var(--cr-text)', borderBottom: '1px solid var(--cr-tint-3)', verticalAlign: 'top' }}>{children}</td>;
    },
    blockquote({ children }) {
        return (
            <blockquote style={{
                borderLeft: '3px solid var(--cr-accent)',
                margin: '12px 0', padding: '8px 14px',
                background: 'var(--cr-accent-15)',
                borderRadius: '0 6px 6px 0',
                color: 'var(--cr-sub)', fontStyle: 'italic',
            }}>
                {children}
            </blockquote>
        );
    },
    hr() {
        return <hr style={{ border: 'none', borderTop: '1px solid var(--cr-border)', margin: '16px 0' }} />;
    },
    // Block code — className will be "language-xxx"
    pre({ children }) {
        // Let the code component handle the full block rendering
        return <>{children}</>;
    },
    code({ children, className }) {
        const lang = (className ?? '').replace('language-', '').trim();
        const code = String(children).trimEnd();
        if (lang || className) {
            return <CodeBlock lang={lang || 'text'} code={code} />;
        }
        // Inline code
        return (
            <code style={{
                background: 'var(--cr-tint-4)',
                border: '1px solid var(--cr-border)',
                color: 'var(--cr-accent-warm)',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '12px',
                fontFamily: 'var(--cr-font-mono)',
            }}>{children}</code>
        );
    },
};

/** A path-like inline code (has a slash + an extension on the last segment). */
export const looksLikeFilePath = (s: string) => /\/[\w.\-]+\.[A-Za-z0-9]{1,8}$/.test(s.trim());

/**
 * Rich markdown components, shared by both chats. When `onOpenFile` is supplied,
 * path-like inline code renders as a clickable chip that opens the file
 * (Claude-Code style). Without it, falls back to plain styled inline code.
 */
export function createProseComponents(onOpenFile?: (path: string) => void): Components {
    if (!onOpenFile) return proseComponents;
    return {
        ...proseComponents,
        code({ children, className }) {
            const lang = (className ?? '').replace('language-', '').trim();
            const raw = String(children);
            const text = raw.replace(/\n$/, '');
            const isBlock = /language-/.test(className || '') || text.includes('\n');
            if (isBlock) return <CodeBlock lang={lang || 'text'} code={raw.trimEnd()} />;
            if (looksLikeFilePath(text)) {
                return (
                    <code role="button" title={`Open ${text}`} onClick={() => onOpenFile(text)}
                        style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '12px', color: 'var(--cr-accent-warm)', background: 'var(--cr-well-str)', border: '1px solid var(--cr-border)', padding: '1px 6px', borderRadius: '4px', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px', wordBreak: 'break-all' }}
                    >{text}</code>
                );
            }
            return (
                <code style={{ background: 'var(--cr-tint-4)', border: '1px solid var(--cr-border)', color: 'var(--cr-accent-warm)', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontFamily: 'var(--cr-font-mono)' }}>{children}</code>
            );
        },
    };
}

// ─── Activity Pills ───────────────────────────────────────────────────────────

export function PillStrip({ steps }: { steps: ActivityStep[] }) {
    const web   = steps.filter(s => WEB_TOOLS.has(s.tool)).length;
    const shell = steps.filter(s => SHELL_TOOLS.has(s.tool)).length;
    // Count unique file paths, not write operations
    const writeSteps = steps.filter(s => FILE_WRITE_TOOLS.has(s.tool));
    const uniquePaths = new Set(writeSteps.map(s => {
        try { const p = JSON.parse(s.input); return typeof p.path === 'string' ? p.path : s.id; }
        catch { return s.id; }
    }));
    const files = uniquePaths.size || writeSteps.length;

    const pills = [
        { id: 'web',   count: web,   icon: <Search size={11} />,   color: 'var(--cr-accent)' },
        { id: 'files', count: files, icon: <FileText size={11} />, color: 'var(--cr-green)' },
        { id: 'shell', count: shell, icon: <Terminal size={11} />, color: 'var(--cr-accent-warm)' },
    ].filter(p => p.count > 0);

    if (pills.length === 0) return null;

    return (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
            {pills.map(({ id, count, icon, color }) => (
                <button key={id}
                    onClick={() => window.dispatchEvent(new CustomEvent('open-dock-panel', { detail: id }))}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 11px', borderRadius: '100px', cursor: 'pointer', background: 'var(--cr-tint-1)', border: '1px solid var(--cr-border)', fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', transition: 'all 0.2s' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.color = 'var(--cr-cream)'; e.currentTarget.style.background = 'var(--cr-tint-3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--cr-border)'; e.currentTarget.style.color = 'var(--cr-muted)'; e.currentTarget.style.background = 'var(--cr-tint-1)'; }}
                >
                    <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
                    <span style={{ fontWeight: 600, letterSpacing: '0.05em' }}>{count}</span>
                </button>
            ))}
        </div>
    );
}

// ─── Artifact Detection ───────────────────────────────────────────────────────

export interface ExtractedArtifact {
    title: string;
    html: string;
    sizeBytes: number;
    /** The file the agent wrote it to, when it came from a write step — what lets the
     *  page open full-size and remember what the viewer does on it. */
    path?: string;
}

/** Extract an HTML artifact from the trace's file-write steps (normalized name/args shape). */
function artifactFromSteps(steps: TimelineStep[]): ExtractedArtifact | null {
    // Scan in reverse so we get the LATEST full-page write. edit_file / append_file steps
    // don't carry the full content (they use old_text/new_text or partial chunks), so we
    // skip any step where the content field isn't a complete <!DOCTYPE html> document.
    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (!FILE_WRITE_TOOLS.has(s.name) || !s.args) continue;
        let parsed: { path?: string; content?: string } = {};
        try { parsed = JSON.parse(s.args); } catch { continue; }
        if (typeof parsed.path !== 'string' || !parsed.path.endsWith('.html')) continue;
        const content = parsed.content;
        if (!content || !/<!doctype\s+html/i.test(content)) continue;
        // Reject Vite/React scaffold entry points — they reference source files that
        // don't exist in a standalone context (e.g. <script type="module" src="/src/main.tsx">)
        if (/<script[^>]+type=["']module["'][^>]+src=["'][^"']*\/(src|main)\//i.test(content)) continue;
        if (/<script[^>]+src=["'][^"']*\.(tsx?|jsx)["']/i.test(content)) continue;
        const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : parsed.path.split('/').pop() || 'HTML File';
        return { title, html: content, sizeBytes: new Blob([content]).size, path: parsed.path };
    }
    return null;
}

/** Detect an HTML artifact for a turn — from the message text, else the trace's file writes.
 *  Shared by both chats so the artifact card renders identically. */
export function detectTurnArtifact(content: string, steps: TimelineStep[]): ExtractedArtifact | null {
    const { artifact } = extractArtifact(content);
    return artifact ?? artifactFromSteps(steps);
}

export function extractArtifact(content: string): { text: string; artifact: ExtractedArtifact | null } {
    const doctypeIdx = content.search(/<!doctype\s+html/i);
    if (doctypeIdx === -1) return { text: content, artifact: null };

    // Text before <!DOCTYPE — strip trailing fenced block opener
    let textBefore = content.slice(0, doctypeIdx).replace(/```[\w]*\s*$/i, '').trimEnd();

    let rest = content.slice(doctypeIdx);

    // Cut at </html> — anything after goes back to text
    const htmlCloseMatch = rest.match(/<\/html\s*>/i);
    let html: string;
    let textAfter = '';
    if (htmlCloseMatch && htmlCloseMatch.index !== undefined) {
        const endIdx = htmlCloseMatch.index + htmlCloseMatch[0].length;
        html = rest.slice(0, endIdx);
        // Strip trailing fenced block closer and whitespace
        textAfter = rest.slice(endIdx).replace(/^\s*```\s*/, '').trim();
    } else {
        // No </html> found — strip fenced block closer if present
        html = rest.replace(/\n```\s*$/, '').trimEnd();
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'HTML Preview';
    const text = textBefore + (textAfter ? '\n\n' + textAfter : '');

    return {
        text,
        artifact: { title, html, sizeBytes: new Blob([html]).size },
    };
}

// ─── Artifact Card (inline bubble card) ──────────────────────────────────────

export function ArtifactCard({ artifact, onOpen, agentId }: { artifact: ExtractedArtifact; onOpen?: () => void; agentId?: string }) {
    const kb = (artifact.sizeBytes / 1024).toFixed(1);
    const navigate = useNavigate();
    const [overlay, setOverlay] = useState(false);
    // Never a new window. This used window.open — first about:blank + document.write, then
    // a blob: URL — and the desktop app hands every new-window request to Windows
    // (desktop/main.js setWindowOpenHandler → shell.openExternal), which has no app for
    // either scheme. A page with a known file opens full-size in-app, with storage; HTML
    // that only exists inline in a reply opens in an in-app overlay.
    const open = onOpen ?? (() => {
        if (agentId && artifact.path) navigate(artifactViewPath(agentId, artifact.path));
        else setOverlay(true);
    });
    return (
        <>
        {overlay && (
            <div
                onClick={() => setOverlay(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--cr-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            >
                <div
                    onClick={e => e.stopPropagation()}
                    style={{ width: '100%', maxWidth: 960, height: '85vh', display: 'flex', flexDirection: 'column', background: 'var(--cr-bg-elevated)', border: '1px solid var(--cr-border)', borderRadius: 12, overflow: 'hidden' }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--cr-border)' }}>
                        <div style={{ flex: 1, fontFamily: 'var(--cr-font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--cr-cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</div>
                        <button onClick={() => setOverlay(false)} style={{ background: 'none', border: 'none', color: 'var(--cr-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
                    </div>
                    <ArtifactFrame html={artifact.html} title={artifact.title} />
                </div>
            </div>
        )}
        <div style={{
            marginTop: '12px',
            border: '1px solid var(--cr-border)',
            borderRadius: '10px',
            overflow: 'hidden',
            background: 'var(--cr-well)',
        }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '12px 14px',
            }}>
                {/* Icon */}
                <div style={{
                    width: '36px', height: '36px', borderRadius: '9px', flexShrink: 0,
                    background: 'var(--cr-accent-25)', border: '1px solid var(--cr-accent-40)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <Globe size={16} color="var(--cr-accent)" />
                </div>
                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                        fontFamily: 'var(--cr-font-sans)', fontSize: '13px',
                        color: 'var(--cr-cream)', fontWeight: 500,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {artifact.title}
                    </div>
                    <div style={{
                        fontFamily: 'var(--cr-font-mono)', fontSize: '9px',
                        color: 'var(--cr-muted)', marginTop: '2px', letterSpacing: '0.04em',
                    }}>
                        HTML · {kb} KB · auto-detected
                    </div>
                </div>
                {/* Open button */}
                <button
                    onClick={open}
                    style={{
                        padding: '7px 14px', borderRadius: '8px', cursor: 'pointer',
                        background: 'linear-gradient(135deg, var(--cr-accent), var(--cr-accent-warm))',
                        border: 'none', color: 'var(--cr-on-accent)',
                        fontFamily: 'var(--cr-font-sans)', fontSize: '12px', fontWeight: 600,
                        flexShrink: 0, boxShadow: '0 2px 8px var(--cr-accent-40)',
                        transition: 'opacity 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                    Open →
                </button>
            </div>
        </div>
        </>
    );
}

// ─── User Message ─────────────────────────────────────────────────────────────

/** Badge marking a message that arrived over WhatsApp rather than the dashboard. */
export function WaSourceBadge() {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontFamily: CR.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4,
            color: 'var(--cr-brand-whatsapp)', background: 'rgba(37,211,102,0.10)',
            border: '1px solid rgba(37,211,102,0.30)', borderRadius: 4, padding: '0 5px',
        }}>WA</span>
    );
}

export function UserMsg({ msg, onRetry }: { msg: ChatBubbleProps['message']; onRetry?: () => void }) {
    // Mirrors the agent-chat user bubble (AgentProfilePage): right-aligned gradient,
    // no avatar, 16/4/16/16 radius — so the main chat and agent chat read identically.
    return (
        <div style={{ display: 'flex', flexDirection: 'row-reverse', marginBottom: 20, alignItems: 'flex-start' }}>
            <div style={{ maxWidth: '76%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                <div style={{
                    padding: '12px 16px',
                    borderRadius: '16px 4px 16px 16px',
                    background: `linear-gradient(135deg, ${CR.accent}, ${CR.accentWarm})`,
                    boxShadow: `0 4px 16px ${CR.accent30}`,
                    color: 'var(--cr-on-accent)',
                    fontFamily: CR.sans,
                    fontSize: 13.5,
                    lineHeight: 1.7,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                }}>
                    {renderMentions(msg.content, true)}
                </div>
                {/* Timestamp / error */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 4 }}>
                    {msg.failed && (
                        <button onClick={onRetry} style={{ background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)', borderRadius: 4, color: 'var(--cr-error-str)', fontSize: 9, fontFamily: CR.mono, padding: '1px 6px', cursor: 'pointer' }}>
                            RETRY
                        </button>
                    )}
                    <div style={{ fontFamily: CR.mono, fontSize: 9, color: msg.failed ? 'var(--cr-error-str)' : CR.muted }}>
                        {msg.failed ? 'FAILED TO SEND' : format(new Date(msg.timestamp), 'h:mm a')}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Bot Turn ─────────────────────────────────────────────────────────────────

type Trace = { name: string; args: string; result?: string };

// Normalize the agent chat's ActivityStep[] into the {name,args,result} trace shape the
// agent chat (AgentProfilePage) renders — so both chats draw the same timeline.
function stepsToTrace(steps: ActivityStep[]): Trace[] {
    return steps.map(s => {
        const isThinking = s.type === 'thinking' || (!s.tool && !!s.content);
        return {
            name: isThinking ? 'thinking' : (s.tool || 'tool'),
            args: s.input ?? '',
            result: isThinking ? (s.content ?? s.output) : s.output,
        };
    });
}

export function BotTurn({ final, activity, isActive, liveActivity, agentColor, onOpenHtmlArtifact, turnFiles }: {
    final: ChatBubbleProps['message'];
    activity?: ActivityStep[];
    isActive?: boolean;
    liveActivity?: ActivityStep[];
    agentColor?: string;
    onOpenHtmlArtifact?: (title: string, html: string) => void;
    turnFiles?: React.ReactNode;
}) {
    const { emoji, name } = parseSenderName(final.sender_name || 'Assistant');
    const agColor = agentColor ?? CR.accent;
    const [copied, setCopied] = useState(false);
    const [hovered, setHovered] = useState(false);

    const rawSteps = (isActive ? liveActivity : activity) ?? [];
    const trace = stepsToTrace(rawSteps);
    // The trailing thinking step is the model's pre-answer reasoning that became the
    // final message — drop it from the timeline (only once the turn has settled).
    const trailingThinking = !isActive && trace.length > 0 && trace[trace.length - 1].name === 'thinking'
        ? trace[trace.length - 1] : null;
    const filteredTrace = trailingThinking ? trace.slice(0, -1) : trace;
    const isCycle = filteredTrace.length > 0;

    const { text: bubbleText, artifact: inlineArtifact } = extractArtifact(final.content);
    const htmlArtifact = inlineArtifact ?? artifactFromSteps(filteredTrace);
    const finalAnswerText = bubbleText || final.content || (trailingThinking?.result ?? '');

    const copyAnswer = () => {
        navigator.clipboard.writeText(finalAnswerText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
    };

    return (
        <div
            style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'flex-start' }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}>
            {/* Avatar */}
            <div style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                background: `${withAlpha(agColor, 8)}`, border: `1px solid ${withAlpha(agColor, 19)}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
                boxShadow: `0 0 12px ${withAlpha(agColor, 6)}`,
                ...(isActive && rawSteps.length === 0 ? { animation: 'crewPulse 2s infinite' } : {}),
            }}>{emoji}</div>

            <div style={{ maxWidth: isCycle ? '88%' : '76%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* Name */}
                <div style={{ fontFamily: CR.sans, fontSize: 11, fontWeight: 600, color: agColor, paddingLeft: 4 }}>{name}</div>

                {isCycle ? (
                    /* Inline working-timeline: thinking + tool steps + final answer thread */
                    <div style={{ width: '100%', paddingLeft: 4 }}>
                        <CycleTimeline
                            steps={filteredTrace}
                            agentColor={agColor}
                            isActive={isActive}
                            finalAnswerText={isActive ? undefined : finalAnswerText}
                            mdComponents={proseComponents}
                        />
                    </div>
                ) : isActive ? (
                    /* No steps yet, still streaming → typing dots */
                    <div style={{ display: 'flex', gap: 4, paddingLeft: 4, paddingTop: 6 }}>
                        {[0, 1, 2].map(n => (
                            <div key={n} style={{ width: 4, height: 4, borderRadius: '50%', background: CR.muted, animation: `crewPulse 1.2s ${n * 0.2}s infinite` }} />
                        ))}
                    </div>
                ) : (
                    /* Plain reply → chat bubble */
                    <div style={{ position: 'relative' }}>
                        <div style={{
                            padding: '12px 16px',
                            borderRadius: '4px 16px 16px 16px',
                            background: CR.bgCard,
                            border: `1px solid ${CR.border}`,
                            boxShadow: '0 2px 8px var(--cr-shade-1)',
                            fontFamily: CR.sans, fontSize: 13.5, color: CR.text, lineHeight: 1.7,
                        }}>
                            <div className="agent-md">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={proseComponents}>{finalAnswerText || final.content}</ReactMarkdown>
                            </div>
                        </div>
                        {hovered && finalAnswerText && (
                            <button
                                onClick={copyAnswer}
                                title="Copy"
                                style={{
                                    position: 'absolute', top: 6, right: -32,
                                    background: CR.bgSurf, border: `1px solid ${CR.border}`,
                                    borderRadius: 6, padding: '3px 6px', cursor: 'pointer',
                                    fontSize: 11, color: copied ? 'var(--cr-green)' : CR.muted, transition: 'color 0.2s',
                                }}
                            >{copied ? '✓' : '⎘'}</button>
                        )}
                    </div>
                )}

                {/* Web-source chips now render inside CycleTimeline (shared with agent chat). */}
                {/* HTML artifact card — detected from message content + trace. */}
                {htmlArtifact && (
                    <ArtifactCard artifact={htmlArtifact} onOpen={() => onOpenHtmlArtifact?.(htmlArtifact.title, htmlArtifact.html)} />
                )}

                {/* Inline file artifacts written this turn (shared with agent chat). */}
                {!isActive && turnFiles}

                {/* Timestamp */}
                {!isActive && (
                    <div style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted, paddingLeft: 4 }}>
                        {format(new Date(final.timestamp), 'h:mm a')}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── ChatBubble (dispatcher) ──────────────────────────────────────────────────

const ChatBubbleInner: React.FC<ChatBubbleProps> = ({ message, activity, turnFiles }) => {
    if (message.is_from_me) return <UserMsg msg={message} />;
    // Stage 57 removed background jobs. Their chat messages carried [job-pending:…] and
    // [job-id:…] markers that drove a live job card; the markers are stripped so old
    // messages read as plain text instead of showing raw tags.
    const content = message.content.replace(/\[job-(?:pending|id):[^\]]+\]/g, '').trim();
    const final = content === message.content ? message : { ...message, content };
    return <BotTurn final={final} activity={activity} turnFiles={turnFiles} />;
};

// Memoized so a parent re-render (e.g. every keystroke in the composer) does NOT
// re-parse Markdown for every bubble. Only bubbles whose props actually change re-render.
// Relies on stable props from the parent: a memoized message list and stable
// `activity`/`turnFiles` references.
export const ChatBubble = React.memo(ChatBubbleInner);

