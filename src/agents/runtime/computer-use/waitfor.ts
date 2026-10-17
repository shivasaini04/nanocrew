import type { Page } from 'playwright';
import type { WaitForSpec } from './types.js';

/** Wait for an element to reach the specified state before proceeding. */
export async function applyWaitFor(
  page: Page,
  waitFor: WaitForSpec,
): Promise<void> {
  const timeout = waitFor.timeout ?? 10000;
  const state = waitFor.state ?? 'visible';

  if (waitFor.selector) {
    await page.waitForSelector(waitFor.selector, { state, timeout });
    return;
  }

  // If no selector specified, just wait for page to be stable
  await page.waitForLoadState('domcontentloaded', { timeout });
}

/** Wait for navigation to complete after an action. */
export async function waitForNavigation(
  page: Page,
  timeout = 5000,
): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch {
    // networkidle can time out on SPAs — that's OK, page content loaded
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 2000 });
    } catch {
      // best effort
    }
  }
}

/** Wait for a URL change from the current URL. */
export async function waitForUrlChange(
  page: Page,
  currentUrl: string,
  timeout = 5000,
): Promise<boolean> {
  try {
    await page.waitForFunction(
      (url: string) => (globalThis as any).location?.href !== url,
      currentUrl,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}
