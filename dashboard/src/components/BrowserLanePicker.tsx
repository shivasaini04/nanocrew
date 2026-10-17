import { useEffect, useState } from 'react';
import { Cloud, Monitor, ChevronDown, Check } from 'lucide-react';

import { CR, withAlpha } from '../lib/cr';

/**
 * Which browser the agent uses for this message (stage 60 phase 1).
 *
 * The operator decides, the way ChatGPT and Claude let you pick a tool under the message
 * box. Before this, using your own browser needed three things to line up — the desktop
 * app attached, a checkbox on the agent's profile, and the model choosing `identity: "me"`
 * — and nothing in the chat said which one was missing.
 *
 *   cloud  a clean browser on NanoCrew's server, not signed in as you
 *   local  the desktop app's browser on this computer, signed in as you
 *
 * The choice is remembered per chat, and sent with every message as `browser`.
 */
export type BrowserLane = 'cloud' | 'local';

const STORAGE_PREFIX = 'nc.browserLane.';

export function useBrowserLane(chatKey: string | undefined): [BrowserLane, (l: BrowserLane) => void] {
    const read = (): BrowserLane => {
        try {
            return localStorage.getItem(STORAGE_PREFIX + chatKey) === 'local' ? 'local' : 'cloud';
        } catch {
            return 'cloud';
        }
    };
    const [lane, setLane] = useState<BrowserLane>(read);
    // A different chat has its own remembered choice.
    useEffect(() => { setLane(read()); }, [chatKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const choose = (l: BrowserLane) => {
        setLane(l);
        try { localStorage.setItem(STORAGE_PREFIX + chatKey, l); } catch { /* not remembered, still applied */ }
    };
    return [lane, choose];
}

/** Is a browser attached for this user right now? null while unknown. */
function useLocalBrowserConnected(): boolean | null {
    const [connected, setConnected] = useState<boolean | null>(null);
    useEffect(() => {
        let alive = true;
        const check = async () => {
            try {
                const res = await fetch('/api/browser-control/status', { credentials: 'include' });
                if (!res.ok) throw new Error(String(res.status));
                const body = await res.json() as { controllers?: unknown[] };
                if (alive) setConnected(Array.isArray(body.controllers) && body.controllers.length > 0);
            } catch {
                if (alive) setConnected(null);
            }
        };
        void check();
        const t = setInterval(check, 10_000);
        return () => { alive = false; clearInterval(t); };
    }, []);
    return connected;
}

const OPTIONS: Array<{ lane: BrowserLane; label: string; detail: string }> = [
    { lane: 'cloud', label: 'Cloud', detail: "Works on NanoCrew's server only. Nothing on your computer is touched." },
    { lane: 'local', label: 'This computer', detail: 'Your signed-in browser, plus folders, terminal and apps — it asks you first.' },
];

export function BrowserLanePicker({ lane, onChange, disabled, accent }: {
    lane: BrowserLane;
    onChange: (l: BrowserLane) => void;
    disabled?: boolean;
    accent?: string;
}) {
    const [open, setOpen] = useState(false);
    const connected = useLocalBrowserConnected();
    const color = accent ?? CR.accent;

    // The one state worth warning about: you picked your own browser and it is not there.
    const warn = lane === 'local' && connected === false;
    const Icon = lane === 'local' ? Monitor : Cloud;

    return (
        <div style={{ position: 'relative', flexShrink: 0 }}>
            {open && (
                <>
                    <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
                    <div role="listbox" style={{
                        position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 200, minWidth: 260,
                        background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 10,
                        boxShadow: '0 -6px 24px var(--cr-shade-2)', overflow: 'hidden',
                    }}>
                        <div style={{ padding: '8px 14px 4px', fontFamily: CR.mono, fontSize: 8.5, color: CR.muted, letterSpacing: '0.08em' }}>
                            WHERE THIS AGENT WORKS
                        </div>
                        {OPTIONS.map(o => {
                            const OIcon = o.lane === 'local' ? Monitor : Cloud;
                            const selected = o.lane === lane;
                            const offline = o.lane === 'local' && connected === false;
                            return (
                                <button key={o.lane} role="option" aria-selected={selected}
                                    onClick={() => { onChange(o.lane); setOpen(false); }}
                                    style={{
                                        display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left',
                                        padding: '9px 14px', background: selected ? withAlpha(color, 7) : 'transparent',
                                        border: 'none', color: CR.text, fontFamily: CR.sans, cursor: 'pointer',
                                    }}>
                                    <span style={{ display: 'flex', paddingTop: 2, color: CR.sub }}><OIcon size={14} /></span>
                                    <span style={{ flex: 1 }}>
                                        <span style={{ display: 'block', fontSize: 12.5, color: CR.cream }}>{o.label}</span>
                                        <span style={{ display: 'block', fontSize: 11, color: CR.muted, marginTop: 1 }}>
                                            {offline ? 'Not connected. Open the NanoCrew desktop app.' : o.detail}
                                        </span>
                                    </span>
                                    {selected && <span style={{ display: 'flex', paddingTop: 2, color }}><Check size={14} /></span>}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
            <button onClick={() => { if (!disabled) setOpen(v => !v); }} disabled={disabled}
                title={warn
                    ? 'This computer is selected, but the desktop app is not connected'
                    : lane === 'local' ? 'Working on this computer' : "Working in NanoCrew's cloud"}
                style={{
                    height: 30, borderRadius: 9, padding: '0 9px', display: 'flex', alignItems: 'center', gap: 6,
                    background: open ? withAlpha(color, 8) : 'transparent',
                    border: `1px solid ${warn ? 'var(--cr-amber)' : open ? withAlpha(color, 38) : CR.border}`,
                    color: warn ? 'var(--cr-amber)' : CR.sub,
                    fontFamily: CR.sans, fontSize: 11.5, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap',
                }}>
                <Icon size={13} />
                <span>{lane === 'local' ? 'This computer' : 'Cloud'}</span>
                {lane === 'local' && connected !== null && (
                    <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? 'var(--cr-green)' : 'var(--cr-amber)' }} />
                )}
                <ChevronDown size={12} />
            </button>
        </div>
    );
}
