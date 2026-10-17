/**
 * BrowserBroker — the server half of the real-browser lane (stage 45, doc 05, phase 1).
 *
 * The problem it solves: a browser is a stateful, single-owner resource sitting on someone
 * else's laptop, and the agent side is multi-tenant, multi-cycle and reconnecting. Between
 * them there has to be something that knows *whose* browser a command may reach, what that
 * browser agreed to do, and what happens to work in flight when the connection drops.
 *
 * The contract is Hermes' (`gateway/browser_control_broker.py`, torn down in
 * `docs/research/stage45/02-hermes-teardown.md` §4). It is the best-specified file in
 * either reference project and the rules below are its rules, adapted. Every one of them
 * has a test in browser-broker.test.ts named after it.
 *
 * WIRED, and proven end to end on 2026-08-31: the extension registers over
 * routes/browser-control.ts, holds a socket through api/browser-control-ws.ts, and a cycle
 * reaches it through routes/browser-control-dispatch.ts. A run only gets here when the
 * agent is configured for the lane AND this object says its owner has a browser attached
 * (see onlineControllersFor, called from nanobot-cycle-runner.ts).
 *
 * The live proof is a locally served page with random tokens in cross-origin frames:
 * perception found an in-frame control carrying that run's token, a click computed from
 * the snapshot landed on it with isTrusted=true, and typing reached an in-frame field.
 * See docs/research/stage45/next-session.md.
 */
import crypto from 'crypto';

import { logger } from '../logger.js';

// ─── Capabilities ───────────────────────────────────────────────────────────
//
// Three tiers, mirroring Hermes'. What differs is where perception sits, and that
// difference is the whole security posture of this lane.
//
// Hermes puts JS evaluation in the developer tier and fail-closes it, because for them
// evaluation is an extra. For us perception IS evaluation — capture_dom_snapshot is a
// script — so putting it in the developer tier would mean the base tier cannot see a page.
//
// The split: `page.probe` runs a container-supplied script in the extension's ISOLATED
// world. It can read the DOM (querySelectorAll, getBoundingClientRect, getComputedStyle,
// elementFromPoint, shadowRoot — everything the snapshot needs) and cannot touch page
// JavaScript, patch page functions, or be observed by the page. `page.eval` is MAIN-world
// arbitrary JS and stays in the developer tier, fail-closed, exactly as Hermes has it.
//
// That boundary is real but partial and should not be oversold: an isolated-world script
// still reads the DOM of a logged-in session, including input values. It stops tampering
// and detection, not reading. Reading is what the domain allowlist and the audit log in
// phase 4 are for.

export const BASE_CAPABILITIES = [
  'controller.noop',
  'page.info', // url, title, viewport
  'page.navigate',
  'page.probe', // container-supplied script, isolated world — how perception works
  'page.screenshot',
  'input.mouse',
  'input.key',
  // A wheel event is no more dangerous than a click and rather less — it cannot
  // activate anything. It is here rather than in the developer tier for that reason,
  // and because a lane that can click but not scroll can only reach what happens to
  // be above the fold.
  'input.scroll',
] as const;

export const ARTIFACT_CAPABILITIES = [
  'artifact.download',
  'artifact.upload',
] as const;

/**
 * What a controller driving Chrome over CDP can do that an extension cannot (stage 52
 * step 3).
 *
 * These are NOT a higher privilege tier, and it matters that they are not: `locator.act`
 * clicks and types, which `input.mouse` and `input.key` already do. What changes is
 * AIM, not power. A coordinate click is resolved once, at snapshot time, and fired blind
 * some seconds later at whatever now occupies that pixel; a locator re-resolves at the
 * moment of the action, waits for the element to be actionable, and retries. On a page
 * that moved — a banner loading, an async list settling — the first clicks the wrong
 * thing and reports success.
 *
 * So they sit alongside BASE rather than in DEVELOPER: same blast radius, better aim.
 * `page.eval` stays fail-closed in DEVELOPER exactly where it was, because arbitrary
 * MAIN-world JavaScript genuinely is a different power.
 *
 * The extension does not ask for these and could not serve them — reimplementing
 * Playwright's Locator over its bridge would be a second, subtly different engine
 * (remote_page.py:365-369). A controller that does not have them simply fails the
 * dispatch with ControllerUnavailable, which is how the container discovers the lane it
 * is on without anything having to be configured.
 */
export const CDP_CAPABILITIES = [
  'locator.query', // resolve a selector: count, bounds, text — with auto-wait
  'locator.act', // click/fill/hover/select a selector, actionability-checked
] as const;

/**
 * The user's own computer, beyond the browser (stage 60 phases 4 and 5): folders they
 * share, the terminal, and desktop apps. Only the desktop app serves these.
 *
 * Granted at the broker like any other capability, because the broker is not where their
 * safety lives: every one of them is permission-checked ON the user's machine, by the app,
 * with a native dialog the person answers (desktop/local-policy.js). A compromised server
 * relaying `fs.read ~/.ssh/id_rsa` gets a refusal written by the machine it is asking.
 */
export const LOCAL_CAPABILITIES = [
  'fs.roots',
  'fs.request',
  'fs.list',
  'fs.read',
  'fs.search',
  'fs.write',
  'shell.run',
  'desktop.screenshot',
  'desktop.windows',
  'desktop.focus',
  'desktop.ui_tree',
  'desktop.click',
  'desktop.type',
  'desktop.key',
] as const;

/** Fail-closed: admitted only when developer mode is explicitly on AND negotiated. */
export const DEVELOPER_CAPABILITIES = [
  'page.eval', // MAIN world, arbitrary JS
  'page.cdp',
] as const;

export type Capability =
  | (typeof BASE_CAPABILITIES)[number]
  | (typeof ARTIFACT_CAPABILITIES)[number]
  | (typeof CDP_CAPABILITIES)[number]
  | (typeof LOCAL_CAPABILITIES)[number]
  | (typeof DEVELOPER_CAPABILITIES)[number];

const BASE_SET = new Set<string>(BASE_CAPABILITIES);
const ARTIFACT_SET = new Set<string>(ARTIFACT_CAPABILITIES);
const CDP_SET = new Set<string>(CDP_CAPABILITIES);
const LOCAL_SET = new Set<string>(LOCAL_CAPABILITIES);
const DEVELOPER_SET = new Set<string>(DEVELOPER_CAPABILITIES);

/**
 * Intersect what a controller claims with what the server is willing to grant.
 *
 * The client's list is a request, never a grant: an extension that asks for `page.eval`
 * without developer mode, or invents `page.wipe_disk`, gets neither. Hermes does the same
 * filtering server-side for the same reason (`api_server.py:3401-3417`).
 */
export function filterCapabilities(
  requested: readonly string[],
  developerMode: boolean,
): Capability[] {
  const out: Capability[] = [];
  for (const c of requested) {
    if (
      BASE_SET.has(c) ||
      ARTIFACT_SET.has(c) ||
      CDP_SET.has(c) ||
      LOCAL_SET.has(c)
    )
      out.push(c as Capability);
    else if (DEVELOPER_SET.has(c) && developerMode) out.push(c as Capability);
  }
  return out;
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * Who a controller is. Every field participates in equality — a partial match is not a
 * match, and resolves to no controller at all rather than to a plausible neighbour.
 *
 * `principal` is derived server-side from the authenticated session, never read from a
 * request body. A client that sends its own principal is describing, not deciding.
 */
export interface ControllerScope {
  /** Non-reversible digest of the authenticated owner. Server-derived. */
  principal: string;
  /** Which browser profile on that machine. */
  browserProfileId: string;
  /** One connection's identity, so two windows of one profile stay distinct. */
  controllerId: string;
}

export function scopeKey(s: ControllerScope): string {
  // Length-prefixed so no combination of field values can collide with another:
  // ("a:b", "c") and ("a", "b:c") must not produce the same key.
  return [s.principal, s.browserProfileId, s.controllerId]
    .map((v) => `${v.length}:${v}`)
    .join('|');
}

export function scopesEqual(a: ControllerScope, b: ControllerScope): boolean {
  return (
    a.principal === b.principal &&
    a.browserProfileId === b.browserProfileId &&
    a.controllerId === b.controllerId
  );
}

/** Derive the scope principal from an authenticated identity. Never accepts one. */
export function derivePrincipal(ownerId: string): string {
  return crypto
    .createHash('sha256')
    .update(`nc-browser-principal:${ownerId}`)
    .digest('hex');
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ControllerTicketInvalid extends Error {}
export class ControllerUnavailable extends Error {}
export class ControllerCancelled extends Error {}

// ─── Wire types ─────────────────────────────────────────────────────────────

export const BROWSER_CONTROL_PROTOCOL_VERSION = 1;

export interface Command {
  id: string;
  capability: Capability;
  payload: unknown;
  toolCallId?: string;
}

export type SendFn = (command: Command) => void | Promise<void>;

interface Controller {
  scope: ControllerScope;
  capabilities: Set<Capability>;
  send: SendFn;
  online: boolean;
  /** When this controller last attached. Newest wins — see onlineControllersFor. */
  attachedAt: number;
}

interface Pending {
  scope: ControllerScope;
  toolCallId?: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

interface Ticket {
  scope: ControllerScope;
  capabilities: Capability[];
  expiresAt: number;
}

const TICKET_TTL_MS = 2 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export class BrowserBroker {
  private tickets = new Map<string, Ticket>();
  private controllers = new Map<string, Controller>();
  private pending = new Map<string, Pending>();
  /** Principals the user has stopped. See halt() for why this is not just a detach. */
  private halted = new Set<string>();

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * Mint a single-use, short-lived, identity-bound registration ticket.
   *
   * 32 bytes from crypto.randomBytes — not randomUUID, whose v4 form leaks version bits
   * and is only 122 bits of entropy. The ticket is the one credential that turns an
   * anonymous socket into a named controller, so it gets full-strength randomness.
   */
  mintTicket(
    scope: ControllerScope,
    requested: readonly string[],
    developerMode = false,
  ): string {
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      scope,
      capabilities: filterCapabilities(requested, developerMode),
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return ticket;
  }

  /** Redeem a ticket. Single-use: the second attempt fails, as does an expired one. */
  consumeTicket(ticket: string): {
    scope: ControllerScope;
    capabilities: Capability[];
  } {
    const found = this.tickets.get(ticket);
    if (!found)
      throw new ControllerTicketInvalid('unknown or already-used ticket');
    // Delete before the expiry check so an expired ticket is also burned, rather than
    // left for a second attempt to keep probing.
    this.tickets.delete(ticket);
    if (Date.now() > found.expiresAt)
      throw new ControllerTicketInvalid('ticket expired');
    return { scope: found.scope, capabilities: found.capabilities };
  }

  /** Attach a controller. Re-attaching the same identity refreshes its send callback. */
  attach(
    scope: ControllerScope,
    capabilities: readonly Capability[],
    send: SendFn,
  ): void {
    this.controllers.set(scopeKey(scope), {
      scope,
      capabilities: new Set(capabilities),
      send,
      online: true,
      attachedAt: Date.now(),
    });
    logger.info(
      { principal: scope.principal.slice(0, 8), caps: capabilities.length },
      'browser controller attached',
    );
  }

  /**
   * Deliberate teardown: fail closed. The controller goes, and every command waiting on
   * it is cancelled rather than left to time out — a waiter that hangs after its browser
   * has gone is a cycle that does nothing for a minute for no reason.
   */
  detach(scope: ControllerScope): void {
    this.controllers.delete(scopeKey(scope));
    for (const [id, p] of [...this.pending]) {
      if (!scopesEqual(p.scope, scope)) continue;
      this.settle(id, () =>
        p.reject(new ControllerCancelled('controller detached')),
      );
    }
  }

  /**
   * Unexpected transport loss. NOT the same as detach: the work may still be running in
   * a browser that is fine, and the extension may re-attach seconds later and deliver the
   * result. Marking offline without cancelling is what makes an MV3 service worker being
   * killed mid-command a reconnect instead of a failure — see doc 05, phase 0, spike 2.
   */
  disconnect(scope: ControllerScope, send?: SendFn): void {
    const c = this.controllers.get(scopeKey(scope));
    // Only the socket currently serving this identity can take it offline. A client
    // that reconnects keeps its controllerId, so an OLD socket closing after a newer
    // one attached used to mark the live controller offline — found 2026-09-18: the
    // desktop app piled up reconnects on wake/unlock, one old socket closed, and the
    // chat said "not connected" while a healthy socket sat open.
    if (c && (!send || c.send === send)) c.online = false;
  }

  // ── The kill switch ─────────────────────────────────────────────────────
  //
  // stage45 doc 05, a phase-4 mitigation pulled forward to land with the wiring: the
  // user must be able to stop a run that is already going wrong, and it has to work
  // when the agent is hung, mid-tool-call or ignoring everything.
  //
  // It does, because the container reaches the browser ONLY through this object. A halt
  // is enforced here, in the orchestrator's own memory, and needs nothing from the
  // container to take effect.
  //
  // Why a flag and not just detach(): the extension reconnects on its own three seconds
  // after any drop, which is right for a dropped wifi connection and wrong for "stop".
  // Without a flag that outlives the socket, Stop would mean "pause for three seconds".

  /** Stop everything for this principal, and refuse to start again until resumed. */
  halt(principal: string): number {
    this.halted.add(principal);
    let cancelled = 0;
    for (const [key, c] of [...this.controllers]) {
      if (c.scope.principal !== principal) continue;
      this.controllers.delete(key);
      for (const [id, p] of [...this.pending]) {
        if (p.scope.principal !== principal) continue;
        if (
          this.settle(id, () =>
            p.reject(new ControllerCancelled('stopped by the user')),
          )
        )
          cancelled++;
      }
    }
    logger.warn(
      { principal: principal.slice(0, 8), cancelled },
      'browser control halted by the user',
    );
    return cancelled;
  }

  /** Lift a halt. Only ever called for a deliberate human action — see the register route. */
  resume(principal: string): void {
    if (this.halted.delete(principal)) {
      logger.info(
        { principal: principal.slice(0, 8) },
        'browser control resumed by the user',
      );
    }
  }

  isHalted(principal: string): boolean {
    return this.halted.has(principal);
  }

  // ── Selection ───────────────────────────────────────────────────────────

  /** The controller for this exact identity that negotiated this capability, or null. */
  select(scope: ControllerScope, capability: Capability): Controller | null {
    if (this.halted.has(scope.principal)) return null;
    const c = this.controllers.get(scopeKey(scope));
    if (!c) return null;
    if (!scopesEqual(c.scope, scope)) return null; // belt and braces over the key
    if (!c.capabilities.has(capability)) return null;
    return c;
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  /**
   * Send one command and wait for its result.
   *
   * The send happens AFTER the waiter is parked, never before. A controller is allowed to
   * complete synchronously from inside its own send — a same-process test double does
   * exactly that — and if the waiter were not already in the map that result would arrive
   * for a command nobody is waiting on, and hang forever.
   */
  async dispatch(
    scope: ControllerScope,
    capability: Capability,
    payload: unknown,
    opts: { toolCallId?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    // Named separately from "no controller": a halted principal is a decision someone
    // made, and a caller that cannot tell them apart tells the user to plug their
    // browser back in when they had just unplugged it on purpose.
    if (this.halted.has(scope.principal))
      throw new ControllerUnavailable(
        'browser control was stopped by the user',
      );
    const controller = this.select(scope, capability);
    if (!controller)
      throw new ControllerUnavailable(`no controller for ${capability}`);
    if (!controller.online)
      throw new ControllerUnavailable('controller is offline');

    const id = crypto.randomBytes(16).toString('hex');
    const command: Command = {
      id,
      capability,
      payload,
      toolCallId: opts.toolCallId,
    };

    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.settle(id, () =>
            reject(new ControllerUnavailable('command timed out')),
          ),
        opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
      // unref so a pending command cannot hold the process open at shutdown.
      timer.unref?.();
      this.pending.set(id, {
        scope,
        toolCallId: opts.toolCallId,
        resolve,
        reject,
        timer,
      });
    });

    try {
      await controller.send(command);
    } catch (err) {
      this.settle(id, () => {
        throw err;
      });
      throw err;
    }
    return result;
  }

  /**
   * Deliver a result. Single-shot by construction: the entry is removed before the
   * waiter is resolved, so a duplicate, a late retry, or a result racing the timeout all
   * return false instead of resolving a promise twice.
   */
  complete(commandId: string, result: unknown): boolean {
    return this.settle(commandId, (p) => p.resolve(result));
  }

  /** Deliver a failure. Same single-shot guarantee as complete. */
  fail(commandId: string, message: string): boolean {
    return this.settle(commandId, (p) => p.reject(new Error(message)));
  }

  /**
   * Cancel commands for one tool call. Scoped by identity AND toolCallId: cancelling one
   * agent's step must not touch another agent's in-flight work on the same browser.
   */
  cancel(scope: ControllerScope, toolCallId: string): number {
    let n = 0;
    for (const [id, p] of [...this.pending]) {
      if (!scopesEqual(p.scope, scope) || p.toolCallId !== toolCallId) continue;
      if (this.settle(id, () => p.reject(new ControllerCancelled('cancelled'))))
        n++;
    }
    return n;
  }

  /**
   * Remove a pending entry and run `act` exactly once. Every path that finishes a command
   * goes through here, which is what makes "single-shot" a property of the class rather
   * than something each caller has to remember.
   */
  private settle(id: string, act: (p: Pending) => void): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    act(p);
    return true;
  }

  // ── Introspection (tests and diagnostics) ───────────────────────────────

  /**
   * The online controllers belonging to one principal.
   *
   * The cycle runner uses this to answer "does this agent's owner actually have a
   * browser attached right now" before it opts a run into the remote lane. It returns
   * scopes rather than Controllers so nothing outside this file can hold a send
   * function and route around dispatch's checks.
   */
  /**
   * Controllers this principal can be given, NEWEST FIRST.
   *
   * Callers take the first, so the order is the choice. It used to be Map insertion
   * order — oldest first — which is exactly backwards: a controller that registered an
   * hour ago and whose browser has since gone is the least likely to answer, and a
   * controller that registered a moment ago is the most likely.
   *
   * That is not hypothetical. A desktop app restarted three times leaves three
   * registrations, and a socket that dies without a close frame never clears its
   * `online` flag — so the oldest, deadest one won every time. On 2026-09-06 a cycle
   * was handed such a controller, dispatched to it, and reported "no browser is
   * connected for this owner" while a live browser sat attached and idle.
   *
   * Newest-first does not make a stale controller impossible; it makes it lose.
   */
  onlineControllersFor(principal: string): ControllerScope[] {
    if (this.halted.has(principal)) return [];
    return [...this.controllers.values()]
      .filter((c) => c.online && c.scope.principal === principal)
      .sort((a, b) => b.attachedAt - a.attachedAt)
      .map((c) => ({ ...c.scope }));
  }

  pendingCount(): number {
    return this.pending.size;
  }
  isAttached(scope: ControllerScope): boolean {
    return this.controllers.has(scopeKey(scope));
  }
  isOnline(scope: ControllerScope): boolean {
    return this.controllers.get(scopeKey(scope))?.online ?? false;
  }

  /**
   * What this controller can actually do (stage 52 step 3).
   *
   * The container asks so it can tell an extension from a companion WITHOUT anything
   * being configured: a lane with `locator.act` re-resolves elements at action time, a
   * lane without it must aim by coordinate. Discovering that by trying and catching
   * would work, but it would spend a failed dispatch and a timeout to learn something
   * the broker already knows.
   */
  /**
   * Sites this controller's browser is signed into, as it last reported them.
   *
   * Kept beside the ticket rather than on the controller, because it is known at
   * REGISTRATION — before the socket exists — and a cycle may ask for it while the
   * controller is briefly offline between reconnects.
   */
  private sitesByKey = new Map<string, string[]>();

  noteSites(scope: ControllerScope, sites: string[]): void {
    this.sitesByKey.set(scopeKey(scope), sites);
  }

  sitesFor(scope: ControllerScope): string[] {
    return this.sitesByKey.get(scopeKey(scope)) ?? [];
  }

  /** Any site signed into by any controller of this principal. */
  sitesForPrincipal(principal: string): string[] {
    const out = new Set<string>();
    for (const [key, sites] of this.sitesByKey) {
      if (!key.includes(principal)) continue;
      for (const s of sites) out.add(s);
    }
    return [...out];
  }

  capabilitiesFor(scope: ControllerScope): Capability[] {
    const c = this.controllers.get(scopeKey(scope));
    return c ? [...c.capabilities] : [];
  }
}

export const browserBroker = new BrowserBroker();
