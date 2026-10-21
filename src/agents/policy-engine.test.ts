/**
 * The built-in policy rules must only react to their own events.
 *
 * Found 2026-10-21 on a local stack: 'alert-stale-branch' used `when: always`, so at
 * priority 8 it matched every lane event. Each failed cycle showed "Agent branch is stale
 * against main" and the priority-5 'escalate-after-three-consecutive-failures' rule could
 * never fire, because the first matching rule wins.
 */
import { describe, it, expect, vi } from 'vitest';
import { PolicyEngine, type ActionHandler } from './policy-engine.js';
import type { LaneEvent, LaneState } from './lane-events.js';

function handler() {
  return {
    retryAgentCycle: vi.fn(async () => {}),
    recoverOnce: vi.fn(async () => {}),
    notify: vi.fn(async (_channel: string, _text: string) => {}),
    blockLane: vi.fn(),
  } satisfies ActionHandler;
}

const redState = { currentStatus: 'red', redStreak: 3 } as unknown as LaneState;

describe('built-in policy rules', () => {
  it('a failed turn does not raise the stale-branch alert', async () => {
    const h = handler();
    const event = {
      type: 'TurnFailed',
      agentId: 'a1',
      lane: 'custom',
    } as unknown as LaneEvent;
    await new PolicyEngine(h).evaluate(event, redState);
    const texts = h.notify.mock.calls.map((c) => c[1]);
    expect(texts.join(' ')).not.toMatch(/stale against main/i);
  });

  it('three failures in a row reach the escalation rule', async () => {
    const h = handler();
    const event = {
      type: 'TurnFailed',
      agentId: 'a1',
      lane: 'custom',
    } as unknown as LaneEvent;
    await new PolicyEngine(h).evaluate(event, redState);
    expect(h.notify).toHaveBeenCalledWith(
      'dashboard',
      expect.stringMatching(/failed 3\+ consecutive cycles/),
    );
  });

  it('a stale branch still raises the stale-branch alert', async () => {
    const h = handler();
    const event = {
      type: 'BranchStaleAgainstMain',
      agentId: 'a1',
      lane: 'custom',
      behindBy: 4,
      ts: '2026-10-21T00:00:00.000Z',
    } as unknown as LaneEvent;
    await new PolicyEngine(h).evaluate(event, undefined);
    expect(h.notify).toHaveBeenCalledWith(
      'dashboard',
      expect.stringMatching(/stale against main/i),
    );
  });
});
