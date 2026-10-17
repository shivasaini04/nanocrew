/**
 * Stage 57 phase 4 — opening the pages a worker cited, fresh, from the orchestrator.
 *
 * The URLs come from a worker, and a worker reads the web: a poisoned page can make it cite
 * `http://litellm:4000/...`, a cloud metadata address, or any other service on the compose
 * network. So every connection — including each redirect hop — resolves the host, refuses
 * private, loopback, link-local and shared ranges, and connects to the address it checked
 * (the lookup is pinned into the request, so a second DNS answer cannot swap it).
 *
 * Fresh on purpose: phase 2 found the agent's fetch provider serving a stale copy of a page
 * (docs 18). A direct request comes first; a site that walls off bots gets one try through
 * Firecrawl with its cache disabled.
 */
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import zlib from 'zlib';

export interface Page {
  url: string;
  ok: boolean;
  status: number;
  finalUrl: string;
  text: string;
  via: 'direct' | 'firecrawl' | 'none';
  error?: string;
}

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MIN_TEXT = 200;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(a, p, 'ipv6');

/** True for any address a fetch from the orchestrator must never reach. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

/** Only public http(s) on the standard ports; anything else is refused before a lookup. */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return `${u.protocol} is not allowed`;
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  if (u.port && u.port !== '80' && u.port !== '443')
    return `port ${u.port} is not allowed`;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !net.isIP(host)) return 'not a public host name';
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    return 'not a public host name';
  if (net.isIP(host) && isBlockedAddress(host)) return 'a private address';
  return null;
}

/** dns.lookup that refuses private answers — pinned into every request. */
function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || !list.length) {
      const e = new Error(
        `${hostname} resolves to a private address`,
      ) as NodeJS.ErrnoException;
      e.code = 'EPRIVATE';
      return cb(e, '', 0);
    }
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

interface RawResponse {
  status: number;
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(body);
    if (encoding === 'deflate') return zlib.inflateSync(body);
    if (encoding === 'br') return zlib.brotliDecompressSync(body);
  } catch {
    /* serve what arrived */
  }
  return body;
}

function getOnce(url: string): Promise<{
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({
            status,
            location: res.headers.location,
            contentType: '',
            body: Buffer.alloc(0),
          });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status,
            contentType: String(res.headers['content-type'] ?? ''),
            body: decode(
              Buffer.concat(chunks),
              res.headers['content-encoding'] as string | undefined,
            ),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)),
    );
    req.on('error', reject);
    req.end();
  });
}

/** GET with redirects; every hop passes urlProblem and the pinned lookup. */
export async function safeGet(url: string): Promise<RawResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = urlProblem(current);
    if (problem) throw new Error(`refused ${current}: ${problem}`);
    const r = await getOnce(current);
    if (r.location) {
      current = new URL(r.location, current).toString();
      continue;
    }
    return {
      status: r.status,
      finalUrl: current,
      contentType: r.contentType,
      body: r.body,
    };
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  euro: '€',
  pound: '£',
  copy: '©',
};

/** Visible text of an HTML page — enough to find a value on it, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(br|\/p|\/div|\/li|\/tr|\/h\d|\/section|\/article)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** A page that answered but is a wall, not the content: bot checks and empty shells. */
export function looksBlocked(status: number, text: string): boolean {
  if ([401, 403, 429, 503].includes(status)) return true;
  if (text.length < MIN_TEXT) return true;
  return /just a moment\.\.\.|checking your browser|attention required|cf-browser-verification|verify you are (a )?human|enable javascript and cookies|captcha/i.test(
    text.slice(0, 3000),
  );
}

async function viaFirecrawl(url: string): Promise<Page> {
  // Lazy: the cycle runner is a heavy module, and only this fallback needs its key reader.
  const { readLLMKeys } = await import('../agents/nanobot-cycle-runner.js');
  const key = readLLMKeys().FIRECRAWL_API_KEY;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      // maxAge 0: a fresh copy, never Firecrawl's cache. Whole page — an address or a
      // price is often in a footer or a table that "main content" would drop.
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: false,
        maxAge: 0,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: {
        markdown?: string;
        metadata?: { statusCode?: number; sourceURL?: string };
      };
    };
    const status = body.data?.metadata?.statusCode ?? res.status;
    const text = body.data?.markdown ?? '';
    const ok =
      res.ok && !!body.success && status < 400 && text.length >= MIN_TEXT;
    return {
      url,
      ok,
      status,
      finalUrl: body.data?.metadata?.sourceURL ?? url,
      text,
      via: 'firecrawl',
      error: ok ? undefined : (body.error ?? `HTTP ${status}`),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      finalUrl: url,
      text: '',
      via: 'firecrawl',
      error: String((err as Error)?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Open a cited page now. `ok` means it loaded with real content. */
export async function fetchPage(url: string): Promise<Page> {
  const problem = urlProblem(url);
  if (problem)
    return {
      url,
      ok: false,
      status: 0,
      finalUrl: url,
      text: '',
      via: 'none',
      error: `refused: ${problem}`,
    };
  let direct: Page;
  try {
    const r = await safeGet(url);
    const isPdf = /application\/pdf/i.test(r.contentType);
    const raw = r.body.toString('utf-8');
    const text = isPdf
      ? ''
      : /html|xml/i.test(r.contentType) || /^\s*</.test(raw)
        ? htmlToText(raw)
        : raw;
    direct = {
      url,
      ok: r.status >= 200 && r.status < 300 && !looksBlocked(r.status, text),
      status: r.status,
      finalUrl: r.finalUrl,
      text,
      via: 'direct',
    };
    // Gone is gone — no point asking anyone else for a page the site says does not exist.
    if (r.status === 404 || r.status === 410)
      return { ...direct, ok: false, error: `HTTP ${r.status}` };
    if (direct.ok) return direct;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/private address|refused/.test(msg))
      return {
        url,
        ok: false,
        status: 0,
        finalUrl: url,
        text: '',
        via: 'none',
        error: msg,
      };
    direct = {
      url,
      ok: false,
      status: 0,
      finalUrl: url,
      text: '',
      via: 'direct',
      error: msg,
    };
  }
  const fc = await viaFirecrawl(url);
  return fc.ok
    ? fc
    : {
        ...direct,
        error: `${direct.error ?? `HTTP ${direct.status}, looks blocked`}; fallback: ${fc.error}`,
      };
}
