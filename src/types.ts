export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/NanoCrew/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  memoryLimit?: string;
  cpuLimit?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

/** Stage 28 auth — a platform account (admin or paying client). */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'user';
  status: 'active' | 'suspended';
  created_at: string;
  last_active: string | null;
  /** Entitlement tier: 'standard' | 'pro' | 'business' (Stage 32). Set by admin. */
  plan?: string | null;
  /** ISO timestamp of when the user finished first-run onboarding. null = not yet onboarded. */
  onboarded_at?: string | null;
}

/** Stage 28 auth — a server-side login session (opaque cookie id → user). */
export interface AuthSession {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  /** Channel the message originated from (e.g. 'whatsapp'); undefined = native dashboard. */
  source?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  owner_id?: string | null; // Stage 28 — owning user
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface Project {
  id: string;
  name: string;
  chat_jid: string;
  status: 'active' | 'archived';
  lead_agent_id?: string | null;
  created_at: string;
  updated_at: string;
  owner_id?: string | null; // Stage 28 — owning user
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  /**
   * `sender` attributes the message to a specific agent rather than the assistant.
   * WhatsAppChannel uses it for the display-name prefix; channels that have no use
   * for it simply omit the parameter (an implementation with fewer parameters is
   * still assignable here).
   */
  sendMessage(
    jid: string,
    text: string,
    sender?: { name: string; emoji?: string },
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(
    jid: string,
    isTyping: boolean,
    agentInfo?: { name: string; emoji?: string },
  ): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

// ─── Stage 5: Specialized Agents ─────────────────────────────────────────────

export type AgentType =
  | 'lead_hunter'
  | 'outreach'
  | 'market_research'
  | 'analytics'
  | 'followup'
  | 'content'
  | 'custom';

/**
 * `stopped` is stage 54 phase 3, and is the one an agent cannot lift for itself.
 *
 * `paused` has always been symmetric — the agent can set it and unset it — which means
 * there was no way to park an agent that its own self_manage call could not undo. The
 * closest thing was status idle plus every schedule entry disabled, which works but
 * depends on three separate settings staying aligned. `stopped` says it once.
 *
 * `idle` and `error` remain runtime states the orchestrator owns.
 */
export type AgentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

export type CycleType =
  | 'lead_search'
  | 'send_outreach'
  | 'followup'
  | 'checkin'
  | 'self_improve'
  | 'custom'
  | 'work'
  | 'handoff'
  | 'job_done';

export type CycleStatus = 'running' | 'completed' | 'failed' | 'interrupted';

// 'user_profile' = durable facts about the MANAGER/user (preferences, comms style, decisions).
// Kept out of the relevance/decay-ranked MEMORY.md and surfaced as a dedicated USER.md block.
export type MemoryType =
  | 'lesson'
  | 'pattern'
  | 'failure'
  | 'win'
  | 'icp_update'
  | 'note'
  | 'user_profile';

export type CheckinStatus = 'pending' | 'delivered' | 'responded';

export type FileEventType = 'read' | 'write' | 'create' | 'delete';

export interface AgentPersonality {
  voice?: string; // e.g. "analytical", "warm", "direct"
  expertise?: string[]; // e.g. ["SEO", "content strategy"]
  style?: string; // e.g. "formal", "conversational", "technical"
  color?: string; // hex accent color for dashboard
}

/**
 * A single future run that fires once and is then deleted.
 *
 * `schedule[]` cannot express this: every entry recurs (`_reschedule` re-arms
 * unconditionally), and its in-memory next-run map is keyed by `CycleType`, so a
 * second entry of the same type would silently overwrite the first. "Message me at
 * 1pm" is therefore not a schedule entry — it is one of these.
 */
export interface OneOffRun {
  id: string;
  /** ISO 8601 instant. Stored absolute; the caller resolves any relative phrasing. */
  at: string;
  cycleType: CycleType;
  /** Passed to runCycle as the cycle's context, so the agent knows why it woke up. */
  instruction?: string;
  createdAt: string;
  /** 'owner' | 'agent' — who asked for it. Diagnostic only. */
  createdBy?: string;
}

/**
 * The areas an agent can change about itself — used to label audit rows and held
 * check-ins. Every agent may change all of them: per-agent grants and the "always ask
 * first" list (stage 54) were removed on 2026-09-14 at the owner's request.
 */
export type SelfGrant =
  | 'schedule' // schedule entries + trigger mode
  | 'model' // model, subagent model, thinking
  | 'budget' // daily/monthly caps
  | 'status' // running / paused
  | 'identity' // goals, role, personality, system prompt
  | 'workspace' // pins, custom dirs
  | 'tracker' // entity schema
  | 'name' // rename itself
  | 'tools' // its own tool grants
  | 'credentials' // request access to a credential
  | 'siblings' // read another agent of the SAME owner
  /**
   * Its own runtime knobs — context budget, which tools it disables for itself.
   *
   * Stage 55 phase 4, and only meaningful because phase 1 governs the settings file these
   * write to. Deliberately does NOT cover permissions, hooks or mcp_servers: those are not
   * self-management, they are "run arbitrary code as this container", and no grant reaches
   * them.
   */
  | 'runtime'
  /** Its source rotation and sweep gates — .nanocrew/source_policy.json. */
  | 'sources'
  /** The remaining per-agent config: ICP, escalation rules, wake policy, notifications. */
  | 'settings'
  /** Its own approval rules — loosening one outside an owner-started run goes to the owner. */
  | 'approvals';

export interface SelfAuthority {
  /**
   * Hard limits an agent cannot raise by itself; past them it asks via a check-in. Only
   * the owner moves these. This is what keeps an agent that can change its own budget from
   * meaning one that can drain the account.
   */
  ceilings?: {
    dailyBudgetUsd?: number;
    monthlyBudgetUsd?: number;
    maxOneOffs?: number;
  };
}

/**
 * Stage 59 — one policy for what starts an agent outside its own schedule.
 *
 * `trigger_mode: 'on_demand'` reads as "nothing starts this agent without its owner."
 * That was never true: `ask_agent`, inbound webhooks, pipeline chaining, and several other
 * internal call sites all fired `runCycle` directly, most with no status check at all.
 * `wakePolicy` is the one place that decision now lives, checked via `canWake()` in
 * `agents/wake-policy.ts`. Absent means every source defaults to `true` — the same
 * behaviour every agent already had — so shipping this changes nothing until an owner
 * turns a source off deliberately.
 *
 * Does NOT cover the cron scheduler — `trigger_mode` already gates that correctly
 * (`agent-scheduler.ts`), and it's a cadence question ("does this ever run on a timer"),
 * not an event question ("does this one event get to run it right now").
 */
export type WakeSource =
  | 'handoff' // handoff_to (request performative) from another agent
  | 'webhook' // inbound webhook
  | 'ask' // ask_agent / sibling wake, from another agent
  | 'followup' // the outreach follow-up timer
  | 'pipeline' // pipeline chaining (auto or manual trigger)
  | 'swarm' // a run the agent delegated has finished (stage 57)
  | 'job' // a one-task background run started from /job (stage 57)
  | 'recovery'; // self-healing's automatic retry

export const DEFAULT_WAKE_POLICY: Record<WakeSource, boolean> = {
  handoff: true,
  webhook: true,
  ask: true,
  followup: true,
  pipeline: true,
  swarm: true,
  job: true,
  recovery: true,
};

/** Actions an approval rule can cover — described in agents/approval-policy.ts. */
export type ApprovalAction =
  | 'email'
  | 'batch_send'
  | 'browser_step'
  | 'create_agent'
  | 'budget_raise'
  | 'tool_grant'
  | 'identity_rewrite'
  | 'tracker_stage_delete'
  | 'sweep_gate_off'
  | 'reach_setting';

/** One standing answer to "may I do this without asking?". See agents/approval-policy.ts. */
export interface ApprovalRule {
  id: string;
  action: ApprovalAction;
  /** recipient: 'owner' | an address | a domain; site: a domain the step happens on. */
  match?: { recipient?: string; site?: string };
  decision: 'auto' | 'ask';
  note?: string;
  /** 'owner' from the dashboard; 'agent' when the agent wrote it on the owner's instruction. */
  createdBy: 'owner' | 'agent';
  createdAt: string;
}

/**
 * One timer: when it fires, and what the agent does when it does.
 *
 * `id`, `name`, `instruction` and `timezone` arrived with per-timer instructions
 * (2026-09-24). Before that a timer only said "run your <type> cycle now", every timer of an
 * agent produced the same prompt, and the scheduler keyed timers by `type` — so an agent with
 * three jobs at three times had to guess which one a run was for, and could not have two
 * timers of the same kind at all. Old entries without an id keep working: their key is their
 * type, which is also what their past cycles were matched on.
 */
export interface ScheduleEntryConfig {
  type: CycleType;
  interval: string;
  enabled: boolean;
  project_id?: string;
  /** Stable key. Assigned on save when missing (see normaliseSchedule). */
  id?: string;
  /** What the owner calls it: "Hourly log", "9 AM report". */
  name?: string;
  /** What to do when this timer fires. Put into the run's prompt verbatim. */
  instruction?: string;
  /** IANA zone the cron is read in, e.g. "Asia/Kolkata". Absent means UTC. */
  timezone?: string;
}

/** Handed to a run a timer started, so the agent knows which job this is. */
export interface TimerContext {
  id: string;
  name?: string;
  instruction?: string;
  timezone: string;
  interval: string;
  firedAt: string;
  /** True for the dashboard's Run now — same job, but off the clock. */
  manual?: boolean;
  lastRun?: { at: string; status: string; summary?: string } | null;
}

export interface AgentConfig {
  schedule: ScheduleEntryConfig[];
  /** Fire-once future runs. See OneOffRun — deliberately not part of `schedule[]`. */
  oneOffRuns?: OneOffRun[];
  budget: { daily: number; monthly: number; onExhaust: 'pause' | 'alert' };
  tools: string[];
  icp?: string;
  goals: string;
  escalationRules: string[];
  notifications?: { whatsapp: boolean };
  job_summary?: boolean;
  webhookToken?: string;
  webhookUrl?: string;
  personality?: AgentPersonality;
  /**
   * Human-readable role title (e.g. "World History Researcher"). Used as the
   * IDENTITY title + CORE Role line for `custom` agents instead of the generic
   * "Agent" / "Custom Agent". Populated by the Recruiter from the create spec.
   */
  role?: string;
  model?: string;
  /** Model used by subagents spawned via the `spawn` tool. Unset = inherit the primary model. */
  subagent_model?: string;
  /**
   * The last model this agent actually completed a cycle on.
   *
   * Stage 54 phase 3 — the thing an auto-rollback goes back TO. Agents may now set any
   * model id, which means they can set one that does not resolve, and an agent whose model
   * is broken cannot run the cycle it would need to fix it.
   */
  lastKnownGoodModel?: string;
  /** Per-task model overrides — merge with platform task_models, take precedence over them. */
  task_models?: Record<string, string>;
  /** Per-agent thinking toggle. null/undefined = inherit platform default. */
  thinking_enabled?: boolean | null;
  /** Stage 54 — the budget ceilings an agent cannot raise past by itself. */
  selfAuthority?: SelfAuthority;
  /** The owner's standing approval answers for this agent — see agents/approval-policy.ts. */
  approvalRules?: ApprovalRule[];
  /** Stage 59 — per-source wake gate. Absent means DEFAULT_WAKE_POLICY (every source on). */
  wakePolicy?: Partial<Record<WakeSource, boolean>>;
  repoPath?: string;
  /**
   * Stage 28 — built-in/infrastructure agent that the user can't fire (e.g. the
   * Recruiter, which is the only way to hire other agents). Blocks delete in the API
   * and hides the Fire button in the UI.
   */
  protected?: boolean;
  /**
   * stage45 doc 05 — run this agent's `effector` browser work in the OWNER'S OWN browser,
   * through the NanoCrew Bridge extension, instead of the container's Chromium.
   *
   * Opt-in per agent, and it is only a request: the cycle runner checks that a browser is
   * actually attached before a run gets the lane, and the extension enforces its own
   * allowlist on top. Off means every run stays in the container.
   */
  useUserBrowser?: boolean;
  /**
   * The stronger form of `useUserBrowser`: this agent's work is IMPOSSIBLE without the
   * user's logged-in session, so a cycle with no browser attached is deferred rather than
   * run in the container (stage 52 step 4, src/agents/local-lane-routing.ts).
   *
   * The difference matters because the container fallback is not neutral for such an
   * agent — it runs, hits an auth wall, reports "no results" and bills for it. Deferring
   * costs nothing and runs when the companion reconnects.
   */
  requireUserBrowser?: boolean;
  /**
   * How this agent gets triggered. Phase A5 — Task 1.4.
   * - 'scheduled'  : cron-style entries in `schedule[]` (current default behavior)
   * - 'on_demand'  : runs only when user sends chat or POSTs /cycle. `schedule[]` ignored.
   * - 'event_driven': reserved for webhook/channel triggers — Phase B+ wiring. Schema-forward only.
   */
  triggerMode?: 'scheduled' | 'on_demand' | 'event_driven';
  /**
   * Stage 20 — when true, this agent's chat always uses the full nanobot runtime
   * (never the light two-tier fast-path). Needed for agents whose conversation
   * relies on heavy tools throughout, e.g. the Recruiter (request_approval/create_agent).
   */
  alwaysHeavy?: boolean;
  /**
   * Optional custom system prompt — Phase A5 — Task 1.1.
   * - mode 'augment' : injected as an `## OPERATING_RULES` section into the type-based identity template
   * - mode 'replace' : replaces the type template entirely; the system still appends a `## LEARNED` section
   */
  customSystemPrompt?: { mode: 'augment' | 'replace'; content: string };
  /**
   * Extra workspace subdirectories to create at provisioning time — Phase A5 — Task 1.5.
   * Sanitized at the backend (only [a-z0-9-_]{1,40}; rejects ../).
   */
  customWorkspaceDirs?: Array<{ name: string; description?: string }>;
  /**
   * Reference documents copied into data/agents/{id}/references/ at creation — Phase A5 — Task 1.2.
   * Metadata only — the files themselves live on disk under references/.
   * DEPRECATED: superseded by the project-folder model — references now live in workspace/
   * and are marked via `pins`. Kept for backward-read during the one-time migration.
   */
  references?: Array<{
    filename: string;
    type: string;
    size: number;
    addedAt: string;
  }>;
  /**
   * Project-folder model: workspace-relative paths the agent must read first every cycle
   * (the "must-read" replacement for references). Surfaced in the cycle context.
   */
  pins?: string[];
}

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  emoji?: string;
  status: AgentStatus;
  workspace: string;
  config: AgentConfig;
  identity_version: number;
  created_at: string;
  last_active?: string;
  whatsapp_jid?: string;
  owner_id?: string | null; // Stage 28 — owning user (null only for legacy/system rows)
  /** Stage 34 — watermark for incremental (vs. full-resynthesis) identity evolution. */
  last_evolved_at?: string | null;
}

export interface AgentCycle {
  id: string;
  agent_id: string;
  cycle_type: CycleType;
  status: CycleStatus;
  started_at: string;
  ended_at?: string;
  summary?: string;
  episode_log?: string;
  cost: number;
  tasks_done: number;
  project_id?: string;
  resume_hint?: string;
  /**
   * A person asked for this cycle (dashboard chat, WhatsApp, Run now, a trigger with an
   * instruction). Stored so a self-heal retry keeps the same standing: Crawler's retry of
   * a manual Round 2 (2026-09-11) came back as a scheduled run and was refused by rotation
   * and query cooldowns its original never faced.
   */
  human_requested?: boolean | number;
  /** Which timer started this cycle (ScheduleEntryConfig.id), for per-timer history. */
  schedule_entry_id?: string | null;
  /**
   * The model this cycle actually ran on.
   *
   * Stage 55 phase 3. Without it, "did output get worse when the model changed?" is
   * unanswerable — which is exactly the question that hung over September, when every
   * agent was pointed at a free model that took 43.9s to fail a one-word instruction.
   */
  model?: string;
  /**
   * The agent's status when this cycle began — what it goes back to when the cycle ends.
   *
   * A cycle on an idle agent flips it to 'running' for the duration. That pre-cycle status
   * used to live only in runCycle's memory, so an orchestrator restart mid-cycle lost it
   * and the agent stayed 'running' for good — which the scheduler reads as "started", so
   * a manual agent quietly became a scheduled one. Stored here so startup can put it back.
   */
  status_before?: AgentStatus | null;
  /**
   * Which browser this cycle could reach: 'user-browser' or 'container'.
   *
   * A summary reads identically whichever machine it ran on — "Effector opened
   * example.com" is true in Frankfurt and true on the user's laptop — so "did that
   * actually use my browser?" was answerable only by watching live or reading the
   * orchestrator log, and neither survives the moment.
   */
  lane?: 'user-browser' | 'container';
}

export interface AgentMemory {
  id: string;
  agent_id: string;
  type: MemoryType;
  content: string;
  source_cycle?: string;
  relevance: number;
  used_count: number;
  created_at: string;
  /** Stage 34 Gap 3 — id of an existing memory this one supersedes, if any (soft link; the old row is demoted, not deleted). */
  supersedes_id?: string | null;
}

export interface AgentCheckin {
  id: string;
  agent_id: string;
  status: CheckinStatus;
  report_md?: string;
  user_reply?: string;
  created_at: string;
  responded_at?: string;
  action_type?: string; // e.g. 'send_email' — if set, Approve fires this action automatically
  action_payload?: string; // JSON string with action parameters
}

// ─── Artifact docs (Stage 58) ────────────────────────────────────────────────
// What an agent-written HTML page stores through window.NanoCrewPage, keyed by the
// file itself (see api/routes/artifact-docs.ts and dashboard ArtifactFrame).

export interface ArtifactDoc {
  agent_id: string;
  file_path: string; // relative to the agent's workspace/ dir
  doc_id: string;
  data: string; // JSON string — opaque to the server, shaped by whatever the page writes
  updated_at: string;
}

export interface AgentFileEvent {
  id: string;
  agent_id: string;
  cycle_id: string;
  event_type: FileEventType;
  file_path: string;
  diff_patch?: string;
  timestamp: string;
}

// ─── Conversation event stream (Stage 35) ────────────────────────────────────

/**
 * One entry in a conversation's append-only event log. A user message, an agent
 * reply, a tool call, a file change and an error are all rows in the same table,
 * differing only by `type` — so ordering across them is a fact (`seq`), not a
 * heuristic reconstruction across three separately-fetched tables.
 */
export type ConversationEventType =
  | 'user_msg'
  | 'agent_msg'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'error'
  | 'cycle_start'
  | 'cycle_end'
  // A mid-cycle human-approval gate: the agent is BLOCKED on this event, polling
  // for a decision, and will resume the moment one arrives. It lives in the
  // conversation log rather than a side table so the ask renders inline at the
  // exact point work stopped, and so the decision stays in the transcript as a
  // permanent record. Re-appended under the same id when decided — see
  // insertConversationEvent's upsert.
  | 'approval_request';

export type ConversationEventStatus = 'ok' | 'error' | 'interrupted';

export interface ConversationEvent {
  id: string;
  conversation: string; // JID: agent:<id> | project:<id>
  seq: number; // monotonic per conversation — the ordering key
  cycle_id?: string; // null for user turns
  type: ConversationEventType;
  role?: 'user' | 'assistant' | 'system';
  content?: string; // text / thinking / error message
  tool_name?: string;
  tool_input?: string; // JSON
  tool_output?: string; // JSON / text
  file_path?: string;
  diff_patch?: string;
  status?: ConversationEventStatus;
  metadata?: string; // JSON: cost, tokens, source, model…
  created_at: string;
}

/**
 * `metadata` of an `approval_request` event, JSON-encoded.
 *
 * `decision` is absent while the agent is still blocked and set once a human (or
 * the timeout) settles it — the card reads this to flip from buttons to a verdict.
 */
export interface ApprovalRequestMeta {
  approval_id: string;
  /** The effector step being gated. */
  action: string;
  target?: string;
  url?: string;
  /** The element's accessible name, resolved from a @ref — what the human reads. */
  element?: string;
  run_id?: string;
  /** Wall-clock ms the agent will wait before giving up and treating it as denied. */
  timeout_ms: number;
  decision?: 'approved' | 'denied' | 'expired';
  decided_at?: string;
}

/** The caller-supplied half of an event — id/seq/created_at are assigned on append. */
export type NewConversationEvent = Omit<
  ConversationEvent,
  'id' | 'seq' | 'conversation' | 'created_at'
>;

// ─── Generic Entity Tracker schema ───────────────────────────────────────────

export interface TrackerStage {
  key: string;
  label: string;
  color: string;
}

export interface TrackerField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'number' | 'date';
}

export interface TrackerSchema {
  name: string; // singular (e.g. "Paper")
  namePlural: string; // plural  (e.g. "Papers")
  stages: TrackerStage[];
  fields: TrackerField[];
}

export interface CreateAgentInput {
  name: string;
  type: AgentType;
  emoji?: string;
  config: AgentConfig;
  onboardingContext?: string;
  /** Tracker schema proposed at creation — saved to entity_schemas table */
  trackerSchema?: TrackerSchema;
  /** Tool specs approved during creation — consumed by tool-generator, not persisted */
  proposedTools?: Array<{
    id: string;
    name: string;
    label: string;
    description: string;
    category: string;
    rationale: string;
    requiredCredentials: string[];
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  }>;
  /**
   * Reference documents uploaded with the create request (Phase A5 Task 1.2).
   * On the wire these arrive as multipart form data; the typed interface uses File for browser callers.
   * The backend writes them into data/agents/{newId}/references/ and records metadata in config.references.
   */
  referenceFiles?: File[];
}
