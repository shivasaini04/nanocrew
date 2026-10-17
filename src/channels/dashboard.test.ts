import { describe, it, expect } from 'vitest';
import { isConversationalTurn } from './dashboard.js';

/**
 * The safety property that matters here is asymmetric: a false negative is free (the turn
 * runs the task path, exactly as it did before this router existed), while a false
 * positive strips the task framing off real work. So the tests below care much more about
 * "work is never misread as chat" than about catching every chat message.
 */
describe('isConversationalTurn', () => {
  const plain = { hasProject: false, hasFiles: false };

  it('treats short questions and acknowledgements as conversation', () => {
    expect(
      isConversationalTurn('what did you get done yesterday?', plain),
    ).toBe(true);
    expect(isConversationalTurn('thanks, that looks right', plain)).toBe(true);
    expect(isConversationalTurn('who is levelsio?', plain)).toBe(true);
    expect(isConversationalTurn('why did that one score so low', plain)).toBe(
      true,
    );
  });

  it('routes work requests to the task path', () => {
    expect(isConversationalTurn('draft a reply to that post', plain)).toBe(
      false,
    );
    expect(isConversationalTurn('update the tracker', plain)).toBe(false);
    expect(
      isConversationalTurn('find me five more prospects on HN', plain),
    ).toBe(false);
    expect(isConversationalTurn('send the DM', plain)).toBe(false);
  });

  it('never treats a project turn as conversation — the conversational prompt drops project context', () => {
    expect(
      isConversationalTurn('how is it going?', {
        hasProject: true,
        hasFiles: false,
      }),
    ).toBe(false);
  });

  it('never treats a turn carrying file references as conversation', () => {
    expect(
      isConversationalTurn('what is this?', {
        hasProject: false,
        hasFiles: true,
      }),
    ).toBe(false);
  });

  it('falls back to the task path for long messages, where intent is least certain', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    expect(isConversationalTurn(long, plain)).toBe(false);
  });

  it('ignores empty input rather than treating it as chat', () => {
    expect(isConversationalTurn('   ', plain)).toBe(false);
  });
});
