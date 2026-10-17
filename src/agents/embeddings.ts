/**
 * Embeddings — Stage 34 memory redesign, Gap 3/4.
 *
 * Thin wrapper around litellm's OpenAI-compatible /v1/embeddings endpoint (gemini/text-embedding-004,
 * configured in litellm_config.yaml). Every caller degrades gracefully to `null` when no litellm proxy
 * is configured (BYOK-only deployments, local dev without LITELLM_PROXY_KEY) — callers must treat a
 * null embedding as "fall back to keyword/substring matching", never as a hard failure.
 */
import { embed, embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { logger } from '../logger.js';

const EMBEDDING_MODEL_ID = 'gemini/gemini-embedding-001';
// Same char cap style as memory-distiller's extraction prompt — embedding inputs are single
// memory/query strings, not whole episode logs, so this is a generous safety cap, not a real limit.
const MAX_INPUT_CHARS = 8000;

function getEmbeddingModel() {
  const proxyUrl = process.env.LITELLM_PROXY_URL || '';
  const proxyKey = process.env.LITELLM_PROXY_KEY;
  if (!proxyUrl || !proxyKey) return null;
  const proxy = createOpenAI({ apiKey: proxyKey, baseURL: `${proxyUrl}/v1` });
  return proxy.embedding(EMBEDDING_MODEL_ID);
}

/** Embed a single string. Returns null if no embedding provider is configured or the call fails. */
export async function embedText(text: string): Promise<Float32Array | null> {
  const model = getEmbeddingModel();
  if (!model) return null;
  const value = text.slice(0, MAX_INPUT_CHARS);
  if (!value.trim()) return null;
  try {
    const { embedding } = await embed({ model, value });
    return Float32Array.from(embedding);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[embeddings] embedText failed',
    );
    return null;
  }
}

/**
 * Embed several strings in one batched call. Returns one entry per input, preserving order;
 * entries are null individually only if the whole batch call fails (embedMany fails atomically).
 */
export async function embedTexts(
  texts: string[],
): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  const model = getEmbeddingModel();
  if (!model) return texts.map(() => null);
  try {
    const { embeddings } = await embedMany({
      model,
      values: texts.map((t) => t.slice(0, MAX_INPUT_CHARS) || ' '),
    });
    return embeddings.map((e) => Float32Array.from(e));
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        count: texts.length,
      },
      '[embeddings] embedTexts failed',
    );
    return texts.map(() => null);
  }
}

/** Pack a Float32Array into a Buffer for storage in a SQLite BLOB column. */
export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a SQLite BLOB column back into a Float32Array. */
export function blobToEmbedding(buf: Buffer): Float32Array {
  // Buffers read back from better-sqlite3 are freshly allocated and 4-byte aligned from offset 0,
  // but slice defensively via byteOffset/byteLength anyway — cheap and avoids any assumption drift.
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.byteLength / 4),
  );
}

/** Cosine similarity in [-1, 1]; 0 if either vector is degenerate (all-zero). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
