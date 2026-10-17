import fs from 'fs';
import path from 'path';
import {
  createHandoff,
  getHandoffsByAgent,
  getPendingHandoffsByAgent,
  updateHandoffStatus,
  updateHandoffNote,
  getAllAgents,
  findDuplicateRequest,
  getAgent,
} from '../db.js';
import type {
  AgentHandoff,
  HandoffStatus,
  HandoffPerformative,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { canWake } from './wake-policy.js';

const AGENTS_DIR = path.join(DATA_DIR, 'agents');

// Open string type — not locked to 4 specific values
export type HandoffType = string;

// Stage 56 phase 1: one vocabulary, defined in db.ts next to the migration that renamed
// `acknowledged` to `seen`. This file re-exports rather than redeclaring — the two lists
// drifting apart is how a status the UI filters on stops matching the one the DB writes.
export type { HandoffStatus, HandoffPerformative } from '../db.js';

export interface CreateHandoffInput {
  fromAgentId: string;
  toAgentId: string;
  type: HandoffType;
  payload: unknown;
  note?: string;
  /** Defaults to `request`. `inform` means "no answer wanted" and is not chased. */
  performative?: HandoffPerformative;
  /** The cycle that sent this, for provenance on the reply chain. */
  cycleId?: string;
  /**
   * The message this follows up on. Stage 56 phase 4: it puts the new request in the same
   * thread, so a negotiation is one conversation rather than a scatter of messages about
   * the same subject.
   */
  inReplyTo?: string;
  threadId?: string;
  /**
   * When this lapses if unanswered. Every request should carry one — without a deadline
   * the first mutual wait deadlocks two agents permanently and both look healthy.
   */
  deadlineAt?: string;
}

/**
 * ISSUE-001 fix: scan payload for file/files references and copy them
 * from the sender's workspace into the recipient's inbox directory.
 * Updates the payload paths to point to the local inbox copies.
 *
 * Two shapes are accepted, because agents produce both:
 *   - PATHS   — `file: "x.md"`, `files: ["a.md","b.md"]`, `attachment: "c.md"`
 *               → copied out of the sender's workspace.
 *   - CONTENT — `files: { "KNOWLEDGE_SEED.md": "# ...", ... }`
 *               → written straight into the inbox.
 *
 * The content shape isn't a nicety: a real handoff (Recruiter → Sandbox Tester,
 * 2026-07-17) sent exactly that, `Array.isArray({...})` was false, the key was skipped,
 * and the function returned having copied NOTHING — no error, no warning, handoff marked
 * completed. The agent reported success, the recipient's inbox didn't even exist, and the
 * only trace was a missing directory. A malformed payload must never be indistinguishable
 * from a delivered one, so anything still unusable now warns loudly.
 */
function deliverNamedFiles(
  fromAgentId: string,
  toAgentId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const srcWorkspace = path.join(AGENTS_DIR, fromAgentId, 'workspace');
  const dstInbox = path.join(AGENTS_DIR, toAgentId, 'workspace', 'inbox');

  const filesToDeliver: string[] = [];
  // name → content, for agents that inline the file instead of referencing a path
  const inlineFiles: Array<{ name: string; content: string }> = [];

  // Collect file references from common payload keys
  if (typeof payload.file === 'string') filesToDeliver.push(payload.file);
  if (Array.isArray(payload.files))
    payload.files.forEach(
      (f) => typeof f === 'string' && filesToDeliver.push(f),
    );
  if (typeof payload.attachment === 'string')
    filesToDeliver.push(payload.attachment);

  // `files` as an object of name → content.
  if (
    payload.files &&
    !Array.isArray(payload.files) &&
    typeof payload.files === 'object'
  ) {
    for (const [name, content] of Object.entries(
      payload.files as Record<string, unknown>,
    )) {
      if (typeof content === 'string' && content.length > 0)
        inlineFiles.push({ name, content });
    }
  }

  if (filesToDeliver.length === 0 && inlineFiles.length === 0) {
    // The sender meant to attach something and we couldn't use any of it — say so.
    // Silence here is what let a "successful" handoff deliver nothing at all.
    if (payload.file || payload.files || payload.attachment) {
      logger.warn(
        {
          fromAgentId,
          toAgentId,
          fileType: typeof payload.file,
          filesType: Array.isArray(payload.files)
            ? 'array'
            : typeof payload.files,
        },
        'Handoff payload referenced files but none were usable — nothing delivered',
      );
    }
    return payload;
  }

  fs.mkdirSync(dstInbox, { recursive: true });

  const updated = { ...payload };
  const deliveredFiles: string[] = [];

  // Inline content → write it into the inbox. basename() keeps a crafted name (or an
  // LLM-invented one like "../../x") from escaping the recipient's own inbox.
  for (const { name, content } of inlineFiles) {
    const filename = path.basename(name);
    if (!filename || filename === '.' || filename === '..') {
      logger.warn(
        { fromAgentId, toAgentId, name },
        'Handoff inline file has an unusable name — skipping',
      );
      continue;
    }
    fs.writeFileSync(path.join(dstInbox, filename), content, 'utf-8');
    deliveredFiles.push(filename);
    logger.info(
      { fromAgentId, toAgentId, filename, bytes: content.length },
      'Handoff inline file written to inbox',
    );
  }
  if (inlineFiles.length > 0) {
    // Rewrite to the paths the recipient can actually read.
    updated.files = deliveredFiles.map((f) => `inbox/${f}`);
  }

  const undelivered: string[] = [];
  for (const relPath of filesToDeliver) {
    const srcFile = resolveSenderFile(srcWorkspace, relPath);
    if (!srcFile) {
      logger.warn(
        { fromAgentId, toAgentId, relPath },
        'Handoff file not found in the sender workspace — skipping',
      );
      undelivered.push(relPath);
      continue;
    }
    const filename = path.basename(srcFile);
    const dstFile = path.join(dstInbox, filename);
    fs.copyFileSync(srcFile, dstFile);
    deliveredFiles.push(filename);
    logger.info(
      { fromAgentId, toAgentId, filename },
      'Handoff file delivered to inbox',
    );
  }

  if (deliveredFiles.length > 0) {
    // Rewrite references so recipient sees local inbox paths
    if (typeof updated.file === 'string')
      updated.file = `inbox/${path.basename(updated.file as string)}`;
    if (Array.isArray(updated.files))
      updated.files = (updated.files as string[]).map(
        (f) => `inbox/${path.basename(f)}`,
      );
    if (typeof updated.attachment === 'string')
      updated.attachment = `inbox/${path.basename(updated.attachment as string)}`;
    (updated as any)._deliveredFiles = deliveredFiles;
  }
  if (undelivered.length > 0) (updated as any)._undeliveredFiles = undelivered;

  return updated;
}

/** How an agent sees its own workspace from inside its container. */
const CONTAINER_WORKSPACE = '/workspace/group/workspace/';

/**
 * A path an agent wrote, resolved to a real file inside ITS OWN workspace — or null.
 *
 * Agents write paths the way they see them: `tracked/x.md`, `workspace/tracked/x.md`, or the
 * container path `/workspace/group/workspace/tracked/x.md`. The last one used to resolve to
 * a host path outside the workspace and was skipped without a word, so a handoff naming its
 * list that way arrived with nothing attached.
 */
function resolveSenderFile(srcWorkspace: string, ref: string): string | null {
  let rel = String(ref ?? '').trim();
  if (rel.startsWith(CONTAINER_WORKSPACE))
    rel = rel.slice(CONTAINER_WORKSPACE.length);
  else if (path.isAbsolute(rel) || rel.startsWith('/')) return null; // not the sender's workspace
  const root = path.resolve(srcWorkspace);
  const tries = rel.startsWith('workspace/')
    ? [rel, rel.slice('workspace/'.length)]
    : [rel];
  for (const t of tries) {
    const abs = path.resolve(root, t);
    // Security: must stay inside the sender's workspace.
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch {
      /* not there */
    }
  }
  return null;
}

// A file path inside any string: optionally the container prefix, then AT LEAST one folder,
// then an extension an agent actually hands over. The folder is required: a bare name in
// prose ("read LEAD_DEFINITION.md first") names the recipient's own copy as often as the
// sender's, and copying it over would rewrite the sentence. Bare names still work under
// `file` / `files`. Anything matched is only used if the file really exists in the sender's
// workspace, so a URL that happens to match is inert.
const EMBEDDED_PATH =
  /(?:\/workspace\/group\/workspace\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:md|json|jsonl|csv|tsv|txt|html|pdf|xlsx|yaml|yml)\b/g;
const MAX_EMBEDDED_REFS = 40;

/**
 * Deliver files named ANYWHERE in the payload, not only under `file` / `files` / `attachment`.
 *
 * On 2026-09-13 Crawler handed Finder its 21-company list as
 * `full_report: "/workspace/group/workspace/tracked/round2-find-20.md (each row: …)"` — the
 * tool never said which key to use — and nothing was copied: Finder was handed a path into a
 * workspace it cannot read. Every embedded path that exists in the sender's workspace is now
 * copied to the recipient's inbox and rewritten to `inbox/<name>`. A container path that does
 * NOT exist is reported back as undelivered; other non-matches are ignored.
 */
function deliverEmbeddedFiles(
  fromAgentId: string,
  toAgentId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const srcWorkspace = path.join(AGENTS_DIR, fromAgentId, 'workspace');
  const dstInbox = path.join(AGENTS_DIR, toAgentId, 'workspace', 'inbox');
  const rewrites = new Map<string, string>();
  const delivered: string[] = [];
  const missing: string[] = [];
  let seen = 0;

  const scan = (value: unknown, depth: number): void => {
    if (depth > 4 || seen >= MAX_EMBEDDED_REFS) return;
    if (typeof value === 'string') {
      for (const m of value.match(EMBEDDED_PATH) ?? []) {
        if (seen++ >= MAX_EMBEDDED_REFS || rewrites.has(m)) continue;
        const src = resolveSenderFile(srcWorkspace, m);
        if (!src) {
          if (m.startsWith(CONTAINER_WORKSPACE)) missing.push(m);
          continue;
        }
        fs.mkdirSync(dstInbox, { recursive: true });
        const name = path.basename(src);
        fs.copyFileSync(src, path.join(dstInbox, name));
        rewrites.set(m, `inbox/${name}`);
        if (!delivered.includes(name)) delivered.push(name);
        logger.info(
          { fromAgentId, toAgentId, filename: name, ref: m },
          'Handoff file (named in the payload) delivered to inbox',
        );
      }
    } else if (Array.isArray(value)) {
      value.forEach((v) => scan(v, depth + 1));
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach((v) =>
        scan(v, depth + 1),
      );
    }
  };
  for (const [k, v] of Object.entries(payload)) {
    if (
      k === 'file' ||
      k === 'files' ||
      k === 'attachment' ||
      k.startsWith('_')
    )
      continue;
    scan(v, 0);
  }
  if (rewrites.size === 0 && missing.length === 0) return payload;

  const rewrite = (value: unknown, depth: number): unknown => {
    if (depth > 4) return value;
    if (typeof value === 'string') {
      let s = value;
      for (const [from, to] of rewrites) s = s.split(from).join(to);
      return s;
    }
    if (Array.isArray(value)) return value.map((v) => rewrite(v, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          rewrite(v, depth + 1),
        ]),
      );
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] =
      k === 'file' || k === 'files' || k === 'attachment' || k.startsWith('_')
        ? v
        : rewrite(v, 0);
  }
  if (delivered.length)
    out._deliveredFiles = [
      ...new Set([
        ...((payload._deliveredFiles as string[]) ?? []),
        ...delivered,
      ]),
    ];
  if (missing.length)
    out._undeliveredFiles = [
      ...((payload._undeliveredFiles as string[]) ?? []),
      ...missing,
    ];
  if (missing.length)
    logger.warn(
      { fromAgentId, toAgentId, missing },
      'Handoff named files that are not in the sender workspace — not delivered',
    );
  return out;
}

/** Named keys first (`file` / `files` / `attachment`, and inline content), then any path
 *  named anywhere else in the payload. */
function deliverFiles(
  fromAgentId: string,
  toAgentId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return deliverEmbeddedFiles(
    fromAgentId,
    toAgentId,
    deliverNamedFiles(fromAgentId, toAgentId, payload),
  );
}

/** Exported for tests only — see agent-handoff.test.ts. Not for application code. */
export const __testDeliverFiles = deliverFiles;

/**
 * The ONE place a handoff target name is resolved.
 *
 * There were three code paths and two different resolvers. `handoff_to` (the tool an agent
 * actually calls) POSTs to `/api/agents/:id/handoffs`, which resolved id → name → lowercase
 * name. `handoffs_out.json` is drained by `agent-service._processHandoffs`, which resolved
 * id → name → lowercase name → type → lowercase type. Adding role matching to only the
 * second one fixed nothing, because the tool never goes through it.
 *
 * That is the disease this repo keeps paying for — one decision implemented in several
 * places, agreeing only by convention. Both callers now use this function.
 *
 * Resolution is exact at every step. No fuzzy or substring matching: "Seeker" inside
 * "Lead Hunter" caused silent misrouting once already.
 *
 * `role` is the last resort and the reason this exists: an agent names a target by the JOB
 * it wants done, not by the proper name a human gave the agent. Finder asked for "outreach"
 * on three cycles while the outreach agent was called "Mailer", and every one of those
 * qualified leads was discarded.
 */
/**
 * The agents a message from `fromAgentId` may reach: its own owner's, nobody else's.
 *
 * Every agent-side path used to resolve a name against every agent on the platform. On
 * 2026-09-14 Mechanic sent 11 messages to "Recruiter" and all of them landed with a
 * different customer's Recruiter — six accounts each have one, and the first match won.
 * An inform only sits in a queue; a `request` wakes the recipient, so the same call
 * would have run a cycle on another customer's agent, on their budget. The not-found
 * reply also listed other accounts' agents by name and id.
 *
 * An agent with no owner has no teammates — the rule self-manage's sibling lookup
 * already uses, because matching null to null makes every unowned agent a teammate.
 */
export function crewOf<T extends { id: string; owner_id?: string | null }>(
  fromAgentId: string,
  agents: T[],
): T[] {
  const owner = getAgent(fromAgentId)?.owner_id;
  if (!owner) return [];
  return agents.filter((a) => a.owner_id === owner);
}

export function resolveHandoffTarget<
  T extends {
    id: string;
    name: string;
    type?: string;
    config?: { role?: string };
  },
>(agents: T[], rawTarget: string): T | undefined {
  const trimmed = String(rawTarget ?? '').trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  return (
    agents.find((a) => a.id === trimmed) ||
    agents.find((a) => a.name === trimmed) ||
    agents.find((a) => a.name.toLowerCase() === lower) ||
    agents.find((a) => a.type === trimmed) ||
    agents.find((a) => (a.type ?? '').toLowerCase() === lower) ||
    agents.find((a) => (a.config?.role ?? '').trim().toLowerCase() === lower)
  );
}

export class AgentHandoffService {
  createHandoff(input: CreateHandoffInput): AgentHandoff {
    let payload =
      typeof input.payload === 'object' && input.payload !== null
        ? (input.payload as Record<string, unknown>)
        : input.payload;

    // ISSUE-001: auto-deliver referenced files to recipient inbox
    if (typeof payload === 'object' && payload !== null) {
      try {
        payload = deliverFiles(
          input.fromAgentId,
          input.toAgentId,
          payload as Record<string, unknown>,
        );
      } catch (err) {
        logger.warn(
          { err, fromAgentId: input.fromAgentId },
          'File delivery failed — handoff created without files',
        );
      }
    }

    return createHandoff({
      from_agent_id: input.fromAgentId,
      to_agent_id: input.toAgentId,
      type: input.type,
      payload: JSON.stringify(payload),
      note: input.note,
      status: 'pending',
      performative: input.performative ?? 'request',
      cycle_id: input.cycleId,
      reply_to: input.inReplyTo,
      thread_id: input.threadId ?? input.inReplyTo,
      deadline_at: input.deadlineAt,
    });
  }

  getHandoffsForAgent(agentId: string): AgentHandoff[] {
    return getHandoffsByAgent(agentId);
  }

  /** Everything undelivered — work handed to it AND answers to work it handed out. */
  getPendingHandoffs(agentId: string): AgentHandoff[] {
    return getPendingHandoffsByAgent(agentId);
  }

  /** Only work owed. Pass this wherever the answer decides whether the agent must act. */
  getPendingWork(agentId: string): AgentHandoff[] {
    return getPendingHandoffsByAgent(agentId, { workOnly: true });
  }

  updateStatus(handoffId: string, status: HandoffStatus, note?: string): void {
    updateHandoffStatus(handoffId, status);
    if (note) updateHandoffNote(handoffId, note);
  }

  /** "It reached my context." NOT "I did it" — that distinction is the whole of phase 1. */
  markSeen(handoffId: string): void {
    this.updateStatus(handoffId, 'seen');
  }
  agreeHandoff(handoffId: string): void {
    this.updateStatus(handoffId, 'agreed');
  }
  refuseHandoff(handoffId: string, reason?: string): void {
    this.updateStatus(handoffId, 'refused', reason);
  }
  completeHandoff(handoffId: string, note?: string): void {
    this.updateStatus(handoffId, 'completed', note);
  }

  findAgentByType(agentType: string): string | null {
    const agents = getAllAgents();
    return agents.find((a) => a.type === agentType)?.id ?? null;
  }
}

export const agentHandoffService = new AgentHandoffService();

/**
 * The ONE place an inbound "create a handoff" request is turned into a handoff.
 *
 * There are two routes: `app.post('/api/agents/:id/handoffs')` registered directly in
 * server.ts, and `agentsRouter.post('/:id/handoffs')`. The first is matched by Express and
 * is the one every agent actually reaches; the second serves the dashboard. This file
 * already carries a comment about that split costing two failed fixes to the target
 * resolver — and stage 56 phase 4 walked into it a third time, adding threading and
 * deadlines to the copy agents never touch. The handoff came out with a thread but no
 * deadline, which is a deadline that does not exist.
 *
 * Resolution, threading, deadlines and validation live here now. A route's job is to
 * authenticate and to hand over the body.
 */
export interface HandoffRequestBody {
  toAgentId?: unknown;
  type?: unknown;
  payload?: unknown;
  note?: unknown;
  performative?: unknown;
  cycleId?: unknown;
  inReplyTo?: unknown;
  deadlineHours?: unknown;
}

export function createHandoffFromRequest<
  T extends {
    id: string;
    name: string;
    type?: string;
    owner_id?: string | null;
    config?: { role?: string };
  },
>(
  fromAgentId: string,
  body: HandoffRequestBody,
  candidates: T[],
  getParent: (id: string) => {
    id: string;
    thread_id?: string;
    from_agent_id: string;
    to_agent_id: string;
  } | null,
): { status: number; body: unknown } {
  const {
    toAgentId: toRaw,
    type,
    payload,
    note,
    performative,
    cycleId,
    inReplyTo,
    deadlineHours,
  } = body;

  if (!toRaw || !type || payload === undefined) {
    return {
      status: 400,
      body: { error: 'toAgentId, type, payload required' },
    };
  }
  // Only these two OPEN an exchange. The answering verbs go through reply_to_handoff,
  // which stamps the message it answers — sending one as a fresh handoff would leave the
  // original still reading as unanswered.
  if (performative && performative !== 'request' && performative !== 'inform') {
    return {
      status: 400,
      body: {
        error:
          "performative must be 'request' or 'inform' — the answering verbs go through reply_to_handoff.",
      },
    };
  }

  // Scoped here, not by the caller: the internal route passes every agent on the
  // platform, and an admin's dashboard list is every agent too. See crewOf.
  const allAgents = crewOf(fromAgentId, candidates);
  const resolved = resolveHandoffTarget(allAgents, String(toRaw));
  if (!resolved) {
    return {
      status: 404,
      body: {
        error: `Target agent not found: "${toRaw}". Pass an exact agent id, name, or role.`,
        availableAgents: allAgents
          .filter((a) => a.id !== fromAgentId)
          .slice(0, 20)
          .map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            role: a.config?.role,
          })),
      },
    };
  }
  if (resolved.id === fromAgentId)
    return { status: 400, body: { error: 'Cannot hand off to self.' } };

  // A follow-up joins the thread it follows up on, so a negotiation is one conversation
  // rather than a scatter of messages about the same subject. The parent must be one end
  // of an exchange this agent is in — otherwise an agent could graft its question onto a
  // conversation between two others and have the answer read as belonging there.
  let threadId: string | undefined;
  const parentId =
    typeof inReplyTo === 'string' && inReplyTo.trim()
      ? inReplyTo.trim()
      : undefined;
  if (parentId) {
    const parent = getParent(parentId);
    if (!parent)
      return {
        status: 404,
        body: { error: `No message with id "${parentId}" to follow up on.` },
      };
    if (
      parent.from_agent_id !== fromAgentId &&
      parent.to_agent_id !== fromAgentId
    ) {
      return {
        status: 403,
        body: {
          error: 'That message is not part of a conversation you are in.',
        },
      };
    }
    threadId = parent.thread_id ?? parent.id;
  }

  // Every request carries a deadline. Without one the first mutual wait deadlocks two
  // agents permanently and both look healthy — the requests sit `agreed` forever and
  // nothing reports it, exactly as 347 handoffs read as `acknowledged`. `inform` gets
  // none: nothing is owed, so nothing can lapse.
  // ── Idempotency and the per-cycle cap ────────────────────────────────────
  //
  // Both only apply within a cycle, and both need the cycle id to do anything. A caller
  // that does not send one gets neither — deliberately: the dashboard has no cycle, and
  // capping a human's handoffs would be nonsense.
  const cycle =
    typeof cycleId === 'string' && cycleId.trim() ? cycleId.trim() : null;
  const payloadJson = JSON.stringify(payload);

  if (cycle) {
    // "The same request twice should return the first answer, not run twice" (`06`).
    // A retry loop that re-sends an identical handoff gets back the row it already made,
    // and the recipient is not shown the same question ninety times.
    const dupe = findDuplicateRequest(
      fromAgentId,
      resolved.id,
      cycle,
      String(type),
      payloadJson,
    );
    if (dupe) {
      return {
        status: 200,
        body: {
          ...dupe,
          duplicate: true,
          note: 'You already sent this exact message this cycle. Nothing new was created — this is the message you already sent. Move on.',
        },
      };
    }
  }

  const hours = Number(deadlineHours);
  const wantsAnswer = (performative ?? 'request') === 'request';
  const deadlineAt = wantsAnswer
    ? new Date(
        Date.now() +
          (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 720) : 48) *
            3_600_000,
      ).toISOString()
    : undefined;

  const handoff = agentHandoffService.createHandoff({
    fromAgentId,
    toAgentId: resolved.id,
    type: String(type),
    payload,
    note: typeof note === 'string' ? note : undefined,
    performative: performative as HandoffPerformative | undefined,
    cycleId: typeof cycleId === 'string' ? cycleId : undefined,
    inReplyTo: parentId,
    threadId,
    deadlineAt,
  });

  return { status: 201, body: handoff };
}

/**
 * Should this handoff wake its recipient right now?
 *
 * Stage 59 (small fix, 2026-09-13). Before this, `handoff_to` was the one trigger in the
 * codebase that respected `trigger_mode: on_demand` — `ask_agent` (stage 56 phase 5),
 * inbound webhooks, and the outreach follow-up timer all already call `runCycle` directly
 * regardless of it. That made a manual agent's "safety" from surprise cycles an accident of
 * which tool a sender happened to reach for, not a real guarantee. This closes that one gap
 * by reusing the same wake `ask_agent` already does, not by inventing a new mechanism.
 *
 * Only a `request` wakes anyone — an `inform` has nothing owed on it, so nothing should
 * spend a cycle reacting to it. And only when the recipient isn't already running (its next
 * cycle will see this handoff on its own; `runCycle` also refuses a concurrent start), not
 * stopped by its owner (only they may start it again), and its `wakePolicy.handoff` isn't
 * turned off — the two status guards `ask_agent` already enforces in `self-manage.ts`, plus
 * the stage 59 policy check both now share via `canWake`.
 */
export function shouldWakeOnHandoff(
  performative: HandoffPerformative | undefined,
  target:
    | {
        status?: string;
        config: {
          wakePolicy?: import('../types.js').AgentConfig['wakePolicy'];
        };
      }
    | undefined,
): boolean {
  if ((performative ?? 'request') !== 'request') return false;
  if (!target || !target.status) return false;
  if (target.status === 'running') return false;
  return canWake(target, 'handoff');
}
