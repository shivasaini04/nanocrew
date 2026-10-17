/**
 * MemoryRetrieval — Stage 34 Gaps 3 & 4 ("flat list, not a relationship graph" / "passive
 * retrieval, not spontaneous recall").
 *
 * Upgrades every consumer of searchAgentMemory (search_memory tool, search_crew_memory,
 * and — this is the load-bearing one — the Python container's get_relevant_memory_context(),
 * which already runs automatically before every non-lean turn using the task text as an
 * implicit query, hitting this same endpoint). Fixing ranking quality here fixes automatic
 * recall quality too; they were never two separate problems at the code level, just two
 * symptoms of the same keyword-only ranking.
 *
 * Semantic ranking is additive, not a replacement: if no embedding provider is configured,
 * or the agent has no embedded memories yet (pre-Stage-34 rows), or the embed call fails,
 * this transparently falls back to the existing FTS5/trigram search — never a hard failure.
 */
import { getMemoryWithEmbeddings, searchAgentMemory } from '../db.js';
import { embedText, blobToEmbedding, cosineSimilarity } from './embeddings.js';
import type { AgentMemory } from '../types.js';

// Below this cosine similarity, a memory isn't "relevant to this query" — it's noise, and
// surfacing it would make automatic recall (Gap 4) feel like spam rather than recall.
const SIMILARITY_FLOOR = 0.55;

export type RankedMemory = AgentMemory & { search_rank?: number };

/**
 * Rank an agent's memories against `query`. Semantic search first (cosine similarity over
 * stored embeddings); if that yields nothing usable, falls back to FTS5/trigram.
 * `search_rank` is populated on both paths, lower = more relevant, so callers that already
 * sort by `search_rank` ascending (e.g. the project-wide crew search) keep working unmodified.
 */
export async function searchAgentMemoryRanked(
  agentId: string,
  query: string,
  limit = 20,
  typeFilter?: string,
): Promise<RankedMemory[]> {
  const semantic = await searchAgentMemorySemantic(
    agentId,
    query,
    limit,
    typeFilter,
  );
  if (semantic && semantic.length > 0) return semantic;
  return searchAgentMemory(agentId, query, limit, typeFilter);
}

/** Semantic-only search. Returns null (not []) when semantic search isn't usable at all, so the
 *  caller can distinguish "fall back to FTS" from "genuinely zero memories matched". */
async function searchAgentMemorySemantic(
  agentId: string,
  query: string,
  limit: number,
  typeFilter?: string,
): Promise<RankedMemory[] | null> {
  const candidates = getMemoryWithEmbeddings(agentId, typeFilter).filter(
    (m) => m.embedding,
  );
  if (candidates.length === 0) return null; // no embedded rows yet — nothing to rank semantically

  const queryVec = await embedText(query);
  if (!queryVec) return null; // no embedding provider configured / call failed

  const scored = candidates.map((m) => {
    const vec = blobToEmbedding(m.embedding as Buffer);
    const score = cosineSimilarity(queryVec, vec);
    const { embedding: _drop, ...rest } = m;
    return { ...rest, score };
  });

  const ranked = scored
    .filter((m) => m.score >= SIMILARITY_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 100));

  if (ranked.length === 0) return null; // nothing cleared the floor — let FTS have a shot instead

  return ranked.map(({ score, ...m }) => ({ ...m, search_rank: -score }));
}
