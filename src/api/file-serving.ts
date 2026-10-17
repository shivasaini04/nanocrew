/**
 * Response guards for any route that serves a file the product did not author.
 *
 * Every file-serving path in this app hands back bytes that an agent wrote, a user
 * uploaded, or a page was scraped into — none of it authored by us, all of it served
 * from the dashboard's own origin, where a script would run with the viewer's session.
 *
 * ## What was actually found (2026-09-02)
 *
 * Audited every path that writes bytes to a response:
 *
 * | path | verdict |
 * |---|---|
 * | `agents.ts` workspace/file?raw=1 | served `image/svg+xml` inline |
 * | `files.ts` file content | served `image/svg+xml` inline |
 * | `agents.ts` outputs/:filename, artifact download | safe, but only because `.svg` happens to be missing from `MIME_MAP` — the inline test is a `image/` prefix match, so adding it would silently open the hole |
 * | everything else | JSON, or `text/plain`, which cannot execute |
 *
 * And nothing mitigated it: a live check against prod found no
 * `X-Content-Type-Options`, no CSP, no `X-Frame-Options`. Uploads have a size limit and
 * no `fileFilter`, so any extension can be planted in a workspace.
 *
 * ## Why sandbox rather than `attachment`
 *
 * The first fix (agents.ts, earlier the same day) forced SVG to download. That works and
 * it is heavier than the problem: **an SVG referenced by `<img src>` never executes
 * script in any browser.** The XSS needs the SVG opened as a top-level document. So
 * forcing a download closes the hole and also breaks every legitimate `<img>` of a
 * workspace SVG.
 *
 * `Content-Security-Policy: sandbox` targets exactly the dangerous case: the bytes still
 * render as an image, and if someone navigates directly to the URL the document is
 * sandboxed into an opaque origin with scripting off. This is the approach large hosts
 * of user content use, minus the separate origin we do not have.
 *
 * `nosniff` is applied to everything, not just the risky types: without it a browser may
 * disregard our Content-Type entirely and guess from the bytes, which makes every
 * decision in this file advisory.
 */

import type { Response } from 'express';

/**
 * Types that can execute script when a browser renders them as a document.
 *
 * `text/html` is here for completeness even though the routes today serve it only as an
 * attachment — the point of a list is that the next person adding a route can read it.
 */
const SCRIPTABLE_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
]);

/**
 * Apply content-type guards for one file response.
 *
 * Call after deciding the MIME type and before sending the body. Returns nothing; it
 * only sets headers.
 */
export function guardFileResponse(res: Response, mimeType: string): void {
  // Always. Our Content-Type is only meaningful if the browser agrees to use it.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (SCRIPTABLE_TYPES.has(mimeType.split(';')[0].trim().toLowerCase())) {
    // Renders in <img> exactly as before; refuses to run script if opened directly.
    //
    // This REPLACES the app-wide CSP that security-headers.ts set earlier in the
    // chain, because setHeader overwrites. That is intentional and it is why the
    // value here is a complete policy rather than just `sandbox`: the app-wide one
    // is written for a dashboard page, and a file response should be allowed
    // nothing at all. Do not "fix" this into an append — `sandbox` plus
    // `frame-ancestors 'self'` would be a weaker document than this.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  }
}

/** Whether a type needs the sandbox — exported so tests can assert the list itself. */
export function isScriptableType(mimeType: string): boolean {
  return SCRIPTABLE_TYPES.has(mimeType.split(';')[0].trim().toLowerCase());
}
