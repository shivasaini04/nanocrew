/**
 * Which cookie proves a DURABLE login, per site.
 *
 * ## Why this is its own file
 *
 * Three places need it and none of them may disagree:
 *
 *   scripts/spikes/profile_session_check.mjs   reads Chrome's SQLite (the CLI companion)
 *   desktop/sessions.js                        reads Electron's cookie store (the app)
 *   the dashboard                              renders whatever they report
 *
 * A second copy of a registry like this is the shape of bug this repo keeps paying for —
 * a value drifts in one place, and the failure is silent because both copies still look
 * reasonable. `extension/probes.generated.js` exists for the same reason.
 *
 * ## Why "durable" is the only question worth asking
 *
 * The obvious check — load the site and see whether it renders a logged-in page — is
 * WRONG, and the stage 52 spike proved it wrong on live data. Run 2 showed the real
 * LinkedIn feed while the profile held only `JSESSIONID` and `chp_token`, both
 * session-scoped: the moment the browser closed, the login was gone.
 *
 * That distinction matters far more for an agent than for a person. A human who gets
 * logged out sees a login form and logs in again. An unattended 3am cycle sees an auth
 * wall, reports "no results", and nobody finds out for days —
 * `reference_agent_records_are_not_evidence`.
 *
 * So the test is always: **the auth cookie exists AND it is persistent.**
 *
 * ## The per-site notes cost three live spike runs to learn
 *
 * They are not decoration. Each one is a way a login can look fine and not be.
 */

export const SITES = {
    linkedin: {
        label: 'LinkedIn',
        /** Where "Sign in" sends the browser. */
        loginUrl: 'https://www.linkedin.com/login/',
        /** For the Chrome-SQLite reader: a LIKE pattern over host_key. */
        hostLike: '%linkedin%',
        /** For Electron's cookie store: an origin to query. */
        origin: 'https://www.linkedin.com',
        /** The cookie that proves a durable login. */
        cookie: 'li_at',
        /** Present alongside it when things went well. */
        corroborating: ['liap'],
        /** A cookie whose presence WITHOUT the auth cookie explains the failure. */
        warnIf: {
            chp_token: 'a login challenge was raised — it may not have been completed',
        },
        /**
         * Shown to the user before they sign in. Every line was learned the hard way in
         * the 2026-09-05 spike, where two attempts produced a working feed and no durable
         * session.
         */
        hints: [
            'Use your email and password — not "Continue with Google". The Google picker '
            + 'hangs on a fresh profile, because no Google account is signed into it.',
            'Tick "Keep me signed in". Without it LinkedIn issues a session that dies when '
            + 'the browser closes.',
            'Finish any code or device check fully before closing the panel.',
        ],
    },

    github: {
        label: 'GitHub',
        loginUrl: 'https://github.com/login',
        hostLike: '%github%',
        origin: 'https://github.com',
        cookie: 'user_session',
        corroborating: ['logged_in', 'dotcom_user'],
        hints: [
            'Sign in with your username and password.',
            'Complete two-factor if GitHub asks — the session is only durable once it is '
            + 'fully cleared.',
        ],
    },

    google: {
        label: 'Google',
        loginUrl: 'https://accounts.google.com/',
        hostLike: '%google.com',
        origin: 'https://accounts.google.com',
        cookie: 'SID',
        corroborating: ['SSID', 'HSID'],
        hints: [
            'Google is strict about new browsers and may ask you to confirm on your phone.',
        ],
    },

    x: {
        label: 'X',
        loginUrl: 'https://x.com/i/flow/login',
        hostLike: '%x.com',
        origin: 'https://x.com',
        cookie: 'auth_token',
        corroborating: ['ct0'],
        hints: [
            'Use your password rather than a social sign-in.',
        ],
    },
};

/** Kept for the SQLite reader, whose existing callers use this name. */
export const SITE_AUTH = SITES;

export function siteNames() {
    return Object.keys(SITES);
}
