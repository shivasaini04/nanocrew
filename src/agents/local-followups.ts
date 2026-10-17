/**
 * Work waiting for the user's computer (stage 60 phase 6).
 *
 * ## The gap
 *
 * NanoCrew works in two places — the cloud and the user's own machine — and until now a
 * task was either one or the other for its whole life. Two cases fell between them:
 *
 *   1. The person picks "This computer" for a message while the desktop app is closed.
 *      The run could only say "not connected" and drop the request.
 *   2. An unattended cloud run reaches a step only their computer can do — send the
 *      LinkedIn notes from their account, save the sheet into their Documents — at 3am,
 *      laptop shut. It could only report that it stopped.
 *
 * Both are the same thing: a piece of work that should happen the moment the machine is
 * back, while everything that does not need it carries on in the cloud.
 *
 * ## The shape
 *
 * A queue, keyed by owner, persisted to one JSON file. When a desktop app attaches for that
 * owner, every item for them is taken and run as a fresh cycle on "This computer". Items
 * expire after 24 hours: a request nobody's machine came back for in a day is stale, and
 * running it days later would surprise the person more than dropping it.
 *
 * Unlike `deferredForBrowser` (in-memory on purpose — it only holds "this agent wanted a
 * browser"), these hold a person's actual request, which a deploy restart must not lose.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

export interface LocalFollowup {
  id: string;
  agentId: string;
  /** Owner principal (browser-broker derivePrincipal) — whose machine this waits for. */
  principal: string;
  task: string;
  /** 'chat' when a person asked; 'agent' when a cloud run handed off the local part. */
  source: 'chat' | 'agent';
  projectId?: string;
  /** Why it waits, shown back to the person. */
  reason?: string;
  createdAt: number;
}

export const FOLLOWUP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_AGENT = 10;
const MAX_TASK_CHARS = 20_000;

export class LocalFollowupQueue {
  constructor(private readonly file: string) {}

  private read(): LocalFollowup[] {
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(rows)
        ? rows.filter(
            (r) =>
              r && typeof r.agentId === 'string' && typeof r.task === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  private write(rows: LocalFollowup[]): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.warn({ err: String(err) }, 'could not persist local follow-ups');
    }
  }

  private live(rows: LocalFollowup[], now: number): LocalFollowup[] {
    return rows.filter((r) => now - r.createdAt < FOLLOWUP_TTL_MS);
  }

  /**
   * Queue a task. A chat request REPLACES any earlier chat request for the same agent —
   * someone retyping while the app is closed means the newest message, not all of them.
   */
  add(
    item: Omit<LocalFollowup, 'id' | 'createdAt'>,
    now = Date.now(),
  ): LocalFollowup {
    let rows = this.live(this.read(), now);
    if (item.source === 'chat') {
      rows = rows.filter(
        (r) => !(r.agentId === item.agentId && r.source === 'chat'),
      );
    }
    const mine = rows.filter((r) => r.agentId === item.agentId);
    if (mine.length >= MAX_PER_AGENT) {
      // Oldest goes: a runaway agent queueing in a loop must not grow this without end.
      const oldest = mine.sort((a, b) => a.createdAt - b.createdAt)[0];
      rows = rows.filter((r) => r.id !== oldest.id);
    }
    const row: LocalFollowup = {
      ...item,
      task: item.task.slice(0, MAX_TASK_CHARS),
      id: crypto.randomUUID(),
      createdAt: now,
    };
    rows.push(row);
    this.write(rows);
    return row;
  }

  /** Everything waiting for this principal's machine. Removes them — running is one-shot. */
  takeFor(principal: string, now = Date.now()): LocalFollowup[] {
    const rows = this.live(this.read(), now);
    const taken = rows
      .filter((r) => r.principal === principal)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (taken.length || rows.length !== this.read().length) {
      this.write(rows.filter((r) => r.principal !== principal));
    }
    return taken;
  }

  listFor(agentId: string, now = Date.now()): LocalFollowup[] {
    return this.live(this.read(), now).filter((r) => r.agentId === agentId);
  }

  cancel(agentId: string, id?: string): number {
    const rows = this.read();
    const kept = rows.filter(
      (r) => !(r.agentId === agentId && (!id || r.id === id)),
    );
    if (kept.length !== rows.length) this.write(kept);
    return rows.length - kept.length;
  }
}

export const localFollowups = new LocalFollowupQueue(
  path.join(DATA_DIR, 'local-followups.json'),
);

/**
 * The prompt a queued item runs with, so the agent knows it is resuming — not starting
 * cold — and that the machine is now there.
 */
export function followupPrompt(f: LocalFollowup): string {
  const age = Math.max(1, Math.round((Date.now() - f.createdAt) / 60000));
  const head =
    f.source === 'chat'
      ? `The user asked this ${age} min ago while their computer was not connected. It is connected now — do it:`
      : `Earlier (${age} min ago) you queued this for when the user's computer was back. It is connected now — do it:`;
  return [
    head,
    '',
    f.task,
    ...(f.reason ? ['', `(Why it waited: ${f.reason})`] : []),
  ].join('\n');
}
