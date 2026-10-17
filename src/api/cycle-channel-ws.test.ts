/**
 * Phase 5.2 — the orchestrator's end of the cycle channel.
 *
 * The socket carries frames up and, from 5.3, input down. Two properties matter enough
 * to pin: who is allowed to open one, and that a cycle reconnecting mid-run does not
 * end up with its channel unregistered by the close of the socket it replaced.
 *
 * `resolveCycleToken` is the auth. It is tested here rather than only in cycle-token's
 * own suite because *this* is the caller that decided to trust one secret instead of a
 * token plus a claimed cycle id, and that decision is what makes the socket unspoofable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  issueCycleToken,
  revokeCycleToken,
  resolveCycleToken,
} from '../agents/cycle-token.js';
import {
  isCycleChannelOpen,
  sendToCycle,
  agentForCycleChannel,
} from './cycle-channel-ws.js';

describe('resolveCycleToken — the channel’s authentication', () => {
  it('names both the agent and the cycle, so the socket claims nothing beside its secret', () => {
    const token = issueCycleToken('agent-1', 'cycle-1');
    expect(resolveCycleToken(token)).toEqual({
      agentId: 'agent-1',
      cycleId: 'cycle-1',
    });
    revokeCycleToken(token);
  });

  it('refuses a revoked token, so a socket cannot outlive its run', () => {
    const token = issueCycleToken('agent-1', 'cycle-1');
    revokeCycleToken(token);
    expect(resolveCycleToken(token)).toBeNull();
  });

  it('refuses nothing-at-all rather than treating it as anonymous', () => {
    expect(resolveCycleToken(undefined)).toBeNull();
    expect(resolveCycleToken(null)).toBeNull();
    expect(resolveCycleToken('')).toBeNull();
    expect(resolveCycleToken('not-a-token')).toBeNull();
  });

  it('does not let one cycle’s token resolve to another cycle', () => {
    const a = issueCycleToken('agent-1', 'cycle-A');
    const b = issueCycleToken('agent-2', 'cycle-B');
    expect(resolveCycleToken(a)?.cycleId).toBe('cycle-A');
    expect(resolveCycleToken(b)?.agentId).toBe('agent-2');
    revokeCycleToken(a);
    revokeCycleToken(b);
  });
});

describe('the registry, with nothing connected', () => {
  beforeEach(() => {
    // No sockets are opened in this suite; these are the answers every caller gets
    // before a cycle has dialled in, and they must be safe rather than throwing.
  });

  it('reports a cycle with no channel as closed', () => {
    expect(isCycleChannelOpen('cycle-that-never-connected')).toBe(false);
  });

  it('reports a failed send rather than throwing', () => {
    // 5.3 reads this as "the run ended under you" and tells the human, instead of
    // an exception surfacing inside a socket handler.
    expect(sendToCycle('cycle-that-never-connected', { t: 'release' })).toBe(
      false,
    );
  });

  it('has no agent for an unknown cycle, so an ownership check cannot pass by accident', () => {
    expect(agentForCycleChannel('cycle-that-never-connected')).toBeNull();
  });
});
