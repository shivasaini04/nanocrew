/**
 * Answering a check-in — the one path, whoever answers.
 *
 * Until stage 64 the dashboard's respond route was the only way to answer, so its body
 * was the answering logic. Phase 1 adds a second surface (a reply on the owner's
 * WhatsApp), and two copies of "is a cycle still waiting on this?" would drift the way the
 * two check-in creation routes once did (see approval-apply.ts). Both surfaces call this.
 */
import { getCheckinById, updateAgentCheckin } from '../db.js';
import { getSocketIO } from '../api/instances.js';
import { agentService } from './agent-registry.js';

/**
 * True when this check-in is a `clarify` question asked from a cycle that is still
 * blocked waiting for the answer (stage 49 phase 3).
 *
 * The cycle writes its own give-up time into `action_payload.awaitUntil` when it asks.
 * Reading a deadline the asker recorded — rather than tracking live cycles here — keeps
 * this a pure function of the row: no registry to leak, nothing to reconcile if the
 * orchestrator restarts mid-question, and a stale row simply reads as "not waiting".
 */
export function isLiveClarifyAwaitingReply(checkin: {
  action_type?: string | null;
  action_payload?: string | null;
}): boolean {
  // Stage 60 phase 3: a batch-send approval blocks its run the same way a question does.
  if (
    checkin.action_type !== 'clarify_live' &&
    checkin.action_type !== 'batch_send_live'
  )
    return false;
  try {
    const payload = JSON.parse(checkin.action_payload ?? '{}');
    const awaitUntil = Number(payload?.awaitUntil);
    return Number.isFinite(awaitUntil) && Date.now() < awaitUntil;
  } catch {
    // An unparseable payload means we cannot show a cycle is waiting, so fall
    // through to the normal path rather than dropping the human's answer.
    return false;
  }
}

export type RespondOutcome =
  | { ok: true; deliveredTo: 'live-cycle' | 'feedback' }
  | { ok: false; reason: 'not_found' | 'already_responded' };

/**
 * Record the owner's answer and act on it. `reply` is what the dashboard buttons send:
 * 'approve', 'reject', or free text.
 *
 * The status check and processFeedback's own "mark responded" run in the same tick with no
 * await between them, so a dashboard click and a WhatsApp reply arriving together cannot
 * both act — the second sees `responded`.
 */
export async function respondToCheckin(
  agentId: string,
  checkinId: string,
  reply: string,
  actionPayloadOverride?: string,
): Promise<RespondOutcome> {
  const checkin = getCheckinById(checkinId);
  if (!checkin || checkin.agent_id !== agentId)
    return { ok: false, reason: 'not_found' };
  if (checkin.status === 'responded')
    return { ok: false, reason: 'already_responded' };

  // Stage 49 phase 3. A `clarify` question asked from inside a running cycle is
  // waiting for this answer *in that cycle* — it polls this check-in with the
  // browser still open. Handing it to processFeedback would start a SECOND cycle
  // to answer a question the first one is still sitting on, so the reply is just
  // recorded and the waiting cycle picks it up.
  //
  // The deadline is what makes this safe to get wrong. Past it, the cycle has
  // given up (or was killed by CONTAINER_TIMEOUT) and nothing is polling, so a
  // late answer must go down the normal path or it would vanish silently — the
  // failure mode this whole stage keeps finding.
  if (isLiveClarifyAwaitingReply(checkin)) {
    updateAgentCheckin(checkinId, {
      status: 'responded',
      user_reply: reply,
      responded_at: new Date().toISOString(),
    });
    getSocketIO()?.emit('agent:checkin_responded', { agentId, checkinId });
    return { ok: true, deliveredTo: 'live-cycle' };
  }

  await agentService.processFeedback(
    agentId,
    checkinId,
    reply,
    actionPayloadOverride,
  );
  getSocketIO()?.emit('agent:checkin_responded', { agentId, checkinId });
  return { ok: true, deliveredTo: 'feedback' };
}
