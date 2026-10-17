/**
 * Found live 2026-09-22: clicking "Preview" on a real .xlsx an agent had produced
 * threw "Unsupported ZIP Compression method NaN" in the browser. Root cause was one
 * layer back — this route read EVERY non-image file with `fs.promises.readFile(path,
 * 'utf-8')`, a lossy decode. A spreadsheet is a ZIP archive; forcing its bytes through
 * UTF-8 replaces every invalid sequence with U+FFFD before a single byte leaves the
 * server, so no client-side parser downstream was ever going to succeed.
 *
 * These drive the real route over real HTTP against a real binary file on disk and
 * assert the response bytes are IDENTICAL to what was written — the property the old
 * code broke — not just that the endpoint returns 200.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { _initTestDatabase, insertAgent, createUser } from '../../db.js';
import { filesRouter } from './files.js';
import { DATA_DIR } from '../../config.js';
import type { Agent } from '../../types.js';

let server: Server;
let baseUrl: string;
const AGENTS_DIR = path.join(DATA_DIR, 'agents');

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const uid = req.header('x-test-user');
    if (uid) (req as any).user = { id: uid };
    next();
  });
  app.use('/api', filesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  fs.rmSync(AGENTS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  _initTestDatabase();
});

function setup(agentId: string) {
  createUser({
    id: 'owner',
    email: 'owner@test.local',
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  insertAgent({
    id: agentId,
    name: 'Mechanic',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
    owner_id: 'owner',
    created_at: new Date().toISOString(),
  } as Agent);
  const dir = path.join(AGENTS_DIR, agentId, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A real xlsx's opening bytes: the ZIP local-file-header signature, then bytes that
 * are guaranteed invalid as UTF-8 (a lone continuation byte, an overlong sequence) —
 * exactly the shape the old utf-8 decode would have mangled into U+FFFD. */
function fakeXlsxBytes(): Buffer {
  return Buffer.from([
    0x50,
    0x4b,
    0x03,
    0x04, // "PK\x03\x04" — ZIP local file header signature
    0x80,
    0x81,
    0xff,
    0xfe, // invalid UTF-8 on their own
    ...Buffer.from('[Content_Types].xml', 'ascii'),
    0x00,
    0x01,
    0x02,
    0xc0,
    0xc1, // more invalid-as-UTF-8 bytes
  ]);
}

const url = (agentId: string, filename: string) =>
  `${baseUrl}/api/files/content?context=agent&contextId=${agentId}&path=${encodeURIComponent(filename)}`;

describe('GET /files/content — binary fidelity', () => {
  it('a real .xlsx comes back byte-for-byte identical, not UTF-8-mangled', async () => {
    const agentId = 'agent-xlsx';
    const dir = setup(agentId);
    const original = fakeXlsxBytes();
    fs.writeFileSync(path.join(dir, 'report.xlsx'), original);

    const res = await fetch(url(agentId, 'report.xlsx'), {
      headers: { 'x-test-user': 'owner' },
    });
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());

    expect(got.equals(original)).toBe(true);
    // The specific failure this bug produced: U+FFFD (EF BF BD in UTF-8) appearing
    // where a genuinely invalid byte used to be — proof the old code's decode step ran.
    expect(got.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it('declares the real spreadsheet MIME type, not text/plain', async () => {
    const agentId = 'agent-xlsx-mime';
    const dir = setup(agentId);
    fs.writeFileSync(path.join(dir, 'report.xlsx'), fakeXlsxBytes());

    const res = await fetch(url(agentId, 'report.xlsx'), {
      headers: { 'x-test-user': 'owner' },
    });
    expect(res.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('a real .docx also round-trips exactly and gets its own MIME type', async () => {
    const agentId = 'agent-docx';
    const dir = setup(agentId);
    const original = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x80, 0x81, 0xff, 0xc0, 0xc1,
    ]);
    fs.writeFileSync(path.join(dir, 'resume.docx'), original);

    const res = await fetch(url(agentId, 'resume.docx'), {
      headers: { 'x-test-user': 'owner' },
    });
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(original)).toBe(true);
    expect(res.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('an ordinary text file still comes back as correct, readable text', async () => {
    const agentId = 'agent-txt';
    const dir = setup(agentId);
    fs.writeFileSync(
      path.join(dir, 'notes.md'),
      '# Notes\n\ncafé — a genuine UTF-8 accent',
      'utf-8',
    );

    const res = await fetch(url(agentId, 'notes.md'), {
      headers: { 'x-test-user': 'owner' },
    });
    const text = await res.text();
    expect(text).toBe('# Notes\n\ncafé — a genuine UTF-8 accent');
  });

  it('an unrecognised binary extension still round-trips exactly, on a generic MIME type', async () => {
    const agentId = 'agent-unknown';
    const dir = setup(agentId);
    const original = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80]);
    fs.writeFileSync(path.join(dir, 'data.bin'), original);

    const res = await fetch(url(agentId, 'data.bin'), {
      headers: { 'x-test-user': 'owner' },
    });
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(original)).toBe(true);
  });

  it('sets nosniff — Content-Type is only meaningful if the browser agrees to use it', async () => {
    const agentId = 'agent-nosniff';
    const dir = setup(agentId);
    fs.writeFileSync(path.join(dir, 'report.xlsx'), fakeXlsxBytes());

    const res = await fetch(url(agentId, 'report.xlsx'), {
      headers: { 'x-test-user': 'owner' },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('still refuses a file the caller does not own', async () => {
    const agentId = 'agent-owned-by-someone-else';
    setup(agentId);
    const res = await fetch(url(agentId, 'report.xlsx'), {
      headers: { 'x-test-user': 'a-stranger' },
    });
    expect(res.status).toBe(404);
  });
});
