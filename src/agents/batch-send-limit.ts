/**
 * Daily per-site limit on sends approved from the user's own browser (stage 60 phase 3).
 *
 * The agent asks for a list of sends once (`request_batch_approval`), and the person
 * approves it in the chat. What stops a long day of approvals from getting their account
 * restricted is this: a site's approved sends across ALL of the owner's agents, over the
 * last 24 hours, may not exceed a per-site number. It lives here, on the orchestrator,
 * because the agent's own count is state the agent could get wrong.
 *
 * The LinkedIn default is 20 a day. LinkedIn restricts invitations at roughly 100 a week
 * (their help pages and widely reported behaviour, late 2025 — not a number they
 * publish as a guarantee), so 20 a day on five working days sits at that line rather
 * than past it. Override with IDENTITY_SENDS_PER_DAY, e.g. `{"linkedin.com":15,"*":30}`.
 */

export const DEFAULT_SENDS_PER_DAY: Record<string, number> = {
  'linkedin.com': 20,
  'x.com': 30,
  'twitter.com': 30,
  '*': 30,
};

export function sendsPerDay(
  site: string,
  env: string | undefined = process.env.IDENTITY_SENDS_PER_DAY,
): number {
  let table = DEFAULT_SENDS_PER_DAY;
  if (env) {
    try {
      const parsed = JSON.parse(env);
      if (parsed && typeof parsed === 'object')
        table = { ...DEFAULT_SENDS_PER_DAY, ...parsed };
    } catch {
      // A malformed override must not remove the limit; the defaults stand.
    }
  }
  const n = Number(table[site] ?? table['*']);
  return Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : DEFAULT_SENDS_PER_DAY['*'];
}

export interface BatchCheckinRow {
  action_type?: string | null;
  action_payload?: string | null;
  user_reply?: string | null;
  responded_at?: string | null;
  status?: string | null;
}

function parse(row: BatchCheckinRow): { site?: string; items?: unknown[] } {
  try {
    return JSON.parse(row.action_payload ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** Sends on `site` approved in the 24 hours before `now`. */
export function approvedSendsLastDay(
  rows: readonly BatchCheckinRow[],
  site: string,
  now: number = Date.now(),
): number {
  const since = now - 24 * 60 * 60 * 1000;
  let total = 0;
  for (const r of rows) {
    if (r.action_type !== 'batch_send_live') continue;
    if (!(r.user_reply ?? '').trim().toLowerCase().startsWith('approve'))
      continue;
    const at = Date.parse(r.responded_at ?? '');
    if (!Number.isFinite(at) || at < since) continue;
    const p = parse(r);
    if (p.site !== site) continue;
    total += Array.isArray(p.items) ? p.items.length : 0;
  }
  return total;
}

/**
 * The whole check a check-in route runs before creating a `batch_send_live` row.
 *
 * One function because there are TWO routes that create check-ins: the agents router,
 * and a pre-auth copy in server.ts that agent containers actually reach (Express matches
 * it first). The limit was first added only to the router's copy — which no container
 * ever calls — and a live test on 2026-09-17 is how that surfaced. Both call this now.
 *
 * Returns null when the row may be created, or an HTTP status and body to refuse with.
 */
export function batchCheckinRefusal(
  agentOwnerId: string | null | undefined,
  actionType: unknown,
  actionPayload: unknown,
  ownerCheckins: (ownerId: string | null) => readonly BatchCheckinRow[],
): { status: number; body: Record<string, unknown> } | null {
  if (actionType !== 'batch_send_live') return null;
  let site = '';
  let items = 0;
  try {
    const p = JSON.parse(
      typeof actionPayload === 'string' ? actionPayload : '{}',
    );
    site = String(p?.site ?? '');
    items = Array.isArray(p?.items) ? p.items.length : 0;
  } catch {
    /* refused below */
  }
  if (!site || items === 0) {
    return {
      status: 400,
      body: {
        error:
          'batch_send_live needs action_payload.site and a non-empty items list',
      },
    };
  }
  const verdict = checkBatch(ownerCheckins(agentOwnerId ?? null), site, items);
  if (verdict.ok) return null;
  return {
    status: 422,
    body: {
      error: `Daily limit for ${site}: ${verdict.limit} sends in 24 hours. ${verdict.used} already approved, ${verdict.remaining} left. Trim the list to ${verdict.remaining} or fewer, or wait.`,
      site,
      limit: verdict.limit,
      used: verdict.used,
      remaining: verdict.remaining,
    },
  };
}

/**
 * Whether a new batch fits. `remaining` is what is still allowed today, so a refusal can
 * tell the agent exactly how far to trim.
 */
export function checkBatch(
  rows: readonly BatchCheckinRow[],
  site: string,
  requested: number,
  now: number = Date.now(),
  env?: string,
): { ok: boolean; limit: number; used: number; remaining: number } {
  const limit = sendsPerDay(site, env);
  const used = approvedSendsLastDay(rows, site, now);
  const remaining = Math.max(0, limit - used);
  return { ok: requested <= remaining, limit, used, remaining };
}
