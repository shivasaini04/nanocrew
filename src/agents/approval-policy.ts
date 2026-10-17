/**
 * Per-agent approval rules — the owner's standing answers to "may I do this without asking?".
 *
 * Every approval an agent can raise used to be all-or-nothing and platform-wide: 154 outreach
 * emails in 45 days, each waiting on a click, with no way to say "emails to me don't need
 * asking" or "risky steps on linkedin.com are fine for this agent". Rules live on the agent
 * (config.approvalRules) and are checked at the few places an approval is created:
 *
 *   - POST /:id/checkins        — emails, batch sends, agent creation raised from a cycle
 *   - computer-use-escalation   — a risky browser/desktop step
 *   - the self-management routes that hold a change for the owner (budget past its ceiling,
 *     a large identity deletion, …)
 *
 * No rule means "ask", which is exactly the old behaviour. Two things are never auto:
 * credential requests (the owner consents to a bill or a mailbox, not the agent) and changes
 * to these rules themselves (see the approvals route for how "stop asking me" from a chat
 * turn is handled).
 */
import { randomUUID } from 'crypto';

import type { ApprovalAction, ApprovalRule } from '../types.js';
export type { ApprovalAction, ApprovalRule };

export type ApprovalScope = 'recipient' | 'site' | null;

/** What each action is, in the owner's words — the Approvals tab and the agent both read this. */
export const APPROVAL_ACTIONS: Record<
  ApprovalAction,
  { label: string; desc: string; scope: ApprovalScope }
> = {
  email: {
    label: 'Send an email',
    desc: 'An email drafted by the agent (outreach, reports, replies).',
    scope: 'recipient',
  },
  batch_send: {
    label: 'Send a batch of messages',
    desc: 'A list of messages sent from your own browser, e.g. LinkedIn invites.',
    scope: null,
  },
  browser_step: {
    label: 'Risky browser/computer step',
    desc: 'A click or keypress the agent flags as risky: submitting, buying, deleting, posting.',
    scope: 'site',
  },
  create_agent: {
    label: 'Create a new agent',
    desc: 'Hiring another agent (the Recruiter does this).',
    scope: null,
  },
  budget_raise: {
    label: 'Raise its budget past the ceiling',
    desc: 'Spending more than its self-service ceiling allows.',
    scope: null,
  },
  tool_grant: {
    label: 'Give itself an outbound tool',
    desc: 'Email, WhatsApp or voice tools that reach people outside the system.',
    scope: null,
  },
  identity_rewrite: {
    label: 'Delete much of its instructions',
    desc: 'An edit that removes over 30% of its goals/role/instructions.',
    scope: null,
  },
  tracker_stage_delete: {
    label: 'Remove a tracker stage with data',
    desc: 'Dropping a pipeline stage that still holds rows.',
    scope: null,
  },
  sweep_gate_off: {
    label: 'Switch off a sweep safety check',
    desc: 'E.g. "record results before searching again".',
    scope: null,
  },
  reach_setting: {
    label: 'Use your browser or an outbound webhook',
    desc: 'Turning on your logged-in browser, or posting its events to an outside URL.',
    scope: null,
  },
};

export interface ApprovalContext {
  /** Comma-separated addresses, as a draft's `to` carries them. */
  recipient?: string;
  /** A URL or host the step happens on. */
  site?: string;
}

/** Why a rule cannot be stored, or null. */
export function validateRule(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'A rule must be an object';
  const rule = r as Partial<ApprovalRule>;
  if (!rule.action || !(rule.action in APPROVAL_ACTIONS)) {
    return `action must be one of: ${Object.keys(APPROVAL_ACTIONS).join(', ')}`;
  }
  if (rule.decision !== 'auto' && rule.decision !== 'ask')
    return "decision must be 'auto' (don't ask) or 'ask'";
  const scope = APPROVAL_ACTIONS[rule.action].scope;
  if (rule.match?.recipient !== undefined) {
    if (scope !== 'recipient')
      return `${rule.action} has no recipient to narrow by`;
    const v = String(rule.match.recipient).trim().toLowerCase();
    if (
      v !== 'owner' &&
      !/^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(v) &&
      !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)
    ) {
      return `recipient must be 'owner', an email address, or a domain like @acme.com (got "${rule.match.recipient}")`;
    }
  }
  if (rule.match?.site !== undefined) {
    if (scope !== 'site') return `${rule.action} has no site to narrow by`;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(rule.match.site).trim()))
      return `site must be a domain like linkedin.com (got "${rule.match.site}")`;
  }
  if (
    rule.note !== undefined &&
    (typeof rule.note !== 'string' || rule.note.length > 300)
  )
    return 'note must be text of at most 300 characters';
  return null;
}

/** A clean stored rule from caller input. Assumes validateRule passed. */
export function makeRule(
  input: Partial<ApprovalRule>,
  createdBy: 'owner' | 'agent',
): ApprovalRule {
  const match: ApprovalRule['match'] = {};
  if (input.match?.recipient)
    match.recipient = String(input.match.recipient).trim().toLowerCase();
  if (input.match?.site)
    match.site = String(input.match.site)
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
  return {
    id:
      input.id && /^[A-Za-z0-9_-]{1,40}$/.test(input.id)
        ? input.id
        : `rule-${randomUUID().slice(0, 8)}`,
    action: input.action as ApprovalAction,
    ...(Object.keys(match).length ? { match } : {}),
    decision: input.decision as 'auto' | 'ask',
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    createdBy,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function hostOf(site: string): string {
  try {
    return new URL(site.includes('://') ? site : `https://${site}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return site.toLowerCase();
  }
}

function recipientMatches(
  pattern: string,
  recipients: string[],
  ownerEmail?: string | null,
): boolean {
  if (!recipients.length) return false;
  const p = pattern.toLowerCase();
  return recipients.every((r) => {
    if (p === 'owner') return !!ownerEmail && r === ownerEmail.toLowerCase();
    if (p.includes('@') && !p.startsWith('@')) return r === p;
    const domain = p.replace(/^@/, '');
    return r.endsWith(`@${domain}`) || r.endsWith(`.${domain}`);
  });
}

/**
 * The owner's standing answer for this action, or null for "no rule — ask as always".
 *
 * A rule that names a recipient or site beats a general one, and at the same specificity
 * 'ask' beats 'auto' — so "emails: don't ask" plus "emails to @competitor.com: ask" does
 * what it reads as. A recipient rule applies only when EVERY address matches it.
 */
export function evaluateApproval(
  rules: ApprovalRule[] | undefined,
  action: ApprovalAction,
  ctx: ApprovalContext = {},
  ownerEmail?: string | null,
): ApprovalRule | null {
  const recipients = (ctx.recipient ?? '')
    .split(/[,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const host = ctx.site ? hostOf(ctx.site) : '';
  const candidates = (rules ?? []).filter((r) => {
    if (r.action !== action) return false;
    if (
      r.match?.recipient &&
      !recipientMatches(r.match.recipient, recipients, ownerEmail)
    )
      return false;
    if (
      r.match?.site &&
      !(host === r.match.site || host.endsWith(`.${r.match.site}`))
    )
      return false;
    return true;
  });
  if (!candidates.length) return null;
  const specific = candidates.filter(
    (r) => r.match?.recipient || r.match?.site,
  );
  const pool = specific.length ? specific : candidates;
  return pool.find((r) => r.decision === 'ask') ?? pool[0];
}

/** "Send an email to owner → don't ask" — for notifications, audit reasons and replies. */
export function describeRule(r: ApprovalRule): string {
  const a = APPROVAL_ACTIONS[r.action]?.label ?? r.action;
  const scope = r.match?.recipient
    ? ` to ${r.match.recipient === 'owner' ? 'you' : r.match.recipient}`
    : r.match?.site
      ? ` on ${r.match.site}`
      : '';
  return `${a}${scope} → ${r.decision === 'auto' ? "don't ask" : 'always ask'}`;
}

/** Which rule-able action a check-in raised from a cycle is, or null if rules don't apply. */
export function actionForCheckin(
  actionType: string | null | undefined,
  payload: unknown,
): { action: ApprovalAction; ctx: ApprovalContext } | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >;
  switch (actionType) {
    case 'send_email':
    case 'smtp_send':
      return {
        action: 'email',
        ctx: { recipient: typeof p.to === 'string' ? p.to : undefined },
      };
    case 'batch_send_live':
      return { action: 'batch_send', ctx: {} };
    case 'create_agent':
      return { action: 'create_agent', ctx: {} };
    default:
      return null;
  }
}

/**
 * Would removing or adding this rule let the agent do more without asking? Loosening is the
 * direction that needs the owner behind it; tightening never does.
 */
export function isLoosening(change: {
  add?: ApprovalRule;
  remove?: ApprovalRule;
}): boolean {
  if (change.add) return change.add.decision === 'auto';
  if (change.remove) return change.remove.decision === 'ask';
  return false;
}
