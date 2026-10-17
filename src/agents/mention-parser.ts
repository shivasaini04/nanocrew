/**
 * Parses @AgentName mentions from a chat message and fuzzy-resolves each to
 * a registered agent. Returns one entry per resolved mention with the task
 * text that follows it (up to the next mention or end of string).
 */
import { getAllAgents, getAgentsByOwner } from '../db.js';
import type { Agent } from '../types.js';

export interface ParsedMention {
  agentId: string;
  agentName: string;
  agentEmoji: string;
  task: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_\[\]]+/g, '');
}

function fuzzyResolve(token: string, agents: Agent[]): Agent | null {
  const normToken = normalize(token);
  // 1. Exact normalized match
  let a = agents.find((ag) => normalize(ag.name) === normToken);
  if (a) return a;
  // 2. Agent name starts with token (handles @Analyst → "Analyst Agent")
  a = agents.find((ag) => normalize(ag.name).startsWith(normToken));
  if (a) return a;
  // 3. Token contains agent name's first word (handles @AnalystAgent → "Analyst Agent")
  a = agents.find((ag) => {
    const firstWord = normalize(ag.name.split(' ')[0]);
    return normToken.includes(firstWord) && firstWord.length >= 3;
  });
  if (a) return a;
  // 4. Agent name contains token
  a = agents.find(
    (ag) => normalize(ag.name).includes(normToken) && normToken.length >= 3,
  );
  return a ?? null;
}

/**
 * Returns parsed mentions from the message text.
 * Returns [] if no valid @AgentName mentions are found.
 *
 * SECURITY: pass `ownerId` to resolve ONLY within that owner's agents. Multi-tenant
 * callers (per-client WhatsApp, Stage 30) MUST pass it — otherwise `@dev` could resolve
 * to another tenant's agent. Omitting it falls back to the global, single-tenant set.
 */
export function parseMentions(text: string, ownerId?: string): ParsedMention[] {
  const all = ownerId ? getAgentsByOwner(ownerId) : getAllAgents();
  const agents = all.filter((a) => a.status !== 'paused');
  if (!agents.length) return [];

  // Match @Word or @Multi-Word (up to 4 words, hyphens allowed)
  const mentionRegex = /@([\w][\w\-]*(?:[\s][\w\-]+){0,3})/g;
  const segments: Array<{
    token: string;
    startPos: number;
    endPos: number;
    agent: Agent | null;
  }> = [];

  let m: RegExpExecArray | null;
  while ((m = mentionRegex.exec(text)) !== null) {
    segments.push({
      token: m[1].trim(),
      startPos: m.index,
      endPos: m.index + m[0].length,
      agent: fuzzyResolve(m[1].trim(), agents),
    });
  }

  const resolved = segments.filter((s) => s.agent !== null);
  if (!resolved.length) return [];

  return resolved.map((s, i) => {
    const taskStart = s.endPos;
    const taskEnd =
      i + 1 < resolved.length ? resolved[i + 1].startPos : text.length;
    const task = text.slice(taskStart, taskEnd).trim();
    return {
      agentId: s.agent!.id,
      agentName: s.agent!.name,
      agentEmoji: s.agent!.emoji ?? '🤖',
      // Fallback to full message so the agent always has something to act on
      task: task || text,
    };
  });
}

/** Returns true if the text contains at least one resolvable @mention. */
export function hasMentions(text: string): boolean {
  return /@\w/.test(text) && parseMentions(text).length > 0;
}
