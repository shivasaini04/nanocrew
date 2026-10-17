import { useEffect, useRef } from 'react';

/**
 * Bind the dashboard's "browser" drawer to the desktop app's real browser pane.
 *
 * ## The problem this fixes
 *
 * The web dashboard shows the agent's browser in a drawer, because a web page has no
 * other way to show it — the picture arrives as frames and is rendered inside the page.
 *
 * The desktop app already HAS the browser, as a real Chromium pane beside the dashboard.
 * So without this, opening the browser tab in the app gave you a drawer describing a
 * browser that was already on screen. With it, the app behaves the way the drawer already
 * implies: the pane appears when you open the browser tab, and goes away when you close
 * it. Same gesture, but what appears is the browser rather than a picture of it.
 *
 * ## Two bugs this has already had, both worth keeping in mind
 *
 * **1 — racing IPC.** `setVisible` is async, and the first version put three calls in
 * flight at once (React invokes an effect, its cleanup, then the effect again). Whichever
 * resolved LAST won, usually the cleanup's `false`. Hence the serialised chain below: one
 * desired value, and a stale reply cannot overwrite the current intent.
 *
 * **2 — hiding on unmount.** The second version still hid the pane in an unmount cleanup.
 * The host page re-mounts more often than it looks — a route change, a remount from a
 * changing key — and each remount fired a cleanup that slammed the pane shut. Instrumented
 * 2026-09-06: one `setVisible(true)` followed by four separate `setVisible(false)` calls.
 *
 * So **only an explicit change of `open` moves the pane now.** If the page unmounts while
 * the pane is open, the pane stays open. That is the better failure too: a pane left
 * showing is a thing the user can close, while a pane that shuts itself looks broken and
 * gives them nothing to do about it.
 *
 * ## Why it lives in the dashboard rather than the app
 *
 * Only the dashboard knows intent — which agent is open, whether the browser tab was
 * clicked. The app knows how to show a pane. Intent flows one way through the narrow
 * preload bridge, and the app stays ignorant of what a "drawer" is.
 *
 * Outside the desktop app this is inert: no bridge, no calls, and the web drawer renders
 * exactly as before.
 */

interface DesktopBrowser {
    setVisible: (visible: boolean) => Promise<boolean>;
}

function panel(): DesktopBrowser | null {
    const d = (window as unknown as { nanocrewDesktop?: { browser?: DesktopBrowser } }).nanocrewDesktop;
    return d?.browser ?? null;
}

/** True when running inside the desktop shell. */
export function inDesktopApp(): boolean {
    return typeof window !== 'undefined'
        && Boolean((window as unknown as { nanocrewDesktop?: unknown }).nanocrewDesktop);
}

export function useDesktopBrowserPanel(open: boolean): void {
    /** The only source of truth for what the pane should be doing right now. */
    const desired = useRef(open);
    /** Serialises the IPC so replies cannot arrive out of order. */
    const inFlight = useRef<Promise<unknown>>(Promise.resolve());

    useEffect(() => {
        const api = panel();
        if (!api) return;               // web dashboard: nothing to do

        // This runs on mount too, INCLUDING when the drawer is closed, and that matters:
        // the drawer is the source of truth for whether the pane is showing, so a mount
        // has to assert it rather than assume it. An earlier version skipped a closed
        // first run to be tidy, and the result was a pane left open beside an unrelated
        // drawer — the Workspace open on the left, a browser still showing on the right,
        // with no way to reconcile them. Reported 2026-09-06.
        //
        // This does not bring back the closing bug, which came from an UNMOUNT cleanup
        // (see the docstring). Asserting on mount and never hiding on unmount are
        // different things.
        desired.current = open;
        // Chain rather than fire-and-forget: each call waits for the previous one and then
        // re-reads the desired value, so a queued call that has been superseded applies
        // the current intent instead of a stale one.
        inFlight.current = inFlight.current
            .catch(() => {})
            .then(() => api.setVisible(desired.current));
    }, [open]);

    // Deliberately NO unmount cleanup. See the module docstring — hiding on unmount is
    // what made the pane close itself.
}
