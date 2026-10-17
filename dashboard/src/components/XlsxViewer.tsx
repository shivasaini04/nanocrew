import { useEffect, useMemo, useState } from 'react';

/**
 * A real spreadsheet, not a download link.
 *
 * Same shape as CsvViewer beside it — parse, then a plain <table> — but the input is
 * binary (a ZIP container, not text) and the parser is SheetJS, loaded lazily so nobody
 * previewing a .md file pays for it. Read-only: this is "see the data", not "Excel in a
 * browser" — no formulas, no formatting fidelity, no editing.
 *
 * The npm-registry `xlsx` package stalled on two HIGH-severity advisories (prototype
 * pollution, ReDoS) that SheetJS fixed only in builds they publish from their own CDN,
 * not npm — package.json points at cdn.sheetjs.com for that reason. This parses files an
 * agent (or anyone with file access) produced; a stale, exploitable parser reading
 * untrusted bytes is exactly the situation those advisories are about.
 */

interface XlsxViewerProps {
    filename: string;
    /** Where to fetch the file's own bytes from — never decoded as text server-side or
     * here; a spreadsheet is a ZIP container. Same shape as how an image file already
     * hands this component's siblings a URL rather than pre-fetched content. */
    url: string;
}

interface SheetData {
    name: string;
    rows: unknown[][];
}

export default function XlsxViewer({ filename, url }: XlsxViewerProps) {
    const [sheets, setSheets] = useState<SheetData[] | null>(null);
    const [activeSheet, setActiveSheet] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setSheets(null);
        setError(null);
        setActiveSheet(0);

        Promise.all([
            fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
            import('xlsx'),
        ]).then(([data, XLSX]) => {
            if (cancelled) return;
            const workbook = XLSX.read(data, { type: 'array' });
            const parsed = workbook.SheetNames.map(name => ({
                name,
                rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], {
                    header: 1,
                    blankrows: false,
                }) as unknown[][],
            }));
            setSheets(parsed);
        }).catch(err => {
            if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read this file.');
        });

        return () => { cancelled = true; };
    }, [url]);

    const sheet = sheets?.[activeSheet];
    const { headers, rows } = useMemo(() => {
        if (!sheet || sheet.rows.length === 0) return { headers: [] as unknown[], rows: [] as unknown[][] };
        const [first, ...rest] = sheet.rows;
        return { headers: first, rows: rest };
    }, [sheet]);

    if (error) {
        return (
            <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                {error}
            </div>
        );
    }

    if (!sheets) {
        return (
            <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                Reading spreadsheet…
            </div>
        );
    }

    if (headers.length === 0) {
        return (
            <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                {sheet?.name ? `"${sheet.name}" is empty.` : 'This spreadsheet has no rows.'}
            </div>
        );
    }

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)', fontSize: '13px', fontFamily: 'monospace', color: 'var(--accent-green)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                📊 {filename}
            </div>
            {sheets.length > 1 && (
                <div style={{ display: 'flex', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--border-subtle)', overflowX: 'auto', flexShrink: 0 }}>
                    {sheets.map((s, i) => (
                        <button
                            key={s.name}
                            onClick={() => setActiveSheet(i)}
                            style={{
                                padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap',
                                background: i === activeSheet ? 'var(--cr-accent-15)' : 'transparent',
                                color: i === activeSheet ? 'var(--cr-accent)' : 'var(--text-muted)',
                            }}
                        >{s.name}</button>
                    ))}
                </div>
            )}
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-base)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                    <thead style={{ position: 'sticky', top: 0, background: 'var(--cr-bg-elevated)', borderBottom: '1px solid var(--border-subtle)', zIndex: 10 }}>
                        <tr>
                            {headers.map((val, idx) => (
                                <th key={idx} style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                                    {val === undefined || val === null ? '' : String(val)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, rIdx) => (
                            <tr key={rIdx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                {headers.map((_, cIdx) => {
                                    const cell = row[cIdx];
                                    return (
                                        <td key={cIdx} style={{ padding: '6px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                            {cell === undefined || cell === null ? '' : String(cell)}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
