/**
 * ArtifactViewPage — an agent's HTML file as a full page, inside the app.
 *
 * Route: /artifact?agent=<agentId>&path=<file, relative to the agent's workspace>
 *
 * This is where every "Open" for an HTML artifact goes. It replaces opening a new window,
 * which the desktop app hands to Windows (desktop/main.js setWindowOpenHandler →
 * shell.openExternal) — so an about:blank or blob: URL arrived at the OS with no app to
 * open it. A same-origin route never leaves the app, and reloading it keeps what the page
 * saved, because storage is keyed to the file (see ArtifactFrame).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { CR } from '../lib/cr';
import ArtifactFrame, { toWorkspaceRelative } from '../components/ArtifactFrame';

export default function ArtifactViewPage() {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const agentId = params.get('agent') ?? '';
    const filePath = toWorkspaceRelative(params.get('path') ?? '');

    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!agentId || !filePath) { setError('This link is missing the agent or the file.'); return; }
        setHtml(null); setError(null);
        fetch(`/api/files/content?context=agent&contextId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(filePath)}`)
            .then(r => (r.ok ? r.text() : Promise.reject(r.status)))
            .then(setHtml)
            .catch(status => setError(status === 404
                ? 'This page no longer exists in the agent\'s workspace.'
                : 'This page could not be loaded.'));
    }, [agentId, filePath]);

    const title = html?.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || filePath.split('/').pop() || 'Page';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: CR.bgMain }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
                borderBottom: `1px solid ${CR.border}`, flexShrink: 0,
            }}>
                <button
                    onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(`/agents/${agentId}`))}
                    title="Back"
                    style={{ background: 'none', border: 'none', color: CR.muted, cursor: 'pointer', display: 'flex', padding: 4 }}
                >
                    <ArrowLeft size={16} />
                </button>
                <div style={{ fontFamily: CR.sans, fontSize: 13, fontWeight: 600, color: CR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {error ? 'Page unavailable' : title}
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {filePath}
                </div>
            </div>
            {error ? (
                <div style={{ padding: 40, textAlign: 'center', color: CR.muted, fontFamily: CR.sans, fontSize: 13 }}>{error}</div>
            ) : html === null ? (
                <div style={{ padding: 40, textAlign: 'center', color: CR.muted, fontFamily: CR.sans, fontSize: 13 }}>Loading…</div>
            ) : (
                <ArtifactFrame html={html} agentId={agentId} filePath={filePath} title={title} />
            )}
        </div>
    );
}
