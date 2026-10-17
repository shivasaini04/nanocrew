/**
 * Lane routing (stage 52 step 4).
 *
 * `decideLane` is pure and its bugs are silent — a wrong answer runs the wrong lane
 * rather than throwing — so the table below is deliberately exhaustive over the four
 * inputs that matter. The case that actually motivated the module is the last one in the
 * first block: `requireUserBrowser` with nothing attached must NOT fall through to the
 * container, because that is the path that runs into an auth wall and reports "no
 * results" while billing for it.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  decideLane,
  deferredForBrowser,
  laneHintFromChoice,
} from './local-lane-routing.js';

describe('decideLane', () => {
  const owned = { hasOwner: true, attachedControllerIds: [] as string[] };

  it('stays in the container when the agent asks for nothing', () => {
    expect(decideLane({ ...owned }).lane).toBe('container');
    expect(decideLane({ ...owned, useUserBrowser: false }).lane).toBe(
      'container',
    );
  });

  it('uses an attached browser when the agent prefers one', () => {
    const d = decideLane({
      ...owned,
      useUserBrowser: true,
      attachedControllerIds: ['ctl-1'],
    });
    expect(d.lane).toBe('user-browser');
    expect(d.controllerId).toBe('ctl-1');
  });

  it('falls back to the container when a PREFERENCE cannot be met', () => {
    // Today's behaviour, deliberately preserved: an agent that merely prefers the
    // real browser is better off working than waiting.
    const d = decideLane({ ...owned, useUserBrowser: true });
    expect(d.lane).toBe('container');
    expect(d.reason).toMatch(/none is connected/);
  });

  it('DEFERS when a REQUIREMENT cannot be met, instead of running blind', () => {
    // The whole point of the module. Running here would hit an auth wall, report
    // "no results", and bill for it — with nothing in the record to say why.
    const d = decideLane({ ...owned, requireUserBrowser: true });
    expect(d.lane).toBe('defer');
    expect(d.controllerId).toBeUndefined();
    expect(d.reason).toMatch(/requires the user browser/);
  });

  it('a requirement is also a request — it does not need useUserBrowser as well', () => {
    // Making callers set both would be a trap: forgetting one silently downgrades a
    // hard requirement to a preference.
    const d = decideLane({
      ...owned,
      requireUserBrowser: true,
      attachedControllerIds: ['ctl-9'],
    });
    expect(d.lane).toBe('user-browser');
    expect(d.controllerId).toBe('ctl-9');
  });

  it('takes the first controller when several are attached', () => {
    const d = decideLane({
      ...owned,
      useUserBrowser: true,
      attachedControllerIds: ['a', 'b'],
    });
    expect(d.controllerId).toBe('a');
  });

  describe('a per-run lane hint', () => {
    // The agent's flags are a habit; one job can want the opposite. An agent opted
    // into the user's browser still has work that is BETTER in the container —
    // public scraping, where the stealth stack and the datacenter IP are the point.

    it("'container' keeps a run in the container even with a browser attached", () => {
      const d = decideLane({
        ...owned,
        useUserBrowser: true,
        attachedControllerIds: ['ctl-1'],
        laneHint: 'container',
      });
      expect(d.lane).toBe('container');
      expect(d.controllerId).toBeUndefined();
      expect(d.reason).toMatch(/asked to stay in the container/);
    });

    it("'container' beats requireUserBrowser — it is an instruction, not a preference", () => {
      // Deliberate: a caller saying "this run belongs in the container" knows
      // something the agent's standing config does not, and must not be overruled
      // into a deferral.
      const d = decideLane({
        ...owned,
        requireUserBrowser: true,
        laneHint: 'container',
      });
      expect(d.lane).toBe('container');
    });

    it("'local' opts a run in even when the agent is not configured for it", () => {
      const d = decideLane({
        ...owned,
        attachedControllerIds: ['ctl-7'],
        laneHint: 'local',
      });
      expect(d.lane).toBe('user-browser');
      expect(d.controllerId).toBe('ctl-7');
    });

    it("'local' DEFERS rather than falling back, like requireUserBrowser", () => {
      // Asking for the session is asking for it. Running without would produce the
      // silent auth-wall failure this module exists to prevent.
      const d = decideLane({ ...owned, laneHint: 'local' });
      expect(d.lane).toBe('defer');
    });

    it('no hint leaves the agent configuration in charge', () => {
      expect(decideLane({ ...owned, useUserBrowser: true }).lane).toBe(
        'container',
      );
      expect(
        decideLane({
          ...owned,
          useUserBrowser: true,
          attachedControllerIds: ['a'],
        }).lane,
      ).toBe('user-browser');
    });
  });

  describe('an agent with no owner', () => {
    const orphan = { hasOwner: false, attachedControllerIds: [] as string[] };

    it('runs in the container when the browser was only a preference', () => {
      const d = decideLane({ ...orphan, useUserBrowser: true });
      expect(d.lane).toBe('container');
      expect(d.reason).toMatch(/no owner/);
    });

    it('defers, and says why, when the browser was required', () => {
      // No owner means no principal means no controller can ever match. Deferring
      // forever is bad, but running the work without the session it requires is
      // worse — and the reason has to name the real problem, which is the owner.
      const d = decideLane({ ...orphan, requireUserBrowser: true });
      expect(d.lane).toBe('defer');
      expect(d.reason).toMatch(/no owner/);
    });
  });
});

describe('deferredForBrowser', () => {
  beforeEach(() => {
    for (const e of deferredForBrowser.list())
      deferredForBrowser.clear(e.agentId);
  });

  it('remembers who is waiting, and for whose browser', () => {
    deferredForBrowser.note('agent-1', 'principal-a', 'no browser');
    expect(deferredForBrowser.isWaiting('agent-1')).toBe(true);
    expect(deferredForBrowser.size()).toBe(1);
  });

  it('wakes only the agents belonging to the principal that connected', () => {
    // Two users, one companion. Waking the wrong user's agents would run work in a
    // browser that is not theirs — the one outcome this must never produce.
    deferredForBrowser.note('a1', 'alice', 'waiting');
    deferredForBrowser.note('a2', 'alice', 'waiting');
    deferredForBrowser.note('b1', 'bob', 'waiting');

    const woken = deferredForBrowser.takeFor('alice');
    expect(woken.sort()).toEqual(['a1', 'a2']);
    expect(deferredForBrowser.isWaiting('b1')).toBe(true);
  });

  it('waking is one-shot — a second connect does not re-run the same cycle', () => {
    deferredForBrowser.note('a1', 'alice', 'waiting');
    expect(deferredForBrowser.takeFor('alice')).toEqual(['a1']);
    expect(deferredForBrowser.takeFor('alice')).toEqual([]);
  });

  it('clear removes an agent that ran or was reconfigured', () => {
    deferredForBrowser.note('a1', 'alice', 'waiting');
    deferredForBrowser.clear('a1');
    expect(deferredForBrowser.takeFor('alice')).toEqual([]);
  });

  it('re-noting the same agent does not queue it twice', () => {
    deferredForBrowser.note('a1', 'alice', 'first');
    deferredForBrowser.note('a1', 'alice', 'second');
    expect(deferredForBrowser.size()).toBe(1);
    expect(deferredForBrowser.takeFor('alice')).toEqual(['a1']);
  });
});

describe('the chat browser picker (stage 60 phase 1)', () => {
  const owned = { hasOwner: true, attachedControllerIds: [] as string[] };

  it('maps the picker to a lane hint, and anything else to none', () => {
    expect(laneHintFromChoice('local')).toBe('local');
    expect(laneHintFromChoice('cloud')).toBe('container');
    expect(laneHintFromChoice(undefined)).toBeUndefined();
    expect(laneHintFromChoice('LOCAL')).toBeUndefined();
    expect(laneHintFromChoice({})).toBeUndefined();
  });

  it('Cloud keeps the container even for an agent that requires the user browser', () => {
    const d = decideLane({
      ...owned,
      requireUserBrowser: true,
      attachedControllerIds: ['ctl-1'],
      laneHint: 'container',
      interactive: true,
    });
    expect(d.lane).toBe('container');
  });

  it('This computer uses the attached browser even when the agent never opted in', () => {
    const d = decideLane({
      ...owned,
      attachedControllerIds: ['ctl-1'],
      laneHint: 'local',
      interactive: true,
    });
    expect(d.lane).toBe('user-browser');
    expect(d.controllerId).toBe('ctl-1');
  });

  it('This computer with nothing attached tells the waiting person instead of deferring', () => {
    const d = decideLane({ ...owned, laneHint: 'local', interactive: true });
    expect(d.lane).toBe('unavailable');
    expect(d.reason).toMatch(/desktop app/);
    expect(d.reason).toMatch(/Cloud/);
  });

  it('an unattended requirement still defers, unchanged', () => {
    expect(decideLane({ ...owned, requireUserBrowser: true }).lane).toBe(
      'defer',
    );
    expect(decideLane({ ...owned, laneHint: 'local' }).lane).toBe('defer');
  });
});
