/**
 * ArtifactFrame — an agent-written HTML page that remembers what its viewer does on it.
 *
 * Every place the dashboard shows an agent's HTML file renders it through here: the
 * workspace drawer, the Files page, the Artifacts tab, and the full-page view. Given the
 * agent and the file, the page gets storage keyed to that FILE, so a box ticked in the
 * drawer is still ticked after a reload, and in every other place the same page opens.
 * Without them it renders exactly as before, with no storage.
 *
 * Two ways a page can save, both backed by the same store (api/routes/artifact-docs.ts):
 *  - `window.NanoCrewPage` — getDoc / setDoc / listDocs / deleteDoc, documented to agents
 *    in emit_artifact.
 *  - `localStorage` — what most generated pages reach for unprompted. Inside a sandbox
 *    with no origin the real one throws, and a page that touches it on load can crash
 *    before drawing anything. So it is replaced with one preloaded from the store.
 *
 * Security: sandbox="allow-scripts allow-forms allow-modals" with NO allow-same-origin —
 * the page has no cookie and cannot call the API itself. It asks this component over
 * postMessage, and this component (trusted, same session as the dashboard) makes the call.
 * A page can therefore reach only its own file's documents.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The same file is named `/workspace/group/workspace/x.html` by a write_file step,
 * `workspace/x.html` by the artifacts manifest and `x.html` by the files API. One key, or
 * the page remembers different things in different tabs. Mirrors normaliseArtifactPath.
 */
export function toWorkspaceRelative(p: string): string {
    let s = p.trim().replace(/\\/g, '/');
    if (s.startsWith('/workspace/group/')) s = s.slice('/workspace/group/'.length);
    s = s.replace(/^\/+/, '');
    if (s.startsWith('workspace/')) s = s.slice('workspace/'.length);
    return s.replace(/^(\.\/)+/, '');
}

/** The in-app full-page view of an agent's HTML file. Never a new window: the desktop app
 *  hands every new-window request to Windows (desktop/main.js setWindowOpenHandler). */
export function artifactViewPath(agentId: string, filePath: string): string {
    return `/artifact?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(toWorkspaceRelative(filePath))}`;
}

const LS_PREFIX = 'ls:';

function bridgeScript(initial: Record<string, unknown>): string {
    // `<` escaped so stored text containing "</script>" cannot close this tag early.
    const seed = JSON.stringify(initial).replace(/</g, '\\u003c');
    return `<script>(function () {
  if (window.NanoCrewPage) return;
  var saved = ${seed};
  var pending = {}, seq = 0;
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (ev.source !== window.parent || !m || m.source !== 'nanocrew-page-host' || !pending[m.id]) return;
    var p = pending[m.id]; delete pending[m.id];
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  function call(type, args) {
    return new Promise(function (resolve, reject) {
      var id = 'm' + (seq++);
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ source: 'nanocrew-page', id: id, type: type, args: args || {} }, '*');
    });
  }
  function quiet(p) { p.catch(function (e) { console.warn('NanoCrewPage:', e.message); }); }
  window.NanoCrewPage = Object.freeze({
    getDoc: function (id) { return call('getDoc', { docId: String(id) }); },
    setDoc: function (id, data) { return call('setDoc', { docId: String(id), data: data === undefined ? null : data }); },
    listDocs: function () {
      return call('listDocs').then(function (docs) {
        return docs.filter(function (d) { return d.id.indexOf('${LS_PREFIX}') !== 0; });
      });
    },
    deleteDoc: function (id) { return call('deleteDoc', { docId: String(id) }); }
  });
  var ls = {};
  Object.keys(saved).forEach(function (k) {
    if (k.indexOf('${LS_PREFIX}') === 0) ls[k.slice(${LS_PREFIX.length})] = String(saved[k]);
  });
  var storage = {
    getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null; },
    setItem: function (k, v) { k = String(k); v = String(v); ls[k] = v; quiet(call('setDoc', { docId: '${LS_PREFIX}' + k, data: v })); },
    removeItem: function (k) { k = String(k); delete ls[k]; quiet(call('deleteDoc', { docId: '${LS_PREFIX}' + k })); },
    clear: function () { Object.keys(ls).forEach(function (k) { storage.removeItem(k); }); },
    key: function (i) { return Object.keys(ls)[i] === undefined ? null : Object.keys(ls)[i]; }
  };
  Object.defineProperty(storage, 'length', { get: function () { return Object.keys(ls).length; } });
  try { Object.defineProperty(window, 'localStorage', { value: storage, configurable: true }); } catch (e) {}
})();</script>`;
}

/**
 * Splice the bridge in right after <head> (or <html>). Prepending it ahead of
 * <!DOCTYPE html> would push the page into quirks mode, and it must run before the
 * page's own scripts so both APIs exist when they look.
 */
export function injectBridge(html: string, initial: Record<string, unknown>): string {
    const script = bridgeScript(initial);
    for (const re of [/<head[^>]*>/i, /<html[^>]*>/i]) {
        const m = html.match(re);
        if (m && m.index !== undefined) {
            const at = m.index + m[0].length;
            return html.slice(0, at) + script + html.slice(at);
        }
    }
    return script + html;
}

interface Props {
    html: string;
    /** Both needed for storage; without them the page renders with none. */
    agentId?: string;
    filePath?: string;
    title?: string;
}

export default function ArtifactFrame({ html, agentId, filePath, title }: Props) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const key = agentId && filePath ? toWorkspaceRelative(filePath) : null;
    const base = agentId ? `/api/agents/${encodeURIComponent(agentId)}/artifact-docs` : '';
    const query = key ? `?path=${encodeURIComponent(key)}` : '';

    // Saved state is fetched BEFORE the page renders, so localStorage reads on load see it.
    const [initial, setInitial] = useState<Record<string, unknown> | null>(key ? null : {});
    useEffect(() => {
        if (!key) { setInitial({}); return; }
        let cancelled = false;
        setInitial(null);
        fetch(base + query)
            .then(r => (r.ok ? r.json() : { docs: [] }))
            .then((d: { docs?: { id: string; data: unknown }[] }) => {
                if (cancelled) return;
                const map: Record<string, unknown> = {};
                for (const doc of d.docs ?? []) map[doc.id] = doc.data;
                setInitial(map);
            })
            // Unreachable storage must not cost the page: render it, unsaved.
            .catch(() => { if (!cancelled) setInitial({}); });
        return () => { cancelled = true; };
        // html too: a re-rendered page must be seeded with what was saved since it loaded.
    }, [key, base, query, html]);

    // Registered before the frame can load, so a call made on page load is never missed.
    useLayoutEffect(() => {
        if (!key) return;
        const onMessage = async (ev: MessageEvent) => {
            const msg = ev.data;
            const frame = frameRef.current?.contentWindow;
            if (!frame || ev.source !== frame || !msg || msg.source !== 'nanocrew-page') return;
            const reply = (result?: unknown, error?: string) =>
                frame.postMessage({ source: 'nanocrew-page-host', id: msg.id, result, error }, '*');
            const docUrl = (id: unknown) => `${base}/${encodeURIComponent(String(id ?? ''))}${query}`;
            try {
                if (msg.type === 'listDocs') {
                    const r = await fetch(base + query);
                    if (!r.ok) throw new Error(`could not load saved data (${r.status})`);
                    reply(((await r.json()).docs ?? []).map((d: { id: string; data: unknown }) => ({ id: d.id, data: d.data })));
                } else if (msg.type === 'getDoc') {
                    const r = await fetch(docUrl(msg.args?.docId));
                    if (!r.ok) throw new Error(`could not load saved data (${r.status})`);
                    reply((await r.json()).data ?? null);
                } else if (msg.type === 'setDoc') {
                    const r = await fetch(docUrl(msg.args?.docId), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ data: msg.args?.data ?? null }),
                    });
                    if (!r.ok) throw new Error(`could not save (${r.status})`);
                    reply(true);
                } else if (msg.type === 'deleteDoc') {
                    const r = await fetch(docUrl(msg.args?.docId), { method: 'DELETE' });
                    if (!r.ok) throw new Error(`could not delete (${r.status})`);
                    reply(true);
                } else {
                    reply(undefined, `unknown call: ${String(msg.type)}`);
                }
            } catch (err) {
                reply(undefined, err instanceof Error ? err.message : String(err));
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [key, base, query]);

    if (initial === null) {
        return <div style={{ padding: 24, color: 'var(--cr-muted)', fontSize: 12 }}>Loading…</div>;
    }
    return (
        <iframe
            ref={frameRef}
            title={title ?? 'Page'}
            sandbox="allow-scripts allow-forms allow-modals"
            srcDoc={key ? injectBridge(html, initial) : html}
            // The agent's HTML assumes a browser's default white canvas; theming it would
            // change what they see.
            style={{ flex: 1, width: '100%', height: '100%', border: 'none', background: '#fff', display: 'block' }}
        />
    );
}
