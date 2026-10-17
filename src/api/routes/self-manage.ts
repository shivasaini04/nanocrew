/**
 * Agent self-management routes — the control plane an agent may write to itself.
 *
 * Mounted ABOVE the `app.use('/api', requireAuth)` gate in server.ts, because the caller
 * is a container with no session cookie. Unlike the 22 other internal routes it is NOT
 * open to anyone holding an agent UUID: every route here requires the per-cycle token
 * from cycle-token.ts. That distinction matters because these routes change how much
 * money an agent may spend, which model it runs, and whether it runs at all — whereas
 * the pre-existing internal routes only append rows.
 *
 * Scope is strictly self: the token is bound to one agent id and the route only ever
 * writes to that same agent. There is no path here to touch another agent's config.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { agentService, agentScheduler } from '../../agents/agent-registry.js';
import {
  getAgentSelfReport,
  recordConfigAudit,
  getAllAgents as dbGetAllAgents,
  getRecentTraceSignals,
  getConfigAudit,
  getHandoffOutcomes,
} from '../../db.js';
import {
  getHandoffById,
  getHandoffsByAgent,
  getUnansweredRequestsByAgent,
  getMessagesOwedCount,
  replyToHandoff,
  REPLY_PERFORMATIVES,
} from '../../db.js';
import type { HandoffPerformative } from '../../db.js';
import { getCheckinById } from '../../db.js';
import { findAgents, renderMatches } from '../../agents/capability-index.js';
import { borrowTool } from '../../agents/tool-borrowing.js';
import { agentHandoffService } from '../../agents/agent-handoff.js';
import {
  getChangeImpact,
  type ChangeImpact,
} from '../../agents/change-impact.js';
import {
  createAgentCheckin,
  getLearnedBullets,
  getEntitySchema,
  upsertEntitySchema,
  countTrackedItemsInStage,
} from '../../db.js';
import { normaliseTrackerSchema } from '../../agents/agent-service.js';
import { renderSelfReport } from '../../agents/self-report.js';
import { DATA_DIR } from '../../config.js';
import {
  validateSchedule,
  whyEntryWontFire,
  normaliseSchedule,
  describeTimers,
} from '../../agents/agent-scheduler.js';
import {
  verifyCycleToken,
  extractCycleToken,
  resolveCycleToken,
} from '../../agents/cycle-token.js';
import { drainSteers } from '../../agents/run-steering.js';
import { isTaintedByWorkerData } from '../../swarm/taint.js';
import { getChannelSender } from '../instances.js';
import { getSocketIO } from '../instances.js';
import { getModelConfig } from '../../services/model-router.js';
import { logger } from '../../logger.js';
import { canWake } from '../../agents/wake-policy.js';
import { notify } from '../../notifications.js';
import { probeModel } from '../../agents/model-safety.js';
import { ALWAYS_GRANTED, OUTBOUND_TOOLS } from '../../agents/tool-grants.js';
import { secretsManager } from '../../agents/secrets-manager.js';
import type {
  AgentConfig,
  CycleType,
  OneOffRun,
  SelfGrant,
} from '../../types.js';
import { localFollowups } from '../../agents/local-followups.js';
import { DEFAULT_WAKE_POLICY } from '../../types.js';
import {
  evaluateApproval,
  describeRule,
  validateRule,
  makeRule,
  isLoosening,
  APPROVAL_ACTIONS,
  type ApprovalAction,
  type ApprovalContext,
  type ApprovalRule,
} from '../../agents/approval-policy.js';
import { getAgentCycleById, getUserById } from '../../db.js';
import { browserBroker, derivePrincipal } from '../../agents/browser-broker.js';

export const selfManageRouter: Router = Router({ mergeParams: true });

/**
 * Ceilings on what an agent may grant itself.
 *
 * The platform-wide daily cap in agent-service.ts is the real backstop, but it pauses
 * *every* agent at once — a blunt instrument to reach for because one agent talked
 * itself into a bigger allowance. These bound the per-agent damage first.
 */
const SELF_MAX_DAILY_BUDGET = Number(
  process.env.AGENT_SELF_MAX_DAILY_BUDGET ?? 20,
);
const SELF_MAX_MONTHLY_BUDGET = Number(
  process.env.AGENT_SELF_MAX_MONTHLY_BUDGET ?? 200,
);

/**
 * The ceiling for one agent — its own if set, otherwise the platform default.
 *
 * Stage 54 phase 3. Grants and ceilings answer different questions and conflating them is
 * what made the old split incoherent: a grant says whether an agent may touch budget at
 * all, a ceiling says how far. Keeping them separate is what lets "full control" stop
 * short of "can drain the account" without a special case inside the route.
 *
 * The env vars survive as the DEFAULT rather than the law, so nothing changes for an
 * agent nobody has configured.
 */
function ceilingsFor(agent: { config: AgentConfig }) {
  const c = agent.config.selfAuthority?.ceilings ?? {};
  return {
    daily: c.dailyBudgetUsd ?? SELF_MAX_DAILY_BUDGET,
    monthly: c.monthlyBudgetUsd ?? SELF_MAX_MONTHLY_BUDGET,
    maxOneOffs: c.maxOneOffs ?? MAX_ONE_OFFS_PER_AGENT,
  };
}

/** How far ahead a one-off may be scheduled, and how many may be queued at once. */
const MAX_ONE_OFF_HORIZON_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_ONE_OFFS_PER_AGENT = 20;

/**
 * Cycle types an agent may schedule for itself.
 *
 * A deliberate subset of CycleType: 'handoff' and 'job_done' are dispatched by the
 * orchestrator in response to an event that has already happened, so a timer that fires
 * one has nothing to act on.
 */
const VALID_CYCLE_TYPES: CycleType[] = [
  'work',
  'lead_search',
  'send_outreach',
  'followup',
  'checkin',
  'self_improve',
  'custom',
];

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Require a live per-cycle token that was minted for THIS agent.
 *
 * Read from the Authorization header (preferred) or an `X-Cycle-Token` header. Never
 * from the query string: query strings land in access logs, which is most of the reason
 * the UUID-as-password model is not good enough for these routes.
 */
function requireCycleToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const agentId = String(req.params.id ?? '');
  const token = extractCycleToken(
    req.headers.authorization,
    req.headers['x-cycle-token'],
  );

  if (!verifyCycleToken(token, agentId)) {
    logger.warn(
      { agentId, path: req.path },
      'Self-management call rejected — invalid or expired cycle token',
    );
    res.status(401).json({ error: 'Invalid or expired cycle token' });
    return;
  }
  next();
}

selfManageRouter.use('/:id/self', requireCycleToken);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAgentOr404(req: Request, res: Response) {
  const agent = agentService.getAgent(String(req.params.id));
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  return agent;
}

/**
 * Re-arm the in-memory scheduler after a config write.
 *
 * The PATCH route does this inline and swallows failures as a warning. Here the failure
 * is returned to the caller instead: the agent asked for this change and is the only
 * party in a position to correct a bad interval, so telling it "your schedule did not
 * take" is the whole point. Validation upstream should make this unreachable.
 */
function resyncSchedule(agentId: string, config: AgentConfig): string | null {
  const hasEnabledEntry = (config.schedule ?? []).some(
    (s) => s.enabled && s.interval && s.interval.toLowerCase() !== 'manual',
  );
  try {
    if (hasEnabledEntry) agentScheduler.register(agentId, config);
    else agentScheduler.unregister(agentId);
    return null;
  } catch (e: any) {
    logger.error(
      { agentId, err: e?.message },
      'Self-managed schedule re-register failed',
    );
    return `Schedule saved but could not be armed: ${e?.message ?? String(e)}`;
  }
}

// ─── Audit (stage 54 phase 1) ─────────────────────────────────────────────────

/**
 * Which fields of an agent each capability owns.
 *
 * Two properties every entry must hold, both learned the hard way on the first live
 * revert:
 *
 * 1. **The keys are real AgentConfig keys.** A revert hands this object straight back to
 *    updateAgent, so a friendly label like `systemPrompt` instead of `customSystemPrompt`
 *    means the restore writes a junk key and silently misses the real one. The revert
 *    still reports success, because nothing compares what it wrote to what it meant.
 *
 * 2. **Every field is present, using null for unset.** JSON.stringify DROPS undefined, so
 *    an agent whose `role` was never set produced a snapshot with no `role` key at all —
 *    and "put this field back to unset" became unexpressible. The revert ran, changed
 *    nothing, and said ok.
 *
 * `status` is the one exception: it lives on the agent row, not in config, and the revert
 * route special-cases it.
 */
const AUDIT_SUBTREE: Record<
  string,
  (a: { id: string; status: string; config: AgentConfig }) => unknown
> = {
  schedule: (a) => ({
    schedule: a.config.schedule ?? [],
    triggerMode: a.config.triggerMode ?? 'scheduled',
  }),
  one_off: (a) => ({ oneOffRuns: a.config.oneOffRuns ?? [] }),
  model: (a) => ({
    model: a.config.model ?? null,
    subagent_model: a.config.subagent_model ?? null,
    thinking_enabled: a.config.thinking_enabled ?? null,
    task_models: a.config.task_models ?? null,
  }),
  budget: (a) => ({ budget: a.config.budget }),
  status: (a) => ({ status: a.status }),
  identity: (a) => ({
    goals: a.config.goals ?? null,
    role: a.config.role ?? null,
    personality: a.config.personality ?? null,
    customSystemPrompt: a.config.customSystemPrompt ?? null,
  }),
  runtime: () => ({}), // written straight from the settings file, not from config
  workspace: (a) => ({
    pins: a.config.pins ?? [],
    customWorkspaceDirs: a.config.customWorkspaceDirs ?? [],
  }),
  approvals: (a) => ({ approvalRules: a.config.approvalRules ?? [] }),
  settings: (a) => ({
    icp: a.config.icp ?? null,
    escalationRules: a.config.escalationRules ?? [],
    wakePolicy: a.config.wakePolicy ?? null,
    notifications: a.config.notifications ?? null,
    job_summary: a.config.job_summary ?? null,
    alwaysHeavy: a.config.alwaysHeavy ?? null,
    useUserBrowser: a.config.useUserBrowser ?? null,
    requireUserBrowser: a.config.requireUserBrowser ?? null,
    webhookUrl: a.config.webhookUrl ?? null,
  }),
};

/** The config keys a revert is allowed to write, derived from the subtrees above. */
export const REVERTABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'schedule',
  'triggerMode',
  'oneOffRuns',
  'model',
  'subagent_model',
  'thinking_enabled',
  'task_models',
  'budget',
  'goals',
  'role',
  'personality',
  'customSystemPrompt',
  'pins',
  'customWorkspaceDirs',
  'icp',
  'escalationRules',
  'wakePolicy',
  'notifications',
  'job_summary',
  'alwaysHeavy',
  'useUserBrowser',
  'requireUserBrowser',
  'webhookUrl',
  'approvalRules',
]);

/**
 * Snapshot the part of an agent one capability owns.
 *
 * Reads from the live agent rather than a passed-in copy, because several routes mutate
 * through agentService and the caller's object is stale by the time the change lands.
 */
export function auditSnapshot(agentId: string, capability: string): unknown {
  const a = agentService.getAgent(agentId);
  if (!a) return null;
  const pick = AUDIT_SUBTREE[capability];
  return pick ? pick(a) : null;
}

/**
 * Record one self-management change, attributed to the cycle that made it.
 *
 * Never throws: an audit failure must not fail the change the agent just made, or a
 * logging bug becomes an outage. It logs loudly instead — a silent gap in the trail is
 * the exact failure this table exists to prevent, so it should be visible.
 */
export function auditSelfChange(
  req: Request,
  agentId: string,
  capability: string,
  before: unknown,
  after: unknown,
  reason?: unknown,
): string | null {
  try {
    const token = extractCycleToken(
      req.headers.authorization,
      req.headers['x-cycle-token'],
    );
    const resolved = resolveCycleToken(token);
    return recordConfigAudit({
      agentId,
      capability,
      actor: 'agent',
      cycleId: resolved?.cycleId ?? null,
      before,
      after,
      reason:
        typeof reason === 'string' && reason.trim()
          ? reason.trim().slice(0, 2000)
          : null,
    });
  } catch (err: any) {
    logger.error(
      { agentId, capability, err: err?.message },
      'config audit write FAILED — change applied but unrecorded',
    );
    return null;
  }
}

// ─── GET /api/agents/:id/self — read back what is self-manageable ─────────────

selfManageRouter.get('/:id/self', (req: Request, res: Response) => {
  const agent = getAgentOr404(req, res);
  if (!agent) return;

  const next = agentScheduler.getNextCycle(agent.id);
  res.json({
    name: agent.name,
    // Settled, not raw: this is only ever called from inside a cycle, when the raw
    // value is always 'running'.
    status: agentService.getSettledStatus(agent.id) ?? agent.status,
    triggerMode: agent.config.triggerMode ?? 'scheduled',
    schedule: agent.config.schedule ?? [],
    oneOffRuns: agent.config.oneOffRuns ?? [],
    nextCycle: next
      ? { type: next.type, dueAt: next.dueAt.toISOString() }
      : null,
    model: agent.config.model ?? getModelConfig().defaultModel,
    budget: agent.config.budget,
    whatsappBound: !!agent.whatsapp_jid,
    taskModels: agent.config.task_models ?? {},
    // Everything else it can change, so `get` answers "what is my X?" for all of it.
    settings: auditSnapshot(agent.id, 'settings'),
    limits: {
      maxDailyBudget: ceilingsFor(agent).daily,
      maxMonthlyBudget: ceilingsFor(agent).monthly,
      maxOneOffs: ceilingsFor(agent).maxOneOffs,
    },
  });
});

// ─── POST /api/agents/:id/self/schedule ───────────────────────────────────────

selfManageRouter.post(
  '/:id/self/schedule',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { schedule, triggerMode, reason, op } = req.body as {
        schedule?: unknown;
        triggerMode?: unknown;
        reason?: unknown;
        op?: unknown;
      };
      const operation = String(op ?? 'set');
      if (!['set', 'add', 'remove'].includes(operation)) {
        return res
          .status(422)
          .json({ error: "op must be 'set', 'add' or 'remove'" });
      }
      const beforeSchedule = auditSnapshot(agent.id, 'schedule');

      const patch: Partial<AgentConfig> = {};

      if (triggerMode !== undefined) {
        if (
          triggerMode !== 'scheduled' &&
          triggerMode !== 'on_demand' &&
          triggerMode !== 'event_driven'
        ) {
          return res.status(422).json({
            error: `triggerMode must be one of: scheduled, on_demand, event_driven`,
          });
        }
        patch.triggerMode = triggerMode;
      }

      if (schedule !== undefined) {
        const err = validateSchedule(schedule);
        if (err) return res.status(422).json({ error: err });
        for (const entry of schedule as Array<{ type: string }>) {
          if (!VALID_CYCLE_TYPES.includes(entry.type as CycleType)) {
            return res.status(422).json({
              error: `Unknown cycle type "${entry.type}". Valid types: ${VALID_CYCLE_TYPES.join(', ')}`,
            });
          }
        }
        const incoming = schedule as AgentConfig['schedule'];
        const current = normaliseSchedule(agent.config.schedule ?? []);

        // Which existing timer an incoming entry means: by id, then by name, then — for
        // an entry with neither — the one timer of that type, if there is exactly one.
        // Matching by type alone was the old rule, and it is why an agent could never
        // hold two timers of the same kind: the second overwrote the first.
        const findMatch = (e: AgentConfig['schedule'][number]): number => {
          if (e.id) return current.findIndex((c) => c.id === e.id);
          if (e.name?.trim())
            return current.findIndex(
              (c) => c.name?.toLowerCase() === e.name!.trim().toLowerCase(),
            );
          const same = current
            .map((c, i) => [c, i] as const)
            .filter(([c]) => c.type === e.type && !c.name);
          return same.length === 1 ? same[0][1] : -1;
        };

        // `set` replaces the whole list, and used to be the only behaviour. That made
        // "add a weekly check-in" a silent delete of everything else for any agent that
        // did not call `get` first — the tool description asked it to, which is a
        // request, not a guard, and precisely the kind of instruction a weak model
        // drops. `add` and `remove` are named so the destructive one has to be chosen.
        if (operation === 'add') {
          const next = [...current];
          for (const e of incoming) {
            const i = findMatch(e);
            if (i >= 0) next[i] = { ...next[i], ...e, id: next[i].id };
            else next.push(e);
          }
          patch.schedule = normaliseSchedule(next);
        } else if (operation === 'remove') {
          const drop = new Set<number>();
          for (const e of incoming) {
            const i = findMatch(e);
            if (i < 0) {
              const candidates = current
                .filter((c) => c.type === e.type)
                .map((c) => `${c.id}${c.name ? ` ("${c.name}")` : ''}`);
              return res.status(422).json({
                error:
                  candidates.length > 1
                    ? `Several ${e.type} timers exist — say which by id or name: ${candidates.join(', ')}`
                    : `No timer matches ${e.id ?? e.name ?? e.type}. Call get to see your timers.`,
              });
            }
            drop.add(i);
          }
          patch.schedule = current.filter((_, i) => !drop.has(i));
        } else {
          patch.schedule = normaliseSchedule(incoming);
        }
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error: 'Nothing to change: pass schedule and/or triggerMode',
        });
      }

      // A non-scheduled trigger mode must not leave live entries behind, or the scheduler
      // keeps firing a schedule the agent disowned. This used to empty the array, which
      // made "make yourself on-demand" a destructive edit: hand-written cron strings were
      // discarded and had to be retyped to undo it. Disabling keeps the entries, so the
      // mode is reversible and the audit diff shows a flag flipping rather than data
      // disappearing.
      const effectiveMode =
        patch.triggerMode ?? agent.config.triggerMode ?? 'scheduled';
      if (effectiveMode !== 'scheduled' && patch.schedule === undefined) {
        patch.schedule = (agent.config.schedule ?? []).map((e) => ({
          ...e,
          enabled: false,
        }));
      }

      const updated = await agentService.updateAgent(agent.id, {
        config: patch as AgentConfig,
      });
      const warning = resyncSchedule(agent.id, updated.config);

      getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      auditSelfChange(
        req,
        agent.id,
        'schedule',
        beforeSchedule,
        auditSnapshot(agent.id, 'schedule'),
        reason,
      );

      // Setting a schedule means "run on it". It used to write the timetable and leave the
      // on/off switch alone, so on an idle agent every entry was saved, reported as done,
      // and skipped by the scheduler forever (Crawler, 2026-09-23). An idle agent is one
      // nobody has started, so starting it is what was asked for. Paused and stopped are
      // someone's decision — those are left alone and reported instead.
      let status = agentService.getSettledStatus(agent.id) ?? agent.status;
      const wouldFire = (updated.config.schedule ?? []).filter(
        (e) =>
          whyEntryWontFire(e, { status: 'running', config: updated.config }) ===
          null,
      );
      let armedNow = false;
      if (status === 'idle' && wouldFire.length > 0) {
        const beforeStatus = { status };
        agentService.setSelfStatus(agent.id, 'running');
        status = 'running';
        armedNow = true;
        auditSelfChange(
          req,
          agent.id,
          'status',
          beforeStatus,
          { status: 'running' },
          'Switched on because a schedule was set while the agent was idle',
        );
        try {
          notify(
            'agent_alert',
            `${agent.name} switched itself on`,
            `It set a schedule while idle, so it is now running on: ` +
              wouldFire
                .map(
                  (e) =>
                    `${e.name ?? e.type} ${e.interval} (${e.timezone ?? 'UTC'})`,
                )
                .join(', ') +
              `${typeof reason === 'string' && reason.trim() ? `\n\nIts reason: ${reason.trim()}` : ''}`,
            agent.id,
          );
        } catch (notifyErr: any) {
          logger.error(
            { agentId: agent.id, err: notifyErr?.message },
            'agent armed itself but the owner was NOT notified',
          );
        }
      }

      const entries = describeTimers(
        updated,
        status,
        agentScheduler.getEntryNextRuns(agent.id),
      ).map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        interval: t.interval,
        timezone: t.timezone ?? 'UTC',
        enabled: t.enabled,
        instruction: t.instruction,
        willFire: !t.blockedBy,
        ...(t.blockedBy ? { blockedBy: t.blockedBy } : {}),
        ...(t.nextRunAt ? { nextRunAt: t.nextRunAt } : {}),
      }));
      const blocked = entries.filter(
        (e) =>
          e.blockedBy === 'agent_not_running' || e.blockedBy === 'trigger_mode',
      );

      // Spelled out for the model, because `ok: true` alone is what it reported as "Done"
      // while nothing was going to run.
      // First sentence always says whether the agent is on. A bare `switchedOn: false`
      // (meaning "this call did not switch you on") read to GLM as "you are off" when it
      // was already running, and it looped: set timers, switch on, set timers again.
      const summary = [
        status === 'running'
          ? armedNow
            ? 'You were off, so you have been switched ON — your timers are live.'
            : 'You are ON — your timers are live. Nothing else to switch on.'
          : null,
        blocked.some((e) => e.blockedBy === 'agent_not_running')
          ? `Saved, but you are ${status}, so NOTHING on this schedule will run until your owner starts you. ` +
            'Tell them that; do not report the schedule as active.'
          : null,
        blocked.some((e) => e.blockedBy === 'trigger_mode')
          ? `Your triggerMode is ${updated.config.triggerMode}, which suppresses these entries: ` +
            blocked
              .filter((e) => e.blockedBy === 'trigger_mode')
              .map((e) => e.name ?? e.type)
              .join(', ') +
            ". Pass triggerMode: 'scheduled' if they are meant to run."
          : null,
        entries.some((e) => e.enabled && !e.instruction)
          ? 'Timers without an instruction only say "run your work cycle" when they fire — give each ' +
            'job its own timer with an instruction so a run knows which job it is.'
          : null,
        'A timer with no timezone reads its cron in UTC.',
      ]
        .filter(Boolean)
        .join(' ');

      const next = agentScheduler.getNextCycle(agent.id);
      res.json({
        ok: true,
        status,
        on: status === 'running',
        switchedOnNow: armedNow,
        schedule: entries,
        triggerMode: updated.config.triggerMode ?? 'scheduled',
        nextCycle:
          next && status === 'running'
            ? { type: next.type, dueAt: next.dueAt.toISOString() }
            : null,
        summary,
        ...(warning ? { warning } : {}),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/one-off — schedule a single future run ─────────

selfManageRouter.post(
  '/:id/self/one-off',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;
      // A one-off IS scheduling, so it answers to the same grant. Leaving it open meant
      // an agent locked down with `grants: []` could still queue future runs.

      const {
        at,
        cycleType = 'custom',
        instruction,
      } = req.body as {
        at?: string;
        cycleType?: string;
        instruction?: string;
      };

      if (typeof at !== 'string' || !at.trim()) {
        return res.status(422).json({
          error:
            'at is required (ISO 8601 instant, e.g. 2026-08-22T13:00:00+05:30)',
        });
      }
      const atMs = Date.parse(at);
      if (Number.isNaN(atMs)) {
        return res.status(422).json({
          error: `Could not parse "${at}" as a date. Use ISO 8601 with an offset.`,
        });
      }
      // A past timestamp usually means the agent resolved "1pm" against the wrong day or
      // zone. Firing immediately would hide that; refusing surfaces it while it is fixable.
      if (atMs <= Date.now()) {
        return res.status(422).json({
          error: `"${at}" is in the past. Include a UTC offset so there is no ambiguity.`,
        });
      }
      if (atMs - Date.now() > MAX_ONE_OFF_HORIZON_MS) {
        return res.status(422).json({
          error: 'One-off runs cannot be scheduled more than 90 days ahead.',
        });
      }
      if (!VALID_CYCLE_TYPES.includes(cycleType as CycleType)) {
        return res.status(422).json({
          error: `Unknown cycle type "${cycleType}". Valid types: ${VALID_CYCLE_TYPES.join(', ')}`,
        });
      }

      const existing = agent.config.oneOffRuns ?? [];
      if (existing.length >= MAX_ONE_OFFS_PER_AGENT) {
        return res.status(422).json({
          error: `Already ${existing.length} one-off runs queued (max ${MAX_ONE_OFFS_PER_AGENT}). Cancel one first.`,
        });
      }

      const run: OneOffRun = {
        id: randomUUID(),
        at: new Date(atMs).toISOString(),
        cycleType: cycleType as CycleType,
        ...(instruction
          ? { instruction: String(instruction).slice(0, 4000) }
          : {}),
        createdAt: new Date().toISOString(),
        createdBy: 'agent',
      };

      await agentService.updateAgent(agent.id, {
        config: { oneOffRuns: [...existing, run] } as AgentConfig,
      });

      auditSelfChange(
        req,
        agent.id,
        'one_off',
        { oneOffRuns: existing },
        auditSnapshot(agent.id, 'one_off'),
        (req.body as { reason?: unknown }).reason,
      );
      logger.info(
        { agentId: agent.id, runId: run.id, at: run.at },
        'Agent scheduled a one-off run',
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      res.status(201).json({ ok: true, run });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── DELETE /api/agents/:id/self/one-off/:runId ───────────────────────────────

selfManageRouter.delete(
  '/:id/self/one-off/:runId',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const existing = agent.config.oneOffRuns ?? [];
      const remaining = existing.filter((r) => r.id !== req.params.runId);
      if (remaining.length === existing.length) {
        return res
          .status(404)
          .json({ error: `No queued one-off run with id ${req.params.runId}` });
      }

      await agentService.updateAgent(agent.id, {
        config: { oneOffRuns: remaining } as AgentConfig,
      });
      auditSelfChange(
        req,
        agent.id,
        'one_off',
        { oneOffRuns: existing },
        auditSnapshot(agent.id, 'one_off'),
        (req.body as { reason?: unknown })?.reason,
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      res.json({ ok: true, remaining });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/model ──────────────────────────────────────────

selfManageRouter.post(
  '/:id/self/model',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { model, subagentModel, thinking, taskModels, reason } =
        req.body as {
          model?: string;
          subagentModel?: string;
          thinking?: boolean;
          taskModels?: Record<string, string | null>;
          reason?: unknown;
        };
      const beforeModel = auditSnapshot(agent.id, 'model');

      // Allowlist = the models this platform is actually configured to route. A model
      // id the proxy has never heard of does not fail here, it fails on every future
      // cycle — and an agent that has broken its own model cannot run a cycle to fix it.
      const cfg = getModelConfig();
      const known = new Set<string>([
        cfg.defaultModel,
        ...cfg.fallbackChain,
        ...Object.values(cfg.taskModels ?? {}),
      ]);

      const patch: Partial<AgentConfig> = {};
      const unknownModels: string[] = [];
      for (const [field, value] of [
        ['model', model],
        ['subagent_model', subagentModel],
      ] as const) {
        if (value === undefined) continue;
        // A model the proxy has never heard of does not fail here, it fails on every
        // future cycle — and an agent that has broken its own model cannot run a cycle
        // to fix it. That is a BRICKING risk, not a security one, so the answer is a
        // way back rather than a wall: probe it once now, and if it answers, allow it.
        if (!known.has(value)) {
          const reachable = await probeModel(value);
          if (!reachable) {
            return res.status(422).json({
              error:
                `Model "${value}" did not answer a test call, so it was not applied — ` +
                'setting it would have broken every future cycle, including the one ' +
                'you would need to undo it.',
              availableModels: [...known].sort(),
            });
          }
          unknownModels.push(value);
        }
        (patch as Record<string, unknown>)[field] = value;
      }
      if (thinking !== undefined) {
        if (typeof thinking !== 'boolean')
          return res.status(422).json({ error: 'thinking must be a boolean' });
        patch.thinking_enabled = thinking;
      }
      // Per-task overrides (the Models tab's task table). Same probe as above: a model
      // that cannot answer would break every cycle of that task type. null drops one.
      if (taskModels !== undefined) {
        if (
          typeof taskModels !== 'object' ||
          taskModels === null ||
          Array.isArray(taskModels)
        ) {
          return res.status(422).json({
            error: 'taskModels must be an object of {taskType: model | null}',
          });
        }
        const merged: Record<string, string> = {
          ...(agent.config.task_models ?? {}),
        };
        for (const [task, m] of Object.entries(taskModels)) {
          if (m === null) {
            delete merged[task];
            continue;
          }
          if (typeof m !== 'string' || !m.trim())
            return res
              .status(422)
              .json({ error: `taskModels.${task} must be a model id or null` });
          if (!known.has(m) && !(await probeModel(m))) {
            return res.status(422).json({
              error: `Model "${m}" for ${task} did not answer a test call, so it was not applied.`,
              availableModels: [...known].sort(),
            });
          }
          if (!known.has(m)) unknownModels.push(m);
          merged[task] = m;
        }
        patch.task_models = merged;
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error:
            'Nothing to change: pass model, subagentModel, thinking and/or taskModels',
        });
      }

      const updated = await agentService.updateAgent(agent.id, {
        config: patch as AgentConfig,
      });
      auditSelfChange(
        req,
        agent.id,
        'model',
        beforeModel,
        auditSnapshot(agent.id, 'model'),
        reason,
      );
      logger.info(
        { agentId: agent.id, patch },
        'Agent changed its own model settings',
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      res.json({
        ok: true,
        model: updated.config.model ?? cfg.defaultModel,
        subagentModel: updated.config.subagent_model ?? null,
        thinking: updated.config.thinking_enabled ?? null,
        taskModels: updated.config.task_models ?? {},
        note: 'Takes effect on the NEXT cycle — the current cycle keeps the model it started on.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/budget ─────────────────────────────────────────

selfManageRouter.post(
  '/:id/self/budget',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { daily, monthly, onExhaust, reason } = req.body as {
        daily?: number;
        monthly?: number;
        onExhaust?: string;
        reason?: unknown;
      };
      const beforeBudget = auditSnapshot(agent.id, 'budget');
      const ceiling = ceilingsFor(agent);

      const next = { ...agent.config.budget };

      if (daily !== undefined) {
        if (
          typeof daily !== 'number' ||
          !Number.isFinite(daily) ||
          daily <= 0
        ) {
          return res
            .status(422)
            .json({ error: 'daily must be a positive number (USD)' });
        }
        if (daily > ceiling.daily && !ruleAllows(agent, 'budget_raise')) {
          // Do not leave the agent at a dead end. The old failure mode was an agent
          // hitting the wall, writing "I could not raise my budget" into a summary
          // nobody reads, and carrying on degraded — so put the ask in front of the
          // owner, carrying the agent's own reason.
          const checkinId = deferToApproval(
            agent.id,
            'budget',
            `Wants its daily budget raised from $${agent.config.budget.daily} to $${daily}. ` +
              `Its self-service ceiling is $${ceiling.daily}.`,
            { patch: { budget: { ...agent.config.budget, daily } } },
            reason,
          );
          return res.status(200).json({
            ok: false,
            status: 'pending_approval',
            checkinId,
            error:
              `Your self-service ceiling is $${ceiling.daily}/day, so this was not applied. ` +
              `Your owner has been asked. Do not report the raise as done.`,
          });
        }
        next.daily = daily;
      }
      if (monthly !== undefined) {
        if (
          typeof monthly !== 'number' ||
          !Number.isFinite(monthly) ||
          monthly <= 0
        ) {
          return res
            .status(422)
            .json({ error: 'monthly must be a positive number (USD)' });
        }
        if (monthly > ceiling.monthly && !ruleAllows(agent, 'budget_raise')) {
          const checkinId = deferToApproval(
            agent.id,
            'budget',
            `Wants its monthly budget raised from $${agent.config.budget.monthly} to $${monthly}. ` +
              `Its self-service ceiling is $${ceiling.monthly}.`,
            { patch: { budget: { ...agent.config.budget, monthly } } },
            reason,
          );
          return res.status(200).json({
            ok: false,
            status: 'pending_approval',
            checkinId,
            error:
              `Your self-service ceiling is $${ceiling.monthly}/month, so this was not applied. ` +
              `Your owner has been asked. Do not report the raise as done.`,
          });
        }
        next.monthly = monthly;
      }
      if (onExhaust !== undefined) {
        if (onExhaust !== 'pause' && onExhaust !== 'alert') {
          return res
            .status(422)
            .json({ error: "onExhaust must be 'pause' or 'alert'" });
        }
        next.onExhaust = onExhaust;
      }

      const updated = await agentService.updateAgent(agent.id, {
        config: { budget: next } as AgentConfig,
      });
      auditSelfChange(
        req,
        agent.id,
        'budget',
        beforeBudget,
        auditSnapshot(agent.id, 'budget'),
        reason,
      );
      logger.info(
        { agentId: agent.id, budget: next },
        'Agent changed its own budget',
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      res.json({ ok: true, budget: updated.config.budget });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/status ─────────────────────────────────────────

selfManageRouter.post('/:id/self/status', (req: Request, res: Response) => {
  try {
    const agent = getAgentOr404(req, res);
    if (!agent) return;

    const { status, reason } = req.body as {
      status?: string;
      reason?: unknown;
    };
    const beforeStatus = auditSnapshot(agent.id, 'status');

    // No value = "am I on?". Models reach for `status` to check before acting, and an
    // error here sent them round again.
    if (status === undefined || status === null || status === '') {
      const current = agentService.getSettledStatus(agent.id) ?? agent.status;
      return res.json({
        ok: true,
        status: current,
        on: current === 'running',
        note:
          current === 'running'
            ? 'You are ON — your timers fire by themselves.'
            : `You are ${current} — no timer fires until you are switched on.`,
      });
    }
    if (status !== 'running' && status !== 'paused' && status !== 'stopped') {
      return res.status(422).json({
        error:
          "status must be 'running' (enable scheduled cycles), 'paused' (stop them), " +
          "or 'stopped' (stop them and require a human to restart you). " +
          "'idle' and 'error' are runtime states the orchestrator owns.",
      });
    }

    // `stopped` is the one an agent cannot lift for itself. Without this, every way of
    // parking an agent was symmetric — it could always undo it — so there was no
    // setting that meant "stay off until a person says otherwise".
    if (agent.status === 'stopped' && status !== 'stopped') {
      return res.status(403).json({
        error:
          'You were stopped by your owner. Only they can start you again. ' +
          'Say so rather than trying another route.',
      });
    }

    agentService.setSelfStatus(agent.id, status);

    // Audit BEFORE the scheduler resync: arming can return early with a warning, and a
    // status change that armed the agent but was never recorded is precisely the gap
    // this table exists to close.
    auditSelfChange(
      req,
      agent.id,
      'status',
      beforeStatus,
      auditSnapshot(agent.id, 'status'),
      reason,
    );

    // Arm or disarm the in-memory scheduler to match, exactly as start/pause do.
    // Without this the DB says 'running' while the scheduler holds no entry, and
    // the agent stays silently unscheduled until the next restart.
    let warning: string | null = null;
    if (status === 'running') {
      warning = resyncSchedule(agent.id, agent.config);
    } else {
      agentScheduler.unregister(agent.id);
    }

    // Arming is the capability that restarts autonomous operation, and it was the only
    // uncapped, unannounced one. It stays uncapped — telling the owner is worth more
    // here than stopping the agent — but it no longer happens quietly, and the agent is
    // told what it just switched on. A model that meant "run once" can then see it did
    // something larger, instead of discovering it from the bill.
    const next = agentScheduler.getNextCycle(agent.id);
    const armed =
      status === 'running'
        ? (agent.config.schedule ?? []).filter(
            (e) => e.enabled && e.interval?.toLowerCase() !== 'manual',
          )
        : [];

    // Wrapped for the same reason the audit write is: telling somebody about a change
    // must not be able to fail the change. A notification backend having a moment
    // would otherwise 500 a status flip the agent has already made, leaving the DB and
    // the response disagreeing about whether it is armed.
    try {
      notify(
        'agent_alert',
        `${agent.name} set itself to ${status}`,
        status === 'running'
          ? `It armed ${armed.length} schedule entr${armed.length === 1 ? 'y' : 'ies'}` +
              `${armed.length ? ` (${armed.map((e) => `${e.type} ${e.interval}`).join(', ')})` : ''}` +
              `${next ? `. Next: ${next.type} at ${next.dueAt.toISOString()}` : '.'}` +
              `${
                typeof reason === 'string' && reason.trim()
                  ? `

Its reason: ${reason.trim()}`
                  : ''
              }`
          : `Scheduled cycles are off.${typeof reason === 'string' && reason.trim() ? ` Its reason: ${reason.trim()}` : ''}`,
        agent.id,
      );
    } catch (notifyErr: any) {
      logger.error(
        { agentId: agent.id, err: notifyErr?.message },
        'status changed but the owner was NOT notified',
      );
    }

    logger.info(
      { agentId: agent.id, status, armed: armed.length },
      'Agent changed its own status',
    );
    res.json({
      ok: true,
      status,
      ...(warning ? { warning } : {}),
      armedEntries: armed.map((e) => ({ type: e.type, interval: e.interval })),
      nextCycle: next
        ? { type: next.type, dueAt: next.dueAt.toISOString() }
        : null,
      ...(status === 'running' && armed.length > 1
        ? {
            note:
              `You are now running ${armed.length} recurring schedules, not a single cycle. ` +
              'If you only meant to run once, use run_once and set yourself back to paused.',
          }
        : {}),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The owner's "don't ask" rule covering this held change, or null to hold it as before.
 * Credentials and approval-rule changes never reach here: they have no rule action.
 */
function ruleAllows(
  agent: { id?: string; owner_id?: string | null; config: AgentConfig },
  action: ApprovalAction,
  ctx: ApprovalContext = {},
): ApprovalRule | null {
  // Stage 57: after reading worker results (web data), held changes wait for the owner.
  if (agent.id && isTaintedByWorkerData(agent.id)) return null;
  const ownerEmail = agent.owner_id
    ? (getUserById(agent.owner_id)?.email ?? null)
    : null;
  const rule = evaluateApproval(
    agent.config.approvalRules,
    action,
    ctx,
    ownerEmail,
  );
  return rule?.decision === 'auto' ? rule : null;
}

// ─── Held changes ─────────────────────────────────────────────────────────────
//
// Every agent may change everything on this router about itself. The per-agent grants and
// the "always ask first" list (stage 54) were removed on 2026-09-14 at the owner's request.
// What still goes to a check-in is a short, fixed list, each for a reason of its own:
// raising a budget past its ceiling, granting itself a tool that reaches a person outside
// the system, asking for a credential, and the two data-loss guards — an identity edit that
// deletes over 30% of the text, and removing a tracker stage that still holds rows.

/**
 * Park a change behind a human check-in instead of applying it.
 *
 * Returns the check-in id. The agent is TOLD this happened — a silent no-op reads to a
 * model as success, and it will report the change as done.
 */
function deferToApproval(
  agentId: string,
  grant: SelfGrant,
  summary: string,
  payload: unknown,
  reason: unknown,
): string {
  // Use the id createAgentCheckin returns, not one made up here — it generates its own
  // and ignores anything passed in. Reporting a locally-minted uuid handed the agent a
  // reference to a row that does not exist, and left the owner unable to correlate the
  // check-in with the message that announced it. Caught on the first live run.
  const created = createAgentCheckin({
    agent_id: agentId,
    status: 'pending',
    report_md:
      `## Self-change awaiting your approval: ${grant}\n\n${summary}\n\n` +
      `**Agent's reason:** ${typeof reason === 'string' && reason.trim() ? reason.trim() : '_none given_'}`,
    action_type: 'self_change',
    action_payload: JSON.stringify({
      agentId,
      grant,
      ...(payload as Record<string, unknown>),
    }),
    created_at: new Date().toISOString(),
  } as Parameters<typeof createAgentCheckin>[0]);
  getSocketIO()?.emit('agent:checkin_created', {
    agentId,
    checkinId: created.id,
  });
  return created.id;
}

// ─── POST /api/agents/:id/self/identity ───────────────────────────────────────
//
// Field-scoped on purpose. There is no "replace the whole document" form here, because
// an agent that can only replace a document will eventually replace it with less than it
// had — which is exactly what happened on 2026-08-28, by accident, via a parser. The
// same outcome reachable deliberately is not an improvement.

selfManageRouter.post(
  '/:id/self/identity',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { goals, role, personality, promptSection, reason } = req.body as {
        goals?: unknown;
        role?: unknown;
        personality?: unknown;
        promptSection?: { section?: unknown; content?: unknown };
        reason?: unknown;
      };

      const patch: Partial<AgentConfig> = {};
      if (goals !== undefined) {
        if (typeof goals !== 'string' || !goals.trim())
          return res
            .status(422)
            .json({ error: 'goals must be a non-empty string' });
        patch.goals = goals.trim().slice(0, 4000);
      }
      if (role !== undefined) {
        if (typeof role !== 'string' || !role.trim())
          return res
            .status(422)
            .json({ error: 'role must be a non-empty string' });
        patch.role = role.trim().slice(0, 200);
      }
      if (personality !== undefined) {
        if (typeof personality !== 'object' || personality === null)
          return res
            .status(422)
            .json({ error: 'personality must be an object' });
        patch.personality = personality as AgentConfig['personality'];
      }

      // A system prompt is edited one named section at a time. `## LEARNED` is excluded
      // because self_improve owns it; two writers over one section race and the loser's
      // work vanishes without either noticing.
      if (promptSection !== undefined) {
        const name = String(promptSection.section ?? '').trim();
        const body = String(promptSection.content ?? '');
        if (!name)
          return res
            .status(422)
            .json({ error: 'promptSection.section is required' });
        if (/^learned$/i.test(name)) {
          return res.status(422).json({
            error:
              'The LEARNED section belongs to your self_improve cycles. Edit any other section.',
          });
        }
        const current = agent.config.customSystemPrompt;
        if (!current?.content) {
          return res.status(422).json({
            error:
              'You have no custom system prompt to edit. Change your goals instead.',
          });
        }
        const re = new RegExp(
          `(^|\\n)(##+\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`,
          'i',
        );
        if (!re.test(current.content)) {
          const headings = [...current.content.matchAll(/^##+\s*(.+)$/gm)].map(
            (m) => m[1].trim(),
          );
          return res.status(422).json({
            error: `No section "${name}" in your system prompt.`,
            sections: headings,
          });
        }
        patch.customSystemPrompt = {
          ...current,
          content: current.content.replace(
            re,
            (_m, lead, heading) => `${lead}${heading}${body.trim()}\n`,
          ),
        };
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error:
            'Nothing to change: pass goals, role, personality and/or promptSection',
        });
      }

      // A change that removes a lot is escalated whatever the grants say. This is the
      // cheap check that would have caught the 2026-08-28 loss on the spot.
      const beforeSize = JSON.stringify({
        goals: agent.config.goals,
        role: agent.config.role,
        prompt: agent.config.customSystemPrompt?.content,
      }).length;
      const afterSize = JSON.stringify({
        goals: patch.goals ?? agent.config.goals,
        role: patch.role ?? agent.config.role,
        prompt: (patch.customSystemPrompt ?? agent.config.customSystemPrompt)
          ?.content,
      }).length;
      const shrinkPct =
        beforeSize > 0 ? (beforeSize - afterSize) / beforeSize : 0;

      if (shrinkPct > 0.3 && !ruleAllows(agent, 'identity_rewrite')) {
        const why = `This removes ${Math.round(shrinkPct * 100)}% of the agent's identity text (${beforeSize} → ${afterSize} bytes).`;
        const checkinId = deferToApproval(
          agent.id,
          'identity',
          `${why}\n\nFields: ${Object.keys(patch).join(', ')}`,
          { patch },
          reason,
        );
        return res.json({
          ok: false,
          status: 'pending_approval',
          checkinId,
          message:
            `Not applied yet — this needs your owner's approval. ${why} ` +
            'They will see the diff. Do not report the change as done.',
        });
      }

      const before = auditSnapshot(agent.id, 'identity');
      const updated = await agentService.updateAgent(agent.id, {
        config: patch as AgentConfig,
      });
      auditSelfChange(
        req,
        agent.id,
        'identity',
        before,
        auditSnapshot(agent.id, 'identity'),
        reason,
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });

      res.json({
        ok: true,
        goals: updated.config.goals,
        role: updated.config.role ?? null,
        note: 'IDENTITY.md has been regenerated. It takes effect on your NEXT cycle.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/workspace ──────────────────────────────────────

selfManageRouter.post(
  '/:id/self/workspace',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { pins, dirs, reason } = req.body as {
        pins?: unknown;
        dirs?: unknown;
        reason?: unknown;
      };
      const patch: Partial<AgentConfig> = {};
      const wsRoot = path.join(DATA_DIR, 'agents', agent.id, 'workspace');

      // Validate on write. A pin is injected into every cycle's context, so a dangling
      // one is a live cost, not a latent typo — Crawler carried 8 pins to deleted
      // files and a workspace dir that never existed at any point, and IDENTITY.md told
      // it to use that folder every cycle.
      if (pins !== undefined) {
        if (!Array.isArray(pins) || !pins.every((p) => typeof p === 'string')) {
          return res.status(422).json({
            error: 'pins must be an array of workspace-relative paths',
          });
        }
        const missing = (pins as string[]).filter((p) => {
          const abs = path.resolve(wsRoot, p);
          return !abs.startsWith(wsRoot) || !fs.existsSync(abs);
        });
        if (missing.length) {
          return res.status(422).json({
            error: 'These pins do not resolve inside your workspace',
            missing,
          });
        }
        patch.pins = pins as string[];
      }

      if (dirs !== undefined) {
        if (!Array.isArray(dirs))
          return res
            .status(422)
            .json({ error: 'dirs must be an array of {name}' });
        const names = (dirs as Array<{ name?: unknown }>)
          .map((d) => String(d?.name ?? '').trim())
          .filter(Boolean);
        if (names.some((n) => n.includes('..') || path.isAbsolute(n))) {
          return res.status(422).json({
            error: 'Directory names must be simple, workspace-relative names',
          });
        }
        for (const n of names)
          fs.mkdirSync(path.join(wsRoot, n), { recursive: true });
        patch.customWorkspaceDirs = names.map((name) => ({ name }));
      }

      if (Object.keys(patch).length === 0) {
        return res
          .status(400)
          .json({ error: 'Nothing to change: pass pins and/or dirs' });
      }

      const before = auditSnapshot(agent.id, 'workspace');
      const updated = await agentService.updateAgent(agent.id, {
        config: patch as AgentConfig,
      });
      auditSelfChange(
        req,
        agent.id,
        'workspace',
        before,
        auditSnapshot(agent.id, 'workspace'),
        reason,
      );
      res.json({
        ok: true,
        pins: updated.config.pins ?? [],
        dirs: updated.config.customWorkspaceDirs ?? [],
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/rename ─────────────────────────────────────────
//
// A name is an ADDRESS, not a label: handoff_to takes to_agent_id="Finder". Renaming
// breaks every reference written against the old name — in other agents' prompts, in
// their learned bullets, in workspace files — none of which update. Finder has sent 133
// handoffs and received 214. So the rename reports what it just broke rather than
// pretending a name is cosmetic.

selfManageRouter.post(
  '/:id/self/rename',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { name, reason } = req.body as { name?: unknown; reason?: unknown };
      const next = String(name ?? '').trim();
      if (!next) return res.status(422).json({ error: 'name is required' });
      if (next.length > 60)
        return res
          .status(422)
          .json({ error: 'name must be 60 characters or fewer' });
      if (next === agent.name)
        return res.status(400).json({ error: 'That is already your name' });

      const siblings = dbGetAllAgents().filter(
        (a) => a.id !== agent.id && a.owner_id === agent.owner_id,
      );
      if (siblings.some((a) => a.name.toLowerCase() === next.toLowerCase())) {
        return res.status(409).json({
          error: `Another of your owner's agents is already called "${next}".`,
        });
      }

      // Who addresses this agent by its old name today.
      const referrers = siblings
        .filter((a) => {
          const hay = [
            a.config.goals ?? '',
            a.config.customSystemPrompt?.content ?? '',
            ...getLearnedBullets(a.id).map((b) => b.text),
          ].join('\n');
          return new RegExp(
            `\\b${agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i',
          ).test(hay);
        })
        .map((a) => a.name);

      const before = { name: agent.name };
      await agentService.updateAgent(agent.id, { name: next });
      auditSelfChange(req, agent.id, 'name', before, { name: next }, reason);
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });

      res.json({
        ok: true,
        name: next,
        previousName: agent.name,
        ...(referrers.length
          ? {
              warning:
                `${referrers.length} teammate(s) still refer to you as "${agent.name}" in their own ` +
                `instructions: ${referrers.join(', ')}. Handoffs addressed to the old name will not ` +
                `reach you until those are updated — tell your owner.`,
              referrers,
            }
          : {}),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/tracker ────────────────────────────────────────
//
// The risk here is data, not code. The LAST stage in a tracker schema is silently the
// conversion goal, and every tracked row carries a stage string that a schema edit can
// orphan — a row sitting in a stage the schema no longer lists is invisible to the funnel
// and to the agent's own counts.
//
// So adding is free and removing is not: dropping a stage that has rows in it goes to the
// owner with the row count attached, whatever the grants say.

selfManageRouter.post(
  '/:id/self/tracker',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { schema, reason } = req.body as {
        schema?: unknown;
        reason?: unknown;
      };
      const normalised = normaliseTrackerSchema(schema);
      if (!normalised) {
        return res.status(422).json({
          error: 'schema needs a name plus at least one stage and one field',
        });
      }

      const existing = getEntitySchema(agent.id);
      const before = existing
        ? {
            name: existing.name,
            stages: existing.stages,
            fields: existing.fields,
          }
        : null;

      // Which stages are disappearing, and how much lives in them. Stages are objects;
      // the `key` is what a tracked row actually stores.
      const oldKeys = (existing?.stages ?? []).map((st) => st.key);
      const newKeys = new Set(normalised.stages.map((st) => st.key));
      const orphanCounts = oldKeys
        .filter((k) => !newKeys.has(k))
        .map((k) => ({ stage: k, rows: countTrackedItemsInStage(agent.id, k) }))
        .filter((d) => d.rows > 0);

      if (
        orphanCounts.length > 0 &&
        !ruleAllows(agent, 'tracker_stage_delete')
      ) {
        const summary = orphanCounts
          .map((d) => `${d.rows} row(s) in "${d.stage}"`)
          .join(', ');
        const checkinId = deferToApproval(
          agent.id,
          'tracker',
          `Removing stage(s) that still hold data: ${summary}.\n\n` +
            `Stages before: ${oldKeys.join(' → ')}\nStages after: ${[...newKeys].join(' → ')}`,
          { trackerSchema: normalised },
          reason,
        );
        return res.json({
          ok: false,
          status: 'pending_approval',
          checkinId,
          message:
            `Not applied — this removes stage(s) that still hold rows (${summary}), ` +
            'so it needs your owner. Do not report the change as done.',
          orphaned: orphanCounts,
        });
      }

      upsertEntitySchema(agent.id, normalised);
      auditSelfChange(
        req,
        agent.id,
        'tracker',
        before,
        {
          name: normalised.name,
          stages: normalised.stages,
          fields: normalised.fields,
        },
        reason,
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });

      res.json({
        ok: true,
        schema: normalised,
        note: normalised.stages.length
          ? `The last stage ("${normalised.stages[normalised.stages.length - 1].key}") is what counts as converted.`
          : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/tools ──────────────────────────────────────────
//
// Every agent already holds every tool except the outbound ones (see tool-grants.ts), so
// what this changes is what the agent sees from turn one — and, for an outbound tool,
// whether it may use it at all. Those need the owner: everything internal is revertible
// from the history tab, and an email is not.

selfManageRouter.post(
  '/:id/self/tools',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { add, remove, reason } = req.body as {
        add?: unknown;
        remove?: unknown;
        reason?: unknown;
      };
      const toAdd = Array.isArray(add)
        ? (add.filter((t) => typeof t === 'string') as string[])
        : [];
      const toRemove = Array.isArray(remove)
        ? (remove.filter((t) => typeof t === 'string') as string[])
        : [];
      if (toAdd.length === 0 && toRemove.length === 0) {
        return res
          .status(400)
          .json({ error: 'Nothing to change: pass add and/or remove' });
      }

      // Removing one of these does not restrict the agent, it breaks it — it could no
      // longer read its workspace, record what it did, or say it was stuck.
      const refusedRemovals = toRemove.filter((t) => ALWAYS_GRANTED.has(t));
      if (refusedRemovals.length) {
        return res.status(422).json({
          error:
            'These are needed for you to function at all and cannot be dropped.',
          refused: refusedRemovals,
        });
      }

      const gated = ruleAllows(agent, 'tool_grant')
        ? []
        : toAdd.filter((t) => OUTBOUND_TOOLS.has(t));
      if (gated.length) {
        const checkinId = deferToApproval(
          agent.id,
          'tools',
          `Wants to grant itself ${gated.join(', ')} — tool(s) that contact people outside ` +
            `the system. Everything else it asked for has been applied.`,
          {
            patch: {
              tools: [
                ...new Set([...(agent.config.tools ?? []), ...toAdd]),
              ].sort(),
            },
          },
          reason,
        );
        // Apply the safe half now rather than making the whole request wait on one
        // gated tool — an agent blocked on an unrelated approval learns to ask for
        // less than it needs.
        const safe = toAdd.filter((t) => !OUTBOUND_TOOLS.has(t));
        const next = [...new Set([...(agent.config.tools ?? []), ...safe])]
          .filter((t) => !toRemove.includes(t))
          .sort();
        const before = { tools: [...(agent.config.tools ?? [])].sort() };
        await agentService.updateAgent(agent.id, {
          config: { tools: next } as AgentConfig,
        });
        auditSelfChange(
          req,
          agent.id,
          'tools',
          before,
          { tools: next },
          reason,
        );

        return res.json({
          ok: true,
          tools: next,
          pendingApproval: { checkinId, tools: gated },
          message:
            `${gated.join(', ')} reach people outside the system, so those need your ` +
            'owner. Do not report them as available yet.',
        });
      }

      const before = { tools: [...(agent.config.tools ?? [])].sort() };
      const next = [...new Set([...(agent.config.tools ?? []), ...toAdd])]
        .filter((t) => !toRemove.includes(t))
        .sort();
      const updated = await agentService.updateAgent(agent.id, {
        config: { tools: next } as AgentConfig,
      });
      auditSelfChange(req, agent.id, 'tools', before, { tools: next }, reason);
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });

      res.json({ ok: true, tools: updated.config.tools });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/credentials ────────────────────────────────────
//
// An agent can hold and USE a credential without the secret entering its context, and
// that stays true here: `list` returns names and status, never a value.
//
// The rule matters more than the routes. Once a plaintext key is in a cycle's context it
// is in cycle_steps, in the compaction summary, in the memory distiller's input, possibly
// in a learned bullet, and in the transcript on the dashboard. There is no un-ringing that.
//
// There is also no self-grant at any grant level — not because the agent is untrusted, but
// because a credential is usually not the agent's to give: it is an API key with a bill on
// it, or an OAuth token to somebody's mailbox. Only the owner can consent to that, and a
// check-in makes it one click.

selfManageRouter.post(
  '/:id/self/credentials',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { op, service, reason } = req.body as {
        op?: unknown;
        service?: unknown;
        reason?: unknown;
      };
      const operation = String(op ?? 'list');

      if (operation === 'list') {
        // Names only. SecretSummary carries a `masked` field (last four characters) for
        // the dashboard, and that is dropped here rather than passed through: four
        // characters is not a secret, but a transcript is forever, and there is no
        // question an agent answers better for having seen them.
        const names = [
          ...secretsManager.list({ agentId: agent.id }).map((x) => x.name),
          ...(agent.owner_id
            ? secretsManager
                .list({ ownerId: agent.owner_id })
                .map((x) => x.name)
            : []),
          ...secretsManager.list('global').map((x) => x.name),
        ];
        const services = [...new Set(names.map((n) => n.toLowerCase()))].sort();
        return res.json({
          ok: true,
          available: services.map((service) => ({
            service,
            status: 'available',
          })),
          note:
            'Names only — a secret value is never returned to you, on any code path. ' +
            'Call the tool that needs it and it will be resolved at call time.',
        });
      }

      const name = String(service ?? '')
        .trim()
        .toLowerCase();
      if (!name) return res.status(422).json({ error: 'service is required' });

      if (operation === 'request') {
        const checkinId = deferToApproval(
          agent.id,
          'credentials',
          `Is asking for access to **${name}**.\n\nGranting it means connecting ${name} for this ` +
            `agent in its settings — the agent never sees the value either way.`,
          { credentialRequest: name },
          reason,
        );
        return res.json({
          ok: false,
          status: 'pending_approval',
          checkinId,
          message:
            `Asked your owner for ${name}. You do not have it yet — plan without it, and ` +
            'do not report it as available.',
        });
      }

      if (operation === 'revoke') {
        // Only its own scope. An agent dropping an owner-level or platform credential
        // would be revoking it for every other agent too.
        secretsManager.delete({ agentId: agent.id }, name);
        auditSelfChange(
          req,
          agent.id,
          'credentials',
          { revoked: null },
          { revoked: name },
          reason,
        );
        return res.json({ ok: true, revoked: name });
      }

      res
        .status(422)
        .json({ error: "op must be 'list', 'request' or 'revoke'" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/runtime ────────────────────────────────────────
//
// Stage 55 phase 4. The knobs an agent adapts to its own task — this is the "train
// yourself to lift the weight" case in its most literal form: an agent that notices it is
// losing context mid-task raising its own threshold.
//
// Only meaningful because phase 1 governs the file these land in. permissions, hooks and
// mcp_servers are NOT here and no grant reaches them: they are not self-management, they
// are "run arbitrary code as this container" wearing the same file.
//
// Named fields, not a raw JSON blob — same reason as identity. An agent that can only
// replace a document will eventually replace it with less than it had.

selfManageRouter.post(
  '/:id/self/runtime',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const {
        compactionThresholdTokens,
        compactionKeepTail,
        disableTools,
        reason,
      } = req.body as {
        compactionThresholdTokens?: unknown;
        compactionKeepTail?: unknown;
        disableTools?: unknown;
        reason?: unknown;
      };

      const file = path.join(
        DATA_DIR,
        'agents',
        agent.id,
        '.nanocrew',
        'settings.json',
      );
      let onDisk: Record<string, any> = {};
      try {
        onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        onDisk = {};
      }

      // Carry forward ONLY the keys this route manages. The file is agent-writable, so
      // anything else in it is agent-authored — reading it back wholesale would mean
      // this route, which the owner trusts, rewriting the agent's own
      // `permissions: danger_full_access` into the file under its own hand. The
      // container drops that key at load time either way, but owner-trusted code should
      // not be the thing preserving it. Caught on the first live test.
      const MANAGED = ['compaction', 'tools'] as const;
      const current: Record<string, any> = {};
      for (const k of MANAGED)
        if (onDisk[k] !== undefined) current[k] = onDisk[k];
      const dropped = Object.keys(onDisk).filter(
        (k) => !(MANAGED as readonly string[]).includes(k),
      );
      const before = JSON.parse(JSON.stringify(current));

      if (compactionThresholdTokens !== undefined) {
        const n = Number(compactionThresholdTokens);
        // Floor and ceiling because both ends brick a cycle: too low compacts on every
        // turn and loses the thread, too high never compacts and blows the window.
        if (!Number.isFinite(n) || n < 20_000 || n > 400_000) {
          return res.status(422).json({
            error: 'compactionThresholdTokens must be between 20000 and 400000',
          });
        }
        current.compaction = {
          ...(current.compaction ?? {}),
          threshold_tokens: Math.round(n),
        };
      }
      if (compactionKeepTail !== undefined) {
        const n = Number(compactionKeepTail);
        if (!Number.isFinite(n) || n < 2 || n > 40) {
          return res
            .status(422)
            .json({ error: 'compactionKeepTail must be between 2 and 40' });
        }
        current.compaction = {
          ...(current.compaction ?? {}),
          keep_tail: Math.round(n),
        };
      }
      if (disableTools !== undefined) {
        if (
          !Array.isArray(disableTools) ||
          !disableTools.every((t) => typeof t === 'string')
        ) {
          return res
            .status(422)
            .json({ error: 'disableTools must be an array of tool names' });
        }
        const breaking = (disableTools as string[]).filter((t) =>
          ALWAYS_GRANTED.has(t),
        );
        if (breaking.length) {
          return res.status(422).json({
            error:
              'Disabling these would stop you functioning at all, not restrict you.',
            refused: breaking,
          });
        }
        current.tools = { ...(current.tools ?? {}), disabled: disableTools };
      }

      if (JSON.stringify(before) === JSON.stringify(current)) {
        return res.status(400).json({
          error:
            'Nothing to change: pass compactionThresholdTokens, compactionKeepTail and/or disableTools',
        });
      }

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf-8');
      auditSelfChange(req, agent.id, 'runtime', before, current, reason);
      logger.info(
        { agentId: agent.id },
        'Agent changed its own runtime settings',
      );

      res.json({
        ok: true,
        settings: current,
        ...(dropped.length
          ? {
              removed: dropped,
              warning:
                `Your settings file also contained ${dropped.join(', ')}, which you may not set. ` +
                'Those keys have been removed. Asking again will not work, and your owner is ' +
                'told each time you try.',
            }
          : {}),
        note:
          'Takes effect on your NEXT cycle. Your owner will see what this changed, and ' +
          'your next self_report will show what happened after it.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/settings ───────────────────────────────────────
//
// The per-agent config no other action reached, so an owner could only change it in the
// dashboard. Named fields, validated one by one — never a raw config write.
//
// Two of these widen what the agent can touch outside its container: using the owner's own
// logged-in browser, and posting its events to an outside URL. Turning those ON goes to the
// owner; turning them off does not.

const SETTINGS_NEEDING_OWNER = [
  'useUserBrowser',
  'requireUserBrowser',
  'webhookUrl',
] as const;

selfManageRouter.post(
  '/:id/self/settings',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const b = req.body as Record<string, unknown>;
      const patch: Partial<AgentConfig> = {};

      if (b.icp !== undefined) {
        if (b.icp !== null && typeof b.icp !== 'string')
          return res
            .status(422)
            .json({ error: 'icp must be text (or null to clear it)' });
        // '' rather than undefined: config is merged, and JSON drops undefined, so an
        // undefined here would leave the old ICP in place and report it cleared.
        patch.icp =
          typeof b.icp === 'string' ? b.icp.trim().slice(0, 4000) : '';
      }
      if (b.escalationRules !== undefined) {
        if (
          !Array.isArray(b.escalationRules) ||
          !b.escalationRules.every((r) => typeof r === 'string')
        ) {
          return res
            .status(422)
            .json({ error: 'escalationRules must be a list of sentences' });
        }
        if (b.escalationRules.length > 30)
          return res.status(422).json({ error: 'At most 30 escalation rules' });
        patch.escalationRules = (b.escalationRules as string[])
          .map((r) => r.trim().slice(0, 500))
          .filter(Boolean);
      }
      if (b.wakePolicy !== undefined) {
        if (
          typeof b.wakePolicy !== 'object' ||
          b.wakePolicy === null ||
          Array.isArray(b.wakePolicy)
        ) {
          return res.status(422).json({
            error: `wakePolicy must be an object of {source: true|false}. Sources: ${Object.keys(DEFAULT_WAKE_POLICY).join(', ')}`,
          });
        }
        for (const [src, on] of Object.entries(b.wakePolicy)) {
          if (!(src in DEFAULT_WAKE_POLICY))
            return res.status(422).json({
              error: `Unknown wake source "${src}". Sources: ${Object.keys(DEFAULT_WAKE_POLICY).join(', ')}`,
            });
          if (typeof on !== 'boolean')
            return res
              .status(422)
              .json({ error: `wakePolicy.${src} must be true or false` });
        }
        patch.wakePolicy = {
          ...(agent.config.wakePolicy ?? {}),
          ...(b.wakePolicy as Record<string, boolean>),
        };
      }
      for (const [key, field] of [
        ['whatsappNotifications', 'notifications'],
        ['jobSummary', 'job_summary'],
        ['alwaysHeavy', 'alwaysHeavy'],
        ['useUserBrowser', 'useUserBrowser'],
        ['requireUserBrowser', 'requireUserBrowser'],
      ] as const) {
        if (b[key] === undefined) continue;
        if (typeof b[key] !== 'boolean')
          return res
            .status(422)
            .json({ error: `${key} must be true or false` });
        if (field === 'notifications')
          patch.notifications = {
            ...(agent.config.notifications ?? {}),
            whatsapp: b[key] as boolean,
          };
        else (patch as Record<string, unknown>)[field] = b[key];
      }
      if (b.webhookUrl !== undefined) {
        if (b.webhookUrl === null || b.webhookUrl === '') {
          (patch as Record<string, unknown>).webhookUrl = '';
        } else {
          let ok = false;
          try {
            ok = ['http:', 'https:'].includes(
              new URL(String(b.webhookUrl)).protocol,
            );
          } catch {
            /* invalid */
          }
          if (!ok)
            return res.status(422).json({
              error: 'webhookUrl must be an http(s) URL, or null to clear it',
            });
          patch.webhookUrl = String(b.webhookUrl);
        }
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error:
            'Nothing to change: pass icp, escalationRules, wakePolicy, whatsappNotifications, ' +
            'jobSummary, alwaysHeavy, useUserBrowser, requireUserBrowser and/or webhookUrl',
        });
      }

      // Split off what widens reach — only when it is being switched ON.
      const held: Partial<AgentConfig> = {};
      const reachAllowed = !!ruleAllows(agent, 'reach_setting');
      for (const k of reachAllowed ? [] : SETTINGS_NEEDING_OWNER) {
        const v = (patch as Record<string, unknown>)[k];
        if (
          v === true ||
          (k === 'webhookUrl' &&
            typeof v === 'string' &&
            v !== '' &&
            v !== agent.config.webhookUrl)
        ) {
          (held as Record<string, unknown>)[k] = v;
          delete (patch as Record<string, unknown>)[k];
        }
      }
      let pendingApproval:
        | { checkinId: string; settings: string[] }
        | undefined;
      if (Object.keys(held).length) {
        const checkinId = deferToApproval(
          agent.id,
          'settings',
          `Wants to turn on: ${Object.entries(held)
            .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
            .join(', ')}. ` +
            'These let it act outside its own container (your logged-in browser, or posting its events to an outside URL).',
          { patch: held },
          b.reason,
        );
        pendingApproval = { checkinId, settings: Object.keys(held) };
      }

      let updated = agent;
      if (Object.keys(patch).length) {
        const before = auditSnapshot(agent.id, 'settings');
        updated = await agentService.updateAgent(agent.id, {
          config: patch as AgentConfig,
        });
        auditSelfChange(
          req,
          agent.id,
          'settings',
          before,
          auditSnapshot(agent.id, 'settings'),
          b.reason,
        );
        getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      }

      res.json({
        ok: true,
        applied: Object.keys(patch),
        settings: auditSnapshot(updated.id, 'settings'),
        ...(pendingApproval
          ? {
              pendingApproval,
              message:
                `${pendingApproval.settings.join(', ')} need your owner — a check-in has been sent. ` +
                'Do not report them as on yet.',
            }
          : {}),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/approvals ──────────────────────────────────────
//
// The agent reading and changing its own approval rules, so the owner can say "don't ask me
// before emailing me" in chat instead of finding a settings page.
//
// Which DIRECTION matters, not whether the agent may touch the rules at all. Tightening
// ("always ask before X") is always allowed. Loosening ("stop asking") is allowed only in a
// run the owner started themselves — a chat or WhatsApp message (agent_cycles.human_requested)
// — and the owner is notified with the rule, so a wrong one is one click to undo. From any
// other run (a timer, a handoff) loosening becomes a check-in: an agent must not be able to
// talk itself, or be talked by a web page it read, out of asking.

selfManageRouter.post(
  '/:id/self/approvals',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;
      const { op, rule, ruleId, reason } = req.body as {
        op?: string;
        rule?: unknown;
        ruleId?: string;
        reason?: unknown;
      };
      const current: ApprovalRule[] = agent.config.approvalRules ?? [];

      if (!op || op === 'list') {
        return res.json({
          ok: true,
          rules: current.map((r) => ({ ...r, reads: describeRule(r) })),
          actions: Object.fromEntries(
            Object.entries(APPROVAL_ACTIONS).map(([k, v]) => [
              k,
              `${v.label} — ${v.desc}`,
            ]),
          ),
          note: "No rule means you ask, as always. 'auto' means you do it without asking.",
        });
      }

      let next: ApprovalRule[];
      let changed: { add?: ApprovalRule; remove?: ApprovalRule };
      if (op === 'add') {
        const err = validateRule(rule);
        if (err) return res.status(422).json({ error: err });
        const made = makeRule(rule as Partial<ApprovalRule>, 'agent');
        // Same action and scope as an existing rule = that rule, updated.
        const sameScope = (r: ApprovalRule) =>
          r.action === made.action &&
          (r.match?.recipient ?? '') === (made.match?.recipient ?? '') &&
          (r.match?.site ?? '') === (made.match?.site ?? '');
        const existing = current.find(sameScope);
        if (existing?.decision === made.decision) {
          return res.status(400).json({
            error: `That rule already exists: ${describeRule(existing)}`,
          });
        }
        next = [
          ...current.filter((r) => !sameScope(r)),
          existing ? { ...made, id: existing.id } : made,
        ];
        changed = { add: made };
      } else if (op === 'remove') {
        const target = current.find((r) => r.id === ruleId);
        if (!target)
          return res
            .status(404)
            .json({ error: `No rule with id "${ruleId}". Call op=list.` });
        next = current.filter((r) => r.id !== ruleId);
        changed = { remove: target };
      } else {
        return res
          .status(422)
          .json({ error: "op must be 'list', 'add' or 'remove'" });
      }

      const label = changed.add
        ? describeRule(changed.add)
        : `removed: ${describeRule(changed.remove!)}`;
      if (isLoosening(changed)) {
        const token = extractCycleToken(
          req.headers.authorization,
          req.headers['x-cycle-token'],
        );
        const cycleId = resolveCycleToken(token)?.cycleId;
        const ownerStarted = !!(
          cycleId && getAgentCycleById(cycleId)?.human_requested
        );
        if (!ownerStarted) {
          const checkinId = deferToApproval(
            agent.id,
            'approvals',
            `Wants to stop asking you before: **${label}**.\n\n` +
              'This was not asked for in a conversation with you, so it needs your OK.',
            { patch: { approvalRules: next } },
            reason,
          );
          return res.json({
            ok: false,
            status: 'pending_approval',
            checkinId,
            message:
              'You can only stop asking for approval when your owner tells you to in a ' +
              'conversation with them. A check-in has been sent — do not act as if the rule exists.',
          });
        }
      }

      const before = { approvalRules: current };
      await agentService.updateAgent(agent.id, {
        config: { approvalRules: next } as AgentConfig,
      });
      auditSelfChange(
        req,
        agent.id,
        'approvals',
        before,
        { approvalRules: next },
        reason,
      );
      getSocketIO()?.emit('agent:updated', { agentId: agent.id });
      if (isLoosening(changed)) {
        try {
          notify(
            'agent_alert',
            `${agent.name} will no longer ask you before: ${label}`,
            "Set from your conversation with it. Undo it in the agent's Approval rules tab, or tell it to start asking again." +
              `${typeof reason === 'string' && reason.trim() ? `\n\nIts reason: ${reason.trim()}` : ''}`,
            agent.id,
          );
        } catch (notifyErr: any) {
          logger.error(
            { agentId: agent.id, err: notifyErr?.message },
            'approval rule loosened but the owner was NOT notified',
          );
        }
      }
      res.json({
        ok: true,
        rules: next.map((r) => ({ ...r, reads: describeRule(r) })),
        message: isLoosening(changed)
          ? `Done: ${label}. Your owner has been notified and can undo it.`
          : `Done: ${label}.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── GET /api/agents/:id/self/webhook — this agent's inbound trigger URL ──────

/**
 * Returns the agent's inbound webhook token and base URL, minting a token the first
 * time if the agent has none.
 *
 * The owner-facing equivalents (`GET /api/webhooks/:agentId`, `POST .../token`) are both
 * `requireAuth + requireOwnedAgent`, so the `register_webhook` tool — which calls them
 * from inside a container with no session cookie — has always received a blanket 401 and
 * never once worked.
 *
 * Creates but never ROTATES. Rotation invalidates whatever the owner has already pasted
 * into GitHub or Stripe, and an agent has no way to know that integration exists; that
 * stays an explicit owner action on the authenticated route.
 */
selfManageRouter.get(
  '/:id/self/webhook',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      let token = agent.config.webhookToken;
      let created = false;
      if (!token) {
        token = randomBytes(24).toString('base64url');
        await agentService.updateAgent(agent.id, {
          config: { webhookToken: token } as AgentConfig,
        });
        created = true;
        logger.info(
          { agentId: agent.id },
          'Agent minted its first inbound webhook token',
        );
      }

      // WEBHOOK_BASE_URL is the externally reachable origin. Falling back to the
      // in-container callback host would hand the agent a URL that only resolves from
      // inside Docker — worse than useless, since it looks like a working URL.
      const base = process.env.WEBHOOK_BASE_URL ?? process.env.APP_URL ?? '';
      res.json({
        token,
        created,
        baseUrl: base ? `${base}/api/webhooks/${agent.id}` : null,
        externalBaseUrlConfigured: !!base,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/self/whatsapp — send a WhatsApp message ─────────────

selfManageRouter.post(
  '/:id/self/whatsapp',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { message } = req.body as { message?: string };
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(422).json({ error: 'message is required' });
      }

      // Deliberately no caller-supplied destination. The agent may only write to the
      // chat its owner already bound it to, which makes this a reply channel rather
      // than an outbound-messaging capability — an agent that can pick arbitrary JIDs
      // is an agent that can message arbitrary phone numbers.
      const jid = agent.whatsapp_jid;
      if (!jid) {
        return res.status(409).json({
          error:
            'This agent has no WhatsApp chat bound. The owner must link one in the dashboard first.',
        });
      }

      const send = getChannelSender();
      if (!send) {
        return res.status(503).json({
          error:
            'No messaging channel is connected (WhatsApp may be disabled).',
        });
      }

      await send(jid, message.slice(0, 4000), {
        name: agent.name,
        emoji: agent.emoji,
      });
      logger.info(
        { agentId: agent.id, jid, length: message.length },
        'Agent sent a WhatsApp message',
      );
      res.json({ ok: true, sent: true, to: jid });
    } catch (err: any) {
      // The channel throws when no channel owns the JID, or when WhatsApp is mid-reconnect.
      logger.warn(
        { agentId: req.params.id, err: err.message },
        'Agent WhatsApp send failed',
      );
      res.status(502).json({ error: `Send failed: ${err.message}` });
    }
  },
);

// ─── GET /api/agents/:id/self/steer — drain the owner's mid-run notes ────────
/**
 * stage45 item 5. The agent side of steering: a running browser loop asks, at each turn
 * boundary, whether its owner has said anything since the last turn.
 *
 * Cycle-token gated like every other route in this file, and scoped to the cycle in the
 * query string rather than a body so it stays a plain GET. Draining is destructive —
 * see run-steering.ts for why a note must not be re-delivered.
 */
selfManageRouter.get('/:id/self/steer', (req: Request, res: Response) => {
  try {
    const cycleId = String(req.query.cycleId ?? '');
    if (!cycleId) return res.status(400).json({ error: 'cycleId required' });
    const notes = drainSteers(cycleId);
    res.json({ notes: notes.map((n) => n.text) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/self/computer-use-escalation — Effector's real blocking
//     human-takeover round trip ─────────────────────────────────────────────────

/**
 * Register a pending human-approval request from INSIDE the agent's own container
 * (Effector's escalation.py) — not the dashboard-owner route this shares its
 * underlying pending-approvals map with (GET/approve/deny under
 * /api/agents/:id/computer-use/escalations, owner-session gated).
 *
 * That route was never callable from here: it's gated by `ownsResource`, an
 * owner-session check, and a container has a cycle token, not a session cookie.
 * This is the cycle-token-authenticated twin — same escalation.ts state, same
 * dashboard notification, reached the way self_manage/webhook/whatsapp already are.
 *
 * stage43 gap-closing pass, 2026-08-23: `effector_escalate`'s blocking round trip
 * was the one piece explicitly left unbuilt through all five phases (see
 * escalation.py's module docstring at the time) — this is what makes it real.
 */
// ─── GET /api/agents/:id/self/checkins/:checkinId — read your own question's answer ──
/**
 * How a waiting run learns the human's reply (clarify, request_batch_approval).
 *
 * Found by the stage 60 live test, 2026-09-17: both tools polled
 * GET /api/agents/:id/checkins/:checkinId, which is behind session auth. A container has a
 * cycle token, not a session, so every poll got a 401 that the tools treat as "not yet"
 * — the run waited out its full 10 minutes, reported nobody answered, and asked the same
 * question again while the answer sat in the database. Stage 49 phase 3's "clarify now
 * waits for the answer" had therefore never been able to receive one in production.
 *
 * Cycle-token gated like everything under /self, and scoped to the agent's own rows.
 */
selfManageRouter.get(
  '/:id/self/checkins/:checkinId',
  (req: Request, res: Response) => {
    const agent = getAgentOr404(req, res);
    if (!agent) return;
    const checkin = getCheckinById(String(req.params.checkinId ?? ''));
    if (!checkin || checkin.agent_id !== agent.id)
      return res.status(404).json({ error: 'Check-in not found' });
    res.json({
      id: checkin.id,
      status: checkin.status,
      user_reply: checkin.user_reply ?? null,
      responded_at: checkin.responded_at ?? null,
    });
  },
);

// ─── POST /api/agents/:id/self/local-followups — queue work for the user's computer ──
/**
 * Stage 60 phase 6. A cloud run that reaches a step only the user's own machine can do —
 * their signed-in browser, their files, their terminal — while that machine is not
 * connected hands the step off here and carries on with the rest. The queued task runs as
 * a fresh cycle on "This computer" the moment their desktop app connects.
 */
selfManageRouter.post(
  '/:id/self/local-followups',
  (req: Request, res: Response) => {
    const agent = getAgentOr404(req, res);
    if (!agent) return;
    const ownerId = (agent as { owner_id?: string | null }).owner_id;
    if (!ownerId)
      return res.status(422).json({
        error: 'This agent has no owner, so no computer to wait for.',
      });
    const { task, reason } = (req.body ?? {}) as {
      task?: unknown;
      reason?: unknown;
    };
    if (typeof task !== 'string' || !task.trim())
      return res.status(400).json({ error: 'task is required' });
    const principal = derivePrincipal(ownerId);
    const connected = browserBroker.onlineControllersFor(principal).length > 0;
    const row = localFollowups.add({
      agentId: agent.id,
      principal,
      task: task.trim(),
      source: 'agent',
      reason: typeof reason === 'string' ? reason.slice(0, 500) : undefined,
    });
    logger.info(
      { agentId: agent.id, followup: row.id, connected },
      "queued work for the user's computer",
    );
    res.status(201).json({
      queued: true,
      id: row.id,
      connected,
      message: connected
        ? "The user's computer is connected right now, so this will run on the next connection event — if it is urgent, ask them to send it again with This computer selected."
        : "Queued. It will run as a new cycle on the user's computer the moment their NanoCrew desktop app connects (within 24 hours).",
    });
  },
);

selfManageRouter.post(
  '/:id/self/computer-use-escalation',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { runId, action, target, description, reason, element, url } =
        req.body as {
          runId?: string;
          action?: string;
          target?: string;
          description?: string;
          reason?: string;
          element?: string;
          url?: string;
        };
      if (typeof action !== 'string' || !action.trim()) {
        return res.status(422).json({ error: 'action is required' });
      }

      const { createPendingApproval } =
        await import('../../agents/runtime/computer-use/escalation.js');
      const step = {
        step: 0,
        action,
        // `element` is the ref resolved to its accessible name — what the approval
        // card shows the human. `target` stays the raw ref/selector for the log.
        target: element?.trim() || target,
        url,
        description: description ?? reason,
        isDangerous: true,
      } as unknown as Parameters<typeof createPendingApproval>[0];

      const { id, createdAt } = createPendingApproval(
        step,
        agent.id,
        runId ?? 'unknown',
      );

      // The owner may have said this kind of step, on this site, needs no asking.
      const rule = isTaintedByWorkerData(agent.id)
        ? null
        : evaluateApproval(agent.config.approvalRules, 'browser_step', {
            site: url,
          });
      if (rule?.decision === 'auto') {
        const { resolveApproval } =
          await import('../../agents/runtime/computer-use/escalation.js');
        resolveApproval(id, 'approved');
        logger.info(
          {
            agentId: agent.id,
            approvalId: id,
            action,
            rule: describeRule(rule),
          },
          "Risky step auto-approved by the owner's rule",
        );
        return res.json({
          approvalId: id,
          createdAt,
          autoApproved: true,
          rule: describeRule(rule),
        });
      }

      logger.info(
        { agentId: agent.id, approvalId: id, action, target },
        'Effector requested human takeover',
      );
      res.json({ approvalId: id, createdAt });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

/** GET .../computer-use-escalation/:approvalId — Effector polls this while blocked. */
selfManageRouter.get(
  '/:id/self/computer-use-escalation/:approvalId',
  async (req: Request, res: Response) => {
    try {
      const agent = getAgentOr404(req, res);
      if (!agent) return;

      const { getApprovalDecision } =
        await import('../../agents/runtime/computer-use/escalation.js');
      const decision = getApprovalDecision(String(req.params.approvalId ?? ''));
      res.json({ decision });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── GET /api/agents/:id/self/report — what the agent has actually done ───────
//
// `GET /:id/self` above answers "when do I run next, on what model, with what budget".
// It carries no history at all, and neither does the identity block injected at cycle
// start (agent-service.ts `selfContext`: name, id, role). The agent container mounts
// only its own workspace, so `sql_query` cannot reach `agent_cycles` either. Asked to
// summarise its own work, Finder counted the `sweep-results-*.json` files in its
// workspace — 210 — and reported that as its cycle count. The real figure was 457. It
// was not being careless; it had nothing else to count. This route is the missing
// observable.
//
// Gathering only: the rendering and every judgement call live in agents/self-report.ts,
// which is pure and can be exercised against real rows without standing up express.

/**
 * Impact for the changes worth looking at: recent, and made by the agent or the platform.
 *
 * Owner edits are excluded — you know what you did, and the question this answers is
 * "did what I changed help?".
 */
function recentImpacts(agentId: string, days = 14): ChangeImpact[] {
  const since = Date.now() - days * 86_400_000;
  return getConfigAudit(agentId, 40)
    .filter((e) => Date.parse(e.created_at) >= since && e.actor !== 'owner')
    .slice(0, 5)
    .map((e) => getChangeImpact(e.id))
    .filter((x): x is ChangeImpact => !!x);
}

selfManageRouter.get('/:id/self/report', (req: Request, res: Response) => {
  const agent = getAgentOr404(req, res);
  if (!agent) return;

  try {
    const data = getAgentSelfReport(agent.id);
    const cfg = agent.config;
    const next = agentScheduler.getNextCycle(agent.id);

    // Count rows in each tracked file the agent actually reads from, so the renderer
    // can compare them against the DB. A missing or non-array file is not a
    // divergence — it just means there is nothing to compare.
    const trackedDir = path.join(
      DATA_DIR,
      'agents',
      agent.id,
      'workspace',
      'tracked',
    );
    const trackedFileCounts: Record<string, number> = {};
    for (const entity of new Set(data.tracked.map((t) => t.entity))) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(trackedDir, `${entity}.json`), 'utf-8'),
        );
        if (Array.isArray(parsed)) trackedFileCounts[entity] = parsed.length;
      } catch {
        /* no file, or not JSON — nothing to compare against */
      }
    }

    const { report, warnings } = renderSelfReport({
      // The column exists on the row but not on the `Agent` type, which models only
      // the fields every caller shares (getSubAgents intersects it the same way).
      agent: agent as typeof agent & { parent_agent_id?: string | null },
      model: cfg.model ?? getModelConfig().defaultModel,
      triggerMode: cfg.triggerMode ?? 'scheduled',
      schedule: (cfg.schedule ?? [])
        .filter((s) => s.enabled)
        .map((s) => ({ type: s.type, interval: s.interval })),
      nextCycle: next
        ? { type: next.type, dueAt: next.dueAt.toISOString() }
        : null,
      budget: cfg.budget,
      data,
      trackedFileCounts,
      traceSignals: getRecentTraceSignals(agent.id, 3),
      changeImpacts: recentImpacts(agent.id),
      handoffOutcomes: getHandoffOutcomes(agent.id),
      messagesOwed: getMessagesOwedCount(agent.id),
    });

    res.json({ report, data, warnings: warnings.length });
  } catch (err: any) {
    logger.error(
      { agentId: agent.id, err: err?.message },
      'self-report failed',
    );
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Which agents one agent may read, and which of them it asked for.
 *
 * Pure and exported so the owner boundary can be tested directly. It is the only thing
 * standing between "read a teammate" and "read another tenant's data" — prod runs 11
 * agents across 5 accounts — and a boundary verified only by reading the code is a
 * boundary verified by hope.
 *
 * Addressable by name because that is how agents already address each other: handoff_to
 * takes to_agent_id="Finder". Requiring a UUID would mean the one identifier an agent
 * actually knows does not work.
 */
export function resolveSibling<
  T extends { id: string; name: string; owner_id?: string | null },
>(
  self: { id: string; owner_id?: string | null },
  wanted: string,
  allAgents: T[],
): { siblings: T[]; target: T | undefined } {
  // An agent with no owner has no teammates. Without this an unowned agent would match
  // every other unowned agent, which is the whole boundary gone on a null.
  const siblings = self.owner_id
    ? allAgents.filter(
        (a) => a.id !== self.id && !!a.owner_id && a.owner_id === self.owner_id,
      )
    : [];
  const needle = wanted.trim().toLowerCase();
  const target =
    siblings.find((a) => a.id === wanted) ??
    siblings.find((a) => a.name.toLowerCase() === needle);
  return { siblings, target };
}

// ─── GET /api/agents/:id/self/crew/:target/report — read a teammate ────────────
//
// Stage 54, pulled forward out of phase 5 because it is the half with real payoff and no
// downside, and because an agent asked for it in as many words. Finder, 2026-08-24:
// "leads sitting 7+ days without pipeline status need Mailer's status before I spend more
// effort broadening the top of the funnel." It never got an answer. It has sent 133
// handoffs and can see nothing about what became of any of them — and when asked to
// summarise its own results it filled that gap by inventing an email address.
//
// READ ONLY, and same-owner only. The owner comparison is unconditional and sits above
// everything else: prod runs 11 agents across 5 accounts, so "read another agent" and
// "read another tenant's data" are one typo apart. 404 rather than 403, because a 403
// confirms the agent exists.
//
// Writing to a sibling is NOT here and is not a later flag on this route. An agent
// rewriting another agent's configuration is unattributable in practice — the audit row
// names the actor, but the reasoning lives in a transcript nobody will find.

selfManageRouter.get(
  '/:id/self/crew/:target/report',
  (req: Request, res: Response) => {
    const self = getAgentOr404(req, res);
    if (!self) return;

    try {
      const wanted = String(req.params.target ?? '').trim();
      if (!wanted)
        return res
          .status(422)
          .json({ error: 'Name or id of the teammate to read is required' });

      const { siblings, target } = resolveSibling(
        self,
        wanted,
        dbGetAllAgents(),
      );

      if (!target) {
        // Deliberately identical whether the agent does not exist, belongs to someone
        // else, or is simply not a teammate. The list of visible names is safe to
        // include — they are all this owner's own.
        return res.status(404).json({
          error: `No teammate "${wanted}".`,
          yourCrew: siblings.map((a) => a.name),
        });
      }

      const data = getAgentSelfReport(target.id);
      const trackedDir = path.join(
        DATA_DIR,
        'agents',
        target.id,
        'workspace',
        'tracked',
      );
      const trackedFileCounts: Record<string, number> = {};
      for (const entity of new Set(data.tracked.map((t) => t.entity))) {
        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(trackedDir, `${entity}.json`), 'utf-8'),
          );
          if (Array.isArray(parsed)) trackedFileCounts[entity] = parsed.length;
        } catch {
          /* nothing to compare against */
        }
      }

      const next = agentScheduler.getNextCycle(target.id);
      const { report, warnings } = renderSelfReport({
        agent: target as typeof target & { parent_agent_id?: string | null },
        model: target.config.model ?? getModelConfig().defaultModel,
        triggerMode: target.config.triggerMode ?? 'scheduled',
        schedule: (target.config.schedule ?? [])
          .filter((s) => s.enabled)
          .map((s) => ({ type: s.type, interval: s.interval })),
        nextCycle: next
          ? { type: next.type, dueAt: next.dueAt.toISOString() }
          : null,
        budget: target.config.budget,
        data,
        trackedFileCounts,
        traceSignals: getRecentTraceSignals(target.id, 3),
        changeImpacts: recentImpacts(target.id),
        handoffOutcomes: getHandoffOutcomes(target.id),
        messagesOwed: getMessagesOwedCount(target.id),
      });

      logger.info(
        { agentId: self.id, targetId: target.id },
        'Agent read a teammate self-report',
      );

      // Re-headed so the reading agent cannot mistake it for its own. The report body
      // says "you" throughout — that is right for the agent it describes and wrong for
      // the one holding it, and a weak model will act on the difference.
      res.json({
        report:
          `# Teammate report: ${target.name}\n` +
          `(Read-only. Everything below describes ${target.name}, not you. ` +
          `You cannot change any of it — ask ${target.name} directly, or raise it with your owner.)\n\n` +
          report,
        teammate: { id: target.id, name: target.name, status: target.status },
        warnings: warnings.length,
      });
    } catch (err: any) {
      logger.error(
        { agentId: self.id, err: err?.message },
        'teammate self-report failed',
      );
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  },
);

// ─── POST /api/agents/:id/self/crew/:target/:action — nudge a teammate ─────────
//
// Stage 54 phase 5. The read half shipped earlier; this is the rest, and it is
// deliberately narrow. An agent may WAKE a teammate or PAUSE one. It may not reconfigure
// one, and no grant unlocks that:
//
//   - editing a sibling's identity or goals is unattributable in practice. The audit row
//     names which agent did it, but the reasoning lives in a transcript nobody will find,
//     so the owner is left with a changed agent and no way to reconstruct why.
//   - ARMING a sibling is how a stopped fleet restarts itself with no human in the loop.
//     Waking one for a single cycle is bounded; setting it `running` is not.
//
// Everything here is bounded by the target's OWN budget and status, so a sibling nudge
// cannot spend more than the owner already allowed that agent to spend.

selfManageRouter.post(
  '/:id/self/crew/:target/:action',
  async (req: Request, res: Response) => {
    const self = getAgentOr404(req, res);
    if (!self) return;

    try {
      const { siblings, target } = resolveSibling(
        self,
        String(req.params.target ?? ''),
        dbGetAllAgents(),
      );
      if (!target) {
        return res.status(404).json({
          error: `No teammate "${req.params.target}".`,
          yourCrew: siblings.map((a) => a.name),
        });
      }

      const action = String(req.params.action ?? '');
      const { reason, instruction } = req.body as {
        reason?: unknown;
        instruction?: unknown;
      };
      const why =
        typeof reason === 'string' && reason.trim() ? reason.trim() : null;
      if (!why) {
        return res.status(422).json({
          error:
            'A `reason` is required when acting on a teammate — it is what tells your ' +
            'owner why one of their agents touched another.',
        });
      }

      if (action === 'wake') {
        // A single cycle, now. Not a schedule, not an arming — the recipient runs once
        // and returns to whatever it was.
        if (target.status === 'stopped') {
          return res.status(409).json({
            error:
              `${target.name} was stopped by your owner. Only they can start it. ` +
              'Raise it with them rather than working around it.',
          });
        }
        if (!canWake(target, 'ask')) {
          return res.status(409).json({
            error:
              `${target.name}'s wake policy has \`ask\` turned off — its owner has decided ` +
              'it should not be started this way right now.',
          });
        }
        const note =
          typeof instruction === 'string' && instruction.trim()
            ? instruction.trim().slice(0, 2000)
            : `${self.name} asked you to run: ${why}`;

        // Fire and forget: this route must not block for the length of another agent's
        // cycle, and the caller has no use for the result mid-cycle anyway.
        void agentService.runCycle(target.id, 'custom', note).catch((err) => {
          logger.warn(
            { from: self.id, to: target.id, err: err?.message },
            'sibling wake cycle failed',
          );
        });

        recordConfigAudit({
          agentId: target.id,
          capability: 'status',
          actor: 'agent',
          before: { wokenBy: null },
          after: { wokenBy: self.name },
          reason: `Woken by ${self.name}: ${why}`,
        });
        logger.info({ from: self.id, to: target.id }, 'agent woke a teammate');
        return res.json({ ok: true, woke: target.name, note });
      }

      if (action === 'pause') {
        // The one direction that is safe to hand over: an agent noticing a teammate is
        // looping or burning budget should be able to stop it without waiting for a
        // human. The reverse — arming — stays with the owner.
        const before = { status: target.status };
        agentService.setSelfStatus(target.id, 'paused');
        agentScheduler.unregister(target.id);
        recordConfigAudit({
          agentId: target.id,
          capability: 'status',
          actor: 'agent',
          before,
          after: { status: 'paused' },
          reason: `Paused by ${self.name}: ${why}`,
        });
        notify(
          'agent_alert',
          `${self.name} paused ${target.name}`,
          `${why}\n\nOnly you can start ${target.name} again — an agent cannot arm a teammate.`,
          target.id,
        );
        logger.info(
          { from: self.id, to: target.id },
          'agent paused a teammate',
        );
        return res.json({
          ok: true,
          paused: target.name,
          note: `${target.name} is paused. You cannot start it again — that is your owner's call.`,
        });
      }

      res.status(422).json({
        error:
          `Unknown teammate action "${action}". You can 'wake' a teammate or 'pause' one, ` +
          'and read its report. Reconfiguring a teammate is not available to any agent.',
      });
    } catch (err: any) {
      logger.error(
        { agentId: self.id, err: err?.message },
        'teammate action failed',
      );
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  },
);

// ─── GET  /api/agents/:id/self/handoffs — my open messages, both directions ────
// ─── POST /api/agents/:id/self/handoffs/:handoffId/reply — answer one ──────────
//
// Stage 56 phase 1. The primitive that was missing.
//
// `agent_handoffs` carried work in one direction and had nowhere to put an answer, so
// there were no answers. Finder handed Mailer 84 leads and never learned the fate of one;
// asked later to summarise its results, it filled the gap by inventing an email address.
// Crawler and Finder, meanwhile, built their own reply channel inside the payload — an
// `ack_received` field acknowledging the PREVIOUS message on the NEXT one going the other
// way. Nobody designed that. Two models needed to reply badly enough to invent a
// half-duplex protocol out of a free-text blob.
//
// These live on the self-manage router rather than beside `POST /handoffs`, which
// authenticates with nothing but an agent UUID. A reply is the record of what an agent
// says it did, and it is read back as fact by the sender and by change-impact
// measurement; anyone holding a UUID out of a log should not be able to write one. The
// cycle token also carries the cycle id, which gives every reply its provenance for free
// — so a wrong answer can be traced to the run that produced it rather than merely
// discovered.
//
// No grant gates either route. Withdrawing the ability to answer does not restrict an
// agent, it restores the silence this phase exists to end: an agent that may receive work
// must be able to say what became of it, and "cannot" is the most valuable thing it can
// say.

selfManageRouter.get('/:id/self/handoffs', (req: Request, res: Response) => {
  const self = getAgentOr404(req, res);
  if (!self) return;

  try {
    const names = new Map(dbGetAllAgents().map((a) => [a.id, a.name]));
    const nameOf = (id: string) => names.get(id) ?? id.slice(0, 8);

    // Everything addressed to this agent that it has not answered. `seen` is included
    // deliberately: it means a cycle had the message in context, which is exactly the
    // state 347 rows sat in while reading as handled.
    const owed = getHandoffsByAgent(self.id).filter(
      (h) =>
        h.to_agent_id === self.id &&
        !h.reply_to &&
        (h.status === 'pending' || h.status === 'seen'),
    );

    res.json({
      owedByYou: owed.map((h) => ({
        id: h.id,
        from: nameOf(h.from_agent_id),
        type: h.type,
        note: h.note ?? null,
        at: h.created_at,
        status: h.status,
        dataAt: `workspace/inbox/${h.id}.json`,
      })),
      awaitingAnswer: getUnansweredRequestsByAgent(self.id).map((h) => ({
        id: h.id,
        to: nameOf(h.to_agent_id),
        type: h.type,
        at: h.created_at,
        status: h.status,
      })),
    });
  } catch (err: any) {
    logger.error(
      { agentId: self.id, err: err?.message },
      'self handoff list failed',
    );
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

selfManageRouter.post(
  '/:id/self/handoffs/:handoffId/reply',
  (req: Request, res: Response) => {
    const self = getAgentOr404(req, res);
    if (!self) return;

    try {
      const handoff = getHandoffById(String(req.params.handoffId ?? ''));
      if (!handoff) {
        return res.status(404).json({
          error:
            `No message with id "${req.params.handoffId}". List what you have been sent ` +
            'with reply_to_handoff action="list" rather than guessing an id.',
        });
      }

      // You may only answer what was sent to YOU. Without this, a cycle token would let
      // an agent close out a conversation between two other agents — and since the
      // sender reads a reply as fact, that is a way to put words in a teammate's mouth.
      if (handoff.to_agent_id !== self.id) {
        return res.status(403).json({
          error:
            'That message was not addressed to you, so you cannot answer it.',
        });
      }
      // Phase 4 made `reply_to` mean "in this thread", so a follow-up QUESTION also
      // carries it. What may not be answered is a message that is itself an answer.
      if (
        handoff.performative &&
        handoff.performative !== 'request' &&
        handoff.performative !== 'inform'
      ) {
        return res.status(422).json({
          error:
            `That message is an answer (${handoff.performative}), not a question. Answers do not ` +
            'need answering. To continue the conversation, send a follow-up with handoff_to ' +
            'using in_reply_to with this id.',
        });
      }
      if (handoff.performative === 'inform') {
        return res.status(422).json({
          error:
            'That was sent for your information and asks nothing of you. Nothing is owed back.',
        });
      }

      // Answered once, and once only. Without this a retry loop stamps the parent again
      // and again and the sender is shown the same answer N times — and worse, a LATER
      // answer silently overwrites an earlier one, so "what did Mailer say" depends on
      // how many times it said it.
      //
      // `agreed` is the deliberate exception and the only one: "I will do it" is a
      // promise, and the agent must be able to come back with the result. That is a
      // second reply to the same message and it is correct.
      const TERMINAL = ['completed', 'refused', 'cannot', 'failed', 'expired'];
      if (TERMINAL.includes(handoff.status)) {
        return res.status(409).json({
          error:
            `You already answered that message — it is "${handoff.status}". ` +
            `${handoff.result ? `You said: ${String(handoff.result).slice(0, 200)}. ` : ''}` +
            'Answering twice would overwrite what you told them. If you have something new, ' +
            'send it with handoff_to using in_reply_to and this id.',
          alreadyAnswered: true,
        });
      }

      const { performative, result, reason } = req.body as {
        performative?: unknown;
        result?: unknown;
        reason?: unknown;
      };
      const verb = String(performative ?? '')
        .trim()
        .toLowerCase();
      if (!REPLY_PERFORMATIVES.includes(verb as HandoffPerformative)) {
        return res.status(422).json({
          error: `performative must be one of: ${REPLY_PERFORMATIVES.join(', ')}.`,
          meaning: {
            agree: 'I will do it — not done yet. Send `result` when it is.',
            result: 'Here is the answer.',
            refuse: 'I will not, and here is why.',
            cannot:
              'I would, but I lack a tool, skill or access. Name it in `reason`.',
            failure: 'I tried and it broke. Put the error in `reason`.',
          },
        });
      }

      const answer = typeof result === 'string' ? result.trim() : '';
      if (!answer) {
        return res.status(422).json({
          error:
            '`result` is required — it is what the sender reads. An empty answer is the ' +
            'silence this channel exists to replace.',
        });
      }

      // refuse/cannot/failure MUST carry a reason. A bare rejection is specifically
      // dangerous in this system: a bare `reject` on a check-in was once LLM-summarised
      // into invented instructions and written to IDENTITY.md at relevance 0.9. A refusal
      // with no reason gets a reason imagined for it. For `cannot` the reason is also the
      // product — it is the crew naming, in its own words, a capability it needs.
      const why = typeof reason === 'string' ? reason.trim() : '';
      if (
        (verb === 'refuse' || verb === 'cannot' || verb === 'failure') &&
        !why
      ) {
        return res.status(422).json({
          error:
            verb === 'cannot'
              ? '`reason` is required for "cannot" — name the tool, access or skill you are missing. ' +
                'That name is the useful part: it tells the sender where to route instead, and your ' +
                'owner what to give you.'
              : `\`reason\` is required for "${verb}". A refusal with no reason gets a reason imagined for it.`,
        });
      }

      const { reply, parent } = replyToHandoff({
        handoffId: handoff.id,
        fromAgentId: self.id,
        performative: verb as HandoffPerformative,
        result: answer,
        reason: why || undefined,
        cycleId: resolveCycleToken(
          extractCycleToken(
            req.headers.authorization,
            req.headers['x-cycle-token'],
          ),
        )?.cycleId,
      });

      const sender = agentService.getAgent(parent.from_agent_id);
      const senderName = sender?.name ?? parent.from_agent_id.slice(0, 8);

      // Tell the owner about the two answers they can act on. `cannot` is a capability
      // gap they can close; `failure` is something broken. result/agree/refuse are the
      // crew working, and notifying on those would be noise.
      if (verb === 'cannot' || verb === 'failure') {
        try {
          notify(
            'handoff_rejected',
            verb === 'cannot'
              ? `${self.name} lacks something ${senderName} needed`
              : `${self.name} failed work from ${senderName}`,
            `${answer}\n\n${verb === 'cannot' ? 'Missing' : 'Error'}: ${why}`,
            self.id,
            {
              handoffId: parent.id,
              performative: verb,
              senderId: parent.from_agent_id,
            },
          );
        } catch (e: any) {
          logger.warn({ err: e?.message }, 'reply notify failed');
        }
      }

      try {
        getSocketIO()?.emit('agent:handoff_updated', {
          handoffId: parent.id,
          fromAgentId: parent.from_agent_id,
          toAgentId: self.id,
          prevStatus: handoff.status,
          newStatus: parent.status,
        });
      } catch {
        /* the reply is written; a missed socket frame is cosmetic */
      }

      logger.info(
        { agentId: self.id, handoffId: parent.id, performative: verb },
        'agent answered a handoff',
      );

      res.json({
        ok: true,
        replyId: reply.id,
        answered: parent.id,
        to: senderName,
        status: parent.status,
        note:
          `${senderName} will see this at the start of its next cycle. It is not woken by it — ` +
          'if this needs acting on now, use self_report with action="wake".',
      });
    } catch (err: any) {
      logger.error(
        { agentId: self.id, err: err?.message },
        'handoff reply failed',
      );
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  },
);

// ─── GET  /api/agents/:id/self/find-agent?q=… — who can help ──────────────────
// ─── POST /api/agents/:id/self/borrow — use a teammate's tool without waking it ─
//
// Stage 56 phases 2 and 3. Together these are what turns a chain into a web: one answers
// "who can do this", the other answers "then let me just do it".
//
// Measured 2026-09-08, the live network was exactly the three-node chain its three prompts
// describe. An agent's whole knowledge of its colleagues was a roster line — name, type,
// and a goal truncated to 100 characters — which is enough to address a message and
// nothing else. Routing was whatever the prompt happened to name.
//
// Neither route is gated by a grant. Discovery is read-only over the owner's own crew, and
// borrowing has its own, tighter boundary (same owner, holder must actually hold it, one
// cycle, audited both sides) which a coarse grant flag would only blur.

selfManageRouter.get('/:id/self/find-agent', (req: Request, res: Response) => {
  const self = getAgentOr404(req, res);
  if (!self) return;

  try {
    const q = String(req.query.q ?? req.query.capability ?? '').trim();
    if (!q) {
      return res.status(422).json({
        error:
          'Say what you need, in your own words — `q=verify an email address`, not a tool name.',
      });
    }

    const matches = findAgents(q, {
      excludeAgentId: self.id,
      ownerId: self.owner_id ?? null,
      context:
        typeof req.query.context === 'string' ? req.query.context : undefined,
    });

    res.json({
      query: q,
      found: matches.length,
      report: renderMatches(q, matches),
      matches,
    });
  } catch (err: any) {
    logger.error({ agentId: self.id, err: err?.message }, 'find-agent failed');
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

selfManageRouter.post('/:id/self/borrow', (req: Request, res: Response) => {
  const self = getAgentOr404(req, res);
  if (!self) return;

  try {
    const { tool, from, reason } = req.body as {
      tool?: unknown;
      from?: unknown;
      reason?: unknown;
    };
    const result = borrowTool({
      borrowerId: self.id,
      tool: String(tool ?? ''),
      from: typeof from === 'string' && from.trim() ? from.trim() : undefined,
      reason: String(reason ?? ''),
    });

    if (!result.ok) {
      const { status, ...body } = result;
      return res.status(status).json(body);
    }
    res.json(result);
  } catch (err: any) {
    logger.error({ agentId: self.id, err: err?.message }, 'tool borrow failed');
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ─── POST /api/agents/:id/self/ask — ask a teammate and wait for the answer ────
//
// Stage 56 phase 5, and the last piece of the objective: *"that agent can call it, wait
// for the response, and once confirmed continue its job."*
//
// Phase 3 covers that for a TOOL — borrow it and the result is in hand this turn. This is
// for the other half, where what is needed is a colleague's JUDGEMENT: what did you make
// of these leads, is this worth chasing, did you already try it.
//
// ## Why the waiting happens here and not in the model's loop
//
// The obvious build is to let the agent poll: send, sleep, check, repeat. It is also the
// one this codebase has the scar for. Mailer called `request_approval` with wrong
// arguments 174 times in eight days, 90 in one day, because a loop it could not exit was
// in front of it. Every poll is a model turn, and a polling loop handed to a weak model is
// a budget fire.
//
// So the wait is ONE HTTP request that blocks server-side. From the model's side it is a
// single tool call that returns an answer or a plain "not yet" — there is no loop to get
// stuck in, and no way to spend more than one turn on it however the wait resolves.
//
// ## The two guards, each against a specific failure
//
// - **Refuse to ask an agent that is already running.** The deadlock check: if B is
//   mid-cycle it may itself be waiting, and B's own ask would come back to A. It also
//   stops chains — A waits on B, B asks C, C asks A: A is running, so C is refused. That
//   is why the "one ask per cycle" limit that used to sit here could go (2026-09-14): it
//   guarded the same failure, and cost every agent the ability to ask two teammates.
// - **A hard ceiling on the wait.** The container has a 30-minute timeout; a wait that
//   outlives its own cycle returns into nothing.
//
// When the wait runs out, the request does NOT vanish — it keeps its deadline and lands in
// the recipient's Messages block like any other. "Not yet" is a real answer here.

const ASK_MAX_WAIT_SECONDS = Number(
  process.env.AGENT_ASK_MAX_WAIT_SECONDS ?? 180,
);
const ASK_POLL_MS = 2000;

selfManageRouter.post('/:id/self/ask', async (req: Request, res: Response) => {
  const self = getAgentOr404(req, res);
  if (!self) return;

  try {
    const cycleId = resolveCycleToken(
      extractCycleToken(
        req.headers.authorization,
        req.headers['x-cycle-token'],
      ),
    )?.cycleId;

    const { to, question, waitSeconds, deadlineHours } = req.body as {
      to?: unknown;
      question?: unknown;
      waitSeconds?: unknown;
      deadlineHours?: unknown;
    };

    const ask = typeof question === 'string' ? question.trim() : '';
    if (!ask) {
      return res
        .status(422)
        .json({ error: '`question` is required — say what you need to know.' });
    }

    const { siblings, target } = resolveSibling(
      self,
      String(to ?? ''),
      dbGetAllAgents(),
    );
    if (!target) {
      return res.status(404).json({
        error: `No teammate "${to}". Use find_agent to look for a capability rather than guessing a name.`,
        yourCrew: siblings.map((a) => a.name),
      });
    }

    // The deadlock check. If the target is mid-cycle it may itself be waiting — quite
    // possibly on us — and blocking here would leave both stuck with both looking fine.
    if (target.status === 'running') {
      return res.status(409).json({
        error:
          `${target.name} is running right now, so it cannot be asked and waited on — it may ` +
          'be waiting on something itself. Send it a `handoff_to` instead; it will answer on a ' +
          'later cycle and you will be shown the reply.',
      });
    }
    if (target.status === 'stopped') {
      return res.status(409).json({
        error: `${target.name} was stopped by your owner. Only they can start it.`,
      });
    }
    if (!canWake(target, 'ask')) {
      return res.status(409).json({
        error:
          `${target.name}'s wake policy has \`ask\` turned off — its owner has decided ` +
          'it should not be started this way right now.',
      });
    }

    // `Number(x) || 60` would turn an explicit 0 into a full minute — an agent asking
    // not to wait would wait anyway. Zero is a real answer here: send it, wake them,
    // do not block.
    const askedFor = Number(waitSeconds);
    const wait = Math.max(
      0,
      Math.min(Number.isFinite(askedFor) ? askedFor : 60, ASK_MAX_WAIT_SECONDS),
    );
    const hours = Number(deadlineHours);
    const deadlineAt = new Date(
      Date.now() +
        (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 720) : 24) *
          3_600_000,
    ).toISOString();

    const handoff = agentHandoffService.createHandoff({
      fromAgentId: self.id,
      toAgentId: target.id,
      type: 'question',
      payload: { question: ask, askedBy: self.name, waiting: true },
      note: ask.slice(0, 500),
      performative: 'request',
      cycleId,
      deadlineAt,
    });

    // Wake it for exactly one cycle. Fire and forget — this route must not block for
    // the length of another agent's cycle beyond the caller's own stated wait.
    void agentService
      .runCycle(
        target.id,
        'custom',
        `${self.name} has asked you a question and is WAITING for your answer right now:\n\n${ask}\n\n` +
          `Answer it first, before anything else, with reply_to_handoff on id ${handoff.id}. ` +
          `If you cannot answer, reply "cannot" naming exactly what you lack — a fast "cannot" is far ` +
          `more useful to them than a slow silence, because they are blocked until you speak.`,
      )
      .catch((err) => {
        logger.warn(
          { from: self.id, to: target.id, err: err?.message },
          'ask: target cycle failed',
        );
      });

    const deadline = Date.now() + wait * 1000;
    let answer = getHandoffById(handoff.id);
    while (Date.now() < deadline && answer && !answer.replied_at) {
      await new Promise((r) => setTimeout(r, ASK_POLL_MS));
      answer = getHandoffById(handoff.id);
    }

    if (answer?.replied_at) {
      logger.info(
        { from: self.id, to: target.id, waitedMs: wait * 1000 },
        'agent asked a teammate and got an answer',
      );
      return res.json({
        answered: true,
        from: target.name,
        performative: answer.status,
        answer: answer.result,
        reason: answer.result_reason ?? null,
        handoffId: handoff.id,
        note: 'That is their answer. Continue your work with it.',
      });
    }

    res.json({
      answered: false,
      from: target.name,
      handoffId: handoff.id,
      deadline: deadlineAt,
      note:
        `${target.name} did not answer within ${wait}s and is still working. Do NOT wait again or ask ` +
        `again — the question stands, and their answer will be in your Messages block on a later ` +
        `cycle. If it lapses unanswered you are told that too. Carry on with what you can do without it.`,
    });
  } catch (err: any) {
    logger.error({ agentId: self.id, err: err?.message }, 'ask failed');
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});
