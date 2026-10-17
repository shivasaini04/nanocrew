import { useMemo } from 'react';

interface CsvViewerProps {
    filename: string;
    csvText: string;
}

export default function CsvViewer({ filename, csvText }: CsvViewerProps) {
    const { headers, rows } = useMemo(() => {
        if (!csvText) return { headers: [], rows: [] };

        // Simple CSV parser handling quotes
        const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');

        const parseLine = (line: string) => {
            const result = [];
            let inQuotes = false;
            let currentStr = '';
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    result.push(currentStr);
                    currentStr = '';
                } else {
                    currentStr += char;
                }
            }
            result.push(currentStr);
            return result;
        };

        const headers = lines.length > 0 ? parseLine(lines[0]) : [];
        const rows = lines.slice(1).map(parseLine);

        return { headers, rows };
    }, [csvText]);

    if (headers.length === 0) {
        return (
            <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center', fontFamily: 'monospace' }}>
                Empty or invalid CSV file
            </div>
        );
    }

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)', fontSize: '13px', fontFamily: 'monospace', color: 'var(--accent-green)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                📊 Data Visualizer: {filename}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-base)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                    <thead style={{ position: 'sticky', top: 0, background: 'var(--cr-bg-elevated)', borderBottom: '1px solid var(--border-subtle)', zIndex: 10 }}>
                        <tr>
                            {headers.map((val, idx) => (
                                <th key={idx} style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                                    {val}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, rIdx) => (
                            <tr key={rIdx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                {headers.map((_, cIdx) => (
                                    <td key={cIdx} style={{ padding: '6px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                        {row[cIdx] !== undefined ? row[cIdx] : ''}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
