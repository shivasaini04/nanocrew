import type { Page } from 'playwright';
import type { VerifySpec, VerificationResult } from './types.js';

/** Run all assertions in a VerifySpec against the current page state. */
export async function runVerification(
  spec: VerifySpec,
  page: Page,
): Promise<VerificationResult> {
  const failures: string[] = [];

  if (spec.urlContains) {
    const url = page.url();
    if (!url.includes(spec.urlContains)) {
      failures.push(`urlContains: expected "${spec.urlContains}" in "${url}"`);
    }
  }

  if (spec.elementVisible) {
    try {
      const locator = page.locator(spec.elementVisible);
      const visible = await locator
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (!visible)
        failures.push(
          `elementVisible: "${spec.elementVisible}" not found or not visible`,
        );
    } catch {
      failures.push(`elementVisible: error checking "${spec.elementVisible}"`);
    }
  }

  if (spec.elementAbsent) {
    try {
      const locator = page.locator(spec.elementAbsent);
      const count = await locator.count();
      if (count > 0) {
        const visible = await locator
          .first()
          .isVisible()
          .catch(() => false);
        if (visible)
          failures.push(
            `elementAbsent: "${spec.elementAbsent}" is still visible`,
          );
      }
    } catch {
      failures.push(`elementAbsent: error checking "${spec.elementAbsent}"`);
    }
  }

  if (spec.textPresent) {
    try {
      const bodyText = await page.evaluate(
        (): string => (globalThis as any).document?.body?.innerText ?? '',
      );
      if (!bodyText.includes(spec.textPresent)) {
        failures.push(`textPresent: "${spec.textPresent}" not found in page`);
      }
    } catch {
      failures.push(`textPresent: could not read page text`);
    }
  }

  return failures.length === 0
    ? { passed: true }
    : { passed: false, reason: failures.join('; ') };
}
