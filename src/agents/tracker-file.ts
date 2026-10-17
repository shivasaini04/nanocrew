/**
 * Stage 40 — write a tracked item's stage to BOTH stores.
 *
 * There are two copies of every tracked row and only one of them is authoritative:
 *
 *   workspace/tracked/<Entity>.json   the agent reads and writes this. It is the truth.
 *   tracked_items (SQLite)            the product reads this. It is a projection.
 *
 * `AgentService._syncTrackedItems()` copies file -> table on every cycle, and its upsert ends
 * with a bare `stage = excluded.stage`. So anything that writes ONLY to the table is not just
 * invisible to the agent — it is actively reverted by the next cycle.
 *
 * That is exactly what happened on 2026-08-11. `info@dmvdatingroup.com` bounced ("Address not
 * found"), the reply poller called `updateTrackedItemStage(... 'unreachable')`, and the table
 * was correct. `Leads.json` still said `qualified`, so the next sync would have pushed
 * `qualified` back over it and the lead would have looked live again — with the bounce
 * evidence sitting in `outreach_sends` the whole time, contradicting it.
 *
 * So: write the file first (the thing that wins), then the table (so the product updates
 * immediately instead of waiting for the next cycle).
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { getEntitySchema, updateTrackedItemStage } from '../db.js';
import { logger } from '../logger.js';

export interface TrackerStageWrite {
  /** The workspace JSON file was found and the row's stage rewritten. */
  fileUpdated: boolean;
  /** The tracked_items projection was updated. */
  dbUpdated: boolean;
  /** Stage the row held before this write, when the file had one. */
  previousStage?: string | null;
  reason?: string;
}

/**
 * Set `stage` on one tracked row, in the workspace file and in the DB projection.
 *
 * Returns what actually changed rather than throwing — callers are background pollers where a
 * missing workspace file is a normal condition (agent never ran, tracker not set up yet), not
 * an error worth crashing a poll pass over.
 */
export function setTrackedItemStage(
  agentId: string,
  entity: string,
  itemKey: string,
  stage: string,
): TrackerStageWrite {
  const result: TrackerStageWrite = { fileUpdated: false, dbUpdated: false };

  try {
    const schema = getEntitySchema(agentId);
    // Resolve the key field the same way _syncTrackedItems does, so "which row is this"
    // cannot be answered differently by the writer and the syncer. A rename of the schema's
    // first field has already silently broken row sync once (2026-08-08, 18 rows).
    const keyField = schema?.fields?.[0]?.key;
    const file = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'workspace',
      'tracked',
      `${entity}.json`,
    );

    if (!keyField) {
      result.reason = 'no entity schema / key field for this agent';
    } else if (!fs.existsSync(file)) {
      result.reason = `no tracker file at ${file}`;
    } else {
      const raw = fs.readFileSync(file, 'utf-8');
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) {
        result.reason = 'tracker file is not an array';
      } else {
        let hit = false;
        for (const it of items) {
          const data =
            it &&
            typeof it === 'object' &&
            it.data &&
            typeof it.data === 'object'
              ? it.data
              : it;
          if (String(data?.[keyField] ?? '').trim() !== itemKey) continue;

          hit = true;
          result.previousStage = (it?.stage ?? data?.stage ?? null) as
            | string
            | null;
          if (it && typeof it === 'object' && 'stage' in it) it.stage = stage;
          else if (it && typeof it === 'object') it.stage = stage;
          // _syncTrackedItems reads `it.stage ?? data.stage`, so a stale `data.stage` is
          // harmless there — but it makes the file self-contradictory to anyone reading it,
          // agent included. Keep the two in step when the row carries both.
          if (data && data !== it && 'stage' in data) data.stage = stage;
        }

        if (hit) {
          // Write via temp + rename: a cycle may be reading this file, and a torn tracker is
          // worse than a stale one — the agent parses it as JSON and would lose every row.
          const tmp = `${file}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf-8');
          fs.renameSync(tmp, file);
          result.fileUpdated = true;
        } else {
          result.reason = `no row with ${keyField}=${itemKey} in ${entity}.json`;
        }
      }
    }
  } catch (err) {
    result.reason = `file write failed: ${String(err)}`;
    logger.warn(
      { err: String(err), agentId, entity, itemKey },
      '[tracker-file] workspace write failed',
    );
  }

  try {
    result.dbUpdated = updateTrackedItemStage(agentId, entity, itemKey, stage);
  } catch (err) {
    logger.warn(
      { err: String(err), agentId, entity, itemKey },
      '[tracker-file] db stage update failed',
    );
  }

  // A DB-only write is the exact silent-revert failure this module exists to stop. Say so.
  if (result.dbUpdated && !result.fileUpdated) {
    logger.warn(
      { agentId, entity, itemKey, stage, reason: result.reason },
      '[tracker-file] stage written to tracked_items but NOT to the workspace file — the next cycle sync will revert it',
    );
  }

  return result;
}
