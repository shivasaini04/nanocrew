/**
 * Stage 40 — setTrackedItemStage writes both stores.
 *
 * The bug this guards against is not "the file was not updated". It is that a stage written
 * only to `tracked_items` gets REVERTED by the next cycle, because `_syncTrackedItems` copies
 * the workspace file over the table with a bare `stage = excluded.stage`. So the load-bearing
 * test here is `survives a cycle sync` — the others are scaffolding around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

// DATA_DIR is resolved from process.cwd() at import time, so it has to be replaced before
// tracker-file.js pulls it in — otherwise the test writes into the real data/ directory.
const h = vi.hoisted(() => {
  const os2 = require('os'),
    fs2 = require('fs'),
    path2 = require('path');
  return {
    dataDir: fs2.mkdtempSync(
      path2.join(os2.tmpdir(), 'nanocrew-tracker-test-'),
    ),
  };
});

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: h.dataDir };
});

const {
  _initTestDatabase,
  upsertEntitySchema,
  upsertTrackedItem,
  buildTrackedUrlIndex,
  getTrackedItems,
  insertAgent,
} = await import('../db.js');
const { setTrackedItemStage } = await import('./tracker-file.js');

const AGENT_ID = 'tracker-test-agent';
const LEAD_KEY = 'ojp:virtual-events-assistant-1661998';

function trackerFile(): string {
  return path.join(
    h.dataDir,
    'agents',
    AGENT_ID,
    'workspace',
    'tracked',
    'Leads.json',
  );
}

function writeTracker(rows: unknown[]): void {
  const f = trackerFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rows, null, 2), 'utf-8');
}

function readTracker(): any[] {
  return JSON.parse(fs.readFileSync(trackerFile(), 'utf-8'));
}

/**
 * What AgentService._syncTrackedItems() does on every cycle: copy the workspace file into
 * tracked_items, keyed on the schema's FIRST field, stage taken as `it.stage ?? data.stage`.
 * A row whose item_key drifted from an earlier sweep is folded back onto its original
 * item_key by matched_post_url (2026-08-15 Landeed dedup fix) before the upsert.
 */
function runCycleSync(): void {
  const items = readTracker();
  const urlIndex = buildTrackedUrlIndex(AGENT_ID, 'Leads');
  for (const it of items) {
    const data = it?.data && typeof it.data === 'object' ? it.data : it;
    let itemKey = String(data?.handle ?? '').trim();
    if (!itemKey) continue;
    const url =
      typeof data?.matched_post_url === 'string'
        ? data.matched_post_url.trim()
        : '';
    if (url) {
      const canonicalKey = urlIndex.get(url);
      if (canonicalKey && canonicalKey !== itemKey) itemKey = canonicalKey;
      else if (!canonicalKey) urlIndex.set(url, itemKey);
    }
    upsertTrackedItem(
      AGENT_ID,
      'Leads',
      itemKey,
      it?.stage ?? data?.stage ?? null,
      data,
      'cycle',
    );
  }
}

function dbStage(key = LEAD_KEY): string | null {
  const row = getTrackedItems(AGENT_ID, 'Leads').find(
    (r: any) => r.item_key === key,
  );
  return row ? row.stage : null;
}

beforeEach(() => {
  _initTestDatabase();
  // entity_schemas has a FK to agents, so the row has to exist even though tracker-file
  // itself never reads it.
  insertAgent({
    id: AGENT_ID,
    name: 'Finder',
    type: 'lead_hunter',
    status: 'running',
    workspace: path.join(h.dataDir, 'agents', AGENT_ID, 'workspace'),
    config: {},
    identity_version: 1,
    created_at: new Date().toISOString(),
  } as any);
  upsertEntitySchema(AGENT_ID, {
    name: 'Lead',
    namePlural: 'Leads',
    stages: [
      { key: 'qualified', label: 'Qualified' },
      { key: 'unreachable', label: 'Unreachable' },
    ] as any,
    // `handle` first — this is the key field, matching Finder's real schema.
    fields: [
      { key: 'handle', label: 'Handle' },
      { key: 'business', label: 'Business' },
    ] as any,
  });
});

afterEach(() => {
  fs.rmSync(path.join(h.dataDir, 'agents'), { recursive: true, force: true });
});

describe('setTrackedItemStage', () => {
  it('writes the stage to the workspace file and the DB projection', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: LEAD_KEY,
        data: { handle: LEAD_KEY, business: 'DMV Dating' },
      },
    ]);
    runCycleSync();
    expect(dbStage()).toBe('qualified');

    const r = setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');

    expect(r.fileUpdated).toBe(true);
    expect(r.dbUpdated).toBe(true);
    expect(r.previousStage).toBe('qualified');
    expect(readTracker()[0].stage).toBe('unreachable');
    expect(dbStage()).toBe('unreachable');
  });

  // ── The regression. This is the whole point of the module. ────────────────────────────
  it('survives a cycle sync — a DB-only write would be reverted here', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: LEAD_KEY,
        data: { handle: LEAD_KEY, business: 'DMV Dating' },
      },
    ]);
    runCycleSync();

    setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');
    expect(dbStage()).toBe('unreachable');

    // The next cycle runs and re-syncs the file over the table.
    runCycleSync();

    expect(dbStage()).toBe('unreachable');
    expect(readTracker()[0].stage).toBe('unreachable');
  });

  it('proves the old DB-only path really was reverted by a sync', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: LEAD_KEY,
        data: { handle: LEAD_KEY, business: 'DMV Dating' },
      },
    ]);
    runCycleSync();

    // Exactly what the poller used to do: table only, file untouched.
    upsertTrackedItem(
      AGENT_ID,
      'Leads',
      LEAD_KEY,
      'unreachable',
      { handle: LEAD_KEY },
      'poller',
    );
    expect(dbStage()).toBe('unreachable');

    runCycleSync();

    expect(dbStage()).toBe('qualified'); // reverted — the bug, reproduced
  });

  it('keeps a nested data.stage in step so the row cannot contradict itself', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: LEAD_KEY,
        data: { handle: LEAD_KEY, stage: 'qualified' },
      },
    ]);

    setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');

    const row = readTracker()[0];
    expect(row.stage).toBe('unreachable');
    expect(row.data.stage).toBe('unreachable');
  });

  it('handles a flat row with no nested data object', () => {
    writeTracker([
      { stage: 'qualified', handle: LEAD_KEY, business: 'DMV Dating' },
    ]);

    const r = setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');

    expect(r.fileUpdated).toBe(true);
    expect(readTracker()[0].stage).toBe('unreachable');
  });

  it('leaves other rows untouched', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: 'other-lead',
        data: { handle: 'other-lead' },
      },
      { stage: 'qualified', handle: LEAD_KEY, data: { handle: LEAD_KEY } },
    ]);

    setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');

    const rows = readTracker();
    expect(rows.find((r) => r.handle === 'other-lead').stage).toBe('qualified');
    expect(rows.find((r) => r.handle === LEAD_KEY).stage).toBe('unreachable');
  });

  it('reports honestly when the row is absent instead of silently succeeding', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: 'someone-else',
        data: { handle: 'someone-else' },
      },
    ]);

    const r = setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');

    expect(r.fileUpdated).toBe(false);
    expect(r.reason).toContain('no row with handle=');
  });

  it('reports honestly when there is no tracker file at all', () => {
    const r = setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');
    expect(r.fileUpdated).toBe(false);
    expect(r.reason).toContain('no tracker file');
  });

  it('does not corrupt the file or leave temp files behind', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: LEAD_KEY,
        data: { handle: LEAD_KEY, business: 'DMV Dating' },
      },
    ]);

    setTrackedItemStage(AGENT_ID, 'Leads', LEAD_KEY, 'unreachable');

    expect(() => readTracker()).not.toThrow();
    expect(readTracker()[0].data.business).toBe('DMV Dating'); // fields preserved
    const dir = path.dirname(trackerFile());
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

// ── The Landeed bug, reproduced and fixed (2026-08-15). ──────────────────────────────────
// Real incident: the same YC posting was written to Leads.json twice under two different
// item_key slugs ("landeed-crm-95120" on 08-13, "landeed-customer-relationship-manager-95120"
// on 08-15) because the agent regenerates item_key from the role title, which isn't stable
// across sweeps. Dedup is on (agent_id, entity, item_key), so the second sync created a
// second row for a posting already tracked — and already emailed, under the first key.
describe('runCycleSync URL dedup', () => {
  const URL =
    'https://www.ycombinator.com/companies/landeed/jobs/rwIYQSC-customer-relationship-manager';

  it('folds a re-discovered posting (drifted item_key, same URL) into its original row', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: 'landeed-crm-95120',
        data: {
          handle: 'landeed-crm-95120',
          matched_post_url: URL,
          found_date: '2026-08-13',
        },
      },
    ]);
    runCycleSync();
    expect(getTrackedItems(AGENT_ID, 'Leads')).toHaveLength(1);

    // Next sweep re-discovers the same posting under a differently-worded slug.
    writeTracker([
      {
        stage: 'qualified',
        handle: 'landeed-crm-95120',
        data: {
          handle: 'landeed-crm-95120',
          matched_post_url: URL,
          found_date: '2026-08-13',
        },
      },
      {
        stage: 'qualified',
        handle: 'landeed-customer-relationship-manager-95120',
        data: {
          handle: 'landeed-customer-relationship-manager-95120',
          matched_post_url: URL,
          found_date: '2026-08-15',
        },
      },
    ]);
    runCycleSync();

    const rows = getTrackedItems(AGENT_ID, 'Leads');
    expect(rows).toHaveLength(1); // not 2 — the duplicate is a bug, not a second lead
    expect(rows[0].item_key).toBe('landeed-crm-95120'); // the original, already-emailed key wins
  });

  it('still tracks two different postings as two rows when URLs genuinely differ', () => {
    writeTracker([
      {
        stage: 'qualified',
        handle: 'landeed-crm-95120',
        data: {
          handle: 'landeed-crm-95120',
          matched_post_url: URL,
          found_date: '2026-08-13',
        },
      },
      {
        stage: 'qualified',
        handle: 'other-co-role-1',
        data: {
          handle: 'other-co-role-1',
          matched_post_url: 'https://example.com/jobs/1',
          found_date: '2026-08-14',
        },
      },
    ]);
    runCycleSync();
    expect(getTrackedItems(AGENT_ID, 'Leads')).toHaveLength(2);
  });
});
