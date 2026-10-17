/**
 * MemoryService — the single front door for WRITING agent memory.
 *
 * The fragmentation problem this solves: agent memory is canonical in the `agent_memory`
 * DB, but file *views* (MEMORY.md, USER.md) must be regenerated to match. Several callers
 * historically wrote to the DB and forgot to refresh the views, so the views drifted.
 *
 * Contract (Phase 1 of the memory consolidation):
 *   • The DB is the source of truth.
 *   • Every write goes through here: DB first, then ONE view refresh (`syncMemoryViews`).
 *   • File views are pure projections of the DB — never edited independently.
 *
 * (Retrieval unification + used_count tracking are later phases; this owns write + sync.)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createAgentMemory,
  deleteAgentMemory,
  getMemoryByAgent,
  setMemoryEmbedding,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import { embedTexts, embeddingToBlob } from './embeddings.js';
import { logger } from '../logger.js';
import type { AgentMemory, MemoryType } from '../types.js';

/**
 * Fill in embeddings for rows written without one, off the response path.
 *
 * Only the distiller ever passed an embedding. Every other writer — most importantly the
 * `append_memory` tool, which is how an agent records a lesson *during* work — wrote
 * `embedding = NULL`. Those rows are then skipped by `deduplicateMemories()` (it filters on
 * `embedding != null`) and can never be matched by the supersession-similarity gate, so the
 * agent's own hard-won lessons were the ones least visible to its memory system.
 *
 * Deliberately fire-and-forget: `recordMemory` is synchronous and a cycle agent is awaiting
 * the HTTP response behind it, so the DB write must not wait on a network round-trip to the
 * embedding provider. The row is durable the moment it is inserted; the vector lands a beat
 * later. A failure here is a degradation (falls back to substring matching), never data loss,
 * so it warns and moves on.
 */
function backfillEmbeddings(
  rows: Array<{ id: string; content: string }>,
): void {
  if (rows.length === 0) return;
  setImmediate(() => {
    void (async () => {
      try {
        const vecs = await embedTexts(rows.map((r) => r.content));
        let written = 0;
        vecs.forEach((v, i) => {
          if (!v) return;
          setMemoryEmbedding(rows[i].id, embeddingToBlob(v));
          written++;
        });
        if (written < rows.length) {
          logger.warn(
            { wrote: written, of: rows.length },
            '[memory] some rows stored without an embedding',
          );
        }
      } catch (err) {
        logger.warn(
          { err: String(err), count: rows.length },
          '[memory] embedding backfill failed — rows kept, semantic match degraded',
        );
      }
    })();
  });
}

export interface RecordMemoryInput {
  type: MemoryType;
  content: string;
  relevance?: number;
  source_cycle?: string;
  /** Stage 34 Gap 3/4 — precomputed embedding BLOB, if the caller already has one (e.g. the distiller). */
  embedding?: Buffer | null;
  /** Stage 34 Gap 3 — id of an existing memory this one supersedes (soft link; see demoteMemoryRelevance). */
  supersedes_id?: string;
}

/**
 * The ONE place file views are regenerated from the DB.
 * `syncToMemoryMd` already rewrites MEMORY.md (excluding user_profile) and USER.md.
 */
export function syncMemoryViews(agentId: string): void {
  syncToMemoryMd(agentId);
}

/**
 * Write a single memory: DB first, then refresh the views.
 * Pass `{ syncNow: false }` on hot paths (e.g. an HTTP handler an agent is awaiting) to
 * push the view refresh off the response path — the durable DB write is what matters.
 */
export function recordMemory(
  agentId: string,
  input: RecordMemoryInput,
  opts: { syncNow?: boolean } = {},
): AgentMemory {
  const mem = createAgentMemory(
    {
      agent_id: agentId,
      type: input.type,
      content: input.content,
      source_cycle: input.source_cycle,
      relevance: input.relevance ?? 0.8,
      used_count: 0,
      supersedes_id: input.supersedes_id,
    },
    input.embedding,
  );
  if (!input.embedding)
    backfillEmbeddings([{ id: mem.id, content: input.content }]);
  if (opts.syncNow === false) {
    setImmediate(() => {
      try {
        syncMemoryViews(agentId);
      } catch {
        /* non-fatal — DB is truth */
      }
    });
  } else {
    syncMemoryViews(agentId);
  }
  return mem;
}

/** Write several memories, then refresh views ONCE (use for batch writers like the distiller). */
export function recordMemories(
  agentId: string,
  inputs: RecordMemoryInput[],
): AgentMemory[] {
  const saved = inputs.map((i) =>
    createAgentMemory(
      {
        agent_id: agentId,
        type: i.type,
        content: i.content,
        source_cycle: i.source_cycle,
        relevance: i.relevance ?? 0.8,
        used_count: 0,
        supersedes_id: i.supersedes_id,
      },
      i.embedding,
    ),
  );
  backfillEmbeddings(
    saved
      .map((m, i) => ({ m, supplied: inputs[i].embedding }))
      .filter(({ supplied }) => !supplied)
      .map(({ m }) => ({ id: m.id, content: m.content })),
  );
  if (saved.length) syncMemoryViews(agentId);
  return saved;
}

/** Delete a memory, then refresh views. */
export function forgetMemory(agentId: string, id: string): void {
  deleteAgentMemory(id);
  syncMemoryViews(agentId);
}

// ─── File views (projections of the DB) ─────────────────────────────────────────
// These are the ONLY writers of MEMORY.md / USER.md. They render from the DB, so the
// files are always a faithful projection and can never drift. DB is the source of truth.

/** Rewrite MEMORY.md from the top-20 DB memories (excluding user_profile). */
export function syncToMemoryMd(agentId: string): void {
  try {
    const memories = getMemoryByAgent(agentId)
      .filter((m) => m.type !== 'user_profile')
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, 20);

    // Always refresh USER.md alongside MEMORY.md.
    syncUserMd(agentId);

    if (memories.length === 0) return;

    const lines: string[] = ['# Memory\n'];
    for (const m of memories) {
      lines.push(
        `## [${m.type}] (relevance: ${(m.relevance ?? 0).toFixed(2)})`,
      );
      lines.push(m.content);
      lines.push('');
    }

    const memPath = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'memory',
      'MEMORY.md',
    );
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    fs.writeFileSync(memPath, lines.join('\n'), 'utf-8');
  } catch {
    /* non-fatal — SQLite is the source of truth */
  }
}

/** Rewrite USER.md — durable facts about the manager (Hermes-style USER.md). */
export function syncUserMd(agentId: string): void {
  try {
    const profile = getMemoryByAgent(agentId).filter(
      (m) => m.type === 'user_profile',
    );
    const userPath = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'memory',
      'USER.md',
    );
    if (profile.length === 0) {
      try {
        fs.unlinkSync(userPath);
      } catch {
        /* none */
      }
      return;
    }
    const lines = [
      '# Manager Profile',
      '',
      'Durable facts about your manager (preferences, style, decisions):',
      '',
    ];
    for (const m of profile.sort((a, b) =>
      a.created_at < b.created_at ? -1 : 1,
    )) {
      lines.push(`- ${m.content}`);
    }
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, lines.join('\n') + '\n', 'utf-8');
  } catch {
    /* non-fatal */
  }
}
