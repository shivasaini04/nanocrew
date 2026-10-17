/**
 * The database half of the daily send limit, kept out of batch-send-limit.ts so that
 * module stays pure and its tests never open SQLite.
 */
import { getAllAgents, getCheckinsByAgent } from '../db.js';
import type { BatchCheckinRow } from './batch-send-limit.js';

/** Every check-in of every agent this owner has — the rows the daily limit counts. */
export function ownerCheckins(ownerId: string | null): BatchCheckinRow[] {
  return getAllAgents()
    .filter(
      (a) => ((a as { owner_id?: string | null }).owner_id ?? null) === ownerId,
    )
    .flatMap((a) => getCheckinsByAgent(a.id));
}
