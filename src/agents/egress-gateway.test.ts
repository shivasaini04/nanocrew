import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'net';
import type { AddressInfo } from 'net';

import {
  _stopEgressGateway,
  egressUsage,
  gatewayKey,
  gatewayProxyEnv,
  registrableDomain,
  startEgressGateway,
  withoutGatewayOwned,
  type Upstream,
} from './egress-gateway.js';

/** A stand-in for DataImpulse: records every CONNECT head, answers 200, then echoes. */
function fakeUpstream(): Promise<{
  port: number;
  heads: string[];
  close: () => void;
}> {
  const heads: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let tunnel = false;
    sock.on('data', (d) => {
      if (tunnel) {
        sock.write(d);
        return;
      }
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      heads.push(buf.slice(0, end));
      tunnel = true;
      sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        heads,
        close: () => {
          sockets.forEach((s) => s.destroy());
          server.close();
        },
      }),
    ),
  );
}

function connectVia(
  port: number,
  target: string,
  auth?: string,
): Promise<{ status: number; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          (auth
            ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n`
            : '') +
          '\r\n',
      );
    });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      sock.off('data', onData);
      resolve({ status: parseInt(buf.split(' ')[1]!, 10), sock });
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

const once = (sock: net.Socket) =>
  new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));

describe('egress gateway', () => {
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let upstream: Upstream;
  let port: number;
  const open: net.Socket[] = [];

  beforeEach(async () => {
    up = await fakeUpstream();
    upstream = {
      host: '127.0.0.1',
      port: up.port,
      user: 'dataimpulse-user',
      pass: 'the-real-password',
    };
    const server = startEgressGateway({
      port: 0,
      host: '127.0.0.1',
      upstream,
    })!;
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    open.splice(0).forEach((s) => s.destroy());
    up.close();
    await _stopEgressGateway();
  });

  it('gives an agent a key and the gateway address — never the upstream password', () => {
    const env = gatewayProxyEnv('agent-1')!;
    expect(env.PROXY_HOST).toBe('host.docker.internal');
    expect(env.PROXY_USER).toBe('agent-1');
    expect(env.PROXY_PASS).toBe(gatewayKey('agent-1', upstream));
    expect(Object.values(env).join(' ')).not.toContain('the-real-password');
    expect(Object.values(env).join(' ')).not.toContain('dataimpulse-user');
  });

  it('tunnels an agent with a valid key, adding the real credentials upstream', async () => {
    const { status, sock } = await connectVia(
      port,
      'www.linkedin.com:443',
      `agent-1:${gatewayKey('agent-1', upstream)}`,
    );
    open.push(sock);
    expect(status).toBe(200);
    const echoed = once(sock);
    sock.write('ping');
    expect(await echoed).toBe('ping');
    const head = up.heads[0]!;
    expect(head).toContain('CONNECT www.linkedin.com:443');
    expect(head).toContain(
      `Basic ${Buffer.from('dataimpulse-user:the-real-password').toString('base64')}`,
    );
    expect(egressUsage()['agent-1|linkedin.com']!.connections).toBe(1);
  });

  it('challenges a client with no credentials (browsers only send them after a 407)', async () => {
    const { status, sock } = await connectVia(port, 'www.linkedin.com:443');
    open.push(sock);
    expect(status).toBe(407);
    expect(up.heads).toHaveLength(0);
  });

  it("refuses one agent's key presented as another agent", async () => {
    const { status, sock } = await connectVia(
      port,
      'www.linkedin.com:443',
      `agent-2:${gatewayKey('agent-1', upstream)}`,
    );
    open.push(sock);
    expect(status).toBe(407);
  });

  it('refuses the upstream password itself — it is not a gateway key', async () => {
    const { status, sock } = await connectVia(
      port,
      'www.linkedin.com:443',
      'dataimpulse-user:the-real-password',
    );
    open.push(sock);
    expect(status).toBe(407);
  });

  it('spaces out new connections from one agent to a paced site', async () => {
    const auth = `agent-1:${gatewayKey('agent-1', upstream)}`;
    const t0 = Date.now();
    const a = await connectVia(port, 'www.linkedin.com:443', auth);
    const b = await connectVia(port, 'www.linkedin.com:443', auth);
    open.push(a.sock, b.sock);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  });

  it('does not pace a site with no profile, or a different agent', async () => {
    const t0 = Date.now();
    const a = await connectVia(
      port,
      'example.com:443',
      `agent-1:${gatewayKey('agent-1', upstream)}`,
    );
    const b = await connectVia(
      port,
      'example.com:443',
      `agent-1:${gatewayKey('agent-1', upstream)}`,
    );
    const c = await connectVia(
      port,
      'www.linkedin.com:443',
      `agent-3:${gatewayKey('agent-3', upstream)}`,
    );
    open.push(a.sock, b.sock, c.sock);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('keys domains the way source_fetch does', () => {
    expect(registrableDomain('www.linkedin.com:443')).toBe('linkedin.com');
    expect(registrableDomain('nz.linkedin.com')).toBe('linkedin.com');
  });
});

describe('withoutGatewayOwned (stage 64 phase 2)', () => {
  it('a secret named like the proxy env never reaches a container — it overrode the gateway key with the real password', () => {
    const { env, dropped } = withoutGatewayOwned({
      PROXY_HOST: 'upstream.example',
      PROXY_PORT: '823',
      PROXY_USER: 'u',
      PROXY_PASS: 'real-password',
      PROXY_FOR_HTTP_TOOLS: '1',
      SERPER_API_KEY: 'k',
    });
    expect(env).toEqual({ PROXY_FOR_HTTP_TOOLS: '1', SERPER_API_KEY: 'k' });
    expect(dropped.sort()).toEqual([
      'PROXY_HOST',
      'PROXY_PASS',
      'PROXY_PORT',
      'PROXY_USER',
    ]);
  });

  it('nothing to drop: unchanged', () => {
    expect(withoutGatewayOwned({ A: '1' })).toEqual({
      env: { A: '1' },
      dropped: [],
    });
  });
});
