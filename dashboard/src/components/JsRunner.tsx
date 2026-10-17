/**
 * JsRunner — executes JS/TS files in a sandboxed iframe and captures console output.
 *
 * Security: sandbox="allow-scripts" only — no allow-same-origin, so the iframe
 * can never access the parent DOM, cookies, or credentials.
 *
 * TypeScript: transpiled in-browser via the TypeScript compiler loaded from CDN
 * (~3 MB, cached after first use). No server round-trip.
 *
 * User code is base64-encoded into the iframe srcdoc to avoid </script> injection
 * issues. Executed inside an async IIFE so top-level await works.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface JsRunnerProps {
    code: string;
    filename: string;
}

type RunState = 'idle' | 'loading-ts' | 'running' | 'done' | 'error';

interface OutputLine {
    id: number;
    type: 'log' | 'warn' | 'error';
    text: string;
}

// ── TypeScript compiler loader (singleton) ────────────────────────────────────

let tsLoaderPromise: Promise<void> | null = null;

function ensureTypeScript(): Promise<void> {
    if ((window as any).ts) return Promise.resolve();
    if (tsLoaderPromise) return tsLoaderPromise;
    tsLoaderPromise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/typescript@5.4.5/lib/typescript.js';
        script.onload = () => resolve();
        script.onerror = () => {
            tsLoaderPromise = null;
            reject(new Error('Failed to load TypeScript compiler'));
        };
        document.head.appendChild(script);
    });
    return tsLoaderPromise;
}

function transpileTs(tsCode: string): string {
    const ts = (window as any).ts;
    const result = ts.transpileModule(tsCode, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.None,
            strict: false,
            experimentalDecorators: true,
        },
        reportDiagnostics: true,
    });
    if (result.diagnostics?.length) {
        const first = result.diagnostics[0];
        const msg = typeof first.messageText === 'string'
            ? first.messageText
            : first.messageText.messageText;
        throw new Error('TypeScript error: ' + msg);
    }
    return result.outputText;
}

// ── iframe HTML builder ───────────────────────────────────────────────────────

function buildIframeHtml(jsCode: string): string {
    // Encode user code to base64 to sidestep all HTML injection/escaping issues.
    // atob/btoa only works with latin-1, so we encode Unicode via encodeURIComponent.
    const b64 = btoa(unescape(encodeURIComponent(jsCode)));

    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
(function(){
var _p=parent,_pm=function(t,d){_p.postMessage({type:t,data:d},'*');};
window.console={
  log:function(){_pm('log',[].slice.call(arguments).map(function(v){return typeof v==='object'?JSON.stringify(v,null,2):String(v);}).join(' '));},
  error:function(){_pm('error',[].slice.call(arguments).map(String).join(' '));},
  warn:function(){_pm('warn',[].slice.call(arguments).map(String).join(' '));},
  info:function(){_pm('log',[].slice.call(arguments).map(String).join(' '));},
  dir:function(v){_pm('log',JSON.stringify(v,null,2));},
  table:function(v){_pm('log',JSON.stringify(v,null,2));},
};
window.onerror=function(msg,src,line){_pm('error',msg+(line?' (line '+line+')':''));return true;};
window.addEventListener('unhandledrejection',function(e){
  var r=e.reason;
  _pm('error','Unhandled rejection: '+(r&&r.message?r.message:String(r)));
});
(async function(){
  try{
    var _raw=atob('${b64}');
    var _code=decodeURIComponent(escape(_raw));
    var AsyncFn=Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFn(_code)();
  }catch(e){
    _pm('error',e&&e.message?e.message:String(e));
  }
  _pm('done','');
})();
})();
<\/script></body></html>`;
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
    return (
        <span style={{
            display: 'inline-block', width: '11px', height: '11px',
            border: '2px solid var(--cr-green-line)',
            borderTopColor: 'var(--cr-green-line)',
            borderRadius: '50%',
            animation: 'jsr-spin 0.7s linear infinite',
            flexShrink: 0,
        }} />
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function JsRunner({ code, filename }: JsRunnerProps) {
    const [state, setState]     = useState<RunState>('idle');
    const [output, setOutput]   = useState<OutputLine[]>([]);
    const [errMsg, setErrMsg]   = useState('');
    const iframeRef  = useRef<HTMLIFrameElement>(null);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lineId     = useRef(0);
    const isTs = filename.split('.').pop()?.toLowerCase() === 'ts';

    const addLine = useCallback((type: OutputLine['type'], text: string) => {
        setOutput(prev => [...prev, { id: lineId.current++, type, text }]);
    }, []);

    // Listen for messages from the sandboxed iframe
    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
            const { type, data } = (e.data ?? {}) as { type: string; data: string };
            if (type === 'log' || type === 'warn' || type === 'error') {
                addLine(type as OutputLine['type'], data);
            } else if (type === 'done') {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                setState('done');
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [addLine]);

    const run = async () => {
        setOutput([]);
        setErrMsg('');
        lineId.current = 0;

        try {
            let jsCode = code;

            if (isTs) {
                setState('loading-ts');
                await ensureTypeScript();
                jsCode = transpileTs(code);
            }

            setState('running');

            if (iframeRef.current) {
                iframeRef.current.srcdoc = buildIframeHtml(jsCode);
            }

            // Kill-switch: if done message never arrives, stop after 15s
            timeoutRef.current = setTimeout(() => setState('done'), 15_000);
        } catch (e: any) {
            setErrMsg(e.message ?? String(e));
            setState('error');
        }
    };

    const isBusy = state === 'loading-ts' || state === 'running';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {/* Hidden execution iframe */}
            <iframe
                ref={iframeRef}
                sandbox="allow-scripts"
                style={{ display: 'none' }}
                title="JS Sandbox"
            />

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
                        background: isBusy ? 'var(--cr-green-low)' : 'var(--cr-green-low)',
                        border: '1px solid var(--cr-green-line)',
                        color: 'var(--cr-green)', fontSize: '11px', fontWeight: 700,
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit', letterSpacing: '0.04em',
                        transition: 'all 0.15s',
                    }}
                >
                    {isBusy ? <Spinner /> : <span>▶</span>}
                    {state === 'loading-ts' ? 'Loading TS compiler…' : isBusy ? 'Running…' : '▶ Run'}
                </button>

                {(state !== 'idle' || output.length > 0) && (
                    <button
                        onClick={() => { setOutput([]); setErrMsg(''); setState('idle'); }}
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

                {state === 'done' && (
                    <span style={{ fontSize: '10px', color: 'var(--cr-green-line)', marginLeft: '2px' }}>✓ Done</span>
                )}
            </div>

            {/* Output */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', background: 'var(--cr-well)' }}>
                {state === 'idle' && output.length === 0 && (
                    <div style={{ color: 'var(--cr-line-str)', fontSize: '11px', paddingTop: '4px' }}>
                        Click ▶ Run to execute
                    </div>
                )}

                {errMsg && (
                    <div style={{ color: 'var(--cr-error)', fontSize: '12px', whiteSpace: 'pre-wrap', marginBottom: '8px' }}>
                        {errMsg}
                    </div>
                )}

                {output.map(line => (
                    <div key={line.id} style={{
                        fontSize: '12px', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        marginBottom: '1px',
                        color: line.type === 'error' ? 'var(--cr-error)'
                             : line.type === 'warn'  ? 'var(--cr-warn)'
                             : 'var(--cr-cream)',
                    }}>
                        {line.type === 'error' && <span style={{ opacity: 0.55, marginRight: '5px' }}>✗</span>}
                        {line.type === 'warn'  && <span style={{ opacity: 0.55, marginRight: '5px' }}>⚠</span>}
                        {line.text}
                    </div>
                ))}
            </div>

            <style>{`@keyframes jsr-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}
