/**
 * Stage 64 phase 1 — reach the owner where they are, and take their answer there.
 *
 * Measured 2026-09-30: approvals waited a median of 19 hours (p90 60 h) because the
 * dashboard was the only place to answer one. This queues each thing that needs the owner,
 * sends it to their phone (one message, or a digest when several are waiting), and applies
 * the reply through the same code path as the dashboard button.
 *
 * Transport-agnostic: WhatsApp specifics live in ./whatsapp-delivery.ts, so this file is
 * testable with a fake transport and an in-memory DB.
 */
import {
  createOwnerPrompt,
  getAgent,
  getCheckinById,
  getEscalationApproval,
  getOpenOwnerPromptByRef,
  getOpenOwnerPrompts,
  getOwnerPrompt,
  getOwnerPromptByWaMsgId,
  getOwnersWithQueuedPrompts,
  getSentOwnerPrompts,
  hasRecentOwnerPrompt,
  getUserNotifyPrefs,
  markOwnerPromptsSent,
  settleOwnerPrompt,
  updateOwnerPromptWaId,
  type OwnerPrompt,
} from '../db.js';
import type { AgentCheckin } from '../types.js';
import { logger } from '../logger.js';
import {
  formatDigest,
  formatSingle,
  isQuietNow,
  parseOwnerReply,
  toCheckinReply,
  toEscalationDecision,
  isQuestion,
  startsWithDecisionWord,
  buttonsFor,
  type PromptView,
} from './format.js';

/** Where one owner's messages go, and which account sends them. */
export interface DeliveryTarget {
  /** Which channel carries it. Telegram is preferred when the owner linked it. */
  channel: 'whatsapp' | 'telegram';
  /** WhatsApp: the user id whose linked session sends. Telegram: the bot. */
  sendAs: string;
  /** The chat to send to (a WhatsApp JID, or a Telegram chat id). */
  toJid: string;
  /** Sending to yourself — delivered, but your phone doesn't ring for it. */
  selfChat: boolean;
}

/** Tap-to-answer buttons, one array per row. `data` is sent back as if the owner typed it. */
export type ButtonRows = Array<Array<{ label: string; data: string }>>;

export interface OwnerTransport {
  /** Null when there is no working route to this owner right now. */
  resolveTarget(ownerId: string): DeliveryTarget | null;
  /** Returns the sent message id, or null when the send failed. Buttons are dropped where unsupported. */
  send(
    target: DeliveryTarget,
    text: string,
    buttons?: ButtonRows,
  ): Promise<string | null>;
}

export interface NotifierDeps {
  transport: OwnerTransport;
  /** Same path as the dashboard's respond route. */
  answerCheckin(
    agentId: string,
    checkinId: string,
    reply: string,
  ): Promise<'ok' | 'already' | 'not_found'>;
  /** Same path as the dashboard's escalation buttons. False = expired or already settled. */
  answerEscalation(
    approvalId: string,
    decision: 'approved' | 'denied',
  ): boolean;
  /** Desktop fallback: a native notification wherever the dashboard is open. */
  emitDesktop?(ownerId: string, n: { title: string; body: string }): void;
  /** The dashboard page where every waiting thing can be answered. */
  link: string | null;
  /** An agent's page — where a failed run is looked into (a notice has nothing to answer). */
  agentLink?: (agentId: string) => string;
  timeZone: string;
  now?: () => number;
}

/** Wait this long before sending, so a "don't ask" rule or a dashboard click can settle it. */
export const SETTLE_MS = 8_000;
/** A failing agent tells the owner once in this window, not on every failed run. */
export const INFO_PER_AGENT_WINDOW_MS = 60 * 60_000;
/** At most one message per owner in this window; anything that queues meanwhile is digested. */
export const MIN_GAP_MS = 2 * 60_000;
/** A prompt that never found a route in this long is dropped (the dashboard still has it). */
const QUEUED_MAX_AGE_MS = 24 * 60 * 60_000;
const FLUSH_EVERY_MS = 10_000;

export class OwnerNotifier {
  private lastSentAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly deps: NotifierDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ─── Queueing ───────────────────────────────────────────────────────────────────

  /** The owner of an agent who wants WhatsApp and has a route — else null. */
  private ownerFor(agentId: string | null | undefined): string | null {
    if (!agentId) return null;
    const ownerId = getAgent(agentId)?.owner_id ?? null;
    if (!ownerId) return null;
    if (!getUserNotifyPrefs(ownerId).whatsapp) return null;
    if (!this.deps.transport.resolveTarget(ownerId)) return null;
    return ownerId;
  }

  private schedule(): void {
    const t = setTimeout(() => {
      void this.flush();
    }, SETTLE_MS + 500);
    t.unref?.();
  }

  enqueueCheckin(checkin: AgentCheckin): void {
    if (checkin.status !== 'pending') return;
    const ownerId = this.ownerFor(checkin.agent_id);
    if (!ownerId) return;
    if (getOpenOwnerPromptByRef('checkin', checkin.id)) return;
    createOwnerPrompt({
      owner_id: ownerId,
      agent_id: checkin.agent_id,
      kind: 'checkin',
      ref_id: checkin.id,
    });
    this.schedule();
  }

  enqueueEscalation(approvalId: string, agentId: string): void {
    const ownerId = this.ownerFor(agentId);
    if (!ownerId) return;
    if (getOpenOwnerPromptByRef('escalation', approvalId)) return;
    createOwnerPrompt({
      owner_id: ownerId,
      agent_id: agentId,
      kind: 'escalation',
      ref_id: approvalId,
    });
    this.schedule();
  }

  enqueueInfo(agentId: string, text: string): void {
    const ownerId = this.ownerFor(agentId);
    if (!ownerId) return;
    // One failure notice per agent per hour. On 2026-09-30 two benchmark agents failing
    // on the same dead fallback chain sent three in ten minutes.
    const since = new Date(this.now() - INFO_PER_AGENT_WINDOW_MS).toISOString();
    if (hasRecentOwnerPrompt(agentId, 'info', since)) return;
    createOwnerPrompt({
      owner_id: ownerId,
      agent_id: agentId,
      kind: 'info',
      body: text.slice(0, 600),
    });
    this.schedule();
  }

  // ─── Building what the owner reads ──────────────────────────────────────────────

  /** Null when the thing it points at is gone or already settled — close it, don't send. */
  private view(p: OwnerPrompt): PromptView | null {
    const agentName =
      (p.agent_id ? getAgent(p.agent_id)?.name : null) ?? 'An agent';
    if (p.kind === 'info') {
      return {
        code: p.code,
        kind: 'info',
        agentName,
        actionType: null,
        payload: null,
        text: p.body ?? '',
      };
    }
    if (p.kind === 'checkin') {
      const c = p.ref_id ? getCheckinById(p.ref_id) : undefined;
      if (!c || c.status !== 'pending') return null;
      let payload: Record<string, unknown> | null = null;
      try {
        payload = c.action_payload ? JSON.parse(c.action_payload) : null;
      } catch {
        /* leave null */
      }
      return {
        code: p.code,
        kind: 'checkin',
        agentName,
        actionType: c.action_type ?? null,
        payload,
        text: c.report_md ?? '',
      };
    }
    const e = p.ref_id ? getEscalationApproval(p.ref_id) : undefined;
    if (!e || e.status !== 'pending') return null;
    let step: Record<string, unknown> | null = null;
    try {
      step = JSON.parse(e.step);
    } catch {
      /* leave null */
    }
    const what =
      (typeof step?.description === 'string' && step.description) ||
      [step?.action, step?.target ?? step?.url]
        .filter((x) => typeof x === 'string' && x)
        .join(' ') ||
      'a step it flagged as risky';
    return {
      code: p.code,
      kind: 'escalation',
      agentName,
      actionType: null,
      payload: step,
      text: String(what),
    };
  }

  // ─── Sending ────────────────────────────────────────────────────────────────────

  /** One pass: every owner with something queued gets at most one message. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // Answered on the dashboard after it went to the phone: close it here too, so a
      // later "1" is not read as an answer to it and the open list stays true.
      for (const p of getSentOwnerPrompts()) {
        if (!this.view(p)) settleOwnerPrompt(p.id, 'closed');
      }
      for (const ownerId of getOwnersWithQueuedPrompts()) {
        try {
          await this.flushOwner(ownerId);
        } catch (err) {
          logger.warn(
            { err: String(err), ownerId },
            'owner-notify: flush failed for owner',
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async flushOwner(ownerId: string): Promise<void> {
    const now = this.now();
    const queued = getOpenOwnerPrompts(ownerId).filter(
      (p) => p.status === 'queued',
    );

    const target = this.deps.transport.resolveTarget(ownerId);
    const prefs = getUserNotifyPrefs(ownerId);
    if (!target || !prefs.whatsapp) {
      // No route. Drop what has waited too long; the dashboard still holds all of it.
      for (const p of queued) {
        if (now - Date.parse(p.created_at) > QUEUED_MAX_AGE_MS)
          settleOwnerPrompt(p.id, 'closed');
      }
      return;
    }
    if (isQuietNow(prefs, new Date(now), this.deps.timeZone)) return;
    if (now - (this.lastSentAt.get(ownerId) ?? 0) < MIN_GAP_MS) return;

    const ready: Array<{ p: OwnerPrompt; v: PromptView }> = [];
    for (const p of queued) {
      if (now - Date.parse(p.created_at) < SETTLE_MS) continue;
      const v = this.view(p);
      if (!v) {
        settleOwnerPrompt(p.id, 'closed');
        continue;
      }
      ready.push({ p, v });
    }
    if (ready.length === 0) return;

    const only = ready.length === 1 ? ready[0] : null;
    const link =
      only && only.p.kind === 'info' && only.p.agent_id && this.deps.agentLink
        ? this.deps.agentLink(only.p.agent_id)
        : this.deps.link;
    const text = only
      ? formatSingle(only.v, link)
      : formatDigest(
          ready.map((r) => r.v),
          link,
        );
    const msgId = await this.deps.transport.send(
      target,
      text,
      buttonsFor(ready.map((r) => r.v)),
    );
    if (!msgId) {
      logger.warn(
        { ownerId, count: ready.length },
        'owner-notify: send failed — will retry',
      );
      return;
    }
    this.lastSentAt.set(ownerId, now);
    markOwnerPromptsSent(
      ready.map((r) => r.p.id),
      msgId,
    );
    // A notice has nothing to answer — it is done once delivered.
    for (const r of ready)
      if (r.p.kind === 'info') settleOwnerPrompt(r.p.id, 'closed');

    if (this.deps.emitDesktop) {
      const title =
        ready.length === 1
          ? `${ready[0].v.agentName} needs you`
          : `${ready.length} things need you`;
      const body = ready
        .map(
          (r) =>
            `${r.v.agentName}: ${r.v.text.replace(/\s+/g, ' ').slice(0, 80)}`,
        )
        .join('\n');
      try {
        this.deps.emitDesktop(ownerId, { title, body });
      } catch {
        /* best effort */
      }
    }
    logger.info(
      { ownerId, count: ready.length, selfChat: target.selfChat },
      'owner-notify: sent',
    );
  }

  // ─── Replies ────────────────────────────────────────────────────────────────────

  /**
   * A message from the owner on the route this notifier uses. True when it was an answer
   * (handled and acknowledged here); false when it was something else and the normal
   * WhatsApp handling should see it.
   */
  async handleReply(
    ownerId: string,
    text: string,
    quotedWaMsgId: string | null,
  ): Promise<boolean> {
    const target = this.deps.transport.resolveTarget(ownerId);
    if (!target) return false;
    const open = getOpenOwnerPrompts(ownerId).filter(
      (p) => p.status === 'sent',
    );
    const quote = quotedWaMsgId
      ? {
          waMsgId: quotedWaMsgId,
          isOurs: !!getOwnerPromptByWaMsgId(ownerId, quotedWaMsgId),
        }
      : null;
    const parsed = parseOwnerReply(
      text,
      quote,
      open.map((p) => ({
        id: p.id,
        code: p.code,
        kind: p.kind,
        actionType: null,
        waMsgId: p.wa_msg_id,
        sentAt: p.sent_at ? Date.parse(p.sent_at) : null,
      })),
      // A separate notifier number's chat exists only for this; a self-chat is also a notepad.
      { dedicated: !target.selfChat, now: this.now() },
    );
    if (!parsed) return false;

    const ack = (t: string) => this.deps.transport.send(target, t);

    if (parsed.type === 'ambiguous') {
      await ack(
        `Several things are waiting (${parsed.codes.join(', ')}). Start your reply with the code, e.g. *${parsed.codes[0]} 1*.`,
      );
      return true;
    }
    if (parsed.type === 'stale') {
      await ack('That one is already settled — nothing more to do.');
      return true;
    }

    const p = getOwnerPrompt(parsed.promptId);
    if (!p) return false;
    const v = this.view(p);
    if (!v) {
      settleOwnerPrompt(p.id, 'closed');
      await ack(`*${p.code}* was already answered or has expired.`);
      return true;
    }

    // The code alone: show the whole thing, and make that message the one a quote points at.
    if (!parsed.answer) {
      const id = await this.deps.transport.send(
        target,
        formatSingle(v, this.deps.link),
        buttonsFor([v]),
      );
      // A quote of this new message should find the prompt, not the old digest.
      if (id) updateOwnerPromptWaId(p.id, id);
      return true;
    }

    // Free text tied to nothing but timing may be a note that happens to start with
    // "yes". It can answer a question or pass a comment on — never approve or reject.
    const loose = parsed.via === 'text';
    const decisionHint =
      p.kind === 'escalation'
        ? `To answer *${p.code}*: reply just *1* to allow or *2* to block.`
        : `To answer *${p.code}*: reply just *1* to ${v.actionType === 'send_email' ? 'send' : 'approve'} or *2* to ${v.actionType === 'send_email' ? 'skip' : 'reject'} — or start with *${p.code}* to add a note.`;
    if (
      loose &&
      !isQuestion(v) &&
      (p.kind === 'escalation' || startsWithDecisionWord(parsed.answer))
    ) {
      await ack(decisionHint);
      return true;
    }

    if (p.kind === 'escalation') {
      const decision = toEscalationDecision(parsed.answer);
      if (!decision) {
        await ack(decisionHint);
        return true;
      }
      const ok = p.ref_id
        ? this.deps.answerEscalation(p.ref_id, decision)
        : false;
      settleOwnerPrompt(p.id, ok ? 'answered' : 'closed', decision);
      await ack(
        ok
          ? `✓ *${p.code}* ${decision === 'approved' ? 'allowed' : 'blocked'} — ${v.agentName} carries on.`
          : `*${p.code}* expired or was already answered.`,
      );
      return true;
    }

    // A check-in.
    const reply = toCheckinReply(v, parsed.answer);
    const result =
      p.agent_id && p.ref_id
        ? await this.deps.answerCheckin(p.agent_id, p.ref_id, reply)
        : 'not_found';
    if (result !== 'ok') {
      settleOwnerPrompt(p.id, 'closed');
      await ack(
        result === 'already'
          ? `*${p.code}* was already answered on the dashboard.`
          : `*${p.code}* no longer exists.`,
      );
      return true;
    }
    settleOwnerPrompt(p.id, 'answered', reply);
    let msg: string;
    if (isQuestion(v)) msg = `✓ Sent your answer to ${v.agentName}.`;
    else if (reply.startsWith('approve'))
      msg = `✓ *${p.code}* approved — ${v.agentName} goes ahead.`;
    else if (reply.startsWith('reject'))
      msg = `✓ *${p.code}* rejected — ${v.agentName} won't do it${reply.length > 'reject'.length ? ' and will revise' : ''}.`;
    else
      msg = `✓ Passed your note on *${p.code}* to ${v.agentName}. It will reply before doing anything.`;
    await ack(msg);
    return true;
  }
}
