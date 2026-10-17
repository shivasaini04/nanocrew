/**
 * A cycle is badged "YOUR BROWSER" only if a command really reached it.
 *
 * The dashboard renders that badge with the tooltip "This cycle drove the browser on your
 * machine" — a definite claim about someone's own laptop. It was written up front from the
 * ROUTING decision, which was the same thing as actual use only while the lane was a
 * per-cycle property.
 *
 * `identity` ended that. An opted-in cycle now routinely sweeps hundreds of public pages
 * in the container and never touches the user's browser at all, and every one of those
 * cycles would have carried the badge. That is the shape CLAUDE.md keeps recording: a
 * record asserting a fact that has moved, believed because nothing marked it stale — and
 * the shape of `reference_effector_ledger_fake_approval`, where a signed ledger logged
 * "auto-approved" for clicks a human had actually been asked about.
 *
 * So the row starts at 'container' and the dispatch route promotes it. These tests are
 * about the promotion being earned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const updates: Array<{ id: string; lane?: string }> = [];

vi.mock('../../db.js', () => ({
  getAgent: (id: string) => ({ id, owner_id: 'owner-1' }),
  updateAgentCycle: (id: string, u: { lane?: string }) => {
    updates.push({ id, ...u });
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const dispatch = vi.fn();
vi.mock('../../agents/browser-broker.js', () => ({
  browserBroker: {
    dispatch: (...args: unknown[]) => dispatch(...args),
    isAttached: () => true,
    isOnline: () => true,
  },
  derivePrincipal: (ownerId: string) => `user:${ownerId}`,
  class_ControllerUnavailable: null,
  ControllerUnavailable: class ControllerUnavailable extends Error {},
}));

const { issueCycleToken, revokeCycleToken } =
  await import('../../agents/cycle-token.js');
const { browserControlDispatchRouter } =
  await import('./browser-control-dispatch.js');

/** Drive the router's POST handler directly — no HTTP server needed for this question. */
async function post(
  agentId: string,
  token: string | undefined,
  body: Record<string, unknown>,
) {
  const layer = (
    browserControlDispatchRouter as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Function }>;
        };
      }>;
    }
  ).stack.find(
    (l) =>
      l.route?.path === '/:id/browser-control/dispatch' && l.route.methods.post,
  );
  if (!layer?.route) throw new Error('dispatch route not found');

  const req = {
    params: { id: agentId },
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    query: {},
  };
  let payload: unknown;
  let status = 200;
  const res = {
    json: (v: unknown) => {
      payload = v;
      return res;
    },
    status: (s: number) => {
      status = s;
      return res;
    },
  };
  await layer.route.stack[0].handle(req, res, () => {});
  return { status, payload };
}

const BODY = { capability: 'page.info', controllerId: 'ctrl-1', payload: {} };

describe('cycle lane attribution', () => {
  beforeEach(() => {
    updates.length = 0;
    dispatch.mockReset();
    dispatch.mockResolvedValue({ url: 'https://example.test/' });
  });

  it('promotes the cycle when a command actually reaches the browser', async () => {
    const token = issueCycleToken('agent-1', 'cycle-1');
    const { status } = await post('agent-1', token, BODY);

    expect(status).toBe(200);
    expect(updates).toEqual([{ id: 'cycle-1', lane: 'user-browser' }]);
    revokeCycleToken(token);
  });

  it('writes once however many commands the cycle sends', async () => {
    // The promotion sits on the hot path — every click, every snapshot. A DB write per
    // command would be a real cost for a claim that cannot change once it is true.
    const token = issueCycleToken('agent-2', 'cycle-2');
    for (let i = 0; i < 25; i++) await post('agent-2', token, BODY);

    expect(updates).toHaveLength(1);
    revokeCycleToken(token);
  });

  it('does NOT promote when the dispatch fails', async () => {
    // A command that never arrived is not use of the browser. This is the case that
    // matters: "nobody is connected" is the normal state of a laptop at 3am, and a
    // cycle that tried and could not must not be recorded as having succeeded.
    dispatch.mockRejectedValue(new Error('no controller attached'));
    const token = issueCycleToken('agent-3', 'cycle-3');
    const { status } = await post('agent-3', token, BODY);

    expect(status).toBeGreaterThanOrEqual(400);
    expect(updates).toEqual([]);
    revokeCycleToken(token);
  });

  it('does NOT promote a request that failed the token gate', async () => {
    // Rejected before the broker is reached, so there is nothing to attribute. Asserted
    // rather than assumed: the promotion reads the same token the gate does, and an
    // ordering slip would attribute a browser to a caller that was refused one.
    const { status } = await post('agent-4', 'not-a-real-token', BODY);

    expect(status).toBe(401);
    expect(updates).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
