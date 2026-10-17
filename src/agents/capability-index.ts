/**
 * Stage 56 phase 2 — how an agent finds who can help.
 *
 * Today an agent's entire knowledge of its colleagues is the crew roster injected at
 * cycle start: name, type, and a goal string truncated to 100 characters. That is enough
 * to address a message and nothing else. It cannot ask *"who here can verify an email
 * address?"* — and that question is the whole difference between a chain and a web.
 *
 * Measured 2026-09-08, the live network was exactly the three-node chain its three
 * prompts describe: `Crawler → Finder → Mailer`. Routing was whatever the sender's
 * prompt happened to name. Nothing was discovered; everything was pre-wired.
 *
 * Nothing here needs inventing — the answers already sit in tables. What phase 2 adds is
 * the question.
 *
 * ## Why substring matching and not embeddings
 *
 * A semantic index over eight agents is a great deal of machinery to answer a question a
 * `LIKE` does, and this codebase has a documented pattern of shipping capable machinery
 * nothing calls: seven inter-agent tools, one used. Deterministic, debuggable, free.
 * Revisit when the crew is large enough that names stop being enough.
 *
 * ## What is deliberately NOT ranked highest
 *
 * Holding a tool. `config.tools` says what an agent is permitted; `cycle_steps.tool` says
 * what it has actually done. A granted tool nobody has ever called is not evidence of
 * capability, so usage outranks grants, and both are shown rather than collapsed into a
 * score the caller cannot audit.
 */
import { randomUUID } from 'crypto';
import {
  getAllAgents,
  getToolsUsedByAgent,
  getCyclesByAgent,
  recordCapabilityGap,
  getHandoffReplyStats,
  getToolUsageCounts,
} from '../db.js';
import type { Agent } from '../types.js';

export interface CapabilityMatch {
  agentId: string;
  name: string;
  role: string;
  /** Tools this agent is granted that matched the query. */
  holds: string[];
  /** Of those, the ones it has actually called, with counts and recency. */
  used: Array<{ tool: string; calls: number; lastAt: string | null }>;
  status: string;
  /** Cycles in the last 7 days. Zero means recommending it is recommending silence. */
  cyclesLast7d: number;
  /** How it has answered requests since phase 1. Null when it has no history yet. */
  replies: {
    answered: number;
    asked: number;
    medianHours: number | null;
  } | null;
  /** Why this agent surfaced: 'tool' beats 'role' beats 'goal'. */
  matchedOn: Array<'tool' | 'role' | 'goal' | 'type'>;
  score: number;
}

/**
 * Words that match everything and therefore mean nothing.
 *
 * Without this, `find_agent("can someone please find me an email")` matches every agent
 * that has ever had the word "a" in a goal, and a result list that contains everyone is
 * the same as no result list at all.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'for',
  'with',
  'in',
  'on',
  'at',
  'by',
  'is',
  'are',
  'was',
  'be',
  'can',
  'could',
  'would',
  'who',
  'what',
  'which',
  'that',
  'this',
  'it',
  'me',
  'my',
  'i',
  'you',
  'your',
  'we',
  'us',
  'someone',
  'anyone',
  'please',
  'help',
  'need',
  'needs',
  'want',
  'wants',
  'able',
  'agent',
  'tool',
  'do',
  'does',
  'has',
  'have',
  'get',
  'gets',
  'here',
  'from',
  'about',
  'how',
]);

/**
 * Hand-written synonyms, because the vocabulary an agent uses to describe a need is not
 * the vocabulary a tool was named with.
 *
 * Kept small and explicit on purpose. A wrong synonym routes work to the wrong agent
 * silently, which is worse than a miss — a miss is at least recorded as a capability gap
 * and can be acted on. Every entry here should be one somebody has actually needed.
 */
const SYNONYMS: Record<string, string[]> = {
  email: ['mail', 'smtp', 'outreach', 'inbox', 'message'],
  verify: ['validate', 'check', 'confirm'],
  scrape: ['crawl', 'extract', 'fetch', 'harvest'],
  search: ['find', 'lookup', 'discover', 'query'],
  browser: ['web', 'page', 'site', 'click', 'effector', 'navigate'],
  lead: ['prospect', 'contact', 'company'],
  write: ['draft', 'compose', 'author'],
  call: ['phone', 'voice', 'dial'],
  pdf: ['document', 'doc'],
  job: ['vacancy', 'posting', 'hiring'],
  linkedin: ['li', 'profile'],
  memory: ['remember', 'recall', 'knowledge'],
  file: ['read', 'write', 'workspace'],
  code: ['script', 'python', 'exec', 'run'],
};

/** Query → the set of terms that will be matched, expanded by synonym. */
export function expandQuery(query: string): string[] {
  const base = String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  const out = new Set(base);
  for (const w of base) {
    for (const syn of SYNONYMS[w] ?? []) out.add(syn);
    // Reverse direction too: a query for "mail" should reach the `email` family.
    for (const [key, syns] of Object.entries(SYNONYMS)) {
      if (syns.includes(w)) out.add(key);
    }
  }
  return [...out];
}

/** Does `haystack` contain any of `terms`? Substring, so `email` hits `verify_email`. */
function hits(haystack: string, terms: string[]): string[] {
  const h = haystack.toLowerCase();
  return terms.filter((t) => h.includes(t));
}

export interface FindAgentOptions {
  /** Never returns the caller — an agent asking who can help means someone else. */
  excludeAgentId: string;
  /** Same-owner only. The boundary stage 54 already proved. */
  ownerId?: string | null;
  limit?: number;
  /** Free text the agent was working on, stored with a miss so a gap has context. */
  context?: string;
}

export function findAgents(
  query: string,
  opts: FindAgentOptions,
): CapabilityMatch[] {
  const terms = expandQuery(query);
  if (terms.length === 0) return [];

  const now = Date.now();
  const WEEK = 7 * 86_400_000;

  // No owner, no crew: a null owner used to search every account's agents.
  if (!opts.ownerId) return [];
  const candidates = getAllAgents().filter(
    (a) => a.id !== opts.excludeAgentId && a.owner_id === opts.ownerId,
  );

  const matches: CapabilityMatch[] = [];

  for (const agent of candidates) {
    const granted = agent.config?.tools ?? [];
    const holds = granted.filter((t) => hits(t, terms).length > 0);

    const role = (agent.config?.role ?? '').toString();
    const goals = (agent.config?.goals ?? '').toString();
    const roleHit = hits(role, terms).length > 0;
    const goalHit = hits(goals, terms).length > 0;
    const typeHit = hits(agent.type ?? '', terms).length > 0;

    if (holds.length === 0 && !roleHit && !goalHit && !typeHit) continue;

    // Held vs used. The honest signal is the second one.
    const usageCounts = getToolUsageCounts(agent.id, holds);
    const used = holds
      .map((t) => ({
        tool: t,
        calls: usageCounts[t]?.calls ?? 0,
        lastAt: usageCounts[t]?.lastAt ?? null,
      }))
      .filter((u) => u.calls > 0)
      .sort((a, b) => b.calls - a.calls);

    const cyclesLast7d = getCyclesByAgent(agent.id, 200).filter(
      (c) => now - new Date(c.started_at).getTime() < WEEK,
    ).length;

    const matchedOn: CapabilityMatch['matchedOn'] = [];
    if (holds.length) matchedOn.push('tool');
    if (roleHit) matchedOn.push('role');
    if (goalHit) matchedOn.push('goal');
    if (typeHit) matchedOn.push('type');

    // Ranking, in plain terms: proven use of a matching tool beats holding one, holding
    // one beats a role that reads right, and an agent that has not run in a week is
    // pushed down because recommending it is recommending silence.
    const score =
      used.reduce((s, u) => s + Math.min(u.calls, 50), 0) * 2 +
      holds.length * 20 +
      (roleHit ? 15 : 0) +
      (goalHit ? 5 : 0) +
      (typeHit ? 5 : 0) +
      (cyclesLast7d > 0 ? 25 : 0) +
      (agent.status === 'running' ? 10 : 0);

    matches.push({
      agentId: agent.id,
      name: agent.name,
      role: role || agent.type,
      holds,
      used,
      status: agent.status,
      cyclesLast7d,
      replies: getHandoffReplyStats(agent.id),
      matchedOn,
      score,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, opts.limit ?? 5);

  // A miss is the product. Record it before returning nothing.
  if (top.length === 0) {
    recordCapabilityGap({
      agentId: opts.excludeAgentId,
      query,
      context: opts.context ?? null,
    });
  }

  return top;
}

/** The text an agent reads. Rendered here so wording ships with a normal deploy. */
export function renderMatches(
  query: string,
  matches: CapabilityMatch[],
): string {
  if (matches.length === 0) {
    return (
      `No agent on your crew matches "${query}".\n\n` +
      `This has been recorded as a capability gap for your owner — you do not need to raise it again.\n` +
      `Do not invent a teammate or guess a name. Either do it yourself with the tools you have, ` +
      `or use \`clarify\` to ask your owner for the capability, naming exactly what you need.`
    );
  }

  const L: string[] = [`Agents that may be able to help with "${query}":`, ''];
  for (const m of matches) {
    L.push(`${m.name} — ${m.role}`);
    if (m.used.length) {
      L.push(
        `  proven: ${m.used.map((u) => `${u.tool} (${u.calls} calls, last ${u.lastAt ? u.lastAt.slice(0, 10) : 'unknown'})`).join(', ')}`,
      );
    }
    const unproven = m.holds.filter((h) => !m.used.some((u) => u.tool === h));
    if (unproven.length) {
      L.push(
        `  granted but never used: ${unproven.join(', ')} — it holds these, it has not done it`,
      );
    }
    if (!m.holds.length) {
      L.push(
        `  matched on its ${m.matchedOn.join(' and ')}, not on a tool — it may be the right agent, but nothing proves it can`,
      );
    }
    L.push(
      `  ${m.status} · ${m.cyclesLast7d} cycles in the last 7 days` +
        (m.cyclesLast7d === 0
          ? ' — IT IS NOT AWAKE. Sending it work will not get it done unless someone wakes it.'
          : ''),
    );
    if (m.replies && m.replies.asked > 0) {
      L.push(
        `  answers: ${m.replies.answered} of ${m.replies.asked} requests` +
          (m.replies.medianHours !== null
            ? `, typically within ${m.replies.medianHours}h`
            : ''),
      );
    } else {
      L.push('  answers: no history — nobody has asked it anything yet');
    }
    L.push('');
  }
  L.push(
    'To ask one of them, use `handoff_to` with its NAME. It will answer on its next cycle.',
  );
  L.push(
    'To use a tool one of them holds without waking it, use `borrow_tool`.',
  );
  return L.join('\n');
}

export const __testExports = { STOPWORDS, SYNONYMS, randomUUID };
