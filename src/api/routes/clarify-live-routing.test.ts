/**
 * Stage 49 phase 3 — where a check-in reply is delivered.
 *
 * `clarify` now blocks inside the running cycle waiting for its answer, instead of
 * ending the run and picking the answer up on a later one. That creates a routing
 * decision this predicate owns: a reply to a question a live cycle is still sitting on
 * must be handed to that cycle, because passing it to `processFeedback` would start a
 * SECOND cycle to answer a question the first has not finished asking.
 *
 * The deadline is what keeps it honest in both directions. Inside it, a cycle is
 * waiting. Past it, the cycle has given up or been killed by CONTAINER_TIMEOUT and
 * nothing is polling — so the reply must go down the normal path or it would be
 * recorded and silently never acted on, which is the exact failure shape this whole
 * stage keeps turning up.
 */

import { describe, it, expect } from 'vitest';
import { isLiveClarifyAwaitingReply } from './agents.js';

const future = () => JSON.stringify({ awaitUntil: Date.now() + 60_000 });
const past = () => JSON.stringify({ awaitUntil: Date.now() - 60_000 });

describe('isLiveClarifyAwaitingReply', () => {
  it('routes to the waiting cycle while the deadline holds', () => {
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'clarify_live',
        action_payload: future(),
      }),
    ).toBe(true);
  });

  it('falls back to the normal path once the deadline has passed', () => {
    // The cycle has given up by now. Answering must still reach the agent somehow,
    // just on a later cycle — never nowhere.
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'clarify_live',
        action_payload: past(),
      }),
    ).toBe(false);
  });

  it('leaves ordinary check-ins alone', () => {
    // request_approval drafts and every other check-in still go through
    // processFeedback exactly as before — this phase must not reroute them.
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'send_email',
        action_payload: future(),
      }),
    ).toBe(false);
    expect(
      isLiveClarifyAwaitingReply({ action_type: null, action_payload: null }),
    ).toBe(false);
  });

  it('treats an unparseable or deadline-less payload as nobody waiting', () => {
    // Fail towards delivering the answer: the worst case here is a slightly slower
    // reply, where the other way round is a human answer that goes nowhere.
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'clarify_live',
        action_payload: 'not json',
      }),
    ).toBe(false);
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'clarify_live',
        action_payload: '{}',
      }),
    ).toBe(false);
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'clarify_live',
        action_payload: null,
      }),
    ).toBe(false);
    expect(
      isLiveClarifyAwaitingReply({
        action_type: 'clarify_live',
        action_payload: JSON.stringify({ awaitUntil: 'soon' }),
      }),
    ).toBe(false);
  });
});
