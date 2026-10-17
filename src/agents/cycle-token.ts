/**
 * Per-cycle bearer tokens for agent → orchestrator writes.
 *
 * The 22 pre-existing `/api/agents/:id/*` internal routes authenticate with nothing
 * but the agent's UUID ("agentId + cycleId UUIDs serve as the bearer token"). That is
 * survivable for the routes that only *append* — a step row, a memory, a handoff — and
 * it is not survivable for the self-management routes, which change how much money an
 * agent may spend, which model it runs, and whether it runs at all. Agent UUIDs appear
 * in logs, in socket payloads and in the dashboard URL bar; they are identifiers, not
 * secrets, and nothing about them expires.
 *
 * So the self-management routes require a token instead. It is minted per cycle, handed
 * to the container in the stdin payload (NOT the env — a warm daemon's env is frozen for
 * its whole lifetime, which is the same reason cycleId travels in the payload), and
 * revoked when the cycle returns. A token is bound to one agent: presenting Finder's
 * token on Mailer's route fails even though both are valid tokens.
 *
 * This module is deliberately a LEAF — it imports nothing but node:crypto — for the same
 * reason api/instances.ts is. Both server routes and the cycle runner import it, and the
 * cycle runner is already inside the agent-service → api/server → routes → agent-registry
 * cycle documented in api/instances.ts.
 */
import { randomBytes } from 'crypto';

interface TokenRecord {
  agentId: string;
  cycleId: string;
  expiresAt: number;
}

/** token → record. Process-local by design: a restart invalidates in-flight tokens, and
 *  a cycle whose orchestrator restarted mid-run has already lost its result channel. */
const tokens = new Map<string, TokenRecord>();

/**
 * Outlives CONTAINER_TIMEOUT by 10 minutes, so a cycle that runs to the wire can still write
 * on its final turn, but not by so much that a leaked token stays useful for long.
 *
 * Was a fixed 40 minutes, written when the timeout defaulted to 30. Prod sets
 * CONTAINER_TIMEOUT=3000000 (50 min), so for the last 10 minutes of a long cycle every
 * token-gated call — credentials, self-management, the cycle channel — was refused as
 * expired. Read from the env rather than config.js: this module stays a leaf (see above).
 */
//
// Since 2026-09-30 a cycle has no wall-clock limit (liveness.ts) — it may run for days — so
// the token lives as long as the optional CYCLE_MAX_MS ceiling allows, or 30 days when there
// is none. It is still revoked the moment its cycle ends, and dies with the process.
export const TOKEN_TTL_MS = (() => {
  const max = parseInt(process.env.CYCLE_MAX_MS || '', 10) || 0;
  return max > 0 ? max + 10 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
})();

/** Drop expired records. Called on every issue/verify — no timer to leak. */
function sweep(now: number): void {
  for (const [token, rec] of tokens) {
    if (rec.expiresAt <= now) tokens.delete(token);
  }
}

/** Mint a token for one cycle of one agent. Returns the token to put in the payload. */
export function issueCycleToken(agentId: string, cycleId: string): string {
  const now = Date.now();
  sweep(now);
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { agentId, cycleId, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/**
 * True when `token` was minted for `agentId` and has not expired.
 *
 * The agentId check is the point: without it any live token would authorise a write to
 * any agent, and every agent on the platform holds a live token whenever it is running.
 */
export function verifyCycleToken(
  token: string | undefined | null,
  agentId: string,
): boolean {
  if (!token) return false;
  const now = Date.now();
  sweep(now);
  const rec = tokens.get(token);
  return !!rec && rec.agentId === agentId && rec.expiresAt > now;
}

/**
 * Resolve a token to the agent and cycle it was minted for, or null.
 *
 * The token already names both, so a caller that needs to know *which* cycle is talking
 * should ask it rather than accept the claim alongside it. The cycle channel
 * (api/cycle-channel-ws.ts) authenticates a socket this way: one secret, no separate
 * agentId/cycleId parameters to verify against it and no way to present a valid token
 * beside someone else's cycle id.
 */
export function resolveCycleToken(
  token: string | undefined | null,
): { agentId: string; cycleId: string } | null {
  if (!token) return null;
  const now = Date.now();
  sweep(now);
  const rec = tokens.get(token);
  if (!rec || rec.expiresAt <= now) return null;
  return { agentId: rec.agentId, cycleId: rec.cycleId };
}

/** Invalidate a token once its cycle has returned. Safe to call twice. */
export function revokeCycleToken(token: string | undefined | null): void {
  if (token) tokens.delete(token);
}

/**
 * Pull the token out of the `Authorization: Bearer …` / `X-Cycle-Token` header pair.
 *
 * Deliberately does NOT look at the query string: query strings land in access logs and
 * proxy logs, which is most of the reason the agent-UUID-as-password model these routes
 * inherited was not good enough in the first place.
 *
 * Kept here so the self-management router and the credential route cannot drift apart on
 * how they read the same token.
 */
export function extractCycleToken(
  authorization?: string | string[],
  xCycleToken?: string | string[],
): string {
  const first = (v?: string | string[]) =>
    Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  return (
    first(authorization)
      .replace(/^Bearer\s+/i, '')
      .trim() || first(xCycleToken).trim()
  );
}

/** Test/diagnostic helper — number of live (unexpired) tokens. */
export function liveTokenCount(): number {
  sweep(Date.now());
  return tokens.size;
}
