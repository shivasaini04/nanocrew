import { useEffect, useRef, useState } from 'react';
import { CR } from '../lib/cr';
import { socket } from '../lib/socket';
import { useLiveBrowsersStore, isBrowserLive } from '../stores/liveBrowsersStore';
import VncViewer from './VncViewer';
import { probeCompanion, type CompanionStatus } from '../lib/companion';

/**
 * The agent's browser, in the workspace drawer — watch it, and take the wheel when it
 * asks (phases 5.1 and 5.5).
 *
 * The frames are the ones already arriving app-wide (liveBrowsersStore); nothing is
 * fetched here. Input goes back over the same cycle channel the frames came down.
 *
 * Two states, and the difference must be visible at a glance:
 *
 * - **Watching.** A picture. It must not look interactive, because a picture you can
 *   click that does nothing is worse than one that does not invite clicking.
 * - **Driving.** The agent is parked and waiting for you. Now clicks land on the real
 *   page, and the panel says so loudly enough that nobody clicks by accident.
 *
 * Both lanes reach here: the container browser via CDP screencast, and the user's own
 * browser via the extension's page.screenshot.
 */
export default function AgentBrowserPanel({ agentId }: { agentId?: string }) {
    const frame = useLiveBrowsersStore(s => (agentId ? s.byAgent[agentId] : undefined));
    const live = useLiveBrowsersStore(s => isBrowserLive(s.byAgent, agentId));
    const ask = useLiveBrowsersStore(s => (agentId ? s.waiting[agentId] : undefined));
    const clearTakeover = useLiveBrowsersStore(s => s.clearTakeover);

    // stage 52: a companion on THIS machine means the browser being driven is a few
    // inches away, so its picture should come straight off loopback instead of being
    // relayed from the container. Probed rather than announced — the orchestrator knows a
    // controller is attached but not whether it is on this computer, and only that
    // decides whether a local stream is the right thing to show.
    const [companion, setCompanion] = useState<CompanionStatus | null>(null);
    useEffect(() => {
        let alive = true;
        const tick = async () => {
            const s = await probeCompanion();
            if (alive) setCompanion(s);
        };
        void tick();
        // Slow poll: this only has to notice a companion starting or stopping, and it is
        // a request to the user's own machine on every dashboard that has this panel open.
        const t = setInterval(tick, 5000);
        return () => { alive = false; clearInterval(t); };
    }, []);

    const [driving, setDriving] = useState(false);
    const [typed, setTyped] = useState('');
    const imgRef = useRef<HTMLImageElement | null>(null);
    // Stage 50: while driving, show the real screen over VNC instead of the once-a-second
    // picture. Falls back to the picture — which still works — if the screen is
    // unavailable, so an image without x11vnc, or a lane with no display at all, loses
    // smoothness rather than the ability to drive.
    const [vncFailed, setVncFailed] = useState<string | null>(null);

    const cycleId = ask?.cycleId ?? frame?.cycleId;
    // An ask is itself the invitation: the run is parked and waiting, whether or not
    // a frame has arrived yet. Requiring `live` here left the button disabled at the
    // exact moment it was needed, since liveness is inferred from frames.
    const canDrive = !!cycleId && (live || !!ask);
    const liveScreen = driving && !!cycleId && !vncFailed;

    const send = (input: Record<string, unknown>) => {
        if (!cycleId) return;
        socket.emit('browser:input', { cycleId, input });
    };

    const handBack = () => {
        if (cycleId) socket.emit('browser:release', { cycleId });
        setDriving(false);
        setTyped('');
        // Cleared so the next takeover tries the live screen again rather than
        // inheriting one run's failure for the rest of the session.
        setVncFailed(null);
        if (agentId) clearTakeover(agentId);
    };

    /**
     * A click on the picture becomes a click on the page.
     *
     * Sent as a FRACTION of the rendered image, never pixels: this image is a frame
     * downscaled from the real viewport and then scaled again to whatever width the
     * drawer happens to be, so a pixel measured here means nothing to the page. The
     * container multiplies by the real viewport, where that is actually known.
     */
    const onFrameClick = (e: React.MouseEvent<HTMLImageElement>) => {
        if (!driving) return;
        const rect = imgRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        send({
            kind: 'mouse',
            type: 'click',
            nx: (e.clientX - rect.left) / rect.width,
            ny: (e.clientY - rect.top) / rect.height,
        });
    };

    /**
     * Scrolling the picture scrolls the page.
     *
     * Sent with the cursor position so the wheel lands on whatever is under it — that is
     * what lets an inner scroll container (a modal body, a long dropdown) receive it
     * rather than the document behind it.
     *
     * Needs an extension new enough to have `input.scroll`; an older one simply does not
     * scroll, and the PageUp/PageDown buttons still work because those go through
     * input.key, which this lane has always had.
     */
    const onFrameWheel = (e: React.WheelEvent<HTMLImageElement>) => {
        if (!driving) return;
        const rect = imgRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        send({
            kind: 'scroll',
            nx: (e.clientX - rect.left) / rect.width,
            ny: (e.clientY - rect.top) / rect.height,
            dx: e.deltaX,
            dy: e.deltaY,
        });
    };

    // No frame AND nothing waiting on you: there is genuinely nothing here.
    //
    // The `ask` half of this condition is the fix for a real trap. The empty state used
    // to return before the ask and the buttons were rendered, so a run that was parked
    // waiting for a human — with no frame yet, which is exactly what happens when it
    // asks on turn one — showed "No browser open right now" and NO Hand back button.
    // The one moment you must be able to answer was the one moment the panel offered
    // nothing to press. Observed live 2026-09-03.
    if (!frame && !ask && !companion) {
        return (
            <div style={{ padding: 24, fontFamily: CR.sans, fontSize: 12.5, color: CR.muted, lineHeight: 1.6, textAlign: 'center' }}>
                <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.5 }}>🖥</div>
                No browser open right now.
                <div style={{ fontSize: 11.5, marginTop: 6 }}>
                    When this agent starts browsing, the page it is working on appears here.
                </div>
            </div>
        );
    }

    // A companion is running here, so show ITS browser — live, off loopback, whether or
    // not a cycle is currently driving it. Seeing the real window sit there idle is the
    // point: it is the browser your agent will use, and you can tell it is yours.
    if (companion) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderBottom: `1px solid ${CR.border}`, flexShrink: 0 }}>
                    <span style={{
                        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: companion.streaming ? 'var(--cr-green)' : CR.muted,
                        ...(companion.streaming ? { boxShadow: '0 0 7px var(--cr-green)' } : {}),
                    }} />
                    <span style={{ fontFamily: CR.mono, fontSize: 10.5, color: CR.muted, flexShrink: 0 }}>
                        {companion.inApp ? 'your browser · in app' : 'your browser · local'}
                    </span>
                    <span style={{
                        fontFamily: CR.sans, fontSize: 11, color: CR.sub, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                        {companion.title || companion.url || 'waiting for the agent'}
                    </span>
                </div>
                {/* An ask, in the app.
                    The pane beside this IS the browser, so there is no picture to drive
                    and no VNC to start — the person just uses it. What they still need is
                    a way to say they are finished, and that is the only thing missing
                    when the run is parked: the agent waits for `browser:release` and has
                    no other way to learn that the human did the work.
                    Found 2026-09-06: an agent hit a LinkedIn login wall, asked for help,
                    the user signed in in the pane, and the cycle stayed parked because the
                    Hand back button lived in a drawer the desktop app does not render. */}
                {companion.inApp && ask && (
                    <div style={{
                        margin: '10px 10px 0', padding: '12px 14px', borderRadius: 8,
                        border: `1px solid ${CR.amber}55`, background: 'var(--cr-amber-low, transparent)',
                    }}>
                        <div style={{ fontFamily: CR.sans, fontSize: 12.5, color: CR.text, fontWeight: 600, marginBottom: 4 }}>
                            Your agent needs you
                        </div>
                        <div style={{ fontFamily: CR.sans, fontSize: 12, color: CR.sub, lineHeight: 1.55, marginBottom: 10 }}>
                            {ask.reason || 'It has paused and is waiting for you.'}
                            {' '}Do what is needed in the browser pane, then hand it back.
                        </div>
                        <button
                            onClick={handBack}
                            style={{
                                padding: '6px 14px', fontSize: 12, fontWeight: 600, borderRadius: 7,
                                border: 'none', background: CR.amber, color: '#1a1208', cursor: 'pointer',
                            }}
                        >I&rsquo;m done — carry on</button>
                    </div>
                )}

                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 10px' }}>
                    {companion.inApp ? (
                        /* Inside the desktop app the browser is the pane beside this one —
                           a real Chromium, not a picture of one. Rendering a stream here
                           would be a screenshot of a window already on screen. */
                        <div style={{
                            marginTop: 10, padding: '18px 16px', borderRadius: 6,
                            border: `1px solid ${CR.border}`,
                            fontFamily: CR.sans, fontSize: 12, color: CR.sub, lineHeight: 1.6,
                        }}>
                            <div style={{ color: CR.text, fontWeight: 600, marginBottom: 6 }}>
                                Your browser is open beside this panel →
                            </div>
                            {companion.url && (
                                <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, marginBottom: 8, wordBreak: 'break-all' }}>
                                    {companion.url}
                                </div>
                            )}
                            Sign into any site in that pane once, and your agents can use it.
                            Nothing leaves this machine.
                        </div>
                    ) : (
                        <>
                            {/* An <img> on an MJPEG stream: the browser decodes it off the
                                main thread and there is no per-frame React state to churn. */}
                            <img
                                src={companion.streamUrl}
                                alt="Your own browser, driven by the agent"
                                style={{
                                    display: 'block', width: '100%', borderRadius: 6,
                                    marginTop: 10, border: `1px solid ${CR.border}`, background: '#fff',
                                }}
                            />
                            <div style={{ fontFamily: CR.sans, fontSize: 11, color: CR.muted, marginTop: 8, lineHeight: 1.5 }}>
                                This is Chrome on your own computer. Sign into any site in that window once and
                                your agents can use it — the picture never leaves this machine.
                            </div>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderBottom: `1px solid ${CR.border}`, flexShrink: 0 }}>
                <span style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: live ? 'var(--cr-green)' : CR.muted,
                    ...(live ? { boxShadow: '0 0 7px var(--cr-green)' } : {}),
                }} />
                {/* A still must never pass for a live view. Frames stop when the cycle
                    ends, and the label is what keeps the last picture honest. */}
                <span style={{ fontFamily: CR.mono, fontSize: 10.5, color: CR.muted, flexShrink: 0 }}>
                    {live ? (driving ? 'YOU ARE DRIVING' : 'LIVE') : 'CLOSED — LAST VIEW'}
                </span>
                {frame?.title && (
                    <span title={frame.title!} style={{ fontFamily: CR.sans, fontSize: 11.5, color: CR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {frame.title}
                    </span>
                )}
            </div>

            {/* What the agent stopped for. Shown whether or not you have taken the wheel,
                because it is the reason to. */}
            {ask && (
                <div style={{ margin: '8px 10px 0', padding: '9px 11px', borderRadius: 7, border: `1px solid ${CR.amberLine}`, background: CR.amberLow, flexShrink: 0 }}>
                    <div style={{ fontFamily: CR.mono, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: CR.amber, marginBottom: 4 }}>
                        Waiting for you
                    </div>
                    <div style={{ fontFamily: CR.sans, fontSize: 12.5, color: CR.text, lineHeight: 1.55 }}>
                        {ask.reason}
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0, flexWrap: 'wrap' }}>
                {!driving ? (
                    <button
                        onClick={() => setDriving(true)}
                        disabled={!canDrive}
                        title={canDrive ? 'Click in the page yourself' : 'The browser is not open'}
                        style={{
                            padding: '5px 11px', borderRadius: 6, fontSize: 12, cursor: canDrive ? 'pointer' : 'not-allowed',
                            border: `1px solid ${ask ? CR.amber : CR.border}`,
                            background: ask ? CR.amberLow : 'transparent',
                            color: canDrive ? CR.text : CR.muted,
                        }}
                    >Take over</button>
                ) : (
                    <>
                        <button
                            onClick={handBack}
                            style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: `1px solid var(--cr-green)`, background: 'transparent', color: CR.text }}
                        >Hand back</button>
                        {/* These send through the SCREENSHOT input path (socket ->
                            takeover.py -> page.keyboard). On the live screen that is the
                            wrong pipe entirely: VNC carries the keyboard itself, and
                            anything sent this way lands on the page object the agent was
                            last on rather than the window you are looking at. Reported
                            live as "it's not catching the typing" — the keystrokes went
                            somewhere, just not where the person could see. So on the live
                            screen they are hidden, and you simply type. */}
                        {!liveScreen && (['Enter', 'Tab', 'Escape', 'PageUp', 'PageDown'] as const).map(key => (
                            <button
                                key={key}
                                onClick={() => send({ kind: 'key', key })}
                                style={{ padding: '5px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: `1px solid ${CR.border}`, background: 'transparent', color: CR.sub }}
                            >{key}</button>
                        ))}
                        {liveScreen && (
                            <span style={{ fontFamily: CR.sans, fontSize: 11.5, color: CR.muted }}>
                                Click the screen, then type as you normally would.
                            </span>
                        )}
                    </>
                )}
            </div>

            {driving && !liveScreen && (
                // A field rather than capturing keystrokes off the document: typing into
                // the page has to compete with the browser's own shortcuts otherwise, and
                // this way what you are about to send is visible before it lands. It is
                // also the honest place for a one-time code — a password belongs in a
                // stored credential, which the agent injects without anyone seeing it.
                <form
                    onSubmit={e => { e.preventDefault(); if (typed) { send({ kind: 'key', text: typed }); setTyped(''); } }}
                    style={{ display: 'flex', gap: 6, padding: '0 10px 8px', flexShrink: 0 }}
                >
                    <input
                        value={typed}
                        onChange={e => setTyped(e.target.value)}
                        placeholder="Type into the page, then Send"
                        style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: `1px solid ${CR.border}`, background: 'var(--cr-bg-main)', color: CR.text, fontSize: 12 }}
                    />
                    <button type="submit" style={{ padding: '5px 11px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: `1px solid ${CR.border}`, background: 'transparent', color: CR.text }}>Send</button>
                </form>
            )}

            {frame?.url && (
                // Page-controlled text: plain text, never an anchor. Truncated from the
                // left so the host stays readable on a long path.
                <div title={frame.url} style={{
                    margin: '0 10px 7px', padding: '3px 8px', borderRadius: 6,
                    background: 'var(--cr-bg-main)', border: `1px solid ${CR.border}`,
                    fontFamily: CR.mono, fontSize: 11, color: CR.muted, flexShrink: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    direction: 'rtl', textAlign: 'left',
                }}>
                    <span style={{ direction: 'ltr', unicodeBidi: 'bidi-override' }}>{frame.url}</span>
                </div>
            )}

            {!frame && (
                // Parked, asking, and no picture yet — say why rather than showing a
                // blank area. The controls above still work: Hand back must never
                // depend on a frame having arrived.
                <div style={{ padding: '14px 12px', fontFamily: CR.sans, fontSize: 12, color: CR.muted, lineHeight: 1.6 }}>
                    Waiting for the first frame of the page. The agent is paused and the
                    controls above are live — you can hand back at any time.
                </div>
            )}

            {/* Driving gets the real screen: the whole display, so a popup or a native
                dialog is visible, and at VNC's frame rate rather than one a second.
                Watching stays on the picture, because a live session costs CPU and
                bandwidth for as long as it is open and a glance does not need it. */}
            {liveScreen ? (
                // A plain block, not `flex: 1`: this panel is mounted inside a drawer
                // whose content box has no definite height, so `flex: 1` here resolves to
                // zero and takes the live screen with it. VncViewer carries its own
                // height instead — see the note in there.
                <div style={{ padding: '0 10px 10px', overflow: 'auto' }}>
                    <VncViewer cycleId={cycleId!} onFailed={setVncFailed} />
                </div>
            ) : frame ? (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 10px' }}>
                {driving && vncFailed && (
                    // Say why this is the slower view rather than letting it look broken.
                    <div style={{ fontFamily: CR.sans, fontSize: 11.5, color: CR.muted, paddingBottom: 6 }}>
                        Live screen unavailable ({vncFailed}) — driving the still picture instead.
                    </div>
                )}
                <img
                    ref={imgRef}
                    src={frame.dataUrl}
                    alt={driving ? 'The page you are driving — click to click' : 'The page the agent is working on'}
                    onClick={onFrameClick}
                    onWheel={onFrameWheel}
                    style={{
                        display: 'block', width: '100%', borderRadius: 6,
                        border: `1px solid ${driving ? CR.amber : CR.border}`,
                        cursor: driving ? 'crosshair' : 'default',
                    }}
                />
            </div>
            ) : null}
        </div>
    );
}
