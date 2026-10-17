import type { Page } from 'playwright';
import type { Step, StepResult } from './types.js';
import { resolveTarget } from './resolver.js';
import { applyWaitFor, waitForNavigation } from './waitfor.js';
import { runVerification } from './verify.js';
import { resolveCredentialRef, hasCredentialRef } from './credential-inject.js';
import { isDangerous, requestApproval } from './escalation.js';

export interface ExecutorOptions {
  maxExternalActions?: number;
  agentId?: string;
  runId?: string;
  requireApproval?: boolean; // default true — pause on dangerous steps
  onStepStart?: (step: Step) => void;
  onStepEnd?: (step: Step, result: StepResult) => void;
}

/** Execute a list of steps against a Playwright page. */
export async function executeSteps(
  steps: Step[],
  page: Page,
  options: ExecutorOptions = {},
): Promise<StepResult[]> {
  const maxExternal = options.maxExternalActions ?? 5;
  let externalCount = 0;
  const results: StepResult[] = [];

  for (const rawStep of steps) {
    // Normalize: accept `selector` as alias for `target`
    const step: Step =
      (rawStep as any).selector && !rawStep.target
        ? { ...rawStep, target: (rawStep as any).selector }
        : rawStep;

    options.onStepStart?.(step);

    // External action budget check
    const isExternal =
      step.isExternal ||
      ['navigate'].includes(step.action) ||
      (step.action === 'click' &&
        /delete|remove|cancel|submit|send|pay|confirm/i.test(
          step.target ?? '',
        ));

    if (isExternal && externalCount >= maxExternal) {
      const result: StepResult = {
        step: step.step,
        status: 'skipped',
        error: `External action budget exhausted (max ${maxExternal})`,
      };
      results.push(result);
      options.onStepEnd?.(step, result);
      continue;
    }

    // Escalation gate — pause for human approval on dangerous actions
    if (isDangerous(step) && options.requireApproval !== false) {
      const decision = await requestApproval(
        step,
        options.agentId ?? 'unknown',
        options.runId ?? 'unknown',
      );
      if (decision === 'denied') {
        const result: StepResult = {
          step: step.step,
          status: 'skipped',
          error: 'Denied by operator — escalation gate blocked this action',
        };
        results.push(result);
        options.onStepEnd?.(step, result);
        break;
      }
    }

    const result = await executeStep(step, page);
    if (isExternal && result.status === 'success') externalCount++;

    results.push(result);
    options.onStepEnd?.(step, result);

    // Halt on failure — don't try to continue with a broken state
    if (result.status === 'failed') break;
  }

  return results;
}

/** Execute a single step. Returns StepResult. */
export async function executeStep(step: Step, page: Page): Promise<StepResult> {
  const urlBefore = page.url();

  try {
    // Pre-action wait
    if (step.waitFor) {
      await applyWaitFor(page, step.waitFor);
    }

    // Execute the action
    await dispatchAction(step, page);

    // Wait for any navigation/network activity to settle
    if (['click', 'double_click', 'navigate', 'key'].includes(step.action)) {
      await waitForNavigation(page, 3000).catch(() => undefined);
    }

    const urlAfter = page.url();

    // Post-action verification
    let verificationPassed: boolean | undefined;
    if (step.verify) {
      const vResult = await runVerification(step.verify, page);
      verificationPassed = vResult.passed;
      if (!vResult.passed) {
        return {
          step: step.step,
          status: 'failed',
          error: `Verification failed: ${vResult.reason}`,
          verificationPassed: false,
          urlAfter,
        };
      }
    }

    return {
      step: step.step,
      status: 'success',
      verificationPassed,
      urlAfter: urlAfter !== urlBefore ? urlAfter : undefined,
    };
  } catch (err) {
    return {
      step: step.step,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      urlAfter: page.url(),
    };
  }
}

async function dispatchAction(step: Step, page: Page): Promise<void> {
  switch (step.action) {
    case 'navigate': {
      if (!step.url) throw new Error('navigate action requires url');
      await page.goto(step.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      break;
    }

    case 'wait': {
      const ms = step.duration ?? 1000;
      await page.waitForTimeout(ms);
      break;
    }

    case 'screenshot': {
      // No-op in executor — caller captures screenshot separately
      break;
    }

    case 'key': {
      if (!step.key) throw new Error('key action requires key');
      await page.keyboard.press(step.key);
      break;
    }

    case 'scroll': {
      const dir = step.direction ?? 'down';
      const amt = step.amount ?? 300;
      const deltaX = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
      const deltaY = dir === 'up' ? -amt : dir === 'down' ? amt : 0;

      if (step.target) {
        const resolved = await resolveTarget(page, step.target);
        if ('x' in resolved) {
          await page.mouse.wheel(deltaX, deltaY);
        } else {
          await resolved.hover();
          await page.mouse.wheel(deltaX, deltaY);
        }
      } else {
        await page.mouse.wheel(deltaX, deltaY);
      }
      break;
    }

    case 'type': {
      if (!step.target) throw new Error('type action requires target');

      // Resolve credential if referenced — never use step.text for logged/visible data
      let typeText: string;
      if (hasCredentialRef(step.credentialRef)) {
        const credValue = await resolveCredentialRef(step.credentialRef);
        if (credValue === null)
          throw new Error(
            `Credential not found: "${step.credentialRef}". Store it first via POST /api/credentials/browser/:service`,
          );
        typeText = credValue;
      } else {
        if (step.text === undefined)
          throw new Error('type action requires text or credentialRef');
        typeText = step.text;
      }

      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved) {
        await page.mouse.click(resolved.x, resolved.y);
        await page.keyboard.type(typeText, { delay: 20 });
      } else {
        await resolved.fill(typeText);
      }
      break;
    }

    case 'clear': {
      if (!step.target) throw new Error('clear action requires target');
      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved) {
        await page.mouse.click(resolved.x, resolved.y);
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
      } else {
        await resolved.fill('');
      }
      break;
    }

    case 'select': {
      if (!step.target) throw new Error('select action requires target');
      if (!step.value) throw new Error('select action requires value');
      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved)
        throw new Error('select action cannot use coordinates');
      await resolved.selectOption(step.value);
      break;
    }

    case 'hover': {
      if (!step.target) throw new Error('hover action requires target');
      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved) {
        await page.mouse.move(resolved.x, resolved.y);
      } else {
        await resolved.hover();
      }
      break;
    }

    case 'right_click': {
      if (!step.target) throw new Error('right_click action requires target');
      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved) {
        await page.mouse.click(resolved.x, resolved.y, { button: 'right' });
      } else {
        await resolved.click({ button: 'right' });
      }
      break;
    }

    case 'double_click': {
      if (!step.target) throw new Error('double_click action requires target');
      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved) {
        await page.mouse.dblclick(resolved.x, resolved.y);
      } else {
        await resolved.dblclick();
      }
      break;
    }

    case 'click':
    default: {
      if (!step.target) throw new Error('click action requires target');
      const resolved = await resolveTarget(page, step.target);
      if ('x' in resolved) {
        await page.mouse.click(resolved.x, resolved.y);
      } else {
        await resolved.click({ timeout: 10000 });
      }
      break;
    }
  }
}
