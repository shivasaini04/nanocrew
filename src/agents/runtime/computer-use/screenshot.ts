import type { Page } from 'playwright';

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
}

/** Take a JPEG screenshot of the current page, scaled to 1280×720 viewport. */
export async function takeScreenshot(page: Page): Promise<ScreenshotResult> {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

  return {
    base64: buffer.toString('base64'),
    width: viewport.width,
    height: viewport.height,
    capturedAt: new Date().toISOString(),
  };
}

/** Take a screenshot and return the base64 string. */
export async function screenshotBase64(page: Page): Promise<string> {
  const result = await takeScreenshot(page);
  return result.base64;
}

/** Extract readable text content from the page for LLM verification. */
export async function extractPageText(page: Page): Promise<string> {
  try {
    const text = await page.evaluate((): string => {
      /* eslint-disable no-undef */
      const body = (globalThis as any).document?.body;
      if (!body) return '';
      const clone = body.cloneNode(true) as any;
      clone
        .querySelectorAll?.('script, style, noscript')
        .forEach((el: any) => el.remove());
      return ((clone.innerText || clone.textContent || '') as string)
        .replace(/\s+/g, ' ')
        .trim();
    });
    return text.slice(0, 3000);
  } catch {
    return '(could not extract page text)';
  }
}
