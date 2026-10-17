/** Renders a unified-diff string (--- a/, +++ b/, @@ hunks) with +/- line coloring. */
export function DiffViewer({ patch, onBack }: { patch: string; onBack?: () => void }) {
    const lines = patch.split('\n');
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {onBack && (
                <div style={{ padding: '6px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>diff</span>
                    <button onClick={onBack} style={{ fontSize: '11px', color: 'var(--accent-cyan)', cursor: 'pointer', background: 'none', border: 'none' }}>← Back to file</button>
                </div>
            )}
            <div style={{ flex: 1, overflow: 'auto', fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.6 }}>
                {lines.map((line, i) => {
                    const bg = line.startsWith('+') && !line.startsWith('+++')
                        ? 'var(--cr-green-low)' : line.startsWith('-') && !line.startsWith('---')
                        ? 'var(--cr-error-low)' : line.startsWith('@')
                        ? 'var(--cr-cyan-low)' : 'transparent';
                    const color = line.startsWith('+') && !line.startsWith('+++')
                        ? 'var(--accent-green)' : line.startsWith('-') && !line.startsWith('---')
                        ? 'var(--accent-red)' : line.startsWith('@')
                        ? 'var(--accent-cyan)' : 'var(--text-secondary)';
                    return (
                        <div key={i} style={{ background: bg, color, padding: '1px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {line || ' '}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** Count added/removed content lines in a unified diff, for a compact "+N -M" badge. */
export function diffLineCounts(patch: string): { added: number; removed: number } {
    let added = 0, removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
}
