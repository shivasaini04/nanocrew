/**
 * Egress gateway — the residential proxy without its password.
 *
 * Until 2026-09-11 the DataImpulse credentials were passed into every agent container as
 * PROXY_HOST/PORT/USER/PASS. That made them readable by anything the agent runs: on
 * Crawler's Round 2 the agent wrote its own scraper with `exec`, read PROXY_PASS from
 * the environment and fetched pages straight through the paid pool — around every budget,
 * pacing rule and 429 latch that `source_fetch` exists to apply. The same password was
 * also printed in clear in the spawn-config log line on every cycle.
 *
 * Now the password stays in the orchestrator. Agents get this gateway's address and a key
 * that is theirs alone:
 *
 *   PROXY_HOST=host.docker.internal  PROXY_PORT=3130
 *   PROXY_USER=<agentId>             PROXY_PASS=HMAC(<upstream secret>, agentId)
 *
 * The Python side is unchanged — `proxy_config` builds the same `http://user:pass@host:port`
 * URL it always did, and httpx / Playwright / Camoufox all speak to this gateway exactly as
 * they spoke to DataImpulse. The gateway checks the key, adds the real credentials, and
 * forwards to the upstream pool. A key only works here, is useless without the gateway, and
 * changes whenever the upstream password does.
 *
 * Two things the gateway adds on top, because it is the one place every proxied byte passes:
 *
 *  - **Pacing for any client.** New connections from one agent to a rate-sensitive site are
 *    spaced out (PACE_MS). source_fetch already paces its own requests; this is the backstop
 *    for code that does not go through it. A script that reuses one keep-alive tunnel for
 *    many requests is paced per tunnel, not per request — CONNECT is all the gateway sees
 *    of HTTPS.
 *  - **Metering.** Connections and bytes per agent per site, logged every 10 minutes, so the
 *    paid pool's spend is attributable for the first time.
 *
 * Deliberately a leaf (node builtins + logger): the cycle runner imports it.
 */
import crypto from 'crypto';
import http from 'http';
import net from 'net';

import { logger } from '../logger.js';

export const EGRESS_GATEWAY_PORT = parseInt(
  process.env.EGRESS_GATEWAY_PORT || '3130',
  10,
);

export interface Upstream {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** Minimum gap between new connections from ONE agent to one of these sites. */
export const PACE_MS: Record<string, number> = {
  'linkedin.com': 2000,
  'indeed.com': 2000,
  'glassdoor.com': 2000,
  'reddit.com': 3000,
  'x.com': 5000,
  'twitter.com': 5000,
};

export function upstreamFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Upstream | null {
  const host = (env.PROXY_HOST || '').trim().replace(/^https?:\/\//, '');
  const port = parseInt(env.PROXY_PORT || '', 10);
  if (!host || !port) return null;
  return { host, port, user: env.PROXY_USER || '', pass: env.PROXY_PASS || '' };
}

// An upstream with no credentials (IP-allowlisted) has nothing to derive keys from, so it
// gets a per-process random secret: keys then change on restart, which only costs a warm
// daemon its proxy until it is recycled.
const FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

function secretFor(upstream: Upstream): string {
  return (
    process.env.EGRESS_GATEWAY_SECRET ||
    (upstream.user || upstream.pass
      ? `nanocrew-egress:${upstream.user}:${upstream.pass}`
      : FALLBACK_SECRET)
  );
}

/** The key an agent presents as its proxy password. */
export function gatewayKey(agentId: string, upstream: Upstream): string {
  return crypto
    .createHmac('sha256', secretFor(upstream))
    .update(agentId)
    .digest('hex')
    .slice(0, 40);
}

/** `linkedin.com` for `www.linkedin.com:443` — keyed the same way as source_fetch. */
export function registrableDomain(hostPort: string): string {
  const host = hostPort
    .replace(/^\[|\]$/g, '')
    .split(':')[0]!
    .toLowerCase();
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

function agentFromAuth(
  header: string | undefined,
  upstream: Upstream,
): string | null {
  if (!header || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString(
    'utf-8',
  );
  const sep = decoded.indexOf(':');
  if (sep <= 0) return null;
  const agentId = decoded.slice(0, sep);
  const presented = Buffer.from(decoded.slice(sep + 1));
  const expected = Buffer.from(gatewayKey(agentId, upstream));
  if (
    presented.length !== expected.length ||
    !crypto.timingSafeEqual(presented, expected)
  )
    return null;
  return agentId;
}

const nextSlot = new Map<string, number>();

/** Wait for this agent's next slot on a paced site. Serialises concurrent opens. */
async function pace(agentId: string, domain: string): Promise<void> {
  const gap = PACE_MS[domain];
  if (!gap) return;
  const key = `${agentId}|${domain}`;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

interface Usage {
  connections: number;
  bytes: number;
}
const usage = new Map<string, Usage>();

function meter(agentId: string, domain: string): Usage {
  const key = `${agentId}|${domain}`;
  let u = usage.get(key);
  if (!u) {
    u = { connections: 0, bytes: 0 };
    usage.set(key, u);
  }
  return u;
}

/** Snapshot of connections/bytes per `agentId|domain` since the last flush. */
export function egressUsage(): Record<string, Usage> {
  return Object.fromEntries([...usage].map(([k, v]) => [k, { ...v }]));
}

const REALM = 'Proxy-Authenticate: Basic realm="nanocrew-egress"';

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function handleConnect(
  upstream: Upstream,
  req: http.IncomingMessage,
  client: net.Socket,
  head: Buffer,
): void {
  client.on('error', () => {
    /* client went away — nothing to report */
  });
  const agentId = agentFromAuth(req.headers['proxy-authorization'], upstream);
  if (!agentId) {
    client.end(
      `HTTP/1.1 407 Proxy Authentication Required\r\n${REALM}\r\nContent-Length: 0\r\n\r\n`,
    );
    return;
  }
  const target = req.url || '';
  const domain = registrableDomain(target);

  void pace(agentId, domain).then(() => {
    if (client.destroyed) return;
    const u = meter(agentId, domain);
    u.connections += 1;
    const up = net.connect(upstream.port, upstream.host);
    let buffered = Buffer.alloc(0);
    let established = false;

    up.on('error', (err) => {
      if (!established && !client.destroyed)
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      else client.destroy();
      logger.debug(
        { agentId, target, err: String(err) },
        '[egress] upstream error',
      );
    });
    up.once('connect', () => {
      up.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          (upstream.user || upstream.pass
            ? `Proxy-Authorization: ${basic(upstream.user, upstream.pass)}\r\n`
            : '') +
          '\r\n',
      );
    });

    const onHead = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      up.off('data', onHead);
      const status = parseInt(
        buffered.subarray(0, end).toString('latin1').split(' ')[1] || '0',
        10,
      );
      const rest = buffered.subarray(end + 4);
      if (status !== 200) {
        // Never relay the upstream's own 407: it would invite the client to retry with
        // credentials it does not have, and name the upstream in the challenge.
        const shown = status === 407 ? 502 : status || 502;
        client.end(
          `HTTP/1.1 ${shown} Upstream Refused\r\nContent-Length: 0\r\n\r\n`,
        );
        up.destroy();
        logger.warn(
          { agentId, target, status },
          '[egress] upstream refused CONNECT',
        );
        return;
      }
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) client.write(rest);
      if (head.length) up.write(head);
      up.on('data', (d: Buffer) => {
        u.bytes += d.length;
      });
      client.on('data', (d: Buffer) => {
        u.bytes += d.length;
      });
      up.pipe(client);
      client.pipe(up);
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
    };
    up.on('data', onHead);
  });
}

function handlePlain(
  upstream: Upstream,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const agentId = agentFromAuth(req.headers['proxy-authorization'], upstream);
  if (!agentId) {
    res
      .writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="nanocrew-egress"',
        'Content-Length': '0',
      })
      .end();
    return;
  }
  if (!/^https?:\/\//i.test(req.url || '')) {
    res
      .writeHead(400, { 'Content-Type': 'text/plain' })
      .end('This port is a forward proxy.');
    return;
  }
  const domain = registrableDomain(new URL(req.url!).host);
  void pace(agentId, domain).then(() => {
    const u = meter(agentId, domain);
    u.connections += 1;
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    if (upstream.user || upstream.pass)
      headers['proxy-authorization'] = basic(upstream.user, upstream.pass);
    const upReq = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upRes) => {
        const status =
          upRes.statusCode === 407 ? 502 : (upRes.statusCode ?? 502);
        res.writeHead(status, upRes.headers);
        upRes.on('data', (d: Buffer) => {
          u.bytes += d.length;
        });
        upRes.pipe(res);
      },
    );
    upReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upReq);
  });
}

let running: { server: http.Server; upstream: Upstream; port: number } | null =
  null;
let usageTimer: NodeJS.Timeout | null = null;

/**
 * Start the gateway if a residential upstream is configured. Returns the server, or null
 * when there is no upstream (the gateway then has nothing to guard and stays off).
 */
export function startEgressGateway(
  opts: { port?: number; host?: string; upstream?: Upstream | null } = {},
): http.Server | null {
  const upstream =
    opts.upstream === undefined ? upstreamFromEnv() : opts.upstream;
  if (!upstream) return null;
  const port = opts.port ?? EGRESS_GATEWAY_PORT;
  const server = http.createServer((req, res) =>
    handlePlain(upstream, req, res),
  );
  server.on('connect', (req, socket, head) =>
    handleConnect(upstream, req, socket as net.Socket, head),
  );
  server.on('error', (err) => {
    logger.error(
      { err: String(err), port },
      '[egress] gateway failed — agents will get NO proxy, not the raw credentials',
    );
    if (running?.server === server) running = null;
  });
  server.listen(port, opts.host ?? '0.0.0.0', () => {
    running = {
      server,
      upstream,
      port: (server.address() as net.AddressInfo).port,
    };
    logger.info(
      { port: running.port, upstream: upstream.host },
      '[egress] residential gateway listening',
    );
  });
  if (!usageTimer) {
    usageTimer = setInterval(
      () => {
        if (usage.size === 0) return;
        logger.info(
          { usage: egressUsage() },
          '[egress] residential pool usage, last 10 min',
        );
        usage.clear();
      },
      10 * 60 * 1000,
    );
    usageTimer.unref();
  }
  return server;
}

/**
 * The proxy env an agent container gets: this gateway and the agent's own key — never the
 * upstream credentials. Null while the gateway is not listening, in which case the agent
 * gets no proxy at all rather than the password it used to get.
 */
export function gatewayProxyEnv(
  agentId: string,
): Record<string, string> | null {
  if (!running) return null;
  return {
    PROXY_HOST: 'host.docker.internal',
    PROXY_PORT: String(running.port),
    PROXY_USER: agentId,
    PROXY_PASS: gatewayKey(agentId, running.upstream),
  };
}

/**
 * Env names only this module may set in an agent container.
 *
 * Stage 64 phase 2, found 2026-09-30: the founder's account held owner-scoped secrets named
 * PROXY_HOST/PORT/USER/PASS, and PROXY_PASS was the real upstream password. Secrets are
 * injected after the gateway env, and again from the stdin payload, so they won: every
 * agent on that account had the residential-proxy password this gateway exists to keep out,
 * and it went around every pacing rule and budget. A secret by one of these names is never
 * injected.
 */
export const GATEWAY_OWNED_ENV: ReadonlySet<string> = new Set([
  'PROXY_HOST',
  'PROXY_PORT',
  'PROXY_USER',
  'PROXY_PASS',
]);

/** `env` without the names the gateway owns, plus which were dropped (names only — never values). */
export function withoutGatewayOwned(env: Record<string, string>): {
  env: Record<string, string>;
  dropped: string[];
} {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (GATEWAY_OWNED_ENV.has(k)) dropped.push(k);
    else out[k] = v;
  }
  return { env: out, dropped };
}

/** Test hook. */
export async function _stopEgressGateway(): Promise<void> {
  const r = running;
  running = null;
  nextSlot.clear();
  usage.clear();
  if (r) await new Promise<void>((resolve) => r.server.close(() => resolve()));
}
