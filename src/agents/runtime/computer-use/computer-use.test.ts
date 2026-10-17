import { describe, test, expect, vi } from 'vitest';
import { classifyStep, buildLogEntry } from './action-log.js';
import { isCoordinate } from './resolver.js';
import { runVerification } from './verify.js';
import { isDangerous } from './escalation.js';
import { ComputerUseArgsSchema, StepSchema } from './types.js';
import type { Step, StepResult } from './types.js';

// ─── classifyStep ─────────────────────────────────────────────────────────────

describe('classifyStep', () => {
  test('navigate is read', () => {
    const step: Step = {
      step: 1,
      action: 'navigate',
      url: 'https://example.com',
    };
    expect(classifyStep(step)).toBe('read');
  });

  test('screenshot is read', () => {
    const step: Step = { step: 1, action: 'screenshot' };
    expect(classifyStep(step)).toBe('read');
  });

  test('type is write', () => {
    const step: Step = {
      step: 1,
      action: 'type',
      target: '#email',
      text: 'user@example.com',
    };
    expect(classifyStep(step)).toBe('write');
  });

  test('click on submit is external', () => {
    const step: Step = { step: 1, action: 'click', target: '#submit' };
    expect(classifyStep(step)).toBe('external');
  });

  test('click on nav link is write', () => {
    const step: Step = { step: 1, action: 'click', target: '.nav-link' };
    expect(classifyStep(step)).toBe('write');
  });

  test('explicit isExternal overrides action', () => {
    const step: Step = {
      step: 1,
      action: 'click',
      target: '#confirm',
      isExternal: true,
    };
    expect(classifyStep(step)).toBe('external');
  });
});

// ─── isCoordinate ─────────────────────────────────────────────────────────────

describe('isCoordinate', () => {
  test('detects "640,360"', () => expect(isCoordinate('640,360')).toBe(true));
  test('detects "[640,360]"', () =>
    expect(isCoordinate('[640,360]')).toBe(true));
  test('detects "640, 360" with space', () =>
    expect(isCoordinate('640, 360')).toBe(true));
  test('rejects CSS selector', () =>
    expect(isCoordinate('#submit')).toBe(false));
  test('rejects text label', () => expect(isCoordinate('Sign In')).toBe(false));
  test('rejects partial number', () => expect(isCoordinate('640')).toBe(false));
});

// ─── runVerification ──────────────────────────────────────────────────────────

describe('runVerification', () => {
  function mockPage(url: string, selectorVisible = false, bodyText = '') {
    return {
      url: () => url,
      locator: (_sel: string) => ({
        first: () => ({
          isVisible: (_opts?: object) => Promise.resolve(selectorVisible),
        }),
        count: () => Promise.resolve(selectorVisible ? 1 : 0),
      }),
      evaluate: (_fn: () => string) => Promise.resolve(bodyText),
    } as any;
  }

  test('urlContains passes when URL matches', async () => {
    const page = mockPage('https://app.example.com/dashboard');
    const result = await runVerification({ urlContains: '/dashboard' }, page);
    expect(result.passed).toBe(true);
  });

  test('urlContains fails when URL does not match', async () => {
    const page = mockPage('https://app.example.com/login');
    const result = await runVerification({ urlContains: '/dashboard' }, page);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('urlContains');
  });

  test('elementVisible passes when element is visible', async () => {
    const page = mockPage('https://example.com', true);
    const result = await runVerification({ elementVisible: '.success' }, page);
    expect(result.passed).toBe(true);
  });

  test('elementVisible fails when element is not visible', async () => {
    const page = mockPage('https://example.com', false);
    const result = await runVerification({ elementVisible: '.success' }, page);
    expect(result.passed).toBe(false);
  });

  test('multiple assertions all must pass', async () => {
    const page = mockPage('https://app.example.com/dashboard', false);
    const result = await runVerification(
      { urlContains: '/dashboard', elementVisible: '.header' },
      page,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('elementVisible');
  });

  test('empty spec always passes', async () => {
    const page = mockPage('https://example.com');
    const result = await runVerification({}, page);
    expect(result.passed).toBe(true);
  });
});

// ─── isDangerous ──────────────────────────────────────────────────────────────

describe('isDangerous', () => {
  test('non-external step is never dangerous', () => {
    const step: Step = {
      step: 1,
      action: 'click',
      target: '#delete-account',
      isExternal: false,
    };
    expect(isDangerous(step)).toBe(false);
  });

  test('external click on delete URL is dangerous', () => {
    const step: Step = {
      step: 1,
      action: 'click',
      url: '/account/delete',
      isExternal: true,
    };
    expect(isDangerous(step)).toBe(true);
  });

  test('external click on cancel-account URL is dangerous', () => {
    const step: Step = {
      step: 1,
      action: 'navigate',
      url: '/close-account',
      isExternal: true,
    };
    expect(isDangerous(step)).toBe(true);
  });

  test('external navigate to safe URL is not dangerous', () => {
    const step: Step = {
      step: 1,
      action: 'navigate',
      url: '/dashboard',
      isExternal: true,
    };
    expect(isDangerous(step)).toBe(false);
  });

  test('external click on "deactivate" target is dangerous', () => {
    const step: Step = {
      step: 1,
      action: 'click',
      target: '[data-action="deactivate"]',
      isExternal: true,
    };
    expect(isDangerous(step)).toBe(true);
  });
});

// ─── Zod schema validation ────────────────────────────────────────────────────

describe('StepSchema', () => {
  test('valid navigate step parses', () => {
    const raw = { step: 1, action: 'navigate', url: 'https://example.com' };
    const parsed = StepSchema.parse(raw);
    expect(parsed.action).toBe('navigate');
    expect(parsed.url).toBe('https://example.com');
  });

  test('valid type step with credentialRef parses', () => {
    const raw = {
      step: 2,
      action: 'type',
      target: '#password',
      credentialRef: 'github:password',
    };
    const parsed = StepSchema.parse(raw);
    expect(parsed.credentialRef).toBe('github:password');
  });

  test('invalid action throws', () => {
    expect(() =>
      StepSchema.parse({ step: 1, action: 'launch_missile' }),
    ).toThrow();
  });
});

describe('ComputerUseArgsSchema', () => {
  test('minimal valid args parse', () => {
    const raw = {
      task: 'Open GitHub',
      steps: [{ step: 1, action: 'navigate', url: 'https://github.com' }],
    };
    const parsed = ComputerUseArgsSchema.parse(raw);
    expect(parsed.task).toBe('Open GitHub');
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.maxExternalActions).toBe(5); // default
  });

  test('empty steps array parses (tool validates at runtime)', () => {
    const raw = { task: 'Test', steps: [] };
    expect(() => ComputerUseArgsSchema.parse(raw)).not.toThrow();
  });
});

// ─── buildLogEntry credential redaction ──────────────────────────────────────

describe('buildLogEntry credential redaction', () => {
  const dummyResult: StepResult = { step: 2, status: 'success' };

  test('text step logs text as-is', () => {
    const step: Step = {
      step: 2,
      action: 'type',
      target: '#email',
      text: 'user@example.com',
    };
    const entry = buildLogEntry(step, dummyResult, 'run1', 'agent1');
    expect(entry.action.text).toBe('user@example.com');
  });

  test('credentialRef step redacts text in log', () => {
    const step: Step = {
      step: 2,
      action: 'type',
      target: '#password',
      credentialRef: 'github:password',
    };
    const entry = buildLogEntry(step, dummyResult, 'run1', 'agent1');
    expect(entry.action.text).toBe('[CREDENTIAL_REDACTED]');
  });
});
