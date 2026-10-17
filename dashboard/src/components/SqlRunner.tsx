/**
 * SqlRunner — executes SQL files in-browser via sql.js (SQLite compiled to WASM).
 * No server. Creates a fresh in-memory database on each run.
 *
 * CDN: https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.js
 * (~1.4 MB JS + ~900 KB WASM, both cached after first load)
 */

import { useState } from 'react';

interface SqlRunnerProps {
    code: string;
}

type RunState = 'idle' | 'loading' | 'running' | 'done' | 'error';

interface QueryResult {
    columns: string[];
    values: any[][];
}

interface RunOutput {
    results: QueryResult[];   // SELECT results
    rowsModified: number;     // rows affected by last DML
    statementCount: number;   // rough count of non-empty statements
}

// ── sql.js singleton ──────────────────────────────────────────────────────────

const SQL_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0';
let sqlJsPromise: Promise<any> | null = null;

function getSqlJs(): Promise<any> {
    if (sqlJsPromise) return sqlJsPromise;
    sqlJsPromise = new Promise((resolve, reject) => {
        const init = () => {
            (window as any).initSqlJs({
                locateFile: (f: string) => `${SQL_CDN}/${f}`,
            }).then(resolve).catch((e: any) => { sqlJsPromise = null; reject(e); });
        };
        if ((window as any).initSqlJs) { init(); return; }
        const script = document.createElement('script');
        script.src = `${SQL_CDN}/sql-wasm.js`;
        script.onload = init;
        script.onerror = () => { sqlJsPromise = null; reject(new Error('Failed to load sql.js')); };
        document.head.appendChild(script);
    });
    return sqlJsPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countStatements(sql: string): number {
    // Rough count: split on ; and count non-empty trimmed parts
    return sql.split(';').filter(s => s.trim().length > 0).length;
}

function Spinner() {
    return (
        <span style={{
            display: 'inline-block', width: '11px', height: '11px',
            border: '2px solid var(--cr-cyan-line)',
            borderTopColor: 'var(--cr-cyan-line)',
            borderRadius: '50%',
            animation: 'sqlr-spin 0.7s linear infinite',
            flexShrink: 0,
        }} />
    );
}

// ── Result table ──────────────────────────────────────────────────────────────

function ResultTable({ result, index }: { result: QueryResult; index: number }) {
    return (
        <div style={{ marginBottom: '20px' }}>
            <div style={{
                fontSize: '10px', fontWeight: 700, color: 'var(--cr-cyan-line)',
                letterSpacing: '0.06em', marginBottom: '6px',
                fontFamily: 'ui-monospace, monospace',
            }}>
                RESULT SET {index + 1} — {result.values.length} {result.values.length === 1 ? 'row' : 'rows'}
            </div>
            <div style={{ overflowX: 'auto', borderRadius: '6px', border: '1px solid var(--cr-tint-5)' }}>
                <table style={{
                    width: '100%', borderCollapse: 'collapse',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '11px',
                }}>
                    <thead>
                        <tr style={{ background: 'var(--cr-cyan-low)' }}>
                            {result.columns.map(col => (
                                <th key={col} style={{
                                    padding: '6px 12px', textAlign: 'left',
                                    color: 'var(--cr-cyan-line)', fontWeight: 700,
                                    borderBottom: '1px solid var(--cr-tint-5)',
                                    whiteSpace: 'nowrap',
                                }}>
                                    {col}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {result.values.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={result.columns.length}
                                    style={{ padding: '10px 12px', color: 'var(--cr-line-str)', textAlign: 'center', fontStyle: 'italic' }}
                                >
                                    (no rows)
                                </td>
                            </tr>
                        ) : result.values.map((row, ri) => (
                            <tr
                                key={ri}
                                style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--cr-tint-1)' }}
                            >
                                {row.map((cell, ci) => (
                                    <td key={ci} style={{
                                        padding: '5px 12px',
                                        color: cell === null ? 'var(--cr-line-str)' : 'var(--cr-text)',
                                        borderBottom: '1px solid var(--cr-tint-3)',
                                        fontStyle: cell === null ? 'italic' : 'normal',
                                        whiteSpace: 'nowrap', maxWidth: '320px',
                                        overflow: 'hidden', textOverflow: 'ellipsis',
                                    }}>
                                        {cell === null ? 'NULL' : String(cell)}
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

// ── Main component ────────────────────────────────────────────────────────────

export default function SqlRunner({ code }: SqlRunnerProps) {
    const [state, setState]   = useState<RunState>('idle');
    const [output, setOutput] = useState<RunOutput | null>(null);
    const [errMsg, setErrMsg] = useState('');

    const run = async () => {
        setOutput(null);
        setErrMsg('');
        setState('loading');

        try {
            const SQL = await getSqlJs();
            setState('running');

            const db = new SQL.Database();
            let results: QueryResult[] = [];
            let rowsModified = 0;

            try {
                results = db.exec(code) as QueryResult[];
                rowsModified = db.getRowsModified();
            } finally {
                db.close();
            }

            setOutput({
                results,
                rowsModified,
                statementCount: countStatements(code),
            });
            setState('done');
        } catch (e: any) {
            setErrMsg(e.message ?? String(e));
            setState('error');
        }
    };

    const isBusy = state === 'loading' || state === 'running';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {/* Toolbar */}
            <div style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--cr-well)',
            }}>
                <button
                    onClick={run}
                    disabled={isBusy}
                    style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '5px 14px', borderRadius: '6px',
                        background: isBusy ? 'var(--cr-cyan-low)' : 'var(--cr-cyan-low)',
                        border: '1px solid var(--cr-cyan-line)',
                        color: 'var(--cr-cyan)', fontSize: '11px', fontWeight: 700,
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit', letterSpacing: '0.04em',
                        transition: 'all 0.15s',
                    }}
                >
                    {isBusy ? <Spinner /> : <span>▶</span>}
                    {state === 'loading' ? 'Loading SQLite…' : isBusy ? 'Running…' : '▶ Run'}
                </button>

                {output && (
                    <button
                        onClick={() => { setOutput(null); setState('idle'); }}
                        style={{
                            padding: '4px 10px', borderRadius: '6px',
                            background: 'transparent', border: '1px solid var(--border-subtle)',
                            color: 'var(--text-muted)', fontSize: '10px',
                            cursor: 'pointer', fontFamily: 'inherit',
                        }}
                    >
                        Clear
                    </button>
                )}

                {state === 'done' && output && (
                    <span style={{ fontSize: '10px', color: 'var(--cr-cyan-line)', marginLeft: '2px' }}>
                        ✓ {output.statementCount} {output.statementCount === 1 ? 'statement' : 'statements'} executed
                        {output.rowsModified > 0 && ` · ${output.rowsModified} rows affected`}
                    </span>
                )}
            </div>

            {/* Output */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px', background: 'var(--cr-well)' }}>
                {state === 'idle' && !output && (
                    <div style={{ color: 'var(--cr-line-str)', fontSize: '11px', paddingTop: '4px' }}>
                        Click ▶ Run to execute against an in-memory SQLite database
                    </div>
                )}

                {errMsg && (
                    <div style={{
                        color: 'var(--cr-error)', fontSize: '12px', whiteSpace: 'pre-wrap',
                        background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)',
                        borderRadius: '6px', padding: '10px 14px',
                    }}>
                        <span style={{ fontWeight: 700, marginRight: '6px' }}>✗ Error:</span>{errMsg}
                    </div>
                )}

                {output && output.results.length === 0 && state === 'done' && (
                    <div style={{
                        fontSize: '12px', color: 'var(--cr-green-line)',
                        background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)',
                        borderRadius: '6px', padding: '10px 14px',
                    }}>
                        ✓ Executed successfully — no SELECT results
                        {output.rowsModified > 0 && ` (${output.rowsModified} rows modified)`}
                    </div>
                )}

                {output && output.results.map((r, i) => (
                    <ResultTable key={i} result={r} index={i} />
                ))}
            </div>

            <style>{`@keyframes sqlr-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}
