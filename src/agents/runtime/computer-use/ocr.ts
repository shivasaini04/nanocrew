/**
 * Phase 4 — OCR fallback using Tesseract.js.
 *
 * Called after vision LLM + scroll-to-find both fail.
 * Extracts text blocks with bounding boxes from a screenshot,
 * scores each block against the target description, and returns
 * the center coords of the best match.
 *
 * Best for: text buttons, links, labels, image-embedded text.
 * Not designed for finding blank input fields — use vision for those.
 */
import { createWorker } from 'tesseract.js';
import { logger } from '../../../logger.js';

export interface OcrMatch {
  text: string;
  x: number;
  y: number;
  confidence: number;
}

/**
 * Run OCR on a base64 JPEG screenshot and find the element
 * described by `description`. Returns center coords of the
 * best matching text block, or null if nothing scores well enough.
 */
export async function resolveTargetViaOcr(
  base64Image: string,
  description: string,
  minConfidence = 0.4,
): Promise<{ x: number; y: number } | null> {
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;

  try {
    worker = await createWorker('eng', 1, {
      // Suppress Tesseract progress logs
      logger: () => {},
    });

    const imageBuffer = Buffer.from(base64Image, 'base64');
    const result = await worker.recognize(imageBuffer);
    const data = result.data as any;

    const words: any[] = data.words ?? [];
    const lines: any[] = data.lines ?? [];

    if (words.length === 0) return null;

    const descWords = tokenize(description);
    let bestScore = 0;
    let bestMatch: OcrMatch | null = null;

    for (const word of words) {
      if (!word.text.trim() || word.confidence < 30) continue;

      const score = scoreMatch(word.text, descWords);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          text: word.text,
          x: Math.round((word.bbox.x0 + word.bbox.x1) / 2),
          y: Math.round((word.bbox.y0 + word.bbox.y1) / 2),
          confidence: score,
        };
      }
    }

    // Also check multi-word lines for better phrase matching
    for (const line of lines) {
      const lineText = (line.words ?? []).map((w: any) => w.text).join(' ');
      if (!lineText.trim()) continue;

      const score = scoreMatch(lineText, descWords);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          text: lineText,
          x: Math.round((line.bbox.x0 + line.bbox.x1) / 2),
          y: Math.round((line.bbox.y0 + line.bbox.y1) / 2),
          confidence: score,
        };
      }
    }

    if (bestMatch && bestMatch.confidence >= minConfidence) {
      logger.debug(
        {
          target: description,
          matched: bestMatch.text,
          score: bestMatch.confidence.toFixed(2),
          coords: { x: bestMatch.x, y: bestMatch.y },
        },
        'resolver: OCR fallback matched',
      );
      return { x: bestMatch.x, y: bestMatch.y };
    }

    return null;
  } catch (err) {
    logger.warn({ target: description, err }, 'resolver: OCR fallback failed');
    return null;
  } finally {
    await worker?.terminate();
  }
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  // Strip stop words and punctuation, lowercase
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'for',
    'of',
    'in',
    'on',
    'at',
    'to',
    'and',
    'or',
    'is',
    'it',
    'this',
    'that',
    'input',
    'field',
    'button',
    'box',
    'area',
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
}

function scoreMatch(candidate: string, descWords: string[]): number {
  if (descWords.length === 0) return 0;
  const candLower = candidate.toLowerCase();
  let hits = 0;
  for (const word of descWords) {
    if (candLower.includes(word)) hits++;
  }
  return hits / descWords.length;
}
