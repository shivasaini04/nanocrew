/**
 * Mid-run steering — a note from the owner that reaches a browser run already in flight.
 *
 * stage45 item 5. Everything else a human could say to a running agent was a *decision*:
 * the escalation gate offers approve / reject / comment on one proposed action, and only
 * when the agent chose to ask. There was no way to say "it's the second tab" or "stop
 * doing that, try the search box" to a run that is going wrong but not asking.
 *
 * ## Why a mailbox and not a socket
 *
 * The agent runs in a container that reaches the orchestrator over HTTP and has no
 * inbound address. It already polls for escalation decisions the same way. So steering
 * is a mailbox: the dashboard drops a note in, the run drains it at its next turn
 * boundary. Bounded latency, no new transport, and nothing to clean up if the run dies
 * mid-flight.
 *
 * ## Why turn boundaries and not immediately
 *
 * A turn is perceive -> decide -> act. Injecting a note anywhere inside that would mean
 * the model decided against one page state and acted on another. Draining between turns
 * means the note is simply part of the next decision's context, which is both correct
 * and the cheapest thing to reason about.
 *
 * ## Memory, deliberately
 *
 * Notes live in a Map, not the DB. A steer is only meaningful to a run that is currently
 * executing — an undelivered one is worthless the moment its cycle ends, and persisting
 * it would mean a note typed at a dying run resurfaces days later in an unrelated one.
 * The same reasoning `escalation.ts` uses for pending approvals.
 */

import { logger } from '../logger.js';

export interface SteerNote {
  text: string;
  at: number;
}

/** cycleId -> notes waiting for that run to pick them up. */
const pending = new Map<string, SteerNote[]>();

/** A note longer than this is a pasted document, not steering. */
const MAX_TEXT = 2000;

/** Per cycle. Someone hammering the box must not grow it without bound. */
const MAX_NOTES = 20;

/**
 * How long an undelivered note stays interesting.
 *
 * A run that never drains (it crashed, or it finished before the note landed) would
 * otherwise leave its notes in the map for the life of the process. Swept lazily on
 * every access rather than on a timer: there is no background loop to leak, and the map
 * is only ever touched by these three functions.
 */
const TTL_MS = 30 * 60 * 1000;

/**
 * The clock, injectable.
 *
 * Not a general-purpose abstraction — it exists because the TTL sweep is the one
 * behaviour here that cannot be observed without controlling time, and a test that
 * cannot observe it is a test that says the sweep works when it has been deleted.
 */
let clock: () => number = () => Date.now();

/** Test seam. */
export function _setClock(fn: () => number): void {
  clock = fn;
}

function sweep(): void {
  const cutoff = clock() - TTL_MS;
  for (const [cycleId, notes] of pending) {
    const live = notes.filter((n) => n.at >= cutoff);
    if (live.length === 0) pending.delete(cycleId);
    else if (live.length !== notes.length) pending.set(cycleId, live);
  }
}

/** Queue a note for a running cycle. Returns how many are now waiting. */
export function addSteer(cycleId: string, text: string): number {
  sweep();
  const clean = String(text ?? '')
    .trim()
    .slice(0, MAX_TEXT);
  if (!cycleId || !clean) return 0;

  const notes = pending.get(cycleId) ?? [];
  // Oldest-first eviction: if someone types twenty notes, the newest are the ones
  // still describing what they want.
  if (notes.length >= MAX_NOTES) notes.shift();
  notes.push({ text: clean, at: clock() });
  pending.set(cycleId, notes);
  logger.info(
    { cycleId, waiting: notes.length },
    'Steering note queued for a running cycle',
  );
  return notes.length;
}

/**
 * Take every note for this cycle. Draining is destructive on purpose: a note the run has
 * already been told about must not be repeated on the next turn, or the model reads it
 * as a fresh instruction every time and never stops obeying it.
 */
export function drainSteers(cycleId: string): SteerNote[] {
  sweep();
  const notes = pending.get(cycleId) ?? [];
  if (notes.length) {
    pending.delete(cycleId);
    logger.info(
      { cycleId, delivered: notes.length },
      'Steering notes delivered to a run',
    );
  }
  return notes;
}

/** How many notes are waiting, without taking them. For the dashboard's own feedback. */
export function countSteers(cycleId: string): number {
  sweep();
  return (pending.get(cycleId) ?? []).length;
}

/** Test seam — the map is module state and a test must be able to start clean. */
export function _resetSteers(): void {
  pending.clear();
  clock = () => Date.now();
}
