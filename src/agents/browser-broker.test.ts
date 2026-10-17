/**
 * The broker contract, one test per rule (stage 45 doc 05 phase 1).
 *
 * These rules exist because the resource on the other end is someone's real, logged-in
 * browser. The expensive failures are not crashes — they are a command reaching a browser
 * it should not have, or a waiter hanging on a browser that has gone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  BrowserBroker,
  ControllerTicketInvalid,
  ControllerUnavailable,
  ControllerCancelled,
  filterCapabilities,
  derivePrincipal,
  scopesEqual,
  type Capability,
  type ControllerScope,
  type Command,
} from './browser-broker.js';

const scope = (over: Partial<ControllerScope> = {}): ControllerScope => ({
  principal: 'p1',
  browserProfileId: 'default',
  controllerId: 'c1',
  ...over,
});

const CAPS: Capability[] = ['page.probe', 'input.mouse', 'page.info'];

/** A controller that answers immediately, the way a healthy extension would. */
function echoController(broker: BrowserBroker, result: unknown = 'ok') {
  const sent: Command[] = [];
  const send = (cmd: Command) => {
    sent.push(cmd);
    broker.complete(cmd.id, result);
  };
  return { sent, send };
}

let broker: BrowserBroker;
beforeEach(() => {
  broker = new BrowserBroker();
});

// ─── Tickets ────────────────────────────────────────────────────────────────

describe('registration tickets', () => {
  it('are single-use', () => {
    const t = broker.mintTicket(scope(), CAPS);
    expect(broker.consumeTicket(t).scope.principal).toBe('p1');
    expect(() => broker.consumeTicket(t)).toThrow(ControllerTicketInvalid);
  });

  it('reject an unknown ticket', () => {
    expect(() => broker.consumeTicket('not-a-ticket')).toThrow(
      ControllerTicketInvalid,
    );
  });

  it('expire, and an expired one is burned rather than left to probe', () => {
    vi.useFakeTimers();
    try {
      const t = broker.mintTicket(scope(), CAPS);
      vi.advanceTimersByTime(3 * 60 * 1000);
      expect(() => broker.consumeTicket(t)).toThrow(/expired/);
      // Second attempt must not leak that it was once valid.
      expect(() => broker.consumeTicket(t)).toThrow(/unknown/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carry enough entropy to be unguessable', () => {
    const t = broker.mintTicket(scope(), CAPS);
    expect(t.length).toBeGreaterThanOrEqual(32);
    const many = new Set(
      Array.from({ length: 200 }, () => broker.mintTicket(scope(), CAPS)),
    );
    expect(many.size).toBe(200);
  });
});

// ─── Capabilities ───────────────────────────────────────────────────────────

describe('capability negotiation', () => {
  it('grants base and artifact tiers', () => {
    expect(
      filterCapabilities(['page.probe', 'artifact.download'], false),
    ).toEqual(['page.probe', 'artifact.download']);
  });

  it('fails closed on the developer tier without developer mode', () => {
    expect(filterCapabilities(['page.eval', 'page.cdp'], false)).toEqual([]);
    expect(filterCapabilities(['page.eval'], true)).toEqual(['page.eval']);
  });

  it('drops capabilities the server has never heard of', () => {
    // The client's list is a request, not a grant.
    expect(
      filterCapabilities(['page.probe', 'page.wipe_disk', ''], true),
    ).toEqual(['page.probe']);
  });

  it('a capability that was not negotiated cannot be dispatched', async () => {
    const s = scope();
    broker.attach(s, ['page.info'], () => {});
    await expect(broker.dispatch(s, 'page.eval', {})).rejects.toThrow(
      ControllerUnavailable,
    );
  });
});

// ─── Identity ───────────────────────────────────────────────────────────────

describe('identity', () => {
  it('matches on every field or not at all', () => {
    const s = scope();
    broker.attach(s, CAPS, () => {});
    expect(broker.select(s, 'page.probe')).not.toBeNull();
    for (const near of [
      scope({ principal: 'p2' }),
      scope({ browserProfileId: 'other' }),
      scope({ controllerId: 'c2' }),
    ]) {
      expect(broker.select(near, 'page.probe')).toBeNull();
    }
  });

  it('cannot be spoofed by re-splitting field values', () => {
    // A naive key like `${a}:${b}:${c}` would let these two collide, and a collision
    // here is one customer's command reaching another customer's browser.
    expect(
      scopesEqual(
        { principal: 'a:b', browserProfileId: 'c', controllerId: 'd' },
        { principal: 'a', browserProfileId: 'b:c', controllerId: 'd' },
      ),
    ).toBe(false);

    // Two colliding identities must both stay attached and independently reachable.
    // Asserting only that the wrong one resolves to null is too weak: `select` also
    // re-checks scopesEqual, so it passes even with a colliding key — verified by
    // mutation. The damage a collision actually does is at ATTACH, where the second
    // controller overwrites the first and a live browser silently stops being
    // reachable while still reporting itself attached.
    const left: ControllerScope = {
      principal: 'a:b',
      browserProfileId: 'c',
      controllerId: 'd',
    };
    const right: ControllerScope = {
      principal: 'a',
      browserProfileId: 'b:c',
      controllerId: 'd',
    };
    broker.attach(left, CAPS, () => {});
    broker.attach(right, CAPS, () => {});

    expect(broker.select(left, 'page.probe')).not.toBeNull();
    expect(broker.select(right, 'page.probe')).not.toBeNull();
  });

  it('derives a principal that does not carry the owner id', () => {
    const p = derivePrincipal('91241d6a-cca8-40b7-b860-351bf553acf0');
    expect(p).not.toContain('91241d6a');
    expect(p).toBe(derivePrincipal('91241d6a-cca8-40b7-b860-351bf553acf0'));
    expect(p).not.toBe(derivePrincipal('other-owner'));
  });
});

// ─── Dispatch and completion ────────────────────────────────────────────────

describe('dispatch', () => {
  it('round-trips a result', async () => {
    const s = scope();
    const c = echoController(broker, { url: 'https://example.com' });
    broker.attach(s, CAPS, c.send);
    await expect(broker.dispatch(s, 'page.info', {})).resolves.toEqual({
      url: 'https://example.com',
    });
    expect(c.sent[0].capability).toBe('page.info');
  });

  it('tolerates a controller that completes synchronously inside its own send', async () => {
    // The waiter must be parked BEFORE send is called, or this result arrives for a
    // command nobody is waiting on and the dispatch hangs forever.
    const s = scope();
    broker.attach(s, CAPS, (c) => {
      broker.complete(c.id, 'immediate');
    });
    await expect(broker.dispatch(s, 'page.probe', {})).resolves.toBe(
      'immediate',
    );
  });

  it('completion is single-shot', async () => {
    const s = scope();
    let captured: Command | undefined;
    broker.attach(s, CAPS, (c) => {
      captured = c;
    });
    const p = broker.dispatch(s, 'page.probe', {});

    expect(broker.complete(captured!.id, 'first')).toBe(true);
    expect(broker.complete(captured!.id, 'second')).toBe(false);
    expect(broker.fail(captured!.id, 'too late')).toBe(false);
    await expect(p).resolves.toBe('first');
  });

  it('gives every command a distinct id', async () => {
    const s = scope();
    const c = echoController(broker);
    broker.attach(s, CAPS, c.send);
    await Promise.all([
      broker.dispatch(s, 'page.probe', {}),
      broker.dispatch(s, 'page.probe', {}),
    ]);
    expect(new Set(c.sent.map((x) => x.id)).size).toBe(2);
  });

  it('leaves nothing pending after a send that throws', async () => {
    const s = scope();
    broker.attach(s, CAPS, () => {
      throw new Error('socket is gone');
    });
    await expect(broker.dispatch(s, 'page.probe', {})).rejects.toThrow(
      'socket is gone',
    );
    expect(broker.pendingCount()).toBe(0);
  });

  it('refuses when no controller is attached', async () => {
    await expect(broker.dispatch(scope(), 'page.probe', {})).rejects.toThrow(
      ControllerUnavailable,
    );
  });
});

// ─── Cancellation ───────────────────────────────────────────────────────────

describe('cancellation', () => {
  it('is scoped to one tool call, not the whole browser', async () => {
    const s = scope();
    broker.attach(s, CAPS, () => {});
    const mine = broker.dispatch(s, 'page.probe', {}, { toolCallId: 'call-1' });
    const other = broker.dispatch(
      s,
      'page.probe',
      {},
      { toolCallId: 'call-2' },
    );

    expect(broker.cancel(s, 'call-1')).toBe(1);
    await expect(mine).rejects.toThrow(ControllerCancelled);
    expect(broker.pendingCount()).toBe(1);
    void other.catch(() => {});
  });

  it('does not reach another identity using the same tool call id', async () => {
    const a = scope({ controllerId: 'a' });
    const b = scope({ controllerId: 'b' });
    broker.attach(a, CAPS, () => {});
    broker.attach(b, CAPS, () => {});
    const pa = broker.dispatch(a, 'page.probe', {}, { toolCallId: 'shared' });
    const pb = broker.dispatch(b, 'page.probe', {}, { toolCallId: 'shared' });

    expect(broker.cancel(a, 'shared')).toBe(1);
    await expect(pa).rejects.toThrow(ControllerCancelled);
    expect(broker.pendingCount()).toBe(1);
    void pb.catch(() => {});
  });
});

// ─── Detach vs disconnect ───────────────────────────────────────────────────

describe('losing the controller', () => {
  it('detach fails closed — waiters are cancelled, not left hanging', async () => {
    const s = scope();
    broker.attach(s, CAPS, () => {});
    const p = broker.dispatch(s, 'page.probe', {});

    broker.detach(s);
    await expect(p).rejects.toThrow(ControllerCancelled);
    expect(broker.isAttached(s)).toBe(false);
    expect(broker.pendingCount()).toBe(0);
  });

  it("detach does not touch another identity's work", async () => {
    const a = scope({ controllerId: 'a' });
    const b = scope({ controllerId: 'b' });
    broker.attach(a, CAPS, () => {});
    broker.attach(b, CAPS, () => {});
    const pb = broker.dispatch(b, 'page.probe', {});

    broker.detach(a);
    expect(broker.pendingCount()).toBe(1);
    expect(broker.isAttached(b)).toBe(true);
    void pb.catch(() => {});
  });

  it('an OLD socket closing does not take a newer, live one offline', () => {
    // 2026-09-18: the desktop app reconnected on wake with the same controllerId; the
    // stale socket closed afterwards and the chat showed "not connected".
    const s = scope();
    const oldSend = () => {};
    const newSend = () => {};
    broker.attach(s, CAPS, oldSend);
    broker.attach(s, CAPS, newSend);
    broker.disconnect(s, oldSend);
    expect(broker.isOnline(s)).toBe(true);
    broker.disconnect(s, newSend);
    expect(broker.isOnline(s)).toBe(false);
  });

  it('disconnect is recoverable: work survives and a re-attach can still deliver it', async () => {
    // The MV3 case. A killed service worker must not lose a command that is still
    // running in a browser that is perfectly fine.
    const s = scope();
    let captured: Command | undefined;
    broker.attach(s, CAPS, (c) => {
      captured = c;
    });
    const p = broker.dispatch(s, 'page.probe', {});

    broker.disconnect(s);
    expect(broker.isOnline(s)).toBe(false);
    expect(broker.pendingCount()).toBe(1); // NOT cancelled

    // While offline, nothing new may be sent...
    await expect(broker.dispatch(s, 'page.probe', {})).rejects.toThrow(
      /offline/,
    );

    // ...and when the same identity comes back, the original result still lands.
    broker.attach(s, CAPS, () => {});
    expect(broker.isOnline(s)).toBe(true);
    expect(broker.complete(captured!.id, 'delivered after reconnect')).toBe(
      true,
    );
    await expect(p).resolves.toBe('delivered after reconnect');
  });

  it('a timed-out command is settled once and stops pending', async () => {
    vi.useFakeTimers();
    try {
      const s = scope();
      let captured: Command | undefined;
      broker.attach(s, CAPS, (c) => {
        captured = c;
      });
      const p = broker.dispatch(s, 'page.probe', {}, { timeoutMs: 1000 });
      const assertion = expect(p).rejects.toThrow(/timed out/);

      vi.advanceTimersByTime(1500);
      await assertion;
      expect(broker.pendingCount()).toBe(0);
      expect(broker.complete(captured!.id, 'late')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── The kill switch ────────────────────────────────────────────────────────
//
// stage45 doc 05, phase-4 mitigation pulled forward. The property under test is not
// "stop works" — it is "stop works when the thing being stopped is not cooperating."

describe('halt: the user kill switch', () => {
  it('cancels work in flight rather than leaving it to time out', async () => {
    const s = scope();
    broker.attach(s, CAPS, () => {
      /* a controller that never answers */
    });
    const p = broker.dispatch(s, 'page.probe', {});
    const assertion = expect(p).rejects.toThrow(ControllerCancelled);

    expect(broker.halt(s.principal)).toBe(1);
    await assertion;
    expect(broker.pendingCount()).toBe(0);
  });

  it('refuses new commands with a reason that is not "no browser connected"', async () => {
    const s = scope();
    broker.attach(s, CAPS, echoController(broker).send);
    broker.halt(s.principal);
    await expect(broker.dispatch(s, 'page.probe', {})).rejects.toThrow(
      /stopped by the user/,
    );
  });

  it('survives the extension re-attaching, which is what makes it a stop and not a pause', async () => {
    // The extension reconnects three seconds after any drop. If a halt were only a
    // detach, Stop would mean "pause for three seconds".
    const s = scope();
    broker.halt(s.principal);
    broker.attach(s, CAPS, echoController(broker).send);
    await expect(broker.dispatch(s, 'page.info', {})).rejects.toThrow(
      /stopped by the user/,
    );
    expect(broker.onlineControllersFor(s.principal)).toEqual([]);
  });

  it('is scoped to one principal — one user stopping does not stop another', async () => {
    const mine = scope();
    const theirs = scope({ principal: 'p2' });
    broker.attach(mine, CAPS, echoController(broker, 'mine').send);
    broker.attach(theirs, CAPS, echoController(broker, 'theirs').send);

    broker.halt(mine.principal);
    await expect(broker.dispatch(mine, 'page.info', {})).rejects.toThrow(
      /stopped/,
    );
    await expect(broker.dispatch(theirs, 'page.info', {})).resolves.toBe(
      'theirs',
    );
  });

  it('lifts on resume, which only a deliberate human action calls', async () => {
    const s = scope();
    broker.attach(s, CAPS, echoController(broker, 'back').send);
    broker.halt(s.principal);
    expect(broker.isHalted(s.principal)).toBe(true);

    broker.resume(s.principal);
    expect(broker.isHalted(s.principal)).toBe(false);
    broker.attach(s, CAPS, echoController(broker, 'back').send);
    await expect(broker.dispatch(s, 'page.info', {})).resolves.toBe('back');
  });
});

// ─── Finding a browser to use ───────────────────────────────────────────────

describe('onlineControllersFor', () => {
  it('lists only this principal, and only while online', () => {
    const mine = scope();
    broker.attach(mine, CAPS, () => {});
    broker.attach(
      scope({ principal: 'p2', controllerId: 'c9' }),
      CAPS,
      () => {},
    );

    expect(
      broker.onlineControllersFor('p1').map((s) => s.controllerId),
    ).toEqual(['c1']);

    broker.disconnect(mine);
    expect(broker.onlineControllersFor('p1')).toEqual([]);
  });

  it('reports nothing while halted, so a cycle cannot opt into a stopped browser', () => {
    broker.attach(scope(), CAPS, () => {});
    broker.halt('p1');
    expect(broker.onlineControllersFor('p1')).toEqual([]);
  });

  it('hands back a copy, so a caller cannot mutate the broker’s own scope', () => {
    broker.attach(scope(), CAPS, () => {});
    const [got] = broker.onlineControllersFor('p1');
    got.controllerId = 'tampered';
    expect(broker.onlineControllersFor('p1')[0].controllerId).toBe('c1');
  });
});

describe('choosing between several controllers', () => {
  /**
   * A desktop app restarted three times leaves three registrations, and a socket that
   * dies without a close frame never clears its `online` flag. Callers take the first
   * controller returned, so the ORDER decides which browser a cycle is handed.
   *
   * It used to be Map insertion order — oldest first — which is backwards: on
   * 2026-09-06 a cycle was given a controller from before an app restart, dispatched to
   * it, and reported "no browser is connected for this owner" while a live browser sat
   * attached and idle.
   */
  it('returns the most recently attached first', async () => {
    const broker = new BrowserBroker();
    const principal = derivePrincipal('multi-owner');
    const older = scope({ principal, controllerId: 'old' });
    const newer = scope({ principal, controllerId: 'new' });

    broker.attach(older, CAPS, () => {});
    // attachedAt is a millisecond clock; two attaches in the same tick would tie.
    await new Promise((r) => setTimeout(r, 5));
    broker.attach(newer, CAPS, () => {});

    expect(broker.onlineControllersFor(principal)[0]?.controllerId).toBe('new');
  });

  it('still skips a controller that is known to be offline', () => {
    // Newest-first is a tiebreak among plausible controllers, not a reason to hand
    // out one we have already been told is gone.
    const broker = new BrowserBroker();
    const principal = derivePrincipal('offline-owner');
    const gone = scope({ principal, controllerId: 'gone' });

    broker.attach(gone, CAPS, () => {});
    broker.disconnect(gone);

    expect(broker.onlineControllersFor(principal)).toEqual([]);
  });
});
