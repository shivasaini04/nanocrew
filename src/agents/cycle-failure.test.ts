/**
 * Stage 35 Phase 1 — the error contract.
 *
 * The cases below are the real result shapes the runner can produce, derived from
 * nanobot-cycle-runner's extractSummary/extractReply (a missing <summary> tag falls
 * back to the output's last non-empty line; extractReply appends
 * "**Accomplished:** <summary>" to the body). The launch-day incident is the first
 * failure case; the false-positive guards are the last block and matter just as
 * much — wrongly marking a good cycle failed would be worse than the silent bug.
 */
import { describe, it, expect } from 'vitest';
import { detectResultFailure, looksLikeErrorText } from './cycle-failure.js';

const ok = { cost: 0, tasksDone: 1 };

describe('detectResultFailure — failures', () => {
  it('catches the launch-day shape: LLM auth error in summary, no reply', () => {
    // Exactly what was in agent_cycles for the Recruiter cycles: status 'completed',
    // summary carrying the provider error, nothing for the chat to show.
    const failure = detectResultFailure({
      ...ok,
      summary:
        'Error calling LLM: litellm.BadRequestError: DeepseekException - Authentication Fails, Your api key is invalid',
      reply: '',
    });
    expect(failure).not.toBeNull();
    expect(failure!.reason).toBe('error_text');
    expect(failure!.message).toContain('Authentication Fails');
  });

  it('catches the error-as-whole-response shape (error in both body and summary)', () => {
    // When the framework returns the error as the entire response, extractSummary
    // takes its last line and extractReply appends it back as "**Accomplished:**".
    const summary =
      'Error calling LLM: litellm.APIConnectionError: connection refused';
    const failure = detectResultFailure({
      ...ok,
      summary,
      reply: `${summary}\n\n**Accomplished:**\n${summary}`,
    });
    expect(failure).not.toBeNull();
    expect(failure!.reason).toBe('error_text');
  });

  it('catches total silence — no reply, and summary is the placeholder', () => {
    // extractSummary returns 'Cycle completed' when the container emitted no text.
    // That carries no information, so it must not count as an answer.
    const failure = detectResultFailure({
      ...ok,
      summary: 'Cycle completed',
      reply: '',
    });
    expect(failure).not.toBeNull();
    expect(failure!.reason).toBe('no_output');
  });

  it('catches an empty result outright', () => {
    expect(detectResultFailure({ ...ok, summary: '', reply: '' })!.reason).toBe(
      'no_output',
    );
    expect(detectResultFailure({ ...ok, summary: '' })!.reason).toBe(
      'no_output',
    );
  });

  it('catches a reply that is only the restated summary error', () => {
    const summary = 'Agent execution failed: RuntimeError in tool dispatch';
    const failure = detectResultFailure({
      ...ok,
      summary,
      reply: `**Accomplished:**\n${summary}`,
    });
    expect(failure!.reason).toBe('error_text');
  });

  it('catches a python traceback returned as result text', () => {
    const failure = detectResultFailure({
      ...ok,
      summary:
        'Traceback (most recent call last)\n  File "agent.py", line 3\nValueError: bad',
      reply: '',
    });
    expect(failure!.reason).toBe('error_text');
  });

  it('catches the DSML leaked-markup shape verbatim (2026-08-17 prod incident)', () => {
    // agent_cycles for db084798-4af7-43fe-92d8-7a3f32b090de: status 'completed', summary
    // was literally this string — a batch of tool calls a provider emitted as text
    // instead of structured tool_calls. Nothing usable for chat or memory.
    const failure = detectResultFailure({
      ...ok,
      summary: '</｜｜DSML｜｜tool_calls>',
      reply: '',
    });
    expect(failure).not.toBeNull();
    expect(failure!.reason).toBe('malformed_output');
  });

  it('catches a different tag vocabulary leaking the same way', () => {
    const failure = detectResultFailure({
      ...ok,
      summary:
        '<invoke name="read_file"><parameter name="path">/a</parameter></invoke>',
      reply: '',
    });
    expect(failure!.reason).toBe('malformed_output');
  });
});

describe('detectResultFailure — successes (false-positive guards)', () => {
  it('does not flag an agent REPORTING that it fixed an error', () => {
    // A debugging agent legitimately writes about errors. Flagging this would be a
    // worse bug than the one we are fixing.
    expect(
      detectResultFailure({
        ...ok,
        summary: 'Fixed the AuthenticationError in auth.ts',
        reply:
          'I found the AuthenticationError was caused by a stale key and fixed it.\n\n**Accomplished:**\nFixed the AuthenticationError in auth.ts',
      }),
    ).toBeNull();
  });

  it('does not flag a real answer that quotes an error it encountered', () => {
    expect(
      detectResultFailure({
        ...ok,
        summary: 'Investigated the outage',
        reply:
          'The logs show:\nError calling LLM: rate limited\nI retried and it succeeded, so the pipeline is healthy now.',
      }),
    ).toBeNull();
  });

  it('does not flag an ordinary successful cycle', () => {
    expect(
      detectResultFailure({
        ...ok,
        summary: 'Found 12 qualified leads',
        reply:
          'I found 12 leads.\n\n**Accomplished:**\nFound 12 qualified leads',
      }),
    ).toBeNull();
  });

  it('does not flag a summary-only success (no conversational reply)', () => {
    // Scheduled cycles often have no reply — only a work summary. That is success.
    expect(
      detectResultFailure({
        ...ok,
        summary: 'Sent 7 outreach emails',
        reply: '',
      }),
    ).toBeNull();
  });

  it('does not flag a real answer that happens to quote a tag', () => {
    // Plenty of real prose survives stripping the tag fragment — this is someone
    // describing the bug, not the bug itself.
    expect(
      detectResultFailure({
        ...ok,
        summary:
          'Fixed the pseudo-XML leak where <invoke name="read_file"> showed up as chat text',
        reply: '',
      }),
    ).toBeNull();
  });
});

describe('looksLikeErrorText', () => {
  it('matches framework error output at line start', () => {
    expect(looksLikeErrorText('Error calling LLM: boom')).toBe(true);
    expect(looksLikeErrorText('litellm.AuthenticationError: nope')).toBe(true);
    expect(looksLikeErrorText('Agent execution failed: x')).toBe(true);
  });

  it('ignores empty text and ordinary prose', () => {
    expect(looksLikeErrorText('')).toBe(false);
    expect(looksLikeErrorText(undefined)).toBe(false);
    expect(
      looksLikeErrorText('I handled the error gracefully and moved on.'),
    ).toBe(false);
  });

  it('matches the job-path failure verbatim — the string job-worker now gates on', () => {
    // Copied byte-for-byte from prod job_1784282660066_09749629's result_text, which was
    // stored under status 'completed'. The job path checks only the CONTAINER's exit
    // status, and nanoagent exits 0 while returning its LLM error as ordinary result
    // text, so this reached the user as an agent answer and triggered the "completed
    // successfully — ask follow-up questions" summary cycle. job-worker gates on this
    // function now; if this string ever stops matching, that gate silently reopens.
    const prodResult =
      'Error calling LLM: litellm.BadRequestError: DeepseekException - ' +
      '{"error":{"message":"Invalid assistant message: content or tool_calls must be set",' +
      '"type":"invalid_request_error","param":null,"code":"invalid_request_error"}}';
    expect(looksLikeErrorText(prodResult)).toBe(true);
  });

  it('does not fail a job that merely reports an error it dealt with', () => {
    // The false positive that would be worse than the bug: jobs whose whole purpose is
    // fixing errors must still be able to complete.
    expect(
      looksLikeErrorText(
        'Fixed the site. The build was throwing Error calling LLM on every request; ' +
          'I pinned the model and it passes now.',
      ),
    ).toBe(false);
  });
});
