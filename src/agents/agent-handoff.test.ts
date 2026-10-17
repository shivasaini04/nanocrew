/**
 * Handoff file delivery.
 *
 * This had no tests, and the gap was expensive: a real handoff (Recruiter → Sandbox
 * Tester, 2026-07-17) sent `files` as an object of name → content. `Array.isArray`
 * said false, the key was skipped, and deliverFiles returned having copied nothing —
 * no error, no warning, handoff marked completed. The agent told the user the files
 * were delivered; the recipient's inbox directory didn't even exist.
 *
 * So these cover both payload shapes agents actually produce, and — the important part —
 * that an unusable payload can never look like a successful delivery.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// config.ts computes DATA_DIR from `process.cwd()` — it does NOT read an env var — and
// agent-handoff derives AGENTS_DIR from it at module load. So the only way to point this
// at a scratch directory is to mock the config module, hoisted above the import.
const { TMP_ROOT, TMP_DATA } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'handoff-'));
  return { TMP_ROOT: root, TMP_DATA: _path.join(root, 'data') };
});

vi.mock('../config.js', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  DATA_DIR: TMP_DATA,
}));

const tmp = TMP_ROOT;
const agentsDir = path.join(TMP_DATA, 'agents');

const FROM = 'agent-from';
const TO = 'agent-to';

beforeEach(() => {
  fs.rmSync(agentsDir, { recursive: true, force: true });
  fs.mkdirSync(agentsDir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function srcWorkspace() {
  const p = path.join(agentsDir, FROM, 'workspace');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function inboxOf(agentId = TO) {
  return path.join(agentsDir, agentId, 'workspace', 'inbox');
}

/** Drive the real deliverFiles. Imported once — see the DATA_DIR note above. */
async function deliver(payload: Record<string, unknown>) {
  const { __testDeliverFiles } = await import('./agent-handoff.js');
  return __testDeliverFiles(FROM, TO, payload);
}

describe('handoff file delivery — inline content (the shape that silently failed)', () => {
  it('writes files given as an object of name → content', async () => {
    const out = await deliver({
      summary: 'seed files for the new agent',
      files: {
        'KNOWLEDGE_SEED.md': '# Knowledge Seed\ncontent here',
        'SYSTEM_PROMPT.md': '# System Prompt\nrules here',
      },
    });

    expect(
      fs.readFileSync(path.join(inboxOf(), 'KNOWLEDGE_SEED.md'), 'utf-8'),
    ).toContain('Knowledge Seed');
    expect(
      fs.readFileSync(path.join(inboxOf(), 'SYSTEM_PROMPT.md'), 'utf-8'),
    ).toContain('System Prompt');
    // The recipient is handed paths it can actually read.
    expect(out.files).toEqual([
      'inbox/KNOWLEDGE_SEED.md',
      'inbox/SYSTEM_PROMPT.md',
    ]);
    expect(out._deliveredFiles).toEqual([
      'KNOWLEDGE_SEED.md',
      'SYSTEM_PROMPT.md',
    ]);
  });

  it('cannot be tricked out of the recipient inbox by a crafted name', async () => {
    await deliver({ files: { '../../escaped.md': 'nope' } });
    expect(fs.existsSync(path.join(inboxOf(), 'escaped.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'escaped.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'escaped.md'))).toBe(false);
  });
});

describe('handoff file delivery — paths (the original shape)', () => {
  it('copies files referenced by path out of the sender workspace', async () => {
    fs.writeFileSync(path.join(srcWorkspace(), 'report.md'), 'the report');
    const out = await deliver({ files: ['report.md'] });
    expect(fs.readFileSync(path.join(inboxOf(), 'report.md'), 'utf-8')).toBe(
      'the report',
    );
    expect(out.files).toEqual(['inbox/report.md']);
  });

  it('still refuses to read outside the sender workspace', async () => {
    fs.writeFileSync(path.join(tmp, 'secret.md'), 'private');
    const out = await deliver({ file: '../../../secret.md' });
    expect(out._deliveredFiles).toBeUndefined();
  });
});

describe('handoff file delivery — an unusable payload is never silent', () => {
  it('leaves a payload with no file keys completely alone', async () => {
    const out = await deliver({ summary: 'just a note', tasks: ['a'] });
    expect(out).toEqual({ summary: 'just a note', tasks: ['a'] });
    expect(fs.existsSync(inboxOf())).toBe(false); // no inbox conjured for nothing
  });

  it('delivers nothing when the referenced file does not exist', async () => {
    srcWorkspace();
    const out = await deliver({ files: ['missing.md'] });
    expect(out._deliveredFiles).toBeUndefined();
  });

  it('ignores non-string values inside a content object', async () => {
    const out = await deliver({
      files: { 'ok.md': 'fine', 'bad.md': { nested: true } },
    });
    expect(out._deliveredFiles).toEqual(['ok.md']);
  });
});

// 2026-09-13: Crawler handed Finder its list as `full_report: "/workspace/group/workspace/
// tracked/round2-find-20.md (each row: …)"`. No `file` key, a container path, trailing prose —
// and nothing was copied. Finder was handed a path into a workspace it cannot read.
describe('handoff file delivery — a path named anywhere in the payload', () => {
  it('delivers the exact shape Crawler sent', async () => {
    const ws = srcWorkspace();
    fs.mkdirSync(path.join(ws, 'tracked'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'tracked', 'round2-find-20.md'),
      '# 21 companies',
    );
    const out = await deliver({
      batch: 'Round 1 — Find 20',
      full_report:
        '/workspace/group/workspace/tracked/round2-find-20.md (each row: live-fetched posting)',
    });
    expect(
      fs.readFileSync(path.join(inboxOf(), 'round2-find-20.md'), 'utf-8'),
    ).toBe('# 21 companies');
    expect(out.full_report).toBe(
      'inbox/round2-find-20.md (each row: live-fetched posting)',
    );
    expect(out._deliveredFiles).toEqual(['round2-find-20.md']);
  });

  it('accepts the workspace-relative and plain forms, in nested values too', async () => {
    const ws = srcWorkspace();
    fs.mkdirSync(path.join(ws, 'tracked'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tracked', 'a.json'), '[]');
    fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'reports', 'b.csv'), 'x');
    const out = await deliver({
      details: { list: 'see workspace/tracked/a.json' },
      extra: ['reports/b.csv'],
    });
    expect(out._deliveredFiles).toEqual(['a.json', 'b.csv']);
    expect((out.details as { list: string }).list).toBe('see inbox/a.json');
  });

  it('reports a named container path that does not exist, so the sender is told', async () => {
    srcWorkspace();
    const out = await deliver({
      report: '/workspace/group/workspace/tracked/gone.md',
    });
    expect(out._undeliveredFiles).toEqual([
      '/workspace/group/workspace/tracked/gone.md',
    ]);
    expect(out._deliveredFiles).toBeUndefined();
  });

  it('ignores URLs and prose that only look like paths', async () => {
    // The sender HAS a LEAD_DEFINITION.md - a bare mention must still not ship it.
    fs.writeFileSync(
      path.join(srcWorkspace(), 'LEAD_DEFINITION.md'),
      'the sender copy',
    );
    const payload = {
      url: 'https://www.ycombinator.com/companies/x/jobs/y',
      note: 'read LEAD_DEFINITION.md first',
    };
    const out = await deliver(payload);
    expect(out).toEqual(payload);
  });

  it('never reaches outside the sender workspace through an embedded path', async () => {
    fs.writeFileSync(path.join(tmp, 'secret.md'), 'private');
    srcWorkspace();
    const out = await deliver({
      note: 'see ../../../secret.md and /workspace/group/workspace/../../secret.md',
    });
    expect(out._deliveredFiles).toBeUndefined();
    expect(fs.existsSync(path.join(inboxOf(), 'secret.md'))).toBe(false);
  });
});
