import { randomUUID, randomBytes } from 'crypto';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import nodemailer from 'nodemailer';
import type { LaneHint } from './local-lane-routing.js';
import {
  insertAgent,
  setAgentOwner as dbSetAgentOwner,
  updateAgentConfig as dbUpdateAgentConfig,
  getAgent as dbGetAgent,
  getAllAgents as dbGetAllAgents,
  updateAgentStatus,
  updateAgentLastActive,
  updateAgentIdentityVersion,
  updateAgentFields,
  deleteAgent as dbDeleteAgent,
  createAgentCycle,
  updateAgentCycle,
  failCycleIfStillRunning,
  getCyclesByAgent,
  getCycleCostToday,
  getPlatformCostToday,
  getUserById,
  getUserByok,
  countUserCyclesThisMonth,
  recordUsageAlert,
  getWeeklyCycles,
  getMemoryByAgent,
  createAgentCheckin,
  getCheckinById,
  updateAgentCheckin,
  getPendingHandoffsByAgent,
  getOpenMessagesForAgent,
  getThread,
  updateHandoffStatus,
  createHandoff,
  upsertEntitySchema,
  getEntitySchema,
  upsertTrackedItem,
  buildTrackedUrlIndex,
  getTrackedItems,
  getAgentProjects,
  getProject,
  linkAgentToProject,
  createAgentMessage,
  getUnreadAgentMessages,
  markAgentMessageRead,
  getSubAgents,
  getMatchingPipelines,
  logPipelineRun,
  updatePipelineRunTarget,
  clearAgentInterruptFlag,
  setAgentInterruptFlag,
  storeChatMetadata,
  storeMessageDirect,
  replaceCycleSteps,
  decayAndPruneMemories,
  getLastCycleForProject,
  queueFastlane,
  getDistilledEpisodeDates,
  markEpisodesDistilled,
} from '../db.js';
import { recordConfigAudit } from '../db.js';
import { recordModelWorked, rollbackModelIfBricked } from './model-safety.js';
import type { CycleStep, AgentHandoff } from '../db.js';
import { startCycleStream, endCycleStream } from '../cycle-activity-stream.js';
import {
  appendConversationEvent,
  appendChatMessageEvent,
} from '../conversation-events.js';
import { detectResultFailure, looksLikeErrorText } from './cycle-failure.js';
import { notify } from '../notifications.js';
import { sendPlainTextMail, isEmailConfigured } from '../auth/mailer.js';
import { resolveHandoffTarget, crewOf } from './agent-handoff.js';
import { recordOutreachSend, getLatestOutreachSendForLead } from '../db.js';
import type {
  Agent,
  AgentCheckin,
  AgentConfig,
  AgentCycle,
  AgentStatus,
  AgentType,
  AgentMemory,
  CycleType,
  CreateAgentInput,
  TrackerSchema,
  TrackerStage,
  TrackerField,
  TimerContext,
} from '../types.js';
import { AgentWorkspaceManager } from './agent-workspace.js';
import { sweepQuietly } from './skill-curator.js';
import { MemoryDistiller } from './memory-distiller.js';
import { recordMemory, syncMemoryViews } from './memory-service.js';
import { IdentityEvolutionEngine } from './identity-evolution.js';
import { FileTracker } from './file-tracker.js';
import { sidecarRegistry } from './agent-sidecar.js';
import { credentialManager } from './credential-manager.js';
import { secretsManager } from './secrets-manager.js';
import { isServiceConnectedViaSecrets } from './credential-catalog.js';
import { CYCLE_BUILTINS } from './tool-catalog.js';
import {
  DATA_DIR,
  STAGING_DIR,
  planCycleLimit,
  planAllowsByok,
  hasActivePlan,
} from '../config.js';

/**
 * Daily cap on approved smtp_send emails, per agent. Must match DEFAULT_DAILY_LIMIT in
 * container/nanoagent/nanoagent/agent/tools/smtp_send.py — the tool shows the agent its
 * remaining quota, but this side is what actually enforces it.
 */
const SMTP_SEND_DAILY_LIMIT = 20;
import { logger } from '../logger.js';
import { canWake } from './wake-policy.js';
import { Sentry } from '../instrument.js';
import { laneEventBus, LaneFailureClass, ts } from './lane-events.js';
import { checkBranchFreshness } from './stale-branch.js';
import { updateBulletin } from './bulletin-writer.js';
import { getSocketIO } from '../api/instances.js';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { readEnvFile } from '../env.js';
import { resolveInternalModel } from '../services/model-router.js';
import { noteCycleStart, noteCycleEnd } from '../swarm/taint.js';

function isEqualJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Stage 34 Gap 6 — once the pinned "live" knowledge-seed view grows past this size, fold it
// back into a merged/deduped rewrite instead of letting it grow forever. The permanent raw
// log (SEED_UPDATES.md) is never touched by this — only the compact projection is.
const SEED_CURRENT_REORG_THRESHOLD_CHARS = 6000;

// ─── Claude helper ────────────────────────────────────────────────────────────
// Stage 34 — this used to be a raw fetch to api.anthropic.com gated on ANTHROPIC_API_KEY
// being set directly, which isn't the case on the orchestrator (litellm centralizes
// provider keys there instead) — the exact same silent-failure shape already found and
// fixed in memory-distiller.ts / identity-evolution.ts this stage. writeEpisodeLog() was
// masking it with a template fallback (episodes have likely been using the generic
// template instead of a real Claude-written one in prod); the new seed-reorg call
// (_reorganizeSeedCurrent) would have inherited the same silent failure. Fixed by routing
// through litellm first, matching the now-established pattern, direct ANTHROPIC_API_KEY
// only as a last resort.

function getAgentServiceModel(agentId?: string) {
  const proxyUrl = process.env.LITELLM_PROXY_URL || '';
  const proxyKey = process.env.LITELLM_PROXY_KEY;
  if (proxyUrl && proxyKey) {
    const proxy = createOpenAI({ apiKey: proxyKey, baseURL: `${proxyUrl}/v1` });
    // Model-router-governed (Settings -> Models / the agent's own override), not a
    // literal — see resolveInternalModel()'s docstring for why this changed.
    return proxy.chat(resolveInternalModel(agentId, 'internal_writing'));
  }
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY || env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    process.env.ANTHROPIC_API_KEY = anthropicKey;
    return anthropic('claude-haiku-4-5-20251001');
  }
  throw new Error(
    'No LLM provider available. Set LITELLM_PROXY_URL/LITELLM_PROXY_KEY or ANTHROPIC_API_KEY.',
  );
}

async function callClaude(
  system: string,
  user: string,
  maxTokens = 1024,
  agentId?: string,
): Promise<string> {
  const { text } = await generateText({
    model: getAgentServiceModel(agentId),
    system,
    messages: [{ role: 'user', content: user }],
    maxOutputTokens: maxTokens,
  });
  return text;
}

/**
 * `callClaude`, plus whether the model ran out of room mid-sentence.
 *
 * The model here defaults to a hybrid DeepSeek that emits reasoning tokens against the
 * same output budget, so a generous-looking cap can still cut the visible answer in
 * half. That is survivable for a summary nobody stores, and not survivable when the
 * answer is written into IDENTITY.md — a half-bullet ("- Expand the YC") is read as a
 * whole instruction on every subsequent cycle. Callers that persist the text check
 * `truncated` and fall back.
 */
async function callClaudeChecked(
  system: string,
  user: string,
  maxTokens: number,
  agentId?: string,
): Promise<{ text: string; truncated: boolean }> {
  const { text, finishReason } = await generateText({
    model: getAgentServiceModel(agentId),
    system,
    messages: [{ role: 'user', content: user }],
    maxOutputTokens: maxTokens,
  });
  return { text, truncated: finishReason === 'length' };
}

/**
 * Headings every check-in report must contain — the dashboard renders these five and
 * `processFeedback` parses answers out of the Questions block, so a report missing any
 * of them is not displayable.
 *
 * `generateCheckinReport` owns this contract: it either returns a report containing all
 * five or substitutes its own template. Callers do not need to re-validate.
 */
export const CHECKIN_SECTIONS = [
  '## What I Did',
  '## Wins',
  '## Observations',
  "## What's Next",
  '## Questions for You',
] as const;

/**
 * Which required headings a generated report is missing.
 *
 * Empty output counts as missing everything, which is the case that actually bites:
 * a thinking model can burn its entire token budget on reasoning and return "" without
 * throwing, so a bare try/catch never sees it.
 */
export function missingCheckinSections(reportMd: string): string[] {
  if (looksLikeErrorText(reportMd)) return [...CHECKIN_SECTIONS];
  return CHECKIN_SECTIONS.filter((s) => !reportMd.includes(s));
}

// ─── Opening suggestions ─────────────────────────────────────────────────────

/**
 * Three concrete jobs this agent could start on, phrased as the owner would ask.
 *
 * Exists to remove the blank page. A new hire lands in an empty chat and has to
 * invent both what to ask and how to phrase it — which is the moment the product
 * looks like every other chat box. Suggestions turn invention into a choice, and
 * because they are generated from the owner's own business rather than written
 * in advance, they stay specific without anyone guessing at templates.
 *
 * The third is always recurring work: that is the one thing a stateless
 * assistant cannot do, so it is the one worth showing on the first screen.
 *
 * Never throws — a failure here must not affect hiring or opening a chat. An
 * empty result simply means no chips are rendered.
 */
export async function generateAgentStarters(
  agentName: string,
  role: string,
  goals: string,
  businessContext: string,
  agentId?: string,
): Promise<string[]> {
  const system =
    'You write short opening requests a business owner would type to a new AI teammate. ' +
    'Reply with exactly three lines, one request per line. No numbering, no bullets, no quotes, ' +
    'no preamble. Each line is under 60 characters, written in first person as the owner ' +
    '("Draft…", "Find…", "Track…"). The first two are one-off jobs that can be done right now. ' +
    'The third is recurring work on a schedule (e.g. "every Monday", "each morning").';

  const user = [
    `The teammate is "${agentName}", whose role is: ${role}.`,
    goals ? `Their mission: ${goals}` : '',
    businessContext
      ? `The business they work for: ${businessContext}`
      : 'The business is unknown — keep the requests generic but concrete.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const text = await callClaude(system, user, 200, agentId);
    return text
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
          .replace(/^["']|["']$/g, '')
          .trim(),
      )
      .filter((l) => l.length > 0 && l.length <= 120)
      .slice(0, 3);
  } catch (err) {
    logger.warn(
      { agentName, err: String(err) },
      'Could not generate opening suggestions',
    );
    return [];
  }
}

// ─── Identity template loader ────────────────────────────────────────────────

const IDENTITY_TEMPLATES: Record<AgentType, string> = {
  lead_hunter: `# Lead Hunter

## CORE
**Role:** Lead Hunter — I find and qualify B2B SaaS leads that match the ICP.

**Mission:** {goals}

**ICP:** {icp}

**Hard Rules:**
- Never contact a lead twice without checking sent history
- Qualify against ICP before adding to pipeline
- Score every lead — nothing below 60 enters the pipeline
- Stop immediately if daily budget is exceeded

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
  outreach: `# Outreach Agent

## CORE
**Role:** Outreach Agent — I send personalized messages to qualified leads.

**Mission:** {goals}

**Hard Rules:**
- Always check unsubscribe list before sending
- Respect daily send limit
- Personalize every message — no generic blasts
- Never send to a lead already contacted this week

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
  market_research: `# Market Research Agent

## CORE
**Role:** Market Research Agent — I monitor the competitive landscape and track trends.

**Mission:** {goals}

**Hard Rules:**
- Report factually — no speculation presented as fact
- Track competitors weekly at minimum
- Flag any pricing or feature changes immediately

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
  analytics: `# Analytics Agent

## CORE
**Role:** Analytics Agent — I aggregate data and produce actionable insights.

**Mission:** {goals}

**Hard Rules:**
- Always cite data sources in reports
- Highlight anomalies prominently
- Weekly KPI summary every Monday

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
  followup: `# Follow-Up Agent

## CORE
**Role:** Follow-Up Agent — I nurture the outreach pipeline with timely follow-ups.

**Mission:** {goals}

**Hard Rules:**
- Never follow up more than 3 times per lead
- Wait at least 3 days between follow-ups
- Stop immediately when a reply is received

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
  content: `# Content Agent

## CORE
**Role:** Content Agent — I create and publish content on schedule.

**Mission:** {goals}

**Hard Rules:**
- Stick to the publishing calendar
- Never publish without a draft review step
- Maintain consistent brand voice

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
  custom: `# Agent

## CORE
**Role:** Custom Agent

**Mission:** {goals}

## LEARNED
Version: 1
*(This section evolves with each self-improvement cycle)*
`,
};

function renderReferencesSection(config: AgentConfig): string | null {
  const refs = config.references;
  if (!refs || refs.length === 0) return null;
  const lines = [
    '## REFERENCES',
    'The following documents have been provided to you under `references/`. Read them before answering questions in their domain, and cite the filename when you draw on one.',
    '',
  ];
  for (const r of refs) {
    lines.push(`- \`references/${r.filename}\` (${r.type}, ${r.size} bytes)`);
  }
  return lines.join('\n');
}

function renderWorkspaceSection(config: AgentConfig): string | null {
  const dirs = config.customWorkspaceDirs;
  if (!dirs || dirs.length === 0) return null;
  const lines = [
    '## WORKSPACE',
    'These folders were provisioned for you under `workspace/`. Use them for the work they imply; `memory/` is always available alongside them.',
    '',
  ];
  for (const d of dirs) {
    lines.push(
      `- \`workspace/${d.name}/\`${d.description ? ` — ${d.description}` : ''}`,
    );
  }
  return lines.join('\n');
}

function renderIdentity(
  agentType: AgentType,
  config: AgentConfig,
  agentName?: string,
): string {
  const refsSection = renderReferencesSection(config);
  const workspaceSection = renderWorkspaceSection(config);
  const extras = [refsSection, workspaceSection].filter(Boolean).join('\n\n');

  // Phase A5 Task 1.1 — replace mode: user's prompt is the whole identity (we still append ## LEARNED)
  if (
    config.customSystemPrompt?.mode === 'replace' &&
    config.customSystemPrompt.content.trim()
  ) {
    const body = config.customSystemPrompt.content.trim();
    const hasLearned = /(^|\n)##\s+LEARNED/i.test(body);
    const base = hasLearned
      ? body
      : `${body}\n\n## LEARNED\n*(This section evolves with each self-improvement cycle)*\n`;
    if (!extras) return base;
    // Inject the extras before ## LEARNED so they're treated as part of the agent's static identity
    return base.replace(/(^|\n)##\s+LEARNED/, `\n${extras}\n\n## LEARNED`);
  }

  const template = IDENTITY_TEMPLATES[agentType] ?? IDENTITY_TEMPLATES.custom;
  let md = template
    .replace('{goals}', config.goals || 'Not specified')
    .replace('{icp}', config.icp || 'Not specified');

  // Custom agents: use role (if Recruiter supplied one) or fall back to the agent name.
  // Inject an explicit "Your name is X" line so the model never defaults to "nanobot".
  if (agentType === 'custom') {
    const label = config.role?.trim() || agentName?.trim();
    if (label) {
      md = md
        .replace('# Agent', `# ${label}`)
        .replace('**Role:** Custom Agent', `**Role:** ${label}`);
      // Insert the name assertion immediately after the header line.
      md = md.replace(`# ${label}\n`, `# ${label}\n\nYour name is ${label}.\n`);
    }
  }

  const p = config.personality;
  if (p && (p.voice || p.expertise?.length || p.style)) {
    const lines = ['## PERSONALITY'];
    if (p.voice) lines.push(`**Voice:** ${p.voice}`);
    if (p.expertise?.length)
      lines.push(`**Expertise:** ${p.expertise.join(', ')}`);
    if (p.style) lines.push(`**Style:** ${p.style}`);
    md = md.replace('## LEARNED', lines.join('\n') + '\n\n## LEARNED');
  }

  // Phase A5 Task 1.1 — augment mode: inject operating rules before ## LEARNED
  if (
    config.customSystemPrompt?.mode === 'augment' &&
    config.customSystemPrompt.content.trim()
  ) {
    const rules = `## OPERATING_RULES\n${config.customSystemPrompt.content.trim()}\n`;
    md = md.replace('## LEARNED', `${rules}\n## LEARNED`);
  }

  // References + workspace dirs go in just before ## LEARNED so the agent treats them
  // as part of its static identity (not transient cycle context).
  if (extras) {
    md = md.replace('## LEARNED', `${extras}\n\n## LEARNED`);
  }

  return md;
}

function renderSchemaMd(
  agentType: AgentType,
  trackerSchema?: { name: string; namePlural: string },
): string {
  const trackedFile = trackerSchema
    ? `workspace/tracked/${trackerSchema.namePlural}.json`
    : 'workspace/tracked/<EntityPlural>.json';

  return `# Agent Output Schema

## Tracked Entities
Write the items you track to:
- **${trackedFile}** — array of tracked items (synced to the platform database after each cycle)

Each item format:
{ "stage": "<stage_key>", "data": { ...your entity fields } }
The key field (first field in schema) is used for deduplication on sync.

## Receiving Inbound Work
Inbound handoffs arrive at \`workspace/inbox/*.json\`. The cycle context summary
includes a preview of each pending handoff — read the full payload with the file
tool when you need it. **After processing, delete the inbox file** so the same
work isn't re-processed on your next cycle.

**Answer every message addressed to you, before this cycle ends, with \`reply_to_handoff\`.**
The sender cannot see what you did unless you reply — it sees only that delivery
succeeded. Doing the work in silence reads to them as nothing having happened, and they
will hand you the same work again.

Say what is true: \`result\` when you have an answer, \`agree\` when you have taken it on
and will finish later, \`failure\` when it broke. If you could not do it because you lack
a tool, credential or access, answer \`cannot\` and **name exactly what is missing** — that
is a good answer, not an admission of failure. It tells the sender to route the work
elsewhere and tells your owner what to give you. Never leave a message unanswered because
the answer is "I couldn't".

Messages other agents send you (from their \`message_agent\` tool, or the platform's
inter-agent messaging) arrive the same way, at \`workspace/inbox/msg-*.json\`, and are
also shown in full under "## Messages From Other Agents" in this cycle's context —
you don't need to go looking for them. They're marked read automatically once this
cycle completes, so act on one now if it needs action; it won't be re-shown.

## Outbound Handoffs (preferred: \`handoff_to\` tool)
**Preferred** — use the \`handoff_to\` tool. It returns a confirmation immediately:

\`\`\`
handoff_to(
  to_agent_id: "<id-or-name>",   // accepts UUID OR agent name (exact match)
  type:        "<handoff_type>",  // e.g. "task", "review", "data", "approval"
  payload:     { ...structured data... },
  note:        "optional human-readable note"
)
\`\`\`

If the recipient doesn't exist, you'll get an error you can react to in the same
cycle — much better than the file-based path.

### Fallback: \`workspace/handoffs_out.json\`
If you can't call the tool, append entries (NOT replace — read existing first):
\`\`\`
[{"to_type": "<agent_name_or_type>", "type": "<handoff_type>", "note": "...", "data": {...}}]
\`\`\`
The orchestrator delivers them after your cycle ends and clears the file.

**Rate limit**: max 5 outbound handoffs per cycle. Extra entries are dropped.

## Platform Conventions
- The orchestrator syncs ${trackedFile} to the database after every cycle.
- Handoffs are delivered before the recipient's next cycle.
- Inbox files are consumed once — delete or move them after processing.
- Cycle types: \`custom\` (one-off), \`work\` (scheduled), \`handoff\` (auto-fired
  on incoming handoff), \`self_improve\` (memory consolidation), \`checkin\`
  (status report).
`;
}

// ─── Recruiter spec coercion ─────────────────────────────────────────────────
// The Recruiter is an LLM writing JSON from a conversation, so these accept the loose
// forms it actually produces — bare strings where objects are expected, snake_case keys,
// missing colours, invented field types — rather than rejecting a spec the user has
// already approved in chat. A hire that half-works beats a hire that 500s.

const TRACKER_STAGE_COLORS = [
  '#94a3b8',
  '#f59e0b',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#22c55e',
  '#16a34a',
  '#64748b',
];
const TRACKER_FIELD_TYPES = new Set(['text', 'url', 'number', 'date']);
const CYCLE_TYPES = new Set<string>([
  'lead_search',
  'send_outreach',
  'followup',
  'checkin',
  'self_improve',
  'custom',
  'work',
]);

function slugKey(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Coerce a proposed tracker schema into the shape `upsertEntitySchema` needs.
 *
 * Returns undefined when there is nothing usable, which leaves the agent tracker-less
 * rather than failing the whole hire — the user approved an agent, not a table, and
 * losing the table is recoverable while losing the agent is not.
 */
export function normaliseTrackerSchema(raw: any): TrackerSchema | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const name = String(raw.name ?? '').trim();
  if (!name) return undefined;
  const namePlural =
    String(raw.namePlural ?? raw.name_plural ?? `${name}s`).trim() ||
    `${name}s`;

  const stages = (Array.isArray(raw.stages) ? raw.stages : [])
    .map((s: any, i: number) => {
      const label = String(
        (typeof s === 'string' ? s : (s?.label ?? s?.key)) ?? '',
      ).trim();
      if (!label) return null;
      const key = slugKey(typeof s === 'object' && s?.key ? s.key : label);
      if (!key) return null;
      const color =
        typeof s === 'object' &&
        typeof s?.color === 'string' &&
        /^#[0-9a-f]{6}$/i.test(s.color)
          ? s.color
          : TRACKER_STAGE_COLORS[i % TRACKER_STAGE_COLORS.length];
      return { key, label, color };
    })
    .filter(Boolean)
    .slice(0, 12) as TrackerStage[];

  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .map((f: any) => {
      const label = String(
        (typeof f === 'string' ? f : (f?.label ?? f?.key)) ?? '',
      ).trim();
      if (!label) return null;
      const key = slugKey(typeof f === 'object' && f?.key ? f.key : label);
      if (!key) return null;
      const t = String(
        (typeof f === 'object' && f?.type) || 'text',
      ).toLowerCase();
      return {
        key,
        label,
        type: (TRACKER_FIELD_TYPES.has(t) ? t : 'text') as TrackerField['type'],
      };
    })
    .filter(Boolean)
    .slice(0, 24) as TrackerField[];

  // A tracker with no stages or no fields renders as an empty board — worse than none,
  // because it looks like a feature that is broken rather than one that wasn't set up.
  if (stages.length === 0 || fields.length === 0) return undefined;
  return { name, namePlural, stages, fields };
}

/** Multi-entry schedule from a spec; falls back to the legacy single-interval form. */
export function normaliseSchedule(
  raw: any,
  fallbackInterval: string,
): AgentConfig['schedule'] {
  const entries = (Array.isArray(raw) ? raw : [])
    .map((e: any) => {
      const type = String(e?.type ?? e?.cycle_type ?? '').trim();
      const interval = String(e?.interval ?? '').trim();
      if (!CYCLE_TYPES.has(type) || !interval) return null;
      return {
        type: type as CycleType,
        interval,
        enabled: e?.enabled !== false,
      };
    })
    .filter(Boolean)
    .slice(0, 8) as AgentConfig['schedule'];

  return entries.length
    ? entries
    : [
        {
          type: 'custom' as CycleType,
          interval: fallbackInterval,
          enabled: true,
        },
      ];
}

// ─── Container runner interface (injectable for testing) ─────────────────────

export interface CycleRunner {
  run(params: {
    agentId: string;
    cycleId: string;
    cycleType: CycleType;
    workspacePath: string;
    identityMd: string;
    config: AgentConfig;
    handoffContext?: string;
    projectId?: string;
    projectName?: string;
    conversational?: boolean;
    /** A person directly asked for this cycle — see request_origin.py in the container. */
    humanRequested?: boolean;
    /** Which browser this run may use, from the chat's picker (stage 60 phase 1). */
    laneHint?: LaneHint;
    /** Set when a timer started this run: which one, and what it is for. */
    timer?: TimerContext;
  }): Promise<{
    summary: string;
    reply?: string;
    cost: number;
    tasksDone: number;
  }>;
}

/** Default no-op runner used when no real container is available (dev/test). */
export const NoopCycleRunner: CycleRunner = {
  async run({ cycleType }) {
    return {
      summary: `[noop] ${cycleType} cycle simulated`,
      cost: 0,
      tasksDone: 0,
    };
  },
};

/**
 * Snapshot the agent's current activity.json into a per-cycle file so the cycle
 * drawer can show *this* cycle's trace rather than always showing the latest one.
 *
 * For project cycles, the Python container writes activity.json into the project's
 * shared workspace (NOT the agent's private workspace), so we have to look there.
 * Reads project workspace first, falls back to agent workspace.
 *
 * The Python adapter overwrites activity.json every cycle, so we capture it
 * the moment the cycle finishes (completed/failed). Non-fatal — if the snapshot
 * fails the cycle still completes normally.
 */
// Persist this cycle's activity timeline into the DB, keyed by cycle_id, so it is
// durable and a later cycle can never overwrite it. Reads the freshest activity.json
// the Python adapter wrote for this run (live feed) and snapshots it into cycle_steps.
// (Phase 1 of the activity-rework: history now lives in the DB; the file is still the
// live transport, retired in Phase 2.)
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /insufficient balance|quota|rate.?limit|429|503|temporarily unavailable|connection refused|timeout/i.test(
    msg,
  );
}

/**
 * A cycle that failed *inside* the container and came back as a normal exit-0
 * result (Stage 35). The nanoagent framework catches its own LLM/tool errors and
 * returns the error as result text, so nothing throws on its own — this is thrown
 * for it, at the point the result is classified, so that in-container failures and
 * orchestrator-level failures converge on runCycle's single catch path.
 *
 * That convergence is the fix: previously these two failure classes were handled by
 * two different code paths with two different outcomes, and this one took the
 * *success* path — marking the cycle 'completed' and handing error text to the chat
 * as though it were the agent's answer.
 *
 * Carries the cost the container already incurred before failing, which would
 * otherwise be lost — the catch path can't know it from a thrown error alone.
 */
class CycleResultError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_output' | 'error_text' | 'malformed_output',
    readonly cost = 0,
  ) {
    super(message);
    this.name = 'CycleResultError';
  }
}

function snapshotActivityForCycle(
  agentId: string,
  cycleId: string,
  projectId?: string,
  cycleStartedAt?: string,
): void {
  try {
    const candidates: string[] = [];
    if (projectId) {
      const projPath = path.join(
        DATA_DIR,
        '..',
        'groups',
        'projects',
        projectId,
        'workspace',
        'activity.json',
      );
      // Also try without the "..", in case PROJECTS_DIR is colocated
      const projPathAlt = path.resolve(
        DATA_DIR,
        '..',
        '..',
        'groups',
        'projects',
        projectId,
        'workspace',
        'activity.json',
      );
      candidates.push(projPath, projPathAlt);
    }
    candidates.push(path.join(DATA_DIR, 'agents', agentId, 'activity.json'));

    // Pick the freshest existing candidate — handles both project and private cycles correctly.
    let bestSrc: string | null = null;
    let bestMtime = 0;
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          const m = fs.statSync(c).mtimeMs;
          if (m > bestMtime) {
            bestMtime = m;
            bestSrc = c;
          }
        }
      } catch {
        /* skip */
      }
    }
    if (!bestSrc) return;

    const data = JSON.parse(fs.readFileSync(bestSrc, 'utf-8')) as {
      steps?: CycleStep[];
      cycleId?: string;
    };

    // STALENESS GUARD. activity.json lives at a fixed path and is overwritten per run,
    // so a cycle that dies before its first tool call (e.g. the LLM call itself fails)
    // never rewrites it — and without this check we'd snapshot the PREVIOUS cycle's
    // trace and attribute it to the failed one. That made a crashed cycle render in
    // chat as if it had done a full run's worth of work.
    if (data.cycleId) {
      // Authoritative: the adapter stamps the cycle it belongs to.
      if (data.cycleId !== cycleId) return;
    } else if (cycleStartedAt) {
      // Legacy file (written by an older agent image, no stamp) — fall back to mtime:
      // a file last written before this cycle even started cannot belong to it.
      const startedMs = Date.parse(cycleStartedAt);
      if (Number.isFinite(startedMs) && bestMtime < startedMs) return;
    }

    const steps = Array.isArray(data.steps) ? data.steps : [];
    if (steps.length) replaceCycleSteps(agentId, cycleId, steps);
  } catch {
    /* non-fatal — chat still shows the result text without a trace */
  }
}

// ─── Recruiter starter-agent config (Stage 28) ────────────────────────────────
// The canonical spec for the per-account Recruiter, provisioned on signup. Pure
// chat agent with the request_approval tool; its customSystemPrompt drives the
// "interview → propose spec → create on approval" hiring flow.
const RECRUITER_CONFIG: AgentConfig = {
  goals:
    'Help the user create new agents through conversation — interview, propose a spec, and create on approval.',
  tools: ['request_approval'],
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  escalationRules: [],
  triggerMode: 'on_demand',
  alwaysHeavy: true,
  protected: true, // account infrastructure — can't be fired
  personality: {
    voice: 'warm',
    style: 'conversational',
    color: '#8b5cf6',
    expertise: [],
  },
  customSystemPrompt: {
    mode: 'replace',
    content: `You are the Recruiter for NanoCrew. Your job is to help the user create new agents through conversation — like a friendly hiring manager.

When the user describes an agent they want:
1. INTERVIEW first. Ask focused clarifying questions before proposing anything: what workflow it runs, how it is triggered (scheduled or on-demand), what tools/integrations it needs, and what success looks like. If the request is vague, ask — do not guess. Also ask, once, whether they have a model preference for this agent — phrase it in plain language ("any preference for which AI model powers this agent — a specific one, 'cheap and fast', 'best quality', or should it just use your account default?"), not model ID syntax. This is optional: if they don't answer or say "default"/"whatever", drop it and never bring it up again for this hire.
2. Bias toward FOCUSED, single-responsibility agents. If they describe something that is really three agents, say so and suggest starting with the most valuable one.
3. Before proposing, check whether the request matches one of these proven ARCHETYPES — use its tool bundle and system-prompt structure as a starting point (adapted to specifics), rather than improvising a structure from zero every time:
   - RESEARCH (e.g. "research X for me", literature/domain synthesis): tools web_search, web_fetch, url_check, read_pdf, python_repl, search_knowledge, append_memory, search_crew_memory. Prompt structure: Identity → Sourcing principles (verify every URL with url_check before citing, never invent a paper/citation, prefer primary sources) → Epistemic labeling (Confirmed / Consistent with / Reported non-replicated / Contradictory / Unclear) → Output format (a research-brief template) → Priority-ordered focus areas.
   - OUTREACH / LEAD-GEN (e.g. "find and contact prospects"): tools web_search, web_fetch, hn_search, gmail_send, gmail_replies. Prompt structure: Identity → ICP definition (who to target, who to exclude) → Personalization rule (no generic templates — reference something specific about the prospect) → Compliance rule (no spam, respect opt-outs) → Follow-up cadence. Almost always wants a tracker_schema (see step 7) — a lead-gen agent whose output isn't a table is just a chat log. If the user only wants sourcing and NOT contacting, say so explicitly in the mission and leave the sending tools out; a research-only lead agent is a legitimate and much safer starting point.
   - OPS / MONITORING (e.g. "watch X and alert me"): tools web_fetch, url_check, exec, notify, cron (only if scheduled). Prompt structure: Identity → Exactly what to watch and how often → Alert threshold (what's worth interrupting the user for vs. logging quietly) → Escalation path.
   - DATA / REPORTING (e.g. "pull data and summarize"): tools sql_query, python_repl, exec, read_file, write_file, emit_artifact. Prompt structure: Identity → Data sources → Analysis method → Report format → What NOT to editorialize on (stick to what the data shows).
   - CODING / DEV (e.g. "build/fix code, run tests"): tools read_file, write_file, edit_file, exec, git, test_runner, github_api. Prompt structure: Identity → Coding standards → Test-before-claiming-done rule → Commit/PR conventions.
   If the request doesn't fit any of these, that's fine — design from scratch, but keep the same DISCIPLINE: a clear identity, explicit principles (not vibes), and a concrete output format.
4. When you have enough, PROPOSE a complete spec in your reply — name, emoji, role (a specific job title like "World History Researcher", not "agent"), mission (one or two sentences), areas of expertise, tools, trigger mode, schedule, any dedicated output folders, and the model (only if they stated a preference — otherwise say it'll use their account default, don't list a specific model they never asked for). Lay it out clearly so they can review it.
5. If they want changes, adjust and re-show the updated spec.
6. DOMAIN KNOWLEDGE FILES (research briefs, reference notes, a curated knowledge base, a longer system prompt draft — anything you author with write_file to prepare the new agent) only exist in YOUR OWN workspace until you explicitly transfer them. Writing a file does not attach it to the new agent. When you approve-and-create (next step), you MUST list every such file in seed_files, or it will never leave your workspace and the new agent's identity will reference a file that doesn't exist.
7. When they APPROVE (looks good / create it / yes), call the request_approval tool with action_type="create_agent" and action_payload = {
   name, emoji, role (specific job title), mission,
   expertise (REQUIRED — list of 2-6 specialty tags, e.g. ["world history","primary-source research"]; never leave this empty, derive tags from the mission/role if the user didn't state them explicitly),
   workspace_dirs (list of dedicated output folders the agent will write to, each { name, description } — only for agents that PRODUCE artifacts like reports/drafts/datasets; omit for pure-chat agents),
   tools (list of tool names),
   trigger_mode ("scheduled" or "on_demand"), schedule_interval (e.g. "24h", only if scheduled),
   schedule (optional, INSTEAD of schedule_interval, when the agent needs more than one recurring cycle — a list of { type, interval, enabled }. type is one of: work, lead_search, followup, checkin, self_improve, custom. Use this for e.g. a daily working cycle plus a weekly review; a single "do everything" cycle is usually the wrong shape for an agent with both daily and weekly duties.),
   tracker_schema (REQUIRED whenever the agent's job involves keeping a list of things — leads, applicants, orders, invoices, papers, candidates, bugs. This is what makes the agent's output a real table in Pipelines instead of a file nobody sees. Shape: { name (singular, e.g. "Lead"), namePlural (e.g. "Leads"), stages: [{ key, label }] in pipeline order, fields: [{ key, label, type }] where type is text|url|number|date }. The FIRST field is the deduplication key — choose something uniquely identifying (a handle, an email, a URL), never a display name. Ask the user what columns they want if it isn't obvious; do not invent a schema they haven't agreed to.),
   escalation_rules (list of short strings — the situations where the agent must stop and ask the user rather than decide alone. Always propose these for any agent that touches money, sends anything to a third party, or makes commitments on the user's behalf.),
   icp (optional, for lead/outreach agents — one paragraph on who counts as a target and who explicitly does not),
   model (OPTIONAL — only include this if the user actually stated a model preference during the interview. If they said something specific and recognizable, map it to a real NanoCrew model string, e.g. "deepseek/deepseek-v4-flash", "openrouter/tencent/hy3", "openrouter/xiaomi/mimo-v2.5". If they said something vague like "cheap"/"fast", use a cheap one such as "openrouter/inclusionai/ling-3.0-flash"; for "best"/"highest quality" use "deepseek/deepseek-v4-pro". If they expressed no preference (the common case), OMIT this field entirely — the agent then inherits the user's account default, then the platform default, same as any agent without its own override. Never invent a preference they didn't state.),
   system_prompt (optional extra operating rules for the new agent),
   seed_files (list of paths to any file YOU wrote in your own workspace that the new agent should have — e.g. ["kairos-research-agent/KNOWLEDGE_SEED.md"]. Use the same path you passed to write_file. These are copied into the new agent's own workspace and pinned as must-read on every cycle. Omit entirely if you didn't author any supporting files.)
   }. Put a clear summary of the agent in report_md so the user can confirm before it is created.
8. After it is created, tell them it is done. Only claim a file was "created for" or "seeded into" the new agent if you actually listed it in seed_files on this call — otherwise describe it as something you drafted for reference, not something the new agent has. Mention any credentials they still need to connect for its tools to work.

Tool names you can give new agents include: web_fetch, web_search, github_api, gmail_send, gmail_replies, url_check, hn_search, sql_query, browser, request_approval, and the built-in file tools. Only include tools the agent actually needs.


Keep it conversational and concise. You are the front door to building a crew.`,
  },
} as AgentConfig;

/** Sanitise a (possibly folder-nested) workspace-relative path for the seed_files
 *  mechanism: keep the tree, scrub each segment, block traversal. Tolerates a path
 *  written in an agent's own tool-call style with a leading "workspace/" segment
 *  (what read_file/write_file actually see, since those are agent-root-relative) by
 *  stripping it — the result is always relative to the workspace/ folder itself.
 *  Mirrors api/routes/agents.ts's sanitiseRefPath; duplicated rather than imported to
 *  avoid a circular import (that file imports the agentService singleton this file
 *  defines). */
// Generic words that make poor expertise tags on their own — filtered out of the
// role/mission-derived fallback in _createAgentFromSpec.
const EXPERTISE_STOPWORDS = new Set([
  'agent',
  'assistant',
  'specialist',
  'expert',
  'helper',
  'manager',
  'research',
  'about',
  'their',
  'other',
  'which',
  'through',
  'using',
  'agents',
  'system',
  'that',
  'this',
  'with',
  'from',
  'your',
  'will',
  'would',
  'help',
  'work',
]);

export interface AgentAuditResult {
  agentId: string;
  agentName: string;
  checkedAt: string;
  passed: boolean;
  checks: {
    pinnedFiles: Array<{ path: string; exists: boolean }>;
    workspaceDirs: Array<{ name: string; exists: boolean }>;
    missingCredentials: string[];
    unknownTools: string[];
    scheduleOk: boolean;
  };
}

function sanitiseWorkspacePath(raw: string): string | null {
  const parts = String(raw)
    .split(/[\\/]+/)
    .filter(Boolean);
  // An agent describes its OWN workspace to itself as the in-container mount path
  // "/workspace/group/workspace/..." (every agent's system prompt says exactly this) —
  // so that's the convention a model naturally reaches for in seed_files/workspace_dirs,
  // even though this function's callers store paths relative to the host workspace/ dir.
  // Stripping a single leading "workspace" left "group/workspace/scrapybaby/..." behind,
  // which doesn't exist, so every seed file silently failed to resolve (found 2026-08-17,
  // Crawler created with a fully empty workspace). Peel off any leading run of
  // "workspace"/"group" segments, in either order, until neither matches.
  while (parts[0] === 'workspace' || parts[0] === 'group') parts.shift();
  const clean: string[] = [];
  for (const p of parts) {
    if (p === '..' || p === '.') return null;
    const s = p.replace(/[^\w.\- ]/g, '_').slice(0, 120);
    if (!s) return null;
    clean.push(s);
  }
  if (clean.length === 0 || clean.length > 8) return null;
  return clean.join('/');
}

// ─── AgentService ─────────────────────────────────────────────────────────────

export class AgentService {
  private workspace: AgentWorkspaceManager;
  private runner: CycleRunner;
  private agentsBaseDir: string;
  private distiller: MemoryDistiller;
  private evolver: IdentityEvolutionEngine;
  // Per-agent concurrency guard: prevents budget gate race condition (ISSUE-004)
  private runningCycles = new Set<string>();

  /**
   * Statuses an agent set on ITSELF during its own cycle, awaiting the post-cycle restore.
   *
   * An agent can only act while a cycle is running, so every self-enable/disable happens
   * mid-cycle — exactly when the restore at the end of runCycle overwrites status with
   * `statusBeforeCycle`. Pausing survives that by accident (the restore explicitly skips
   * 'paused'), but self-*enabling* does not: the cycle began with the agent at 'idle',
   * so the restore writes 'idle' straight back over the agent's 'running' and the change
   * silently evaporates. Re-reading the DB cannot distinguish the two, because runCycle
   * itself writes 'running' at cycle start.
   *
   * So the intent is recorded out-of-band here, consulted once by the restore, and cleared.
   */
  private selfStatusOverrides = new Map<string, AgentStatus>();

  /**
   * Set an agent's status on the agent's own behalf (the self-management route).
   *
   * Separate from startAgent/pauseAgent/stopAgent because it must additionally survive
   * the post-cycle restore — see selfStatusOverrides.
   */
  setSelfStatus(
    agentId: string,
    status: Extract<AgentStatus, 'running' | 'paused' | 'stopped'>,
  ): void {
    updateAgentStatus(agentId, status);
    this.selfStatusOverrides.set(agentId, status);
    getSocketIO()?.emit('agent:status_changed', {
      agentId,
      status,
      reason: 'self_managed',
    });
  }

  /** The status each in-flight cycle found the agent in, i.e. what it goes back to. */
  private statusBeforeCycles = new Map<string, AgentStatus>();

  /**
   * The status an agent will be in once any in-flight cycle ends.
   *
   * runCycle writes 'running' at the start of every cycle, including a chat turn on an
   * idle agent, so the DB status mid-cycle cannot answer "is this agent switched on?".
   * Asked from inside a cycle — which is the only place an agent can ask — it always said
   * yes. This answers what the scheduler will actually see afterwards.
   */
  getSettledStatus(agentId: string): AgentStatus | undefined {
    const override = this.selfStatusOverrides.get(agentId);
    if (override !== undefined) return override;
    const current = dbGetAgent(agentId)?.status;
    if (current === undefined) return undefined;
    if (current === 'paused' || current === 'stopped') return current;
    const before = this.statusBeforeCycles.get(agentId);
    if (before !== undefined) return before === 'running' ? 'running' : 'idle';
    return current;
  }

  /**
   * An owner's start/stop, made to survive the end of a cycle that is running right now.
   *
   * The post-cycle restore puts back the status the cycle began with. Pressing Start
   * during a chat turn on an idle agent therefore lasted until the turn ended and then
   * reverted to idle, with nothing on screen to say so — the same evaporation the self
   * route already guards against, reached from the header button instead.
   */
  private holdStatusThroughCycle(agentId: string, status: AgentStatus): void {
    if (this.runningCycles.has(agentId))
      this.selfStatusOverrides.set(agentId, status);
  }

  /**
   * Decide the status to write once a cycle ends, honouring any self-set intent.
   * Shared by the success and failure paths so the two cannot drift.
   */
  private _restoreStatusAfterCycle(
    agentId: string,
    statusBeforeCycle: AgentStatus,
  ): void {
    const selfSet = this.selfStatusOverrides.get(agentId);
    if (selfSet !== undefined) {
      this.selfStatusOverrides.delete(agentId);
      updateAgentStatus(agentId, selfSet);
      getSocketIO()?.emit('agent:status_changed', {
        agentId,
        status: selfSet,
        reason: 'self_managed',
      });
      return;
    }
    // 'paused' is never overwritten — that is how budget-exhaustion pausing survives
    // the cycle that triggers it. 'stopped' likewise, and more strictly: it means a human
    // parked this agent, so a cycle finishing must not quietly restore it to idle and
    // erase the fact.
    const current = dbGetAgent(agentId)?.status;
    if (current === 'paused' || current === 'stopped') return;
    const restored = statusBeforeCycle === 'running' ? 'running' : 'idle';
    updateAgentStatus(agentId, restored);
    getSocketIO()?.emit('agent:status_changed', { agentId, status: restored });
  }

  /**
   * True while a cycle is actually executing, right now.
   *
   * Distinct from `status`, which records whether the agent is *enabled*
   * (running / paused / idle-stopped). Callers wanting a live "working now"
   * indicator must use this — reading `status === 'running'` answers a
   * different question and will be true between cycles too.
   */
  isExecutingCycle(agentId: string): boolean {
    return this.runningCycles.has(agentId);
  }

  private readonly slotFreedListeners: Array<(agentId: string) => void> = [];

  /**
   * Called each time an agent's turn slot is released — the moment it can take the next
   * turn. The chat queue starts a waiting message from here (chat-queue.ts).
   */
  onCycleSlotFreed(fn: (agentId: string) => void): void {
    this.slotFreedListeners.push(fn);
  }

  constructor(agentsBaseDir: string, runner: CycleRunner = NoopCycleRunner) {
    this.agentsBaseDir = agentsBaseDir;
    this.workspace = new AgentWorkspaceManager(agentsBaseDir);
    this.runner = runner;
    this.distiller = new MemoryDistiller(agentsBaseDir);
    this.evolver = new IdentityEvolutionEngine(agentsBaseDir);
  }

  /** One-time, idempotent migration (project-folder model): move each agent's
   *  references/* into workspace/ and convert config.references → config.pins, then
   *  retire the references/ folder. Only acts on agents that still have references.
   *  Call AFTER initDatabase() — it reads/writes the agents table. */
  migrateReferencesToPins(): void {
    let agents: Agent[];
    try {
      agents = dbGetAllAgents();
    } catch {
      return;
    }
    for (const a of agents) {
      const refs = a.config?.references;
      if (!refs || refs.length === 0) continue;
      const agentRoot = this.workspace.getAgentRoot(a.id);
      const refDir = path.join(agentRoot, 'references');
      const wsDir = path.join(agentRoot, 'workspace');
      const pins = new Set(a.config.pins ?? []);
      for (const r of refs) {
        try {
          const src = path.join(refDir, r.filename);
          const dest = path.join(wsDir, r.filename);
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
          }
          pins.add(r.filename); // pin it — it's a must-read context file
        } catch {
          /* skip this one */
        }
      }
      a.config.pins = [...pins];
      a.config.references = [];
      try {
        void this.updateAgent(a.id, { config: a.config });
      } catch {
        /* non-fatal */
      }
      try {
        fs.rmSync(refDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      logger.info(
        `[migrate] ${a.name}: ${refs.length} reference(s) → workspace + pins`,
      );
    }
  }

  /** One-time, idempotent migration: give every agent created before self_improve was
   *  scheduled by default a weekly entry, so "remember" and "learn" (memory
   *  distillation + identity evolution) start working for existing accounts too, not
   *  just agents created after this fix. Persists to config.schedule; AgentScheduler's
   *  boot-time initFromDb() picks up the new entry on this same restart. */
  async backfillSelfImproveSchedule(): Promise<void> {
    let agents: Agent[];
    try {
      agents = dbGetAllAgents();
    } catch {
      return;
    }
    let count = 0;
    for (const a of agents) {
      if (a.config.schedule?.some((s) => s.type === 'self_improve')) continue;
      const schedule = [
        ...(a.config.schedule ?? []),
        { type: 'self_improve' as CycleType, interval: '7d', enabled: true },
      ];
      // Awaited (not fire-and-forget) — this must land in the DB before
      // agentScheduler.initFromDb() reads agents back out later in the same boot,
      // or the new entry wouldn't be picked up until the *next* restart.
      try {
        await this.updateAgent(a.id, { config: { ...a.config, schedule } });
        count++;
      } catch (e) {
        logger.warn(
          { agentId: a.id, err: String(e) },
          '[migrate] Failed to backfill self_improve schedule',
        );
      }
    }
    if (count)
      logger.info(
        `[migrate] Backfilled self_improve schedule for ${count} existing agent(s)`,
      );
  }

  /**
   * One-time, idempotent migration for Stage 34 Gap 2 (episode distillation ledger).
   *
   * The ledger table starts empty for every agent that existed before this deploy. Without
   * this backfill, MemoryDistiller.readEpisodes() would see zero "already distilled" dates
   * for an established agent and treat its ENTIRE episode history as unprocessed — working
   * through months of backlog (oldest-first, 60 files/cycle) instead of picking up where the
   * old rolling-7-day window left off. That's a real cost/time regression on a live system,
   * not the intended behavior change.
   *
   * Fix: for any agent with zero ledger rows, mark every episode STRICTLY OLDER than 7 days
   * ago as already-distilled — exactly what the old `windowDays=7` default would have already
   * excluded from its next run. Episodes from the last 7 days are left unmarked, so the next
   * self_improve run behaves exactly like it would have before this deploy. Only new episodes
   * from this point forward get the actual ledger benefit (nothing silently ages out again).
   */
  async backfillEpisodeLedger(): Promise<void> {
    let agents: Agent[];
    try {
      agents = dbGetAllAgents();
    } catch {
      return;
    }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let migratedAgents = 0,
      migratedEpisodes = 0;

    for (const a of agents) {
      try {
        if (getDistilledEpisodeDates(a.id).size > 0) continue; // already has ledger state — not a pre-existing agent

        const files = this.workspace.listFiles(
          a.id,
          'workspace/memory/episodes',
        );
        const oldDates: string[] = [];
        for (const f of files) {
          if (f.type !== 'file') continue;
          const dateStr = (f.path.split('/').pop() ?? '').replace('.md', '');
          const fileDate = Date.parse(dateStr + 'T00:00:00Z');
          if (!isNaN(fileDate) && fileDate < cutoff) oldDates.push(dateStr);
        }
        if (oldDates.length === 0) continue; // no pre-existing backlog to grandfather in

        markEpisodesDistilled(a.id, oldDates);
        migratedAgents++;
        migratedEpisodes += oldDates.length;
      } catch (e) {
        logger.warn(
          { agentId: a.id, err: String(e) },
          '[migrate] Failed to backfill episode ledger',
        );
      }
    }
    if (migratedAgents) {
      logger.info(
        `[migrate] Grandfathered ${migratedEpisodes} pre-existing episode(s) across ${migratedAgents} agent(s) into the distillation ledger`,
      );
    }
  }

  /**
   * Stage 28 — find-or-create a Recruiter starter agent owned by `ownerId`.
   * The Recruiter is the conversational entry point for hiring all other agents
   * (the Agents page "Hire" button routes to it). Every account needs its own,
   * since data isolation hides one account's agents from another. Idempotent.
   */
  async ensureRecruiterAgent(ownerId: string): Promise<string> {
    const existing = dbGetAllAgents().find(
      (a) => a.name === 'Recruiter' && a.owner_id === ownerId,
    );
    if (existing) {
      // Upgrade Recruiters created before the `protected` flag existed so they can't be fired.
      if (!(existing.config as any)?.protected) {
        dbUpdateAgentConfig(existing.id, {
          ...existing.config,
          protected: true,
        } as any);
      }
      // Upgrade Recruiters whose system prompt predates the seed_files mechanism — this
      // runs for every existing account (see index.ts's boot backfill loop), which is
      // what makes the fix apply retroactively instead of only to new signups. Without
      // this, a Recruiter can author knowledge-seed files for a new agent but has no
      // instructed way to actually transfer them — the exact bug this closes (KAIROS
      // Research Agent, 2026-07-12: files written, described as "created" for the new
      // agent, but never left the Recruiter's own workspace).
      const currentPrompt = RECRUITER_CONFIG.customSystemPrompt?.content;
      if (
        currentPrompt &&
        existing.config.customSystemPrompt?.content !== currentPrompt
      ) {
        try {
          await this.updateAgent(existing.id, {
            config: {
              ...existing.config,
              customSystemPrompt: { mode: 'replace', content: currentPrompt },
            },
          });
          logger.info(
            { agentId: existing.id, ownerId },
            'Upgraded Recruiter system prompt (seed_files mechanism)',
          );
        } catch (e) {
          logger.warn(
            { agentId: existing.id, ownerId, err: String(e) },
            'Failed to upgrade Recruiter system prompt',
          );
        }
      }
      return existing.id;
    }
    const agent = await this.createAgent({
      name: 'Recruiter',
      type: 'custom',
      emoji: '🧑‍💼',
      config: { ...RECRUITER_CONFIG },
    });
    dbSetAgentOwner(agent.id, ownerId);
    logger.info(
      { agentId: agent.id, ownerId },
      'Provisioned Recruiter starter agent',
    );
    return agent.id;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const id = randomUUID();
    const workspacePath = this.workspace.getAgentRoot(id);

    // Merge proposed tools into config tools list so the agent knows it has them
    const toolIds = [
      ...(input.config.tools ?? []),
      ...(input.proposedTools?.map((t) => t.id) ?? []),
    ];

    // Auto-generate webhook token if not already present
    const config: typeof input.config = {
      ...input.config,
      tools: Array.from(new Set(toolIds)),
      webhookToken:
        input.config.webhookToken ?? crypto.randomBytes(24).toString('hex'),
    };

    // Every agent gets a background self_improve entry by default (distills the last
    // week of episode logs into searchable memory, folds high-confidence lessons into
    // IDENTITY.md's LEARNED section). Previously this cycle type only ever ran if
    // someone manually triggered it or wired it into a Pipeline — "remember" and
    // "learn" were opt-in in practice for the overwhelming majority of agents
    // (on_demand ones). AgentScheduler.register() exempts self_improve from the
    // on_demand "no auto-runs" rule, so this now actually fires.
    if (!config.schedule.some((s) => s.type === 'self_improve')) {
      config.schedule = [
        ...config.schedule,
        { type: 'self_improve', interval: '7d', enabled: true },
      ];
    }

    // Every agent also gets a weekly check-in — the reporting half of "hire an agent",
    // and the only scheduled moment the owner is asked anything. It had never been
    // wired to a schedule anywhere: on prod, 0 of 16 agents carried a checkin entry and
    // the only 3 checkin cycles that ever ran were triggered by hand. Existing agents
    // are deliberately NOT backfilled here — a check-in asks the owner questions and
    // waits, so switching it on for live accounts is a product call, not a migration.
    if (!config.schedule.some((s) => s.type === 'checkin')) {
      config.schedule = [
        ...config.schedule,
        { type: 'checkin', interval: '7d', enabled: true },
      ];
    }

    // 1. Provision filesystem
    this.workspace.provision(id, input.type, input.config.customWorkspaceDirs);

    // 2. Write IDENTITY.md
    const identityMd = renderIdentity(input.type, config, input.name);
    this.workspace.writeFile(id, 'IDENTITY.md', identityMd);

    // 3. Write SCHEMA.md — output file conventions for this agent
    const schemaMd = renderSchemaMd(input.type, input.trackerSchema);
    this.workspace.writeFile(id, 'SCHEMA.md', schemaMd);

    // 4. Write config.json
    this.workspace.writeFile(
      id,
      'config.json',
      JSON.stringify(config, null, 2),
    );

    // 5. Archive v1 identity
    this.workspace.archiveIdentityVersion(id, 1);

    // 6. Insert into DB with our pre-chosen id
    const now = new Date().toISOString();
    const agent: Agent = {
      id,
      name: input.name,
      type: input.type,
      emoji: input.emoji,
      status: 'idle',
      workspace: workspacePath,
      config,
      identity_version: 1,
      created_at: now,
    };

    insertAgent(agent);

    // 7. Save tracker schema to entity_schemas table if provided
    if (input.trackerSchema) {
      upsertEntitySchema(id, input.trackerSchema);
    }

    return agent;
  }

  /** Start an agent — sets status to 'running'. Scheduler will pick it up. */
  async startAgent(id: string): Promise<void> {
    const agent = dbGetAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);
    // 'running' in the DB mid-cycle is not "started" — see getSettledStatus. Skipping on
    // it meant Start during a chat turn did nothing at all.
    this.holdStatusThroughCycle(id, 'running');
    if (agent.status === 'running') return; // idempotent
    updateAgentStatus(id, 'running');
  }

  /** Pause an agent — no new cycles will be triggered until resumed. */
  async pauseAgent(id: string): Promise<void> {
    const agent = dbGetAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);
    updateAgentStatus(id, 'paused');
  }

  /** Stop an agent — sets to idle, preserves workspace. */
  /**
   * Stop an agent, including whatever it is doing right now.
   *
   * This used to be `updateAgentStatus(id, 'idle')` and nothing else — it flipped a
   * field while the cycle carried on in its container, so a run parked waiting for a
   * human sat there for its full fifteen minutes after the operator had pressed Stop
   * and watched the status go idle. A button labelled Stop that stops nothing is worse
   * than no button: it tells you the problem is handled.
   *
   * Raising the interrupt flag is the mechanism that already exists for this — the
   * cycle polls it (`GET /:id/interrupt-flag`) and winds itself down, which is a clean
   * stop rather than a killed container. Killing the container is deliberately NOT done
   * here: the runner treats a non-zero exit as a crash and starts the work again, so a
   * hard kill turns "stop" into "restart" (observed live 2026-09-03).
   */
  async stopAgent(id: string): Promise<void> {
    const agent = dbGetAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);
    setAgentInterruptFlag(id);
    this.holdStatusThroughCycle(id, 'idle');
    updateAgentStatus(id, 'idle');
  }

  /** Delete an agent — removes from DB and archives workspace. */
  async deleteAgent(id: string): Promise<void> {
    dbDeleteAgent(id);
    this.workspace.remove(id);
    // Tear down sidecar container and cache volume if one was provisioned
    sidecarRegistry
      .teardown(id)
      .catch((err) =>
        logger.warn(
          { agentId: id, err },
          'Sidecar teardown error during agent delete',
        ),
      );
  }

  /** Update an agent's name, emoji, config, and/or whatsapp_jid fields. */
  async updateAgent(
    id: string,
    updates: Partial<Pick<Agent, 'name' | 'emoji' | 'config'>> & {
      whatsapp_jid?: string | null;
    },
  ): Promise<Agent> {
    const agent = dbGetAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);

    const mergedConfig =
      updates.config !== undefined
        ? { ...agent.config, ...updates.config }
        : agent.config;

    // Persist to DB
    updateAgentFields(id, {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.emoji !== undefined ? { emoji: updates.emoji } : {}),
      ...(updates.config !== undefined ? { config: mergedConfig } : {}),
      ...('whatsapp_jid' in updates
        ? { whatsapp_jid: updates.whatsapp_jid ?? null }
        : {}),
    });

    // Update config.json in workspace if config changed
    if (updates.config !== undefined) {
      this.workspace.writeFile(
        id,
        'config.json',
        JSON.stringify(mergedConfig, null, 2),
      );
    }

    // Bump identity version when goals change — archive current IDENTITY.md first
    const updatedName = updates.name ?? agent.name;
    if (
      updates.config?.goals !== undefined &&
      updates.config.goals !== agent.config.goals
    ) {
      const newVersion = agent.identity_version + 1;
      this.workspace.archiveIdentityVersion(id, agent.identity_version);
      const newIdentityMd = renderIdentity(
        agent.type,
        mergedConfig,
        updatedName,
      );
      this.workspace.writeFile(id, 'IDENTITY.md', newIdentityMd);
      updateAgentIdentityVersion(id, newVersion);
    } else if (
      updates.config !== undefined &&
      (!isEqualJSON(updates.config.references, agent.config.references) ||
        !isEqualJSON(
          updates.config.customWorkspaceDirs,
          agent.config.customWorkspaceDirs,
        ) ||
        !isEqualJSON(
          updates.config.customSystemPrompt,
          agent.config.customSystemPrompt,
        ) ||
        !isEqualJSON(updates.config.personality, agent.config.personality) ||
        (updates.config.icp !== undefined &&
          updates.config.icp !== agent.config.icp))
    ) {
      // Refresh IDENTITY.md in place (no version bump) when identity-shaping fields change
      // without touching the mission. Without this, references uploaded post-creation
      // are persisted in config but the agent never learns they exist.
      const newIdentityMd = renderIdentity(
        agent.type,
        mergedConfig,
        updatedName,
      );
      this.workspace.writeFile(id, 'IDENTITY.md', newIdentityMd);
    }

    const refreshed = dbGetAgent(id);
    if (!refreshed) throw new Error(`Agent ${id} not found after update`);
    return refreshed;
  }

  getAgent(id: string): Agent | null {
    return dbGetAgent(id);
  }

  getAllAgents(): Agent[] {
    return dbGetAllAgents();
  }

  /** Run a single work cycle for an agent. Optional projectId scopes the cycle to a project workspace.
   *  If replyFn is provided, the cycle summary is posted back to the originating chat (@ mention dispatch). */
  /**
   * Persist + broadcast a message into an agent's own chat thread (`agent:<id>`).
   * Used so EVERY cycle — scheduled, handoff, pipeline, API — lands in the chat
   * timeline, not just chat-box-initiated ones. Stage 20 unification.
   */
  /** Fire cycle-usage reminders as the owner crosses 50/75/90/99/100% of their monthly
   *  allowance. Each threshold notifies at most once per month (recordUsageAlert dedups). */
  private _maybeAlertUsage(
    userId: string,
    agentId: string,
    used: number,
    limit: number,
  ): void {
    if (!Number.isFinite(limit) || limit <= 0) return; // unlimited/BYOK — nothing to warn about
    const pct = (used / limit) * 100;
    const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM' (UTC), matches cycle reset
    for (const t of [50, 75, 90, 99, 100]) {
      if (pct < t) continue;
      if (!recordUsageAlert(userId, month, t)) continue; // already fired this month
      const remaining = Math.max(0, limit - used);
      const title =
        t >= 100
          ? 'Monthly agent runs used up'
          : `You've used ${t}% of your monthly runs`;
      const body =
        t >= 100
          ? `You've used all ${limit} agent runs this month. Your agents pause until the 1st — upgrade for more.`
          : `You've used ${used} of ${limit} monthly agent runs (${remaining} left). At 100% your agents pause until the 1st.`;
      try {
        notify('usage_alert', title, body, agentId);
      } catch {
        /* non-fatal */
      }
    }
  }

  private _emitCycleChat(
    agentId: string,
    agent: { name: string; emoji?: string },
    text: string,
    cycleId?: string,
    kind: 'start' | 'result' | 'fail' | 'msg' = 'msg',
    targetJid?: string,
    source?: string,
  ): void {
    if (!text?.trim()) return;
    try {
      const jid = targetJid ?? `agent:${agentId}`;
      // Tag the message id with the cycle id so the Log can scroll to it.
      const msgId = cycleId
        ? `cyc-${cycleId}-${kind}-${randomUUID().slice(0, 8)}`
        : `cycle_msg_${randomUUID()}`;
      const timestamp = new Date().toISOString();
      const senderName = `${agent.emoji ?? '🤖'} ${agent.name}`;
      storeChatMetadata(
        jid,
        timestamp,
        agent.name ?? 'Agent Chat',
        'dashboard',
        false,
      );
      storeMessageDirect({
        id: msgId,
        chat_jid: jid,
        sender: senderName,
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: true,
        source,
      });
      getSocketIO()?.emit('chat:message', {
        id: msgId,
        chatJid: jid,
        text,
        timestamp,
        sender: senderName,
        source,
      });
      // Stage 35 dual-write: mirror into the conversation event log. Deliberately a
      // faithful mirror of the legacy write, including its flaws — it sits after the
      // empty-text early-return above, so a cycle that failed with no reply text still
      // appends nothing here. That's the launch-day bug, and Phase 1 fixes it at the
      // source (an error contract every producer must satisfy); Phase 0 only proves
      // the stream reproduces today's data.
      appendConversationEvent(jid, {
        type: kind === 'fail' ? 'error' : 'agent_msg',
        cycle_id: cycleId,
        role: 'assistant',
        content: text,
        status: kind === 'fail' ? 'error' : 'ok',
        metadata: JSON.stringify({
          kind,
          source,
          sender: senderName,
          legacy_msg_id: msgId,
        }),
      });
    } catch (err) {
      logger.warn(
        { agentId, err: String(err) },
        'Failed to emit cycle chat message',
      );
    }
  }

  /**
   * Post a factual note into an agent's thread as SYSTEM — not as the agent.
   *
   * For things the platform knows and the model must not be free to narrate its own
   * version of (e.g. exactly which files a create_agent call really seeded). Attributed
   * to System deliberately: the agent didn't say it, and dressing it up as the agent's
   * own words is how a record meant to correct the model becomes indistinguishable from
   * the model.
   */
  private _emitSystemChat(agentId: string, text: string): void {
    if (!text?.trim()) return;
    try {
      const jid = `agent:${agentId}`;
      const msgId = `sys-${randomUUID().slice(0, 8)}`;
      const timestamp = new Date().toISOString();
      storeChatMetadata(jid, timestamp, 'Agent Chat', 'dashboard', false);
      storeMessageDirect({
        id: msgId,
        chat_jid: jid,
        sender: 'System',
        sender_name: 'System',
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: true,
      });
      appendChatMessageEvent(jid, {
        content: text,
        sender: 'System',
        source: 'system',
        legacyMsgId: msgId,
      });
      getSocketIO()?.emit('chat:message', {
        id: msgId,
        chatJid: jid,
        text,
        timestamp,
        sender: 'System',
      });
    } catch (err) {
      logger.warn(
        { agentId, err: String(err) },
        'Failed to emit system chat message',
      );
    }
  }

  /**
   * Persist + stream an inbound human turn that arrived over an external channel
   * (e.g. WhatsApp), so the dashboard thread shows the message the client sent — not
   * just the agent's reply — tagged with its source so the UI can badge it.
   */
  private _emitUserChat(
    agentId: string,
    text: string,
    targetJid?: string,
    source?: string,
  ): void {
    if (!text?.trim()) return;
    try {
      const jid = targetJid ?? `agent:${agentId}`;
      const msgId = `usr-${source ?? 'ext'}-${randomUUID().slice(0, 8)}`;
      const timestamp = new Date().toISOString();
      storeChatMetadata(jid, timestamp, 'Agent Chat', 'dashboard', false);
      storeMessageDirect({
        id: msgId,
        chat_jid: jid,
        sender: 'You',
        sender_name: 'You',
        content: text,
        timestamp,
        is_from_me: true,
        is_bot_message: false,
        source,
      });
      getSocketIO()?.emit('chat:message', {
        id: msgId,
        chatJid: jid,
        text,
        timestamp,
        sender: 'You',
        fromUser: true,
        source,
      });
      // Stage 35 dual-write — see _emitCycleChat.
      appendConversationEvent(jid, {
        type: 'user_msg',
        role: 'user',
        content: text,
        status: 'ok',
        metadata: JSON.stringify({ source, legacy_msg_id: msgId }),
      });
    } catch (err) {
      logger.warn(
        { agentId, err: String(err) },
        'Failed to emit inbound channel message',
      );
    }
  }

  async runCycle(
    agentId: string,
    cycleType: CycleType,
    extraContext?: string,
    projectId?: string,
    replyFn?: (text: string) => Promise<void>,
    _pipelineVisited?: Set<string>,
    opts?: {
      chatJid?: string;
      source?: string;
      userMessage?: string;
      conversational?: boolean;
      humanRequested?: boolean;
      laneHint?: LaneHint;
      timer?: TimerContext;
    },
  ): Promise<AgentCycle> {
    const agent = dbGetAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Stream JID: where the live cycle trace (thinking, tool calls, result) is emitted.
    // Defaults to agent:{agentId} for direct agent chat; callers can override to a
    // project JID so project-chat cycles get the full timeline there instead.
    const streamJid = opts?.chatJid;
    const source = opts?.source;
    let stopOwnActivity: (() => void) | undefined;

    // Surface the inbound channel turn (e.g. a client's WhatsApp message) as the human's
    // message in the dashboard thread — so the chat shows the prompt, not just the reply.
    if (opts?.userMessage)
      this._emitUserChat(agentId, opts.userMessage, streamJid, source);

    // Pre-cycle gates (budget / plan / paywall) run BEFORE the agent is marked 'running'
    // and before the cycle-execution try below — so a rejection leaves the agent idle and
    // never enters the catch (which assumes a cycle record already exists).
    // Global platform budget gate — pauses every agent when total daily spend hits cap.
    // Read straight from process.env so the runtime picks up edits without restart.
    const globalCapRaw = process.env.GLOBAL_DAILY_BUDGET_USD;
    const globalCap = globalCapRaw ? parseFloat(globalCapRaw) : 0;
    if (globalCap > 0) {
      const platformToday = getPlatformCostToday();
      if (platformToday >= globalCap) {
        throw new Error(
          `Global daily budget exhausted: $${platformToday.toFixed(2)} / $${globalCap.toFixed(2)}. All agents paused.`,
        );
      }
    }

    // Budget gate: check daily spend
    const todayCost = getCycleCostToday(agentId);
    if (todayCost >= agent.config.budget.daily) {
      if (agent.config.budget.onExhaust === 'pause') {
        updateAgentStatus(agentId, 'paused');
      }
      this._dispatchWebhook(agent, {
        type: 'budget.exhausted',
        cost: todayCost,
        limit: agent.config.budget.daily,
      });
      throw new Error(
        `Daily budget exhausted for agent ${agentId}: $${todayCost.toFixed(2)} / $${agent.config.budget.daily}`,
      );
    }

    // Plan cycle-limit gate (Topic 02): block when the owner has used their monthly run
    // allowance. Admins and BYOK users are unlimited; the count spans all the owner's agents.
    const limitOwnerId = (agent as { owner_id?: string }).owner_id;
    if (limitOwnerId) {
      const owner = getUserById(limitOwnerId);
      // BYOK lifts the cycle cap only on tiers that ALLOW BYOK. A key left over from
      // a higher tier (e.g. after a downgrade) must not grant unlimited runs on a
      // plan that doesn't include BYOK — otherwise the tier gate is trivially bypassed.
      const hasByok =
        !!getUserByok(limitOwnerId).keyEnc && planAllowsByok(owner?.plan);
      if (owner && owner.role !== 'admin' && !hasByok) {
        // Hard paywall (Stage 32): a self-serve user with no active plan can't run anything
        // until they subscribe. Admin-granted plans and BYOK (which requires a paid tier) pass.
        if (!hasActivePlan(owner.plan)) {
          const friendly = `Your crew isn't active yet — choose a plan in Account → Plan & billing to start running your agents.`;
          try {
            this._emitCycleChat(
              agentId,
              agent,
              `_⚠️ ${friendly}_`,
              `noplan-${Date.now()}`,
              'fail',
              streamJid,
              source,
            );
          } catch {
            /* non-fatal */
          }
          try {
            await replyFn?.(friendly);
          } catch {
            /* non-fatal */
          }
          throw new Error(
            `No active plan for owner ${limitOwnerId}: subscription required.`,
          );
        }
        const used = countUserCyclesThisMonth(limitOwnerId);
        const limit = planCycleLimit(owner.plan);
        this._maybeAlertUsage(limitOwnerId, agentId, used, limit);
        if (used >= limit) {
          const friendly =
            `You've reached this month's limit of ${limit} agent runs on the ${owner.plan || 'Starter'} plan. ` +
            `It resets on the 1st of next month — or upgrade for more.`;
          // Surface it in the chat thread (reliable on the socket path, since pre-cycle
          // throws skip runCycle's own "Cycle failed" emit) + best-effort replyFn.
          try {
            this._emitCycleChat(
              agentId,
              agent,
              `_⚠️ ${friendly}_`,
              `limit-${Date.now()}`,
              'fail',
              streamJid,
              source,
            );
          } catch {
            /* non-fatal */
          }
          try {
            await replyFn?.(friendly);
          } catch {
            /* non-fatal */
          }
          throw new Error(
            `Monthly run limit reached: ${used}/${limit} on the ${owner.plan || 'Starter'} plan.`,
          );
        }
      }
    }

    // Refuse a concurrent cycle BEFORE taking any side effect.
    //
    // The rejection used to happen a few lines further down, after the status flip and the
    // cycle.start webhook below — so every refused call still told the outside world that a
    // cycle had begun. The consequence that always fired: a `cycle.start` webhook delivered
    // to the owner's endpoint for a cycle that never ran, and therefore never followed by a
    // matching cycle.completed or cycle.failed. A consumer counting starts against finishes
    // drifts by one per overlapping tick, and nothing in the logs says why — the throw's own
    // line reads only "already running a cycle".
    //
    // The status flip just above is usually a no-op on this path (the cycle already holding
    // the slot has normally set status to 'running' itself), but it is reachable: stop an
    // agent mid-cycle and the next colliding call reads 'idle', writes 'running', and throws
    // before the try/finally that would restore it — silently undoing the stop.
    //
    // This is the *check* only. The slot is still claimed further down, immediately before
    // the try/finally that releases it, so a gate rejection can never strand it — see the
    // comment there. Nothing between here and the claim awaits, so no race is introduced.
    if (this.runningCycles.has(agentId)) {
      throw new Error(`Agent ${agentId} is already running a cycle`);
    }

    // Gates passed — mark running, fire the start webhook, then claim the concurrency slot.
    // The runningCycles guard/add live HERE (after the gates, immediately before the
    // try/finally that releases the slot) so a gate rejection can never strand the slot and
    // permanently block the agent. Prevents the budget-gate race where concurrent requests
    // all read the same completed-cost total before any cycle records its cost.
    // `status` answers "is this agent enabled" — running (started), paused, or
    // idle (stopped). Whether a cycle is executing *right now* is tracked
    // separately and precisely by runningCycles below. Those two were previously
    // conflated: the end of every cycle forced status to 'idle', which is also
    // what stopAgent() writes, so the scheduler's `status === 'running'` gate
    // never matched again and a started agent fired exactly one cycle, ever.
    // Capture the pre-cycle status so the end of the cycle can restore it.
    const statusBeforeCycle = dbGetAgent(agentId)?.status ?? agent.status;
    if (agent.status === 'idle') {
      updateAgentStatus(agentId, 'running');
      getSocketIO()?.emit('agent:status_changed', {
        agentId,
        status: 'running',
      });
    }
    this._dispatchWebhook(agent, { type: 'cycle.start', cycleType, projectId });
    if (this.runningCycles.has(agentId)) {
      throw new Error(`Agent ${agentId} is already running a cycle`);
    }
    this.runningCycles.add(agentId);
    noteCycleStart(agentId);
    this.statusBeforeCycles.set(agentId, statusBeforeCycle);
    // Clear any stale interrupt flag from a previous (possibly stranded) run, so a fresh
    // cycle isn't immediately interrupted at iteration 1 by a leftover stop signal.
    clearAgentInterruptFlag(agentId);

    let openCycleId: string | undefined;
    try {
      // Create cycle record
      const cycle = createAgentCycle({
        agent_id: agentId,
        cycle_type: cycleType,
        status: 'running',
        started_at: new Date().toISOString(),
        cost: 0,
        tasks_done: 0,
        project_id: projectId,
        resume_hint: extraContext ?? undefined,
        human_requested: opts?.humanRequested === true,
        schedule_entry_id: opts?.timer?.id ?? null,
        // Stage 55 phase 3 — stamp the model this cycle will actually run on, so a later
        // regression can be attributed to a model change instead of guessed at.
        model: agent.config.model ?? undefined,
        status_before: statusBeforeCycle,
      });
      openCycleId = cycle.id;

      // Emit typed lane event so the dashboard and policy engine observe the start
      laneEventBus.emit_event({
        type: 'TurnStarted',
        lane: cycleType,
        agentId,
        cycleId: cycle.id,
        ts: ts(),
      });

      // ── Special handling for self_improve cycles ─────────────────────────────
      // Set only when a self_improve cycle finds skills worth a model's judgment and
      // falls through to the container path instead of returning early.
      let curationContext: string | undefined;

      if (cycleType === 'self_improve') {
        try {
          const { memories, failed: distillFailed } =
            await this.distiller.distill(agent.id, agent.name, agent.type);
          // Natural forgetting: decay relevance + prune faded old memories, then refresh MEMORY.md.
          // Housekeeping must never be able to stop an agent from working.
          //
          // Prod, 2026-09-02: decayAndPruneMemories threw a FOREIGN KEY error, the catch
          // at the bottom of this try marked the cycle failed and rethrew, and the agent
          // did not run at all. The specific FK is fixed in db.ts — this is the class fix,
          // and it is the one that matters: forgetting old memories is the least important
          // thing this cycle does, and it was able to cancel everything else.
          let decay = { decayed: 0, pruned: 0 };
          try {
            decay = decayAndPruneMemories(agent.id);
          } catch (err) {
            logger.warn(
              {
                agentId: agent.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'memory decay/prune failed — skipped for this cycle, the cycle continues',
            );
          }
          if (decay.pruned > 0 || decay.decayed > 0) syncMemoryViews(agent.id);
          logger.info({ agentId: agent.id, ...decay }, 'memory decay/prune');

          // Stage 42 #4, cheap half — retire agent-written skills nothing has used in
          // 90 days. Memory already decays here; skills accumulating forever while
          // memory forgets is the asymmetry this closes. Pure date arithmetic on the
          // workspace, so it belongs on this container-free path (doc Decision 1) —
          // and it has to live here, because a self_improve cycle never reaches a
          // container, which is why the Python half's documented trigger never fired.
          const skillSweep = sweepQuietly(
            this.workspace.getAgentRoot(agent.id),
            agent.id,
          );
          const evolveResult = await this.evolver.evolve(agent.id);

          // Fold newly-distilled, high-relevance memory back into the agent's seed
          // knowledge — otherwise memory and identity keep growing while the original
          // seed document (if any was seeded at creation) stays frozen at whatever the
          // Recruiter wrote on day one.
          if (memories.length > 0) {
            try {
              this._enrichKnowledgeSeed(agent.id, memories);
            } catch (e) {
              logger.warn(
                { agentId: agent.id, err: String(e) },
                'Knowledge-seed enrichment failed',
              );
            }
          }

          const newMemCount = memories.length;
          const evolved =
            'version' in evolveResult ? evolveResult.version : null;
          // "Identity updated to v3" used to print whether or not anything changed — the
          // version shown was simply the current one. Say which it was, and why not.
          const identityLine =
            evolved !== null
              ? `Identity updated to v${evolved}.`
              : `Identity unchanged at v${agent.identity_version} (${'skipped' in evolveResult ? evolveResult.skipped : 'no change'}).`;
          // Say plainly when distillation broke. "Extracted 0 new learnings" read as a clean
          // result for three consecutive runs while the extractor was failing outright.
          // Only mentioned when it actually did something. A "Retired 0 skills" on every
          // self_improve summary is noise, and worse, it reads as a working feature on an
          // agent that has never written a skill at all.
          const retired = skillSweep?.archived.length
            ? ` Retired ${skillSweep.archived.length} unused skill${skillSweep.archived.length !== 1 ? 's' : ''}.`
            : '';
          const summary =
            (distillFailed
              ? `Memory distillation FAILED — episodes left undistilled and will be retried next cycle. ${identityLine}`
              : `Extracted ${newMemCount} new learning${newMemCount !== 1 ? 's' : ''}. ${identityLine}`) +
            retired;
          if (evolved !== null)
            this._dispatchWebhook(agent, {
              type: 'identity.evolved',
              version: evolved,
            });

          // Stage 42 #4, judgment half — the seam curator.py's consolidation_candidates
          // docstring says it is waiting for. Deciding that two skills say the same
          // thing, or that one is stale rather than merely unfashionable, needs a model;
          // the sweep above deliberately stops at the warning shelf and leaves those on
          // disk. `stale` is exactly that list.
          //
          // Doc Decision 1 put this in a self_improve sub-mode rather than a new cycle
          // type. It could not work before, because self_improve returns above without
          // ever reaching a container — so `curate_skills` was registered on every loop
          // and triggered by nothing. Falling through hands the same cycle record to the
          // normal container path with a curation task attached.
          //
          // Gated on there being something to curate, which keeps it free in the common
          // case: a self_improve with nothing stale still costs $0.002 and spawns no
          // container, exactly as before. Only an agent that has actually written skills
          // and let them go idle pays for a container leg.
          if (skillSweep?.stale.length) {
            curationContext = [
              `## Skill curation (this cycle)`,
              ``,
              `${skillSweep.stale.length} skill${skillSweep.stale.length !== 1 ? 's' : ''} you wrote yourself ${skillSweep.stale.length !== 1 ? 'have' : 'has'} gone unused for 30+ days: ${skillSweep.stale.map((s) => `\`${s}\``).join(', ')}.`,
              ``,
              `Use the \`curate_skills\` tool to review them. For each one, decide whether it is:`,
              `- **worth keeping** — pin it, so it stops ageing;`,
              `- **duplicated** by a newer skill — merge them into one;`,
              `- **wrong or superseded** — patch it, or archive it.`,
              ``,
              `Leaving one alone is a valid answer; it will be archived automatically at 90 days`,
              `and can be restored. Only skills you wrote are eligible — anything the user wrote`,
              `is off-limits and will not appear here. Do this before your other work.`,
            ].join('\n');
            logger.info(
              { agentId: agent.id, stale: skillSweep.stale.length },
              'self_improve escalating to a container leg for skill curation',
            );
          } else {
            updateAgentCycle(cycle.id, {
              status: 'completed',
              ended_at: new Date().toISOString(),
              summary,
              cost: 0.002,
              tasks_done: newMemCount,
            });
            updateAgentLastActive(agentId);

            laneEventBus.emit_event({
              type: 'TurnCompleted',
              lane: cycleType,
              agentId,
              cycleId: cycle.id,
              cost: 0.002,
              tasksDone: newMemCount,
              ts: ts(),
            });

            return {
              ...cycle,
              status: 'completed',
              summary,
              cost: 0.002,
              tasks_done: newMemCount,
            };
          }
          // Curation pending — fall through to the container path, which completes
          // this same cycle record rather than opening a second one.
        } catch (err) {
          updateAgentCycle(cycle.id, {
            status: 'failed',
            ended_at: new Date().toISOString(),
            summary: err instanceof Error ? err.message : String(err),
          });
          laneEventBus.emit_event({
            type: 'TurnFailed',
            lane: cycleType,
            agentId,
            cycleId: cycle.id,
            reason: err instanceof Error ? err.message : String(err),
            class: LaneFailureClass.Infra,
            ts: ts(),
          });
          throw err;
        }
      }

      // ── Special handling for checkin cycles ──────────────────────────────────
      if (cycleType === 'checkin') {
        try {
          // No section validation here: generateCheckinReport guarantees CHECKIN_SECTIONS,
          // substituting its own template when the model returns something unusable.
          // This used to throw instead, which failed the cycle and threw the report away —
          // the owner got nothing at all for the week.
          const { reportMd, cost } = await this.generateCheckinReport(agent);

          createAgentCheckin({
            agent_id: agentId,
            status: 'pending',
            report_md: reportMd,
          });
          getSocketIO()?.emit('agent:checkin_created', { agentId });

          updateAgentCycle(cycle.id, {
            status: 'completed',
            ended_at: new Date().toISOString(),
            summary: 'Weekly check-in report generated',
            cost,
            tasks_done: 1,
          });
          updateAgentLastActive(agentId);

          laneEventBus.emit_event({
            type: 'TurnCompleted',
            lane: cycleType,
            agentId,
            cycleId: cycle.id,
            cost,
            tasksDone: 1,
            ts: ts(),
          });

          return {
            ...cycle,
            status: 'completed',
            summary: 'Weekly check-in report generated',
            cost,
            tasks_done: 1,
          };
        } catch (err) {
          updateAgentCycle(cycle.id, {
            status: 'failed',
            ended_at: new Date().toISOString(),
            summary: err instanceof Error ? err.message : String(err),
          });
          laneEventBus.emit_event({
            type: 'TurnFailed',
            lane: cycleType,
            agentId,
            cycleId: cycle.id,
            reason: err instanceof Error ? err.message : String(err),
            class: LaneFailureClass.PromptDelivery,
            ts: ts(),
          });
          throw err;
        }
      }

      // Resolve project name if a projectId was provided, and ensure this agent is linked to it.
      // Auto-linking means the agent appears in BULLETIN.md and crew memory searches immediately.
      const projectName = projectId
        ? (getProject(projectId)?.name ?? undefined)
        : undefined;
      if (projectId) {
        try {
          linkAgentToProject(agentId, projectId);
        } catch {
          /* non-fatal — INSERT OR IGNORE handles duplicates */
        }
      }

      const identityMd = this.workspace.readFile(agentId, 'IDENTITY.md') ?? '';

      // ── Messages: work handed to this agent, and answers to work it handed out ────
      //
      // Stage 56 phase 1. This block used to be `## Pending Handoffs` and carried one
      // direction only, because there was no other direction to carry: a handoff had no
      // result column, so nothing ever came back. Finder handed Mailer 84 leads and learned
      // the fate of none of them.
      //
      // Both directions arrive here now, because a reply is a row addressed to the original
      // sender — so it is delivered by this same, already-proven path rather than a second
      // one. The two are separated under their own headings because they ask for different
      // things: a request is work, a reply is information.
      //
      // The block names the exact tool call to answer with, id included. That is not
      // hand-holding: these two agents invented `ack_received` inside a JSON payload rather
      // than find a channel, and stage 54 measured that `self_report` went uncalled until
      // the prompt named it. An affordance the model has to discover is one it will not use.
      // UNRESOLVED, not unread. Surfacing only `status='pending'` gave an agent exactly one
      // cycle's chance to answer: a message flipped to `seen` on the way out of the first
      // cycle that carried it and was invisible from then on, answered or not. That is the
      // same disease as the old `acknowledged` — the state meaning "you saw this and said
      // nothing" is precisely the one that has to stay in view. Caught 2026-09-09 on the
      // first live test: Mailer had 82 messages owed and would have been shown none.
      const open = getOpenMessagesForAgent(agentId);
      // The retirement loop at the end of the cycle marks what was SHOWN as seen, and only
      // ever moves a row out of `pending` — an `agreed` message must not be knocked back.
      const pendingHandoffs = [...open.owed, ...open.replies].filter(
        (h) => h.status === 'pending',
      );
      let handoffContext: string | undefined;
      if (open.owed.length > 0 || open.replies.length > 0) {
        const inboxDir = path.join(
          DATA_DIR,
          'agents',
          agentId,
          'workspace',
          'inbox',
        );
        fs.mkdirSync(inboxDir, { recursive: true });

        const nameOf = (() => {
          const names = new Map(dbGetAllAgents().map((a) => [a.id, a.name]));
          // A UUID tells the model nothing it can act on — it cannot address a teammate by
          // one, and it will not ask. Fall back to the id only if the agent is gone.
          return (id: string) => names.get(id) ?? id.slice(0, 8);
        })();

        const render = (h: AgentHandoff) => {
          // Write payload to a real inbox file the agent can read
          const inboxFile = path.join(inboxDir, `${h.id}.json`);
          try {
            fs.writeFileSync(inboxFile, h.payload, 'utf-8');
          } catch {
            /* non-fatal */
          }
          const preview = (() => {
            try {
              return JSON.stringify(JSON.parse(h.payload)).slice(0, 150);
            } catch {
              return h.payload.slice(0, 150);
            }
          })();
          return { h, preview };
        };

        const parts: string[] = [];

        if (open.owed.length > 0) {
          parts.push(
            `### Requests for you — ${open.owed.length} unanswered${open.owedOverflow > 0 ? ` (${open.owedOverflow} older ones not listed)` : ''}\n` +
              `Each of these is owed an answer and has never had one. Answer with ` +
              `\`reply_to_handoff\` — one call per message, using the id shown.\n` +
              `Answering "cannot", naming the tool or access you are missing, is a GOOD outcome ` +
              `and far more useful than silence: it tells the sender to route elsewhere and tells ` +
              `your owner what to give you. Doing the work and saying nothing leaves the sender ` +
              `believing nothing happened — that is how 82 batches of leads went unaccounted for.\n` +
              `If you cannot get through all of them this cycle, answer the oldest first and say ` +
              `so; the rest will still be here next time.\n\n` +
              open.owed
                .map(render)
                .map(
                  ({ h, preview }) =>
                    `- **${nameOf(h.from_agent_id)}** — ${h.type}` +
                    (h.status === 'seen'
                      ? ' · you have seen this before and not answered it'
                      : '') +
                    (h.status === 'agreed'
                      ? ' · YOU AGREED TO THIS and have not delivered — finish it or say why not'
                      : '') +
                    '\n' +
                    `  id: \`${h.id}\`\n` +
                    `  sent: ${h.created_at}\n` +
                    (h.note ? `  note: ${h.note}\n` : '') +
                    `  full data: workspace/inbox/${h.id}.json\n` +
                    `  preview: ${preview}`,
                )
                .join('\n'),
          );
        }

        if (open.replies.length > 0) {
          parts.push(
            `### Answers to you\n` +
              `Replies to messages you sent. These are already answered — do not reply again.\n\n` +
              open.replies
                .map(render)
                .map(({ h }) => {
                  const body = (() => {
                    try {
                      const p = JSON.parse(h.payload) as {
                        result?: string;
                        reason?: string | null;
                      };
                      return [p.result, p.reason ? `(reason: ${p.reason})` : '']
                        .filter(Boolean)
                        .join(' ');
                    } catch {
                      return h.payload.slice(0, 300);
                    }
                  })();
                  // An `expire` notice is the system speaking, not the agent — saying so keeps an
                  // agent from recording "Mailer told me it timed out" as something Mailer said.
                  if (h.performative === 'expire') {
                    return (
                      `- your request to **${nameOf(h.from_agent_id)}** EXPIRED unanswered: ${body.slice(0, 300)}
` +
                      `  They never answered. Chase it, do it yourself, or drop it — do not keep waiting.`
                    );
                  }
                  return (
                    `- **${nameOf(h.from_agent_id)}** answered **${h.performative ?? 'result'}**: ${body.slice(0, 400)}
` +
                    `  To follow up in the same conversation, use \`handoff_to\` with in_reply_to=\`${h.id}\`.`
                  );
                })
                .join('\n'),
          );
        }

        handoffContext = `## Messages\n${parts.join('\n\n')}`;
      }

      // Gather unread inter-agent messages the same way — a message another agent sent
      // via handoff_to/message tooling is written to workspace/inbox/msg-*.json at send
      // time, but unlike a handoff nothing previously re-surfaced it into context, so it
      // sat invisible until the recipient happened to browse its own inbox directory.
      const unreadMessages = getUnreadAgentMessages(agentId);
      let messageContext: string | undefined;
      if (unreadMessages.length > 0) {
        messageContext = `## Messages From Other Agents\n${unreadMessages
          .map(
            (m, i) =>
              `### Message ${i + 1}\nFrom: ${m.from_agent_id}\nSubject: ${m.subject}\n${m.body}`,
          )
          .join('\n\n')}`;
      }

      // Anchor the agent's own identity in the runtime context so it survives context
      // compression and cannot be overwritten by first-person statements in shared files
      // (e.g. a teammate's MEMORY.md that says "I am the Strategist").
      const selfContext = (() => {
        const role = agent.config.role?.trim() || agent.name;
        const goals = (agent.config.goals ?? '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 200);
        const goalLine = goals ? `\nYour role: ${goals}` : '';
        return `## Your Identity\nYou are **${agent.name}** (ID: \`${agentId}\`).${goalLine}\nYou are NOT any other agent listed in the crew section. If any file you read refers to itself in the first person as a different agent, that file was written BY that agent — it is not your identity.`;
      })();

      // Inject a crew roster so the agent knows who else exists and can pick a sensible
      // handoff target without having to call swarm_status mid-cycle. Lists name + type +
      // truncated goal so the LLM can match by capability.
      const crewContext = (() => {
        const others = dbGetAllAgents().filter((a) => a.id !== agentId);
        if (others.length === 0) return undefined;
        const lines = others.slice(0, 15).map((a) => {
          const goals = (a.config?.goals ?? '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 100);
          return `- **${a.name}** \`${a.id}\` (type: ${a.type}, status: ${a.status})${goals ? ` — ${goals}${goals.length === 100 ? '…' : ''}` : ''}`;
        });
        return `## Crew (other agents you can hand off to)\nUse \`handoff_to(to_agent_id: "<id-or-name>", ...)\`. Agent names AND ids both work — names are matched exactly (no fuzzy/substring).\n\n${lines.join('\n')}${others.length > 15 ? `\n…and ${others.length - 15} more.` : ''}`;
      })();

      // Project-folder awareness: list the files in the agent's workspace so it always
      // knows what's there — including files the USER uploaded — without having to probe
      // with list_dir. Skips internal plumbing dirs; capped so big trees stay cheap.
      const workspaceFilesContext = (() => {
        const wsRoot = this.workspace.getWorkspacePath(agentId);
        const SKIP_TOP = new Set([
          'inbox',
          'logs',
          'sessions',
          'tools',
          'memory',
          'node_modules',
          '.git',
        ]);
        const CAP = 80;
        const out: string[] = [];
        const walk = (dir: string, rel: string): void => {
          if (out.length >= CAP) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              if (rel === '' && SKIP_TOP.has(e.name)) continue;
              walk(path.join(dir, e.name), relPath);
            } else {
              out.push(relPath);
            }
            if (out.length >= CAP) return;
          }
        };
        walk(wsRoot, '');
        if (out.length === 0) return undefined;
        out.sort();
        // In a project cycle the agent's CWD is the shared workspace, so its private files
        // must be referenced by their absolute mount path (/workspace/group/workspace/…).
        const privBase = projectId ? '/workspace/group/workspace' : 'workspace';
        const listing =
          out.map((p) => `- ${privBase}/${p}`).join('\n') +
          (out.length >= CAP
            ? '\n…(more not shown — use list_dir to see the rest)'
            : '');
        const header = projectId
          ? `## Your Private Files\nThese are YOUR private files (read for context) under \`/workspace/group/workspace/\`. Read any with the file tool. Write your project OUTPUT to \`/workspace/shared/\` — do not write project output into your private folder.`
          : `## Workspace Files\nThese files live in your workspace (your project folder) — including any the user added for you. Read any with the file tool before acting; do not overwrite or delete user-provided files without saying so.`;
        return `${header}\n\n${listing}`;
      })();

      // Pinned must-read files (the project-folder replacement for references): the agent
      // is told to read these before acting, every cycle. Only lists pins that still exist.
      const pinsContext = (() => {
        const pins = (agent.config.pins ?? []).filter(Boolean);
        if (pins.length === 0) return undefined;
        const wsRoot = this.workspace.getWorkspacePath(agentId);
        const present = pins.filter((p) => {
          try {
            return fs.existsSync(path.join(wsRoot, p));
          } catch {
            return false;
          }
        });
        if (present.length === 0) return undefined;
        const privBase = projectId ? '/workspace/group/workspace' : 'workspace';
        return `## Must-Read (pinned)\nRead these files before acting, and cite them when you draw on them:\n\n${present.map((p) => `- ${privBase}/${p}`).join('\n')}`;
      })();

      // Secrets already injected as real env vars for this cycle (nanobot-cycle-runner's
      // fetchAgentCredentials does this unconditionally) — but nothing ever told the AGENT
      // that, so it had no way to know PROXY_HOST etc. were already sitting in os.environ.
      // Found 2026-08-17: asked to wire proxy credentials in, Crawler (reasonably, given
      // it was never told otherwise) built a local .env + python-dotenv layer to duplicate
      // what was already there — turning an encrypted-at-rest secret into a plaintext file
      // in its own workspace for no reason. Names only, never values — same posture as
      // secretsManager.list() over HTTP.
      const secretsContext = (() => {
        const names = Object.keys(
          secretsManager.getAll(agentId, agent.owner_id ?? undefined),
        );
        if (names.length === 0) return undefined;
        return `## Environment Secrets (already available)\nThese are already injected as real environment variables for every cycle — read them directly with \`os.environ.get("NAME")\` (Python) or \`process.env.NAME\` (Node). Do not write them to a .env file, config file, or anywhere else in the workspace — they're already set, and copying them to disk turns an encrypted secret into a plaintext one for no reason:\n\n${names.map((n) => `- ${n}`).join('\n')}`;
      })();

      // C2 read-back: the agent's own tracked records, as AUTHORITATIVE ground truth.
      // This is the source it must cite for any count/metric — never reconstruct or invent.
      const trackedContext = (() => {
        const schema = getEntitySchema(agentId);
        if (!schema) return undefined;
        const items = getTrackedItems(agentId, schema.namePlural);
        if (items.length === 0) return undefined;
        const byStage = new Map<string, number>();
        for (const it of items) {
          const s = it.stage || 'unstaged';
          byStage.set(s, (byStage.get(s) ?? 0) + 1);
        }
        const stageLine = [...byStage.entries()]
          .map(([s, n]) => `${s}: ${n}`)
          .join(', ');
        const recent = items
          .slice(0, 15)
          .map((it) => `- ${it.item_key}${it.stage ? ` [${it.stage}]` : ''}`)
          .join('\n');
        const trackedFile = projectId
          ? `/workspace/group/workspace/tracked/${schema.namePlural}.json`
          : `workspace/tracked/${schema.namePlural}.json`;

        // C3 — outcome analytics: how the work is performing, so the agent can learn from results.
        const stageKeys: string[] = (schema.stages ?? [])
          .map((s: any) => s?.key)
          .filter(Boolean);
        const finalStage = stageKeys[stageKeys.length - 1];
        const reached = finalStage ? (byStage.get(finalStage) ?? 0) : 0;
        const conversion =
          finalStage && items.length
            ? `\nConversion: ${reached}/${items.length} reached "${finalStage}" (${Math.round((reached / items.length) * 100)}%).`
            : '';
        const STALE_DAYS = 7;
        const cutoff = Date.now() - STALE_DAYS * 86400000;
        const stale = items.filter(
          (it) =>
            it.stage !== finalStage && Date.parse(it.stage_since) < cutoff,
        );
        const staleLine = stale.length
          ? `\n⏳ Stale (no progress in ${STALE_DAYS}+ days — follow up or change approach): ${stale
              .slice(0, 8)
              .map((it) => `${it.item_key} [${it.stage}]`)
              .join(', ')}${stale.length > 8 ? ` …(+${stale.length - 8})` : ''}`
          : '';
        const learn = `\n\nLEARN FROM OUTCOMES: review these results — double down on what's converting, follow up on stale items, and when you spot a clear pattern (a segment/approach that converts better or worse), record it with append_memory so you apply it next time.`;

        return `## Your Records — ${schema.namePlural} (AUTHORITATIVE)\nThis is the single source of truth for your ${schema.namePlural}: ${items.length} total (${stageLine}). Use THESE figures for any count, rate, or status — never estimate or invent. To add/update items, write \`${trackedFile}\`.${conversion}${staleLine}\n\nRecent:\n${recent}${items.length > 15 ? `\n…and ${items.length - 15} more` : ''}${learn}`;
      })();

      const fileTracker = new FileTracker(path.join(DATA_DIR, 'agents'));
      const snapshotBefore = fileTracker.snapshot(agentId);

      try {
        const combinedContext =
          [
            selfContext,
            curationContext,
            extraContext,
            handoffContext,
            messageContext,
            crewContext,
            workspaceFilesContext,
            pinsContext,
            secretsContext,
            trackedContext,
          ]
            .filter(Boolean)
            .join('\n\n') || undefined;

        // Announce the cycle in the target chat. Live tool activity is PUSHED
        // by the nanobot adapter (POST …/cycles/:id/steps → streamCycleSteps) rather
        // than polled from a file; we just bracket it with start/done markers.
        this._emitCycleChat(
          agentId,
          agent,
          `_⚙️ Running ${cycleType.replace(/_/g, ' ')} cycle…_`,
          cycle.id,
          'start',
          streamJid,
        );
        startCycleStream(agentId, streamJid, cycle.id);
        stopOwnActivity = () => endCycleStream(agentId, cycle.id);

        const result = await this.runner.run({
          agentId,
          cycleId: cycle.id,
          cycleType,
          workspacePath: this.workspace.getWorkspacePath(agentId),
          identityMd,
          config: agent.config,
          handoffContext: combinedContext,
          projectId,
          projectName,
          conversational: opts?.conversational,
          humanRequested: opts?.humanRequested === true,
          laneHint: opts?.laneHint,
          timer: opts?.timer,
        });

        // Track and persist workspace file changes for this cycle
        try {
          const snapshotAfter = fileTracker.snapshot(agentId);
          const diffs = fileTracker.diff(
            agentId,
            snapshotBefore,
            snapshotAfter,
          );
          // streamJid, so a cycle's file changes land in the same conversation as its
          // messages and steps. Without it they resolve independently and a
          // project-scoped cycle with no chatJid splits across two threads.
          fileTracker.persistEvents(agentId, cycle.id, diffs, streamJid);
        } catch {
          /* non-fatal — don't fail cycle over tracking */
        }

        // C2: sync the agent's tracked/<Entity>.json into the durable tracked_items store.
        try {
          this._syncTrackedItems(agentId);
        } catch {
          /* non-fatal */
        }

        // ── The error contract (Stage 35) ─────────────────────────────────────
        // An error inside the container doesn't throw: the framework catches it and
        // returns an ordinary exit-0 result whose text *is* the error. Detect that
        // here and throw, so it lands in the same catch as a container crash and gets
        // the same treatment — cycle marked failed, a distinct ⚠️ error event in the
        // conversation. Without this, the code below marks the cycle 'completed' and
        // posts the error text as the agent's reply (or, when the reply is empty,
        // posts nothing at all — which is what made a broken Recruiter agent look
        // like it was repeating its last message on launch day).
        //
        // Placed after file/tracked-item persistence: the work the container *did* do
        // before failing really happened, and stays recorded.
        const failure = detectResultFailure(result);
        if (failure) {
          logger.warn(
            {
              agentId,
              cycleId: cycle.id,
              reason: failure.reason,
              summary: result.summary?.slice(0, 200),
            },
            'Cycle returned an error-shaped result — failing it',
          );
          throw new CycleResultError(
            failure.message,
            failure.reason,
            result.cost,
          );
        }

        updateAgentCycle(cycle.id, {
          status: 'completed',
          ended_at: new Date().toISOString(),
          summary: result.summary,
          cost: result.cost,
          tasks_done: result.tasksDone,
        });
        snapshotActivityForCycle(
          agentId,
          cycle.id,
          projectId,
          cycle.started_at,
        );
        updateAgentLastActive(agentId);

        // Acknowledge inbound handoffs and process outbound declarations.
        // Track which recipients get a cycle fired this round (handoff OR pipeline) so
        // we don't double-fire the same agent via both paths.
        //
        // 'custom' cycles are the event-driven path — an outreach follow-up coming due, a HITL
        // approval resuming, an @mention from chat. They are fired for a reason that has nothing
        // to do with the inbox, but they still receive every pending handoff as context, and
        // retiring one here quietly destroys the only signal the scheduler has that the work is
        // still owed: AgentScheduler's send_outreach gate arms itself off
        // getPendingHandoffsByAgent(), which counts status='pending' alone.
        //
        // That is exactly how Mailer stalled. Finder handed over 28 qualified leads on 2026-08-23;
        // the next cycle to run was a follow-up 'custom' cycle whose own summary said it had
        // "deferred the 28-lead mega-batch handoff to the next scheduled cycle" — and then this
        // loop marked it acknowledged on the way out. There was no next scheduled cycle: the gate
        // saw zero pending handoffs and skipped every send_outreach slot for the following 33
        // hours while the leads sat unworked in the inbox.
        //
        // So only the agent's actual work cycle retires a handoff. A 'custom' cycle leaves the
        // inbox exactly as it found it.
        //
        // Stage 56 renamed what this writes from `acknowledged` to `seen`, and the rename is
        // the honest description of this exact line: all it knows is that the message was in
        // the context of a cycle that ran. It was never evidence the work was done, and for
        // 347 rows it was read as though it were. `seen` is now a waypoint rather than an
        // ending — the ending is a reply, and only the recipient can write one.
        //
        // A reply is retired the same way and that is correct: an answer needs no answer, so
        // reaching the sender's context is all that is owed.
        if (cycleType !== 'custom') {
          for (const h of pendingHandoffs) {
            updateHandoffStatus(h.id, 'seen');
          }
        }
        for (const m of unreadMessages) {
          markAgentMessageRead(m.id);
        }
        const firedThisRound = new Set<string>();
        this._processOutboundHandoffs(agentId, firedThisRound);
        this._processOutboundMessages(agentId);
        this._firePipelines(
          agentId,
          cycleType,
          'completed',
          result.summary,
          _pipelineVisited,
          projectId,
          cycle.id,
          firedThisRound,
        );
        notify(
          'cycle_completed',
          `${agent.name} finished`,
          result.summary?.slice(0, 120) || `Completed a ${cycleType} cycle`,
          agentId,
          { cycleType, cost: result.cost },
        );

        // Chat shows the agent's ACTUAL answer (conversational), not the terse work-summary
        // (which is for memory/notifications). Falls back to summary if reply is empty.
        //
        // Deliberately NOT skipped when the agent also used the message tool. In a cycle that
        // tool posts to `cli:direct`, which is not a real conversation — verified 2026-08-21,
        // no cli/direct conversation exists in the DB and none of Seeker's message-tool reports
        // ever reached a chat. This post is the only copy the user sees, so suppressing it as a
        // "duplicate" loses the report entirely. (The bus path in loop.py's _dispatch, where the
        // tool does reach a live chat, still suppresses its own duplicate.)
        const chatText =
          result.reply && result.reply.trim() ? result.reply : result.summary;

        // Post result to the target chat. When streamJid is set (project context),
        // _emitCycleChat handles it with a cycle-linked message ID so the UI can
        // correlate the result with the activity stream. Otherwise replyFn (if any)
        // handles project/group dispatch and _emitCycleChat fills the agent thread.
        if (streamJid) {
          if (chatText)
            this._emitCycleChat(
              agentId,
              agent,
              chatText,
              cycle.id,
              'result',
              streamJid,
              source,
            );
        } else {
          if (replyFn && chatText) {
            const reply = `${agent.emoji ?? '🤖'} *${agent.name}*\n${chatText}`;
            replyFn(reply).catch((err) =>
              logger.warn({ agentId, err: err.message }, 'replyFn failed'),
            );
          }
          if (chatText)
            this._emitCycleChat(
              agentId,
              agent,
              chatText,
              cycle.id,
              'result',
              undefined,
              source,
            );
        }

        // The agent's status is restored in the `finally` below, for every exit.

        // A completed cycle is proof the current model works, which is the only thing that
        // makes an automatic rollback possible later. Stage 54 phase 3.
        recordModelWorked(agentId);

        // Update project bulletin board after cycle (non-fatal)
        if (projectId) updateBulletin(projectId, agentId);

        // Write episode log asynchronously (non-blocking — don't await)
        this.writeEpisodeLog(agent, cycle.id, cycleType, result).catch(() => {
          /* silent */
        });

        // Stale-branch check: cheap `.git` stat first so agents whose workspace isn't a
        // repo (most of them) never pay for a git subprocess. The workspace directory is
        // bind-mounted into the container, so the host-side TS process already sees the
        // same working tree the cycle just committed to — no need to ask the container.
        try {
          const workspacePath = this.workspace.getWorkspacePath(agentId);
          if (fs.existsSync(path.join(workspacePath, '.git'))) {
            const freshness = checkBranchFreshness(workspacePath);
            if (!freshness.fresh) {
              laneEventBus.emit_event({
                type: 'BranchStaleAgainstMain',
                lane: cycleType,
                agentId,
                behindBy: freshness.behindBy,
                ts: ts(),
              });
            }
          }
        } catch {
          /* non-fatal — never fail a cycle over a hygiene check */
        }

        laneEventBus.emit_event({
          type: 'TurnCompleted',
          lane: cycleType,
          agentId,
          cycleId: cycle.id,
          cost: result.cost,
          tasksDone: result.tasksDone,
          ts: ts(),
        });

        this._dispatchWebhook(agent, {
          type: 'cycle.complete',
          cycleId: cycle.id,
          cost: result.cost,
          tasksDone: result.tasksDone,
        });
        return {
          ...cycle,
          status: 'completed',
          summary: result.summary,
          cost: result.cost,
          tasks_done: result.tasksDone,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const transient = isTransientError(err);
        updateAgentCycle(cycle.id, {
          status: transient ? 'interrupted' : 'failed',
          ended_at: new Date().toISOString(),
          summary: errMsg,
          // An in-container failure already spent money before it failed; a thrown
          // error carries no cost, so only override when we actually know it.
          ...(err instanceof CycleResultError && err.cost > 0
            ? { cost: err.cost }
            : {}),
        });
        snapshotActivityForCycle(
          agentId,
          cycle.id,
          projectId,
          cycle.started_at,
        );
        // Distinguish an LLM/provider failure (rate limit, mid-stream drop, bad
        // model response) from an actual tool-execution crash, so the self-healing
        // pipeline routes it to FailureScenario.ProviderFailure (3 attempts,
        // alert_human on exhaustion) instead of the generic, silent ToolRuntime
        // bucket. Reuses cycle-failure.ts's single source of truth for "is this
        // text an LLM/provider error" rather than duplicating pattern matching —
        // covers both the exit-0 success-shaped error text (CycleResultError,
        // reason 'error_text') and a directly thrown "Agent execution failed: ..."
        // error.
        const isModelProviderFailure =
          err instanceof CycleResultError
            ? err.reason === 'error_text'
            : looksLikeErrorText(errMsg);
        laneEventBus.emit_event({
          type: 'TurnFailed',
          lane: cycleType,
          agentId,
          cycleId: cycle.id,
          reason: errMsg,
          class: isModelProviderFailure
            ? LaneFailureClass.ModelProvider
            : LaneFailureClass.ToolRuntime,
          ts: ts(),
        });
        if (transient) {
          notify('cycle_failed', `${agent.name} interrupted`, errMsg, agentId, {
            cycleType,
          });
          this._emitCycleChat(
            agentId,
            agent,
            `_⚡ Cycle interrupted (${errMsg}). Type **continue** to retry or describe a new task._`,
            cycle.id,
            'fail',
            streamJid,
          );
        } else {
          notify('cycle_failed', `${agent.name} failed`, errMsg, agentId, {
            cycleType,
          });
          // Surface real (non-transient) cycle failures in Sentry with context (no-op without DSN).
          Sentry?.captureException(
            err instanceof Error ? err : new Error(errMsg),
            {
              tags: { kind: 'agent_cycle', agent: agent.name, cycleType },
              extra: { agentId, cycleId: cycle.id },
            },
          );
          this._emitCycleChat(
            agentId,
            agent,
            `_⚠️ Cycle failed: ${errMsg}_`,
            cycle.id,
            'fail',
            streamJid,
          );
        }
        this._dispatchWebhook(agent, {
          type: 'cycle.failed',
          cycleId: cycle.id,
          error: errMsg,
        });
        // A failed cycle does not disable a started agent either — the `finally` below
        // restores it, and it retries on its next scheduled tick.

        // If the last few cycles all died because the model id does not resolve, put the
        // agent back on what worked. An agent whose model is broken cannot run the cycle it
        // would need to fix itself, so nothing else will.
        try {
          const recent = getCyclesByAgent(agentId, 5)
            .filter((c) => c.status === 'failed')
            .map((c) => c.summary ?? '');
          rollbackModelIfBricked(agentId, recent);
        } catch (rbErr) {
          logger.warn(
            {
              agentId,
              err: rbErr instanceof Error ? rbErr.message : String(rbErr),
            },
            'model rollback check failed',
          );
        }

        throw err;
      }
    } finally {
      stopOwnActivity?.();
      // Every exit ends here, so this is where the cycle is closed and the agent put back.
      //
      // The restore used to sit on the two main exits only. The self_improve fast path and
      // the weekly check-in return early and never reached it, and neither did an error
      // thrown while building the cycle's context or inside the failure handling. Each of
      // those left an idle agent reading 'running' — which the scheduler takes as
      // "started", so a manual agent began firing on its schedule.
      //
      // A cycle finishing does not disable an agent: started agents stay started, a manual
      // run on a stopped one leaves it stopped, and a status the agent set on itself during
      // the cycle wins over both — see _restoreStatusAfterCycle.
      try {
        if (
          openCycleId &&
          failCycleIfStillRunning(
            openCycleId,
            'Cycle ended without recording a result',
          )
        ) {
          logger.warn(
            { agentId, cycleId: openCycleId },
            'Cycle exited without recording an outcome — marked failed',
          );
        }
        this._restoreStatusAfterCycle(agentId, statusBeforeCycle);
      } catch (err) {
        logger.error(
          { agentId, err: err instanceof Error ? err.message : String(err) },
          'Could not restore agent status after cycle',
        );
      }
      this.runningCycles.delete(agentId);
      noteCycleEnd(agentId);
      this.statusBeforeCycles.delete(agentId);
      clearAgentInterruptFlag(agentId);
      // After this turn's own callers have settled, so the next turn never overlaps them.
      setImmediate(() => {
        for (const fn of this.slotFreedListeners) {
          try {
            fn(agentId);
          } catch (err) {
            logger.warn(
              { agentId, err: String(err) },
              'slot-freed listener failed',
            );
          }
        }
      });
    }
  }

  /** Get recent cycles for an agent. */
  getCycles(agentId: string, limit = 50): AgentCycle[] {
    return getCyclesByAgent(agentId, limit);
  }

  /**
   * After a cycle, scan workspace/handoffs_out.json for outbound handoff declarations.
   * For each, create a DB handoff record and pre-write the recipient's inbox file.
   * Clears the outbox file when done.
   */
  private _dispatchWebhook(
    agent: { id: string; config: AgentConfig },
    event: Record<string, unknown>,
  ): void {
    const url = agent.config.webhookUrl;
    if (!url) return;
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(agent.config.webhookToken
          ? { 'X-Webhook-Token': agent.config.webhookToken }
          : {}),
      },
      body: JSON.stringify({
        ...event,
        agentId: agent.id,
        ts: new Date().toISOString(),
      }),
    }).catch((err) =>
      logger.warn(
        { agentId: agent.id, url, err: err.message },
        'Webhook dispatch failed',
      ),
    );
  }

  private _processOutboundHandoffs(
    agentId: string,
    firedThisRound?: Set<string>,
  ): void {
    const outboxFile = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'workspace',
      'handoffs_out.json',
    );
    if (!fs.existsSync(outboxFile)) return;

    let declarations: Array<{
      to_type: string;
      type: string;
      note?: string;
      data: unknown;
    }>;
    try {
      const raw = fs.readFileSync(outboxFile, 'utf-8');
      declarations = JSON.parse(raw);
      if (!Array.isArray(declarations) || declarations.length === 0) return;
    } catch {
      return; // malformed file — skip silently
    }

    // The sender's own crew only — see crewOf in agent-handoff.ts.
    const allAgents = crewOf(agentId, dbGetAllAgents());

    /**
     * Resolve `to_type` to a specific agent. Strict precedence (no silent collisions):
     *   1. Exact ID match
     *   2. Exact name match (case-sensitive)
     *   3. Exact name match (case-insensitive)
     *   4. Exact type match (e.g. agent type 'researcher')
     * Substring matches are NOT used — they caused silent misrouting when one agent's
     * name was a prefix/substring of another (e.g. "Seeker" inside "Lead Hunter").
     */
    // Shared with the POST /handoffs route — see resolveHandoffTarget in agent-handoff.ts.
    // These were two separate copies and only one knew about roles, which is why fixing it
    // here alone did nothing for the tool-based path.
    const resolveTarget = (raw: string) => resolveHandoffTarget(allAgents, raw);

    for (const decl of declarations) {
      if (!decl.to_type || !decl.type) continue;
      const toAgent = resolveTarget(decl.to_type);
      if (!toAgent) {
        // Loud on purpose. This used to be a bare warn, and a qualified lead handed to a
        // name that didn't resolve simply evaporated: the sending agent reported success,
        // the receiving agent never heard, and nothing in the product said otherwise. The
        // candidate list is logged because without it the next person debugging this cannot
        // see what the target *should* have been.
        logger.error(
          {
            agentId,
            requested: decl.to_type,
            handoffType: decl.type,
            candidates: allAgents.map(
              (a) => `${a.name}(role=${a.config.role ?? '-'},type=${a.type})`,
            ),
          },
          'Handoff target not found — lead DROPPED (no id/name/type/role match)',
        );
        notify(
          'agent_alert',
          'Handoff dropped',
          `${this.getAgent(agentId)?.name ?? agentId} tried to hand off "${decl.type}" to "${decl.to_type}", which matches no agent. The handoff was discarded. Check the target name against the agent's name or role.`,
          agentId,
        );
        continue;
      }

      const payloadStr = JSON.stringify(decl.data ?? {});
      const handoff = createHandoff({
        from_agent_id: agentId,
        to_agent_id: toAgent.id,
        type: decl.type,
        payload: payloadStr,
        note: decl.note,
        status: 'pending',
      });

      const fromAgent = dbGetAgent(agentId);
      if (fromAgent)
        this._dispatchWebhook(fromAgent, {
          type: 'handoff.sent',
          toId: toAgent.id,
          handoffType: decl.type,
        });
      this._dispatchWebhook(toAgent, {
        type: 'handoff.received',
        fromId: agentId,
        handoffType: decl.type,
      });

      // Pre-write inbox file so it's ready before the recipient's next cycle
      const toInbox = path.join(
        DATA_DIR,
        'agents',
        toAgent.id,
        'workspace',
        'inbox',
        `${handoff.id}.json`,
      );
      try {
        fs.mkdirSync(path.dirname(toInbox), { recursive: true });
        fs.writeFileSync(toInbox, payloadStr, 'utf-8');
      } catch {
        /* non-fatal */
      }

      // If recipient is a project agent, fire an immediate cycle so they don't wait for the scheduler.
      // Skip if already fired this round via another path (handoff+pipeline collision).
      const recipientProjects = getAgentProjects(toAgent.id);
      if (recipientProjects.length > 0) {
        if (firedThisRound?.has(toAgent.id)) {
          logger.info(
            { agentId: toAgent.id },
            'Handoff cycle already fired this round (dedupe) — skipping',
          );
          continue;
        }
        firedThisRound?.add(toAgent.id);
        if (!canWake(toAgent, 'handoff')) {
          logger.info(
            { agentId: toAgent.id },
            'Handoff cycle skipped — recipient wake policy has handoff turned off (or it is stopped)',
          );
          continue;
        }
        const senderProjects = getAgentProjects(agentId);
        const sharedProject = senderProjects.find((sp) =>
          recipientProjects.some((rp) => rp.id === sp.id),
        );
        setImmediate(() => {
          this.runCycle(
            toAgent.id,
            'handoff',
            undefined,
            sharedProject?.id,
          ).catch((err) =>
            logger.warn(
              { agentId: toAgent.id, err: err.message },
              'Handoff-triggered cycle failed',
            ),
          );
        });
      }
    }

    // Clear the outbox
    try {
      fs.writeFileSync(outboxFile, '[]', 'utf-8');
    } catch {
      /* non-fatal */
    }
  }

  /**
   * After a cycle, read workspace/messages_out.json written by the agent.
   * Delivers each message to the target agent's inbox and logs it in the DB.
   * Format: [{ to: "Agent Name", subject: "...", body: "..." }]
   */
  private _processOutboundMessages(agentId: string): void {
    const msgsFile = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'workspace',
      'messages_out.json',
    );
    if (!fs.existsSync(msgsFile)) return;

    let entries: Array<{ to: string; subject: string; body: string }>;
    try {
      const raw = fs.readFileSync(msgsFile, 'utf-8');
      entries = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length === 0) {
        fs.unlinkSync(msgsFile);
        return;
      }
    } catch {
      return;
    }

    // The sender's own crew only — see crewOf in agent-handoff.ts.
    const allAgents = crewOf(agentId, dbGetAllAgents());
    const fromAgent = allAgents.find((a) => a.id === agentId);
    const fromName = fromAgent?.name ?? agentId;

    for (const entry of entries) {
      if (!entry.to?.trim() || !entry.body?.trim()) continue;
      const target = entry.to.toLowerCase();
      const toAgent = allAgents.find(
        (a) =>
          a.name.toLowerCase() === target ||
          a.name.toLowerCase().includes(target) ||
          target.includes(a.name.toLowerCase()),
      );
      if (!toAgent) {
        logger.warn(
          { agentId, to: entry.to },
          'Inter-agent message target not found',
        );
        continue;
      }

      const subject = entry.subject?.trim() || '(no subject)';
      const record = createAgentMessage({
        from_agent_id: agentId,
        to_agent_id: toAgent.id,
        subject,
        body: entry.body,
      });

      // Write to target inbox so it's available on next cycle
      const inboxDir = path.join(
        DATA_DIR,
        'agents',
        toAgent.id,
        'workspace',
        'inbox',
      );
      const inboxFile = path.join(inboxDir, `msg-${record.id}.json`);
      try {
        fs.mkdirSync(inboxDir, { recursive: true });
        fs.writeFileSync(
          inboxFile,
          JSON.stringify(
            {
              type: 'agent_message',
              id: record.id,
              from: fromName,
              subject,
              body: entry.body,
              sent_at: record.sent_at,
            },
            null,
            2,
          ),
          'utf-8',
        );
      } catch {
        /* non-fatal */
      }

      logger.info(
        { agentId, toAgentId: toAgent.id, subject },
        'Inter-agent message delivered',
      );
    }

    try {
      fs.unlinkSync(msgsFile);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * After a completed/failed cycle, fire any matching pipeline rules.
   * Each matching pipeline triggers a `runCycle` on the target agent asynchronously.
   */
  private _firePipelines(
    agentId: string,
    cycleType: string,
    status: 'completed' | 'failed',
    summary: string,
    visited: Set<string> = new Set(),
    projectId?: string,
    sourceCycleId?: string,
    firedThisRound?: Set<string>,
  ): void {
    const pipelines = getMatchingPipelines(
      agentId,
      cycleType,
      status,
      projectId,
    );
    if (!pipelines.length) return;

    // Build the visited set for downstream hops (include the current agent)
    const nextVisited = new Set(visited).add(agentId);

    for (const pipe of pipelines) {
      const baseRun = {
        pipeline_id: pipe.id,
        source_cycle_id: sourceCycleId ?? null,
        target_cycle_id: null,
        source_agent_id: agentId,
        source_cycle_type: cycleType,
        source_status: status,
        target_agent_id: pipe.target_agent_id,
        target_cycle_type: pipe.target_cycle_type,
        project_id: projectId ?? null,
        trigger_kind: 'auto' as const,
      };

      if (nextVisited.has(pipe.target_agent_id)) {
        logger.warn(
          { pipelineId: pipe.id, agentId, targetAgentId: pipe.target_agent_id },
          'Pipeline loop detected — skipping to prevent cycle',
        );
        try {
          logPipelineRun({
            ...baseRun,
            status: 'skipped',
            reason: 'loop detected',
          });
        } catch {
          /* non-fatal */
        }
        continue;
      }

      // Dedupe — if a handoff already fired this recipient this round, don't fire again
      if (firedThisRound?.has(pipe.target_agent_id)) {
        logger.info(
          { pipelineId: pipe.id, targetAgentId: pipe.target_agent_id },
          'Pipeline target already fired this round via handoff — skipping (dedupe)',
        );
        try {
          logPipelineRun({
            ...baseRun,
            status: 'skipped',
            reason: 'already fired via handoff',
          });
        } catch {
          /* non-fatal */
        }
        continue;
      }
      firedThisRound?.add(pipe.target_agent_id);

      const tgtAgent = dbGetAgent(pipe.target_agent_id);
      if (!tgtAgent || !canWake(tgtAgent, 'pipeline')) {
        logger.info(
          { pipelineId: pipe.id, targetAgentId: pipe.target_agent_id },
          'Pipeline trigger skipped — target wake policy has pipeline turned off (or it is stopped/missing)',
        );
        try {
          logPipelineRun({
            ...baseRun,
            status: 'skipped',
            reason: 'blocked by wake policy',
          });
        } catch {
          /* non-fatal */
        }
        continue;
      }

      const context = pipe.inject_output
        ? `## Pipeline Trigger\nSource agent completed a "${cycleType}" cycle.\n\nOutput summary:\n${summary}`
        : `## Pipeline Trigger\nSource agent completed a "${cycleType}" cycle.`;

      // Log the fire intent immediately so the audit log records every match
      const run = (() => {
        try {
          return logPipelineRun({ ...baseRun, status: 'fired', reason: null });
        } catch {
          return null;
        }
      })();

      const loopVisited = new Set(nextVisited);
      setImmediate(() => {
        notify(
          'pipeline_fired',
          `Pipeline fired: ${pipe.name}`,
          `Triggered ${pipe.target_cycle_type} cycle on target agent`,
          pipe.target_agent_id,
          { pipelineId: pipe.id, sourceAgentId: agentId },
        );
        const srcAgent = dbGetAgent(agentId);
        if (srcAgent)
          this._dispatchWebhook(srcAgent, {
            type: 'pipeline.fired',
            pipelineId: pipe.id,
            targetId: pipe.target_agent_id,
          });
        if (tgtAgent)
          this._dispatchWebhook(tgtAgent, {
            type: 'pipeline.fired',
            pipelineId: pipe.id,
            sourceId: agentId,
          });
        this.runCycle(
          pipe.target_agent_id,
          pipe.target_cycle_type as CycleType,
          context,
          projectId,
          undefined,
          loopVisited,
        )
          .then((targetCycle) => {
            logger.info(
              { pipelineId: pipe.id, targetAgentId: pipe.target_agent_id },
              'Pipeline trigger completed',
            );
            if (run && targetCycle?.id)
              try {
                updatePipelineRunTarget(run.id, targetCycle.id);
              } catch {
                /* non-fatal */
              }
          })
          .catch((err) => {
            logger.warn(
              { pipelineId: pipe.id, err: err.message },
              'Pipeline trigger failed',
            );
            if (run)
              try {
                logPipelineRun({
                  ...baseRun,
                  status: 'failed',
                  reason: String(err?.message ?? err).slice(0, 240),
                });
              } catch {
                /* non-fatal */
              }
          });
      });
    }
  }

  /** Check whether the agent workspace exists on disk. */
  workspaceExists(agentId: string): boolean {
    return this.workspace.exists(agentId);
  }

  // ─── Episode logging ─────────────────────────────────────────────────────

  /** Write a structured episode log after a completed work cycle. Fire-and-forget. */
  private async writeEpisodeLog(
    agent: Agent,
    cycleId: string,
    cycleType: CycleType,
    result: { summary: string; cost: number; tasksDone: number },
  ): Promise<void> {
    const now = new Date();
    const timestamp = now.toISOString();
    const dateStr = timestamp.split('T')[0];

    const systemPrompt = `You are ${agent.name}. Write a brief, factual episode log for your memory. Be specific.`;
    const userPrompt = `You just completed a ${cycleType.replace('_', ' ')} cycle.

## This cycle:
Summary: ${result.summary}
Cost: $${result.cost.toFixed(4)} | Tasks done: ${result.tasksDone}

Write the episode using this EXACT format:

## Episode: ${timestamp} — ${cycleType.replace('_', ' ')}
Cost: $${result.cost.toFixed(4)} | Tasks: ${result.tasksDone}

### What happened
[2-4 sentences describing what was done and key results]

### What worked
[1-3 specific observations]

### What didn't
[1-2 things that failed, or "None notable"]

### Signals noticed
[Patterns or anomalies, or "None"]`;

    let episodeText: string;
    try {
      episodeText = await callClaude(systemPrompt, userPrompt, 500, agent.id);
    } catch {
      // Fallback template when no API key / error
      episodeText = `## Episode: ${timestamp} — ${cycleType.replace('_', ' ')}
Cost: $${result.cost.toFixed(4)} | Tasks: ${result.tasksDone}

### What happened
${result.summary}

### What worked
None notable

### What didn't
None notable

### Signals noticed
None`;
    }

    // 1. Save to agent_cycles.episode_log
    updateAgentCycle(cycleId, { episode_log: episodeText });

    // 2. Append to daily file workspace/memory/episodes/YYYY-MM-DD.md
    const separator = '\n\n---\n\n';
    this.workspace.appendFile(
      agent.id,
      `workspace/memory/episodes/${dateStr}.md`,
      episodeText + separator,
    );

    // Stage 34 Gap 1 — fast-lane consolidation: tag salient episodes (failures, corrections,
    // rejections) so AgentScheduler can trigger a self_improve run ahead of the weekly timer
    // instead of leaving a significant event inert for up to 6 days. Cheap regex, no LLM call —
    // salience only decides WHEN to distill sooner, the existing extraction LLM call still
    // decides WHAT is actually worth remembering.
    const salienceReason = this._detectSalience(episodeText, result);
    if (salienceReason) {
      try {
        queueFastlane(agent.id, salienceReason);
      } catch (e) {
        logger.warn(
          { agentId: agent.id, err: String(e) },
          'Failed to queue fast-lane consolidation',
        );
      }
    }
  }

  /**
   * Cheap keyword heuristic (no LLM call) for whether an episode is worth consolidating
   * sooner than the weekly self_improve timer (Gap 1). Returns a short reason or null.
   * Deliberately coarse: false positives just mean an extra self_improve run finds nothing
   * new to distill (cheap); false negatives just mean that event waits for the weekly timer
   * like before this feature existed — neither failure mode is expensive.
   */
  private _detectSalience(
    episodeText: string,
    result: { summary: string },
  ): string | null {
    const haystack = `${episodeText}\n${result.summary}`.toLowerCase();
    const SALIENCE_PATTERNS: Array<[RegExp, string]> = [
      [/\breject(ed|ion)?\b/, 'rejection'],
      [/\bcritical\b|\bcrashed?\b|\bbroke\b|\bbroken\b/, 'critical failure'],
      [/\bincorrect\b|\bwrong\b|\bmistake\b/, 'correction'],
      [/\bescalat/, 'escalation'],
      [/\bblocked\b|\bblocker\b/, 'blocker'],
    ];
    for (const [pattern, reason] of SALIENCE_PATTERNS) {
      if (pattern.test(haystack)) return reason;
    }
    return null;
  }

  // ─── Check-in generation ──────────────────────────────────────────────────

  /**
   * Generate a weekly check-in report for the agent.
   * Called internally when cycleType === 'checkin'.
   */
  private async generateCheckinReport(
    agent: Agent,
  ): Promise<{ reportMd: string; cost: number }> {
    const weeklyCycles = getWeeklyCycles(agent.id);
    const recentMemory = getMemoryByAgent(agent.id).slice(0, 10);

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const dateRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // If no episodes: generate a startup check-in
    if (weeklyCycles.length === 0) {
      const identityMd = this.workspace.readFile(agent.id, 'IDENTITY.md') ?? '';
      const coreMatch = identityMd.match(/## CORE([\s\S]*?)(?=## LEARNED|$)/);
      const coreSummary = coreMatch?.[1]?.trim() ?? 'No identity loaded yet.';

      const startupReport = `# Weekly Check-in: ${agent.name}
Period: ${dateRange}

## What I Did
- Just getting started — no completed cycles yet
- Reviewed my mission and identity
- Ready to begin executing on the first work cycle

## Wins
- Successfully provisioned and configured
- Identity and goals are clear

## Observations
- This is my first check-in — establishing baseline

## What's Next
- Run first ${agent.type.replace('_', ' ')} cycle
- Begin tracking metrics from day one

## Questions for You
**Q: Is my current mission description accurate?**
Options: [Yes, looks good] | [Needs some adjustments] | [Let's discuss]

**Q: What's the single most important outcome you want from me this week?**
Options: [Volume — more leads/tasks] | [Quality — fewer but better results] | [Research first]

---
Budget used this period: $0.00 of $${agent.config.budget.monthly} monthly.`;

      return { reportMd: startupReport, cost: 0 };
    }

    // Build episode logs summary
    const episodeSummary = weeklyCycles
      .map((c) => {
        const date = new Date(c.started_at).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
        const tasks = c.tasks_done ? ` (${c.tasks_done} tasks)` : '';
        const summary = c.summary ? ` — ${c.summary}` : '';
        return `- [${date}] ${c.cycle_type.replace('_', ' ')}${tasks}${summary}`;
      })
      .join('\n');

    const memorySummary =
      recentMemory.length > 0
        ? recentMemory.map((m) => `- [${m.type}] ${m.content}`).join('\n')
        : '(no memory entries yet)';

    const identityMd = this.workspace.readFile(agent.id, 'IDENTITY.md') ?? '';
    const coreMatch = identityMd.match(/## CORE([\s\S]*?)(?=## LEARNED|$)/);
    const coreSummary = coreMatch?.[1]?.trim() ?? '';

    const totalCost = weeklyCycles.reduce((s, c) => s + (c.cost ?? 0), 0);

    const systemPrompt = `You are ${agent.name}, a ${agent.type.replace('_', ' ')} agent reporting to your manager.
Write an honest, specific, data-driven weekly check-in. Be concise but informative.
Always include specific numbers where available. The Questions section must have exactly 2-4 questions,
each with 2-3 short option labels separated by | character.`;

    const userPrompt = `## Your work this week:
${episodeSummary}

## Your current knowledge/lessons:
${memorySummary}

## Your mission (CORE):
${coreSummary}

Write the report using this EXACT format:

# Weekly Check-in: ${agent.name}
Period: ${dateRange}

## What I Did
[3-6 bullet points]

## Wins
[Top 2-3 wins with data]

## Observations
[2-3 patterns]

## What's Next
[2-3 focus areas]

## Questions for You
**Q: [question]**
Options: [Option A] | [Option B] | [Option C]

(repeat for 2-4 questions total)

---
Budget used this period: $${totalCost.toFixed(2)} of $${agent.config.budget.monthly} monthly.`;

    // Built up-front rather than inside `catch`, because the common failure is not a
    // thrown error: a thinking model can spend its whole output budget on reasoning and
    // return an empty string, which no catch block would ever see.
    const fallback = `# Weekly Check-in: ${agent.name}
Period: ${dateRange}

## What I Did
${weeklyCycles
  .slice(0, 6)
  .map(
    (c) => `- ${c.cycle_type.replace('_', ' ')}: ${c.summary ?? 'completed'}`,
  )
  .join('\n')}

## Wins
- Completed ${weeklyCycles.length} cycle(s) this week
- Total cost: $${totalCost.toFixed(4)}

## Observations
- Baseline week — gathering data for future pattern analysis

## What's Next
- Continue scheduled ${agent.type.replace('_', ' ')} cycles
- Refine approach based on early results

## Questions for You
**Q: How is my output quality so far?**
Options: [Great, keep going] | [Needs improvement] | [Too early to tell]

**Q: Any priorities to adjust for next week?**
Options: [No changes needed] | [Focus on quality] | [Increase volume]

---
Budget used this period: $${totalCost.toFixed(2)} of $${agent.config.budget.monthly} monthly.`;

    let reportMd: string;
    try {
      // 4000, not 1200: this runs on deepseek-v4-flash via the litellm proxy, and its
      // reasoning pass alone consumed the entire 1200-token budget — every generated
      // check-in came back empty. Measured reasoning use here is ~600-1200 tokens, so
      // the report needs its own headroom on top. Asking the provider to skip thinking
      // (chat_template_kwargs.thinking=false) was tested against prod and ignored.
      reportMd = await callClaude(systemPrompt, userPrompt, 4000, agent.id);
    } catch {
      return { reportMd: fallback, cost: 0 };
    }

    // An unusable report is worth less than the template: the owner sees a real check-in
    // either way, instead of the cycle failing and the week going unreported entirely.
    const missing = missingCheckinSections(reportMd);
    if (missing.length > 0) {
      console.warn(
        `[checkin] ${agent.name}: generated report unusable (${
          reportMd.trim() ? `missing ${missing.join(', ')}` : 'empty output'
        }) — falling back to template`,
      );
      return { reportMd: fallback, cost: 0.002 };
    }

    return { reportMd, cost: 0.002 };
  }

  // ─── Feedback processing ─────────────────────────────────────────────────

  /**
   * Process user feedback from a check-in response.
   * Extracts actionable changes, updates IDENTITY.md LEARNED section, logs memory.
   */
  async processFeedback(
    agentId: string,
    checkinId: string,
    userReply: string,
    actionPayloadOverride?: string,
  ): Promise<void> {
    const agent = dbGetAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const checkin = getCheckinById(checkinId);
    if (!checkin) throw new Error(`Check-in ${checkinId} not found`);

    // Mark checkin as responded
    const now = new Date().toISOString();
    updateAgentCheckin(checkinId, {
      status: 'responded',
      user_reply: userReply,
      responded_at: now,
    });

    // ── HITL layer (action-gated check-in) — conversational, not fire-and-forget ──
    // The agent's turn already ended when it requested approval; we resume it with a
    // follow-up turn carrying the user's decision so it acknowledges / revises in chat.
    if (checkin.action_type) {
      const { decision, note } = this._parseDecision(userReply);
      const brief = checkin.report_md
        ? ` ("${this._brief(checkin.report_md)}")`
        : '';

      if (decision === 'approve') {
        const payloadStr = actionPayloadOverride ?? checkin.action_payload;
        let actionResult = 'The approved action was executed.';
        if (payloadStr) {
          try {
            await this._fireCheckinAction(
              checkin.action_type,
              JSON.parse(payloadStr),
              agent.owner_id ?? undefined,
              agentId,
            );
          } catch (err: any) {
            logger.error(
              `[HITL] Action failed for checkin ${checkinId}: ${err.message}`,
            );
            actionResult = `The action FAILED to execute: ${err.message}.`;
          }
        }
        recordMemory(agentId, {
          type: 'lesson',
          content: `HITL approved on ${now.split('T')[0]}: ${checkin.action_type}`,
          relevance: 0.3,
        });
        this._kickHitlFollowup(
          agentId,
          `[Approval result] The user APPROVED your pending request${brief}. ${actionResult}${note ? ` They also said: "${note}".` : ''}\n\nReply briefly in chat confirming what is now done, and handle anything they added. Do NOT re-request approval for what was just approved.`,
        );
        return;
      }

      if (decision === 'reject') {
        await this._onCheckinRejected(
          checkin.action_type,
          checkin.action_payload,
          note,
        );
        recordMemory(agentId, {
          type: 'lesson',
          content: `HITL rejected on ${now.split('T')[0]}: ${checkin.action_type}${note ? ` — ${note}` : ''}`,
          relevance: 0.6,
        });
        this._kickHitlFollowup(
          agentId,
          `[Approval result] The user REJECTED your pending request${brief}. ${note ? `Their feedback: "${note}".` : 'No reason was given.'}\n\nAcknowledge in chat, then revise your proposal based on their feedback. If it makes sense, request approval again with the changes — otherwise ask a clarifying question. Do NOT execute the original action.`,
        );
        return;
      }

      // Free-text comment — neither a clear approve nor reject. Engage, but don't fire.
      recordMemory(agentId, {
        type: 'lesson',
        content: `HITL comment on ${now.split('T')[0]}: ${userReply.slice(0, 200)}`,
        relevance: 0.5,
      });
      this._kickHitlFollowup(
        agentId,
        `[Approval discussion] On your pending request${brief}, the user said: "${userReply}".\n\nThis is not a clear approve or reject. Respond in chat — answer their question or adjust your proposal — but do NOT execute the action until they explicitly approve.`,
      );
      return;
    }

    // Quick-pass: a bare approval carries no instruction, so there is nothing to learn
    // from it and IDENTITY.md should not grow a section.
    //
    // This used to match three literal strings — 'all good', 'looks good', 'approved' —
    // while the Approve button sends 'approve'. One letter out, so every bare Approve on a
    // weekly check-in fell through to the extraction path below and wrote "Manager
    // feedback: approve" into IDENTITY.md as a LEARNED entry plus a 0.9-relevance memory.
    // At 0.9 that outranks almost everything real the agent knows. Now the same decision
    // parser the HITL path uses decides this, so 'approve'/'yes'/'ok'/'lgtm' all shortcut.
    //
    // A bare *reject* shortcuts for the same reason, and it is the worse case: asked to
    // extract "2-5 bullet points of specific changes" from the single word "reject", the
    // model invents plausible ones. On 2026-08-14 that produced "Tighten lead qualification
    // criteria / Add a self-verification step / Refine search targeting" — none of it said
    // by anyone — written into Finder's IDENTITY.md and memory at relevance 0.9. A decision
    // with no note is a decision, not feedback; there is nothing to summarise.
    const trimmed = userReply.toLowerCase().trim();
    const { decision, note } = this._parseDecision(userReply);
    if (
      trimmed === 'all good' ||
      trimmed === 'looks good' ||
      (decision !== 'comment' && !note)
    ) {
      recordMemory(agentId, {
        type: 'lesson',
        content:
          decision === 'reject'
            ? `Manager check-in on ${now.split('T')[0]}: report rejected with no reason given.`
            : `Manager check-in on ${now.split('T')[0]}: No changes needed. Continue as planned.`,
        relevance: 0.5,
      });
      return;
    }

    // Extract changes via Claude (best-effort). Feed it the note rather than the raw reply,
    // so a leading "approve — " is not mistaken for part of the instruction.
    //
    // 2026-08-16: forcing "2-5 bullet points... be specific" on a one-sentence note invited
    // the model to pad — a manager reply that made exactly one point (fix volume, don't drop
    // quality) came back with five, including "broaden industries/regions/company sizes",
    // which nobody said and which directly contradicted a still-live instruction two entries
    // above it in the same IDENTITY.md ("do not loosen the ICP"). This is the same failure
    // shape as the 2026-08-14 bare-reject hallucination the shortcut above already guards
    // against — here the note was real, so the shortcut didn't apply, and the extraction
    // prompt itself was the thing inventing content. Fixed at the source: no bullet-count
    // floor, and an explicit ban on adding anything not actually said.
    const feedbackText = decision === 'comment' ? userReply : note || userReply;
    let changesSummary = feedbackText;
    try {
      const { text: extracted, truncated } = await callClaudeChecked(
        'You extract actionable changes from manager feedback for an AI agent. Restate only what the manager actually said, as short bullet points — one bullet per distinct point they made. Never add implementation ideas, tactics, examples, or specifics they did not mention, even if they would plausibly follow. If they made one point, output one bullet.',
        `Agent: ${agent.name} (${agent.type})\nFeedback: ${feedbackText}\n\nList the distinct points in this feedback as bullets (as few or as many as the feedback actually contains — do not pad to reach a target count, do not invent points).`,
        1200,
        agent.id,
      );
      // A cut-off summary is worse than no summary: the manager's own words are already
      // complete, so fall back to them rather than persisting half a sentence as doctrine.
      if (truncated || !extracted.trim()) {
        logger.warn(
          { agentId, truncated },
          'Check-in feedback extraction unusable — storing the raw note instead',
        );
        changesSummary = feedbackText;
      } else {
        changesSummary = extracted;
      }

      // Update IDENTITY.md LEARNED section
      const currentIdentity =
        this.workspace.readFile(agentId, 'IDENTITY.md') ?? '';
      const learnedMatch = currentIdentity.match(/## LEARNED\nVersion: (\d+)/);
      const currentVersion = learnedMatch
        ? parseInt(learnedMatch[1])
        : agent.identity_version;
      const newVersion = currentVersion + 1;

      const dateStr = now.split('T')[0];
      const learnedEntry = `\n\n### Feedback — ${dateStr}\n${changesSummary}`;

      let updatedIdentity: string;
      if (currentIdentity.includes('## LEARNED')) {
        updatedIdentity =
          currentIdentity.replace(
            /## LEARNED\nVersion: \d+/,
            `## LEARNED\nVersion: ${newVersion}`,
          ) + learnedEntry;
      } else {
        updatedIdentity =
          currentIdentity +
          `\n\n## LEARNED\nVersion: ${newVersion}${learnedEntry}`;
      }

      this.workspace.archiveIdentityVersion(agentId, currentVersion);
      this.workspace.writeFile(agentId, 'IDENTITY.md', updatedIdentity);
      updateAgentIdentityVersion(agentId, newVersion);
    } catch {
      /* silent — still log memory */
    }

    // Log lesson memory entry (single write path: DB + view refresh)
    recordMemory(agentId, {
      type: 'lesson',
      content: `Manager feedback on ${now.split('T')[0]}: ${changesSummary.substring(0, 500)}`,
      relevance: 0.9,
    });
  }

  /**
   * Decide several action-gated check-ins at once.
   *
   * Not a loop over `processFeedback`. That kicks a follow-up cycle per check-in, so
   * approving a morning's drafts would start N cycles on the same agent at the same
   * moment, all writing the same workspace files. Here the actions fire **sequentially**
   * — one send at a time, in the order given, which is also what a mail host wants —
   * and the whole batch resumes the agent in a **single** follow-up turn.
   *
   * Per-item failures never abort the batch: a mailbox that rejects one address should
   * not strand the other nine drafts as pending forever. Each result is reported back
   * and the agent is told which ones failed.
   */
  async processFeedbackBatch(
    agentId: string,
    checkinIds: string[],
    userReply: string,
  ): Promise<{ id: string; ok: boolean; error?: string }[]> {
    const agent = dbGetAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const { decision, note } = this._parseDecision(userReply);
    const now = new Date().toISOString();
    const results: { id: string; ok: boolean; error?: string }[] = [];
    const briefs: string[] = [];

    for (const checkinId of checkinIds) {
      const checkin = getCheckinById(checkinId);
      if (!checkin || checkin.agent_id !== agentId) {
        results.push({ id: checkinId, ok: false, error: 'not found' });
        continue;
      }
      if (checkin.status === 'responded') {
        results.push({ id: checkinId, ok: false, error: 'already responded' });
        continue;
      }

      updateAgentCheckin(checkinId, {
        status: 'responded',
        user_reply: userReply,
        responded_at: now,
      });
      briefs.push(
        this._brief(checkin.report_md ?? '') || checkinId.slice(0, 8),
      );
      if (decision === 'reject')
        await this._onCheckinRejected(
          checkin.action_type,
          checkin.action_payload,
          userReply,
        );

      if (
        decision === 'approve' &&
        checkin.action_type &&
        checkin.action_payload
      ) {
        try {
          await this._fireCheckinAction(
            checkin.action_type,
            JSON.parse(checkin.action_payload),
            agent.owner_id ?? undefined,
            agentId,
          );
          results.push({ id: checkinId, ok: true });
        } catch (err: any) {
          logger.error(
            `[HITL] Batch action failed for checkin ${checkinId}: ${err.message}`,
          );
          results.push({
            id: checkinId,
            ok: false,
            error: String(err?.message ?? err),
          });
        }
      } else {
        results.push({ id: checkinId, ok: true });
      }
    }

    const done = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (done === 0 && failed.length === 0) return results;

    // Nothing landed — every id was stale, already answered, or its action threw. Resuming
    // the agent here would tell it to "confirm what is now done" and "update your records"
    // about work that did not happen, which is how a cycle invents a send it never made.
    // The caller still gets the per-item errors; the agent is simply not woken for them.
    if (done === 0) {
      logger.warn(
        { agentId, failed },
        '[HITL] Batch decided nothing — no follow-up cycle kicked',
      );
      return results;
    }

    recordMemory(agentId, {
      type: 'lesson',
      content: `HITL batch ${decision} on ${now.split('T')[0]}: ${done} item(s)${failed.length ? `, ${failed.length} failed` : ''}`,
      relevance: decision === 'reject' ? 0.6 : 0.3,
    });

    const failLine = failed.length
      ? ` ${failed.length} did NOT go through: ${failed.map((f) => `${f.id.slice(0, 8)} (${f.error})`).join('; ')}.`
      : '';

    if (decision === 'approve') {
      this._kickHitlFollowup(
        agentId,
        `[Approval result] The user APPROVED ${done} pending request(s) in one batch: ${briefs.join('; ')}.` +
          ` The approved actions were executed.${failLine}${note ? ` They also said: "${note}".` : ''}` +
          `\n\nReply briefly in chat confirming what is now done, and update your records for ALL of them.` +
          ` Do NOT re-request approval for what was just approved.`,
      );
    } else if (decision === 'reject') {
      this._kickHitlFollowup(
        agentId,
        `[Approval result] The user REJECTED ${done} pending request(s) in one batch: ${briefs.join('; ')}.` +
          `${note ? ` Their feedback: "${note}".` : ' No reason was given.'}` +
          `\n\nAcknowledge in chat and revise. Do NOT execute the original actions.`,
      );
    } else {
      this._kickHitlFollowup(
        agentId,
        `[Approval discussion] On ${done} pending request(s) (${briefs.join('; ')}) the user said: "${userReply}".` +
          `\n\nThis is not a clear approve or reject. Respond in chat — do NOT execute the actions until they explicitly approve.`,
      );
    }

    return results;
  }

  // ─── HITL helpers ────────────────────────────────────────────────────────────

  /** Classify a HITL reply into approve / reject / comment and split off any free-text note. */
  /**
   * Approve a just-created check-in on the owner's behalf, because one of their approval
   * rules says this action needs no asking.
   *
   * Runs the same executor as the Approve button, so an auto-approved email is sent exactly
   * the way a clicked one is. Unlike processFeedback it starts no follow-up cycle: the
   * agent's tool call is still waiting on the response and hears the outcome there — a
   * follow-up run per email would have cost a whole cycle for every send.
   */
  async autoApproveCheckin(
    agentId: string,
    checkinId: string,
    ruleLabel: string,
  ): Promise<{ ok: boolean; result: string }> {
    const agent = dbGetAgent(agentId);
    const checkin = getCheckinById(checkinId);
    if (!agent || !checkin?.action_type)
      return { ok: false, result: 'Nothing to approve' };
    updateAgentCheckin(checkinId, {
      status: 'responded',
      user_reply: `approve — auto-approved by your rule: ${ruleLabel}`,
      responded_at: new Date().toISOString(),
    });
    try {
      await this._fireCheckinAction(
        checkin.action_type,
        JSON.parse(checkin.action_payload ?? '{}'),
        agent.owner_id ?? undefined,
        agentId,
      );
      return {
        ok: true,
        result:
          "Done — approved automatically by your owner's rule and executed.",
      };
    } catch (err: any) {
      logger.error(
        `[HITL] auto-approved action failed for checkin ${checkinId}: ${err.message}`,
      );
      return {
        ok: false,
        result: `Approved by rule, but it FAILED to execute: ${err.message}`,
      };
    }
  }

  /**
   * Most rejected actions simply never happen. A held run is different: it exists, waiting,
   * and a rejection must cancel it rather than leave it parked forever.
   */
  private async _onCheckinRejected(
    actionType: string | null | undefined,
    payloadStr: string | null | undefined,
    note: string,
  ): Promise<void> {
    if (actionType !== 'run_plan') return;
    try {
      const { getSwarmEngine } = await import('../swarm/service.js');
      const runId = String(
        (JSON.parse(payloadStr ?? '{}') as { runId?: unknown }).runId ?? '',
      );
      getSwarmEngine().rejectPlan(runId, note);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not cancel a rejected run plan',
      );
    }
  }

  private _parseDecision(reply: string): {
    decision: 'approve' | 'reject' | 'comment';
    note: string;
  } {
    const raw = (reply ?? '').trim();
    const firstWord = raw.toLowerCase().split(/[\s,:.;—–-]+/)[0];
    const approveWords = new Set([
      'approve',
      'approved',
      'yes',
      'send',
      'ok',
      'okay',
      'go',
      'accept',
      'accepted',
      'lgtm',
    ]);
    const rejectWords = new Set([
      'reject',
      'rejected',
      'no',
      'nope',
      'deny',
      'denied',
      'decline',
      'declined',
      'cancel',
      'stop',
    ]);
    let decision: 'approve' | 'reject' | 'comment' = 'comment';
    if (approveWords.has(firstWord)) decision = 'approve';
    else if (rejectWords.has(firstWord)) decision = 'reject';
    let note = raw;
    if (decision !== 'comment') {
      note = raw
        .replace(new RegExp(`^${firstWord}[\\s,:.;—–-]*`, 'i'), '')
        .trim();
    }
    return { decision, note };
  }

  /** Shorten a block of text for inclusion in a follow-up prompt. */
  private _brief(s: string): string {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 160 ? t.slice(0, 160) + '…' : t;
  }

  /** Resume the agent with a follow-up turn after a HITL decision. Fire-and-forget so the
   *  HTTP respond handler returns immediately; the reply streams into the agent's chat. */
  private _kickHitlFollowup(agentId: string, context: string): void {
    void this._runFollowupWhenFree(agentId, context);
  }

  /**
   * Run the follow-up turn, waiting for the agent to be free rather than giving up.
   *
   * `runCycle` refuses a concurrent cycle, and this used to be a bare `.catch` that logged
   * a warning and dropped the turn. The action itself has already happened by then — the
   * send is awaited before this is called — so what got dropped was only the bookkeeping:
   * the turn that records what went out. On 2026-08-14 two batches decided 12 seconds apart,
   * the second collided with the first, and six emails that the mailer had genuinely sent
   * stayed marked `pending-approval` in the agent's own outbox. Nothing looked broken; the
   * agent simply believed it still had drafts to send, to people it had already mailed.
   *
   * Retrying is the right shape because the blocker is always temporary — a cycle in flight
   * finishes. Bounded so a wedged cycle cannot leave a timer running forever. Still in
   * memory only: a process restart loses queued follow-ups, which is why the recorded state
   * should never be the only evidence that something was sent.
   */
  private async _runFollowupWhenFree(
    agentId: string,
    context: string,
    attempt = 0,
  ): Promise<void> {
    const MAX_ATTEMPTS = 20;
    const RETRY_MS = 30_000;
    try {
      await this.runCycle(agentId, 'custom', context);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/already running a cycle/i.test(msg) && attempt < MAX_ATTEMPTS) {
        logger.info(
          { agentId, attempt: attempt + 1 },
          'HITL follow-up deferred — agent busy, will retry',
        );
        setTimeout(() => {
          void this._runFollowupWhenFree(agentId, context, attempt + 1);
        }, RETRY_MS);
        return;
      }
      logger.warn(
        { agentId, attempt, err: msg },
        'HITL follow-up cycle failed — records may be unrecorded',
      );
    }
  }

  private async _fireCheckinAction(
    actionType: string,
    payload: Record<string, any>,
    ownerId?: string,
    sourceAgentId?: string,
  ): Promise<void> {
    if (actionType === 'run_plan') {
      // Stage 57 phase 5 — a delegated run over $1, held until its owner approved the plan.
      const { getSwarmEngine } = await import('../swarm/service.js');
      if (!getSwarmEngine().approvePlan(String(payload.runId ?? ''))) {
        throw new Error('that run is no longer waiting for approval');
      }
      return;
    }
    if (actionType === 'send_email') {
      await this._gmailSend(
        payload as {
          to: string;
          subject: string;
          body: string;
          thread_id?: string;
          lead_key?: string;
          business?: string;
        },
        sourceAgentId,
      );
    } else if (actionType === 'smtp_send') {
      if (!sourceAgentId) throw new Error('smtp_send: sourceAgentId required');
      await this._smtpSendForAgent(
        sourceAgentId,
        payload as { to: string; subject: string; body: string },
      );
    } else if (actionType === 'create_agent') {
      await this._createAgentFromSpec(payload, ownerId, sourceAgentId);
    } else if (actionType === 'send_message') {
      // Phase 3b — a dynamic tool's host.send_message, approved by the operator: deliver it.
      const text = String(payload.text ?? '').trim();
      const agentId = String(payload.agentId ?? '');
      if (text) {
        const agentName =
          (agentId && this.getAgent(agentId)?.name) || 'your agent';
        notify(
          'agent_alert',
          `Message from ${agentName}`,
          text,
          agentId || null,
        );
      }
    } else if (actionType === 'self_change') {
      // Stage 54 phase 2 — a self-management change the agent was not allowed to apply
      // unsupervised. The payload carries the config patch exactly as the route built it,
      // so approving here produces the same result the agent would have got directly.
      const targetId = String(payload.agentId ?? sourceAgentId ?? '');
      const grant = String(payload.grant ?? 'unknown');
      if (!targetId) throw new Error('self_change: agentId required');

      // A credential request carries no patch and never could: approving it means the
      // OWNER connects the service in settings, which is a different action in a
      // different place. Record the decision and tell them what to do next rather than
      // failing an approval they legitimately gave.
      const credentialRequest = payload.credentialRequest as string | undefined;
      if (credentialRequest) {
        notify(
          'agent_alert',
          `Connect ${credentialRequest} to finish this`,
          `You approved ${this.getAgent(targetId)?.name ?? 'an agent'}'s request for ` +
            `${credentialRequest}. Nothing was granted automatically — add the credential in the ` +
            `agent's Secrets tab and it will resolve on its next cycle.`,
          targetId,
        );
        recordConfigAudit({
          agentId: targetId,
          capability: 'credentials',
          actor: 'owner',
          before: { requested: credentialRequest, granted: false },
          after: {
            requested: credentialRequest,
            granted: 'owner must connect it in settings',
          },
          reason:
            'Owner approved the request; the credential itself is added by hand',
        });
        return;
      }

      // Held changes that are not config. Each used to fall through to the `patch` check
      // below and throw, so approving a tracker-stage removal failed and applied nothing.
      if (payload.trackerSchema) {
        const schema = payload.trackerSchema as Parameters<
          typeof upsertEntitySchema
        >[1];
        upsertEntitySchema(targetId, schema);
        recordConfigAudit({
          agentId: targetId,
          capability: 'tracker',
          actor: 'owner',
          before: null,
          after: {
            name: schema.name,
            stages: schema.stages,
            fields: schema.fields,
          },
          reason: 'Approved by owner: tracker change requested by the agent',
        });
        return;
      }
      const patch = payload.patch as Record<string, unknown> | undefined;
      if (!patch || typeof patch !== 'object')
        throw new Error('self_change: patch required');

      // Snapshot exactly the keys being changed. This recorded goals/role/systemPrompt for
      // every grant, so an approved budget raise showed no before/after at all, and the
      // `systemPrompt` key was not one the revert route can write back.
      const pick = (cfg: AgentConfig | undefined) =>
        cfg
          ? Object.fromEntries(
              Object.keys(patch).map((k) => [
                k,
                (cfg as unknown as Record<string, unknown>)[k] ?? null,
              ]),
            )
          : null;
      const before = pick(this.getAgent(targetId)?.config);
      await this.updateAgent(targetId, {
        config: patch as unknown as AgentConfig,
      });
      recordConfigAudit({
        agentId: targetId,
        capability: grant,
        actor: 'owner',
        before,
        after: pick(this.getAgent(targetId)?.config),
        reason: `Approved by owner: ${grant} change requested by the agent`,
      });
    } else if (actionType === 'handoff') {
      // A sidecar tool's host.handoff, approved by the operator → deliver the handoff.
      await this._deliverHostHandoff(payload);
    } else {
      logger.warn(`[HITL] Unknown action type: ${actionType}`);
    }
  }

  /**
   * Send an approved smtp_send draft using the AGENT'S OWN mailbox secrets.
   *
   * Deliberately not routed through mailer.ts's sendPlainTextMail: that reads the platform's
   * global EMAIL_SERVER_* config, so it would send as AxonCrew. These credentials come from
   * the agent's own Secrets tab (a personal mailbox connected by app password), and sending
   * as the wrong identity is worse than not sending.
   *
   * This is the only place an smtp_send email is actually transmitted — the in-container tool
   * only queues a check-in. Both the daily cap and the config check are re-evaluated here
   * rather than trusted from queue time: the draft may have sat pending for hours, and the
   * agent could have queued several before any were approved.
   */
  private async _smtpSendForAgent(
    agentId: string,
    payload: { to: string; subject: string; body: string },
  ): Promise<void> {
    const to = String(payload.to ?? '').trim();
    const subject = String(payload.subject ?? '');
    const body = String(payload.body ?? '');
    if (!to || !body) throw new Error('smtp_send: to and body required');

    const ownerId = dbGetAgent(agentId)?.owner_id ?? undefined;
    const secrets = secretsManager.getAll(agentId, ownerId);
    const host = secrets.EMAIL_SERVER_HOST;
    const user = secrets.EMAIL_SERVER_USER;
    const pass = secrets.EMAIL_SERVER_PASSWORD;
    const from = secrets.EMAIL_FROM || user;
    if (!host || !user || !pass) {
      throw new Error(
        "smtp_send: mailbox not configured in this agent's Secrets tab",
      );
    }
    const port = Number(secrets.EMAIL_SERVER_PORT) || 465;

    // Same ledger the agent reads for its own quota accounting — agent root, not workspace/.
    const sentFile = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'outbox',
      'sent.jsonl',
    );
    const today = new Date().toISOString().slice(0, 10);
    let sentToday = 0;
    try {
      for (const line of fs.readFileSync(sentFile, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          if (String(JSON.parse(line).sentAt ?? '').startsWith(today))
            sentToday++;
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      /* no ledger yet — nothing sent */
    }
    if (sentToday >= SMTP_SEND_DAILY_LIMIT) {
      throw new Error(
        `smtp_send: daily limit of ${SMTP_SEND_DAILY_LIMIT} reached (${sentToday} sent today)`,
      );
    }

    const tx = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    const info = await tx.sendMail({ from, to, subject, text: body });
    const messageId = String(info?.messageId ?? '');
    logger.info(
      { agentId, to, subject, messageId },
      '[smtp_send] approved email sent',
    );

    // Bookkeeping must never fail a delivered email — but it must also never claim a send
    // that did not happen, so it is written only after sendMail resolves.
    try {
      fs.mkdirSync(path.dirname(sentFile), { recursive: true });
      fs.appendFileSync(
        sentFile,
        JSON.stringify({
          sent: true,
          to,
          subject,
          from,
          messageId,
          sentAt: new Date().toISOString(),
          approved: true,
        }) + '\n',
        'utf-8',
      );
    } catch (err) {
      logger.warn(
        { agentId, err: String(err) },
        '[smtp_send] sent, but failed to record in sent.jsonl',
      );
    }
  }

  /**
   * Deliver a HITL-approved handoff from a sidecar tool's host.handoff. Resolves the
   * target by exact id or name (no fuzzy match), creates the handoff record, pre-writes
   * the recipient's inbox, and fires their cycle if they're a project agent — mirroring
   * the cycle-driven handoff path (_processHandoffs).
   */
  private async _deliverHostHandoff(
    payload: Record<string, any>,
  ): Promise<void> {
    const fromAgentId = String(payload.fromAgentId ?? '');
    const rawTarget = String(payload.toAgent ?? '').trim();
    const type = String(payload.type ?? '').trim();
    if (!fromAgentId || !rawTarget || !type)
      throw new Error('handoff: fromAgentId, toAgent and type required');

    const lower = rawTarget.toLowerCase();
    // The sender's own crew only — see crewOf in agent-handoff.ts.
    const all = crewOf(fromAgentId, this.getAllAgents());
    const toAgent =
      all.find((a) => a.id === rawTarget) ||
      all.find((a) => a.name === rawTarget) ||
      all.find((a) => a.name.toLowerCase() === lower);
    if (!toAgent)
      throw new Error(
        `handoff: target agent not found (no exact id/name match for '${rawTarget}')`,
      );

    const payloadStr = JSON.stringify(payload.payload ?? {});
    const handoff = createHandoff({
      from_agent_id: fromAgentId,
      to_agent_id: toAgent.id,
      type,
      payload: payloadStr,
      note: String(payload.note ?? '') || undefined,
      status: 'pending',
    });

    const fromAgent = dbGetAgent(fromAgentId);
    if (fromAgent)
      this._dispatchWebhook(fromAgent, {
        type: 'handoff.sent',
        toId: toAgent.id,
        handoffType: type,
      });
    this._dispatchWebhook(toAgent, {
      type: 'handoff.received',
      fromId: fromAgentId,
      handoffType: type,
    });

    const toInbox = path.join(
      DATA_DIR,
      'agents',
      toAgent.id,
      'workspace',
      'inbox',
      `${handoff.id}.json`,
    );
    try {
      fs.mkdirSync(path.dirname(toInbox), { recursive: true });
      fs.writeFileSync(toInbox, payloadStr, 'utf-8');
    } catch {
      /* non-fatal */
    }

    const recipientProjects = getAgentProjects(toAgent.id);
    if (recipientProjects.length > 0 && canWake(toAgent, 'handoff')) {
      const senderProjects = getAgentProjects(fromAgentId);
      const sharedProject = senderProjects.find((sp) =>
        recipientProjects.some((rp) => rp.id === sp.id),
      );
      setImmediate(() => {
        this.runCycle(
          toAgent.id,
          'handoff',
          undefined,
          sharedProject?.id,
        ).catch((err) =>
          logger.warn(
            { agentId: toAgent.id, err: err.message },
            'Host-handoff-triggered cycle failed',
          ),
        );
      });
    } else if (recipientProjects.length > 0) {
      logger.info(
        { agentId: toAgent.id },
        'Host-handoff cycle skipped — recipient wake policy has handoff turned off (or it is stopped)',
      );
    }
    logger.info(
      { fromAgentId, toAgent: toAgent.id, type },
      'HITL handoff delivered',
    );
  }

  // C2: sync the agent's tracked/<Entity>.json into the durable tracked_items store
  // (deduped by the schema's key field), so it becomes authoritative, queryable, and
  // read back into the next cycle. No-op for agents without a tracker schema.
  private _syncTrackedItems(agentId: string): void {
    const schema = getEntitySchema(agentId);
    if (!schema) return;
    const keyField = schema.fields?.[0]?.key;
    if (!keyField) return;
    const file = path.join(
      DATA_DIR,
      'agents',
      agentId,
      'workspace',
      'tracked',
      `${schema.namePlural}.json`,
    );
    if (!fs.existsSync(file)) return;
    let items: any[];
    try {
      items = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return;
    }
    if (!Array.isArray(items)) return;

    // A row can re-enter the file under a different item_key than the one it was first
    // synced under — the agent generates item_key as a readable slug, not a stable id, so
    // re-wording a role title on a later sweep silently produces a "new" row for a posting
    // already tracked. Fold it back into the original row by matched_post_url instead.
    const urlIndex = buildTrackedUrlIndex(agentId, schema.namePlural);

    let synced = 0;
    let deduped = 0;
    let missingKey = 0;
    for (const it of items) {
      const data =
        it && typeof it === 'object' && it.data && typeof it.data === 'object'
          ? it.data
          : it;
      let itemKey = String(data?.[keyField] ?? '').trim();
      if (!itemKey) {
        missingKey++;
        continue;
      }
      const url =
        typeof data?.matched_post_url === 'string'
          ? data.matched_post_url.trim()
          : '';
      if (url) {
        const canonicalKey = urlIndex.get(url);
        if (canonicalKey && canonicalKey !== itemKey) {
          itemKey = canonicalKey;
          deduped++;
        } else if (!canonicalKey) urlIndex.set(url, itemKey);
      }
      const stage = (it?.stage ?? data?.stage ?? null) as string | null;
      try {
        upsertTrackedItem(
          agentId,
          schema.namePlural,
          itemKey,
          stage,
          data,
          'cycle',
        );
        synced++;
      } catch {
        /* skip bad row */
      }
    }
    if (synced)
      logger.info(
        `[tracked] synced ${synced} ${schema.namePlural} item(s) for ${agentId}`,
      );
    if (deduped) {
      logger.info(
        { agentId, entity: schema.namePlural, deduped },
        `[tracked] ${deduped} row(s) re-discovered under a new item_key were folded back into their original row by matched_post_url`,
      );
    }
    // A row whose key field is empty is unsyncable, and skipping it silently is how the
    // file and the table drift apart while every cycle still reports success: the JSON
    // keeps growing, the board stays frozen, and nothing anywhere says why. Seen for real
    // on 2026-08-08 — 18 rows written under the *documented* field name rather than the
    // key field's actual name, invisible until the two counts were compared by hand.
    if (missingKey) {
      logger.warn(
        { agentId, entity: schema.namePlural, keyField, missingKey, synced },
        `[tracked] ${missingKey} row(s) have no '${keyField}' and cannot sync — they exist in the JSON but will never reach the tracker`,
      );
    }
  }

  // Stage 20 Phase 3 — provision a new agent from a hiring-agent spec on approval.
  // Fills sensible defaults so a minimal conversational spec yields a valid agent.
  // `sourceAgentId` is the agent whose cycle raised the request_approval call (e.g. the
  // Recruiter) — needed so seed_files (below) knows whose workspace to copy files from.
  private async _createAgentFromSpec(
    spec: Record<string, any>,
    ownerId?: string,
    sourceAgentId?: string,
  ): Promise<void> {
    const name = String(spec.name ?? '').trim();
    if (!name) throw new Error('create_agent: name is required');

    const triggerMode = (spec.trigger_mode ??
      spec.triggerMode ??
      'on_demand') as 'scheduled' | 'on_demand';
    const interval = String(spec.schedule_interval ?? spec.interval ?? '24h');
    const tools: string[] = Array.isArray(spec.tools) ? spec.tools : [];
    const mission = String(spec.mission ?? spec.goals ?? '').trim();
    const role =
      typeof spec.role === 'string' && spec.role.trim()
        ? spec.role.trim()
        : undefined;

    // Expertise tags — accept array or comma-separated string; merge with any personality.expertise.
    const rawExpertise = spec.expertise ?? spec.personality?.expertise;
    let expertise = (
      Array.isArray(rawExpertise)
        ? rawExpertise
        : typeof rawExpertise === 'string'
          ? rawExpertise.split(',')
          : []
    )
      .map((s: any) => String(s).trim())
      .filter(Boolean)
      .slice(0, 12);
    // Fallback so this never ships empty even if the proposer omits it entirely (soft
    // prompt adherence isn't reliable) — derive coarse tags from role/mission instead.
    if (expertise.length === 0) {
      const source = role || mission || name;
      const words = source
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !EXPERTISE_STOPWORDS.has(w));
      expertise = [...new Set(words)].slice(0, 3);
    }

    // Tool-name check — warn (never silently drop) on names not in the known catalog.
    // The catalog is a hand-maintained mirror of the Python tool registry and can drift
    // (url_check/github_api/search_crew_memory/save_skill were all missing from it until
    // this fix) — rejecting outright risks breaking a legitimate tool the catalog just
    // hasn't caught up with. Unknown names are still logged so a real typo doesn't
    // silently vanish into a config no one checks.
    const knownToolNames = new Set(CYCLE_BUILTINS.map((t) => t.name));
    const unknownTools = tools.filter((t) => !knownToolNames.has(t));
    if (unknownTools.length) {
      logger.warn(
        `[HITL] "${name}" proposed with unrecognized tool name(s), kept as-is: ${unknownTools.join(', ')}`,
      );
    }

    // Dedicated workspace dirs — accept [{name,description}] or ["name"]; sanitize names.
    // A name may arrive as a bare "scrapybaby" or as the full in-container path an agent
    // uses to describe its own workspace ("/workspace/group/workspace/scrapybaby") — take
    // the last path segment either way. Slugifying the whole string used to turn a path
    // into one garbage directory ("workspace-group-workspace-scrapybaby") instead of the
    // folder it named (found 2026-08-17, same root cause as sanitiseWorkspacePath above).
    const rawDirs = Array.isArray(spec.workspace_dirs)
      ? spec.workspace_dirs
      : [];
    const customWorkspaceDirs = rawDirs
      .map((d: any) => {
        const rawName = typeof d === 'string' ? d : d?.name;
        const segments = String(rawName ?? '')
          .split(/[\\/]+/)
          .filter(Boolean);
        const base = segments[segments.length - 1] ?? '';
        const name = base
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40);
        if (!name) return null;
        const description =
          typeof d === 'object' && d?.description
            ? String(d.description).slice(0, 200)
            : undefined;
        return { name, ...(description ? { description } : {}) };
      })
      .filter(Boolean)
      .slice(0, 10) as Array<{ name: string; description?: string }>;

    const basePersonality = spec.personality ?? {
      voice: 'analytical',
      style: 'conversational',
      color: '#c2410c',
    };
    const personality = { ...basePersonality, expertise };

    const input: CreateAgentInput = {
      name,
      type: (spec.type ?? 'custom') as any,
      emoji: spec.emoji ?? '🤖',
      onboardingContext: spec.context ?? undefined,
      // Tracker schema — the single most requested agent shape is one that TRACKS things
      // (leads, applicants, invoices, papers), and until this was read from the spec the
      // conversational hire path could not produce one at all: the agent would write JSON
      // to a file that nothing rendered and nothing synced. createAgent already handled
      // `trackerSchema`; only this mapping was missing.
      trackerSchema: normaliseTrackerSchema(
        spec.tracker_schema ?? spec.trackerSchema,
      ),
      config: {
        goals: mission,
        tools,
        schedule:
          triggerMode === 'scheduled'
            ? normaliseSchedule(spec.schedule, interval)
            : [],
        budget: {
          daily: typeof spec.daily_budget === 'number' ? spec.daily_budget : 5,
          monthly:
            typeof spec.monthly_budget === 'number' ? spec.monthly_budget : 50,
          onExhaust: 'pause',
        },
        // Previously hardcoded empty, so an agent could be given a job with real-world
        // consequences and no stated limits on it.
        escalationRules: (Array.isArray(spec.escalation_rules)
          ? spec.escalation_rules
          : []
        )
          .map((r: any) => String(r).trim())
          .filter(Boolean)
          .slice(0, 10),
        triggerMode,
        personality,
        role,
        ...(typeof spec.icp === 'string' && spec.icp.trim()
          ? { icp: spec.icp.trim() }
          : {}),
        ...(customWorkspaceDirs.length ? { customWorkspaceDirs } : {}),
        model: spec.model ?? undefined,
        customSystemPrompt: spec.system_prompt
          ? { mode: 'augment', content: String(spec.system_prompt) }
          : undefined,
      },
    };

    const agent = await this.createAgent(input);
    if (ownerId) dbSetAgentOwner(agent.id, ownerId);

    // Seed-at-birth #1: materialize any files the user attached to the approval card
    // (uploaded to staging beforehand; the approval payload carries the token).
    const stagingToken =
      spec.references_staging_token ?? spec.referencesStagingToken;
    if (stagingToken) {
      try {
        const { added } = this._materializeStagedReferences(
          agent.id,
          String(stagingToken),
        );
        if (added.length)
          logger.info(
            `[HITL] Seeded ${added.length} reference(s) into "${agent.name}"`,
          );
      } catch (e) {
        logger.warn(
          { agentId: agent.id, err: String(e) },
          '[HITL] Failed to materialize staged references',
        );
      }
    }

    // Seed-at-birth #2: files the CALLING agent authored during its own cycle (e.g. the
    // Recruiter writing a domain knowledge seed while interviewing the user) and wants
    // carried into the new agent's own workspace. Without this, the Recruiter can only
    // *describe* such files in the system prompt — the files themselves never leave its
    // own workspace, so the new agent's system prompt ends up referencing paths that
    // don't exist (the exact bug this closes: KAIROS Research Agent, 2026-07-12).
    const seedFiles = Array.isArray(spec.seed_files) ? spec.seed_files : [];
    let seeded: string[] = [];
    let seedFailed: string[] = [];
    if (seedFiles.length && sourceAgentId) {
      try {
        const { added, skipped } = this._seedFilesFromAgent(
          sourceAgentId,
          agent.id,
          seedFiles,
        );
        seeded = added;
        seedFailed = skipped;
        if (added.length)
          logger.info(
            `[HITL] Seeded ${added.length} file(s) from ${sourceAgentId} into "${agent.name}": ${added.join(', ')}`,
          );
        if (skipped.length)
          logger.warn(
            `[HITL] Could not seed ${skipped.length} file(s) into "${agent.name}" (not found under the source agent's workspace, or an invalid path): ${skipped.join(', ')}`,
          );
      } catch (e) {
        logger.warn(
          { agentId: agent.id, sourceAgentId, err: String(e) },
          '[HITL] Failed to seed files from source agent',
        );
      }
    } else if (seedFiles.length && !sourceAgentId) {
      logger.warn(
        `[HITL] "${agent.name}" spec listed seed_files but no source agent was known — skipped`,
      );
    }

    // Tell the creating agent what actually happened, in its own thread.
    //
    // Seeding is opt-in via seed_files, and creation happens AFTER a HITL approval — so
    // there is no tool result the model can read, and nothing ever contradicted it. Twice
    // now (KAIROS 2026-07-12, Sandbox Tester 2026-07-17) a Recruiter authored the files,
    // omitted seed_files, and then told the user they were "in place". Its prompt already
    // forbids that claim in three separate places; prompting did not hold.
    //
    // So state the outcome as a fact in the conversation instead. The next cycle reads
    // recent chat (formatRecentChatContext), so the model is corrected by the record
    // rather than trusted to remember a rule — and the user sees the same line, which
    // means a false claim is contradicted on screen even if the model still makes one.
    if (sourceAgentId) {
      const summary = seeded.length
        ? `Seeded into its workspace: ${seeded.join(', ')}.`
        : 'No files were seeded — none were listed in seed_files, so its workspace starts empty. ' +
          'Any files you wrote are still only in YOUR workspace. Do not tell the user the new agent has them.';
      const failedNote = seedFailed.length
        ? ` Could not seed: ${seedFailed.join(', ')}.`
        : '';
      this._emitSystemChat(
        sourceAgentId,
        `_Created **${agent.name}**. ${summary}${failedNote}_`,
      );
    }

    logger.info(
      `[HITL] Created agent "${agent.name}" (${agent.id}) via Recruiter`,
    );
    getSocketIO()?.emit('agent:created', {
      agentId: agent.id,
      name: agent.name,
      type: agent.type,
    });
  }

  /**
   * Copy files the calling agent (e.g. the Recruiter) authored in its own workspace
   * into a newly created agent's workspace, and pin them as must-read (same mechanism
   * `_materializeStagedReferences` uses — see the `## Must-Read (pinned)` context block
   * built in `_buildAgentContext`). Each entry in `seedFiles` is either a plain path
   * string (source == target) or `{ source_path, target_path }` to rename on the way in.
   *
   * Paths are tolerant of both conventions an agent's own tool calls use: workspace
   * -relative ("kairos-research-agent/KNOWLEDGE_SEED.md") or agent-root-relative with an
   * explicit "workspace/" prefix (what `read_file`/`write_file` actually see) — a
   * leading "workspace" segment is stripped before resolving. Every path is sanitized
   * (no traversal, scrubbed characters, capped depth) and the resolved absolute path is
   * re-checked against its workspace root before any read/write, so a malformed or
   * adversarial path can only ever touch files already inside one of these two agents'
   * own workspace directories.
   */
  private _seedFilesFromAgent(
    sourceAgentId: string,
    targetAgentId: string,
    seedFiles: unknown[],
  ): { added: string[]; skipped: string[] } {
    const added: string[] = [];
    const skipped: string[] = [];
    const sourceWs = path.join(DATA_DIR, 'agents', sourceAgentId, 'workspace');
    const targetWs = path.join(DATA_DIR, 'agents', targetAgentId, 'workspace');
    fs.mkdirSync(targetWs, { recursive: true });

    const targetAgent = this.getAgent(targetAgentId);
    const pins = new Set(targetAgent?.config.pins ?? []);

    for (const entry of seedFiles) {
      const rawSource =
        typeof entry === 'string'
          ? entry
          : ((entry as any)?.source_path ?? (entry as any)?.sourcePath);
      const rawTarget =
        typeof entry === 'string'
          ? entry
          : ((entry as any)?.target_path ??
            (entry as any)?.targetPath ??
            rawSource);
      const srcRel = sanitiseWorkspacePath(String(rawSource ?? ''));
      const dstRel = sanitiseWorkspacePath(String(rawTarget ?? ''));
      if (!srcRel || !dstRel) {
        skipped.push(String(rawSource ?? '(empty)'));
        continue;
      }

      const srcAbs = path.join(sourceWs, srcRel);
      const dstAbs = path.join(targetWs, dstRel);
      // Belt-and-braces: sanitiseWorkspacePath already blocks '..'/'.' segments, this
      // catches anything that could still slip past it (e.g. Windows/POSIX oddities).
      if (
        !srcAbs.startsWith(sourceWs + path.sep) ||
        !dstAbs.startsWith(targetWs + path.sep)
      ) {
        skipped.push(srcRel);
        continue;
      }
      if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
        skipped.push(srcRel);
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.copyFileSync(srcAbs, dstAbs);
        pins.add(dstRel);
        added.push(dstRel);
      } catch {
        skipped.push(srcRel);
      }
    }

    if (added.length && targetAgent) {
      targetAgent.config.pins = [...pins];
      void this.updateAgent(targetAgentId, { config: targetAgent.config });
    }
    return { added, skipped };
  }

  /**
   * "Does this agent actually have what it was promised?" — the check that would have
   * caught the KAIROS Research Agent bug automatically instead of needing a manual,
   * multi-call investigation. Re-runnable any time (not just at creation), since pinned
   * files can be deleted later and credentials can be connected/disconnected. Every
   * check here is deterministic (file existence, credential presence, known tool
   * names) — deliberately does NOT try to parse free-text system-prompt content for
   * file references, since that's heuristic and would produce noisy false positives.
   */
  auditAgent(agentId: string): AgentAuditResult {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const wsRoot = this.workspace.getWorkspacePath(agentId);
    const pins = (agent.config.pins ?? []).filter(Boolean);
    const pinnedFiles = pins.map((p) => ({
      path: p,
      exists: (() => {
        try {
          return (
            fs.existsSync(path.join(wsRoot, p)) &&
            fs.statSync(path.join(wsRoot, p)).isFile()
          );
        } catch {
          return false;
        }
      })(),
    }));

    const dirs = agent.config.customWorkspaceDirs ?? [];
    const workspaceDirs = dirs.map((d) => ({
      name: d.name,
      exists: (() => {
        try {
          return (
            fs.existsSync(path.join(wsRoot, d.name)) &&
            fs.statSync(path.join(wsRoot, d.name)).isDirectory()
          );
        } catch {
          return false;
        }
      })(),
    }));

    const tools = agent.config.tools ?? [];
    const knownToolNames = new Set(CYCLE_BUILTINS.map((t) => t.name));
    const unknownTools = tools.filter((t) => !knownToolNames.has(t));
    // A credential counts as present if the agent will FIND it at runtime, from any scope —
    // platform, the owner's own connections, or this agent's secrets. Checking only
    // credentialManager reported working agents as broken: that store is admin-only and
    // platform-wide, so a customer's own connection necessarily lives in secrets. Finder is
    // connected to X entirely through per-agent secrets and was still listed as missing `x`.
    const agentEnv = secretsManager.getAll(
      agent.id,
      agent.owner_id ?? undefined,
    );
    const missingCredentials = [
      ...new Set(
        tools.flatMap(
          (t) =>
            CYCLE_BUILTINS.find((c) => c.name === t)?.requiresCredential ?? [],
        ),
      ),
    ].filter(
      (svc) =>
        !credentialManager.get(svc) &&
        !isServiceConnectedViaSecrets(svc, agentEnv),
    );

    const scheduleOk =
      agent.config.triggerMode !== 'scheduled' ||
      (agent.config.schedule ?? []).some(
        (s) => s.enabled && s.interval && s.interval.toLowerCase() !== 'manual',
      );

    const passed =
      pinnedFiles.every((f) => f.exists) &&
      workspaceDirs.every((d) => d.exists) &&
      missingCredentials.length === 0 &&
      unknownTools.length === 0 &&
      scheduleOk;

    return {
      agentId,
      agentName: agent.name,
      checkedAt: new Date().toISOString(),
      passed,
      checks: {
        pinnedFiles,
        workspaceDirs,
        missingCredentials,
        unknownTools,
        scheduleOk,
      },
    };
  }

  /**
   * Append newly-distilled, high-relevance memory to a companion knowledge-seed file next
   * to any pinned seed document — the seed itself is never edited in place (avoids
   * corrupting hand-curated content the user or Recruiter wrote). Only agents with at least
   * one pinned non-scaffold file get one — an agent nobody seeded anything for has no seed
   * to enrich. Called after every self_improve cycle.
   *
   * Stage 34 Gap 6 — split into two files instead of one ever-growing append log:
   *  - SEED_UPDATES.md: the permanent, unabridged raw log. Never reorganized, never pinned.
   *  - SEED_CURRENT.md: the pinned "live" view. Appended to incrementally like before, but
   *    once it grows past SEED_CURRENT_REORG_THRESHOLD_CHARS, an LLM pass merges/dedupes it
   *    back down — the context-budget cost stays bounded without ever losing history, because
   *    the raw log behind it is untouched.
   */
  private _enrichKnowledgeSeed(agentId: string, memories: AgentMemory[]): void {
    const agent = this.getAgent(agentId);
    if (!agent) return;
    const SCAFFOLD = new Set(['IDENTITY.md', 'SCHEMA.md', 'STRUCTURE.md']);
    const pins = agent.config.pins ?? [];
    const seedPins = pins.filter(
      (p) => !SCAFFOLD.has(p) && !p.startsWith('memory/'),
    );
    if (seedPins.length === 0) return; // nothing was seeded for this agent — nothing to enrich

    const worthNoting = memories.filter((m) => m.relevance >= 0.6);
    if (worthNoting.length === 0) return;

    const updatesPath = 'memory/knowledge/SEED_UPDATES.md'; // permanent raw log
    const currentPath = 'memory/knowledge/SEED_CURRENT.md'; // pinned "live" view
    const wsRoot = this.workspace.getWorkspacePath(agentId);
    const updatesAbs = path.join(wsRoot, updatesPath);
    const currentAbs = path.join(wsRoot, currentPath);
    const date = new Date().toISOString().slice(0, 10);
    const block = [
      `\n## ${date}`,
      ...worthNoting.map((m) => `- ${m.content.trim()}`),
      '',
    ].join('\n');

    try {
      fs.mkdirSync(path.dirname(updatesAbs), { recursive: true });
      const isNew = !fs.existsSync(updatesAbs);
      const header = isNew
        ? `# Seed knowledge — permanent raw log\n\nEvery finding ever distilled from self_improve cycles, in order. Never reorganized and never pinned directly — read SEED_CURRENT.md instead; this file is the unabridged audit trail behind it.\n`
        : '';
      fs.appendFileSync(updatesAbs, header + block, 'utf-8');
    } catch (e) {
      logger.warn(
        { agentId, err: String(e) },
        'Failed to write knowledge-seed updates file',
      );
      return;
    }

    try {
      fs.mkdirSync(path.dirname(currentAbs), { recursive: true });
      const isNewCurrent = !fs.existsSync(currentAbs);
      const header = isNewCurrent
        ? `# Seed knowledge — current\n\nAuto-maintained findings from self_improve cycles, read alongside ${seedPins.join(', ')}. Periodically reorganized to stay compact; see SEED_UPDATES.md for the full unabridged history.\n`
        : '';
      fs.appendFileSync(currentAbs, header + block, 'utf-8');

      const size = fs.statSync(currentAbs).size;
      if (size > SEED_CURRENT_REORG_THRESHOLD_CHARS) {
        this._reorganizeSeedCurrent(agentId, currentAbs, seedPins).catch((e) =>
          logger.warn(
            { agentId, err: String(e) },
            'Seed-knowledge reorg failed — SEED_CURRENT.md left as-is',
          ),
        );
      }
    } catch (e) {
      logger.warn(
        { agentId, err: String(e) },
        'Failed to write SEED_CURRENT.md',
      );
      return;
    }

    // Pin SEED_CURRENT.md (the bounded view) going forward, not the ever-growing raw log —
    // migrates already-seeded agents off the old pin in the same update.
    const nextPins = pins.filter((p) => p !== updatesPath);
    if (!nextPins.includes(currentPath)) nextPins.push(currentPath);
    if (nextPins.length !== pins.length || !pins.includes(currentPath)) {
      void this.updateAgent(agentId, {
        config: { ...agent.config, pins: nextPins },
      });
    }
  }

  /**
   * Stage 34 Gap 6 — periodic reorganization pass. Merges/dedupes SEED_CURRENT.md via an LLM
   * call once it's grown past the size threshold; the permanent raw log (SEED_UPDATES.md) is
   * never touched, so a bad reorg pass loses nothing — worst case, SEED_CURRENT.md just stays
   * large until the next successful pass.
   */
  private async _reorganizeSeedCurrent(
    agentId: string,
    currentAbs: string,
    seedPins: string[],
  ): Promise<void> {
    const raw = fs.readFileSync(currentAbs, 'utf-8');
    const systemPrompt = `You are compacting an AI agent's accumulated "knowledge updates" log. Merge duplicate/overlapping findings, remove anything clearly superseded by a later entry, and keep everything else — do not invent anything not already present. Return the reorganized markdown content only, no commentary, no code fences.`;
    const userPrompt = `Reorganize this into a compact, deduplicated knowledge summary (markdown, grouped by theme rather than by date):\n\n${raw.slice(0, 60000)}`;

    const reorganized = await callClaude(
      systemPrompt,
      userPrompt,
      3000,
      agentId,
    );
    if (!reorganized.trim()) return; // safety: never blank out SEED_CURRENT.md on an empty response

    const header = `# Seed knowledge — current\n\nAuto-maintained findings from self_improve cycles, read alongside ${seedPins.join(', ')}. Last reorganized ${new Date().toISOString().slice(0, 10)}; see SEED_UPDATES.md for the full unabridged history.\n\n`;
    fs.writeFileSync(currentAbs, header + reorganized.trim() + '\n', 'utf-8');
    logger.info(
      { agentId, newSize: header.length + reorganized.length },
      '[knowledge-seed] SEED_CURRENT.md reorganized',
    );
  }

  /** Move staged upload files (data/staging/<token>/) into an agent's references/,
   *  merge into config.references, regenerate identity, and clean up the staging dir. */
  private _materializeStagedReferences(
    agentId: string,
    token: string,
  ): { added: string[] } {
    const stageDir = path.join(STAGING_DIR, token);
    const added: string[] = [];
    if (!fs.existsSync(stageDir)) return { added };

    const agent = this.getAgent(agentId);
    if (!agent) return { added };
    // Project-folder model: seed files land in workspace/ and are pinned as must-read.
    const wsDir = path.join(DATA_DIR, 'agents', agentId, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    const pins = new Set(agent.config.pins ?? []);

    const walk = (dir: string, rel: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(abs, relPath);
          continue;
        }
        const dest = path.join(wsDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
        pins.add(relPath);
        added.push(relPath);
      }
    };
    walk(stageDir, '');

    if (added.length) {
      agent.config.pins = [...pins];
      void this.updateAgent(agentId, { config: agent.config });
    }
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    return { added };
  }

  /**
   * Send an email a human approved through HITL. Gmail API first, SMTP as a fallback.
   *
   * Gmail is preferred when connected because it threads the message into a real
   * conversation, which `gmail_replies` can then follow. But Gmail here needs an OAuth
   * refresh token, and a Workspace mailbox with only an app password cannot mint one — so
   * before this fallback existed, an approved outreach email failed outright on a box that
   * could already send perfectly well over SMTP.
   *
   * Only reached from `_fireCheckinAction`, i.e. after an explicit human Approve. That is
   * the send gate: it does not depend on the security posture, which is per-owner and
   * defaults to `auto`, so tool-level approval would not have covered this.
   */
  private async _gmailSend(
    payload: {
      to: string;
      subject: string;
      body: string;
      thread_id?: string;
      lead_key?: string;
      business?: string;
    },
    sourceAgentId?: string,
  ): Promise<void> {
    const gmailCreds = credentialManager.get('gmail') as Record<
      string,
      string
    > | null;
    const fromEmail = gmailCreds?.email;

    // Try cached access token first; if missing/expired, exchange refresh token
    let accessToken = await credentialManager.getValidAccessToken('gmail');

    if (!accessToken) {
      const refreshToken = gmailCreds?.refresh_token;
      const clientId = gmailCreds?.client_id;
      const clientSecret = gmailCreds?.client_secret;

      if (!refreshToken || !clientId || !clientSecret) {
        // No Gmail OAuth — fall back to SMTP. Plain text on purpose (see sendPlainTextMail).
        if (isEmailConfigured()) {
          // Thread a follow-up/closing reply onto the original send, so it lands in the same
          // Gmail conversation instead of as a new, disconnected email. A draft's own lead_key
          // may carry a bookkeeping suffix (e.g. `...#closing`) that the tracked lead never
          // has — strip it before looking up the prior send.
          const baseLeadKey = String(payload.lead_key ?? '').split('#')[0];
          const priorSend = baseLeadKey
            ? getLatestOutreachSendForLead(baseLeadKey)
            : null;
          const thread = priorSend?.message_id
            ? {
                inReplyTo: priorSend.message_id,
                references: priorSend.message_id,
              }
            : undefined;
          const { messageId } = await sendPlainTextMail(
            payload.to,
            payload.subject,
            payload.body,
            thread,
          );
          // Record the send so a reply can be matched back to this lead. Without the
          // Message-ID there is no durable link between an email and its answer.
          try {
            recordOutreachSend({
              agent_id: sourceAgentId ?? null,
              lead_key: payload.lead_key ?? null,
              business: payload.business ?? null,
              to_email: payload.to,
              subject: payload.subject,
              message_id: messageId,
              via: 'smtp',
            });
          } catch (e) {
            // Never fail a delivered email because bookkeeping failed — but say so loudly,
            // because an unrecorded send is a reply we will not be able to match.
            logger.error(
              { err: String(e), to: payload.to },
              '[HITL] email SENT but recording it failed — a reply to this will not be matched',
            );
          }
          logger.info(
            {
              to: payload.to,
              subject: payload.subject,
              via: 'smtp',
              messageId,
              threaded: !!thread,
            },
            '[HITL] Approved email sent via SMTP (Gmail OAuth not connected)',
          );
          return;
        }
        throw new Error(
          'Cannot send: Gmail is not connected and SMTP is not configured. ' +
            'Set EMAIL_SERVER_HOST/USER/PASSWORD, or connect Gmail in Dashboard → Credentials.',
        );
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      if (!tokenRes.ok)
        throw new Error(`Gmail token refresh failed: ${tokenRes.status}`);
      const tokenData = (await tokenRes.json()) as Record<string, unknown>;
      accessToken = tokenData.access_token as string;
    }

    // Set our own Message-ID so a reply quoting it in In-Reply-To can be matched back to the
    // send. Gmail may replace this with its own on the way out, which is why the send is
    // recorded regardless and the poller keeps its match-by-sender-address fallback.
    const msgDomain = (fromEmail?.split('@')[1] ?? 'example.com').trim();
    const messageId = `<${randomUUID()}@${msgDomain}>`;

    const headers = [
      ...(fromEmail ? [`From: ${fromEmail}`] : []),
      `To: ${payload.to}`,
      `Subject: ${payload.subject}`,
      `Message-ID: ${messageId}`,
      'Content-Type: text/plain; charset=utf-8',
    ];
    const rawMsg = headers.join('\r\n') + '\r\n\r\n' + payload.body;
    const encoded = Buffer.from(rawMsg)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const reqBody: Record<string, any> = { raw: encoded };
    if (payload.thread_id) reqBody.threadId = payload.thread_id;

    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail API error ${res.status}: ${text.slice(0, 200)}`);
    }

    // Same bookkeeping the SMTP fallback does. This path had none, so every send made once
    // Gmail OAuth is connected would have been invisible to the reply poller — no row to
    // match against, and the reply silently dropped. Never fail a delivered email because
    // recording it failed, but log loudly: an unrecorded send is an unmatchable reply.
    try {
      recordOutreachSend({
        agent_id: sourceAgentId ?? null,
        lead_key: payload.lead_key ?? null,
        business: payload.business ?? null,
        to_email: payload.to,
        subject: payload.subject,
        message_id: messageId,
        via: 'gmail',
      });
    } catch (e) {
      logger.error(
        { err: String(e), to: payload.to },
        '[HITL] email SENT but recording it failed — a reply to this will not be matched',
      );
    }

    logger.info(
      `[HITL] Email sent to ${payload.to} — subject: "${payload.subject}"`,
    );
  }
}
