/**
 * Messages that arrive while an agent is busy wait their turn instead of being dropped.
 *
 * Until 2026-09-29 a message sent to an agent mid-turn got "Still working on the previous
 * request — one moment." and was thrown away: runCycle refuses a second turn, and the chat
 * handler only said so. With delegated runs an agent can hold its turn for minutes, so this
 * was the common case, not an edge (stage 57 phase 5; Hermes' /background and /queue exist
 * for the same reason).
 *
 * The next queued turn starts the moment the agent's slot frees (AgentService announces it),
 * not on a poll. If something else takes the slot first — a timer, a woken run — the turn is
 * refused as busy and goes back to the front. In memory only: a restart loses what is
 * queued, which is why the chat says a message is queued rather than implying it is safe.
 */
import { logger } from '../logger.js';

export interface QueuedTurn {
  agentId: string;
  /** Start the turn. Rejects with "already running" when the slot was taken first. */
  start: () => Promise<unknown>;
  /** Short text for logs. */
  label: string;
}

export type Enqueued =
  | { ok: true; position: number }
  | { ok: false; reason: string };

export const MAX_QUEUED_PER_AGENT = 5;

const isBusyError = (err: unknown) =>
  /already running/i.test(String((err as Error)?.message ?? err));

export class ChatQueue {
  private readonly queues = new Map<string, QueuedTurn[]>();

  constructor(
    private readonly isBusy: (agentId: string) => boolean,
    private readonly max = MAX_QUEUED_PER_AGENT,
  ) {}

  size(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /** Should a new message wait? Yes when the agent is mid-turn, or others are already waiting (FIFO). */
  mustWait(agentId: string): boolean {
    return this.isBusy(agentId) || this.size(agentId) > 0;
  }

  enqueue(turn: QueuedTurn): Enqueued {
    const list = this.queues.get(turn.agentId) ?? [];
    if (list.length >= this.max) {
      return {
        ok: false,
        reason: `${list.length} requests are already waiting for this agent`,
      };
    }
    list.push(turn);
    this.queues.set(turn.agentId, list);
    logger.info(
      { agentId: turn.agentId, position: list.length, label: turn.label },
      'chat turn queued — agent busy',
    );
    // The agent may have come free between the caller's check and now.
    if (!this.isBusy(turn.agentId))
      queueMicrotask(() => this.onFree(turn.agentId));
    return { ok: true, position: list.length };
  }

  /** The agent's slot is free: start the next waiting turn. */
  onFree(agentId: string): void {
    const list = this.queues.get(agentId);
    if (!list?.length || this.isBusy(agentId)) return;
    const next = list.shift()!;
    if (!list.length) this.queues.delete(agentId);
    logger.info(
      { agentId, label: next.label, remaining: list.length },
      'starting queued chat turn',
    );
    next.start().catch((err) => {
      if (isBusyError(err)) {
        // Something else took the slot first; wait for it to free again, still first in line.
        const again = this.queues.get(agentId) ?? [];
        again.unshift(next);
        this.queues.set(agentId, again);
        return;
      }
      logger.warn(
        {
          agentId,
          label: next.label,
          err: String((err as Error)?.message ?? err),
        },
        'queued chat turn failed',
      );
    });
  }
}
