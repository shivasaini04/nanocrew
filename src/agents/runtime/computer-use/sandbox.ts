import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { loadSession, saveSession } from './session.js';

export interface SandboxOptions {
  sessionsDir?: string;
  sessionDomain?: string;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface SandboxHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stop: () => Promise<void>;
}

/**
 * Launch a Playwright browser sandbox.
 * Loads a saved session if sessionDomain is provided.
 * Browser is destroyed when stop() is called.
 */
export async function startSandbox(
  options: SandboxOptions = {},
): Promise<SandboxHandle> {
  const headless = options.headless ?? true;
  const width = options.viewportWidth ?? 1280;
  const height = options.viewportHeight ?? 720;

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptDownloads: false,
  });

  // Restore saved session if provided
  if (options.sessionDomain && options.sessionsDir) {
    await loadSession(context, options.sessionDomain, options.sessionsDir);
  }

  const page = await context.newPage();

  const stop = async (): Promise<void> => {
    // Save session before closing if domain was provided
    if (options.sessionDomain && options.sessionsDir) {
      try {
        await saveSession(context, options.sessionDomain, options.sessionsDir);
      } catch {
        /* best effort */
      }
    }
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  };

  return { browser, context, page, stop };
}
