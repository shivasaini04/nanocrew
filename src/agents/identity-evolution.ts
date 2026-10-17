/**
 * IdentityEvolutionEngine — takes distilled memories and rewrites the ## LEARNED
 * section of an agent's IDENTITY.md. Archives old versions before updating.
 */
import {
  getAgent,
  getMemoryByAgent,
  updateAgentIdentityVersion,
  updateAgentLastEvolvedAt,
  getLearnedBullets,
  replaceLearnedBullets,
  addLearnedBullet,
  reviseLearnedBullet,
  removeLearnedBullet,
  countCompletedWorkCyclesSince,
} from '../db.js';
import type { LearnedBullet } from '../db.js';
import { recordConfigAudit } from '../db.js';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { AgentWorkspaceManager } from './agent-workspace.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { resolveInternalModel } from '../services/model-router.js';
import type { AgentMemory } from '../types.js';

// Every Nth evolution does a full resynthesis instead of an incremental patch, mirroring
// how sleep does both nightly consolidation AND periodic deeper reorganization — pure
// incremental patching forever risks slow drift/bloat with no correctness backstop.
const FULL_RESYNC_EVERY_N_VERSIONS = 4;

// What belongs in an identity at all. IDENTITY.md is loaded into every cycle the agent ever
// runs; memory is searched when it is relevant. So a LEARNED bullet earns its place only if
// it changes how the agent works on a task it has not seen yet. A fact about one task's
// subject is memory, not identity.
//
// Found 2026-09-30: one agent ran one task — semver
// range parsing — and its next self_improve wrote that task's rules into IDENTITY.md as
// permanent bullets. Two causes. The full-resynthesis prompt asked for "domain-specific
// knowledge" in so many words, and nothing required more than a single task's memories.
//
// Evolution now waits for this many completed work cycles since the last one, and every
// bullet the model adds must be labelled general; task-only and unlabelled ones are dropped.
export const MIN_WORK_CYCLES_PER_EVOLUTION = 3;

// When the rules above went live (04b1071's deploy). A bullet last written before this was
// written under "include domain-specific knowledge", so an agent holding any gets one full
// resynthesis — rebuilt from its memories under the current rules — instead of a patch. Asking
// the patch to judge old bullets is not enough: live, given three semver task-fact bullets, six
// calls removed all three only three times.
export const RULES_CHANGED_AT = '2026-10-01T05:30:00.000Z';

/** Cap on a full resynthesis — every bullet is paid for in every cycle's prompt. */
const MAX_BULLETS = 20;

const WHAT_BELONGS = `The LEARNED section is loaded into EVERY task this agent will ever run. It may hold only
lessons about HOW the agent should work — lessons that would change what it does on a future
task it has not seen yet.

GENERAL — keep:
- an approach or habit that worked or failed ("check a figure against a second source before reporting it")
- how a tool, site or source the agent uses behaves ("site X refuses requests without a proxy")
- a mistake to avoid; a preference the owner stated

TASK — drop (these stay in the agent's searchable memory, which is where they belong):
- facts about the subject of a task: definitions, rules, specifications, answers, data, figures, names, findings
- what happened in one run: outcomes, counts, progress, status
- anything that would matter only if the same task came up again

When a task-specific lesson has a general form, write the general form ("the 2025 rate for X
was 4.5%" is a task fact; "rates change yearly — confirm the year a figure applies to" is general).`;
// ─── Internal types ───────────────────────────────────────────────────────────

export interface ParsedIdentity {
  /**
   * Everything between the title and `## LEARNED`, verbatim, with its own headers intact.
   * Never modified.
   *
   * This used to capture only the text under a literal `## CORE` heading, and everything
   * else was silently dropped on the next evolution. That is fine for identities rendered
   * from a template — they all have `## CORE` — but a `customSystemPrompt` in *replace*
   * mode is the author's own document and organises itself however it likes. Crawler's
   * ran to six sections (`## Identity`, `## Daily volume goal`, `## Sources`,
   * `## Workflow`, `## Compliance Guardrails`, `## WORKSPACE`) and no `## CORE`. On
   * 2026-08-28 07:24 its first evolution after those headers existed rewrote the file as
   * an empty `## CORE` plus the learned bullets, and 4.8 KB of operating instructions —
   * which sources to use, which one was banned, the daily target, the handoff shape —
   * stopped reaching the agent. It kept running, on nothing but its own bullets, for
   * eleven days. The prompt itself survived in config.customSystemPrompt, so the file
   * could be regenerated — but nothing detected the loss, and nothing would have.
   *
   * Any replace-mode prompt is exposed, not only one that picked the wrong headings: a
   * prompt with no `##` headings at all (Recruiter's is a plain numbered list) parses to
   * an empty core just the same, and its first evolution would have erased it.
   */
  bodySection: string;
  learnedSection: string; // everything under ## LEARNED — replaced on evolution
  rawFull: string; // full file content for archive
}

// ─── Claude helper ────────────────────────────────────────────────────────────
// Mirrors memory-distiller.ts's getDistillerModel(): litellm proxy first (single
// gateway, no per-service key scattered across the orchestrator's own env), direct
// ANTHROPIC_API_KEY only as a fallback. Previously this required ANTHROPIC_API_KEY
// directly and nothing else — which isn't set on the orchestrator (the whole point
// of adopting litellm was to centralize keys there instead) — so evolve() failed on
// every single call, always silently (bare catch, fixed alongside this).

// A cap on how long an OpenRouter model may reason before it answers, in OpenRouter's own
// request field. The proxy refuses the OpenAI-style `reasoning_effort` for OpenRouter models
// (UnsupportedParamsError) but passes `reasoning` through. Measured 2026-10-01 on prod, GLM 5.3
// flash on the incremental patch: uncapped, 1 of 3 calls reasoned past 8,000 tokens and wrote
// nothing and the others took 60–100 s; capped at 2,000, 6 of 6 answered in 2–13 s with valid
// JSON.
export const EVOLUTION_REASONING_TOKENS = 2000;

/** Adds `reasoning: { max_tokens }` to the JSON body of each request. */
export const withReasoningCap =
  (inner: typeof fetch = fetch): typeof fetch =>
  (url, init) => {
    if (typeof init?.body !== 'string') return inner(url, init);
    try {
      const body = JSON.parse(init.body);
      return inner(url, {
        ...init,
        body: JSON.stringify({
          ...body,
          reasoning: { max_tokens: EVOLUTION_REASONING_TOKENS },
        }),
      });
    } catch {
      return inner(url, init);
    }
  };

function getEvolutionModel(agentId?: string) {
  const proxyUrl = process.env.LITELLM_PROXY_URL || '';
  const proxyKey = process.env.LITELLM_PROXY_KEY;
  if (proxyUrl && proxyKey) {
    // Model-router-governed, not a literal — see resolveInternalModel()'s docstring.
    const modelId = resolveInternalModel(agentId, 'identity_evolution');
    const proxy = createOpenAI({
      apiKey: proxyKey,
      baseURL: `${proxyUrl}/v1`,
      ...(modelId.startsWith('openrouter/')
        ? { fetch: withReasoningCap() }
        : {}),
    });
    return proxy.chat(modelId);
  }
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY || env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    return anthropic('claude-haiku-4-5-20251001');
  }
  throw new Error(
    'No LLM provider available for identity evolution. Set LITELLM_PROXY_URL/LITELLM_PROXY_KEY or ANTHROPIC_API_KEY.',
  );
}

// Output budget for both evolution calls. A reasoning model spends its output budget thinking
// before it writes. Measured 2026-10-01 on prod: GLM 5.3 flash used 2,297 reasoning tokens on
// an incremental patch capped at 2,000, was cut off, and returned no text at all — which
// surfaced as "unparseable JSON" and left the identity untouched. The same call capped at
// 8,000 finished in 3,058.
const EVOLUTION_MAX_TOKENS = 8000;

async function callClaude(
  system: string,
  user: string,
  maxTokens = EVOLUTION_MAX_TOKENS,
  agentId?: string,
): Promise<string> {
  const { text, finishReason } = await generateText({
    model: getEvolutionModel(agentId),
    system,
    messages: [{ role: 'user', content: user }],
    maxOutputTokens: maxTokens,
  });
  if (!text.trim() && finishReason === 'length') {
    throw new Error(
      `the evolution model spent its whole ${maxTokens}-token output budget before writing anything`,
    );
  }
  return text;
}

/**
 * Keep the candidates the model labelled general. A bare string, or any other label, is
 * dropped: an unlabelled bullet is one nobody checked, and failing closed here costs one
 * evolution, while failing open puts a task's facts into every future prompt.
 */
export function generalOnly(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const out: string[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const { text, scope } = c as { text?: unknown; scope?: unknown };
    if (scope === 'general' && typeof text === 'string' && text.trim())
      out.push(text.trim());
  }
  return out;
}

/** Ids of current bullets the model labelled task-only. */
export function taskLabelled(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const l of labels) {
    if (!l || typeof l !== 'object') continue;
    const { id, scope } = l as { id?: unknown; scope?: unknown };
    if (scope === 'task' && typeof id === 'string') out.push(id);
  }
  return out;
}

// ─── IdentityEvolutionEngine ──────────────────────────────────────────────────

export class IdentityEvolutionEngine {
  private workspace: AgentWorkspaceManager;

  constructor(agentsBaseDir: string) {
    this.workspace = new AgentWorkspaceManager(agentsBaseDir);
  }

  /**
   * Main entry: revise the structured LEARNED bullets (Gap 5), render them into
   * IDENTITY.md, archive + write. Most evolutions PATCH the existing bullet set using only
   * memories recorded since the last evolution; every FULL_RESYNC_EVERY_N_VERSIONS-th
   * evolution (or the very first one) does a full resynthesis instead, as a drift backstop.
   */
  async evolve(
    agentId: string,
  ): Promise<{ version: number } | { skipped: string }> {
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const memories = getMemoryByAgent(agentId);
    if (memories.length === 0) return { skipped: 'no memories to learn from' };

    // The evidence gate. A lesson seen in one task is that task's, not the agent's.
    const workCycles = countCompletedWorkCyclesSince(
      agentId,
      agent.last_evolved_at ?? null,
    );
    if (workCycles < MIN_WORK_CYCLES_PER_EVOLUTION) {
      return {
        skipped: `${workCycles} completed work cycle${workCycles !== 1 ? 's' : ''} since the last update — waiting for ${MIN_WORK_CYCLES_PER_EVOLUTION} before changing it`,
      };
    }

    const newVersion = agent.identity_version + 1;
    const existingBullets = getLearnedBullets(agentId);
    const lastEvolvedAt = agent.last_evolved_at
      ? Date.parse(agent.last_evolved_at)
      : null;
    const newMemories =
      lastEvolvedAt !== null
        ? memories.filter((m) => Date.parse(m.created_at) > lastEvolvedAt)
        : memories;

    const writtenUnderOldRules = existingBullets.some(
      (b) => b.updated_at < RULES_CHANGED_AT,
    );
    const dueForFullResync =
      existingBullets.length === 0 ||
      newVersion % FULL_RESYNC_EVERY_N_VERSIONS === 0 ||
      writtenUnderOldRules;

    try {
      if (dueForFullResync) {
        const bullets = await this.fullResynthesis(
          agent.name,
          memories,
          agentId,
        );
        if (bullets === null) {
          logger.warn(
            { agentId },
            '[identity-evolution] full resync answer was not a JSON array — leaving IDENTITY.md untouched',
          );
          return { skipped: 'the update failed' };
        }
        // A valid empty answer normally leaves the old bullets alone — a lazy [] must not wipe
        // good lessons. Bullets written under the old rules are the exception: an empty
        // section is better than a section of task facts.
        if (bullets.length === 0 && !writtenUnderOldRules) {
          logger.warn(
            { agentId },
            '[identity-evolution] full resync returned no general bullets — leaving IDENTITY.md untouched',
          );
          return { skipped: 'nothing general enough to keep' };
        }
        replaceLearnedBullets(
          agentId,
          bullets.map((text) => ({ text })),
        );
      } else {
        if (newMemories.length === 0) {
          // Not due for periodic resync, and nothing new happened since last evolution —
          // there is nothing to patch. Unlike the old full-resynthesis-every-time design,
          // this is a legitimate no-op, not a failure.
          return { skipped: 'no new memories since the last update' };
        }
        const changed = await this.incrementalPatch(
          agentId,
          agent.name,
          existingBullets,
          newMemories,
        );
        if (!changed)
          return { skipped: 'nothing new that applies beyond one task' };
      }
    } catch (err) {
      // This exact bare catch sat next to the memory-distiller one that hid a real
      // token-budget bug for who knows how long — never fail silently here either.
      logger.warn(
        { agentId, err: err instanceof Error ? err.message : String(err) },
        '[identity-evolution] evolution failed — leaving IDENTITY.md untouched',
      );
      return { skipped: 'the update failed' }; // safety: leave IDENTITY.md untouched on failure
    }

    const parsed = this.readCurrentIdentity(agentId);
    const renderedLearned = this.renderLearnedMarkdown(
      getLearnedBullets(agentId),
      newVersion,
    );

    // Archive current version before modifying
    this.archiveVersion(agentId, agent.identity_version);

    // Write updated identity
    this.writeUpdatedIdentity(agentId, parsed, renderedLearned);

    // Record it. This is the write that deleted a 4.8 KB system prompt on 2026-08-28 and
    // went unnoticed for eleven days, because archiving to identity-history/v*.md is not
    // something anyone queries. Size is carried alongside the text so a shrink is visible
    // at a glance in the history list without opening the diff.
    try {
      const after = this.workspace.readFile(agentId, 'IDENTITY.md') ?? '';
      recordConfigAudit({
        agentId,
        capability: 'identity',
        actor: 'system',
        before: {
          version: agent.identity_version,
          bytes: parsed.rawFull.length,
          identity: parsed.rawFull,
        },
        after: { version: newVersion, bytes: after.length, identity: after },
        reason: `self_improve evolution to v${newVersion}`,
      });
    } catch (err) {
      logger.warn(
        { agentId, err: err instanceof Error ? err.message : String(err) },
        '[identity-evolution] audit write failed',
      );
    }

    // Increment version + evolution watermark in DB
    this.incrementVersion(agentId, newVersion);
    updateAgentLastEvolvedAt(agentId, new Date().toISOString());

    return { version: newVersion };
  }

  /** Parse IDENTITY.md into its constituent sections. */
  readCurrentIdentity(agentId: string): ParsedIdentity {
    const rawFull = this.workspace.readFile(agentId, 'IDENTITY.md') ?? '';

    const learnedMatch = rawFull.match(/## LEARNED([\s\S]*)/);

    // Take the whole document up to `## LEARNED` rather than hunting for one known
    // heading. Anything an author wrote is theirs to keep, whatever they called it.
    const learnedIdx = rawFull.search(/^## LEARNED/m);
    const beforeLearned =
      learnedIdx >= 0 ? rawFull.slice(0, learnedIdx) : rawFull;
    // Drop only the title line — writeUpdatedIdentity re-emits it.
    const bodySection = beforeLearned.replace(/^#[^\n]*\n?/, '').trim();

    return {
      bodySection,
      learnedSection: learnedMatch?.[1]?.trim() ?? '',
      rawFull,
    };
  }

  /**
   * Periodic drift backstop (every FULL_RESYNC_EVERY_N_VERSIONS-th evolution, or the first
   * ever one): synthesize the whole bullet set from scratch off the top-30-by-relevance
   * memories, same inputs the old always-full-resync design used. Returns plain bullet text
   * lines (no ids yet — the caller persists them as fresh rows via replaceLearnedBullets).
   */
  async fullResynthesis(
    agentName: string,
    memories: AgentMemory[],
    agentId?: string,
  ): Promise<string[] | null> {
    const topMemories = [...memories]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 30)
      .map((m) => `[${m.type}] ${m.content}`)
      .join('\n');

    const systemPrompt = `You are rewriting the LEARNED section of an AI agent's identity from its memory.

${WHAT_BELONGS}

Be specific, actionable and concise. Return ONLY a JSON array, no other text, one object per
candidate lesson: [{"text": "...", "scope": "general"}, {"text": "...", "scope": "task"}].
Label every candidate honestly — "task" ones are discarded. At most ${MAX_BULLETS} general ones.
Return [] if nothing qualifies; an empty section is better than a section of task facts.`;

    const userPrompt = `Write the LEARNED bullets for ${agentName} from these memories (most relevant first):
${topMemories}`;

    // Reasoning headroom — see EVOLUTION_MAX_TOKENS.
    const raw = await callClaude(
      systemPrompt,
      userPrompt,
      EVOLUTION_MAX_TOKENS,
      agentId,
    );
    return this.parseBulletArray(raw)?.slice(0, MAX_BULLETS) ?? null;
  }

  /**
   * Incremental revision (the common case): give the LLM the EXISTING bullets (with stable
   * ids) plus only the memories recorded since last evolution, and ask for a patch — add/
   * revise/remove specific bullets with reasons — instead of regenerating everything. This is
   * what stops nuance that didn't make a "top-30 snapshot" from silently vanishing every week
   * even though nothing ever contradicted it (Gap 5's core failure mode).
   */
  async incrementalPatch(
    agentId: string,
    agentName: string,
    existingBullets: LearnedBullet[],
    newMemories: AgentMemory[],
  ): Promise<boolean> {
    const bulletList =
      existingBullets.length > 0
        ? existingBullets.map((b) => `[${b.id}] ${b.text}`).join('\n')
        : '(none yet)';
    const memoryList = newMemories
      .map((m) => `[${m.id}] (${m.type}) ${m.content}`)
      .join('\n');

    const systemPrompt = `You are patching the LEARNED section of an AI agent's identity.

${WHAT_BELONGS}

You will be given its CURRENT bullets (each with a stable id) and memories recorded since the
last update. Decide what changes, if anything — most updates should be small. Return ONLY
valid JSON, no other text, in this exact shape:
{
  "current": [{"id": "<existing bullet id>", "scope": "general" | "task"}],
  "add": [{"text": "new bullet text", "scope": "general" | "task"}],
  "revise": [{"id": "<existing bullet id>", "text": "revised bullet text"}],
  "remove": ["<existing bullet id>", ...]
}
Label EVERY current bullet in "current" by the rules above — "task" ones are removed. Label
every added bullet honestly — "task" ones are discarded. A current bullet with a general form
may be revised into that form instead of labelled "task". Leave "add"/"revise"/"remove" as
empty arrays where nothing applies — do not force a change.`;

    const userPrompt = `Agent: ${agentName}

## Current LEARNED bullets:
${bulletList}

## New memories since last evolution:
${memoryList}

Revise an existing bullet only if a new memory contradicts or supersedes it. Remove one if a
new memory contradicts it or it is a task fact. Add a bullet only for a durable lesson about how
to work — not a fact from one task and not a status update.`;

    const raw = await callClaude(
      systemPrompt,
      userPrompt,
      EVOLUTION_MAX_TOKENS,
      agentId,
    );
    const cleaned = raw
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    let patch: {
      current?: unknown[];
      add?: unknown[];
      revise?: { id: string; text: string }[];
      remove?: string[];
    };
    try {
      patch = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(
        `incrementalPatch: LLM returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const existingIds = new Set(existingBullets.map((b) => b.id));
    const revised = new Set(
      (patch.revise ?? [])
        .filter((r) => existingIds.has(r?.id) && r.text?.trim())
        .map((r) => r.id),
    );
    // Removal was left to the model's discretion and it mostly declined: given the same three
    // semver bullets, six live calls removed all three once, one twice, none twice. Asked to
    // label each current bullet, it has to decide each one. An unlabelled current bullet is
    // kept — deleting a good lesson by mistake is a failure too. A bullet revised into its
    // general form is not also removed.
    const toRemove = new Set(
      (patch.remove ?? []).filter((id) => existingIds.has(id)),
    );
    for (const id of taskLabelled(patch.current))
      if (existingIds.has(id) && !revised.has(id)) toRemove.add(id);
    let changed = 0;
    for (const id of toRemove) {
      removeLearnedBullet(id);
      changed++;
    }
    for (const r of patch.revise ?? []) {
      if (revised.has(r.id) && !toRemove.has(r.id)) {
        reviseLearnedBullet(r.id, r.text.trim());
        changed++;
      }
    }
    for (const text of generalOnly(patch.add)) {
      addLearnedBullet(
        agentId,
        text,
        newMemories.map((m) => m.id),
      );
      changed++;
    }
    return changed > 0;
  }

  /** Parse the resynthesis array down to its general bullets, tolerating code fences. null = not a JSON array. */
  private parseBulletArray(raw: string): string[] | null {
    if (!raw.trim()) return null;
    const cleaned = raw
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    try {
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? generalOnly(parsed) : null;
    } catch {
      return null;
    }
  }

  /** Render the structured bullets table into the markdown that goes under "## LEARNED". */
  renderLearnedMarkdown(bullets: LearnedBullet[], version: number): string {
    const dateStr = new Date().toISOString().split('T')[0];
    if (bullets.length === 0)
      return `Version: ${version} | Updated: ${dateStr}`;
    const lines = bullets.map((b) => `- ${b.text}`);
    return `${lines.join('\n')}\n\nVersion: ${version} | Updated: ${dateStr}`;
  }

  /** Write the updated IDENTITY.md with the new LEARNED section. */
  writeUpdatedIdentity(
    agentId: string,
    parsed: ParsedIdentity,
    newLearnedSection: string,
  ): void {
    const title = parsed.rawFull.split('\n')[0] ?? '# Agent'; // preserve # heading
    // Body goes back exactly as it came, under whatever headings it already used. A
    // template-rendered identity round-trips unchanged (its body simply *is* `## CORE …`);
    // a hand-written system prompt keeps all of its sections instead of losing every one
    // that wasn't called CORE.
    const newContent = `${title}\n\n${parsed.bodySection}\n\n## LEARNED\n${newLearnedSection}\n`;
    this.workspace.writeFile(agentId, 'IDENTITY.md', newContent);
  }

  /** Copy current IDENTITY.md to identity-history/v{version}.md */
  archiveVersion(agentId: string, version: number): void {
    this.workspace.archiveIdentityVersion(agentId, version);
  }

  /** Increment the version counter in the DB. */
  incrementVersion(agentId: string, newVersion: number): void {
    updateAgentIdentityVersion(agentId, newVersion);
  }
}
