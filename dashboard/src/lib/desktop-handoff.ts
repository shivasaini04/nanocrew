/**
 * Handing a finished sign-in back to the desktop app.
 *
 * ## What this is for
 *
 * The desktop app cannot host a Google sign-in: Google refuses OAuth from embedded
 * browsers, and Electron's User-Agent carries the marker they look for. Measured
 * 2026-09-06 — the page loads, which is worse than a clean refusal, because it looks like
 * it works until it does not.
 *
 * So the app opens the login page in the user's REAL browser with `?desktop=1`. The user
 * signs in there by whatever means they like. This module notices that marker, asks the
 * server for a single-use ticket, and redirects to `nanocrew://auth?ticket=…`, which the
 * operating system routes back to the app.
 *
 * The credentials only ever touch the user's own browser.
 *
 * ## Why this is not Google-specific
 *
 * It fires after ANY successful sign-in — Google, email and password, or anything added
 * later — because the app takes no part in authentication. It asks the browser to do it
 * and waits for the answer. A Google-only path would need rebuilding the first time
 * another provider appeared.
 *
 * ## Why it must not fire inside the app
 *
 * The app also loads this dashboard. If it ran there it would mint a ticket and try to
 * deep-link into itself, which at best is a no-op and at worst is a loop. The desktop
 * bridge is the reliable tell: it exists only inside the shell.
 */

/** The query flag the app adds when it opens the login page in the system browser. */
export const DESKTOP_FLAG = 'desktop';

function inDesktopApp(): boolean {
    return typeof window !== 'undefined'
        && Boolean((window as unknown as { nanocrewDesktop?: unknown }).nanocrewDesktop);
}

/**
 * If this page was opened by the desktop app and the user is now signed in, hand the
 * session back and say so.
 *
 * Returns true when a handoff was started, so the caller can show "you can return to the
 * app" instead of the dashboard — landing on a working dashboard in the wrong window is
 * the confusing outcome here.
 */
export async function maybeHandOffToDesktop(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    if (params.get(DESKTOP_FLAG) !== '1') return false;

    // Inside the shell this would deep-link into itself. See the docstring.
    if (inDesktopApp()) return false;

    try {
        const res = await fetch('/api/auth/desktop/ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
        });
        if (!res.ok) return false;

        const { redirect } = await res.json() as { redirect?: string };
        if (!redirect) return false;

        // Assigning to location is what actually invokes the OS handler for the custom
        // protocol. A browser with no handler registered simply does nothing visible,
        // which is why the caller still shows an explanatory screen rather than assuming
        // the app took over.
        window.location.href = redirect;
        return true;
    } catch {
        // Network trouble, an older server without the endpoint, or a browser that
        // refuses the protocol. All of them mean the same thing to the user: finish in
        // the app manually.
        return false;
    }
}
