import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc/lib/rfb';
import { CR } from '../lib/cr';

/**
 * The agent's actual screen, live (stage 50 phase 4).
 *
 * Not a picture of a page — the framebuffer of the X display the browser is drawing on,
 * streamed from x11vnc inside the container. It shows whatever is genuinely on that
 * screen: the page, a popup, a native dialog, the browser's own tab bar. The screenshot
 * path could only ever show one page object, which is what made an OAuth popup
 * invisible on 2026-09-03.
 *
 * ## Why this only appears while you are driving
 *
 * A VNC session costs CPU and bandwidth for as long as it is open. Glancing at what an
 * agent is doing does not need it, so the ambient view stays on the once-a-second
 * screenshot and this connects only when someone actually takes the wheel.
 *
 * ## Getting in
 *
 * A browser cannot set headers on a WebSocket handshake, so the socket cannot carry
 * proof of who is opening it. A cookie-authenticated route checks ownership and mints a
 * single-use ticket; the socket presents that. Same shape as the extension's transport,
 * for the same reason.
 */
export default function VncViewer({
    cycleId, viewOnly = false, onFailed,
}: {
    cycleId: string;
    /** Watching rather than driving: input is not sent. */
    viewOnly?: boolean;
    /** Told when this cannot be used, so the caller can fall back to screenshots. */
    onFailed?: (reason: string) => void;
}) {
    const holder = useRef<HTMLDivElement | null>(null);
    const rfbRef = useRef<InstanceType<typeof RFB> | null>(null);
    const [state, setState] = useState<'connecting' | 'live' | 'gone'>('connecting');
    const [detail, setDetail] = useState('');

    // The connection is keyed on the cycle alone. `viewOnly` deliberately does NOT
    // re-run this: flipping between watching and driving must not tear down and rebuild
    // the session — that would cost a full handshake and a fresh screen every time.
    useEffect(() => {
        let cancelled = false;
        let rfb: InstanceType<typeof RFB> | null = null;

        (async () => {
            let ticket: string;
            try {
                const res = await fetch(`/api/cycles/${encodeURIComponent(cycleId)}/vnc-ticket`, {
                    method: 'POST',
                    credentials: 'include',
                });
                if (!res.ok) throw new Error(`ticket refused (${res.status})`);
                ticket = (await res.json()).ticket;
            } catch (err) {
                if (cancelled) return;
                const reason = err instanceof Error ? err.message : 'could not get a ticket';
                setState('gone');
                setDetail(reason);
                onFailed?.(reason);
                return;
            }
            if (cancelled || !holder.current) return;

            const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const url = `${scheme}://${window.location.host}/api/cycle-vnc/ws`
                + `?ticket=${encodeURIComponent(ticket)}`;

            try {
                rfb = new RFB(holder.current, url, { shared: false });
            } catch (err) {
                if (cancelled) return;
                const reason = err instanceof Error ? err.message : 'could not open the screen';
                setState('gone');
                setDetail(reason);
                onFailed?.(reason);
                return;
            }
            rfbRef.current = rfb;

            // The display is 1920x1080 and this drawer is not. Scale to fit rather than
            // resizing the session: resizing would change the real screen the browser is
            // rendering on, and that screen's size is part of the fingerprint the
            // stealth layer is claiming.
            rfb.scaleViewport = true;
            rfb.resizeSession = false;
            rfb.viewOnly = viewOnly;
            rfb.background = 'transparent';

            rfb.addEventListener('connect', () => {
                if (cancelled) return;
                setState('live');
                // Take the keyboard immediately. noVNC only sends key events while its
                // canvas has focus, and without this the first thing a person does —
                // click a field and type a password — goes to the dashboard instead of
                // the remote screen, with no indication that it went anywhere.
                try { rfb!.focus(); } catch { /* not fatal */ }
            });
            rfb.addEventListener('disconnect', (e: Event) => {
                if (cancelled) return;
                setState('gone');
                // noVNC reports whether the close was orderly. "It ended" and "it broke"
                // are different things to tell someone mid-login.
                const clean = (e as CustomEvent<{ clean?: boolean }>).detail?.clean;
                setDetail(clean ? 'the run finished' : 'the connection dropped');
            });
            rfb.addEventListener('securityfailure', () => {
                if (!cancelled) { setState('gone'); setDetail('the screen refused the connection'); }
            });
        })();

        return () => {
            cancelled = true;
            const live = rfbRef.current ?? rfb;
            rfbRef.current = null;
            try { live?.disconnect(); } catch { /* already gone */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cycleId]);

    /**
     * Re-scale when THIS element changes size.
     *
     * noVNC recomputes its scale on `window` resize only (rfb.js `_windowResize`). Our
     * panel lives in a drawer that resizes without the window doing anything — the
     * "connecting" overlay clears, the ask banner appears, the drawer is dragged — and
     * every one of those leaves the scale stale.
     *
     * A stale scale is not a cosmetic problem: noVNC maps a click through it, so the
     * pointer lands somewhere other than where you clicked, by a margin that grows with
     * the error. Reported from a live run as "I click on the right and it indicates on
     * the left", which is exactly this.
     *
     * Assigning `scaleViewport` re-runs `_updateScale()`, so it is the supported way to
     * ask for a recompute.
     */
    useEffect(() => {
        const el = holder.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            const live = rfbRef.current;
            if (live) {
                try { live.scaleViewport = true; } catch { /* mid-teardown */ }
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Applied to the live session rather than rebuilding it — see the effect above.
    useEffect(() => {
        if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
    }, [viewOnly]);

    return (
        <div style={{ position: 'relative', width: '100%' }}>
            {/* A definite height of its OWN, derived from width — never inherited.

                UniversalDrawer renders tab content into a plain block div with no height,
                so `height: 100%` up the chain resolves to auto and any `flex: 1` in here
                collapses to zero. The screenshot `<img>` never noticed, because an image
                brings its own intrinsic height. A canvas does not: noVNC sized itself to a
                zero-height box and `overflow: hidden` clipped the result away, which looks
                exactly like "the browser is running but nothing is showing".

                16/9 because the display we serve is 1920x1080. scaleViewport letterboxes
                inside this box if the remote is ever a different shape, so a wrong guess
                costs black bars rather than a broken view. */}
            <div
                ref={holder}
                style={{
                    width: '100%', aspectRatio: '16 / 9', maxHeight: '72vh',
                    borderRadius: 6, overflow: 'hidden',
                    border: `1px solid ${viewOnly ? CR.border : CR.amber}`,
                    background: 'var(--cr-bg-main)',
                }}
            />
            {state !== 'live' && (
                <div style={{
                    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', textAlign: 'center', padding: 16,
                    fontFamily: CR.sans, fontSize: 12.5, color: CR.muted, lineHeight: 1.6,
                }}>
                    {state === 'connecting'
                        ? 'Opening the live screen…'
                        : `The live screen closed — ${detail}.`}
                </div>
            )}
        </div>
    );
}
