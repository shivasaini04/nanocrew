/**
 * Stage 56 phase 3 — borrowing a tool instead of waking an agent.
 *
 * This is the cheap answer to the motivating case: *"if a problem needs a tool one agent
 * has and another does not, that agent can call it, wait for the response, and continue
 * its job."* Most of the time what is wanted is a TOOL RESULT, not a colleague's
 * judgement — and a tool problem wearing a communication costume is an order of magnitude
 * cheaper solved as a tool problem.
 *
 * Waking Mailer to verify one email costs a container, a model call, a cycle of context,
 * and a wait measured in hours. Running `verify_email` inside the caller's own cycle costs
 * one HTTP request and returns before the turn ends. It is genuinely synchronous, which
 * nothing else in this stage is.
 *
 * ## What is lent, precisely
 *
 * The RIGHT to call the tool, plus only the credentials that specific tool needs.
 *
 * The tempting shortcut — hand over every secret the holder has that the borrower lacks —
 * is rejected. Borrowing `verify_email` from Mailer must not silently transfer Mailer's
 * Gmail refresh token. So credentials are resolved through an explicit tool → service
 * map: a tool not in it is lent WITHOUT credentials and the borrower is told so, which
 * fails safe. Most tools need none.
 *
 * ## The boundaries, and why each one is here
 *
 * - **Same owner.** The boundary stage 54 already proved. An agent cannot reach across
 *   customers, and this is the check that makes credential lending defensible at all:
 *   both agents' secrets already belong to one person.
 * - **The holder must actually hold it.** Granted in `config.tools`, not merely capable of
 *   it in principle. You cannot lend what is not yours.
 * - **One cycle.** A borrow dies with the cycle that asked for it. There is no lasting
 *   grant, so a borrow can never quietly become a permanent escalation.
 * - **Audited on both sides.** The borrower's row says what it took; the holder's says
 *   what was taken from it. An agent using another's credentials with no record on the
 *   lender's side is exactly the kind of thing that reads as a compromise later.
 */
import { getAgent, getAllAgents, recordConfigAudit } from '../db.js';
import { secretsManager } from './secrets-manager.js';
import { CREDENTIAL_ENV_MAP } from './credential-catalog.js';
import { ALWAYS_GRANTED, OUTBOUND_TOOLS } from './tool-grants.js';
import { logger } from '../logger.js';

/**
 * Which credential service each borrowable tool actually needs.
 *
 * Deliberately explicit and deliberately incomplete. An unmapped tool is lent without
 * credentials rather than with all of them — the failure mode of a guess here is handing
 * over a secret nobody asked for, which is not a failure you find out about.
 */
export const TOOL_SERVICES: Record<string, string> = {
  send_email: 'gmail',
  smtp_send: 'gmail',
  gmail_search: 'gmail',
  x_post: 'x',
  twitter_search: 'twitter',
  sql_query: 'database',
};

export interface BorrowRequest {
  borrowerId: string;
  tool: string;
  /** Optional: a specific teammate. Otherwise the best qualified holder is chosen. */
  from?: string;
  reason: string;
}

export interface BorrowResult {
  ok: true;
  tool: string;
  holder: { id: string; name: string };
  /** Env vars to set for this cycle. Empty when the tool needs no credentials. */
  env: Record<string, string>;
  credentialNote: string;
  note: string;
}

export interface BorrowRefusal {
  ok: false;
  status: number;
  error: string;
  /** Agents that DO hold it, when the named one did not. */
  holders?: string[];
}

/** Agents (same owner) whose granted tools include `tool`, best-qualified first. */
export function holdersOf(
  tool: string,
  borrowerId: string,
  ownerId: string | null | undefined,
) {
  // No owner, no crew: a null owner used to borrow from every account's agents.
  if (!ownerId) return [];
  return getAllAgents()
    .filter((a) => a.id !== borrowerId && a.owner_id === ownerId)
    .filter((a) => (a.config?.tools ?? []).includes(tool));
}

export function borrowTool(req: BorrowRequest): BorrowResult | BorrowRefusal {
  const borrower = getAgent(req.borrowerId);
  if (!borrower) return { ok: false, status: 404, error: 'Agent not found' };

  const tool = String(req.tool ?? '').trim();
  if (!tool)
    return {
      ok: false,
      status: 422,
      error: '`tool` is required — name the tool you want to use.',
    };

  const reason = String(req.reason ?? '').trim();
  if (!reason) {
    return {
      ok: false,
      status: 422,
      error:
        "A `reason` is required. Borrowing runs another agent's credentials under your cycle, " +
        'and the audit row on both sides is only useful if it says what for.',
    };
  }

  // Already yours — say so plainly rather than minting a pointless borrow. A model told
  // "ok" here would conclude the tool needed borrowing every time it used it.
  const own = borrower.config?.tools ?? [];
  if (own.includes(tool) || ALWAYS_GRANTED.has(tool)) {
    return {
      ok: false,
      status: 409,
      error: `You already have \`${tool}\`. Call it directly — nothing needs borrowing.`,
    };
  }

  // A tool that reaches a person outside the system is the one thing still gated on the
  // owner (tool-grants.ts OUTBOUND_TOOLS). Borrowing Seeker's smtp_send would route round
  // that gate in a single call, so these are asked for, never borrowed.
  if (OUTBOUND_TOOLS.has(tool)) {
    return {
      ok: false,
      status: 403,
      error:
        `\`${tool}\` contacts people outside the system, so it cannot be borrowed. ` +
        `Ask your owner for it with self_manage (action "tools", add ["${tool}"]) — they approve it once.`,
    };
  }

  const owner = borrower.owner_id ?? null;
  const holders = holdersOf(tool, borrower.id, owner);
  if (holders.length === 0) {
    return {
      ok: false,
      status: 404,
      error:
        `Nobody on your crew is granted \`${tool}\`, so it cannot be borrowed. ` +
        `Use \`find_agent\` to look for a capability rather than a tool name, or ask your owner for it.`,
    };
  }

  let holder = holders[0];
  if (req.from) {
    const want = String(req.from).trim().toLowerCase();
    const named = holders.find(
      (a) => a.id === req.from || a.name.toLowerCase() === want,
    );
    if (!named) {
      return {
        ok: false,
        status: 404,
        error: `${req.from} is not granted \`${tool}\`.`,
        holders: holders.map((a) => a.name),
      };
    }
    holder = named;
  }

  // Credentials: exactly what this tool needs, and nothing else.
  const service = TOOL_SERVICES[tool];
  const env: Record<string, string> = {};
  let credentialNote: string;

  if (!service) {
    credentialNote =
      `\`${tool}\` is not in the credential map, so it is lent WITHOUT credentials. If it turns out ` +
      `to need a key, it will fail with an auth error — reply \`cannot\` naming the credential rather ` +
      `than retrying.`;
  } else {
    const holderEnv = secretsManager.getAll(
      holder.id,
      holder.owner_id ?? undefined,
    );
    const borrowerEnv = secretsManager.getAll(
      borrower.id,
      borrower.owner_id ?? undefined,
    );
    const names = Object.values(CREDENTIAL_ENV_MAP[service] ?? {});
    for (const n of names) {
      // Only what the borrower is missing. Re-sending a value it already holds would
      // silently swap its own credential for someone else's, which is a different action
      // from the one it asked for.
      if (holderEnv[n] && !borrowerEnv[n]) env[n] = holderEnv[n];
    }
    credentialNote =
      Object.keys(env).length > 0
        ? `Lending ${holder.name}'s ${service} credentials (${Object.keys(env).join(', ')}) for this cycle only.`
        : `No ${service} credentials needed to be lent — you already have what \`${tool}\` uses, or ${holder.name} has none stored.`;
  }

  // Both sides. A borrower-only record leaves the lender's owner unable to see that
  // another agent has been using its keys.
  const audit = (agentId: string, isBorrower: boolean) =>
    recordConfigAudit({
      agentId,
      capability: 'tools',
      actor: 'agent',
      before: { borrowed: null },
      after: {
        borrowed: tool,
        counterparty: isBorrower ? holder.name : borrower.name,
        credentials: Object.keys(env),
      },
      reason: isBorrower
        ? `Borrowed \`${tool}\` from ${holder.name}: ${reason}`
        : `${borrower.name} borrowed \`${tool}\` from you: ${reason}`,
    });
  audit(borrower.id, true);
  audit(holder.id, false);

  logger.info(
    {
      borrower: borrower.id,
      holder: holder.id,
      tool,
      credentials: Object.keys(env).length,
    },
    'agent borrowed a tool',
  );

  return {
    ok: true,
    tool,
    holder: { id: holder.id, name: holder.name },
    env,
    credentialNote,
    note:
      `\`${tool}\` is available to you for the rest of this cycle. Call it directly now — ` +
      `${holder.name} has NOT been woken and does not know the result. If what you learn matters ` +
      `to them, tell them with \`handoff_to\`. The loan ends when this cycle ends.`,
  };
}
