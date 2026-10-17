import { useState, useRef } from 'react';

interface PythonRunnerProps {
    code: string;
    filename: string;
    workspaceFiles?: { filename: string; content: string }[];
}

type RunState = 'idle' | 'loading' | 'running' | 'done' | 'error';

// Singleton Pyodide instance shared across all PythonRunner mounts
let pyodideInstance: any = null;
let pyodideLoading: Promise<any> | null = null;

async function getPyodide(): Promise<any> {
    if (pyodideInstance) return pyodideInstance;
    if (pyodideLoading) return pyodideLoading;

    pyodideLoading = (async () => {
        // Dynamically inject Pyodide script tag if not already present
        if (!(window as any).loadPyodide) {
            await new Promise<void>((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load Pyodide script'));
                document.head.appendChild(script);
            });
        }
        const py = await (window as any).loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/',
        });
        pyodideInstance = py;
        return py;
    })();

    return pyodideLoading;
}

export default function PythonRunner({ code, filename: _filename, workspaceFiles = [] }: PythonRunnerProps) {
    const [state, setState] = useState<RunState>('idle');
    const [stdout, setStdout] = useState('');
    const [stderr, setStderr] = useState('');
    const [images, setImages] = useState<string[]>([]);
    const hasRun = useRef(false);

    const run = async () => {
        setState('loading');
        setStdout('');
        setStderr('');
        setImages([]);
        hasRun.current = true;

        let py: any;
        try {
            py = await getPyodide();
        } catch (e: any) {
            setState('error');
            setStderr(`Failed to load Python runtime:\n${e?.message ?? e}`);
            return;
        }

        setState('running');

        try {
            // Install matplotlib if needed (cached after first install)
            try {
                await py.loadPackage(['matplotlib', 'numpy']);
            } catch { /* non-critical — script may not need them */ }

            // Inject workspace files into the virtual filesystem
            for (const f of workspaceFiles) {
                try {
                    py.FS.writeFile(f.filename, f.content);
                } catch { /* skip if FS not ready */ }
            }

            // Setup: redirect stdout/stderr, configure matplotlib
            await py.runPythonAsync(`
import sys
from io import StringIO
_stdout_capture = StringIO()
_stderr_capture = StringIO()
sys.stdout = _stdout_capture
sys.stderr = _stderr_capture

_captured_figures = []

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    _orig_show = plt.show
    def _capture_show(*args, **kwargs):
        import base64, io
        buf = io.BytesIO()
        plt.savefig(buf, format='png', bbox_inches='tight', dpi=120)
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode()
        _captured_figures.append(b64)
        plt.close('all')
    plt.show = _capture_show
except ImportError:
    pass
`);

            // Run the user's code
            await py.runPythonAsync(code);

            // Capture plt.savefig if show wasn't called but figures exist
            await py.runPythonAsync(`
try:
    import matplotlib.pyplot as plt
    import base64, io
    for fig_num in plt.get_fignums():
        fig = plt.figure(fig_num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', bbox_inches='tight', dpi=120)
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode()
        _captured_figures.append(b64)
    plt.close('all')
except Exception:
    pass
`);

            const out: string = py.globals.get('_stdout_capture').getvalue();
            const err: string = py.globals.get('_stderr_capture').getvalue();
            const figs: string[] = py.globals.get('_captured_figures').toJs();

            setStdout(out);
            setStderr(err);
            setImages(figs);
            setState('done');
        } catch (e: any) {
            const errMsg = e?.message ?? String(e);
            setStderr(errMsg);
            // Also grab anything that was captured before the error
            try {
                const partialOut: string = py.globals.get('_stdout_capture')?.getvalue?.() ?? '';
                if (partialOut) setStdout(partialOut);
            } catch { /* ignore */ }
            setState('error');
        }
    };

    const hasOutput = stdout || images.length > 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)' }}>
            {/* Run bar */}
            <div style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--bg-elevated)',
            }}>
                <button
                    onClick={run}
                    disabled={state === 'loading' || state === 'running'}
                    style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '6px 14px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
                        background: (state === 'loading' || state === 'running') ? 'var(--cr-green-low)' : 'var(--cr-green-low)',
                        border: '1px solid var(--cr-green-line)',
                        color: 'var(--cr-green)', cursor: (state === 'loading' || state === 'running') ? 'wait' : 'pointer',
                        transition: 'all 0.15s',
                    }}
                >
                    {state === 'loading' ? (
                        <><Spinner /> Loading runtime…</>
                    ) : state === 'running' ? (
                        <><Spinner /> Running…</>
                    ) : (
                        <>▶ Run</>
                    )}
                </button>
                {workspaceFiles.length > 0 && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {workspaceFiles.length} workspace file{workspaceFiles.length !== 1 ? 's' : ''} available
                    </span>
                )}
                {state === 'done' && !hasOutput && !stderr && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        No output
                    </span>
                )}
                {(state === 'done' || state === 'error') && (
                    <button
                        onClick={() => { setState('idle'); setStdout(''); setStderr(''); setImages([]); }}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer' }}
                    >
                        Clear
                    </button>
                )}
            </div>

            {/* Output area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {state === 'idle' && !hasRun.current && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', paddingTop: '40px' }}>
                        Click <strong style={{ color: 'var(--cr-green)' }}>▶ Run</strong> to execute this script
                        {workspaceFiles.length > 0 && (
                            <div style={{ marginTop: '8px', fontSize: '11px' }}>
                                Workspace files will be available: {workspaceFiles.map(f => f.filename).join(', ')}
                            </div>
                        )}
                        <div style={{ marginTop: '12px', fontSize: '10px', color: 'var(--cr-muted)' }}>
                            First run downloads the Python runtime (~10 MB, cached after that)
                        </div>
                    </div>
                )}

                {/* Images (matplotlib charts) */}
                {images.map((b64, i) => (
                    // matplotlib renders black-on-transparent, so the backing must stay
                    // white in both themes or the chart vanishes into a dark page.
                    <div key={i} style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-subtle)', background: '#fff' }}>
                        <img
                            src={`data:image/png;base64,${b64}`}
                            alt={`Figure ${i + 1}`}
                            style={{ width: '100%', display: 'block' }}
                        />
                    </div>
                ))}

                {/* stdout */}
                {stdout && (
                    <div>
                        {images.length > 0 && (
                            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: '6px' }}>STDOUT</div>
                        )}
                        <pre style={{
                            margin: 0, padding: '12px 14px', borderRadius: '8px',
                            fontSize: '12px', lineHeight: 1.7, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            background: 'var(--cr-well-str)', border: '1px solid var(--cr-tint-4)',
                            color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        }}>
                            {stdout}
                        </pre>
                    </div>
                )}

                {/* stderr */}
                {stderr && (
                    <div>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--cr-error)', letterSpacing: '0.06em', marginBottom: '6px' }}>
                            {state === 'error' ? 'ERROR' : 'STDERR'}
                        </div>
                        <pre style={{
                            margin: 0, padding: '12px 14px', borderRadius: '8px',
                            fontSize: '12px', lineHeight: 1.7, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)',
                            color: 'var(--cr-error)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        }}>
                            {stderr}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}

function Spinner() {
    return (
        <span style={{
            display: 'inline-block', width: '10px', height: '10px',
            border: '2px solid var(--cr-green-line)', borderTopColor: 'var(--cr-green)',
            borderRadius: '50%', animation: 'spin 0.7s linear infinite',
        }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </span>
    );
}
