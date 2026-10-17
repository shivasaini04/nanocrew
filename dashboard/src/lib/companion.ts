/**
 * Is a companion running on this machine? (stage 52 step 5)
 *
 * ## Why the dashboard asks localhost about it
 *
 * The companion runs on the user's own computer and drives a real Chrome there. The
 * dashboard runs in a tab on that same computer. So when both are present, the browser
 * the agent is driving is sitting a few inches from the eye that wants to watch it, and
 * the frames have no reason to cross the internet at all.
 *
 * That is the difference between this and the existing live view. `chat:frame` carries a
 * picture from the container in Frankfurt, through the orchestrator, to here — which is
 * why `live_screen.py` keeps VNC off except during takeover, and why watching an agent
 * has always felt like watching a slideshow of somewhere far away. When a companion is
 * present there is no distance to pay for.
 *
 * ## Why probing cannot be skipped
 *
 * Nothing tells the dashboard a companion exists. The orchestrator knows a *controller*
 * is attached, but not whether it is an extension in this browser, a companion on this
 * machine, or a companion on a different machine entirely — and only the last case would
 * make a local stream wrong. Asking 127.0.0.1 directly is the one question that answers
 * "is it HERE", which is the only thing that matters for showing pixels.
 *
 * ## Failing is the normal case
 *
 * Most users have no companion. The probe fails, fast, and the panel keeps using the
 * relayed frames exactly as before. So every failure here is silent by design: a console
 * error on every dashboard load for a feature the user has not installed is noise that
 * trains people to ignore the console.
 */

/** Where the companion serves its view. Matches `--view-port`'s default. */
const COMPANION_ORIGIN = 'http://127.0.0.1:9223';

/** A probe must not delay the panel; a companion answers in single-digit ms. */
const PROBE_TIMEOUT_MS = 1200;

/** The surface desktop/preload.js exposes. Feature-detected, never assumed. */
interface DesktopBridge {
    present: boolean;
    info: () => Promise<{
        version?: string;
        browserUrl?: string | null;
        panelVisible?: boolean;
        lane?: { running: boolean; attached: boolean };
    }>;
    browser?: {
        setVisible: (v: boolean) => Promise<boolean>;
        navigate: (url: string) => Promise<boolean>;
    };
}

export interface CompanionStatus {
    /** True when running inside the desktop app — the browser is a pane, not a stream. */
    inApp?: boolean;
    /** The MJPEG stream an <img> can point at. */
    streamUrl: string;
    /** Is a screencast actually attached, or is the companion merely running? */
    streaming: boolean;
    /** Where the agent's browser is, for a caption. */
    url: string;
    title: string;
    frames: number;
}

/**
 * Ask the local machine whether a companion is there.
 *
 * Returns null for "no companion", which is the ordinary answer and not an error.
 */
export async function probeCompanion(): Promise<CompanionStatus | null> {
    // Inside the desktop app there is nothing to probe: the browser is a pane in the same
    // window, so the app says so directly and no request is made at all. This is the
    // whole point of the shell — the loopback fetch, the CORS headers and the
    // Private-Network-Access negotiation below exist only because a web page cannot see a
    // browser on its own machine (stage 52 Phase 2).
    const desktop = (window as unknown as { nanocrewDesktop?: DesktopBridge }).nanocrewDesktop;
    if (desktop?.present) {
        try {
            const info = await desktop.info();
            return {
                streamUrl: '',            // no stream: the panel IS the browser
                inApp: true,
                streaming: Boolean(info?.lane?.attached),
                url: info?.browserUrl ?? '',
                title: '',
                frames: 0,
            };
        } catch {
            // An older shell whose bridge predates info(). Degrade to "present, idle"
            // rather than falling through to a loopback probe that cannot succeed here.
            return { streamUrl: '', inApp: true, streaming: false, url: '', title: '', frames: 0 };
        }
    }

    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);

        const res = await fetch(`${COMPANION_ORIGIN}/status`, {
            signal: ctl.signal,
            // No cookies: this is a different origin and the companion authenticates
            // nothing. Sending credentials would be pointless and slightly worse.
            credentials: 'omit',
            cache: 'no-store',
        });
        clearTimeout(timer);

        if (!res.ok) return null;
        const body = await res.json();
        if (!body?.companion) return null;

        return {
            inApp: false,
            // Prefer the companion's own idea of its URL — it knows which port it bound,
            // which need not be the default if the user moved it.
            streamUrl: typeof body.streamUrl === 'string' ? body.streamUrl : `${COMPANION_ORIGIN}/stream`,
            streaming: Boolean(body.streaming),
            url: typeof body.url === 'string' ? body.url : '',
            title: typeof body.title === 'string' ? body.title : '',
            frames: Number(body.frames) || 0,
        };
    } catch {
        // No companion, a firewall, a browser blocking private-network access, or the
        // page is not on the same machine. All of them mean the same thing to the caller.
        return null;
    }
}
