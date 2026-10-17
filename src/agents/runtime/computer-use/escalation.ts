/**
 * Human escalation gate for dangerous browser actions.
 *
 * When a step matches a dangerous pattern, execution is paused and an approval
 * is requested. The operator approves or denies via API. If no response arrives
 * within the timeout, the action is auto-denied.
 *
 * Dangerous patterns (always require approval):
 *   - URL contains: /delete, /remove, /cancel, /close-account, /confirm-delete
 *   - Target contains: delete, remove, cancel, submit, send, pay, confirm, buy
 *   - Action is 'click' and step.isExternal is true
 */
import { randomUUID } from 'node:crypto';
import { globalEventBus } from '../event-bus.js';
import { appendConversationEvent } from '../../../conversation-events.js';
import { notify } from '../../../notifications.js';
import {
  getAgent,
  insertEscalationApproval,
  decideEscalationApproval,
  getPendingEscalationApprovals,
  getEscalationApproval,
} from '../../../db.js';
import { logger } from '../../../logger.js';
import type { ApprovalRequestMeta } from '../../../types.js';
import type { Step } from './types.js';
import type { Server as SocketIOServer } from 'socket.io';

let _io: SocketIOServer | null = null;
export function setEscalationSocketIO(io: SocketIOServer): void {
  _io = io;
}

export type ApprovalDecision = 'approved' | 'denied';

interface PendingApproval {
  id: string;
  agentId: string;
  runId: string;
  step: Step;
  createdAt: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  // Set by resolveApproval, read by getApprovalDecision — the in-process Promise
  // (`resolve`/await) serves the TS-side /run route's own sandbox; an externally
  // created approval (createPendingApproval, below) has no in-process waiter to
  // resume, since the caller is a different process (the agent's own container) —
  // it polls this field instead.
  decision: ApprovalDecision | null;
  // True for createPendingApproval entries — resolveApproval uses this to decide
  // whether it's safe to delete the entry immediately (an in-process waiter needs
  // nothing further once resolved) or must leave it for getApprovalDecision's poll
  // to observe and clean up itself.
  isExternal: boolean;
}

// In-memory map of pending approvals — keyed by approval ID
const pending = new Map<string, PendingApproval>();

// How long an agent stays blocked before the gate gives up and treats the step as
// denied. Five minutes was right when the only caller was the TS /run route with a
// human watching a live sandbox; it is far too short for a scheduled agent that
// escalates at 3am, where the ask would expire long before anyone saw it. The
// Python side (escalation.py's _MAX_WAIT_S) polls for this plus a margin, so the
// two must be changed together.
const APPROVAL_TIMEOUT_MS = Number(
  process.env.APPROVAL_TIMEOUT_MS ?? 30 * 60 * 1000,
); // 30 minutes

const DANGER_URL_PATTERNS =
  /\/delete|\/remove|\/cancel|\/close-account|\/confirm-delete|\/unsubscribe/i;
const DANGER_TEXT_PATTERNS =
  /delete|remove|deactivate|cancel.account|unsubscribe|send.email|post.tweet/i;

/** Detect whether a step should trigger the escalation gate. */
export function isDangerous(step: Step): boolean {
  // Explicit caller override — always escalate
  if (step.isDangerous === true) return true;

  if (!step.isExternal) return false;

  if (step.url && DANGER_URL_PATTERNS.test(step.url)) return true;

  if (step.action === 'click' && step.target) {
    if (DANGER_TEXT_PATTERNS.test(step.target)) return true;
  }

  if (step.action === 'type' && step.text) {
    // Suspicious if typing into a payment field
    if (/card.number|cvv|credit.card/i.test(step.target ?? '')) return true;
  }

  return false;
}

/**
 * Request human approval for a dangerous step.
 * Returns 'approved' or 'denied'. Auto-denies after APPROVAL_TIMEOUT_MS.
 */
export function requestApproval(
  step: Step,
  agentId: string,
  runId: string,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const id = randomUUID();

    const timer = setTimeout(() => {
      const a = pending.get(id);
      if (a) {
        pending.delete(id);
        _settleRow(id, 'expired', 'timeout');
        _appendApprovalEvent(a, 'expired');
        resolve('denied');
      }
    }, APPROVAL_TIMEOUT_MS);

    const approval: PendingApproval = {
      id,
      agentId,
      runId,
      step,
      createdAt: new Date().toISOString(),
      resolve,
      timer,
      decision: null,
      isExternal: false,
    };

    pending.set(id, approval);
    _notifyCreated(approval);
  });
}

/**
 * Create a pending approval for a caller in a DIFFERENT process — the agent's own
 * Python container (Effector), which has no in-process Promise to await. The
 * caller polls getApprovalDecision(id) instead of awaiting a return value here.
 * Same pending map, same timeout, same dashboard notification as requestApproval
 * — the only difference is who's waiting and how.
 */
export function createPendingApproval(
  step: Step,
  agentId: string,
  runId: string,
): { id: string; createdAt: string } {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  const timer = setTimeout(() => {
    const a = pending.get(id);
    if (a && a.decision === null) {
      a.decision = 'denied';
      // No in-process waiter to resolve() for an externally created approval —
      // the poller (getApprovalDecision) is what observes this, so leave the
      // entry in place until read rather than deleting it out from under a poll
      // that hasn't happened yet. A later resolveApproval on an expired id is a
      // harmless no-op (decision already set, pending.delete already effectively
      // final from the caller's perspective).
      //
      // The card still has to stop offering buttons for an ask nobody can answer
      // any more, so the event is updated here even though the map entry lingers
      // until the poller reads it.
      _settleRow(id, 'expired', 'timeout');
      _appendApprovalEvent(a, 'expired');
    }
  }, APPROVAL_TIMEOUT_MS);

  const approval: PendingApproval = {
    id,
    agentId,
    runId,
    step,
    createdAt,
    resolve: () => {
      /* no in-process waiter for an externally created approval */
    },
    timer,
    decision: null,
    isExternal: true,
  };

  pending.set(id, approval);
  _notifyCreated(approval);
  return { id, createdAt };
}

/** Poll result for an externally created approval. */
export type ApprovalPollResult =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'not_found';

/** Read the current decision for an approval without resolving/removing it —
 * the Python-side caller polls this until it stops returning 'pending'. */
export function getApprovalDecision(approvalId: string): ApprovalPollResult {
  const approval = pending.get(approvalId);
  if (!approval) {
    // Not in memory: either genuinely unknown, or settled by a path that already
    // cleaned up (an earlier poll, or a restart that expired it). The durable row
    // is what distinguishes those, and getting it wrong matters — 'not_found' tells
    // the waiting agent to stop and treat the step as denied, so an approval the
    // operator actually granted must not read as not_found just because this
    // process no longer holds it in memory.
    try {
      const row = getEscalationApproval(approvalId);
      if (!row) return 'not_found';
      if (row.status === 'pending') return 'pending';
      return row.status === 'approved' ? 'approved' : 'denied';
    } catch (err) {
      logger.error({ err, approvalId }, 'escalation approval lookup failed');
      return 'not_found';
    }
  }
  if (approval.decision === null) return 'pending';
  // Now that the poller has observed the terminal decision, the entry has served
  // its purpose — clean it up so `pending` doesn't accumulate resolved/expired
  // externally created approvals the dashboard's listPendingApprovals would
  // otherwise keep showing as live.
  clearTimeout(approval.timer);
  pending.delete(approvalId);
  return approval.decision;
}

/**
 * The conversation this approval belongs in, and the stable event id within it.
 *
 * The id is derived from the approval id rather than random so that resolving the
 * approval can re-append the SAME logical event and have insertConversationEvent
 * update it in place — that is what makes the card flip from buttons to a verdict
 * instead of a second card appearing below the first.
 */
function _conversationFor(agentId: string): string {
  return `agent:${agentId}`;
}
function _eventIdFor(approvalId: string): string {
  return `ce-approval-${approvalId}`;
}

function _approvalMeta(
  approval: PendingApproval,
  decision?: 'approved' | 'denied' | 'expired',
): string {
  const meta: ApprovalRequestMeta = {
    approval_id: approval.id,
    action: approval.step.action,
    target: approval.step.target,
    url: approval.step.url,
    element: approval.step.description,
    run_id: approval.runId,
    timeout_ms: APPROVAL_TIMEOUT_MS,
    ...(decision ? { decision, decided_at: new Date().toISOString() } : {}),
  };
  return JSON.stringify(meta);
}

/**
 * Write the ask into the agent's conversation log, where the chat renders it inline
 * at the point the agent stopped. This is the surface that makes the gate feel like
 * a real HITL prompt rather than a notice on a page nobody has open: the agent is
 * blocked on this exact event, and answering it here resumes the cycle.
 */
function _appendApprovalEvent(
  approval: PendingApproval,
  decision?: 'approved' | 'denied' | 'expired',
): void {
  appendConversationEvent(
    _conversationFor(approval.agentId),
    {
      type: 'approval_request',
      cycle_id:
        approval.runId && approval.runId !== 'unknown'
          ? approval.runId
          : undefined,
      role: 'assistant',
      content:
        approval.step.description ??
        `${approval.step.action} ${approval.step.target ?? approval.step.url ?? ''}`.trim(),
      tool_name: 'effector',
      tool_input: JSON.stringify(approval.step),
      // A settled gate is not an error even when denied — the agent asked, a human
      // answered, and the cycle carries on. 'interrupted' is reserved for the case
      // where nobody answered at all.
      status: decision === 'expired' ? 'interrupted' : 'ok',
      metadata: _approvalMeta(approval, decision),
    },
    _eventIdFor(approval.id),
  );
}

function _notifyCreated(approval: PendingApproval): void {
  // Durable first, before any notification goes out. An operator who sees the ask
  // must be able to answer it, and answering reads this row — so a notification
  // that raced ahead of the write would advertise a button that 404s.
  try {
    insertEscalationApproval({
      id: approval.id,
      agent_id: approval.agentId,
      run_id: approval.runId,
      step: JSON.stringify(approval.step),
      timeout_ms: APPROVAL_TIMEOUT_MS,
      created_at: approval.createdAt,
    });
  } catch (err) {
    // Losing durability is bad but not worth failing the gate over: the in-memory
    // path still works for as long as this process lives, which is the same
    // behaviour as before this table existed.
    logger.error(
      { err, approvalId: approval.id },
      'escalation approval persist failed',
    );
  }

  // Notify dashboard via socket so badge updates immediately
  _io?.emit('computer_use:escalation_created', {
    id: approval.id,
    agentId: approval.agentId,
    runId: approval.runId,
    step: approval.step,
    createdAt: approval.createdAt,
  });

  // Notify operator via event bus — dashboard picks this up
  globalEventBus.emit_agent({
    type: 'tool_start',
    toolName: 'computer_use_escalation',
    args: {
      approvalId: approval.id,
      agentId: approval.agentId,
      runId: approval.runId,
      step: approval.step.step,
      action: approval.step.action,
      target: approval.step.target,
      description:
        approval.step.description ??
        `${approval.step.action} ${approval.step.target ?? approval.step.url ?? ''}`,
      timeoutMs: APPROVAL_TIMEOUT_MS,
    },
  });

  // The inline prompt in the agent's own chat — the surface the operator actually
  // watches, and where answering resumes the blocked cycle.
  _appendApprovalEvent(approval);

  // And the bell, for when that chat isn't open. Without this the ask was only
  // discoverable by having the right page in the foreground at the right moment,
  // which is how escalations went unanswered and silently auto-denied.
  try {
    const agent = getAgent(approval.agentId);
    const what =
      approval.step.description ??
      `${approval.step.action} ${approval.step.target ?? approval.step.url ?? ''}`.trim();
    notify(
      'approval_required',
      `${agent?.name ?? 'An agent'} needs approval`,
      what,
      approval.agentId,
      {
        approvalId: approval.id,
        runId: approval.runId,
        timeoutMs: APPROVAL_TIMEOUT_MS,
      },
    );
  } catch (err) {
    // A failed notification must never block the gate — the agent is waiting on
    // this call to return so it can start polling.
    logger.warn(
      { err, approvalId: approval.id },
      'approval notification failed',
    );
  }
}

/**
 * Rebuild the in-memory shape from a durable row, for the paths that only have the
 * row (a resolve or a restore after the map entry is gone). `timer` is a no-op
 * placeholder these callers never arm — only the restore path installs a real one.
 */
function _approvalFromRow(
  row: {
    id: string;
    agent_id: string;
    run_id: string | null;
    step: string;
    created_at: string;
  },
  decision: ApprovalDecision | null = null,
): PendingApproval {
  const noop = setTimeout(() => {
    /* never armed */
  }, 0);
  clearTimeout(noop);
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id ?? 'unknown',
    step: JSON.parse(row.step) as Step,
    createdAt: row.created_at,
    resolve: () => {
      /* the original in-process waiter, if any, is gone */
    },
    timer: noop,
    decision,
    isExternal: true,
  };
}

/** Mark the durable row settled; a failure here must never block the waiting agent. */
function _settleRow(
  id: string,
  status: 'approved' | 'denied' | 'expired',
  by: string,
): void {
  try {
    decideEscalationApproval(id, status, by);
  } catch (err) {
    logger.error(
      { err, approvalId: id, status },
      'escalation approval settle failed',
    );
  }
}

/** Resolve a pending approval (called from API route). */
export function resolveApproval(
  approvalId: string,
  decision: ApprovalDecision,
): boolean {
  const approval = pending.get(approvalId);
  if (!approval) {
    // Gone from memory but still answerable on disk — the poller may have observed
    // and evicted it between the operator loading the card and clicking it. Settle
    // the row so the click isn't silently lost; the guard inside
    // decideEscalationApproval keeps an already-settled row from being overwritten.
    try {
      if (!decideEscalationApproval(approvalId, decision, 'operator'))
        return false;
      const row = getEscalationApproval(approvalId);
      if (row) _appendApprovalEvent(_approvalFromRow(row, decision), decision);
      return true;
    } catch (err) {
      logger.error(
        { err, approvalId },
        'escalation approval resolve-from-row failed',
      );
      return false;
    }
  }

  approval.decision = decision;
  clearTimeout(approval.timer);
  approval.resolve(decision);
  // In-process waiters (requestApproval) are done the moment resolve() fires, so
  // it's safe to remove them now. Externally created ones stay until
  // getApprovalDecision's poll observes the decision and cleans up itself — an
  // eager delete here would make that poll see 'not_found' and misreport a
  // resolved approval as expired.
  if (!approval.isExternal) pending.delete(approvalId);

  globalEventBus.emit_agent({
    type: 'tool_end',
    toolName: 'computer_use_escalation',
    result: { approvalId, decision },
    durationMs: Date.now() - new Date(approval.createdAt).getTime(),
  });

  _settleRow(approvalId, decision, 'operator');

  // Re-append under the same event id so the inline card flips to a verdict in
  // place, in every tab, and the transcript keeps a permanent record of what was
  // decided rather than the ask simply vanishing.
  _appendApprovalEvent(approval, decision);

  return true;
}

/**
 * Rebuild the in-memory map from the durable table, called once at startup.
 *
 * Without this, an orchestrator restart mid-wait stranded the request: the card
 * stayed on screen with a live countdown because the conversation event is in
 * SQLite, but its buttons 404'd against an empty map and the blocked agent polled
 * until it gave up and denied. The row is the authority, so a restart can pick the
 * ask back up and the operator's click still lands.
 *
 * Rows whose deadline already passed while the process was down are settled as
 * expired rather than revived — reviving them would restart a countdown the agent
 * has long since abandoned, showing a button that can no longer affect anything.
 *
 * Only externally created approvals are restorable. An in-process one (the TS /run
 * route) had a Promise waiting on it, and that caller died with the old process —
 * there is nothing left to resume, so those rows are expired too.
 */
export function restorePendingApprovals(): {
  restored: number;
  expired: number;
} {
  let restored = 0;
  let expired = 0;

  let rows: ReturnType<typeof getPendingEscalationApprovals>;
  try {
    rows = getPendingEscalationApprovals();
  } catch (err) {
    logger.error({ err }, 'could not read pending escalation approvals');
    return { restored: 0, expired: 0 };
  }

  for (const row of rows) {
    const elapsed = Date.now() - new Date(row.created_at).getTime();
    const msLeft = row.timeout_ms - elapsed;

    let approval: PendingApproval;
    try {
      approval = _approvalFromRow(row);
    } catch {
      // Unparseable step — nothing a human could meaningfully be asked about.
      _settleRow(row.id, 'expired', 'restore');
      expired += 1;
      continue;
    }

    if (msLeft <= 0) {
      _settleRow(row.id, 'expired', 'restore');
      // Flip the card to a verdict so it stops offering buttons for a dead ask.
      _appendApprovalEvent(approval, 'expired');
      expired += 1;
      continue;
    }

    approval.timer = setTimeout(() => {
      const a = pending.get(row.id);
      if (a && a.decision === null) {
        a.decision = 'denied';
        _settleRow(row.id, 'expired', 'timeout');
        _appendApprovalEvent(a, 'expired');
      }
    }, msLeft);

    pending.set(row.id, approval);
    restored += 1;
  }

  if (restored || expired) {
    logger.info({ restored, expired }, 'restored pending escalation approvals');
  }
  return { restored, expired };
}

/** List all pending approvals (for operator dashboard). */
export function listPendingApprovals(): Array<
  Omit<PendingApproval, 'resolve' | 'timer' | 'isExternal'>
> {
  return [...pending.values()].map(
    ({ id, agentId, runId, step, createdAt, decision }) => ({
      id,
      agentId,
      runId,
      step,
      createdAt,
      decision,
    }),
  );
}
