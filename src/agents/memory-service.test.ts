/**
 * Stage 40 — every memory gets an embedding, whoever writes it.
 *
 * The distiller passed one; nothing else did. So `append_memory` — the tool an agent uses to
 * record a lesson *during* work — wrote `embedding = NULL`, and those rows are invisible to
 * `deduplicateMemories()` (it filters on `embedding != null`) and to the supersession gate.
 * The agent's own lessons were the ones its memory system could least see.
 *
 * The embed is deliberately off the response path, so these tests await the microtask/timer
 * queue rather than the call itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  created: [] as Array<{ id: string; content: string }>,
  embeddingSet: new Map<string, Buffer>(),
  embedImpl: null as
    | null
    | ((texts: string[]) => Promise<(Float32Array | null)[]>),
}));

vi.mock('../db.js', () => ({
  createAgentMemory: vi.fn((mem: any, embedding?: Buffer | null) => {
    const row = {
      id: `mem-${h.created.length}`,
      ...mem,
      embedding: embedding ?? null,
    };
    h.created.push(row);
    return row;
  }),
  deleteAgentMemory: vi.fn(),
  getMemoryByAgent: vi.fn(() => []),
  setMemoryEmbedding: vi.fn((id: string, buf: Buffer) => {
    h.embeddingSet.set(id, buf);
  }),
}));

vi.mock('./embeddings.js', async () => {
  const actual =
    await vi.importActual<typeof import('./embeddings.js')>('./embeddings.js');
  return {
    ...actual,
    embedTexts: vi.fn((texts: string[]) =>
      h.embedImpl
        ? h.embedImpl(texts)
        : Promise.resolve(texts.map(() => Float32Array.from([1, 2, 3]))),
    ),
  };
});

const { recordMemory, recordMemories } = await import('./memory-service.js');

/** Let setImmediate + the awaited embed promise inside it run to completion. */
const drain = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  h.created.length = 0;
  h.embeddingSet.clear();
  h.embedImpl = null;
  vi.clearAllMocks();
});

afterEach(() => {
  h.embedImpl = null;
});

describe('recordMemory', () => {
  it('embeds a memory whose caller supplied none (the append_memory path)', async () => {
    const mem = recordMemory(
      'agent-1',
      { type: 'lesson', content: 'role inboxes reach a support desk' },
      { syncNow: false },
    );
    expect(h.embeddingSet.size).toBe(0); // not on the response path
    await drain();
    expect(h.embeddingSet.has(mem.id)).toBe(true);
    expect(h.embeddingSet.get(mem.id)!.byteLength).toBe(12); // 3 float32s
  });

  it('does not re-embed when the caller already supplied one (the distiller path)', async () => {
    const supplied = Buffer.from(new Float32Array([9, 9, 9]).buffer);
    const mem = recordMemory(
      'agent-1',
      { type: 'lesson', content: 'x', embedding: supplied },
      { syncNow: false },
    );
    await drain();
    expect(h.embeddingSet.has(mem.id)).toBe(false);
  });

  it('keeps the row when embedding fails — degraded, not lost', async () => {
    h.embedImpl = () => Promise.resolve([null]);
    const mem = recordMemory(
      'agent-1',
      { type: 'lesson', content: 'y' },
      { syncNow: false },
    );
    await drain();
    expect(h.created.find((r) => r.id === mem.id)).toBeTruthy();
    expect(h.embeddingSet.has(mem.id)).toBe(false);
  });

  it('does not throw out of the write path when the provider rejects', async () => {
    h.embedImpl = () => Promise.reject(new Error('provider down'));
    const mem = recordMemory(
      'agent-1',
      { type: 'lesson', content: 'z' },
      { syncNow: false },
    );
    await drain();
    expect(h.created.find((r) => r.id === mem.id)).toBeTruthy();
    expect(h.embeddingSet.has(mem.id)).toBe(false);
  });
});

describe('recordMemories', () => {
  it('embeds only the entries that arrived without one', async () => {
    const supplied = Buffer.from(new Float32Array([7, 7, 7]).buffer);
    const saved = recordMemories('agent-1', [
      { type: 'lesson', content: 'a' },
      { type: 'lesson', content: 'b', embedding: supplied },
      { type: 'lesson', content: 'c' },
    ]);
    await drain();

    expect(h.embeddingSet.has(saved[0].id)).toBe(true);
    expect(h.embeddingSet.has(saved[1].id)).toBe(false); // already had one
    expect(h.embeddingSet.has(saved[2].id)).toBe(true);
  });

  it('pairs each embedding with the right row when some are pre-supplied', async () => {
    // Guards the index-alignment bug: filtering out pre-embedded entries must not shift the
    // remaining contents against their ids.
    h.embedImpl = (texts) =>
      Promise.resolve(texts.map((t) => Float32Array.from([t.charCodeAt(0)])));
    const supplied = Buffer.from(new Float32Array([7]).buffer);
    const saved = recordMemories('agent-1', [
      { type: 'lesson', content: 'a', embedding: supplied },
      { type: 'lesson', content: 'b' },
      { type: 'lesson', content: 'c' },
    ]);
    await drain();

    expect(new Float32Array(h.embeddingSet.get(saved[1].id)!.buffer)[0]).toBe(
      'b'.charCodeAt(0),
    );
    expect(new Float32Array(h.embeddingSet.get(saved[2].id)!.buffer)[0]).toBe(
      'c'.charCodeAt(0),
    );
  });
});
