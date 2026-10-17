/**
 * Approval rules: the owner's standing "may I do this without asking?" answers.
 * The properties that matter are the ones a wrong rule would break silently.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateApproval,
  makeRule,
  validateRule,
  actionForCheckin,
  isLoosening,
  type ApprovalRule,
} from './approval-policy.js';

const rule = (r: Partial<ApprovalRule>) => makeRule(r, 'owner');

describe('evaluateApproval', () => {
  it('no rule means ask, exactly as before rules existed', () => {
    expect(evaluateApproval([], 'email', { recipient: 'a@b.com' })).toBeNull();
  });

  it("'owner' matches only the owner's own address", () => {
    const rules = [
      rule({
        action: 'email',
        match: { recipient: 'owner' },
        decision: 'auto',
      }),
    ];
    expect(
      evaluateApproval(
        rules,
        'email',
        { recipient: 'Me@Mine.com' },
        'me@mine.com',
      )?.decision,
    ).toBe('auto');
    expect(
      evaluateApproval(
        rules,
        'email',
        { recipient: 'lead@acme.com' },
        'me@mine.com',
      ),
    ).toBeNull();
  });

  it('a recipient rule applies only when EVERY address matches', () => {
    const rules = [
      rule({
        action: 'email',
        match: { recipient: 'owner' },
        decision: 'auto',
      }),
    ];
    expect(
      evaluateApproval(
        rules,
        'email',
        { recipient: 'me@mine.com, lead@acme.com' },
        'me@mine.com',
      ),
    ).toBeNull();
  });

  it('a specific ask beats a general auto', () => {
    const rules = [
      rule({ action: 'email', decision: 'auto' }),
      rule({
        action: 'email',
        match: { recipient: '@competitor.com' },
        decision: 'ask',
      }),
    ];
    expect(
      evaluateApproval(rules, 'email', { recipient: 'ceo@competitor.com' })
        ?.decision,
    ).toBe('ask');
    expect(
      evaluateApproval(rules, 'email', { recipient: 'lead@acme.com' })
        ?.decision,
    ).toBe('auto');
  });

  it('site rules match the domain and its subdomains, not look-alikes', () => {
    const rules = [
      rule({
        action: 'browser_step',
        match: { site: 'linkedin.com' },
        decision: 'auto',
      }),
    ];
    expect(
      evaluateApproval(rules, 'browser_step', {
        site: 'https://www.linkedin.com/feed',
      })?.decision,
    ).toBe('auto');
    expect(
      evaluateApproval(rules, 'browser_step', {
        site: 'https://evil-linkedin.com/',
      }),
    ).toBeNull();
  });

  it('a rule for one action never covers another', () => {
    const rules = [rule({ action: 'email', decision: 'auto' })];
    expect(evaluateApproval(rules, 'batch_send')).toBeNull();
  });
});

describe('validateRule', () => {
  it('refuses a scope the action does not have', () => {
    expect(
      validateRule({
        action: 'budget_raise',
        decision: 'auto',
        match: { recipient: 'owner' },
      }),
    ).toMatch(/no recipient/);
  });
  it('refuses an unknown action', () => {
    expect(validateRule({ action: 'credentials', decision: 'auto' })).toMatch(
      /action must be one of/,
    );
  });
});

describe('actionForCheckin', () => {
  it('maps email check-ins to the email action with their recipient', () => {
    expect(actionForCheckin('smtp_send', { to: 'me@mine.com' })).toEqual({
      action: 'email',
      ctx: { recipient: 'me@mine.com' },
    });
  });
  it('leaves questions and unknown kinds alone', () => {
    expect(actionForCheckin('clarify_live', {})).toBeNull();
    expect(actionForCheckin(null, {})).toBeNull();
  });
});

describe('isLoosening', () => {
  it('adding auto or removing ask loosens; the reverse tightens', () => {
    expect(
      isLoosening({ add: rule({ action: 'email', decision: 'auto' }) }),
    ).toBe(true);
    expect(
      isLoosening({ add: rule({ action: 'email', decision: 'ask' }) }),
    ).toBe(false);
    expect(
      isLoosening({ remove: rule({ action: 'email', decision: 'ask' }) }),
    ).toBe(true);
    expect(
      isLoosening({ remove: rule({ action: 'email', decision: 'auto' }) }),
    ).toBe(false);
  });
});
