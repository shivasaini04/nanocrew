/**
 * Stage 57 phase 4 — the verifiers' calls to real services: the mail server, the owner's
 * tracker, the model gateway. Kept apart from service.ts so the judge calibration
 * (calibrate.ts) can use exactly what production uses without starting the engine.
 */
import { getDb } from '../db.js';
import {
  calculateCost,
  type UsageBlock,
} from '../agents/nanobot-cycle-runner.js';
import type { Complete } from './judge.js';
import type { EmailStatus } from './verify.js';

const REACHER_URL = (
  process.env.REACHER_URL || 'http://reacher-verifier:8080'
).replace(/\/$/, '');

/** Reacher's verdict on one address. Anything but a clean answer is `unknown` — which fails the check. */
export async function checkEmail(
  address: string,
): Promise<{ status: EmailStatus; detail?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(`${REACHER_URL}/v0/check_email`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_email: address }),
    });
    if (!res.ok)
      return {
        status: 'unknown',
        detail: `mail check returned HTTP ${res.status}`,
      };
    const d = (await res.json()) as {
      is_reachable?: string;
      smtp?: { is_catch_all?: boolean };
      misc?: { is_role_account?: boolean };
    };
    const s = String(d.is_reachable ?? 'unknown') as EmailStatus;
    const status: EmailStatus = [
      'safe',
      'risky',
      'invalid',
      'unknown',
    ].includes(s)
      ? s
      : 'unknown';
    const why = [
      d.smtp?.is_catch_all ? 'catch-all domain' : '',
      d.misc?.is_role_account ? 'role address' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return { status, detail: why || undefined };
  } catch (err) {
    return {
      status: 'unknown',
      detail: `mail check failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Is this value one of the owner's tracked items — as an item key or any field of one? */
export function knownToOwner(
  ownerUserId: string | null,
  value: string,
): string | null {
  if (!ownerUserId) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const row = getDb()
    .prepare(
      `
    SELECT ti.entity AS entity FROM tracked_items ti JOIN agents a ON a.id = ti.agent_id
    WHERE a.owner_id = ? AND (lower(ti.item_key) = ?
      OR EXISTS (SELECT 1 FROM json_each(ti.data) j WHERE j.type = 'text' AND lower(trim(j.value)) = ?))
    LIMIT 1`,
    )
    .get(ownerUserId, v, v) as { entity: string } | undefined;
  return row ? `tracker (${row.entity})` : null;
}

/** One judge call through the platform's model gateway. */
export const complete: Complete = async (model, system, user) => {
  const url = process.env.LITELLM_PROXY_URL;
  const key = process.env.LITELLM_PROXY_KEY;
  if (!url || !key) throw new Error('no model gateway configured');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      // Room for reasoning models to think before the one-line answer: phase 4's probe saw
      // one spend a 200-token budget thinking and return nothing, and bench 2 saw one spend
      // 2,000 on 24k characters of 10-K pages and do the same (docs 20).
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: UsageBlock & { cost?: number };
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    const usage = body.usage ?? {};
    const costUsd =
      typeof usage.cost === 'number' ? usage.cost : calculateCost(model, usage);
    return { text: body.choices?.[0]?.message?.content ?? '', costUsd };
  } finally {
    clearTimeout(timer);
  }
};
