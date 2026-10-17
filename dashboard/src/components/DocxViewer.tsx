import { useEffect, useState } from 'react';

/**
 * A rendered Word document, not a download link.
 *
 * Mammoth converts the docx's own XML into clean HTML — headings, bold/italic, lists,
 * tables — reconstructed from the document's structure. It is not a full layout engine:
 * a resume with hand-placed columns and a colored header band (the kind Claude's own
 * artifact viewer renders) will come out closer to a plain formatted document than a
 * pixel match. Loaded lazily, same reasoning as XlsxViewer beside it — nobody previewing
 * a .md file should pay for a docx-to-HTML converter.
 *
 * The HTML injected below is mammoth's OWN OUTPUT — structural markup it generates from
 * the document, not the docx's raw content re-serialized — which is the library's
 * intended, documented usage. It is still content that arrived from a file, so this
 * component does not add script execution capability beyond what any other rendered-
 * HTML view here already has.
 */

interface DocxViewerProps {
    filename: string;
    /** Where to fetch the file's own bytes from — a .docx is a ZIP container, never
     * decoded as text. Same shape as how an image file already hands this component's
     * siblings a URL rather than pre-fetched content. */
    url: string;
}

export default function DocxViewer({ filename, url }: DocxViewerProps) {
    const [html, setHtml] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setHtml(null);
        setError(null);
        setWarnings([]);

        Promise.all([
            fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
            import('mammoth'),
        ]).then(([arrayBuffer, mammoth]) => mammoth.convertToHtml({ arrayBuffer }))
            .then(result => {
                if (cancelled) return;
                setHtml(result.value);
                setWarnings(result.messages.filter(m => m.type === 'warning').map(m => m.message));
            }).catch(err => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read this file.');
            });

        return () => { cancelled = true; };
    }, [url]);

    if (error) {
        return (
            <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                {error}
            </div>
        );
    }

    if (html === null) {
        return (
            <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                Reading document…
            </div>
        );
    }

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)', fontSize: '13px', fontFamily: 'monospace', color: 'var(--accent-green)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                📄 {filename}
            </div>
            <div
                style={{
                    flex: 1, overflow: 'auto', padding: '32px 40px', background: '#fff', color: '#1a1a1a',
                    lineHeight: 1.6, fontFamily: 'Georgia, serif',
                }}
                className="docx-preview"
                dangerouslySetInnerHTML={{ __html: html }}
            />
            {warnings.length > 0 && (
                <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border-subtle)', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>
                    {warnings.length} formatting note{warnings.length === 1 ? '' : 's'} — some styling may not match the original exactly.
                </div>
            )}
        </div>
    );
}
