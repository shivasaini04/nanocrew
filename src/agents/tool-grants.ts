/**
 * What `config.tools` means for an agent.
 *
 * Every agent has the whole tool registry. There is no per-agent allowlist: stage 54 built
 * one and stage 55 switched it on for all six live agents (2026-09-08), and on 2026-09-14
 * the owner had it removed — it had quietly withheld `emit_artifact` from Mechanic when it
 * was asked, in so many words, to "create the artifact", and no agent could ever pick up a
 * tool it had not already used, because the allowlist was built from past usage.
 *
 * `config.tools` is now only two things:
 *  - what the model sees from turn one with deferred tools on (resolveAdvertisedTools)
 *  - the owner's permission for the few tools that reach a person OUTSIDE the system
 *    (OUTBOUND_TOOLS). Those stay withheld unless declared — granted by the owner, or
 *    self-granted through an approved check-in — because a sent email cannot be unsent.
 */
import { getAgent } from '../db.js';

/**
 * Tools that reach a real person. An agent holds one only if its owner put it in
 * `config.tools`, directly or by approving the agent's own request (POST /self/tools).
 * Everything else is available to every agent.
 */
export const OUTBOUND_TOOLS = new Set([
  'smtp_send',
  'gmail_send',
  'send_whatsapp',
  'voice_call',
  'send_message_to_agent',
]);

/**
 * Tools every agent needs. Refused when an agent tries to drop them from its own list or
 * disable them in its runtime settings: that would not restrict the agent, it would break
 * it — it could not read its own workspace, record what it did, or say it was stuck.
 */
export const ALWAYS_GRANTED = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'append_file',
  'list_dir',
  'glob_search',
  'grep_search',
  'todo_write',
  'search_memory',
  'append_memory',
  'search_knowledge',
  'tool_search',
  'list_tools',
  'clarify',
  'self_manage',
  'self_report',
  'reply_to_handoff',
  'find_agent',
  'borrow_tool',
  'ask_agent',
  'enter_plan_mode',
  'exit_plan_mode',
  'emit_artifact',
]);

/**
 * The outbound tools this agent's owner has NOT granted — withdrawn from its cycle.
 *
 * Checked 2026-09-14 against every agent: only Seeker and Crawler had ever called one,
 * and both declare what they call, so this withholds nothing anyone was using.
 */
export function resolveWithheldTools(agentId: string): string[] {
  const agent = getAgent(agentId);
  if (!agent) return [...OUTBOUND_TOOLS].sort();
  const declared = new Set(agent.config.tools ?? []);
  return [...OUTBOUND_TOOLS].filter((t) => !declared.has(t)).sort();
}

/**
 * Which tools this agent's model should SEE from turn one, deferral or not.
 *
 * With DEFERRED_TOOLS=on only a CORE set is sent to the model; everything else waits for
 * tool_search. For a source agent that means its whole job — yc_jobs, linkedin_jobs —
 * starts invisible. Measured 2026-09-10 on Crawler: asked to "call yc_jobs", the GLM
 * model called a tool that was not in its schema list, the provider could not turn that
 * into a structured call, and it leaked out as text. The loop read the text as a final
 * answer and ended the cycle with zero tools run — twice in a row (a528ec02, 83011180).
 *
 * The owner naming a tool in config.tools is the plainest possible signal that it is part
 * of this agent's job: an agent does not go looking for a tool it does not know it has.
 */
export function resolveAdvertisedTools(agentId: string): string[] {
  const agent = getAgent(agentId);
  if (!agent) return [];
  const declared = agent.config.tools ?? [];
  return [
    ...new Set(
      declared.filter(
        (t): t is string => typeof t === 'string' && t.length > 0,
      ),
    ),
  ].sort();
}
