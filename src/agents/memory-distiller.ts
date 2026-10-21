/**
 * MemoryDistiller — reads weekly episode logs, extracts structured memories via LLM,
 * deduplicates against existing knowledge, and persists to agent_memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import { anthropic } from '@ai-sdk/anthropic';
import {
  getMemoryByAgent,
  getWeeklyCycles,
  getDistilledEpisodeDates,
  markEpisodesDistilled,
  getMemoryWithEmbeddings,
  demoteMemoryRelevance,
} from '../db.js';
import { recordMemories } from './memory-service.js';
import { AgentWorkspaceManager } from './agent-workspace.js';
import { readEnvFile } from '../env.js';
import { resolveInternalModel } from '../services/model-router.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  embedTexts,
  embeddingToBlob,
  blobToEmbedding,
  cosineSimilarity,
} from './embeddings.js';
import type { AgentMemory, MemoryType } from '../types.js';

// ─── Internal types ───────────────────────────────────────────────────────────

/**
 * Outcome of a distill run. `failed` separates "the extraction did not run" from "it ran
 * and found nothing" — collapsing the two is what let a broken distiller report success.
 */
export interface DistillResult {
  memories: AgentMemory[];
  failed: boolean;
}

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
  confidence: number;
  sourceDates: string[];
  scope?: 'agent' | 'global';
  /** Stage 34 Gap 3 — index into the "existing" array passed to extractMemories, if the LLM
   *  judged this candidate supersedes it. Only trusted after an embedding-similarity gate. */
  supersedesIndex?: number | null;
}

interface DedupedCandidate extends MemoryCandidate {
  embedding: Float32Array | null;
  supersedesId?: string;
}

// Near-duplicate: same fact, reworded. High bar — this REPLACES what used to be a substring
// match, so it must not be looser than "obviously the same sentence".
const DUP_SIMILARITY_THRESHOLD = 0.92;
// Same-topic-different-conclusion: looser than dup, but still a real semantic match — gates
// the LLM's own "supersedes" claim so an ungrounded guess can't silently demote a valid memory.
const SUPERSESSION_SIMILARITY_GATE = 0.72;
// Bounds how much episode backlog one distill() call reads — a paused agent's episodes are
// processed oldest-first across a few cycles instead of read all at once (Gap 2).
const DEFAULT_MAX_EPISODE_FILES = 60;

// ─── LLM helper — same provider priority as agent-runtime ────────────────────

function getDistillerModel(agentId?: string) {
  // LiteLLM proxy takes precedence — single endpoint, proxy handles provider routing.
  // This runs in-process inside the orchestrator container, which is already on the
  // same Docker Compose network as litellm — LITELLM_PROXY_URL (http://litellm:4000)
  // resolves correctly as-is. Do NOT rewrite it to localhost: unlike the nanobot
  // *agent* containers (which run on Docker's default bridge, isolated from the
  // compose network, and need host.docker.internal — see nanobot-cycle-runner.ts),
  // "localhost" here means the orchestrator's own container, where nothing listens
  // on port 4000. That mismatch silently broke every distillation call with
  // ECONNREFUSED, hidden behind the bare catch this fix also addresses.
  const proxyUrl = process.env.LITELLM_PROXY_URL || '';
  const proxyKey = process.env.LITELLM_PROXY_KEY;
  if (proxyUrl && proxyKey) {
    const proxy = createOpenAI({ apiKey: proxyKey, baseURL: `${proxyUrl}/v1` });
    // Model-router-governed (taskType 'memory_distill' — the same key the
    // container-side NANOBOT_MEMORY_MODEL uses, so one setting covers both distillers),
    // not a literal — see resolveInternalModel()'s docstring.
    return proxy.chat(resolveInternalModel(agentId, 'memory_distill'));
  }

  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'GROQ_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_KIMI_API_KEY',
  ]);
  const deepseekKey = process.env.DEEPSEEK_API_KEY || env['DEEPSEEK_API_KEY'];
  const moonshotKey =
    process.env.MOONSHOT_KIMI_API_KEY || env['MOONSHOT_KIMI_API_KEY'];
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY || env['ANTHROPIC_API_KEY'];
  const groqKey = process.env.GROQ_API_KEY || env['GROQ_API_KEY'];

  if (deepseekKey) {
    const ds = createOpenAI({
      apiKey: deepseekKey,
      baseURL: 'https://api.deepseek.com/v1',
    });
    return ds.chat('deepseek-chat');
  }
  if (moonshotKey) {
    const ms = createOpenAI({
      apiKey: moonshotKey,
      baseURL: 'https://api.moonshot.cn/v1',
    });
    return ms.chat('moonshot-v1-8k');
  }
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    return anthropic('claude-haiku-4-5-20251001');
  }
  if (groqKey) {
    const groq = createGroq({ apiKey: groqKey });
    return groq('openai/gpt-oss-120b');
  }
  throw new Error(
    'No LLM provider available for memory distillation. Set DEEPSEEK_API_KEY, MOONSHOT_KIMI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY.',
  );
}

async function callLLM(
  system: string,
  user: string,
  maxTokens = 1024,
  agentId?: string,
): Promise<string> {
  const { text } = await generateText({
    model: getDistillerModel(agentId),
    system,
    messages: [{ role: 'user', content: user }],
    maxOutputTokens: maxTokens,
  });
  return text;
}

// ─── MemoryDistiller ──────────────────────────────────────────────────────────

export class MemoryDistiller {
  private workspace: AgentWorkspaceManager;

  constructor(agentsBaseDir: string) {
    this.workspace = new AgentWorkspaceManager(agentsBaseDir);
  }

  /**
   * Main entry point — distill not-yet-processed episodes for an agent (Gap 2: a per-episode
   * ledger, not a rolling date window, decides what's "new" — see readEpisodes()).
   */
  async distill(
    agentId: string,
    agentName: string,
    agentType: string,
    maxEpisodeFiles = DEFAULT_MAX_EPISODE_FILES,
  ): Promise<DistillResult> {
    const alreadyDistilled = getDistilledEpisodeDates(agentId);
    const { text: episodesText, dates: readDates } = await this.readEpisodes(
      agentId,
      alreadyDistilled,
      maxEpisodeFiles,
    );
    if (!episodesText.trim()) return { memories: [], failed: false }; // nothing new to distill

    const existing = getMemoryByAgent(agentId);
    const candidates = await this.extractMemories(
      episodesText,
      agentId,
      agentName,
      agentType,
      existing,
    );

    // Extraction failed (empty completion, bad JSON, provider error) — NOT "nothing to
    // learn". These must not be conflated: the episodes below are marked distilled and
    // never read again, so treating a failure as an empty result silently destroys the
    // input. Finder ran three self_improve cycles reporting "0 new learnings" while the
    // distiller was returning empty completions and burning the episodes behind it.
    // Leave them unmarked so the next run gets another attempt.
    if (candidates === null) {
      logger.error(
        { agentId, episodes: readDates.length },
        '[memory-distiller] extraction FAILED — leaving episodes undistilled so they are retried',
      );
      return { memories: [], failed: true };
    }

    // Refuse to memorise content that looks like a prompt-injection — a poisoned episode
    // must not be promoted into durable memory (where it would re-enter every future prompt).
    const filtered = candidates.filter(
      (c) => c.confidence >= 0.5 && !looksLikeInjection(c.content),
    );
    const deduped = await this.deduplicateMemories(agentId, filtered, existing);

    // Mark every episode we read as distilled — an episode that genuinely yielded zero
    // candidates was still considered, not silently skipped (Gap 2's whole point: "already
    // looked at" must be a recorded fact, not an accident of timing). Only reached when
    // extraction actually ran.
    markEpisodesDistilled(agentId, readDates);

    if (deduped.length === 0) return { memories: [], failed: false };
    return {
      memories: await this.saveMemories(agentId, undefined, deduped),
      failed: false,
    };
  }

  /**
   * Read not-yet-distilled episode files from workspace/memory/episodes/, oldest first, capped
   * at `maxFiles`. Returns both the concatenated text and the exact dates read, so the caller
   * can mark precisely those as distilled once processing completes (success or not).
   */
  async readEpisodes(
    agentId: string,
    excludeDates: Set<string>,
    maxFiles = DEFAULT_MAX_EPISODE_FILES,
  ): Promise<{ text: string; dates: string[] }> {
    const EPISODES_SUBDIR = 'workspace/memory/episodes';
    const files = this.workspace.listFiles(agentId, EPISODES_SUBDIR);
    const pending: Array<{ date: string; relPath: string }> = [];

    for (const f of files) {
      if (f.type !== 'file') continue;

      // Filename: YYYY-MM-DD.md — parse date from name
      const name = f.path.split('/').pop() ?? '';
      const dateStr = name.replace('.md', '');
      const fileDate = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(fileDate.getTime()) || excludeDates.has(dateStr)) continue;

      pending.push({ date: dateStr, relPath: f.path });
    }

    // Oldest first: a backlog (paused agent, delayed schedule) gets worked down in order
    // across successive cycles instead of jumping straight to the most recent episodes.
    pending.sort((a, b) => a.date.localeCompare(b.date));
    const selected = pending.slice(0, maxFiles);

    const parts: string[] = [];
    const dates: string[] = [];
    for (const p of selected) {
      // listFiles returns paths relative to the subdir, but readFile roots at the
      // agent root — re-prefix the subdir so the read resolves correctly.
      const content = this.workspace.readFile(
        agentId,
        `${EPISODES_SUBDIR}/${p.relPath}`,
      );
      if (content) {
        parts.push(`=== ${p.date} ===\n${content}`);
        dates.push(p.date);
      }
    }

    return { text: parts.join('\n\n'), dates };
  }

  /** Call LLM to extract MemoryCandidate[] from episode text. */
  async extractMemories(
    episodesText: string,
    agentId: string,
    agentName: string,
    agentType: string,
    existing: AgentMemory[],
  ): Promise<MemoryCandidate[] | null> {
    // Indexed so the model can point back at a specific existing memory via supersedes_index
    // (Gap 3) — a bare text summary gives it nothing precise to reference.
    const existingSummary =
      existing.length > 0
        ? existing
            .slice(0, 20)
            .map((m, i) => `[${i}] (${m.type}) ${m.content}`)
            .join('\n')
        : '(none yet)';

    const systemPrompt =
      'You are a memory extraction system. Analyze agent work logs and extract structured learnings. Return only valid JSON.';
    const userPrompt = `You are analyzing a week of work logs for ${agentName} (${agentType}).

## Episode logs:
${episodesText.substring(0, 120000)}

## Already known (indexed — do not duplicate):
${existingSummary}

Extract NEW learnings as a JSON array. Each entry:
{
  "type": "lesson" | "pattern" | "failure" | "win" | "icp_update",
  "content": "concise, specific, actionable insight",
  "confidence": 0.0-1.0,
  "sourceDates": ["YYYY-MM-DD"],
  "scope": "agent" | "global",
  "supersedes_index": <integer index from "Already known" that this NEW learning replaces/contradicts, or null>
}

Rules:
- Extract DURABLE lessons, patterns, and decisions — "what worked / what to change next time" — not transient status or running totals. Live numbers belong in the agent's tracked records, NOT in memory.
- Only extract insights supported by recurring evidence across multiple episodes.
- MEMORY HYGIENE (critical): do NOT memorise a number, rate, or metric unless the logs clearly show it was actually MEASURED (a real result/record) — and then include its source/date. If a figure's provenance is unclear, or it looks self-reported, projected, or aspirational, capture the underlying lesson WITHOUT the number. NEVER turn an unverified or claimed statistic into a remembered fact — that is how fabrications spread across cycles.
- Prefer the lesson over the statistic: "narrow-ICP outreach replied better than broad" (durable) beats "25% reply rate" (a transient, often-unverified number).
- Skip anything already in "Already known"
- Set "supersedes_index" ONLY when a specific existing entry is now clearly wrong or outdated — not just "related to". Leave it null when unsure; a false supersession claim is worse than missing one.
- Set "scope" to "global" only if the learning is a generic best practice, reusable software rule, cold outreach playbook, positioning framework, or API integration/rate-limiting fix that would be useful to other agents. Set it to "agent" if it is specific to this agent's identity, tasks, private files, or local configuration.
- Return empty array [] if no strong patterns found
- Return ONLY the JSON array, no other text`;

    // 1000 tokens was silently starving this call: the distiller model
    // (deepseek/deepseek-v4-flash) is a reasoning model that spends completion
    // tokens on an internal "reasoning_content" pass before it ever writes the
    // final answer into "content" — on a prompt this rule-heavy, with up to
    // 120k chars of episode text to reason over, reasoning alone can burn through
    // 1000 tokens, leaving `content` empty and finish_reason:"length". That
    // produced valid-but-empty JSON.parse('') failures on every real distill run,
    // caught by the bare catch below and reported as "0 new learnings" — every
    // time, regardless of how clear-cut the episode content was (confirmed via a
    // direct litellm probe: a trivial prompt used 21 reasoning tokens before any
    // output; the real extraction prompt is far more demanding). 4000 tokens
    // gives real headroom for both phases.
    try {
      const raw = await callLLM(systemPrompt, userPrompt, 12000, agentId);
      if (!raw.trim()) {
        logger.warn(
          { agentId },
          '[memory-distiller] LLM returned empty content — likely exhausted its token budget on internal reasoning before producing output',
        );
        return null;
      }
      // Strip markdown fences if present
      const cleaned = raw
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .map((c: any) => ({
          type: c.type,
          content: c.content,
          confidence: c.confidence,
          sourceDates: c.sourceDates || [],
          scope: (c.scope === 'global' ? 'global' : 'agent') as
            | 'agent'
            | 'global',
          supersedesIndex:
            typeof c.supersedes_index === 'number' ? c.supersedes_index : null,
        }))
        .filter(
          (c: any) =>
            c.type &&
            typeof c.content === 'string' &&
            typeof c.confidence === 'number',
        );
    } catch (err) {
      // Never fail silently again — this exact bare catch is what hid the token
      // -budget bug above for who knows how long.
      logger.warn(
        { agentId, err: err instanceof Error ? err.message : String(err) },
        '[memory-distiller] extractMemories failed',
      );
      return null;
    }
  }

  /**
   * Remove candidates that are near-duplicates of existing memories, and resolve any
   * LLM-claimed supersession (Gap 3) through an embedding-similarity gate.
   *
   * Embeds every candidate + every existing memory once (batched), then:
   *  - dedup: cosine similarity >= DUP_SIMILARITY_THRESHOLD against ANY existing memory drops it
   *  - supersession: only kept if the LLM named a target AND that target's embedding is
   *    actually similar enough (>= SUPERSESSION_SIMILARITY_GATE) — an ungrounded claim is ignored,
   *    not trusted, so a bad guess can't silently demote a still-valid memory.
   *  - No embedding provider configured, or these are pre-Stage-34 rows with no embeddings yet:
   *    falls back to the original substring-containment check (Gap 3 not applied — the DB
   *    just doesn't have anything to compare against yet, no worse than before this change).
   */
  async deduplicateMemories(
    agentId: string,
    candidates: MemoryCandidate[],
    existing: AgentMemory[],
  ): Promise<DedupedCandidate[]> {
    if (candidates.length === 0) return [];

    const candidateVecs = await embedTexts(candidates.map((c) => c.content));
    const existingEmbedded = getMemoryWithEmbeddings(agentId)
      .filter(
        (m): m is AgentMemory & { embedding: Buffer } => m.embedding != null,
      )
      .map((m) => ({ id: m.id, vec: blobToEmbedding(m.embedding) }));

    const kept: DedupedCandidate[] = [];

    candidates.forEach((candidate, i) => {
      const vec = candidateVecs[i];
      let isDup: boolean;

      if (vec && existingEmbedded.length > 0) {
        isDup = existingEmbedded.some(
          (e) => cosineSimilarity(vec, e.vec) >= DUP_SIMILARITY_THRESHOLD,
        );
      } else {
        const cLower = candidate.content.toLowerCase();
        isDup = existing.some((mem) => {
          const mLower = mem.content.toLowerCase();
          return (
            mLower.includes(cLower.substring(0, 40)) ||
            cLower.includes(mLower.substring(0, 40))
          );
        });
      }
      if (isDup) return;

      let supersedesId: string | undefined;
      if (candidate.supersedesIndex != null && vec) {
        const target = existing[candidate.supersedesIndex];
        const targetEmb = target
          ? existingEmbedded.find((e) => e.id === target.id)
          : undefined;
        if (
          target &&
          targetEmb &&
          cosineSimilarity(vec, targetEmb.vec) >= SUPERSESSION_SIMILARITY_GATE
        ) {
          supersedesId = target.id;
        }
      }

      kept.push({ ...candidate, embedding: vec, supersedesId });
    });

    return kept;
  }

  /** Save a high-confidence global learning candidate to the global knowledge folder. */
  private saveToGlobalKnowledge(type: MemoryType, content: string): void {
    try {
      let subDir = 'lessons';
      if (type === 'pattern') {
        subDir = 'patterns';
      } else if (type === 'failure') {
        subDir = 'fixes';
      }

      const dirPath = path.join(DATA_DIR, 'knowledge', subDir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substring(2, 7);
      const filename = `distilled_${timestamp}_${randomId}.md`;
      const filePath = path.join(dirPath, filename);

      const cleanContent = content.trim();
      const firstLine = cleanContent.split('\n')[0] || '';
      const cleanTitle = firstLine.startsWith('# ')
        ? firstLine.replace('# ', '').trim()
        : firstLine.length > 5 && firstLine.length < 80
          ? firstLine
          : `Distilled ${type.toUpperCase()}`;

      const fileContent = `# ${cleanTitle}\n\n${cleanContent}\n\n*Distilled automatically during memory self-improvement cycle.*`;
      fs.writeFileSync(filePath, fileContent, 'utf-8');
    } catch {
      // non-fatal
    }
  }

  /** Persist deduplicated candidates via the memory facade (DB + view sync), return saved records. */
  saveMemories(
    agentId: string,
    cycleId: string | undefined,
    candidates: DedupedCandidate[],
  ): AgentMemory[] {
    // Single write path: recordMemories writes the DB then refreshes the views once.
    const saved = recordMemories(
      agentId,
      candidates.map((c) => ({
        type: c.type,
        content: c.content,
        source_cycle: cycleId,
        relevance: c.confidence,
        embedding: c.embedding ? embeddingToBlob(c.embedding) : undefined,
        supersedes_id: c.supersedesId,
      })),
    );

    // Gap 3 — soft supersession: quiet the memory that was replaced rather than deleting it.
    for (const c of candidates) {
      if (c.supersedesId) demoteMemoryRelevance(c.supersedesId);
    }

    // Publish high-confidence global learnings to the shared knowledge base
    for (const c of candidates) {
      if (c.scope === 'global' && c.confidence >= 0.8) {
        this.saveToGlobalKnowledge(c.type, c.content);
      }
    }
    return saved;
  }
}

// The MEMORY.md / USER.md view-writers now live in memory-service.ts (the single sync
// owner, Phase 2 of the memory consolidation). Re-exported for backward-compat so existing
// importers (chat-tools, etc.) keep working unchanged.
export { syncToMemoryMd, syncUserMd } from './memory-service.js';

// ─── Injection / promptware detection ──────────────────────────────────────────
// Memory + episodes feed the prompt, so a poisoned entry is a prompt-injection vector.
// We detect (not blindly mutate) suspicious content: the distiller refuses to memorise it,
// and nanobot frames injected memory as untrusted data.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|the\s+|any\s+)?(previous|above|prior|earlier)\s+(instructions|messages|prompts?)/i,
  /disregard\s+(the\s+|all\s+|your\s+)?(previous|above|prior|instructions|rules)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+(instructions?|task|role|persona)\s*:/i,
  /\bsystem\s+prompt\b/i,
  /<\/?(system|developer|assistant|tool_call|tools?)\b/i,
  /\bdo\s+not\s+(tell|inform|mention|reveal)\b/i,
  /\boverride\s+(your|the|all)\s+(instructions|rules|guardrails|safety)/i,
  /\b(begin|start)\s+(system|prompt|instructions)\b/i,
  /\bact\s+as\s+(if|though|a)\b.*\b(jailbreak|DAN|developer\s+mode)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  const t = text || '';
  return INJECTION_PATTERNS.some((p) => p.test(t));
}
