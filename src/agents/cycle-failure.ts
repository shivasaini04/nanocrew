/**
 * The error contract for cycle results (Stage 35 Phase 1).
 *
 * The orchestrator has had two incompatible definitions of failure:
 *
 *   1. Something *throws* (container crash, timeout, non-zero exit, the adapter
 *      reporting status:'error'). runCycle's catch handles this correctly —
 *      cycle marked failed, a ⚠️ bubble posted.
 *   2. Something fails *inside* the agent container. The nanoagent framework
 *      catches its own LLM/tool errors and returns a normal, exit-0 result whose
 *      text happens to be an error message. Nothing throws, so this took the
 *      success path: cycle marked 'completed', error text handed to the chat as
 *      if it were the agent's answer.
 *
 * Case 2 is what made the launch-day Recruiter incident read as a memory bug:
 * `agent_cycles.status='completed'` with `summary="Error calling LLM:
 * litellm.BadRequestError - Authentication Fails"`. The runner's result type has
 * no field that can say "this failed", so the only evidence is the text itself.
 *
 * This module is the single place that decides whether a result is a failure, so
 * "did this turn fail" has exactly one answer instead of one per code path.
 *
 * Detection is deliberately conservative. The danger is a false positive: an
 * agent whose actual job is debugging will legitimately *write about* errors
 * ("I fixed the AuthenticationError in auth.ts"), and marking that cycle failed
 * would be worse than the bug we're fixing. So an error signature alone is never
 * enough — it only counts when the result carries no real answer alongside it.
 */

/**
 * Signatures of an LLM/provider failure surfacing as result text. These are tested
 * against the FIRST non-empty line only (see looksLikeErrorText) — a failed turn
 * *opens* with the framework's error because that's all it produced, whereas an
 * agent that quotes an error while answering ("The logs show: Error calling LLM…,
 * I retried and it worked") has it buried mid-reply. Scanning every line instead
 * flags that second case as a failure, which is the false positive this contract
 * most needs to avoid.
 */
const ERROR_SIGNATURES: RegExp[] = [
  /^Error calling LLM\b/i,
  /^litellm\.\w*(?:Error|Exception)\b/i,
  /^(?:openai|anthropic|litellm)\.[A-Za-z]*Error\b/i,
  /^\w*(?:Error|Exception):\s/i,
  /^Traceback \(most recent call last\)/i,
  /^(?:Authentication|RateLimit|BadRequest|APIConnection|APITimeout|InternalServer|ServiceUnavailable)Error\b/i,
  /^Agent execution failed\b/i,
];

/** The runner result shape — see CycleRunner.run in agent-service.ts. */
export interface CycleRunResult {
  summary: string;
  reply?: string;
  cost: number;
  tasksDone: number;
}

export interface CycleFailure {
  /** Human-readable failure text, suitable for a chat error bubble and cycle summary. */
  message: string;
  /** Why we classified it — 'no_output' | 'error_text' | 'malformed_output'. */
  reason: 'no_output' | 'error_text' | 'malformed_output';
}

/**
 * Leaked model-internal markup: a provider emitting a batch of tool calls (or other
 * control structure) as literal text in .content instead of its structured tool_calls
 * field (observed 2026-08-17 on DeepSeek — `<DSMLtool_calls><DSMLinvoke name="...">...`).
 * The provider layer now recovers real tool calls from this shape (see
 * litellm_provider.py's _parse_pseudo_xml_tool_calls), but a *different* model/provider
 * leaking a *different* tag vocabulary the same way would slip past that fix silently —
 * this is the generic backstop: if the tags are all that's left once stripped, whatever
 * produced them isn't a real answer.
 */
const LEAKED_MARKUP_RE =
  /<\/?[\w｜|]*(?:invoke|tool_calls?|DSML|parameter)\b[^>]*>|<\|[^|>]*\|>|<｜[^｜>]*｜>/gi;

/**
 * Does this text *open* with a framework/provider error rather than an agent's answer?
 * Judged on the first non-empty line only — see ERROR_SIGNATURES for why.
 */
export function looksLikeErrorText(text: string | undefined | null): boolean {
  const firstLine = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return false;
  return ERROR_SIGNATURES.some((re) => re.test(firstLine));
}

/**
 * Strip the meta scaffolding the runner wraps around a reply, so a reply that is
 * *only* an error message doesn't read as "real answer present". The runner's
 * extractReply() appends `**Accomplished:**\n<summary>` to the body, so an errored
 * cycle's reply can be the error text twice over — body and summary — and still be
 * a non-empty "reply" by a naive check.
 */
function replyBody(reply: string | undefined, summary: string): string {
  let body = (reply ?? '').trim();
  if (!body) return '';
  // Drop the appended "**Accomplished:** <summary>" trailer.
  body = body.replace(/\*\*Accomplished:\*\*\s*[\s\S]*$/i, '').trim();
  // If what's left is just the summary restated, there's no independent answer.
  if (summary.trim() && body === summary.trim()) return '';
  return body;
}

/**
 * Classify a runner result. Returns a CycleFailure if this turn failed, or null if
 * it genuinely succeeded.
 *
 * A result is a failure when the agent produced no usable answer, i.e.:
 *   - there is no output at all (empty reply and empty/placeholder summary), or
 *   - the only thing the result carries is error text.
 *
 * A result with a real answer is a success even if it *mentions* an error — that's
 * an agent reporting on its work, not a broken turn.
 */
export function detectResultFailure(
  result: CycleRunResult,
): CycleFailure | null {
  const summary = (result.summary ?? '').trim();
  const body = replyBody(result.reply, summary);

  // The runner's extractSummary() substitutes this when the container returned no
  // text at all, so it carries no information — treat it as absence, not an answer.
  const placeholderSummary = /^cycle completed\.?$/i.test(summary);
  const effectiveSummary = placeholderSummary ? '' : summary;

  if (!body && !effectiveSummary) {
    return {
      message: 'The agent produced no output for this turn.',
      reason: 'no_output',
    };
  }

  // Error text with no real answer beside it → the turn failed. Check the body and
  // the summary independently: the launch-day shape had the error only in summary
  // (extractSummary falls back to the output's last non-empty line), while a
  // framework error returned as the whole response puts it in both.
  const bodyIsError = looksLikeErrorText(body);
  const summaryIsError = looksLikeErrorText(effectiveSummary);
  if ((bodyIsError || summaryIsError) && !(body && !bodyIsError)) {
    const message = (bodyIsError ? body : effectiveSummary).slice(0, 500);
    return { message, reason: 'error_text' };
  }

  // Leaked markup with nothing else: strip every tag-shaped fragment from whichever
  // text is present and see if any real prose survives. A real answer that happens to
  // quote a tag keeps plenty of surrounding text; a leaked control structure doesn't.
  // .replace() on a global regex resets lastIndex to 0 at the start of each call (per
  // spec), so these two calls are independent — but a stray .test() on the same regex
  // object would inherit leftover lastIndex and silently miss matches, so length-diff
  // is used below instead of re-testing the regex.
  const strippedBody = body.replace(LEAKED_MARKUP_RE, '').trim();
  const strippedSummary = effectiveSummary.replace(LEAKED_MARKUP_RE, '').trim();
  const hadMarkup =
    strippedBody.length < body.length ||
    strippedSummary.length < effectiveSummary.length;
  if (hadMarkup && strippedBody.length < 15 && strippedSummary.length < 15) {
    const raw = (body || effectiveSummary).slice(0, 500);
    return {
      message: `The agent's output was leaked internal markup, not an answer: ${raw}`,
      reason: 'malformed_output',
    };
  }

  return null;
}
