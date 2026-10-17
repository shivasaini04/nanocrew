import type { Page, Locator } from 'playwright';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import { screenshotBase64 } from './screenshot.js';
import { resolveTargetViaOcr } from './ocr.js';
import { readEnvFile } from '../../../env.js';
import { logger } from '../../../logger.js';

/**
 * Five-layer element resolver:
 *   1. Coordinate pair "x,y" — direct pixel click
 *   2. CSS selector
 *   3. Accessibility label (role + text + placeholder)
 *   4. Vision fallback — screenshot → LLM → coordinates, with scroll-to-find loop
 *   5. OCR fallback — Tesseract text extraction → word match → coordinates
 */
export async function resolveTarget(
  page: Page,
  target: string,
): Promise<Locator | { x: number; y: number }> {
  // Layer 1 — coordinate pair "x,y" or "[x,y]"
  const coordMatch = target.match(
    /^\[?(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\]?$/,
  );
  if (coordMatch) {
    return { x: parseFloat(coordMatch[1]), y: parseFloat(coordMatch[2]) };
  }

  // Layer 2 — try as CSS selector
  try {
    const locator = page.locator(target);
    const count = await locator.count();
    if (count > 0) return locator.first();
  } catch {
    // Not a valid CSS selector, fall through
  }

  // Layer 3 — a11y: getByRole, getByLabel, getByText, getByPlaceholder
  const a11yLocator = await tryA11yResolver(page, target);
  if (a11yLocator) return a11yLocator;

  // Layer 3b — text match
  const textLocator = page.getByText(target, { exact: false });
  const textCount = await textLocator.count();
  if (textCount > 0) return textLocator.first();

  // Layer 4 — vision fallback: screenshot → LLM → pixel coordinates (with scroll-to-find)
  logger.debug(
    { target },
    'resolver: CSS/a11y/text all failed — trying vision fallback',
  );
  const visionCoords = await resolveTargetViaVision(page, target);
  if (visionCoords) {
    logger.debug(
      { target, coords: visionCoords },
      'resolver: vision fallback succeeded',
    );
    return visionCoords;
  }

  // Layer 5 — OCR fallback: Tesseract text extraction → text match → coordinates
  logger.debug({ target }, 'resolver: vision failed — trying OCR fallback');
  const base64 = await screenshotBase64(page);
  const ocrCoords = await resolveTargetViaOcr(base64, target);
  if (ocrCoords) {
    logger.debug(
      { target, coords: ocrCoords },
      'resolver: OCR fallback succeeded',
    );
    return ocrCoords;
  }

  throw new Error(
    `Could not resolve target: "${target}" — no matching element found via CSS, a11y, text, vision, or OCR`,
  );
}

// ─── Vision fallback ──────────────────────────────────────────────────────────

function getVisionModel() {
  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'MOONSHOT_KIMI_API_KEY',
    'GROQ_API_KEY',
  ]);
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY || env['ANTHROPIC_API_KEY'];
  const groqKey = process.env.GROQ_API_KEY || env['GROQ_API_KEY'];
  const geminiKey = process.env.GEMINI_API_KEY || env['GEMINI_API_KEY'];
  const moonshotKey =
    process.env.MOONSHOT_KIMI_API_KEY || env['MOONSHOT_KIMI_API_KEY'];

  // Priority: Anthropic → Groq Llama-4 Finder → Gemini → Moonshot
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    return anthropic('claude-haiku-4-5-20251001');
  }
  if (groqKey) {
    const groq = createGroq({ apiKey: groqKey });
    return groq('meta-llama/llama-4-scout-17b-16e-instruct');
  }
  if (geminiKey) {
    const gemini = createOpenAI({
      apiKey: geminiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    });
    return gemini.chat('gemini-2.0-flash');
  }
  if (moonshotKey) {
    const ms = createOpenAI({
      apiKey: moonshotKey,
      baseURL: 'https://api.moonshot.cn/v1',
    });
    return ms.chat('moonshot-v1-8k');
  }
  return null;
}

// ─── Phase 3: scroll-to-find wrapper ─────────────────────────────────────────

async function resolveTargetViaVision(
  page: Page,
  description: string,
  maxScrolls = 5,
): Promise<{ x: number; y: number } | null> {
  const model = getVisionModel();
  if (!model) return null;

  for (let scroll = 0; scroll <= maxScrolls; scroll++) {
    if (scroll > 0) {
      const viewportH = page.viewportSize()?.height ?? 720;
      await page.mouse.wheel(0, viewportH);
      await page.waitForTimeout(400); // let lazy content settle
    }

    const coords = await queryVisionOnce(model, page, description, scroll);
    if (coords) {
      if (scroll > 0)
        logger.debug(
          { target: description, scroll },
          'resolver: vision found after scroll',
        );
      return coords;
    }
  }

  // Scrolled all the way down without finding it — scroll back to top
  await page.evaluate(() => (globalThis as any).window?.scrollTo(0, 0));
  return null;
}

// ─── Single vision LLM query ─────────────────────────────────────────────────

async function queryVisionOnce(
  model: ReturnType<typeof getVisionModel>,
  page: Page,
  description: string,
  scrollAttempt: number,
): Promise<{ x: number; y: number } | null> {
  if (!model) return null;

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const base64 = await screenshotBase64(page);

  const prompt = `The browser viewport is ${viewport.width}×${viewport.height} pixels.
Find the UI element matching this description: "${description}"
If the element is NOT visible in this screenshot, return exactly: {"found": false}
If it IS visible, return ONLY a JSON object with its center pixel coordinates — no explanation, no markdown:
{"x": number, "y": number}`;

  try {
    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: base64 },
            { type: 'text', text: prompt },
          ],
        },
      ],
      maxOutputTokens: 64,
    });

    const cleaned = text
      .replace(/```(?:json)?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);

    // Explicit not-found signal
    if (parsed.found === false) return null;

    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return {
        x: Math.max(0, Math.min(viewport.width, Math.round(parsed.x))),
        y: Math.max(0, Math.min(viewport.height, Math.round(parsed.y))),
      };
    }
  } catch (err) {
    if (scrollAttempt === 0) {
      // Only log on first attempt to avoid repeating the same error for each scroll
      logger.warn(
        { target: description, err },
        'resolver: vision LLM call failed',
      );
    }
  }
  return null;
}

async function tryA11yResolver(
  page: Page,
  target: string,
): Promise<Locator | null> {
  // Detect role patterns like "button:Sign In" or just try common roles
  const roleMatch = target.match(
    /^(button|link|textbox|checkbox|radio|combobox|menuitem|tab|heading):\s*(.+)$/i,
  );
  if (roleMatch) {
    const [, role, name] = roleMatch;
    const locator = page.getByRole(
      role as Parameters<typeof page.getByRole>[0],
      { name },
    );
    if ((await locator.count()) > 0) return locator.first();
  }

  // Try getByLabel for form inputs
  const labelLocator = page.getByLabel(target, { exact: false });
  if ((await labelLocator.count()) > 0) return labelLocator.first();

  // Try getByPlaceholder
  const placeholderLocator = page.getByPlaceholder(target, { exact: false });
  if ((await placeholderLocator.count()) > 0) return placeholderLocator.first();

  return null;
}

/** Check if target is a coordinate pair (returns true if "x,y" format). */
export function isCoordinate(target: string): boolean {
  return /^\[?(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\]?$/.test(target);
}
