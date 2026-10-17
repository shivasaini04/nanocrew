import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { randomUUID, randomInt, createHash } from 'crypto';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ASSISTANT_NAME,
  DATA_DIR,
  STORE_DIR,
} from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  Agent,
  AgentStatus,
  AgentCycle,
  CycleStatus,
  CycleType,
  AgentMemory,
  MemoryType,
  AgentCheckin,
  CheckinStatus,
  ArtifactDoc,
  AgentFileEvent,
  FileEventType,
  Project,
  User,
  ConversationEvent,
  NewConversationEvent,
} from './types.js';
import { buildBackfillEvents } from './conversation-backfill.js';

let db: Database.Database;

/** The live connection, for modules that own their own tables (src/swarm/store.ts). */
export function getDb(): Database.Database {
  return db;
}

function createSchema(database: Database.Database): void {
  // Stage 57 — delegated runs (src/swarm/). A run belongs to an AGENT, never a job.
  // run_events is append-only and is the source of truth for a run's history; ids are
  // shaped like OpenTelemetry trace/span ids so exporting to a tracing backend is a
  // mapping, not a migration.
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      owner_agent_id TEXT NOT NULL,
      owner_user_id TEXT,
      boss_cycle_id TEXT,
      goal TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'fanout',
      status TEXT NOT NULL,
      budget_usd REAL NOT NULL,
      spent_usd REAL NOT NULL DEFAULT 0,
      max_parallel INTEGER NOT NULL,
      background INTEGER NOT NULL DEFAULT 1,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      stop_reason TEXT,
      digest_json TEXT,
      woke_boss INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs(owner_agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE TABLE IF NOT EXISTS run_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      idx INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      depends_on TEXT,
      dedupe_key TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      current_attempt_id TEXT,
      last_reason TEXT,
      result_json TEXT,
      verdict_json TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(run_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_run_tasks_run ON run_tasks(run_id, idx);
    CREATE TABLE IF NOT EXISTS run_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES run_tasks(id),
      run_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      timings_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_attempts_task ON run_attempts(task_id);
    CREATE INDEX IF NOT EXISTS idx_run_attempts_status ON run_attempts(status);
    CREATE TABLE IF NOT EXISTS run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      task_id TEXT,
      attempt_id TEXT,
      data_json TEXT,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      source TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS message_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_session ON message_tokens(session_id);
    CREATE INDEX IF NOT EXISTS idx_token_timestamp ON message_tokens(timestamp);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      emoji TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      workspace TEXT NOT NULL,
      config TEXT NOT NULL,
      identity_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_active TEXT,
      interrupt_requested INTEGER DEFAULT 0,
      interrupt_requested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

    -- Stage 30 Phase 2 — where an agent is reachable on an external channel (WhatsApp).
    -- owner-scoped. target_type 'dm' = the owner's personal chats (target_jid null = all of
    -- them), 'group' = a specific group jid. project_id links a group to a project (Phase 4).
    CREATE TABLE IF NOT EXISTS agent_channel_bindings (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      target_type TEXT NOT NULL DEFAULT 'dm',
      target_jid TEXT,
      project_id TEXT,
      trigger_mode TEXT NOT NULL DEFAULT 'mention',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_agent ON agent_channel_bindings(agent_id);
    CREATE INDEX IF NOT EXISTS idx_bindings_owner ON agent_channel_bindings(owner_id);

    CREATE TABLE IF NOT EXISTS agent_cycles (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      cycle_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT,
      episode_log TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tasks_done INTEGER NOT NULL DEFAULT 0,
      project_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_cycles_agent ON agent_cycles(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_cycles_status ON agent_cycles(status);

    CREATE VIRTUAL TABLE IF NOT EXISTS agent_cycles_fts USING fts5(
      episode_log,
      summary,
      agent_id UNINDEXED,
      cycle_type UNINDEXED,
      started_at UNINDEXED,
      content='agent_cycles',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source_cycle TEXT REFERENCES agent_cycles(id),
      relevance REAL NOT NULL DEFAULT 1.0,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
      content,
      type,
      agent_id UNINDEXED,
      created_at UNINDEXED,
      content='agent_memory',
      content_rowid='rowid'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts_trig USING fts5(
      content,
      agent_id UNINDEXED,
      content='agent_memory',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(rowid, content, type, agent_id, created_at)
      VALUES (new.rowid, new.content, new.type, new.agent_id, new.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, type, agent_id, created_at)
      VALUES ('delete', old.rowid, old.content, old.type, old.agent_id, old.created_at);
    END;

    CREATE TRIGGER IF NOT EXISTS agent_memory_au AFTER UPDATE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, type, agent_id, created_at)
      VALUES ('delete', old.rowid, old.content, old.type, old.agent_id, old.created_at);
      INSERT INTO agent_memory_fts(rowid, content, type, agent_id, created_at)
      VALUES (new.rowid, new.content, new.type, new.agent_id, new.created_at);
    END;

    -- Stage 34 Gap 2 — per-episode distillation ledger. Replaces the rolling
    -- "windowDays from now" subtraction in memory-distiller.ts: a paused/delayed
    -- agent's episodes no longer silently age out of a moving window before ever
    -- being read, because "already distilled" is now a fact recorded per episode
    -- date, not a side effect of when the cycle happened to run.
    CREATE TABLE IF NOT EXISTS agent_episode_ledger (
      agent_id     TEXT NOT NULL REFERENCES agents(id),
      episode_date TEXT NOT NULL,
      distilled_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, episode_date)
    );

    -- Stage 34 Gap 1 — fast-lane consolidation queue. writeEpisodeLog() tags an agent
    -- here when an episode looks salient (failure, correction, HITL rejection); the
    -- scheduler drains this (debounced) independently of the weekly self_improve timer,
    -- instead of leaving a significant event inert for up to 6 days.
    CREATE TABLE IF NOT EXISTS agent_fastlane_queue (
      agent_id  TEXT PRIMARY KEY REFERENCES agents(id),
      tagged_at TEXT NOT NULL,
      reason    TEXT
    );

    -- Stage 34 Gap 5 — structured LEARNED bullets. IDENTITY.md's "## LEARNED" markdown
    -- section is rendered FROM this table (a projection, same pattern as MEMORY.md over
    -- agent_memory), so IdentityEvolutionEngine can patch ("add this bullet", "revise
    -- that one", "remove this one") individual rows instead of asking an LLM to
    -- rewrite-and-hope-nothing-true silently drops out of a regenerated markdown blob.
    CREATE TABLE IF NOT EXISTS agent_learned_bullets (
      id                TEXT PRIMARY KEY,
      agent_id          TEXT NOT NULL REFERENCES agents(id),
      text              TEXT NOT NULL,
      source_memory_ids TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_learned_bullets_agent ON agent_learned_bullets(agent_id);

    -- Stage 54 phase 1 — every change to an agent's own configuration, with a diff.
    --
    -- Nothing recorded these before. updateAgent wrote config.json, wrote the DB row,
    -- logged a line, and moved on; there was no before/after, no attribution to the cycle
    -- that did it, and no way to ask "what changed and when". The cost of that is not
    -- hypothetical: on 2026-08-28 a self_improve cycle replaced Crawler's 4.8 KB system
    -- prompt with an empty section, and it ran eleven more days on nothing but its own
    -- learned bullets before anyone noticed — found by reading an archived file by hand.
    --
    -- Neither that nor the other August failure was a permissions problem: a permission
    -- check would have allowed both. What was missing was a record with a diff. So this
    -- table is the foundation the rest of stage 54 is built on, and the reason an agent
    -- can safely be given more power than it has today rather than less.
    --
    -- before_json/after_json hold the TOUCHED SUBTREE, not the whole config: a full
    -- snapshot per change is large and unreadable as a diff, and the only interesting
    -- question is what moved.
    CREATE TABLE IF NOT EXISTS agent_config_audit (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      capability   TEXT NOT NULL,   -- schedule | model | budget | status | identity | ...
      actor        TEXT NOT NULL,   -- agent | owner | admin | system
      cycle_id     TEXT,            -- the cycle that did it, when actor = 'agent'
      before_json  TEXT NOT NULL,
      after_json   TEXT NOT NULL,
      reason       TEXT,            -- the actor's stated why; required for agent writes
      reverted_by  TEXT REFERENCES agent_config_audit(id),
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_config_audit_agent
      ON agent_config_audit(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_checkins (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'pending',
      report_md TEXT,
      user_reply TEXT,
      created_at TEXT NOT NULL,
      responded_at TEXT,
      action_type TEXT,
      action_payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_checkins_agent ON agent_checkins(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_checkins_status ON agent_checkins(status);

    -- Stage 58. What an agent-written HTML page remembers: whatever its own JS stores
    -- through window.NanoCrewPage (see dashboard ArtifactFrame). Keyed by the FILE, not by
    -- a published copy, so the same page keeps its state wherever the owner opens it --
    -- workspace drawer, Artifacts tab, chat card, full-page view. A first version keyed it
    -- to an approved "published page" instead, which meant the file the owner actually
    -- opened had nowhere to save and reset on every reload.
    -- file_path is relative to the agent's workspace/ dir (normalised in artifact-docs.ts).
    CREATE TABLE IF NOT EXISTS artifact_docs (
      agent_id   TEXT NOT NULL REFERENCES agents(id),
      file_path  TEXT NOT NULL,
      doc_id     TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, file_path, doc_id)
    );

    -- Strict posture: a tool call held mid-cycle while a human decides. Distinct
    -- from agent_checkins, which the agent raises itself at the END of its work.
    -- This one is raised by the policy engine, and the container is blocked on it.
    CREATE TABLE IF NOT EXISTS tool_approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      cycle_id TEXT,
      tool TEXT NOT NULL,
      args_preview TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied' | 'expired'
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_agent ON tool_approvals(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_approvals(status);

    -- The effector's mid-cycle danger gate, made durable. Deliberately NOT folded
    -- into tool_approvals: that table's TTL is a fixed 10 minutes shared with the
    -- strict-posture gate, whereas this one waits 30 by default and is configurable
    -- per deployment — one table cannot honour both without one caller silently
    -- getting the other's deadline.
    --
    -- Exists because the pending state used to live only in an in-memory Map, so an
    -- orchestrator restart mid-wait lost the request: the card stayed on screen with
    -- a live countdown, its buttons 404'd, and the blocked agent polled until it gave
    -- up and denied. Its id is the same id the Map and the conversation event use,
    -- so the row is the authority a restart can rebuild from.
    CREATE TABLE IF NOT EXISTS escalation_approvals (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      run_id       TEXT,
      step         TEXT NOT NULL,          -- JSON: the Step being gated
      status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | expired
      timeout_ms   INTEGER NOT NULL,
      created_at   TEXT NOT NULL,
      decided_at   TEXT,
      decided_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_escalation_approvals_status ON escalation_approvals(status);

    CREATE TABLE IF NOT EXISTS agent_file_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      cycle_id TEXT NOT NULL REFERENCES agent_cycles(id),
      event_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      diff_patch TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_file_events_cycle ON agent_file_events(cycle_id);

    CREATE TABLE IF NOT EXISTS agent_handoffs (
      id           TEXT PRIMARY KEY,
      from_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      to_agent_id  TEXT REFERENCES agents(id) ON DELETE CASCADE,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   DATETIME NOT NULL,
      completed_at DATETIME,
      -- Stage 56 phase 1. See the migration block below for why a reply is a row.
      performative  TEXT,      -- request | inform | agree | refuse | cannot | result | failure
      reply_to      TEXT,      -- the message this answers; NULL means it opens an exchange
      result        TEXT,      -- on a parent: the answer, denormalised from its reply
      result_reason TEXT,      -- on a parent: why refused, what was missing, or the error
      replied_at    DATETIME,
      cycle_id      TEXT       -- provenance: the cycle that wrote this message
    );
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_to ON agent_handoffs(to_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_status ON agent_handoffs(status);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_chat ON projects(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

    CREATE TABLE IF NOT EXISTS project_chats (
      project_id TEXT NOT NULL REFERENCES projects(id),
      chat_jid TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (project_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_project_chats_jid ON project_chats(chat_jid);

    CREATE TABLE IF NOT EXISTS workspace_files (
      id          TEXT PRIMARY KEY,
      context     TEXT NOT NULL,
      context_id  TEXT NOT NULL,
      chat_jid    TEXT,
      path        TEXT NOT NULL,
      filename    TEXT NOT NULL,
      extension   TEXT,
      size_bytes  INTEGER,
      checksum    TEXT,
      created_at  TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wf_context ON workspace_files(context, context_id);
    CREATE INDEX IF NOT EXISTS idx_wf_chat    ON workspace_files(chat_jid);

    CREATE TABLE IF NOT EXISTS entity_schemas (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      name_plural TEXT NOT NULL,
      stages      TEXT NOT NULL,
      fields      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_schemas_agent ON entity_schemas(agent_id);

    -- C2: ground-truth records. Agents write workspace/tracked/<Entity>.json; the
    -- orchestrator syncs each item here (deduped by the schema's key field) so the data
    -- is durable, queryable, and read back to the agent as authoritative facts.
    CREATE TABLE IF NOT EXISTS tracked_items (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      entity      TEXT NOT NULL,
      item_key    TEXT NOT NULL,
      stage       TEXT,
      data        TEXT NOT NULL,
      source      TEXT,
      updated_at  TEXT NOT NULL,
      stage_since TEXT,
      UNIQUE(agent_id, entity, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tracked_items_agent ON tracked_items(agent_id);

    -- Stage 40 — outbound email we actually sent, and replies matched back to it.
    --
    -- These exist because a reply was previously invisible to the product: the only way to
    -- read one was an ad-hoc IMAP script, and the send carried no Message-ID, so nothing
    -- could link a reply to the lead it answered.
    CREATE TABLE IF NOT EXISTS outreach_sends (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT,
      lead_key    TEXT,              -- tracked_items.item_key, when known
      business    TEXT,
      to_email    TEXT NOT NULL,
      subject     TEXT,
      message_id  TEXT,              -- what a reply quotes in In-Reply-To / References
      sent_at     TEXT NOT NULL,
      via         TEXT               -- 'smtp' | 'gmail'
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_sends_msgid ON outreach_sends(message_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_sends_to    ON outreach_sends(to_email);

    -- One row per inbound message matched to a send. is_auto separates a real human reply
    -- from an autoresponder, which is NOT a reply and must never be counted as one.
    CREATE TABLE IF NOT EXISTS outreach_replies (
      id            TEXT PRIMARY KEY,
      send_id       TEXT,            -- outreach_sends.id when matched
      lead_key      TEXT,
      from_email    TEXT NOT NULL,
      subject       TEXT,
      body_excerpt  TEXT,
      message_id    TEXT UNIQUE,     -- inbound Message-ID; the dedup key across polls
      in_reply_to   TEXT,
      is_auto       INTEGER NOT NULL DEFAULT 0,
      auto_reason   TEXT,            -- which header or pattern marked it automated
      received_at   TEXT NOT NULL,
      seen_by_human INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_replies_lead ON outreach_replies(lead_key);
  `);
  // C3 migration: stage_since for DBs that created tracked_items before it existed.
  try {
    database.exec('ALTER TABLE tracked_items ADD COLUMN stage_since TEXT');
  } catch {
    /* already present */
  }

  // Stage 40: a send that bounced. Recorded on the SEND because the send is what failed, and
  // because a follow-up must never be drafted to an address we know is dead.
  try {
    database.exec(
      'ALTER TABLE outreach_sends ADD COLUMN bounced INTEGER NOT NULL DEFAULT 0',
    );
  } catch {
    /* already present */
  }
  try {
    database.exec('ALTER TABLE outreach_sends ADD COLUMN bounce_reason TEXT');
  } catch {
    /* already present */
  }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Stage 57 (2026-09-29): the job system and the old swarm were removed. Their tables go
  // with them — swarm_tasks first, since it references jobs. Prod held 2 jobs (July 2026)
  // and 0 swarm tasks; both were exported before the deploy that ran this.
  try {
    database.exec(`DROP TABLE IF EXISTS swarm_tasks`);
  } catch {}
  try {
    database.exec(`DROP TABLE IF EXISTS jobs`);
  } catch {}

  // Agent WhatsApp JID routing (Phase 6)
  try {
    database.exec(`ALTER TABLE agents ADD COLUMN whatsapp_jid TEXT`);
  } catch {}

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add source column (channel a message originated from, e.g. 'whatsapp') — migration.
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN source TEXT`);
  } catch {
    /* exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Webhook delivery log (Stage 16)
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      event        TEXT NOT NULL,
      received_at  TEXT NOT NULL,
      payload_preview TEXT,
      cycle_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_agent ON webhook_deliveries(agent_id, received_at);
  `);

  // Outbound webhooks — the other half of the webhook feature: subscribe an external
  // URL to this agent's own events (cycle_completed, cycle_failed, ...) instead of
  // only receiving inbound pushes. `events` is a JSON array of NotificationType, or
  // `["*"]` for everything.
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_webhooks (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      owner_id    TEXT,
      url         TEXT NOT NULL,
      secret      TEXT NOT NULL,
      events      TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_agent ON outbound_webhooks(agent_id);

    CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
      id              TEXT PRIMARY KEY,
      webhook_id      TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      event           TEXT NOT NULL,
      sent_at         TEXT NOT NULL,
      status          TEXT NOT NULL,
      status_code     INTEGER,
      error           TEXT,
      payload_preview TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_webhook_deliveries_webhook ON outbound_webhook_deliveries(webhook_id, sent_at);
  `);

  // Notification Center (Stage 18)
  database.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      agent_id   TEXT,
      meta       TEXT,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications(agent_id, created_at);
  `);

  // Agent Pipelines (Stage 17)
  database.exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      enabled            INTEGER NOT NULL DEFAULT 1,
      source_agent_id    TEXT,
      trigger_cycle_type TEXT,
      trigger_status     TEXT NOT NULL DEFAULT 'completed',
      target_agent_id    TEXT NOT NULL,
      target_cycle_type  TEXT NOT NULL DEFAULT 'custom',
      inject_output      INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pipelines_source ON pipelines(source_agent_id);
    CREATE INDEX IF NOT EXISTS idx_pipelines_target ON pipelines(target_agent_id);
  `);
  // Migration: scope a pipeline to a specific project (null = any project)
  try {
    database.exec(`ALTER TABLE pipelines ADD COLUMN project_id TEXT`);
  } catch {
    /* exists */
  }

  // Pipeline run audit log
  database.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id                  TEXT PRIMARY KEY,
      pipeline_id         TEXT NOT NULL,
      source_cycle_id     TEXT,
      target_cycle_id     TEXT,
      source_agent_id     TEXT,
      source_cycle_type   TEXT,
      source_status       TEXT,
      target_agent_id     TEXT NOT NULL,
      target_cycle_type   TEXT NOT NULL,
      project_id          TEXT,
      trigger_kind        TEXT NOT NULL DEFAULT 'auto',   -- 'auto' | 'manual'
      status              TEXT NOT NULL DEFAULT 'fired',  -- 'fired' | 'failed' | 'skipped'
      reason              TEXT,
      fired_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_fired    ON pipeline_runs(fired_at);
  `);

  // Sub-agent parent tracking (Stage 16) — ALTER is safe if column exists
  try {
    database.exec(
      `ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`,
    );
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id)`,
    );
  } catch {
    /* column already exists */
  }

  // Agent ↔ Project links (Stage 14)
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_projects (
      agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role        TEXT,
      joined_at   TEXT NOT NULL,
      PRIMARY KEY (agent_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_projects_agent   ON agent_projects(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_projects_project ON agent_projects(project_id);
  `);

  // Inter-agent direct messages (Stage 15)
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id            TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id   TEXT NOT NULL,
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,
      sent_at       TEXT NOT NULL,
      read_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_to   ON agent_messages(to_agent_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent_id, sent_at);
  `);

  // Agent chat message persistence (Stage 8)
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_messages (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      tool_traces TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_chat_agent ON agent_chat_messages(agent_id, created_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS tool_analytics (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      cycle_id    TEXT,
      tool_name   TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      is_error    INTEGER NOT NULL DEFAULT 0,
      error_class TEXT,
      cache_hit   INTEGER NOT NULL DEFAULT 0,
      called_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_analytics_agent ON tool_analytics(agent_id, tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_analytics_time  ON tool_analytics(called_at);

    -- Per-cycle activity timeline (durable, cycle-keyed source of truth for the
    -- chat working-timeline). Replaces the ephemeral activity.json snapshot copy:
    -- rows are keyed by cycle_id so a later cycle can never overwrite an earlier
    -- one, and history is always exact (no "old cycle has no trace" fallback).
    CREATE TABLE IF NOT EXISTS cycle_steps (
      id        TEXT PRIMARY KEY,
      cycle_id  TEXT NOT NULL,
      agent_id  TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      type      TEXT NOT NULL,          -- thinking | tool_call | tool_result
      tool      TEXT,
      input     TEXT,
      output    TEXT,
      content   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cycle_steps_cycle ON cycle_steps(cycle_id, seq);
  `);

  // ─── Stage 35 — conversation event stream ───────────────────────────────────
  // The single append-only log of everything that happened in a conversation:
  // user turns, agent replies, thinking, tool calls, file changes and errors are
  // all rows here, ordered by (conversation, seq). This exists because the three
  // legacy tables (messages / cycle_steps / agent_file_events) have no common
  // ordering key, so the UI could only guess how they interleave — and an error
  // that produced no `messages` row was invisible, rendering as the previous
  // reply repeating. An error is just another row here, so that state is
  // unrepresentable. Phase 0: written in parallel with the legacy tables, read
  // by nothing yet.
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_events (
      id           TEXT PRIMARY KEY,
      conversation TEXT NOT NULL,          -- JID: agent:<id> | project:<id>
      seq          INTEGER NOT NULL,       -- monotonic per conversation — THE ordering key
      cycle_id     TEXT,
      type         TEXT NOT NULL,          -- user_msg | agent_msg | thinking | tool_call
                                           --   | tool_result | file_change | error
                                           --   | cycle_start | cycle_end
                                           --   | approval_request
      role         TEXT,                   -- user | assistant | system
      content      TEXT,
      tool_name    TEXT,
      tool_input   TEXT,
      tool_output  TEXT,
      file_path    TEXT,
      diff_patch   TEXT,
      status       TEXT,                   -- ok | error | interrupted
      metadata     TEXT,                   -- JSON
      created_at   TEXT NOT NULL,
      UNIQUE (conversation, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_events ON conversation_events(conversation, seq);
    CREATE INDEX IF NOT EXISTS idx_conv_events_cycle ON conversation_events(cycle_id);
  `);

  // ─── Stage 28 — Authentication (Topic 03) ────────────────────────────────────
  // NOTE: the pre-existing `sessions` table (group_folder → LLM session_id) is the
  // WhatsApp/agent session map and is UNRELATED to login. Auth login sessions live in
  // `auth_sessions` to avoid colliding with it.
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
      status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended'
      created_at    TEXT NOT NULL,
      last_active   TEXT,
      plan          TEXT,                            -- admin-set plan label (manual billing)
      onboarded_at  TEXT                             -- ISO ts when first-run onboarding finished (null = not yet)
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id            TEXT PRIMARY KEY,           -- random opaque cookie value
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      impersonating TEXT                        -- admin support: client user id being viewed as
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user    ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

    -- Phase 8 — one-time email codes for signup verification, passwordless login, reset.
    CREATE TABLE IF NOT EXISTS email_otps (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      code_hash  TEXT NOT NULL,
      purpose    TEXT NOT NULL,           -- 'signup' | 'login' | 'reset'
      expires_at TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      consumed   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_otps_lookup ON email_otps(email, purpose);

    -- Phase 8 — holds a signup's hashed password between "request code" and "verify",
    -- so we never create an account until the email is verified.
    CREATE TABLE IF NOT EXISTS pending_signups (
      email         TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    -- Stage 32 — Dodo Payments billing record (one row per Dodo subscription).
    -- users.plan stays the entitlement flag; this is the billing truth.
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                    TEXT PRIMARY KEY,          -- Dodo subscription_id
      user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status                TEXT NOT NULL,             -- active|on_hold|cancelled|failed|expired
      plan                  TEXT NOT NULL,             -- resolved tier: standard|pro|business
      dodo_customer_id      TEXT,
      dodo_product_id       TEXT,
      current_period_end    TEXT,                      -- next_billing_date (ISO)
      previous_billing_date TEXT,
      cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      raw                   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

    -- Stage 32 — webhook idempotency + audit. id = Standard Webhooks webhook-id header.
    CREATE TABLE IF NOT EXISTS webhook_events (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      subscription_id TEXT,
      received_at     TEXT NOT NULL,
      status          TEXT,
      payload         TEXT
    );

    -- Stage 32 — one row per cycle-usage reminder fired (per user/month/threshold), so each
    -- 50/75/90/99/100% reminder fires at most once a month. Self-resets: new month = new rows.
    CREATE TABLE IF NOT EXISTS usage_alerts (
      user_id    TEXT NOT NULL,
      month      TEXT NOT NULL,      -- 'YYYY-MM' (UTC)
      threshold  INTEGER NOT NULL,   -- 50 | 75 | 90 | 99 | 100
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month, threshold)
    );
  `);

  // owner_id on the user-data root tables. Child rows (agent_cycles, agent_memory,
  // cycle_steps, project_chats, …) inherit ownership through their parent agent/project,
  // so they are intentionally NOT tagged here. Backfilled to the admin user on boot.
  const OWNED_TABLES = [
    'agents',
    'projects',
    'chats',
    'scheduled_tasks',
    'notifications',
    'pipelines',
  ];
  for (const table of OWNED_TABLES) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT`);
    } catch {
      /* already present */
    }
    try {
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_id)`,
      );
    } catch {
      /* ignore */
    }
  }

  // Per-user BYOK (bring-your-own-key): provider + AES-GCM-encrypted key + optional model.
  try {
    database.exec(`ALTER TABLE users ADD COLUMN byok_provider TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE users ADD COLUMN byok_key_enc TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE users ADD COLUMN byok_model TEXT`);
  } catch {
    /* already present */
  }

  // Stage 32 — Dodo customer id for reverse customer→user webhook lookup.
  try {
    database.exec(`ALTER TABLE users ADD COLUMN dodo_customer_id TEXT`);
  } catch {
    /* already present */
  }

  // Security posture — the org-level dial every agent this owner runs inherits.
  // 'auto' (default) fences externally-controlled tool output before the model
  // sees it; 'dangerous' skips that fencing; 'strict' additionally holds every
  // outside-world tool call in `tool_approvals` until a human decides. The
  // predeclared hard denials hold in every posture regardless.
  try {
    database.exec(`ALTER TABLE users ADD COLUMN security_posture TEXT`);
  } catch {
    /* already present */
  }

  // One sentence describing what the owner's business does, captured once by
  // whichever agent is hired first and reused by every agent after it.
  //
  // Deliberately on the OWNER, not the agent. Per-agent, each new hire would ask
  // the same question again and the user would repeat themselves — which reads
  // as worse memory than a chatbot, not better. Held here, the second hire opens
  // already knowing the business, which is the one thing a stateless assistant
  // structurally cannot do.
  try {
    database.exec(`ALTER TABLE users ADD COLUMN business_context TEXT`);
  } catch {
    /* already present */
  }

  // Owner-level default model — the tier between the platform admin default and a
  // per-agent override. Same shape as security_posture: unset means fall through to
  // the platform default; a specific agent's own model (agentConfig.model) still wins
  // over this regardless.
  try {
    database.exec(`ALTER TABLE users ADD COLUMN default_model TEXT`);
  } catch {
    /* already present */
  }

  // Three concrete opening jobs, generated once from the agent's role and the
  // owner's business, shown as chips above an empty chat. JSON array of strings.
  // Cached rather than regenerated per page load — they are stable, and a model
  // call every time the chat opened would be slow for no gain.
  try {
    database.exec(`ALTER TABLE agents ADD COLUMN starters TEXT`);
  } catch {
    /* already present */
  }
  // Stage 55 phase 3 — which model a cycle actually ran on.
  //
  // agent_cycles has never recorded it, so the question hanging over this whole month —
  // did output get worse when the model changed? — was unanswerable by anyone, agent or
  // owner. Mailer ran on a model that took 43.9s to fail a one-word instruction and
  // nothing recorded which cycles those were.
  try {
    database.exec(`ALTER TABLE agent_cycles ADD COLUMN model TEXT`);
  } catch {
    /* already present */
  }
  // The agent's status when the cycle began, so a restart can put it back — see
  // AgentCycle.status_before and reconcileStuckCycles.
  try {
    database.exec(`ALTER TABLE agent_cycles ADD COLUMN status_before TEXT`);
  } catch {
    /* already present */
  }

  // ── Stage 56 phase 1 — a handoff can be answered ───────────────────────────
  //
  // `agent_handoffs` had no result column. A handoff carried work TO someone and nothing
  // came back, so Finder handed Mailer 84 leads and never learned what happened to one of
  // them. The agents noticed before we did: Crawler and Finder invented `ack_received`
  // inside the free-text payload and used it to acknowledge the PREVIOUS message on the
  // NEXT one going the other way — a half-duplex protocol built out of the only field
  // they had. The requirement is demonstrated, not speculative.
  //
  // A reply is a ROW, not a set of columns on the original. Three reasons, and they are
  // the load-bearing decision for the rest of this stage:
  //   1. a chain of rows carries a multi-turn exchange; columns cap you at one reply
  //   2. a reply addressed to the sender is delivered by the inbox machinery that
  //      already exists and is proven, instead of needing a second surfacing path
  //   3. provenance (which cycle produced this answer) is a row's worth of metadata
  //
  // The columns on the PARENT are then a deliberate denormalisation: `result`,
  // `result_reason` and `replied_at` let "what happened to the thing I sent?" — the
  // question the sender actually asks — be one query rather than a self-join.
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN performative TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN reply_to TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN result TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN result_reason TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN replied_at DATETIME`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN cycle_id TEXT`);
  } catch {
    /* already present */
  }
  // Stage 56 phase 4 — a conversation, and a deadline on every question.
  //
  // `thread_id` is the root message of an exchange, so a follow-up question is part of
  // the same conversation rather than an unrelated message that happens to be about the
  // same thing. `deadline_at` is what stops a mutual wait becoming a permanent one:
  // without it the first deadlock would leave two agents `agreed` forever and nothing in
  // the system would report it, exactly as 347 handoffs read as `acknowledged`.
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN thread_id TEXT`);
  } catch {
    /* already present */
  }
  try {
    database.exec(`ALTER TABLE agent_handoffs ADD COLUMN deadline_at DATETIME`);
  } catch {
    /* already present */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_handoffs_thread ON agent_handoffs(thread_id)`,
    );
  } catch {
    /* already present */
  }
  // Every pre-existing message is its own thread root.
  try {
    database.exec(
      `UPDATE agent_handoffs SET thread_id = COALESCE(reply_to, id) WHERE thread_id IS NULL`,
    );
  } catch {
    /* table absent on a fresh DB */
  }
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_handoffs_reply_to ON agent_handoffs(reply_to)`,
    );
  } catch {
    /* already present */
  }

  // Stage 56 phase 2 — what the crew looked for and did not find.
  //
  // The most valuable output of discovery is not the matches, it is the MISSES. A
  // `find_agent("read a PDF")` that returns nobody is the crew stating, unprompted, that
  // it wanted a capability this platform does not have. Aggregated with the `cannot`
  // replies from phase 1, it is the most honest product backlog this system can produce —
  // written by the agents rather than guessed at by the owner.
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS capability_gaps (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        query       TEXT NOT NULL,
        context     TEXT,
        created_at  DATETIME NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_capability_gaps_query ON capability_gaps(query);
    `);
  } catch {
    /* already present */
  }

  // `acknowledged` → `seen`. Not cosmetic: `acknowledged` is set by ANY cycle the
  // recipient runs, so it has always meant "you woke up since this arrived" — and it
  // reads as "handled". 347 of 349 handoffs carried it, exactly one had a completed_at,
  // and every one of Finder's 327 sends looked successful. A status that lies is worse
  // than a missing one, because nobody goes looking.
  try {
    database.exec(
      `UPDATE agent_handoffs SET status = 'seen' WHERE status = 'acknowledged'`,
    );
  } catch {
    /* table absent on a fresh DB */
  }
  // `rejected` predates the protocol and meant the same thing `refused` now means, but
  // without a required reason. Fold it in so there is one vocabulary, not two.
  try {
    database.exec(
      `UPDATE agent_handoffs SET status = 'refused' WHERE status = 'rejected'`,
    );
  } catch {
    /* table absent on a fresh DB */
  }

  // Stage 64 phase 1 — things sent to the owner's phone that the owner can answer there.
  //
  // Approvals waited a median of 19 hours (2026-09-30, 179 answered) because the only place
  // to answer one was the dashboard. A row here is one message on the owner's WhatsApp:
  // what it asks (`kind` + `ref_id`), the short `code` the owner can type to answer it, and
  // the WhatsApp message id a quoted reply points back to.
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS owner_prompts (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        agent_id    TEXT,
        kind        TEXT NOT NULL,              -- 'checkin' | 'escalation' | 'info'
        ref_id      TEXT,                       -- agent_checkins.id / escalation_approvals.id
        code        TEXT NOT NULL,              -- short handle the owner can type, e.g. 'K4'
        body        TEXT,                       -- the notice itself, for kind 'info'
        status      TEXT NOT NULL DEFAULT 'queued', -- queued | sent | answered | closed
        wa_msg_id   TEXT,
        answer      TEXT,
        created_at  TEXT NOT NULL,
        sent_at     TEXT,
        answered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_owner_prompts_owner_status ON owner_prompts(owner_id, status);
      CREATE INDEX IF NOT EXISTS idx_owner_prompts_wa ON owner_prompts(wa_msg_id);
    `);
  } catch {
    /* already present */
  }
  // JSON: { whatsapp?: boolean, quietStart?: 'HH:MM', quietEnd?: 'HH:MM' }. Unset = defaults.
  try {
    database.exec(`ALTER TABLE users ADD COLUMN notify_prefs TEXT`);
  } catch {
    /* already present */
  }
}

/**
 * 2026-09-14: the tool allowlist (`enforceTools`), per-agent grants and the "always ask
 * first" list were removed from the code at the owner's request. Nothing reads those keys
 * any more, but leaving `enforceTools: true` in six configs is exactly how "why does this
 * restriction still exist?" gets asked again. Strips them once, with a History row each.
 */
function removeRetiredSelfAuthority(): void {
  if (getRouterState('retired_self_authority_v1') === 'done') return;
  const rows = db.prepare('SELECT id, config FROM agents').all() as {
    id: string;
    config: string;
  }[];
  for (const row of rows) {
    let cfg: { selfAuthority?: Record<string, unknown> };
    try {
      cfg = JSON.parse(row.config);
    } catch {
      continue;
    }
    const sa = cfg.selfAuthority;
    if (!sa) continue;
    const removed: Record<string, unknown> = {};
    for (const key of ['grants', 'requireApproval', 'enforceTools']) {
      if (key in sa) {
        removed[key] = sa[key];
        delete sa[key];
      }
    }
    if (Object.keys(removed).length === 0) continue;
    if (Object.keys(sa).length === 0) delete cfg.selfAuthority;
    db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(
      JSON.stringify(cfg),
      row.id,
    );
    recordConfigAudit({
      agentId: row.id,
      capability: 'tools',
      actor: 'system',
      before: removed,
      after: null,
      reason:
        'Owner removed the tool allowlist, per-agent self-change grants and the always-ask-first list',
    });
  }
  setRouterState('retired_self_authority_v1', 'done');
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  // Default SQLite journal mode (rollback journal, full fsync) takes an exclusive
  // lock on the whole file for every write, blocking concurrent reads until it
  // commits. On this DB (500MB+, frequent writes from live agent cycles) that
  // caused reads on totally unrelated tables/connections to stall for seconds at
  // a time. WAL lets readers proceed concurrently with a writer; NORMAL sync is
  // the standard safe pairing with WAL (still crash-safe, just not fsync'd on
  // every single commit).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  createSchema(db);

  // Safe column migrations — ignored if column already exists
  try {
    db.prepare(
      'ALTER TABLE agent_chat_messages ADD COLUMN tool_traces TEXT',
    ).run();
  } catch {}
  try {
    db.prepare('ALTER TABLE agent_cycles ADD COLUMN project_id TEXT').run();
  } catch {}
  try {
    db.prepare('ALTER TABLE agent_cycles ADD COLUMN resume_hint TEXT').run();
  } catch {}
  // Whether a person asked for this cycle — a retry of it must keep the rotation/cooldown override.
  try {
    db.prepare(
      'ALTER TABLE agent_cycles ADD COLUMN human_requested INTEGER NOT NULL DEFAULT 0',
    ).run();
  } catch {}
  // Which timer started this cycle — per-timer last run, failure streaks and history.
  try {
    db.prepare(
      'ALTER TABLE agent_cycles ADD COLUMN schedule_entry_id TEXT',
    ).run();
  } catch {}
  // Which browser this cycle could reach: 'user-browser' or 'container'.
  //
  // A cycle summary reads identically whichever machine it ran on — "Effector opened
  // example.com" is true in Frankfurt and true on the user's laptop. So "did that
  // actually use my browser?" was answerable only by watching the pane live or reading
  // the orchestrator log, and neither survives the moment. Recorded here so the question
  // has an answer afterwards.
  try {
    db.prepare('ALTER TABLE agent_cycles ADD COLUMN lane TEXT').run();
  } catch {}

  // HITL approval layer — action fields on checkins
  try {
    db.prepare('ALTER TABLE agent_checkins ADD COLUMN action_type TEXT').run();
  } catch {}
  try {
    db.prepare(
      'ALTER TABLE agent_checkins ADD COLUMN action_payload TEXT',
    ).run();
  } catch {}

  // Stage 58's first design (2026-09-14, live for a few hours): an approved "published
  // page" copy, separate from the agent's HTML file. Replaced by artifact_docs, keyed by
  // the file itself. The only rows were that day's test pages, whose HTML is still in
  // the agent's workspace. Dropped rather than left behind because published_pages
  // references agents(id) and nothing deletes from it — it would block deleting any
  // agent that ever had a page. Children first.
  try {
    db.exec('DROP TABLE IF EXISTS page_documents');
  } catch {}
  try {
    db.exec('DROP TABLE IF EXISTS published_pages');
  } catch {}

  // Soft interrupt support (Phase 4)
  try {
    db.prepare(
      'ALTER TABLE agents ADD COLUMN interrupt_requested INTEGER DEFAULT 0',
    ).run();
  } catch {}
  try {
    db.prepare(
      'ALTER TABLE agents ADD COLUMN interrupt_requested_at TEXT',
    ).run();
  } catch {}

  // Stage 24 — lead agent per project
  try {
    db.prepare('ALTER TABLE projects ADD COLUMN lead_agent_id TEXT').run();
  } catch {}

  // Stage 28 — plan column for pre-existing users tables
  try {
    db.prepare('ALTER TABLE users ADD COLUMN plan TEXT').run();
  } catch {}
  // Onboarding — first-run product overview completion timestamp (null = not yet onboarded)
  try {
    db.prepare('ALTER TABLE users ADD COLUMN onboarded_at TEXT').run();
  } catch {}
  // Stage 28 Phase 7 — impersonation column for pre-existing auth_sessions tables
  try {
    db.prepare('ALTER TABLE auth_sessions ADD COLUMN impersonating TEXT').run();
  } catch {}

  // Stage 34 — memory redesign: embeddings + soft supersession pointer on agent_memory,
  // and a watermark on agents for incremental (vs. full-resynthesis) identity evolution.
  try {
    db.prepare('ALTER TABLE agent_memory ADD COLUMN embedding BLOB').run();
  } catch {}
  try {
    db.prepare(
      'ALTER TABLE agent_memory ADD COLUMN supersedes_id TEXT REFERENCES agent_memory(id)',
    ).run();
  } catch {}
  try {
    db.prepare('ALTER TABLE agents ADD COLUMN last_evolved_at TEXT').run();
  } catch {}

  try {
    removeRetiredSelfAuthority();
  } catch (err) {
    logger.error({ err }, 'retired self-authority cleanup failed');
  }

  // Stage 28 — seed admin account + assign all pre-auth data to it
  try {
    seedAdminAndBackfill();
  } catch (err) {
    logger.error({ err }, 'admin seed/backfill failed');
  }

  // Stage 20 gap H — one-time, idempotent backfill of legacy agent_chat_messages
  // into the unified `messages` thread (agent:<id>). Only runs for agents that have
  // NO unified history yet, so it never duplicates and is safe on every boot.
  try {
    backfillAgentChatToMessages();
  } catch (err) {
    /* non-fatal */
  }

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** Close the database connection cleanly (call during graceful shutdown). */
export function closeDatabase(): void {
  if (db) db.close();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
/**
 * Test-only escape hatch: the raw better-sqlite3 handle.
 *
 * For tests that need to set up a schema condition no exported helper can express —
 * e.g. a child table with an FK to agents(id) that deleteAgent doesn't know to clean,
 * which is the exact shape of bug that made a failed delete gut an agent's history.
 * Not for application code: everything else goes through the functions above.
 */
export function _rawDb(): Database.Database {
  return db;
}

export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);

  // Safe column migrations — ignored if column already exists
  try {
    db.prepare(
      'ALTER TABLE agent_chat_messages ADD COLUMN tool_traces TEXT',
    ).run();
  } catch {}
  try {
    db.prepare('ALTER TABLE agent_cycles ADD COLUMN project_id TEXT').run();
  } catch {}
  try {
    db.prepare('ALTER TABLE agent_cycles ADD COLUMN resume_hint TEXT').run();
  } catch {}
  // Whether a person asked for this cycle — a retry of it must keep the rotation/cooldown override.
  try {
    db.prepare(
      'ALTER TABLE agent_cycles ADD COLUMN human_requested INTEGER NOT NULL DEFAULT 0',
    ).run();
  } catch {}
  // Which timer started this cycle — per-timer last run, failure streaks and history.
  try {
    db.prepare(
      'ALTER TABLE agent_cycles ADD COLUMN schedule_entry_id TEXT',
    ).run();
  } catch {}
  // Which browser this cycle could reach: 'user-browser' or 'container'.
  //
  // A cycle summary reads identically whichever machine it ran on — "Effector opened
  // example.com" is true in Frankfurt and true on the user's laptop. So "did that
  // actually use my browser?" was answerable only by watching the pane live or reading
  // the orchestrator log, and neither survives the moment. Recorded here so the question
  // has an answer afterwards.
  try {
    db.prepare('ALTER TABLE agent_cycles ADD COLUMN lane TEXT').run();
  } catch {}

  // HITL approval layer — action fields on checkins
  try {
    db.prepare('ALTER TABLE agent_checkins ADD COLUMN action_type TEXT').run();
  } catch {}
  try {
    db.prepare(
      'ALTER TABLE agent_checkins ADD COLUMN action_payload TEXT',
    ).run();
  } catch {}

  // Stage 58's first design (2026-09-14, live for a few hours): an approved "published
  // page" copy, separate from the agent's HTML file. Replaced by artifact_docs, keyed by
  // the file itself. The only rows were that day's test pages, whose HTML is still in
  // the agent's workspace. Dropped rather than left behind because published_pages
  // references agents(id) and nothing deletes from it — it would block deleting any
  // agent that ever had a page. Children first.
  try {
    db.exec('DROP TABLE IF EXISTS page_documents');
  } catch {}
  try {
    db.exec('DROP TABLE IF EXISTS published_pages');
  } catch {}

  // Soft interrupt support (Phase 4)
  try {
    db.prepare(
      'ALTER TABLE agents ADD COLUMN interrupt_requested INTEGER DEFAULT 0',
    ).run();
  } catch {}
  try {
    db.prepare(
      'ALTER TABLE agents ADD COLUMN interrupt_requested_at TEXT',
    ).run();
  } catch {}

  // Stage 24 — lead agent per project
  try {
    db.prepare('ALTER TABLE projects ADD COLUMN lead_agent_id TEXT').run();
  } catch {}

  // Stage 28 — plan column for pre-existing users tables
  try {
    db.prepare('ALTER TABLE users ADD COLUMN plan TEXT').run();
  } catch {}
  // Onboarding — first-run product overview completion timestamp (null = not yet onboarded)
  try {
    db.prepare('ALTER TABLE users ADD COLUMN onboarded_at TEXT').run();
  } catch {}
  // Stage 28 Phase 7 — impersonation column for pre-existing auth_sessions tables
  try {
    db.prepare('ALTER TABLE auth_sessions ADD COLUMN impersonating TEXT').run();
  } catch {}

  // Stage 34 — memory redesign (kept in sync with initDatabase() above)
  try {
    db.prepare('ALTER TABLE agent_memory ADD COLUMN embedding BLOB').run();
  } catch {}
  try {
    db.prepare(
      'ALTER TABLE agent_memory ADD COLUMN supersedes_id TEXT REFERENCES agent_memory(id)',
    ).run();
  } catch {}
  try {
    db.prepare('ALTER TABLE agents ADD COLUMN last_evolved_at TEXT').run();
  } catch {}
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
  owner_id?: string | null;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group, owner_id
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

export function logTokenUsage(
  sessionId: string,
  chatJid: string,
  model: string | undefined,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  },
): void {
  // `db` is guaranteed to be initialized by `initDatabase` before any other functions are called.
  // No need for `if (!db) initDatabase();` here.

  if (
    !usage ||
    (usage.prompt_tokens === 0 &&
      usage.completion_tokens === 0 &&
      usage.total_tokens === 0)
  ) {
    return; // Nothing to log
  }

  const timestamp = new Date().toISOString();

  try {
    const stmt = db.prepare(`
      INSERT INTO message_tokens (
        session_id, chat_jid, model, prompt_tokens, completion_tokens, total_tokens, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sessionId,
      chatJid || 'unknown',
      model || 'unknown',
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      timestamp,
    );
  } catch (error) {
    logger.error({ error, sessionId }, 'Failed to log token usage');
  }
}

export function getUsageSummary(): any {
  // `db` is guaranteed to be initialized by `initDatabase` before any other functions are called.
  // No need for `if (!db) initDatabase();` here.

  try {
    // Basic summary: total tokens grouped by model
    const stmt = db.prepare(`
      SELECT
        model,
        SUM(prompt_tokens) as total_prompt,
        SUM(completion_tokens) as total_completion,
        SUM(total_tokens) as grand_total
      FROM message_tokens
      GROUP BY model
      ORDER BY grand_total DESC
    `);

    return stmt.all();
  } catch (error) {
    // logger.error({ error }, 'Failed to get usage summary'); // Assuming logger is defined elsewhere
    return [];
  }
}

export function getSessionUsage(): any[] {
  // `db` is guaranteed to be initialized by `initDatabase` before any other functions are called.
  // No need for `if (!db) initDatabase();` here.

  try {
    const stmt = db.prepare(`
      SELECT
        session_id,
        chat_jid,
        model,
        SUM(prompt_tokens) as total_prompt,
        SUM(completion_tokens) as total_completion,
        SUM(total_tokens) as grand_total,
        MAX(timestamp) as last_activity
      FROM message_tokens
      GROUP BY session_id
      ORDER BY last_activity DESC
      LIMIT 100
    `);

    return stmt.all() as any[];
  } catch (error) {
    // logger.error({ error }, 'Failed to get session usage'); // Assuming logger is defined elsewhere
    return [];
  }
}

export function getDailyUsage(): any[] {
  try {
    const stmt = db.prepare(`
      SELECT
        DATE(timestamp) as date,
        model,
        SUM(prompt_tokens)      as prompt,
        SUM(completion_tokens)  as completion,
        SUM(total_tokens)       as tokens
      FROM message_tokens
      GROUP BY DATE(timestamp), model
      ORDER BY date DESC
      LIMIT 200
    `);
    return stmt.all() as any[];
  } catch {
    return [];
  }
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  source?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.source ?? null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as any[];

  return rows.map((r) => ({
    ...r,
    is_from_me: r.is_from_me === 1,
    is_bot_message: r.is_bot_message === 1,
  }));
}

/**
 * Get full chat history (including bot messages).
 * Used by the Dashboard UI to show past conversations.
 */
export function deleteMessagesByJid(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
}

export function getChatHistory(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, source
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  const rows = db.prepare(sql).all(chatJid, sinceTimestamp) as any[];

  return rows.map((r) => ({
    ...r,
    is_from_me: r.is_from_me === 1,
    is_bot_message: r.is_bot_message === 1,
  }));
}

export function getRecentMessages(
  chatJid: string,
  limit: number,
): NewMessage[] {
  const rows = db
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(chatJid, limit) as any[];
  return rows.reverse().map((r) => ({
    ...r,
    is_from_me: r.is_from_me === 1,
    is_bot_message: r.is_bot_message === 1,
  }));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Stage 28 auth: user + auth-session accessors ---

export function createUser(user: {
  id: string;
  email: string;
  password_hash: string;
  role?: 'admin' | 'user';
  created_at: string;
}): void {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  ).run(
    user.id,
    user.email.toLowerCase(),
    user.password_hash,
    user.role || 'user',
    user.created_at,
  );
}

export function getUserByEmail(email: string): User | undefined {
  return db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email.toLowerCase()) as User | undefined;
}

export function getUserById(id: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | User
    | undefined;
}

// ── Per-user BYOK + usage (client Account page) ──────────────────────────────
export function setUserByok(
  userId: string,
  provider: string,
  keyEnc: string,
  model?: string | null,
): void {
  db.prepare(
    'UPDATE users SET byok_provider = ?, byok_key_enc = ?, byok_model = ? WHERE id = ?',
  ).run(provider, keyEnc, model || null, userId);
}
export function clearUserByok(userId: string): void {
  db.prepare(
    'UPDATE users SET byok_provider = NULL, byok_key_enc = NULL, byok_model = NULL WHERE id = ?',
  ).run(userId);
}
export function getUserByok(userId: string): {
  provider: string | null;
  keyEnc: string | null;
  model: string | null;
} {
  const r = db
    .prepare(
      'SELECT byok_provider, byok_key_enc, byok_model FROM users WHERE id = ?',
    )
    .get(userId) as
    | {
        byok_provider?: string | null;
        byok_key_enc?: string | null;
        byok_model?: string | null;
      }
    | undefined;
  return {
    provider: r?.byok_provider ?? null,
    keyEnc: r?.byok_key_enc ?? null,
    model: r?.byok_model ?? null,
  };
}
// ── Strict-posture tool approvals ────────────────────────────────────────────

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ToolApproval {
  id: string;
  agent_id: string;
  cycle_id: string | null;
  tool: string;
  args_preview: string | null;
  reason: string | null;
  status: ToolApprovalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

/** How long a pending approval stays answerable before it lapses to denied. */
export const TOOL_APPROVAL_TTL_MS = 10 * 60 * 1000;

export function createToolApproval(input: {
  agent_id: string;
  tool: string;
  args_preview?: string | null;
  reason?: string | null;
  cycle_id?: string | null;
}): ToolApproval {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_approvals (id, agent_id, cycle_id, tool, args_preview, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    input.agent_id,
    input.cycle_id ?? null,
    input.tool,
    input.args_preview ?? null,
    input.reason ?? null,
    created_at,
  );
  return getToolApproval(id)!;
}

/**
 * Read one approval, lapsing it to `expired` first if it has aged out.
 *
 * Expiry is evaluated on read rather than by a sweeper: the container polls this
 * row every couple of seconds, so a stale pending row cannot outlive its TTL in
 * any way an observer would notice, and there is no background job to lose.
 */
export function getToolApproval(id: string): ToolApproval | undefined {
  const row = db
    .prepare('SELECT * FROM tool_approvals WHERE id = ?')
    .get(id) as ToolApproval | undefined;
  if (!row) return undefined;
  if (row.status !== 'pending') return row;
  if (Date.now() - new Date(row.created_at).getTime() < TOOL_APPROVAL_TTL_MS)
    return row;
  return expireToolApproval(id) ?? row;
}

export function getPendingToolApprovals(agentId: string): ToolApproval[] {
  const rows = db
    .prepare(
      `SELECT * FROM tool_approvals WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    )
    .all(agentId) as ToolApproval[];
  // Reuse the read path so an aged row is reported as expired, not pending.
  return rows
    .map((r) => getToolApproval(r.id)!)
    .filter((r) => r.status === 'pending');
}

/** All pending approvals across one owner's agents — the dashboard's inbox query. */
export function getPendingToolApprovalsByOwner(
  ownerId: string,
): ToolApproval[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM tool_approvals t JOIN agents a ON a.id = t.agent_id
     WHERE a.owner_id = ? AND t.status = 'pending' ORDER BY t.created_at ASC`,
    )
    .all(ownerId) as ToolApproval[];
  return rows
    .map((r) => getToolApproval(r.id)!)
    .filter((r) => r.status === 'pending');
}

/**
 * Record a decision. Returns undefined when the approval is missing or already
 * settled, so a late click cannot overwrite an expiry the agent already acted on.
 */
export function decideToolApproval(
  id: string,
  status: 'approved' | 'denied',
  decidedBy: string,
  note?: string | null,
): ToolApproval | undefined {
  const current = getToolApproval(id);
  if (!current || current.status !== 'pending') return undefined;
  db.prepare(
    `UPDATE tool_approvals SET status = ?, decided_at = ?, decided_by = ?, note = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(status, new Date().toISOString(), decidedBy, note ?? null, id);
  return db
    .prepare('SELECT * FROM tool_approvals WHERE id = ?')
    .get(id) as ToolApproval;
}

export function expireToolApproval(id: string): ToolApproval | undefined {
  db.prepare(
    `UPDATE tool_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(new Date().toISOString(), id);
  return db.prepare('SELECT * FROM tool_approvals WHERE id = ?').get(id) as
    | ToolApproval
    | undefined;
}

// ─── Escalation approvals (effector danger gate) ─────────────────────────────

export type EscalationApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired';

export interface EscalationApprovalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  step: string;
  status: EscalationApprovalStatus;
  timeout_ms: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export function insertEscalationApproval(input: {
  id: string;
  agent_id: string;
  run_id?: string | null;
  step: string;
  timeout_ms: number;
  created_at: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO escalation_approvals
       (id, agent_id, run_id, step, status, timeout_ms, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    input.id,
    input.agent_id,
    input.run_id ?? null,
    input.step,
    input.timeout_ms,
    input.created_at,
  );
}

/**
 * Settle a row. Returns false when it was already settled, so a click that races
 * an expiry (or a second tab) cannot overwrite the decision the agent already acted
 * on — the same guard decideToolApproval makes for the strict-posture gate.
 */
export function decideEscalationApproval(
  id: string,
  status: Exclude<EscalationApprovalStatus, 'pending'>,
  decidedBy: string,
): boolean {
  const res = db
    .prepare(
      `UPDATE escalation_approvals SET status = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending'`,
    )
    .run(status, new Date().toISOString(), decidedBy, id);
  return res.changes > 0;
}

export function getEscalationApproval(
  id: string,
): EscalationApprovalRow | undefined {
  return db
    .prepare('SELECT * FROM escalation_approvals WHERE id = ?')
    .get(id) as EscalationApprovalRow | undefined;
}

/** Every row still marked pending — read once at startup to rebuild the in-memory map. */
export function getPendingEscalationApprovals(): EscalationApprovalRow[] {
  return db
    .prepare(
      `SELECT * FROM escalation_approvals WHERE status = 'pending' ORDER BY created_at ASC`,
    )
    .all() as EscalationApprovalRow[];
}

/** The security postures an owner may select. See the `security_posture` column note. */
export const SELECTABLE_SECURITY_POSTURES = [
  'strict',
  'auto',
  'dangerous',
] as const;
export type SecurityPosture = 'strict' | 'auto' | 'dangerous';

/** An owner's security posture; unset or unrecognised falls back to the safe default. */
export function getUserSecurityPosture(userId: string): SecurityPosture {
  const r = db
    .prepare('SELECT security_posture FROM users WHERE id = ?')
    .get(userId) as { security_posture?: string | null } | undefined;
  const raw = (r?.security_posture ?? '').trim().toLowerCase();
  return raw === 'strict' || raw === 'dangerous' ? raw : 'auto';
}

export function setUserSecurityPosture(
  userId: string,
  posture: SecurityPosture,
): void {
  db.prepare('UPDATE users SET security_posture = ? WHERE id = ?').run(
    posture,
    userId,
  );
}

/** Longest business description we will store or feed into a prompt. */
export const BUSINESS_CONTEXT_MAX = 600;

/** Cached opening suggestions for an agent's empty chat. Empty array when not yet generated. */
export function getAgentStarters(agentId: string): string[] {
  const r = db
    .prepare('SELECT starters FROM agents WHERE id = ?')
    .get(agentId) as { starters?: string | null } | undefined;
  if (!r?.starters) return [];
  try {
    const parsed = JSON.parse(r.starters);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return []; // corrupt cache is not worth an error — regenerate instead
  }
}

export function setAgentStarters(agentId: string, starters: string[]): void {
  db.prepare('UPDATE agents SET starters = ? WHERE id = ?').run(
    JSON.stringify(starters),
    agentId,
  );
}

/** What the owner's crew knows about their business. Empty string when unset. */
export function getUserBusinessContext(userId: string): string {
  const r = db
    .prepare('SELECT business_context FROM users WHERE id = ?')
    .get(userId) as { business_context?: string | null } | undefined;
  return (r?.business_context ?? '').trim();
}

/**
 * Store the owner's business description. Truncated rather than rejected — this
 * is written by an agent mid-conversation, and failing the tool call would be a
 * worse experience than keeping the first 600 characters.
 */
export function setUserBusinessContext(userId: string, context: string): void {
  const clean = (context ?? '').trim().slice(0, BUSINESS_CONTEXT_MAX);
  db.prepare('UPDATE users SET business_context = ? WHERE id = ?').run(
    clean || null,
    userId,
  );
}

/** Business context for an agent, resolved through its owner. */
export function getAgentBusinessContext(agentId: string): string {
  const r = db
    .prepare('SELECT owner_id FROM agents WHERE id = ?')
    .get(agentId) as { owner_id?: string | null } | undefined;
  return r?.owner_id ? getUserBusinessContext(r.owner_id) : '';
}

/**
 * Save business context from an agent's side of a conversation. Returns false
 * for an unowned agent (local/dev runs have no owner row) so the caller can
 * report honestly rather than silently dropping what the user just said.
 */
export function setAgentBusinessContext(
  agentId: string,
  context: string,
): boolean {
  const r = db
    .prepare('SELECT owner_id FROM agents WHERE id = ?')
    .get(agentId) as { owner_id?: string | null } | undefined;
  if (!r?.owner_id) return false;
  setUserBusinessContext(r.owner_id, context);
  return true;
}

/** The posture governing an agent, resolved through its owner. */
export function getAgentSecurityPosture(agentId: string): SecurityPosture {
  const r = db
    .prepare('SELECT owner_id FROM agents WHERE id = ?')
    .get(agentId) as { owner_id?: string | null } | undefined;
  return r?.owner_id ? getUserSecurityPosture(r.owner_id) : 'auto';
}

/** An owner's default model for agents that don't have their own override. Null when unset. */
export function getUserDefaultModel(userId: string): string | null {
  const r = db
    .prepare('SELECT default_model FROM users WHERE id = ?')
    .get(userId) as { default_model?: string | null } | undefined;
  const trimmed = (r?.default_model ?? '').trim();
  return trimmed || null;
}

export function setUserDefaultModel(
  userId: string,
  model: string | null,
): void {
  const clean = model ? model.trim() : null;
  db.prepare('UPDATE users SET default_model = ? WHERE id = ?').run(
    clean || null,
    userId,
  );
}

/** The default model governing an agent, resolved through its owner. Null when unset. */
export function getAgentDefaultModel(agentId: string): string | null {
  const r = db
    .prepare('SELECT owner_id FROM agents WHERE id = ?')
    .get(agentId) as { owner_id?: string | null } | undefined;
  return r?.owner_id ? getUserDefaultModel(r.owner_id) : null;
}

/** Count an owner's successful+running agent cycles since the 1st of the current (UTC) month. */
export function countUserCyclesThisMonth(userId: string): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const r = db
    .prepare(
      `SELECT COUNT(*) n FROM agent_cycles c JOIN agents a ON a.id = c.agent_id
     WHERE a.owner_id = ? AND c.started_at >= ?`,
    )
    .get(userId, start.toISOString()) as { n: number };
  return r?.n ?? 0;
}
export function countUserAgents(userId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) n FROM agents WHERE owner_id = ?')
    .get(userId) as { n: number };
  return r?.n ?? 0;
}
export function countUserProjects(userId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) n FROM projects WHERE owner_id = ?')
    .get(userId) as { n: number };
  return r?.n ?? 0;
}

// ── Stage 32 — Dodo Payments subscriptions & webhook idempotency ──────────────
export interface SubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  plan: string;
  dodo_customer_id: string | null;
  dodo_product_id: string | null;
  current_period_end: string | null;
  previous_billing_date: string | null;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
  raw: string | null;
}

/** Insert or update a subscription row (keyed on Dodo subscription_id). */
export function upsertSubscription(s: {
  id: string;
  user_id: string;
  status: string;
  plan: string;
  dodo_customer_id?: string | null;
  dodo_product_id?: string | null;
  current_period_end?: string | null;
  previous_billing_date?: string | null;
  cancel_at_period_end?: boolean;
  raw?: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO subscriptions
       (id, user_id, status, plan, dodo_customer_id, dodo_product_id,
        current_period_end, previous_billing_date, cancel_at_period_end, created_at, updated_at, raw)
     VALUES (@id, @user_id, @status, @plan, @dodo_customer_id, @dodo_product_id,
             @current_period_end, @previous_billing_date, @cancel_at_period_end, @now, @now, @raw)
     ON CONFLICT(id) DO UPDATE SET
       status=@status, plan=@plan, dodo_customer_id=@dodo_customer_id, dodo_product_id=@dodo_product_id,
       current_period_end=@current_period_end, previous_billing_date=@previous_billing_date,
       cancel_at_period_end=@cancel_at_period_end, updated_at=@now, raw=@raw`,
  ).run({
    id: s.id,
    user_id: s.user_id,
    status: s.status,
    plan: s.plan,
    dodo_customer_id: s.dodo_customer_id ?? null,
    dodo_product_id: s.dodo_product_id ?? null,
    current_period_end: s.current_period_end ?? null,
    previous_billing_date: s.previous_billing_date ?? null,
    cancel_at_period_end: s.cancel_at_period_end ? 1 : 0,
    now,
    raw: s.raw ?? null,
  });
}

/** Latest subscription for a user (most recently updated). */
export function getSubscriptionByUser(
  userId: string,
): SubscriptionRow | undefined {
  return db
    .prepare(
      'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(userId) as SubscriptionRow | undefined;
}

/** Tier of the user's entitling subscription: status 'active', or 'cancelled' but not yet
 *  past its period end (end-of-cycle access). Returns null if the user has no such subscription. */
export function getActiveSubscriptionPlan(userId: string): string | null {
  const row = db
    .prepare(
      `SELECT plan FROM subscriptions
     WHERE user_id = ? AND (status = 'active' OR (status = 'cancelled' AND current_period_end > ?))
     ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(userId, new Date().toISOString()) as { plan?: string } | undefined;
  return row?.plan ?? null;
}

export function setUserDodoCustomer(userId: string, customerId: string): void {
  db.prepare('UPDATE users SET dodo_customer_id = ? WHERE id = ?').run(
    customerId,
    userId,
  );
}
export function getUserByDodoCustomer(customerId: string): User | undefined {
  return db
    .prepare('SELECT * FROM users WHERE dodo_customer_id = ?')
    .get(customerId) as User | undefined;
}

/** Record a webhook event for idempotency. Returns false if this webhook-id was already seen. */
export function recordWebhookEvent(
  id: string,
  type: string,
  subscriptionId: string | null,
  payload: string,
): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events (id, type, subscription_id, received_at, status, payload)
     VALUES (?, ?, ?, ?, 'received', ?)`,
    )
    .run(id, type, subscriptionId, new Date().toISOString(), payload);
  return r.changes > 0;
}
export function markWebhookEvent(
  id: string,
  status: 'processed' | 'error',
): void {
  db.prepare('UPDATE webhook_events SET status = ? WHERE id = ?').run(
    status,
    id,
  );
}

/** Record a cycle-usage reminder for a user/month/threshold. Returns true if newly recorded
 *  (i.e. fire the reminder); false if it already fired this month (skip). */
export function recordUsageAlert(
  userId: string,
  month: string,
  threshold: number,
): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO usage_alerts (user_id, month, threshold, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(userId, month, threshold, new Date().toISOString());
  return r.changes > 0;
}

/** Stamp first-run onboarding as complete. Idempotent — keeps the original completion time. */
export function markUserOnboarded(id: string): void {
  db.prepare(
    'UPDATE users SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL',
  ).run(new Date().toISOString(), id);
}

export function getAllUsers(): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
}

// --- Stage 28 admin panel (Phase 6) ---

export interface AdminClientRow {
  id: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'suspended';
  plan: string | null;
  created_at: string;
  last_active: string | null;
  agent_count: number;
  cycle_count: number;
  cost: number;
}

/** One row per account with their headline usage stats (for the admin client list). */
export function getAdminClientList(): AdminClientRow[] {
  return db
    .prepare(
      `
    SELECT u.id, u.email, u.role, u.status, u.plan, u.created_at, u.last_active,
      (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) AS agent_count,
      (SELECT COUNT(*) FROM agent_cycles c JOIN agents a ON a.id = c.agent_id WHERE a.owner_id = u.id) AS cycle_count,
      (SELECT COALESCE(SUM(c.cost), 0) FROM agent_cycles c JOIN agents a ON a.id = c.agent_id WHERE a.owner_id = u.id) AS cost
    FROM users u
    ORDER BY u.created_at DESC
  `,
    )
    .all() as AdminClientRow[];
}

/** Platform-wide headline numbers for the admin dashboard. */
export function getAdminStats(): {
  totalClients: number;
  activeThisMonth: number;
  totalCycles: number;
  totalCost: number;
} {
  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  ).toISOString();
  const totalClients = (
    db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'user'`).get() as {
      c: number;
    }
  ).c;
  const activeThisMonth = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM users WHERE role = 'user' AND last_active >= ?`,
      )
      .get(monthStart) as { c: number }
  ).c;
  const totalCycles = (
    db.prepare('SELECT COUNT(*) c FROM agent_cycles').get() as { c: number }
  ).c;
  const totalCost = (
    db.prepare('SELECT COALESCE(SUM(cost),0) s FROM agent_cycles').get() as {
      s: number;
    }
  ).s;
  return { totalClients, activeThisMonth, totalCycles, totalCost };
}

/** A single client's profile + per-agent usage breakdown (admin detail view). */
export function getAdminClientDetail(userId: string): {
  user: AdminClientRow;
  agents: Array<{
    id: string;
    name: string;
    emoji: string | null;
    status: string;
    cycles: number;
    cost: number;
    last_active: string | null;
  }>;
} | null {
  const user = db
    .prepare(
      `
    SELECT u.id, u.email, u.role, u.status, u.plan, u.created_at, u.last_active,
      (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) AS agent_count,
      (SELECT COUNT(*) FROM agent_cycles c JOIN agents a ON a.id = c.agent_id WHERE a.owner_id = u.id) AS cycle_count,
      (SELECT COALESCE(SUM(c.cost), 0) FROM agent_cycles c JOIN agents a ON a.id = c.agent_id WHERE a.owner_id = u.id) AS cost
    FROM users u WHERE u.id = ?
  `,
    )
    .get(userId) as AdminClientRow | undefined;
  if (!user) return null;
  const agents = db
    .prepare(
      `
    SELECT a.id, a.name, a.emoji, a.status, a.last_active,
      (SELECT COUNT(*) FROM agent_cycles c WHERE c.agent_id = a.id) AS cycles,
      (SELECT COALESCE(SUM(c.cost),0) FROM agent_cycles c WHERE c.agent_id = a.id) AS cost
    FROM agents a WHERE a.owner_id = ? ORDER BY a.created_at DESC
  `,
    )
    .all(userId) as any[];
  return { user, agents };
}

export function setUserStatus(
  userId: string,
  status: 'active' | 'suspended',
): void {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  // Suspending a user immediately invalidates their live sessions.
  if (status === 'suspended')
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

export function setUserPlan(userId: string, plan: string | null): void {
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, userId);
}

/**
 * Hard-delete an account and all its data (admin action). Returns the deleted agent
 * ids so the caller can clean up their on-disk workspaces / sidecars. Runs in a
 * transaction. Refuses to delete an admin account.
 */
export function deleteUserAccount(userId: string): string[] {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as
    | { role?: string }
    | undefined;
  if (!user) return [];
  if (user.role === 'admin') throw new Error('Cannot delete an admin account');
  const agentIds = (
    db
      .prepare('SELECT id FROM agents WHERE owner_id = ?')
      .all(userId) as Array<{ id: string }>
  ).map((a) => a.id);
  const tx = db.transaction(() => {
    for (const aid of agentIds) {
      // Every table keyed by agent_id, and ORDER MATTERS: agent_cycles must go LAST
      // because agent_file_events.cycle_id and agent_memory.source_cycle reference it.
      // It used to be first — that delete failed the FK, the failure was swallowed by
      // the catch below, the cycles survived, and they then blocked the agents delete,
      // whose own failure was ALSO swallowed. Two silent catches turning a wrong order
      // into a committed, half-destroyed account.
      //
      // The three Stage 34 tables (episode ledger, learned bullets, fastlane queue) were
      // missing entirely, exactly as they were from deleteAgent — and they hold rows for
      // any agent that has ever run a cycle.
      for (const t of [
        'agent_memory',
        'agent_checkins',
        'agent_file_events',
        'agent_chat_messages',
        'cycle_steps',
        'tool_analytics',
        'entity_schemas',
        'tracked_items',
        'webhook_deliveries',
        'outbound_webhooks',
        'outbound_webhook_deliveries',
        'agent_projects',
        'agent_episode_ledger',
        'agent_learned_bullets',
        'agent_fastlane_queue',
        'artifact_docs',
        'agent_cycles',
      ]) {
        try {
          db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(aid);
        } catch {
          /* table/col may differ */
        }
      }
      try {
        db.prepare(
          'DELETE FROM agent_handoffs WHERE from_agent_id = ? OR to_agent_id = ?',
        ).run(aid, aid);
      } catch {}
      try {
        db.prepare(
          'DELETE FROM agent_messages WHERE from_agent_id = ? OR to_agent_id = ?',
        ).run(aid, aid);
      } catch {}
      try {
        db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(
          `agent:${aid}`,
        );
      } catch {}
      try {
        db.prepare('DELETE FROM chats WHERE jid = ?').run(`agent:${aid}`);
      } catch {}
      try {
        db.prepare(
          'DELETE FROM conversation_events WHERE conversation = ?',
        ).run(`agent:${aid}`);
      } catch {}
      // NOT wrapped in a silent catch, deliberately. It used to be — so an FK error
      // here was swallowed AFTER every child row had already been deleted, the
      // transaction committed anyway, and the account delete returned {ok:true} having
      // left an orphaned agent stripped of its entire history. A failure must abort the
      // transaction and surface as an error, not quietly destroy data and report success.
      db.prepare('DELETE FROM agents WHERE id = ?').run(aid);
    }
    // Project conversation logs go with the projects themselves.
    try {
      const projectIds = (
        db
          .prepare('SELECT id FROM projects WHERE owner_id = ?')
          .all(userId) as Array<{ id: string }>
      ).map((p) => p.id);
      for (const pid of projectIds) {
        db.prepare(
          'DELETE FROM conversation_events WHERE conversation = ?',
        ).run(`project:${pid}`);
      }
    } catch {
      /* projects table may not have owner_id in older DBs */
    }
    for (const t of [
      'projects',
      'scheduled_tasks',
      'notifications',
      'pipelines',
    ]) {
      try {
        db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).run(userId);
      } catch {}
    }
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  tx();
  return agentIds;
}

export function touchUserLastActive(id: string): void {
  db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
}

export function createAuthSession(session: {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}): void {
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(session.id, session.user_id, session.created_at, session.expires_at);
}

/** Resolve a session cookie to its user, or undefined if missing/expired. */
export function getUserBySession(sessionId: string): User | undefined {
  const row = db
    .prepare(
      `SELECT u.* FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, new Date().toISOString()) as User | undefined;
  return row;
}

/**
 * Stage 28 Phase 7 — resolve a session to its real user + any impersonation target
 * (admin "view as client"). Returns undefined for missing/expired sessions.
 */
export function getSessionContext(
  sessionId: string,
): { user: User; impersonating: string | null } | undefined {
  const row = db
    .prepare(
      `SELECT u.*, s.impersonating AS _impersonating FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, new Date().toISOString()) as
    | (User & { _impersonating: string | null })
    | undefined;
  if (!row) return undefined;
  const { _impersonating, ...user } = row;
  return { user: user as User, impersonating: _impersonating ?? null };
}

/** Set/clear the impersonation target on a session (admin support view). */
export function setSessionImpersonation(
  sessionId: string,
  targetUserId: string | null,
): void {
  db.prepare('UPDATE auth_sessions SET impersonating = ? WHERE id = ?').run(
    targetUserId,
    sessionId,
  );
}

export function deleteAuthSession(sessionId: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
}

/** Housekeeping: drop expired sessions. Safe to call periodically. */
export function deleteExpiredAuthSessions(): void {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(
    new Date().toISOString(),
  );
}

// --- Stage 28 Phase 8: email OTP codes ---

type OtpPurpose = 'signup' | 'login' | 'reset';
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const hashCode = (code: string) =>
  createHash('sha256').update(code).digest('hex');

/**
 * Issue a fresh 6-digit code for (email, purpose). Invalidates any prior unconsumed
 * codes for that pair, stores the hash, and returns the plaintext to email.
 */
export function issueOtp(email: string, purpose: OtpPurpose): string {
  const normEmail = email.toLowerCase();
  db.prepare(
    'DELETE FROM email_otps WHERE email = ? AND purpose = ? AND consumed = 0',
  ).run(normEmail, purpose);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(
    `INSERT INTO email_otps (id, email, code_hash, purpose, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    normEmail,
    hashCode(code),
    purpose,
    new Date(Date.now() + OTP_TTL_MS).toISOString(),
    new Date().toISOString(),
  );
  return code;
}

/**
 * Verify a code for (email, purpose). Single-use; consumes on success. Enforces an
 * attempt cap and expiry. Returns true only on a correct, live, unexhausted code.
 */
export function verifyOtp(
  email: string,
  purpose: OtpPurpose,
  code: string,
): boolean {
  const normEmail = email.toLowerCase();
  const row = db
    .prepare(
      `SELECT * FROM email_otps WHERE email = ? AND purpose = ? AND consumed = 0
     ORDER BY created_at DESC LIMIT 1`,
    )
    .get(normEmail, purpose) as
    | { id: string; code_hash: string; expires_at: string; attempts: number }
    | undefined;
  if (!row) return false;
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare('UPDATE email_otps SET consumed = 1 WHERE id = ?').run(row.id);
    return false;
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('UPDATE email_otps SET consumed = 1 WHERE id = ?').run(row.id);
    return false;
  }
  const ok = hashCode(String(code)) === row.code_hash;
  if (ok) {
    db.prepare('UPDATE email_otps SET consumed = 1 WHERE id = ?').run(row.id);
    return true;
  }
  db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?').run(
    row.id,
  );
  return false;
}

/** Stash a hashed password for a pending (email-unverified) signup. */
export function upsertPendingSignup(email: string, passwordHash: string): void {
  db.prepare(
    `INSERT INTO pending_signups (email, password_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, created_at = excluded.created_at`,
  ).run(email.toLowerCase(), passwordHash, new Date().toISOString());
}

export function getPendingSignup(
  email: string,
): { email: string; password_hash: string } | undefined {
  return db
    .prepare('SELECT email, password_hash FROM pending_signups WHERE email = ?')
    .get(email.toLowerCase()) as
    | { email: string; password_hash: string }
    | undefined;
}

export function deletePendingSignup(email: string): void {
  db.prepare('DELETE FROM pending_signups WHERE email = ?').run(
    email.toLowerCase(),
  );
}

/** Update a user's password (used by reset + change-password). */
export function setUserPassword(userId: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    passwordHash,
    userId,
  );
  // Invalidate existing sessions on a password change.
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

/**
 * On boot: ensure the admin account exists (from ADMIN_EMAIL/ADMIN_PASSWORD) and
 * assign every still-unowned data row to it. Idempotent — only fills NULL owner_ids,
 * so it never clobbers rows already owned by real users.
 */
function seedAdminAndBackfill(): void {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    logger.warn(
      'ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin seed. Set them in .env to enable auth.',
    );
    return;
  }

  let admin = getUserByEmail(ADMIN_EMAIL);
  if (!admin) {
    const id = randomUUID();
    createUser({
      id,
      email: ADMIN_EMAIL,
      password_hash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      role: 'admin',
      created_at: new Date().toISOString(),
    });
    admin = getUserById(id);
    logger.info({ email: ADMIN_EMAIL }, 'Seeded admin account');
  } else if (admin.role !== 'admin') {
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(admin.id);
  }

  if (!admin) return;

  const OWNED_TABLES = [
    'agents',
    'projects',
    'chats',
    'scheduled_tasks',
    'notifications',
    'pipelines',
  ];
  for (const table of OWNED_TABLES) {
    try {
      const res = db
        .prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id IS NULL`)
        .run(admin.id);
      if (res.changes > 0) {
        logger.info(
          { table, rows: res.changes },
          'Backfilled owner_id to admin',
        );
      }
    } catch (err) {
      logger.warn({ table, err }, 'owner_id backfill skipped for table');
    }
  }
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- Stage 20 gap H: legacy agent chat → unified messages backfill ---

function backfillAgentChatToMessages(): void {
  // Tables may not exist on a brand-new DB; guard everything.
  let agents: Array<{ agent_id: string }>;
  try {
    agents = db
      .prepare('SELECT DISTINCT agent_id FROM agent_chat_messages')
      .all() as Array<{ agent_id: string }>;
  } catch {
    return;
  }

  for (const { agent_id } of agents) {
    const jid = `agent:${agent_id}`;
    // Skip agents that already have any unified history (avoids duplicates).
    const existing = (
      db
        .prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_jid = ?')
        .get(jid) as { c: number }
    ).c;
    if (existing > 0) continue;

    const rows = db
      .prepare(
        'SELECT role, content, created_at, tool_traces FROM agent_chat_messages WHERE agent_id = ? ORDER BY created_at',
      )
      .all(agent_id) as Array<{
      role: string;
      content: string;
      created_at: string;
      tool_traces?: string;
    }>;
    if (rows.length === 0) continue;

    const agentName =
      (
        db.prepare('SELECT name FROM agents WHERE id = ?').get(agent_id) as
          | { name?: string }
          | undefined
      )?.name ?? 'Agent';
    // Ensure a chat row exists so the thread shows up.
    try {
      db.prepare(
        `INSERT OR IGNORE INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, 'dashboard', 0)`,
      ).run(jid, agentName, rows[rows.length - 1].created_at);
    } catch {
      /* chats schema may differ — non-fatal */
    }

    for (const r of rows) {
      const content = (r.content || '').trim();
      if (!content) continue;
      const isUser = r.role === 'user';
      try {
        db.prepare(
          `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `backfill_${agent_id}_${randomUUID()}`,
          jid,
          isUser ? 'User' : agentName,
          isUser ? 'User' : agentName,
          content,
          r.created_at,
          isUser ? 1 : 0,
          isUser ? 0 : 1,
        );
      } catch {
        /* skip malformed row */
      }
    }
  }
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// ─── Stage 5: Specialized Agents ─────────────────────────────────────────────

/** Insert an agent with an auto-generated id. Useful for simple ad-hoc creation. */
export function createAgent(agent: Omit<Agent, 'id' | 'created_at'>): Agent {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  return insertAgent({ ...agent, id, created_at });
}

/** Insert an agent with a pre-supplied id and created_at (used by AgentService). */
export function insertAgent(
  agent: Agent & { parent_agent_id?: string },
): Agent {
  // Stage 28: a sub-agent inherits its parent's owner; explicit owner_id wins.
  const owner_id =
    agent.owner_id ??
    (agent.parent_agent_id
      ? ((
          db
            .prepare('SELECT owner_id FROM agents WHERE id = ?')
            .get(agent.parent_agent_id) as { owner_id?: string } | undefined
        )?.owner_id ?? null)
      : null);
  db.prepare(
    `INSERT INTO agents (id, name, type, emoji, status, workspace, config, identity_version, created_at, last_active, parent_agent_id, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.name,
    agent.type,
    agent.emoji ?? null,
    agent.status,
    agent.workspace,
    JSON.stringify(agent.config),
    agent.identity_version,
    agent.created_at,
    agent.last_active ?? null,
    agent.parent_agent_id ?? null,
    owner_id,
  );
  return { ...agent, owner_id };
}

/** Stage 28 — set/transfer an agent's owner (used to stamp ownership on create). */
export function setAgentOwner(agentId: string, ownerId: string): void {
  db.prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run(
    ownerId,
    agentId,
  );
}

/** Stage 28 — owner of an agent, or null. Used to derive owner of agent-linked rows. */
export function getAgentOwner(
  agentId: string | null | undefined,
): string | null {
  if (!agentId) return null;
  const row = db
    .prepare('SELECT owner_id FROM agents WHERE id = ?')
    .get(agentId) as { owner_id?: string } | undefined;
  return row?.owner_id ?? null;
}

/** Stage 28 — stamp ownership on a root-table row (id-keyed tables only). */
export function setRowOwner(
  table: 'projects' | 'scheduled_tasks' | 'pipelines' | 'notifications',
  id: string,
  ownerId: string,
): void {
  db.prepare(`UPDATE ${table} SET owner_id = ? WHERE id = ?`).run(ownerId, id);
}

export function getAgent(id: string): Agent | null {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config) };
}

export function getAllAgents(): Agent[] {
  const rows = db
    .prepare('SELECT * FROM agents ORDER BY created_at DESC')
    .all() as any[];
  return rows.map((r) => ({ ...r, config: JSON.parse(r.config) }));
}

/** Agents owned by a specific user — owner-scoped (multi-tenant: WhatsApp mentions, etc.). */
export function getAgentsByOwner(ownerId: string): Agent[] {
  const rows = db
    .prepare('SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC')
    .all(ownerId) as any[];
  return rows.map((r) => ({ ...r, config: JSON.parse(r.config) }));
}

export function getSubAgents(
  parentAgentId: string,
): Array<Agent & { parent_agent_id: string }> {
  const rows = db
    .prepare(
      'SELECT * FROM agents WHERE parent_agent_id = ? ORDER BY created_at DESC',
    )
    .all(parentAgentId) as any[];
  return rows.map((r) => ({ ...r, config: JSON.parse(r.config) }));
}

// ── Stage 30 Phase 2 — agent_channel_bindings (WhatsApp reachability) ──────────

export interface ChannelBinding {
  id: string;
  owner_id: string | null;
  agent_id: string;
  channel: string;
  target_type: 'dm' | 'group';
  target_jid: string | null;
  project_id: string | null;
  trigger_mode: 'mention' | 'all';
  enabled: boolean;
  created_at: string;
}

function mapBinding(r: any): ChannelBinding {
  return { ...r, enabled: r.enabled === 1 };
}

export function getAgentBindings(agentId: string): ChannelBinding[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_channel_bindings WHERE agent_id = ? ORDER BY created_at',
    )
    .all(agentId) as any[];
  return rows.map(mapBinding);
}

/** The agent's WhatsApp DM (personal-chat) binding, if one was ever configured. */
export function getAgentWhatsAppDmBinding(
  agentId: string,
): ChannelBinding | null {
  const r = db
    .prepare(
      `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'dm' LIMIT 1`,
    )
    .get(agentId) as any;
  return r ? mapBinding(r) : null;
}

/**
 * DM/personal default-allow: an agent answers in the owner's personal chats unless an
 * explicit DM binding turns it OFF. (Groups, by contrast, are default-deny — Phase 3.)
 */
export function isAgentWhatsAppDmEnabled(agentId: string): boolean {
  const b = getAgentWhatsAppDmBinding(agentId);
  return b ? b.enabled : true;
}

/** Upsert the agent's WhatsApp DM binding to enabled/disabled (creates the row on first toggle). */
export function setAgentWhatsAppDm(
  ownerId: string | null,
  agentId: string,
  enabled: boolean,
  triggerMode?: 'mention' | 'all',
): void {
  const existing = getAgentWhatsAppDmBinding(agentId);
  if (existing) {
    const mode = triggerMode || existing.trigger_mode;
    db.prepare(
      'UPDATE agent_channel_bindings SET enabled = ?, trigger_mode = ? WHERE id = ?',
    ).run(enabled ? 1 : 0, mode, existing.id);
  } else {
    db.prepare(
      `INSERT INTO agent_channel_bindings (id, owner_id, agent_id, channel, target_type, target_jid, project_id, trigger_mode, enabled, created_at)
       VALUES (?, ?, ?, 'whatsapp', 'dm', NULL, NULL, ?, ?, ?)`,
    ).run(
      randomUUID(),
      ownerId,
      agentId,
      triggerMode || 'mention',
      enabled ? 1 : 0,
      new Date().toISOString(),
    );
  }
}

/** A specific group binding for an agent (Phase 3 group routing, default-deny). */
export function getAgentGroupBinding(
  agentId: string,
  groupJid: string,
): ChannelBinding | null {
  const r = db
    .prepare(
      `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ? AND enabled = 1 LIMIT 1`,
    )
    .get(agentId, groupJid) as any;
  return r ? mapBinding(r) : null;
}

export function getAgentGroupBindings(agentId: string): ChannelBinding[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' ORDER BY created_at`,
    )
    .all(agentId) as any[];
  return rows.map(mapBinding);
}

export function addAgentGroupBinding(
  ownerId: string | null,
  agentId: string,
  groupJid: string,
): void {
  const existing = db
    .prepare(
      `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ? LIMIT 1`,
    )
    .get(agentId, groupJid) as any;

  if (existing) {
    db.prepare(
      'UPDATE agent_channel_bindings SET enabled = 1 WHERE id = ?',
    ).run(existing.id);
  } else {
    db.prepare(
      `INSERT INTO agent_channel_bindings (id, owner_id, agent_id, channel, target_type, target_jid, project_id, trigger_mode, enabled, created_at)
       VALUES (?, ?, ?, 'whatsapp', 'group', ?, NULL, 'mention', 1, ?)`,
    ).run(randomUUID(), ownerId, agentId, groupJid, new Date().toISOString());
  }
}

export function removeAgentGroupBinding(
  agentId: string,
  groupJid: string,
): void {
  db.prepare(
    `DELETE FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ?`,
  ).run(agentId, groupJid);
}

export function setAgentGroupBindingEnabled(
  agentId: string,
  groupJid: string,
  enabled: boolean,
  triggerMode?: 'mention' | 'all',
): void {
  const existing = db
    .prepare(
      `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ? LIMIT 1`,
    )
    .get(agentId, groupJid) as any;
  if (existing) {
    const mode = triggerMode || existing.trigger_mode;
    db.prepare(
      'UPDATE agent_channel_bindings SET enabled = ?, trigger_mode = ? WHERE id = ?',
    ).run(enabled ? 1 : 0, mode, existing.id);
  }
}

export function getProjectGroupBindings(projectId: string): ChannelBinding[] {
  const rows = db
    .prepare(
      `SELECT MIN(id) as id, owner_id, MIN(agent_id) as agent_id, channel, target_type, target_jid, project_id, trigger_mode, MAX(enabled) as enabled, MIN(created_at) as created_at
     FROM agent_channel_bindings
     WHERE project_id = ? AND channel = 'whatsapp' AND target_type = 'group'
     GROUP BY target_jid`,
    )
    .all(projectId) as any[];
  return rows.map(mapBinding);
}

export function getGroupBindingsByJid(
  groupJid: string,
  ownerId?: string,
): ChannelBinding[] {
  const rows = ownerId
    ? (db
        .prepare(
          `SELECT * FROM agent_channel_bindings WHERE channel = 'whatsapp' AND target_type = 'group' AND target_jid = ? AND owner_id = ?`,
        )
        .all(groupJid, ownerId) as any[])
    : (db
        .prepare(
          `SELECT * FROM agent_channel_bindings WHERE channel = 'whatsapp' AND target_type = 'group' AND target_jid = ?`,
        )
        .all(groupJid) as any[]);
  return rows.map(mapBinding);
}

export function linkGroupToProject(
  ownerId: string | null,
  projectId: string,
  groupJid: string,
): void {
  const agents = getProjectAgents(projectId);
  for (const agent of agents) {
    const existing = db
      .prepare(
        `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ? LIMIT 1`,
      )
      .get(agent.id, groupJid) as any;

    if (existing) {
      db.prepare(
        'UPDATE agent_channel_bindings SET project_id = ?, enabled = 1 WHERE id = ?',
      ).run(projectId, existing.id);
    } else {
      db.prepare(
        `INSERT INTO agent_channel_bindings (id, owner_id, agent_id, channel, target_type, target_jid, project_id, trigger_mode, enabled, created_at)
         VALUES (?, ?, ?, 'whatsapp', 'group', ?, ?, 'mention', 1, ?)`,
      ).run(
        randomUUID(),
        ownerId,
        agent.id,
        groupJid,
        projectId,
        new Date().toISOString(),
      );
    }
  }
}

export function unlinkGroupFromProject(
  projectId: string,
  groupJid: string,
): void {
  db.prepare(
    `DELETE FROM agent_channel_bindings WHERE project_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ?`,
  ).run(projectId, groupJid);
}

export function setProjectGroupEnabled(
  projectId: string,
  groupJid: string,
  enabled: boolean,
  triggerMode?: 'mention' | 'all',
): void {
  if (triggerMode) {
    db.prepare(
      `UPDATE agent_channel_bindings SET enabled = ?, trigger_mode = ? WHERE project_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ?`,
    ).run(enabled ? 1 : 0, triggerMode, projectId, groupJid);
  } else {
    db.prepare(
      `UPDATE agent_channel_bindings SET enabled = ? WHERE project_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ?`,
    ).run(enabled ? 1 : 0, projectId, groupJid);
  }
}

export function updateAgentStatus(id: string, status: AgentStatus): void {
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
}

export function setAgentInterruptFlag(agentId: string): void {
  db.prepare(
    'UPDATE agents SET interrupt_requested = 1, interrupt_requested_at = ? WHERE id = ?',
  ).run(new Date().toISOString(), agentId);
}

export function clearAgentInterruptFlag(agentId: string): void {
  db.prepare(
    'UPDATE agents SET interrupt_requested = 0, interrupt_requested_at = NULL WHERE id = ?',
  ).run(agentId);
}

export function getAgentInterruptFlag(agentId: string): boolean {
  const row = db
    .prepare('SELECT interrupt_requested FROM agents WHERE id = ?')
    .get(agentId) as { interrupt_requested: number } | undefined;
  return (row?.interrupt_requested ?? 0) === 1;
}

export function updateAgentLastActive(id: string): void {
  db.prepare('UPDATE agents SET last_active = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
}

export function updateAgentIdentityVersion(id: string, version: number): void {
  db.prepare('UPDATE agents SET identity_version = ? WHERE id = ?').run(
    version,
    id,
  );
}

export function updateAgentConfig(id: string, config: Agent['config']): void {
  db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(
    JSON.stringify(config),
    id,
  );
}

export function updateAgentFields(
  id: string,
  fields: {
    name?: string;
    emoji?: string;
    config?: Agent['config'];
    whatsapp_jid?: string | null;
  },
): void {
  const parts: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) {
    parts.push('name = ?');
    values.push(fields.name);
  }
  if (fields.emoji !== undefined) {
    parts.push('emoji = ?');
    values.push(fields.emoji);
  }
  if (fields.config !== undefined) {
    parts.push('config = ?');
    values.push(JSON.stringify(fields.config));
  }
  if ('whatsapp_jid' in fields) {
    parts.push('whatsapp_jid = ?');
    values.push(fields.whatsapp_jid ?? null);
  }
  if (parts.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${parts.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getAgentByWhatsappJid(jid: string): Agent | null {
  const row = db
    .prepare('SELECT * FROM agents WHERE whatsapp_jid = ?')
    .get(jid) as any;
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config) };
}

/**
 * Delete an agent and everything that belongs to it.
 *
 * ATOMIC, and that is the point. These ran as five independent statements, so when
 * the last one hit a foreign-key error the first four had already committed: the
 * agent's cycles, memory, check-ins and file events were destroyed while the agent
 * row survived, and the caller saw only "FOREIGN KEY constraint failed" — which reads
 * like nothing happened. Two agents on the dev box were found gutted this way. A
 * transaction makes the whole thing roll back instead.
 *
 * Every table with a non-cascading FK to agents(id) must be listed here. Three were
 * missing (agent_episode_ledger, agent_learned_bullets, agent_fastlane_queue) — the
 * ledger arrived with Stage 34 and this function was never updated, which broke
 * deletion for any agent that had ever run a cycle. If you add a table that
 * references agents(id), add it here too, or agent deletion breaks again.
 * (Tables declared ON DELETE CASCADE clean themselves up and are deliberately absent.)
 */
export function deleteAgent(id: string): void {
  const tx = db.transaction((agentId: string) => {
    // Children first — agent_memory.source_cycle and agent_file_events.cycle_id both
    // reference agent_cycles(id), so cycles cannot go before them.
    db.prepare('DELETE FROM agent_file_events WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM agent_checkins WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM agent_memory WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM agent_episode_ledger WHERE agent_id = ?').run(
      agentId,
    );
    db.prepare('DELETE FROM agent_learned_bullets WHERE agent_id = ?').run(
      agentId,
    );
    db.prepare('DELETE FROM agent_fastlane_queue WHERE agent_id = ?').run(
      agentId,
    );
    db.prepare('DELETE FROM agent_cycles WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM artifact_docs WHERE agent_id = ?').run(agentId);
    // The agent's conversation log. No FK, so it never blocked the delete — it just
    // sat there forever after the agent was gone.
    db.prepare('DELETE FROM conversation_events WHERE conversation = ?').run(
      `agent:${agentId}`,
    );
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  });
  tx(id);
}

export function createAgentCycle(cycle: Omit<AgentCycle, 'id'>): AgentCycle {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agent_cycles (id, agent_id, cycle_type, status, started_at, ended_at, summary, episode_log, cost, tasks_done, project_id, resume_hint, model, human_requested, status_before, schedule_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    cycle.agent_id,
    cycle.cycle_type,
    cycle.status,
    cycle.started_at,
    cycle.ended_at ?? null,
    cycle.summary ?? null,
    cycle.episode_log ?? null,
    cycle.cost,
    cycle.tasks_done,
    cycle.project_id ?? null,
    cycle.resume_hint ?? null,
    cycle.model ?? null,
    cycle.human_requested ? 1 : 0,
    cycle.status_before ?? null,
    cycle.schedule_entry_id ?? null,
  );
  return { ...cycle, id };
}

export function updateAgentCycle(
  id: string,
  updates: Partial<Omit<AgentCycle, 'id' | 'agent_id'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.ended_at !== undefined) {
    fields.push('ended_at = ?');
    values.push(updates.ended_at);
  }
  if (updates.summary !== undefined) {
    fields.push('summary = ?');
    values.push(updates.summary);
  }
  if (updates.episode_log !== undefined) {
    fields.push('episode_log = ?');
    values.push(updates.episode_log);
  }
  if (updates.cost !== undefined) {
    fields.push('cost = ?');
    values.push(updates.cost);
  }
  if (updates.tasks_done !== undefined) {
    fields.push('tasks_done = ?');
    values.push(updates.tasks_done);
  }
  // What the cycle's browser work ACTUALLY used, not what it was allowed to use.
  //
  // The runner writes 'container' up front and the dispatch route promotes it to
  // 'user-browser' the first time a command really reaches that browser. It used to be
  // written once from the routing decision, which stopped being the same thing when the
  // lane became a per-tool-call choice (`identity`): a cycle permitted the user's browser
  // and then sweeping 300 public pages anonymously would still have been badged
  // "YOUR BROWSER — this cycle drove the browser on your machine".
  if (updates.lane !== undefined) {
    fields.push('lane = ?');
    values.push(updates.lane);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agent_cycles SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getCyclesByAgent(agentId: string, limit = 100): AgentCycle[] {
  return db
    .prepare(
      'SELECT * FROM agent_cycles WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(agentId, limit) as AgentCycle[];
}

export function getLastCycleForProject(projectId: string): AgentCycle | null {
  return (
    (db
      .prepare(
        'SELECT * FROM agent_cycles WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(projectId) as AgentCycle | undefined) ?? null
  );
}

/** Returns a Map of agentId → number of completed cycles. */
export function getCompletedCycleCounts(): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT agent_id, COUNT(*) AS n FROM agent_cycles WHERE status = 'completed' GROUP BY agent_id",
    )
    .all() as Array<{ agent_id: string; n: number }>;
  return new Map(rows.map((r) => [r.agent_id, r.n]));
}

// Per-agent count of completed cycles since local midnight — powers the "today" dashboard stat.
export function getCompletedCycleCountsToday(): Map<string, number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = db
    .prepare(
      "SELECT agent_id, COUNT(*) AS n FROM agent_cycles WHERE status = 'completed' AND started_at >= ? GROUP BY agent_id",
    )
    .all(start.toISOString()) as Array<{ agent_id: string; n: number }>;
  return new Map(rows.map((r) => [r.agent_id, r.n]));
}

export function getAgentCycleById(id: string): AgentCycle | null {
  return (
    (db.prepare('SELECT * FROM agent_cycles WHERE id = ?').get(id) as
      | AgentCycle
      | undefined) ?? null
  );
}

// ─── Per-cycle activity timeline (durable source of truth for the chat) ─────────

export interface CycleStep {
  type: 'thinking' | 'tool_call' | 'tool_result';
  id?: string;
  tool?: string;
  input?: string;
  output?: string | null;
  content?: string;
}

/** Replace a cycle's persisted activity steps (idempotent — safe to re-run). */
export function replaceCycleSteps(
  agentId: string,
  cycleId: string,
  steps: CycleStep[],
): void {
  const del = db.prepare('DELETE FROM cycle_steps WHERE cycle_id = ?');
  const ins = db.prepare(
    `INSERT INTO cycle_steps (id, cycle_id, agent_id, seq, type, tool, input, output, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction((rows: CycleStep[]) => {
    del.run(cycleId);
    rows.forEach((s, i) => {
      // PK is cycle-scoped: the adapter's step ids (th-0, tc-1, …) repeat across
      // cycles, so they can't be the global key. Keep the adapter's id in `content`-
      // adjacent fields where it matters; the row's own id is (cycleId, seq).
      ins.run(
        `${cycleId}-${i}`,
        cycleId,
        agentId,
        i,
        s.type,
        s.tool ?? null,
        s.input ?? null,
        s.output ?? null,
        s.content ?? null,
        now,
      );
    });
  });
  tx(steps);
}

/**
 * Upsert only specific (seq, step) rows of a cycle's activity — for the hot
 * per-push streaming path, where the caller has already diffed out which
 * steps are new or changed since the last push.
 *
 * `replaceCycleSteps` does a full delete+reinsert of the *entire* array on
 * every call; called once per pushed step (as `streamCycleSteps` used to do,
 * passing its whole cumulative array each time) that makes total DB work
 * across an N-step cycle O(N^2) — cheap for a short cycle, but a long cycle
 * (100+ steps, e.g. an agent working around a permission wall with repeated
 * retries) blocked the single-threaded orchestrator event loop long enough
 * to fail its own /health check. This does only the rows that changed.
 */
export function upsertCycleSteps(
  agentId: string,
  cycleId: string,
  entries: Array<{ seq: number; step: CycleStep }>,
): void {
  if (entries.length === 0) return;
  const ins = db.prepare(
    `INSERT INTO cycle_steps (id, cycle_id, agent_id, seq, type, tool, input, output, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type, tool = excluded.tool, input = excluded.input,
       output = excluded.output, content = excluded.content`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction((rows: Array<{ seq: number; step: CycleStep }>) => {
    for (const { seq, step: s } of rows) {
      ins.run(
        `${cycleId}-${seq}`,
        cycleId,
        agentId,
        seq,
        s.type,
        s.tool ?? null,
        s.input ?? null,
        s.output ?? null,
        s.content ?? null,
        now,
      );
    }
  });
  tx(entries);
}

/** Read a cycle's activity steps in order. Returns [] if none persisted. */
export function getCycleSteps(cycleId: string): CycleStep[] {
  const rows = db
    .prepare(
      'SELECT type, id, tool, input, output, content FROM cycle_steps WHERE cycle_id = ? ORDER BY seq',
    )
    .all(cycleId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    type: r.type as CycleStep['type'],
    id: (r.id as string) ?? undefined,
    tool: (r.tool as string) ?? undefined,
    input: (r.input as string) ?? undefined,
    output: (r.output as string | null) ?? undefined,
    content: (r.content as string) ?? undefined,
  }));
}

export interface ReconciledCycle {
  id: string;
  agent_id: string;
  cycle_type: CycleType;
  started_at: string;
}

/**
 * On startup, mark any cycles left in 'running' state as 'failed' (orchestrator died
 * mid-cycle). Returns the affected rows — not just a count — so the caller can raise a
 * real notification per cycle instead of a silent DB patch. Before this, a cycle killed
 * by a process restart bypassed the normal cycle_failed notify() path entirely (that path
 * only runs inside runCycle's own catch block, which a killed process never reaches), so
 * it never reached the dashboard, webhooks, or Sentry — only visible by querying the DB.
 */
export function reconcileStuckCycles(): ReconciledCycle[] {
  const now = new Date().toISOString();
  const stuck = db
    .prepare(
      `SELECT id, agent_id, cycle_type, started_at, status_before FROM agent_cycles WHERE status = 'running'`,
    )
    .all() as Array<ReconciledCycle & { status_before: AgentStatus | null }>;
  if (stuck.length === 0) return [];
  db.transaction(() => {
    db.prepare(
      `UPDATE agent_cycles SET status = 'failed', ended_at = ?, summary = 'Orchestrator restarted mid-cycle'
       WHERE status = 'running'`,
    ).run(now);
    // Put each agent back to the status it had before the cycle — the same rule as the
    // end of runCycle (_restoreStatusAfterCycle), which a killed process never reached.
    // Only an agent still reading 'running' is touched: 'paused'/'stopped' mean someone
    // (or the budget gate) parked it, and that must survive. A row from before this
    // column existed has no record, so it is left alone rather than guessed at.
    for (const c of stuck) {
      if (!c.status_before) continue;
      const restored = c.status_before === 'running' ? 'running' : 'idle';
      db.prepare(
        `UPDATE agents SET status = ? WHERE id = ? AND status = 'running'`,
      ).run(restored, c.agent_id);
    }
  })();
  return stuck.map(({ id, agent_id, cycle_type, started_at }) => ({
    id,
    agent_id,
    cycle_type,
    started_at,
  }));
}

/**
 * A running cycle's spend so far (agents/live-spend.ts). Only while it is still running: a
 * progress line can arrive after the final result has written the real cost, and must not
 * overwrite it.
 */
export function setRunningCycleCost(id: string, cost: number): void {
  db.prepare(
    `UPDATE agent_cycles SET cost = ? WHERE id = ? AND status = 'running'`,
  ).run(cost, id);
}

/**
 * Close a cycle record that is still open — the last line of runCycle's `finally`.
 *
 * Every normal exit writes the cycle's outcome itself. This catches the ones that don't:
 * an error thrown while the cycle's context is being built, or inside the failure
 * handling, left the row reading 'running' until the next restart. Returns whether it
 * had to.
 */
export function failCycleIfStillRunning(id: string, summary: string): boolean {
  return (
    db
      .prepare(
        `UPDATE agent_cycles SET status = 'failed', ended_at = ?, summary = ? WHERE id = ? AND status = 'running'`,
      )
      .run(new Date().toISOString(), summary, id).changes > 0
  );
}

// Every cycle's spend counts, not only completed ones. Until 2026-10-01 both of these read
// `status = 'completed'`, so a cycle that failed, timed out or was interrupted spent money
// that no budget ever saw — and a failed cycle had no cost recorded to see anyway.
export function getCycleCostToday(agentId: string): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost), 0) as total FROM agent_cycles
     WHERE agent_id = ? AND started_at >= ?`,
    )
    .get(agentId, start.toISOString()) as { total: number };
  return row.total;
}

// Platform-wide spend today across every agent — used to enforce GLOBAL_DAILY_BUDGET_USD.
export function getPlatformCostToday(): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost), 0) as total FROM agent_cycles
     WHERE started_at >= ?`,
    )
    .get(start.toISOString()) as { total: number };
  return row.total;
}

// Explicit column list (never `SELECT *`) for every public agent_memory read — `embedding`
// is a multi-KB BLOB that must never round-trip into a JSON API response or the dashboard.
const AGENT_MEMORY_COLUMNS =
  'id, agent_id, type, content, source_cycle, relevance, used_count, created_at, supersedes_id';

export function createAgentMemory(
  memory: Omit<AgentMemory, 'id' | 'created_at'>,
  embedding?: Buffer | null,
): AgentMemory {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_memory (id, agent_id, type, content, source_cycle, relevance, used_count, created_at, supersedes_id, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    memory.agent_id,
    memory.type,
    memory.content,
    memory.source_cycle ?? null,
    memory.relevance,
    memory.used_count,
    created_at,
    memory.supersedes_id ?? null,
    embedding ?? null,
  );
  return { ...memory, id, created_at };
}

export function getMemoryByAgent(
  agentId: string,
  type?: MemoryType,
): AgentMemory[] {
  if (type) {
    return db
      .prepare(
        `SELECT ${AGENT_MEMORY_COLUMNS} FROM agent_memory WHERE agent_id = ? AND type = ? ORDER BY relevance DESC, created_at DESC`,
      )
      .all(agentId, type) as AgentMemory[];
  }
  return db
    .prepare(
      `SELECT ${AGENT_MEMORY_COLUMNS} FROM agent_memory WHERE agent_id = ? ORDER BY relevance DESC, created_at DESC`,
    )
    .all(agentId) as AgentMemory[];
}

/**
 * Stage 34 Gap 3/4 — rows with their raw embedding BLOB, for in-process cosine similarity
 * (dedup during distillation, semantic ranking during retrieval). Never exposed over the API.
 */
export function getMemoryWithEmbeddings(
  agentId: string,
  typeFilter?: string,
): Array<AgentMemory & { embedding: Buffer | null }> {
  const clause = typeFilter ? 'AND type = ?' : '';
  const args = typeFilter ? [agentId, typeFilter] : [agentId];
  return db
    .prepare(
      `SELECT ${AGENT_MEMORY_COLUMNS}, embedding FROM agent_memory WHERE agent_id = ? ${clause}`,
    )
    .all(...args) as Array<AgentMemory & { embedding: Buffer | null }>;
}

export function deleteAgentMemory(id: string): void {
  db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id);
}

export function incrementMemoryUsed(id: string): void {
  db.prepare(
    'UPDATE agent_memory SET used_count = used_count + 1 WHERE id = ?',
  ).run(id);
}

/**
 * Stage 34 Gap 3 — soft supersession. Rather than deleting the memory a new one contradicts
 * (an LLM-judged supersession call can be wrong), we demote its relevance so it decays out
 * over subsequent prune cycles instead of sitting alongside the new memory at equal weight.
 * Recoverable: the row still exists, still searchable, just quieter.
 */
export function demoteMemoryRelevance(id: string, factor = 0.4): void {
  db.prepare(
    'UPDATE agent_memory SET relevance = relevance * ? WHERE id = ?',
  ).run(factor, id);
}

export function setMemoryEmbedding(id: string, embedding: Buffer): void {
  db.prepare('UPDATE agent_memory SET embedding = ? WHERE id = ?').run(
    embedding,
    id,
  );
}

// ─── Episode distillation ledger (Stage 34 Gap 2) ────────────────────────────

export function getDistilledEpisodeDates(agentId: string): Set<string> {
  const rows = db
    .prepare('SELECT episode_date FROM agent_episode_ledger WHERE agent_id = ?')
    .all(agentId) as Array<{ episode_date: string }>;
  return new Set(rows.map((r) => r.episode_date));
}

export function markEpisodesDistilled(
  agentId: string,
  episodeDates: string[],
): void {
  if (episodeDates.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO agent_episode_ledger (agent_id, episode_date, distilled_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id, episode_date) DO UPDATE SET distilled_at = excluded.distilled_at`,
  );
  const tx = db.transaction((dates: string[]) => {
    for (const d of dates) stmt.run(agentId, d, now);
  });
  tx(episodeDates);
}

// ─── Fast-lane consolidation queue (Stage 34 Gap 1) ──────────────────────────

export function queueFastlane(agentId: string, reason: string): void {
  db.prepare(
    `INSERT INTO agent_fastlane_queue (agent_id, tagged_at, reason) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET reason = excluded.reason`,
    // tagged_at is intentionally NOT updated on conflict — the debounce window in
    // AgentScheduler measures time since the FIRST salient event in the batch, so a
    // steady trickle of salient episodes can't push the fast-lane run back forever.
  ).run(agentId, new Date().toISOString(), reason);
}

export function getFastlanePending(
  agentId: string,
): { tagged_at: string; reason: string | null } | null {
  const row = db
    .prepare(
      'SELECT tagged_at, reason FROM agent_fastlane_queue WHERE agent_id = ?',
    )
    .get(agentId) as { tagged_at: string; reason: string | null } | undefined;
  return row ?? null;
}

export function clearFastlane(agentId: string): void {
  db.prepare('DELETE FROM agent_fastlane_queue WHERE agent_id = ?').run(
    agentId,
  );
}

// ─── Structured LEARNED bullets (Stage 34 Gap 5) ─────────────────────────────

export interface LearnedBullet {
  id: string;
  agent_id: string;
  text: string;
  source_memory_ids: string;
  created_at: string;
  updated_at: string;
}

export function getLearnedBullets(agentId: string): LearnedBullet[] {
  return db
    .prepare(
      'SELECT * FROM agent_learned_bullets WHERE agent_id = ? ORDER BY created_at ASC',
    )
    .all(agentId) as LearnedBullet[];
}

export function replaceLearnedBullets(
  agentId: string,
  bullets: Array<{ text: string; sourceMemoryIds?: string[] }>,
): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM agent_learned_bullets WHERE agent_id = ?').run(
      agentId,
    );
    const stmt = db.prepare(
      `INSERT INTO agent_learned_bullets (id, agent_id, text, source_memory_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bullets) {
      stmt.run(
        randomUUID(),
        agentId,
        b.text,
        JSON.stringify(b.sourceMemoryIds ?? []),
        now,
        now,
      );
    }
  });
  tx();
}

export function addLearnedBullet(
  agentId: string,
  text: string,
  sourceMemoryIds: string[] = [],
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_learned_bullets (id, agent_id, text, source_memory_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), agentId, text, JSON.stringify(sourceMemoryIds), now, now);
}

export function reviseLearnedBullet(id: string, text: string): void {
  db.prepare(
    'UPDATE agent_learned_bullets SET text = ?, updated_at = ? WHERE id = ?',
  ).run(text, new Date().toISOString(), id);
}

export function removeLearnedBullet(id: string): void {
  db.prepare('DELETE FROM agent_learned_bullets WHERE id = ?').run(id);
}

/**
 * Completed cycles that did the agent's actual work — not its own housekeeping
 * (self_improve) or check-ins — since `sinceIso`, or ever when null. The evidence gate for
 * identity evolution (identity-evolution.ts): one task is not a pattern.
 */
export function countCompletedWorkCyclesSince(
  agentId: string,
  sinceIso: string | null,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_cycles
      WHERE agent_id = ? AND status = 'completed'
        AND cycle_type NOT IN ('self_improve', 'checkin')
        AND (? IS NULL OR started_at > ?)`,
    )
    .get(agentId, sinceIso, sinceIso) as { n: number };
  return row.n;
}

export function updateAgentLastEvolvedAt(agentId: string, iso: string): void {
  db.prepare('UPDATE agents SET last_evolved_at = ? WHERE id = ?').run(
    iso,
    agentId,
  );
}

/**
 * Relevance decay + prune (natural forgetting). Run periodically (on self_improve).
 * Each pass nudges every memory's relevance down a little — slower for memories that have
 * been used, faster for untouched ones — then prunes faded, old memories so the store
 * doesn't accumulate stale facts forever. `user_profile` (manager facts) never decay.
 * Idempotent enough for periodic runs; relevance is clamped to [0,1].
 */
export function decayAndPruneMemories(
  agentId: string,
  opts: {
    unusedFactor?: number;
    usedFactor?: number;
    floor?: number;
    minAgeDaysToPrune?: number;
  } = {},
): { decayed: number; pruned: number } {
  const unusedFactor = opts.unusedFactor ?? 0.9;
  const usedFactor = opts.usedFactor ?? 0.97;
  const floor = opts.floor ?? 0.12;
  const minAgeDays = opts.minAgeDaysToPrune ?? 14;

  const rows = db
    .prepare(
      'SELECT id, type, relevance, used_count, created_at FROM agent_memory WHERE agent_id = ?',
    )
    .all(agentId) as Array<{
    id: string;
    type: string;
    relevance: number;
    used_count: number;
    created_at: string;
  }>;
  const upd = db.prepare('UPDATE agent_memory SET relevance = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM agent_memory WHERE id = ?');
  // `agent_memory.supersedes_id` is a self-referential FK declared with ON DELETE NO
  // ACTION (db.ts's own ALTER TABLE, above). So deleting a memory that some *newer*
  // memory says it superseded raises "FOREIGN KEY constraint failed", and because the
  // whole pass runs in one transaction, one such row aborts the entire decay.
  //
  // Seen in prod 2026-09-02: this threw inside a self_improve cycle, and the cycle's
  // catch marks the cycle failed and rethrows — so the AGENT DID NOT RUN. Memory
  // housekeeping stopped an agent from working.
  //
  // Clearing the pointer first is the fix that needs no migration: SQLite cannot ALTER
  // a constraint, so changing it to ON DELETE SET NULL means rebuilding the table on a
  // live database. And the pointer means nothing once its target is gone — "supersedes
  // a row that no longer exists" is not information worth a table rebuild to preserve.
  //
  // Not scoped to this agent on purpose: the FK is global, so anything anywhere
  // pointing at the row being deleted has to be cleared or the DELETE still fails.
  const clearSupersedes = db.prepare(
    'UPDATE agent_memory SET supersedes_id = NULL WHERE supersedes_id = ?',
  );
  let decayed = 0,
    pruned = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.type === 'user_profile') continue; // manager facts persist
      const factor = (r.used_count ?? 0) > 0 ? usedFactor : unusedFactor;
      const next = Math.max(0, Math.min(1, (r.relevance ?? 1) * factor));
      const ageDays = (Date.now() - Date.parse(r.created_at)) / 86_400_000;
      if (next < floor && ageDays >= minAgeDays) {
        clearSupersedes.run(r.id);
        del.run(r.id);
        pruned++;
      } else {
        upd.run(next, r.id);
        decayed++;
      }
    }
  });
  tx();
  return { decayed, pruned };
}

/**
 * Test seam: push a memory's created_at into the past.
 *
 * `decayAndPruneMemories` only prunes rows older than `minAgeDaysToPrune`, and
 * `createAgentMemory` stamps created_at itself — so without this a test cannot reach
 * the DELETE branch at all, which is the branch the FK bug lives in. Named with the
 * leading underscore the other test-only exports in this file use.
 */
export function _testBackdateMemory(id: string, days: number): void {
  db.prepare('UPDATE agent_memory SET created_at = ? WHERE id = ?').run(
    new Date(Date.now() - days * 86_400_000).toISOString(),
    id,
  );
}

export function insertToolAnalytic(rec: {
  agentId: string;
  cycleId?: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
  errorClass?: string;
  cacheHit: boolean;
}): void {
  db.prepare(
    `
    INSERT INTO tool_analytics (id, agent_id, cycle_id, tool_name, duration_ms, is_error, error_class, cache_hit, called_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    randomUUID(),
    rec.agentId,
    rec.cycleId ?? null,
    rec.toolName,
    rec.durationMs,
    rec.isError ? 1 : 0,
    rec.errorClass ?? null,
    rec.cacheHit ? 1 : 0,
    new Date().toISOString(),
  );
}

export function getToolAnalytics(agentId: string, days = 7): unknown[] {
  return db
    .prepare(
      `
    SELECT tool_name,
           COUNT(*) as total_calls,
           AVG(duration_ms) as avg_ms,
           MAX(duration_ms) as max_ms,
           SUM(is_error) as errors,
           SUM(cache_hit) as cache_hits,
           ROUND(SUM(is_error) * 100.0 / COUNT(*), 1) as error_rate
    FROM tool_analytics
    WHERE agent_id = ?
      AND called_at > datetime('now', '-' || ? || ' days')
    GROUP BY tool_name
    ORDER BY avg_ms DESC
  `,
    )
    .all(agentId, days);
}

export function searchAgentMemory(
  agentId: string,
  query: string,
  limit = 20,
  typeFilter?: string,
): AgentMemory[] {
  const lim = Math.min(limit, 100);
  // Sanitize for FTS5: raw queries with hyphens/colons/etc. make FTS5 misparse (e.g.
  // "check-primes" → tries to match a column "primes" and errors). Tokenize to alphanumeric
  // words, quote each as a literal, and OR them for recall — FTS5 still ranks by relevance.
  const tokens = (query || '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');
  const typeClause = typeFilter ? 'AND m.type = ?' : '';
  const ftsArgs = typeFilter
    ? [agentId, ftsQuery, typeFilter, lim]
    : [agentId, ftsQuery, lim];

  let rows = db
    .prepare(
      `
    SELECT m.id, m.agent_id, m.type, m.content, m.source_cycle,
           m.relevance, m.used_count, m.created_at,
           rank AS search_rank
    FROM agent_memory m
    JOIN agent_memory_fts f ON m.rowid = f.rowid
    WHERE f.agent_id = ?
      AND agent_memory_fts MATCH ?
      ${typeClause}
    ORDER BY rank
    LIMIT ?
  `,
    )
    .all(...ftsArgs) as AgentMemory[];

  if (rows.length === 0) {
    rows = db
      .prepare(
        `
      SELECT m.id, m.agent_id, m.type, m.content, m.source_cycle,
             m.relevance, m.used_count, m.created_at,
             rank AS search_rank
      FROM agent_memory m
      JOIN agent_memory_fts_trig f ON m.rowid = f.rowid
      WHERE f.agent_id = ?
        AND agent_memory_fts_trig MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(agentId, ftsQuery, lim) as AgentMemory[];
  }

  return rows;
}

export function createAgentCheckin(
  checkin: Omit<AgentCheckin, 'id' | 'created_at'> & { created_at?: string },
): AgentCheckin {
  const id = randomUUID();
  const created_at = checkin.created_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_checkins (id, agent_id, status, report_md, user_reply, created_at, responded_at, action_type, action_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    checkin.agent_id,
    checkin.status,
    checkin.report_md ?? null,
    checkin.user_reply ?? null,
    created_at,
    checkin.responded_at ?? null,
    checkin.action_type ?? null,
    checkin.action_payload ?? null,
  );
  const row = { ...checkin, id, created_at };
  for (const fn of checkinCreatedListeners) {
    try {
      fn(row);
    } catch (err) {
      logger.warn({ err, checkinId: id }, 'checkin-created listener threw');
    }
  }
  return row;
}

/**
 * Stage 64 phase 1: tell interested services a check-in exists, from the one function
 * every creator calls. There are eight creation sites (two HTTP routes, self-manage, the
 * reply poller, the sidecar, agent-service, swarm), so hooking them one by one is how one
 * gets missed. Listeners must be quick and must not throw into the caller.
 */
type CheckinCreatedListener = (checkin: AgentCheckin) => void;
const checkinCreatedListeners: CheckinCreatedListener[] = [];
export function onCheckinCreated(fn: CheckinCreatedListener): () => void {
  checkinCreatedListeners.push(fn);
  return () => {
    const i = checkinCreatedListeners.indexOf(fn);
    if (i >= 0) checkinCreatedListeners.splice(i, 1);
  };
}

// ── Stage 64 phase 1: owner prompts (see the owner_prompts table note) ────────────────

export type OwnerPromptKind = 'checkin' | 'escalation' | 'info';
export type OwnerPromptStatus = 'queued' | 'sent' | 'answered' | 'closed';

export interface OwnerPrompt {
  id: string;
  owner_id: string;
  agent_id: string | null;
  kind: OwnerPromptKind;
  ref_id: string | null;
  code: string;
  body: string | null;
  status: OwnerPromptStatus;
  wa_msg_id: string | null;
  answer: string | null;
  created_at: string;
  sent_at: string | null;
  answered_at: string | null;
}

// No I/O/0/1: a code is read off a phone screen and typed back.
const PROMPT_CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PROMPT_CODE_DIGITS = '23456789';

function newPromptCode(taken: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const code =
      PROMPT_CODE_LETTERS[
        Math.floor(Math.random() * PROMPT_CODE_LETTERS.length)
      ] +
      PROMPT_CODE_DIGITS[Math.floor(Math.random() * PROMPT_CODE_DIGITS.length)];
    if (!taken.has(code)) return code;
  }
  // 192 two-character codes are all open at once — fall back to three characters.
  let code: string;
  do {
    code =
      PROMPT_CODE_LETTERS[
        Math.floor(Math.random() * PROMPT_CODE_LETTERS.length)
      ] +
      PROMPT_CODE_DIGITS[
        Math.floor(Math.random() * PROMPT_CODE_DIGITS.length)
      ] +
      PROMPT_CODE_DIGITS[Math.floor(Math.random() * PROMPT_CODE_DIGITS.length)];
  } while (taken.has(code));
  return code;
}

/** A new prompt with a code that is unique among the owner's open prompts. */
export function createOwnerPrompt(input: {
  owner_id: string;
  agent_id?: string | null;
  kind: OwnerPromptKind;
  ref_id?: string | null;
  body?: string | null;
}): OwnerPrompt {
  const taken = new Set(getOpenOwnerPrompts(input.owner_id).map((p) => p.code));
  const row: OwnerPrompt = {
    id: randomUUID(),
    owner_id: input.owner_id,
    agent_id: input.agent_id ?? null,
    kind: input.kind,
    ref_id: input.ref_id ?? null,
    code: newPromptCode(taken),
    body: input.body ?? null,
    status: 'queued',
    wa_msg_id: null,
    answer: null,
    created_at: new Date().toISOString(),
    sent_at: null,
    answered_at: null,
  };
  db.prepare(
    `INSERT INTO owner_prompts (id, owner_id, agent_id, kind, ref_id, code, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    row.id,
    row.owner_id,
    row.agent_id,
    row.kind,
    row.ref_id,
    row.code,
    row.body,
    row.created_at,
  );
  return row;
}

export function getOwnerPrompt(id: string): OwnerPrompt | undefined {
  return db.prepare('SELECT * FROM owner_prompts WHERE id = ?').get(id) as
    | OwnerPrompt
    | undefined;
}

/** Queued or sent — anything the owner could still answer. Oldest first. */
export function getOpenOwnerPrompts(ownerId: string): OwnerPrompt[] {
  return db
    .prepare(
      `SELECT * FROM owner_prompts WHERE owner_id = ? AND status IN ('queued', 'sent') ORDER BY created_at ASC`,
    )
    .all(ownerId) as OwnerPrompt[];
}

/** Sent and still open, any owner — swept for ones answered elsewhere (the dashboard). */
export function getSentOwnerPrompts(): OwnerPrompt[] {
  return db
    .prepare(
      `SELECT * FROM owner_prompts WHERE status = 'sent' AND kind != 'info'`,
    )
    .all() as OwnerPrompt[];
}

/** Did this agent already raise a prompt of this kind since `sinceIso`? */
export function hasRecentOwnerPrompt(
  agentId: string,
  kind: OwnerPromptKind,
  sinceIso: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM owner_prompts WHERE agent_id = ? AND kind = ? AND created_at >= ? LIMIT 1`,
    )
    .get(agentId, kind, sinceIso);
}

/** Owners with anything still waiting to go out — what a flush pass walks. */
export function getOwnersWithQueuedPrompts(): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT owner_id FROM owner_prompts WHERE status = 'queued'`,
      )
      .all() as { owner_id: string }[]
  ).map((r) => r.owner_id);
}

export function getOwnerPromptByWaMsgId(
  ownerId: string,
  waMsgId: string,
): OwnerPrompt | undefined {
  return db
    .prepare(
      `SELECT * FROM owner_prompts WHERE owner_id = ? AND wa_msg_id = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(ownerId, waMsgId) as OwnerPrompt | undefined;
}

/** Every prompt a message carried — a digest is one WhatsApp message holding several. */
export function getOwnerPromptsByWaMsgId(
  ownerId: string,
  waMsgId: string,
): OwnerPrompt[] {
  return db
    .prepare(
      `SELECT * FROM owner_prompts WHERE owner_id = ? AND wa_msg_id = ? ORDER BY created_at ASC`,
    )
    .all(ownerId, waMsgId) as OwnerPrompt[];
}

export function getOpenOwnerPromptByRef(
  kind: OwnerPromptKind,
  refId: string,
): OwnerPrompt | undefined {
  return db
    .prepare(
      `SELECT * FROM owner_prompts WHERE kind = ? AND ref_id = ? AND status IN ('queued', 'sent') LIMIT 1`,
    )
    .get(kind, refId) as OwnerPrompt | undefined;
}

export function markOwnerPromptsSent(
  ids: string[],
  waMsgId: string | null,
): void {
  const at = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE owner_prompts SET status = 'sent', wa_msg_id = ?, sent_at = ? WHERE id = ? AND status = 'queued'`,
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(waMsgId, at, id);
  })();
}

/** Point an already-sent prompt at a newer message about it (the full view of a digest line). */
export function updateOwnerPromptWaId(id: string, waMsgId: string): void {
  db.prepare(`UPDATE owner_prompts SET wa_msg_id = ? WHERE id = ?`).run(
    waMsgId,
    id,
  );
}

/** Settle an open prompt. False when it was already settled — the caller lost a race. */
export function settleOwnerPrompt(
  id: string,
  status: 'answered' | 'closed',
  answer?: string | null,
): boolean {
  const res = db
    .prepare(
      `UPDATE owner_prompts SET status = ?, answer = ?, answered_at = ?
     WHERE id = ? AND status IN ('queued', 'sent')`,
    )
    .run(status, answer ?? null, new Date().toISOString(), id);
  return res.changes > 0;
}

export interface NotifyPrefs {
  /** Send approvals and questions to the owner's WhatsApp. Default on. */
  whatsapp: boolean;
  /**
   * The owner's phone, digits only with country code ("919876543210"). Unset = the number
   * of the WhatsApp the owner linked. A message from your own account to yourself doesn't
   * ring your phone, so this is the number the notifier account writes TO.
   */
  phone: string | null;
  /**
   * Telegram chat the owner linked from Account → Phone notifications (one-time code via the
   * platform bot). When set and the bot runs, notifications go there first: a bot is its own
   * account, so it rings without a second phone number. Only the link flow writes it.
   */
  telegramChatId: string | null;
  /** 'HH:MM' in the orchestrator's TIMEZONE. Both set = quiet hours on. */
  quietStart: string | null;
  quietEnd: string | null;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  whatsapp: true,
  phone: null,
  telegramChatId: null,
  quietStart: null,
  quietEnd: null,
};

export function getUserNotifyPrefs(userId: string): NotifyPrefs {
  const row = db
    .prepare('SELECT notify_prefs FROM users WHERE id = ?')
    .get(userId) as { notify_prefs: string | null } | undefined;
  if (!row?.notify_prefs) return { ...DEFAULT_NOTIFY_PREFS };
  try {
    const p = JSON.parse(row.notify_prefs) as Partial<NotifyPrefs>;
    return {
      whatsapp:
        typeof p.whatsapp === 'boolean'
          ? p.whatsapp
          : DEFAULT_NOTIFY_PREFS.whatsapp,
      phone: typeof p.phone === 'string' && p.phone ? p.phone : null,
      telegramChatId:
        typeof p.telegramChatId === 'string' && p.telegramChatId
          ? p.telegramChatId
          : null,
      quietStart: typeof p.quietStart === 'string' ? p.quietStart : null,
      quietEnd: typeof p.quietEnd === 'string' ? p.quietEnd : null,
    };
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS };
  }
}

export function setUserNotifyPrefs(userId: string, prefs: NotifyPrefs): void {
  db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(
    JSON.stringify(prefs),
    userId,
  );
}

export function getCheckinsByAgent(agentId: string): AgentCheckin[] {
  return db
    .prepare(
      'SELECT * FROM agent_checkins WHERE agent_id = ? ORDER BY created_at DESC',
    )
    .all(agentId) as AgentCheckin[];
}

export function getPendingCheckins(): AgentCheckin[] {
  return db
    .prepare(
      "SELECT * FROM agent_checkins WHERE status = 'pending' ORDER BY created_at DESC",
    )
    .all() as AgentCheckin[];
}

export function updateAgentCheckin(
  id: string,
  updates: Partial<
    Pick<AgentCheckin, 'status' | 'user_reply' | 'responded_at'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.user_reply !== undefined) {
    fields.push('user_reply = ?');
    values.push(updates.user_reply);
  }
  if (updates.responded_at !== undefined) {
    fields.push('responded_at = ?');
    values.push(updates.responded_at);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agent_checkins SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function logAgentFileEvent(
  event: Omit<AgentFileEvent, 'id' | 'timestamp'>,
): void {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_file_events (id, agent_id, cycle_id, event_type, file_path, diff_patch, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.agent_id,
    event.cycle_id,
    event.event_type,
    event.file_path,
    event.diff_patch ?? null,
    timestamp,
  );
}

export function getFileEventsByCycle(cycleId: string): AgentFileEvent[] {
  return db
    .prepare(
      'SELECT * FROM agent_file_events WHERE cycle_id = ? ORDER BY timestamp ASC',
    )
    .all(cycleId) as AgentFileEvent[];
}

// ─── Stage 35 — conversation event stream ─────────────────────────────────────
// Persistence for the single ordered conversation log. Note these are the raw DB
// primitives: everything that writes conversational state goes through
// appendConversationEvent() in conversation-events.ts, which wraps insert +
// socket emit. Don't call insertConversationEvent directly from producers.

// NOTE: there is deliberately no conversationForCycle() helper here.
// It existed, resolving a cycle's conversation from its project_id, and that is
// precisely how a cycle's events ended up split across two threads: the messages and
// steps follow runCycle's streamJid (falling back to `agent:<id>`), so a
// project-scoped cycle started WITHOUT a chatJid — the scheduler, pipelines,
// handoffs — had its files filed under `project:<pid>` while everything else went to
// `agent:<id>`. The orphaned file events then opened a turn nothing ever closed.
// A cycle's conversation is whatever runCycle streams to; producers must be told it
// (see FileTracker.persistEvents), never re-derive it.

/**
 * Append one event to a conversation's log, allocating the next `seq` for that
 * conversation. better-sqlite3 is synchronous and the orchestrator is a single
 * process, so the transaction makes read-max-then-insert atomic and `seq` gaplessly
 * monotonic. (A horizontally-scaled orchestrator would need the seq allocated by
 * the DB instead — noted, not a problem today.)
 *
 * `id` is an optional caller-supplied idempotency key. Producers that may replay
 * the same logical event pass a stable key (e.g. a cycle step's `${cycleId}-${seq}`,
 * re-pushed verbatim after an orchestrator restart resets the stream's in-memory
 * dedup state). A replayed key updates the existing row's mutable fields in place
 * and keeps its original `seq` — it does NOT append a second copy or renumber the
 * log, so a replay can't reorder history or duplicate it in the UI.
 */
export function insertConversationEvent(
  conversation: string,
  ev: NewConversationEvent,
  id?: string,
): ConversationEvent {
  const tx = db.transaction((): ConversationEvent => {
    const rowId = id ?? randomUUID();
    const existing = db
      .prepare('SELECT 1 FROM conversation_events WHERE id = ?')
      .get(rowId);
    if (existing) {
      // Mutable fields only — conversation/seq/cycle_id/created_at are the row's
      // identity and position in the log, and a replay must not move it.
      db.prepare(
        `UPDATE conversation_events SET type = ?, role = ?, content = ?, tool_name = ?,
           tool_input = ?, tool_output = ?, file_path = ?, diff_patch = ?, status = ?, metadata = ?
         WHERE id = ?`,
      ).run(
        ev.type,
        ev.role ?? null,
        ev.content ?? null,
        ev.tool_name ?? null,
        ev.tool_input ?? null,
        ev.tool_output ?? null,
        ev.file_path ?? null,
        ev.diff_patch ?? null,
        ev.status ?? null,
        ev.metadata ?? null,
        rowId,
      );
      // Re-read rather than reconstruct, so what we return (and broadcast) is exactly
      // what's stored — a merged-object guess could disagree with the row.
      return db
        .prepare('SELECT * FROM conversation_events WHERE id = ?')
        .get(rowId) as ConversationEvent;
    }
    const seq =
      ((
        db
          .prepare(
            'SELECT MAX(seq) AS m FROM conversation_events WHERE conversation = ?',
          )
          .get(conversation) as { m: number | null }
      ).m ?? 0) + 1;
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversation_events
         (id, conversation, seq, cycle_id, type, role, content, tool_name, tool_input,
          tool_output, file_path, diff_patch, status, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowId,
      conversation,
      seq,
      ev.cycle_id ?? null,
      ev.type,
      ev.role ?? null,
      ev.content ?? null,
      ev.tool_name ?? null,
      ev.tool_input ?? null,
      ev.tool_output ?? null,
      ev.file_path ?? null,
      ev.diff_patch ?? null,
      ev.status ?? null,
      ev.metadata ?? null,
      created_at,
    );
    // Re-read so the returned event is the row itself. This matters beyond tidiness:
    // this object is what gets broadcast live, while a reload gets the row from the
    // read endpoint. Returning a reconstructed object would hand the live path
    // `undefined` where the reload path has `null` — the two renderings of the same
    // event would differ in shape, which is the exact class of divergence this stream
    // exists to eliminate.
    return db
      .prepare('SELECT * FROM conversation_events WHERE id = ?')
      .get(rowId) as ConversationEvent;
  });
  return tx();
}

/**
 * Per-field caps for the READ path. A stored event keeps the full text — the log is the
 * audit trail and must not lose anything — but shipping it all to a browser is what
 * turned one real conversation's first page into a 241 MB JSON response, stringified
 * synchronously on an orchestrator shared by every tenant. That is the same failure the
 * file-tracker guard already documents ("oversized diff_patch strings ... exhausted the
 * orchestrator's V8 heap and crashed the whole process").
 *
 * The caps cost nothing visible: CycleTimeline slices tool input/output to 4 000 chars
 * before rendering, so anything past that was never on screen anyway.
 */
const READ_CAP_TOOL = 8_000;
const READ_CAP_DIFF = 32_000;
const READ_CAP_TEXT = 100_000;

/**
 * Truncate only if it's a string over the cap. Anything else — null, undefined — is
 * returned EXACTLY as it came out of the row: a live socket event and a reloaded one
 * must stay identical field for field, and quietly turning null into undefined here
 * would reintroduce precisely the live-vs-reload divergence this stream exists to
 * remove. (The identity test caught that; it's why this isn't a `?? undefined`.)
 */
function truncField<T>(v: T, cap: number): T {
  if (typeof v !== 'string' || v.length <= cap) return v;
  return `${v.slice(0, cap)}\n… [truncated — ${v.length} chars total]` as unknown as T;
}

/** Trim the heavy fields of an event for transport. The stored row is untouched. */
function capEventForRead(e: ConversationEvent): ConversationEvent {
  return {
    ...e,
    content: truncField(e.content, READ_CAP_TEXT),
    tool_input: truncField(e.tool_input, READ_CAP_TOOL),
    tool_output: truncField(e.tool_output, READ_CAP_TOOL),
    diff_patch: truncField(e.diff_patch, READ_CAP_DIFF),
  };
}

/**
 * Read a conversation's events in seq order.
 *
 * `afterSeq = 0` (the default) means "open this conversation" and returns the NEWEST
 * `limit` events, not the oldest. That distinction is the whole thing: it used to return
 * the first page ascending, so a conversation longer than `limit` showed its opening
 * messages and could never reach the recent ones no matter how long you waited.
 *
 * `afterSeq > 0` is the client's cursor — return only what's new since it saw `afterSeq`,
 * which is how a socket drop heals.
 *
 * Either way the result is ascending by seq, and heavy fields are capped for transport.
 */
export function getConversationEvents(
  conversation: string,
  afterSeq = 0,
  limit = 500,
  beforeSeq?: number,
): ConversationEvent[] {
  let rows: ConversationEvent[];
  if (beforeSeq && beforeSeq > 0) {
    // Paging BACK: the `limit` events immediately before the oldest one already held.
    // Descending to take the ones nearest the cursor, then flipped to chronological.
    rows = (
      db
        .prepare(
          `SELECT * FROM conversation_events WHERE conversation = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
        )
        .all(conversation, beforeSeq, limit) as ConversationEvent[]
    ).reverse();
  } else if (afterSeq > 0) {
    rows = db
      .prepare(
        `SELECT * FROM conversation_events WHERE conversation = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
      )
      .all(conversation, afterSeq, limit) as ConversationEvent[];
  } else {
    // Newest page, then flip back to ascending so callers always see chronological order.
    rows = (
      db
        .prepare(
          `SELECT * FROM conversation_events WHERE conversation = ?
       ORDER BY seq DESC LIMIT ?`,
        )
        .all(conversation, limit) as ConversationEvent[]
    ).reverse();
  }
  return rows.map(capEventForRead);
}

/** The lowest seq in a conversation — the client has reached the start when its oldest
 *  loaded event equals this. Lets the UI stop offering "load older" at the true beginning. */
export function getConversationTailSeq(conversation: string): number {
  return (
    (
      db
        .prepare(
          'SELECT MIN(seq) AS m FROM conversation_events WHERE conversation = ?',
        )
        .get(conversation) as { m: number | null }
    ).m ?? 0
  );
}

/** Highest seq in a conversation (0 if empty) — the head of the log. */
export function getConversationHeadSeq(conversation: string): number {
  return (
    (
      db
        .prepare(
          'SELECT MAX(seq) AS m FROM conversation_events WHERE conversation = ?',
        )
        .get(conversation) as { m: number | null }
    ).m ?? 0
  );
}

/** Wipe a conversation's event log. Pair with deleteMessagesByJid — under
 *  FLAGS.conversationEvents (on by default) this is what the chat UI actually
 *  renders, so clearing only `messages` leaves the visible transcript intact. */
export function deleteConversationEvents(conversation: string): void {
  db.prepare('DELETE FROM conversation_events WHERE conversation = ?').run(
    conversation,
  );
}

/**
 * One-time backfill of pre-existing conversations into the event log (Stage 35
 * Phase 5). Folds the three legacy tables into `conversation_events` so old threads
 * render under the new read path.
 *
 * Guarded to run once (a router_state marker) so it doesn't rescan on every
 * startup, and non-destructive: a conversation that already has events — i.e. the
 * dual-write has run for it — is skipped, never rewritten. On a fresh prod DB the
 * table is empty, so every conversation is folded in cleanly; the skip only matters
 * on a dev DB that has already been dual-writing.
 *
 * Returns the number of conversations backfilled.
 */
export function backfillConversationEvents(): number {
  if (getRouterState('stage35_backfill_v1') === 'done') return 0;

  // Every agent:/project: thread that has message history.
  const jids = (
    db
      .prepare(
        "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE 'agent:%' OR chat_jid LIKE 'project:%'",
      )
      .all() as Array<{ chat_jid: string }>
  ).map((r) => r.chat_jid);

  let done = 0;
  for (const conversation of jids) {
    // Non-destructive: leave any conversation the dual-write already populated.
    if (getConversationHeadSeq(conversation) > 0) continue;

    const messages = getChatHistory(conversation, '');
    if (messages.length === 0) continue;

    // Collect every cycle referenced by a tagged message, then read its steps/files.
    const cycleIds = new Set<string>();
    for (const m of messages) {
      const tag = m.id.match(
        /^cyc-(.+)-(?:start|result|fail|msg)-[0-9a-f]{8}$/,
      );
      if (tag) cycleIds.add(tag[1]);
    }
    const stepsByCycle: Record<string, CycleStep[]> = {};
    const fileEventsByCycle: Record<string, AgentFileEvent[]> = {};
    for (const cid of cycleIds) {
      stepsByCycle[cid] = getCycleSteps(cid);
      fileEventsByCycle[cid] = getFileEventsByCycle(cid);
    }

    const events = buildBackfillEvents({
      messages,
      stepsByCycle,
      fileEventsByCycle,
    });
    const tx = db.transaction((rows: NewConversationEvent[]) => {
      for (const ev of rows) insertConversationEvent(conversation, ev);
    });
    tx(events);
    if (events.length > 0) done++;
  }

  setRouterState('stage35_backfill_v1', 'done');
  return done;
}

export function getCheckinById(id: string): AgentCheckin | null {
  return (
    (db.prepare('SELECT * FROM agent_checkins WHERE id = ?').get(id) as
      | AgentCheckin
      | undefined) ?? null
  );
}

export function getPendingCheckinByAgent(agentId: string): AgentCheckin | null {
  return (
    (db
      .prepare(
        "SELECT * FROM agent_checkins WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(agentId) as AgentCheckin | undefined) ?? null
  );
}

// ─── Artifact docs (Stage 58) ────────────────────────────────────────────────

export function listArtifactDocs(
  agentId: string,
  filePath: string,
): ArtifactDoc[] {
  return db
    .prepare(
      'SELECT * FROM artifact_docs WHERE agent_id = ? AND file_path = ? ORDER BY doc_id',
    )
    .all(agentId, filePath) as ArtifactDoc[];
}

export function getArtifactDoc(
  agentId: string,
  filePath: string,
  docId: string,
): ArtifactDoc | null {
  return (
    (db
      .prepare(
        'SELECT * FROM artifact_docs WHERE agent_id = ? AND file_path = ? AND doc_id = ?',
      )
      .get(agentId, filePath, docId) as ArtifactDoc | undefined) ?? null
  );
}

export function upsertArtifactDoc(
  agentId: string,
  filePath: string,
  docId: string,
  data: string,
): ArtifactDoc {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO artifact_docs (agent_id, file_path, doc_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, file_path, doc_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(agentId, filePath, docId, data, now);
  return {
    agent_id: agentId,
    file_path: filePath,
    doc_id: docId,
    data,
    updated_at: now,
  };
}

export function deleteArtifactDoc(
  agentId: string,
  filePath: string,
  docId: string,
): void {
  db.prepare(
    'DELETE FROM artifact_docs WHERE agent_id = ? AND file_path = ? AND doc_id = ?',
  ).run(agentId, filePath, docId);
}

export function getWeeklyCycles(agentId: string): AgentCycle[] {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      "SELECT * FROM agent_cycles WHERE agent_id = ? AND started_at >= ? AND status = 'completed' ORDER BY started_at ASC",
    )
    .all(agentId, weekAgo) as AgentCycle[];
}

// ─── Agent Handoffs ───────────────────────────────────────────────────────────

/**
 * What a message IS, as distinct from where it has got to.
 *
 * Borrowed from the speech-act protocols (FIPA ACL, and the Contract Net work before it).
 * They converged on roughly this set because these are the things a collaborator actually
 * needs to be able to say, and two of them are the ones this system has never had:
 *
 *   `cannot` is the keystone. An agent answering "I would, but I do not have
 *   verify_email" is worth more than a successful handoff, because it is actionable — by
 *   the sender, by the owner, and by the capability index in phase 2. It converts a
 *   silent dead end into a routing decision. It is also the message a human collaborator
 *   most often fails to send; we say we will get to it.
 *
 *   `refuse` must carry a reason, and the route enforces that. A bare rejection is
 *   dangerous here specifically: a bare `reject` on a check-in was once LLM-summarised
 *   into invented instructions and written to IDENTITY.md at relevance 0.9. A refusal
 *   with no reason gets a reason imagined for it.
 */
export type HandoffPerformative =
  | 'request' // do this / answer this          — opens an exchange
  | 'inform' // here is data you did not ask for — opens an exchange, wants no answer
  | 'agree' // I will do it; not done yet
  | 'refuse' // I will not — with a reason
  | 'cannot' // I would, but I lack the tool/skill/access — names what is missing
  | 'result' // here is the answer
  | 'failure' // I tried and it broke — with the error
  | 'expire'; // nobody answered in time. Written by the system, never by an agent

/** Performatives that answer an existing message rather than opening one. */
export const REPLY_PERFORMATIVES: readonly HandoffPerformative[] = [
  'agree',
  'refuse',
  'cannot',
  'result',
  'failure',
];

/**
 * Where a message has got to.
 *
 * `pending` and `completed` are the pre-existing names and keep their meaning — both are
 * honest, and `pending` in particular is load-bearing (the scheduler's send_outreach gate
 * arms off it). `acknowledged` is the one that had to go: it was set by any cycle the
 * recipient ran, so it meant "you woke up", and it read as "handled" 347 times.
 */
export type HandoffStatus =
  | 'pending' // the sender wrote it; nothing has come back
  | 'seen' // it reached the recipient's context (the honest form of 'acknowledged')
  | 'agreed' // the recipient took it on and has not finished
  | 'completed' // answered with a result
  | 'refused' // answered with a reason
  | 'cannot' // answered with a named missing capability
  | 'failed' // the recipient tried and it broke
  | 'expired'; // nobody answered in time, or it was closed out as unanswerable

/** The status a reply of each kind leaves on the message it answers. */
export const PERFORMATIVE_TO_STATUS: Record<string, HandoffStatus> = {
  agree: 'agreed',
  result: 'completed',
  refuse: 'refused',
  cannot: 'cannot',
  failure: 'failed',
};

/**
 * Request vs answer, in SQL.
 *
 * Phase 4 made `reply_to` mean "part of this thread" rather than "is an answer": a
 * follow-up QUESTION also points at the message before it. So every filter that used to
 * ask `reply_to IS NULL` has to ask what the message IS instead, or a follow-up question
 * gets filed under "answers to you" and nobody ever answers it.
 *
 * `COALESCE` because rows written before stage 56 carry no performative and are all
 * requests.
 */
const IS_REQUEST = `COALESCE(performative, 'request') IN ('request', 'inform')`;
const IS_ANSWER = `COALESCE(performative, 'request') NOT IN ('request', 'inform')`;

/** Terminal for the sender's purposes — an answer arrived, or the question lapsed. */
const ANSWERED_STATUSES = [
  'completed',
  'refused',
  'cannot',
  'failed',
  'expired',
];

/**
 * Close out messages nobody can honestly answer any more.
 *
 * Run once against the pre-stage-56 backlog: 320 messages sat `seen` and unanswered
 * because until 2026-09-09 there was no way to answer one. Having the agents answer them
 * now would mean reconstructing three weeks of history from memory, and this system has a
 * documented failure mode for exactly that — Finder invented an email address to fill a gap
 * in its own knowledge. Three hundred confabulated results written into the ledger as fact
 * is a worse outcome than an honest gap.
 *
 * So they are marked `expired` with a stated reason. The point is not tidiness: it is that
 * "unanswered" must mean today's silence rather than August's, or the signal this stage
 * built is unreadable from the day it ships.
 */
export function expireHandoffsBefore(
  cutoffIso: string,
  reason: string,
): number {
  const res = db
    .prepare(
      `UPDATE agent_handoffs
        SET status = 'expired', result_reason = ?, replied_at = ?
      WHERE COALESCE(performative, 'request') = 'request'
        AND created_at < ?
        AND status IN ('pending', 'seen', 'agreed')`,
    )
    .run(reason, new Date().toISOString(), cutoffIso);
  return res.changes;
}

export interface AgentHandoff {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  payload: string; // JSON
  note?: string;
  status: HandoffStatus;
  created_at: string;
  completed_at?: string;
  performative?: HandoffPerformative;
  reply_to?: string;
  result?: string;
  result_reason?: string;
  replied_at?: string;
  cycle_id?: string;
  /** Root message of the exchange this belongs to. Equals `id` for a first message. */
  thread_id?: string;
  /** When an unanswered request lapses. Null means no deadline was set. */
  deadline_at?: string;
}

export function createHandoff(
  handoff: Omit<AgentHandoff, 'id' | 'created_at'>,
  /** Override the timestamp. For backfill and for tests that need a real spread of ages. */
  createdAt?: string,
): AgentHandoff {
  const id = randomUUID();
  const created_at = createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_handoffs (id, from_agent_id, to_agent_id, type, payload, note, status, created_at,
                                 performative, reply_to, cycle_id, thread_id, deadline_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    handoff.from_agent_id,
    handoff.to_agent_id,
    handoff.type,
    handoff.payload,
    handoff.note ?? null,
    handoff.status,
    created_at,
    handoff.performative ?? null,
    handoff.reply_to ?? null,
    handoff.cycle_id ?? null,
    // A message with no parent opens its own thread. Doing this here rather than at every
    // call site is what keeps `thread_id` reliably non-null for anything written since.
    handoff.thread_id ?? handoff.reply_to ?? id,
    handoff.deadline_at ?? null,
  );
  return {
    ...handoff,
    id,
    created_at,
    thread_id: handoff.thread_id ?? handoff.reply_to ?? id,
  };
}

/**
 * The same message, already sent in this cycle — or null.
 *
 * `06` asked for this in as many words: "The same request twice should return the first
 * answer, not run twice." A retry loop that re-sends an identical handoff should get the
 * row it already made, not a ninetieth copy of it, and the recipient should not be shown
 * the same question ninety times.
 *
 * Scoped to the cycle deliberately. Across cycles the same request is usually legitimate —
 * Finder hands Mailer a fresh batch of the same shape every day, and treating that as a
 * duplicate would silently drop real work.
 */
export function findDuplicateRequest(
  fromAgentId: string,
  toAgentId: string,
  cycleId: string,
  type: string,
  payload: string,
): AgentHandoff | null {
  const row = db
    .prepare(
      `SELECT * FROM agent_handoffs
      WHERE from_agent_id = ? AND to_agent_id = ? AND cycle_id = ? AND type = ? AND payload = ?
      ORDER BY created_at ASC LIMIT 1`,
    )
    .get(fromAgentId, toAgentId, cycleId, type, payload) as
    | AgentHandoff
    | undefined;
  return row ?? null;
}

export function getHandoffsByAgent(agentId: string): AgentHandoff[] {
  return db
    .prepare(
      'SELECT * FROM agent_handoffs WHERE to_agent_id = ? OR from_agent_id = ? ORDER BY created_at DESC',
    )
    .all(agentId, agentId) as AgentHandoff[];
}

export function getHandoffById(id: string): AgentHandoff | null {
  return (
    (db.prepare('SELECT * FROM agent_handoffs WHERE id = ?').get(id) as
      | AgentHandoff
      | undefined) ?? null
  );
}

/**
 * Undelivered messages for this agent — work handed to it, and answers to work it handed
 * out. Both arrive the same way, which is the point of making a reply a row.
 *
 * `workOnly` excludes replies, and every caller that is deciding whether the agent OWES
 * something must pass it. The scheduler's send_outreach gate is the reason: it arms off
 * "are there pending handoffs", and a reply landing in Mailer's inbox is not work owed —
 * counting it would arm a send gate off an acknowledgement. That is a variant of exactly
 * the bug that stalled Mailer for 33 hours, so it is a named parameter rather than a
 * second function nobody notices they should have called.
 */
export function getPendingHandoffsByAgent(
  agentId: string,
  opts: { workOnly?: boolean } = {},
): AgentHandoff[] {
  const sql = opts.workOnly
    ? `SELECT * FROM agent_handoffs WHERE to_agent_id = ? AND status = 'pending' AND ${IS_REQUEST} ORDER BY created_at ASC`
    : "SELECT * FROM agent_handoffs WHERE to_agent_id = ? AND status = 'pending' ORDER BY created_at ASC";
  return db.prepare(sql).all(agentId) as AgentHandoff[];
}

/**
 * What this agent should be looking at: work it still owes an answer on, and answers it
 * has not yet been shown.
 *
 * Distinct from `getPendingHandoffsByAgent`, and the distinction is the point. That one
 * returns what is UNREAD; this returns what is UNRESOLVED. Surfacing only the unread gave
 * an agent exactly one cycle's chance to reply — a message flipped to `seen` on the way
 * out of the first cycle that carried it, and from then on it was invisible whether it had
 * been answered or not.
 *
 * That is the same disease as the old `acknowledged`: the state that means "you saw this
 * and said nothing" is precisely the state that must stay in view. Found 2026-09-09 on the
 * first live test — Mailer had 82 messages owed and would have been shown none of them.
 *
 * Capped, newest first, because 82 messages at once is a context problem of its own. The
 * caller is told how many were left out, and `self_report`'s reality check carries the
 * full number.
 */
export interface OpenMessages {
  /** Requests addressed to this agent that carry no answer yet. */
  owed: AgentHandoff[];
  /** Replies to this agent's own requests that it has not been shown. */
  replies: AgentHandoff[];
  /** Owed messages beyond the cap. */
  owedOverflow: number;
}

export function getOpenMessagesForAgent(
  agentId: string,
  limit = 10,
): OpenMessages {
  // `agreed` belongs here as much as `seen` does. "I will do it next slot" is a promise,
  // not an answer — dropping it from view is how a promise becomes silence, which is the
  // same failure wearing a more cooperative face.
  const owedAll = db
    .prepare(
      `SELECT * FROM agent_handoffs
      WHERE to_agent_id = ?
        AND COALESCE(performative, 'request') = 'request'
        AND status IN ('pending', 'seen', 'agreed')
      ORDER BY created_at DESC`,
    )
    .all(agentId) as AgentHandoff[];

  const replies = db
    .prepare(
      `SELECT * FROM agent_handoffs
      WHERE to_agent_id = ? AND ${IS_ANSWER} AND status = 'pending'
      ORDER BY created_at ASC`,
    )
    .all(agentId) as AgentHandoff[];

  return {
    // Newest first for the cap, oldest first for reading — the sender of the oldest
    // unanswered message has been waiting longest, and it should be answered first.
    owed: owedAll.slice(0, limit).reverse(),
    replies,
    owedOverflow: Math.max(0, owedAll.length - limit),
  };
}

/**
 * Messages this agent asked for and has not been answered on.
 *
 * `inform` is excluded: it wants no answer, so leaving it here would show every agent a
 * permanent list of things nobody owes it.
 */
export function getUnansweredRequestsByAgent(agentId: string): AgentHandoff[] {
  return db
    .prepare(
      `SELECT * FROM agent_handoffs
      WHERE from_agent_id = ?
        AND COALESCE(performative, 'request') = 'request'
        AND status NOT IN (${ANSWERED_STATUSES.map(() => '?').join(', ')})
      ORDER BY created_at ASC`,
    )
    .all(agentId, ...ANSWERED_STATUSES) as AgentHandoff[];
}

/**
 * Messages addressed to this agent that it has never answered.
 *
 * `seen` counts: it means a cycle ran with the message in front of it and said nothing
 * back, which is precisely the state 347 rows sat in while reading as handled.
 */
export function getMessagesOwedCount(agentId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_handoffs
      WHERE to_agent_id = ?
        AND COALESCE(performative, 'request') = 'request'
        AND status IN ('pending', 'seen', 'agreed')`,
    )
    .get(agentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function updateHandoffStatus(
  id: string,
  status: HandoffStatus,
  completedAt?: string,
): void {
  if (status === 'completed') {
    db.prepare(
      'UPDATE agent_handoffs SET status = ?, completed_at = ? WHERE id = ?',
    ).run(status, completedAt ?? new Date().toISOString(), id);
  } else {
    db.prepare('UPDATE agent_handoffs SET status = ? WHERE id = ?').run(
      status,
      id,
    );
  }
}

export interface ReplyToHandoffInput {
  /** The message being answered. */
  handoffId: string;
  /** The replier. Must be the message's recipient — the route checks, this does not. */
  fromAgentId: string;
  performative: HandoffPerformative;
  /** The answer itself. Free-form text; the sender reads it, not a parser. */
  result: string;
  /** Required for refuse/cannot/failure. For `cannot`, the capability that is missing. */
  reason?: string;
  cycleId?: string;
}

/**
 * Answer a message: one row for the reply, one stamp on the message it answers.
 *
 * Written as a transaction because the two halves are one fact. A reply row with no
 * stamp on its parent would leave the parent reading `seen` forever — the failure this
 * whole phase exists to end — and a stamp with no row would never reach the sender's
 * context, since delivery works on rows addressed to it.
 */
export function replyToHandoff(input: ReplyToHandoffInput): {
  reply: AgentHandoff;
  parent: AgentHandoff;
} {
  const parent = getHandoffById(input.handoffId);
  if (!parent) throw new Error(`No such handoff: ${input.handoffId}`);

  const status = PERFORMATIVE_TO_STATUS[input.performative];
  if (!status)
    throw new Error(`${input.performative} does not answer anything`);

  const now = new Date().toISOString();
  const replyId = randomUUID();

  db.transaction(() => {
    db.prepare(
      // The reply row carries `result`/`result_reason` too, and that is not duplication
      // for its own sake: the reply is the row that says the thing, so a query about what
      // agents have said — `getCannotReasons`, and phase 2's capability index — reads the
      // statement rather than reconstructing it from the message it answered.
      `INSERT INTO agent_handoffs (id, from_agent_id, to_agent_id, type, payload, note, status,
                                   created_at, performative, reply_to, cycle_id, result, result_reason, replied_at, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      replyId,
      input.fromAgentId,
      parent.from_agent_id,
      input.performative,
      JSON.stringify({
        replyTo: parent.id,
        performative: input.performative,
        result: input.result,
        reason: input.reason ?? null,
      }),
      input.result.slice(0, 500),
      now,
      input.performative,
      parent.id,
      input.cycleId ?? null,
      input.result,
      input.reason ?? null,
      now,
      parent.thread_id ?? parent.id,
    );

    // `agree` is not an ending — the recipient has taken the work on and still owes an
    // answer, so the parent keeps no completed_at and stays visible as unanswered.
    if (status === 'completed') {
      db.prepare(
        `UPDATE agent_handoffs SET status = ?, result = ?, result_reason = ?, replied_at = ?, completed_at = ? WHERE id = ?`,
      ).run(status, input.result, input.reason ?? null, now, now, parent.id);
    } else {
      db.prepare(
        `UPDATE agent_handoffs SET status = ?, result = ?, result_reason = ?, replied_at = ? WHERE id = ?`,
      ).run(status, input.result, input.reason ?? null, now, parent.id);
    }
  })();

  return {
    reply: getHandoffById(replyId)!,
    parent: getHandoffById(parent.id)!,
  };
}

/**
 * Lapse every request whose deadline has passed, and TELL the sender.
 *
 * Stage 56 phase 4. A deadline that only changes a status is not much of a deadline: the
 * sender is not watching the table, it is reading its Messages block. So expiry writes a
 * real reply row addressed to the sender, exactly as an agent's answer would — the whole
 * reason a reply is a row is that this delivery path already works.
 *
 * Without this, the first mutual wait deadlocks two agents permanently and both look
 * healthy: the requests sit `agreed` forever and nothing reports it, which is precisely
 * how 347 handoffs came to read as `acknowledged`. An expired request is a visible state,
 * not silence.
 *
 * `expire` is the one performative no agent may write. It is the system's own voice,
 * saying nobody answered — attributing it to the recipient would put a statement in the
 * mouth of an agent that never spoke.
 */
export function expireOverdueHandoffs(
  now = new Date(),
): Array<{ id: string; from: string; to: string }> {
  const nowIso = now.toISOString();
  const due = db
    .prepare(
      `SELECT id, from_agent_id, to_agent_id, type, thread_id, deadline_at
       FROM agent_handoffs
      WHERE COALESCE(performative, 'request') = 'request'
        AND deadline_at IS NOT NULL AND deadline_at <= ?
        AND status IN ('pending', 'seen', 'agreed')`,
    )
    .all(nowIso) as Array<{
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    type: string;
    thread_id: string | null;
    deadline_at: string;
  }>;

  const expired: Array<{ id: string; from: string; to: string }> = [];

  for (const h of due) {
    const reason = `No answer by the deadline (${h.deadline_at}).`;
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE agent_handoffs SET status = 'expired', result_reason = ?, replied_at = ? WHERE id = ?`,
        ).run(reason, nowIso, h.id);

        db.prepare(
          `INSERT INTO agent_handoffs (id, from_agent_id, to_agent_id, type, payload, note, status,
                                       created_at, performative, reply_to, thread_id, result, result_reason, replied_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'expire', ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          // From the agent that did not answer, addressed to the one still waiting. The
          // sender needs to know WHO went quiet, not merely that something did.
          h.to_agent_id,
          h.from_agent_id,
          'expire',
          JSON.stringify({
            replyTo: h.id,
            performative: 'expire',
            result: reason,
            reason,
          }),
          reason,
          nowIso,
          h.id,
          h.thread_id ?? h.id,
          reason,
          reason,
          nowIso,
        );
      })();
      expired.push({ id: h.id, from: h.from_agent_id, to: h.to_agent_id });
    } catch (err) {
      logger.warn(
        { err, handoffId: h.id },
        'Could not expire an overdue handoff',
      );
    }
  }

  return expired;
}

/**
 * Who is currently waiting on whom — the edges of the "blocked" graph.
 *
 * Each row is an unanswered request: `from` is waiting, `to` owes an answer. Feeding a
 * cycle check off this is what `06` asked for, and the reason it asked is specific: a
 * deadlock here is INVISIBLE. Two agents waiting on each other sit in `agreed` forever and
 * both read as healthy — the same way 347 handoffs read as `acknowledged`.
 *
 * Deadlines mean nothing waits forever any more, so a cycle now resolves itself within a
 * day. This exists to make sure a human hears about it before the deadline does, because a
 * cycle that keeps re-forming is a design problem, not a timeout.
 */
export function getWaitingEdges(): Array<{
  from: string;
  fromName: string;
  to: string;
  toName: string;
  since: string;
  handoffId: string;
}> {
  return db
    .prepare(
      `SELECT h.from_agent_id AS "from", COALESCE(fa.name, h.from_agent_id) AS fromName,
            h.to_agent_id   AS "to",   COALESCE(ta.name, h.to_agent_id)   AS toName,
            MIN(h.created_at) AS since, h.id AS handoffId
       FROM agent_handoffs h
       LEFT JOIN agents fa ON fa.id = h.from_agent_id
       LEFT JOIN agents ta ON ta.id = h.to_agent_id
      WHERE COALESCE(h.performative, 'request') = 'request'
        AND h.status IN ('pending', 'seen', 'agreed')
      GROUP BY h.from_agent_id, h.to_agent_id`,
    )
    .all() as Array<{
    from: string;
    fromName: string;
    to: string;
    toName: string;
    since: string;
    handoffId: string;
  }>;
}

export interface ConversationMessage {
  id: string;
  fromId: string;
  from: string;
  toId: string;
  to: string;
  performative: string;
  status: string;
  note: string | null;
  result: string | null;
  reason: string | null;
  payload: string;
  createdAt: string;
  deadlineAt: string | null;
}

export interface Conversation {
  threadId: string;
  participants: string[];
  messages: ConversationMessage[];
  lastAt: string;
  /** The root message's status — what became of the thing that started this. */
  status: string;
  /** True when the opening request has had no answer of any kind. */
  unanswered: boolean;
}

/**
 * Exchanges between agents, grouped, newest activity first.
 *
 * Until stage 56 there were no exchanges to group: a handoff went one way and nothing came
 * back, so a "conversation" was a single row. Now that a reply is a row in the same thread,
 * the data is a transcript and nothing was rendering it as one — you could read a
 * conversation only by joining rows up by eye, or by trusting an agent's own summary of it.
 *
 * Two queries rather than one per thread: pick the most recently active threads for these
 * agents, then fetch every message in them. A thread is two to five rows, so this stays one
 * round trip regardless of how busy the crew is.
 */
export function getConversations(
  agentIds: string[],
  limit = 40,
): Conversation[] {
  if (agentIds.length === 0) return [];
  const marks = agentIds.map(() => '?').join(',');

  const threads = db
    .prepare(
      `SELECT COALESCE(thread_id, id) AS tid, MAX(created_at) AS lastAt
       FROM agent_handoffs
      WHERE from_agent_id IN (${marks}) OR to_agent_id IN (${marks})
      GROUP BY tid
      ORDER BY lastAt DESC
      LIMIT ?`,
    )
    .all(...agentIds, ...agentIds, limit) as Array<{
    tid: string;
    lastAt: string;
  }>;
  if (threads.length === 0) return [];

  const tmarks = threads.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT h.id, h.from_agent_id AS fromId, COALESCE(f.name, h.from_agent_id) AS "from",
            h.to_agent_id AS toId, COALESCE(t.name, h.to_agent_id) AS "to",
            COALESCE(h.performative, 'request') AS performative, h.status,
            h.note,
            -- result/result_reason on a REQUEST row are a denormalised copy of its
            -- reply, put there so 'what happened to this' is one query. In a transcript
            -- the reply has its own row, so exposing it here made every question display
            -- its own answer — caught on live data 2026-09-09, where Finder's request to
            -- Mailer rendered as Mailer's reply to Finder. A question shows the question.
            CASE WHEN COALESCE(h.performative, 'request') IN ('request', 'inform')
                 THEN NULL ELSE h.result END AS result,
            CASE WHEN COALESCE(h.performative, 'request') IN ('request', 'inform')
                 THEN NULL ELSE h.result_reason END AS reason,
            h.payload,
            h.created_at AS createdAt, h.deadline_at AS deadlineAt,
            COALESCE(h.thread_id, h.id) AS tid
       FROM agent_handoffs h
       LEFT JOIN agents f ON f.id = h.from_agent_id
       LEFT JOIN agents t ON t.id = h.to_agent_id
      WHERE COALESCE(h.thread_id, h.id) IN (${tmarks})
      ORDER BY h.created_at ASC`,
    )
    .all(...threads.map((t) => t.tid)) as Array<
    ConversationMessage & { tid: string }
  >;

  const byThread = new Map<string, ConversationMessage[]>();
  for (const r of rows) {
    const { tid, ...msg } = r;
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid)!.push(msg);
  }

  // The retired channel, folded in as history. `agent_messages` was the earlier way agents
  // talked — subject and body, no reply, no deadline, nothing to answer. It lost to
  // handoffs for exactly that reason and the last one was sent 2026-08-31; the `message`
  // tool is unregistered by the adapter and `send_message_to_agent` has never been called.
  //
  // But 23 of them are real crew history, and a second screen showing a dead channel is how
  // someone ends up reading the wrong one. So they appear here as single-turn threads,
  // marked `archived`, and the separate Messages tab goes away.
  let archived: Conversation[] = [];
  try {
    const msgs = db
      .prepare(
        `SELECT m.id, m.from_agent_id AS fromId, COALESCE(f.name, m.from_agent_id) AS "from",
              m.to_agent_id AS toId, COALESCE(t.name, m.to_agent_id) AS "to",
              m.subject, m.body, m.sent_at AS createdAt
         FROM agent_messages m
         LEFT JOIN agents f ON f.id = m.from_agent_id
         LEFT JOIN agents t ON t.id = m.to_agent_id
        WHERE m.from_agent_id IN (${marks}) OR m.to_agent_id IN (${marks})
        ORDER BY m.sent_at DESC
        LIMIT ?`,
      )
      .all(...agentIds, ...agentIds, limit) as Array<{
      id: string;
      fromId: string;
      from: string;
      toId: string;
      to: string;
      subject: string;
      body: string;
      createdAt: string;
    }>;

    archived = msgs.map((m) => ({
      threadId: `msg-${m.id}`,
      participants: [m.from, m.to],
      messages: [
        {
          id: m.id,
          fromId: m.fromId,
          from: m.from,
          toId: m.toId,
          to: m.to,
          performative: 'inform',
          status: 'archived',
          note: m.subject
            ? `${m.subject}

${m.body}`
            : m.body,
          result: null,
          reason: null,
          payload: '',
          createdAt: m.createdAt,
          deadlineAt: null,
        },
      ],
      lastAt: m.createdAt,
      status: 'archived',
      unanswered: false,
    }));
  } catch {
    /* table absent — nothing to fold in */
  }

  const ANSWERED = new Set([
    'completed',
    'refused',
    'cannot',
    'failed',
    'expired',
  ]);
  const built = threads.map((t) => {
    const messages = byThread.get(t.tid) ?? [];
    const root = messages.find((m) => m.id === t.tid) ?? messages[0];
    return {
      threadId: t.tid,
      // Ordered by first appearance, so the opener reads first — the transcript and the
      // header then agree about who started it.
      participants: [...new Set(messages.flatMap((m) => [m.from, m.to]))],
      messages,
      lastAt: t.lastAt,
      status: root?.status ?? 'pending',
      unanswered:
        !!root && root.performative === 'request' && !ANSWERED.has(root.status),
    };
  });

  return [...built, ...archived]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

/**
 * The whole exchange, oldest first — request, answers, follow-ups.
 *
 * Phase 4. Without this a follow-up question arrives with no history attached, and the
 * recipient answers it out of context or asks what it is about.
 */
export function getThread(threadId: string): AgentHandoff[] {
  return db
    .prepare(
      'SELECT * FROM agent_handoffs WHERE thread_id = ? OR id = ? ORDER BY created_at ASC',
    )
    .all(threadId, threadId) as AgentHandoff[];
}

/**
 * What the crew has said it cannot do, and how often — the backlog the agents write
 * themselves.
 *
 * This is the reason `cannot` is worth more than a successful handoff. Every row here is
 * an agent naming, unprompted and in its own words, a capability it needed and did not
 * have. Phase 2's capability index reads the same data to decide where to route; the
 * owner reads it to decide what to build.
 */
export function getCannotReasons(
  sinceDays = 30,
): Array<{ agent: string; reason: string; count: number; last: string }> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  return db
    .prepare(
      `SELECT COALESCE(a.name, h.from_agent_id) AS agent,
            h.result_reason AS reason,
            COUNT(*) AS count, MAX(h.created_at) AS last
       FROM agent_handoffs h
       LEFT JOIN agents a ON a.id = h.from_agent_id
      WHERE h.performative = 'cannot' AND h.result_reason IS NOT NULL AND h.created_at >= ?
      GROUP BY agent, reason
      ORDER BY count DESC, last DESC`,
    )
    .all(since) as Array<{
    agent: string;
    reason: string;
    count: number;
    last: string;
  }>;
}

export function updateHandoffNote(id: string, note: string): void {
  db.prepare('UPDATE agent_handoffs SET note = ? WHERE id = ?').run(note, id);
}

export function getRecentHandoffs(limit = 20): AgentHandoff[] {
  return db
    .prepare('SELECT * FROM agent_handoffs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AgentHandoff[];
}

// ─── Agent Chat Messages ──────────────────────────────────────────────────────

export interface AgentChatMessage {
  id: string;
  agent_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_traces?: string;
  created_at: string;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function createProject(project: Project): void {
  db.prepare(
    `INSERT INTO projects (id, name, chat_jid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.name,
    project.chat_jid,
    project.status,
    project.created_at,
    project.updated_at,
  );
  // Also link the originating chat so lookups work immediately
  db.prepare(
    `INSERT OR IGNORE INTO project_chats (project_id, chat_jid, joined_at) VALUES (?, ?, ?)`,
  ).run(project.id, project.chat_jid, project.created_at);
}

export function getProject(id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | Project
    | undefined;
}

export function getProjectByName(name: string): Project | undefined {
  return db
    .prepare(
      "SELECT * FROM projects WHERE LOWER(name) = LOWER(?) AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(name) as Project | undefined;
}

/** Returns the most recent active project linked to this chat JID. */
export function getActiveProjectForChat(chatJid: string): Project | undefined {
  return db
    .prepare(
      `
    SELECT p.* FROM projects p
    INNER JOIN project_chats pc ON pc.project_id = p.id
    WHERE pc.chat_jid = ? AND p.status = 'active'
    ORDER BY p.created_at DESC
    LIMIT 1
  `,
    )
    .get(chatJid) as Project | undefined;
}

export function linkChatToProject(projectId: string, chatJid: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO project_chats (project_id, chat_jid, joined_at) VALUES (?, ?, ?)`,
  ).run(projectId, chatJid, new Date().toISOString());
}

export function listProjects(status?: 'active' | 'archived'): Project[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC',
      )
      .all(status) as Project[];
  }
  return db
    .prepare('SELECT * FROM projects ORDER BY created_at DESC')
    .all() as Project[];
}

export function updateProject(
  id: string,
  updates: Partial<Pick<Project, 'name' | 'status'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function setProjectLeadAgent(
  projectId: string,
  agentId: string | null,
): void {
  db.prepare(
    `UPDATE projects SET lead_agent_id = ?, updated_at = ? WHERE id = ?`,
  ).run(agentId, new Date().toISOString(), projectId);
}

// ─── Agent ↔ Project links ────────────────────────────────────────────────────

export function linkAgentToProject(
  agentId: string,
  projectId: string,
  role?: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_projects (agent_id, project_id, role, joined_at) VALUES (?, ?, ?, ?)`,
  ).run(agentId, projectId, role ?? null, new Date().toISOString());

  // Auto-bind the new agent to any WhatsApp groups already linked to this project!
  const projectGroups = db
    .prepare(
      `SELECT DISTINCT target_jid, owner_id FROM agent_channel_bindings WHERE project_id = ? AND channel = 'whatsapp' AND target_type = 'group'`,
    )
    .all(projectId) as Array<{ target_jid: string; owner_id: string | null }>;

  for (const pg of projectGroups) {
    const existing = db
      .prepare(
        `SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND channel = 'whatsapp' AND target_type = 'group' AND target_jid = ? LIMIT 1`,
      )
      .get(agentId, pg.target_jid) as any;

    if (existing) {
      db.prepare(
        'UPDATE agent_channel_bindings SET project_id = ?, enabled = 1 WHERE id = ?',
      ).run(projectId, existing.id);
    } else {
      db.prepare(
        `INSERT INTO agent_channel_bindings (id, owner_id, agent_id, channel, target_type, target_jid, project_id, trigger_mode, enabled, created_at)
         VALUES (?, ?, ?, 'whatsapp', 'group', ?, ?, 'mention', 1, ?)`,
      ).run(
        randomUUID(),
        pg.owner_id,
        agentId,
        pg.target_jid,
        projectId,
        new Date().toISOString(),
      );
    }
  }
}

export function unlinkAgentFromProject(
  agentId: string,
  projectId: string,
): void {
  db.prepare(
    `DELETE FROM agent_projects WHERE agent_id = ? AND project_id = ?`,
  ).run(agentId, projectId);

  // Clean up group bindings that were linked to this project for this agent
  db.prepare(
    `DELETE FROM agent_channel_bindings WHERE agent_id = ? AND project_id = ? AND channel = 'whatsapp' AND target_type = 'group'`,
  ).run(agentId, projectId);
}

export function getAgentProjects(
  agentId: string,
): Array<Project & { role?: string }> {
  return db
    .prepare(
      `
    SELECT p.*, ap.role FROM projects p
    INNER JOIN agent_projects ap ON ap.project_id = p.id
    WHERE ap.agent_id = ? AND p.status = 'active'
    ORDER BY ap.joined_at ASC
  `,
    )
    .all(agentId) as Array<Project & { role?: string }>;
}

export function getProjectAgents(
  projectId: string,
): Array<Agent & { role?: string }> {
  return db
    .prepare(
      `
    SELECT a.*, ap.role FROM agents a
    INNER JOIN agent_projects ap ON ap.agent_id = a.id
    WHERE ap.project_id = ?
    ORDER BY ap.joined_at ASC
  `,
    )
    .all(projectId)
    .map((row: any) => ({
      ...row,
      config: JSON.parse(row.config),
    })) as Array<Agent & { role?: string }>;
}

// ─── Crew graph data ─────────────────────────────────────────────────────────

export interface CrewEdge {
  type: 'message' | 'spawn' | 'handoff' | 'pipeline';
  from: string;
  to: string;
  count: number;
  last?: string;
}

export function getCrewGraphEdges(): CrewEdge[] {
  const edges: CrewEdge[] = [];

  // Inter-agent messages
  const msgs = db
    .prepare(
      `
    SELECT from_agent_id as "from", to_agent_id as "to", COUNT(*) as count, MAX(sent_at) as last
    FROM agent_messages GROUP BY from_agent_id, to_agent_id
  `,
    )
    .all() as any[];
  for (const r of msgs)
    edges.push({
      type: 'message',
      from: r.from,
      to: r.to,
      count: r.count,
      last: r.last,
    });

  // Sub-agent spawn relationships (parent_agent_id)
  const spawns = db
    .prepare(
      `
    SELECT parent_agent_id as "from", id as "to" FROM agents WHERE parent_agent_id IS NOT NULL
  `,
    )
    .all() as any[];
  for (const r of spawns)
    edges.push({ type: 'spawn', from: r.from, to: r.to, count: 1 });

  // Handoffs
  const handoffs = db
    .prepare(
      `
    SELECT from_agent_id as "from", to_agent_id as "to", COUNT(*) as count, MAX(created_at) as last
    FROM agent_handoffs WHERE from_agent_id IS NOT NULL AND to_agent_id IS NOT NULL
    GROUP BY from_agent_id, to_agent_id
  `,
    )
    .all() as any[];
  for (const r of handoffs)
    edges.push({
      type: 'handoff',
      from: r.from,
      to: r.to,
      count: r.count,
      last: r.last,
    });

  // Pipelines — derive edge count from target agent's completed cycles
  const pipes = db
    .prepare(
      `
    SELECT p.source_agent_id as "from", p.target_agent_id as "to",
           COUNT(c.id) as count, MAX(c.ended_at) as last
    FROM pipelines p
    LEFT JOIN agent_cycles c ON c.agent_id = p.target_agent_id
      AND c.cycle_type = p.target_cycle_type
      AND c.status = 'completed'
    WHERE p.enabled = 1 AND p.source_agent_id IS NOT NULL
    GROUP BY p.source_agent_id, p.target_agent_id
  `,
    )
    .all() as any[];
  for (const r of pipes)
    edges.push({
      type: 'pipeline',
      from: r.from,
      to: r.to,
      count: r.count ?? 0,
      last: r.last,
    });

  return edges;
}

export function getProjectMemberships(): Array<{
  project_id: string;
  project_name: string;
  agent_id: string;
}> {
  return db
    .prepare(
      `
    SELECT ap.project_id, p.name as project_name, ap.agent_id
    FROM agent_projects ap
    INNER JOIN projects p ON p.id = ap.project_id
    WHERE p.status = 'active'
  `,
    )
    .all() as any[];
}

// ─── Webhook deliveries ───────────────────────────────────────────────────────

export interface WebhookDelivery {
  id: string;
  agent_id: string;
  event: string;
  received_at: string;
  payload_preview: string | null;
  /** 'skipped' — stage 59: wake policy or `stopped` blocked the cycle; the payload was still captured. */
  cycle_status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}

export function logWebhookDelivery(
  d: Omit<WebhookDelivery, 'id'>,
): WebhookDelivery {
  const id = `wh_${Date.now()}_${randomUUID().split('-')[0]}`;
  db.prepare(
    `INSERT INTO webhook_deliveries (id, agent_id, event, received_at, payload_preview, cycle_status) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    d.agent_id,
    d.event,
    d.received_at,
    d.payload_preview ?? null,
    d.cycle_status,
  );
  return { id, ...d };
}

export function updateWebhookDeliveryStatus(
  id: string,
  status: WebhookDelivery['cycle_status'],
): void {
  db.prepare(`UPDATE webhook_deliveries SET cycle_status = ? WHERE id = ?`).run(
    status,
    id,
  );
}

export function getWebhookDeliveries(
  agentId: string,
  limit = 50,
): WebhookDelivery[] {
  return db
    .prepare(
      `SELECT * FROM webhook_deliveries WHERE agent_id = ? ORDER BY received_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as WebhookDelivery[];
}

// ─── Outbound webhooks ──────────────────────────────────────────────────────

export interface OutboundWebhook {
  id: string;
  agent_id: string;
  owner_id: string | null;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}

function rowToOutboundWebhook(r: any): OutboundWebhook {
  return {
    ...r,
    events: JSON.parse(r.events || '[]'),
    enabled: r.enabled === 1,
  };
}

export function createOutboundWebhook(d: {
  agent_id: string;
  url: string;
  secret: string;
  events: string[];
}): OutboundWebhook {
  const id = `owh_${Date.now()}_${randomUUID().split('-')[0]}`;
  const created_at = new Date().toISOString();
  const owner_id = getAgentOwner(d.agent_id);
  db.prepare(
    `INSERT INTO outbound_webhooks (id, agent_id, owner_id, url, secret, events, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    d.agent_id,
    owner_id,
    d.url,
    d.secret,
    JSON.stringify(d.events),
    created_at,
  );
  return {
    id,
    agent_id: d.agent_id,
    owner_id,
    url: d.url,
    secret: d.secret,
    events: d.events,
    enabled: true,
    created_at,
  };
}

export function listOutboundWebhooks(agentId: string): OutboundWebhook[] {
  const rows = db
    .prepare(
      `SELECT * FROM outbound_webhooks WHERE agent_id = ? ORDER BY created_at DESC`,
    )
    .all(agentId) as any[];
  return rows.map(rowToOutboundWebhook);
}

export function getOutboundWebhook(id: string): OutboundWebhook | null {
  const r = db
    .prepare(`SELECT * FROM outbound_webhooks WHERE id = ?`)
    .get(id) as any;
  return r ? rowToOutboundWebhook(r) : null;
}

/** Every enabled subscriber across all agents interested in this (agentId, eventType) pair. */
export function getOutboundWebhooksFor(
  agentId: string,
  eventType: string,
): OutboundWebhook[] {
  const rows = db
    .prepare(
      `SELECT * FROM outbound_webhooks WHERE agent_id = ? AND enabled = 1`,
    )
    .all(agentId) as any[];
  return rows
    .map(rowToOutboundWebhook)
    .filter((w) => w.events.includes('*') || w.events.includes(eventType));
}

export function updateOutboundWebhook(
  id: string,
  patch: Partial<Pick<OutboundWebhook, 'url' | 'events' | 'enabled'>>,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.url !== undefined) {
    sets.push('url = ?');
    vals.push(patch.url);
  }
  if (patch.events !== undefined) {
    sets.push('events = ?');
    vals.push(JSON.stringify(patch.events));
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    vals.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(
    `UPDATE outbound_webhooks SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...vals);
}

export function deleteOutboundWebhook(id: string): void {
  db.prepare(`DELETE FROM outbound_webhooks WHERE id = ?`).run(id);
  db.prepare(
    `DELETE FROM outbound_webhook_deliveries WHERE webhook_id = ?`,
  ).run(id);
}

export interface OutboundWebhookDelivery {
  id: string;
  webhook_id: string;
  agent_id: string;
  event: string;
  sent_at: string;
  status: 'success' | 'failed';
  status_code: number | null;
  error: string | null;
  payload_preview: string | null;
}

export function logOutboundDelivery(
  d: Omit<OutboundWebhookDelivery, 'id'>,
): OutboundWebhookDelivery {
  const id = `owhd_${Date.now()}_${randomUUID().split('-')[0]}`;
  db.prepare(
    `INSERT INTO outbound_webhook_deliveries (id, webhook_id, agent_id, event, sent_at, status, status_code, error, payload_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    d.webhook_id,
    d.agent_id,
    d.event,
    d.sent_at,
    d.status,
    d.status_code ?? null,
    d.error ?? null,
    d.payload_preview ?? null,
  );
  return { id, ...d };
}

export function getOutboundDeliveries(
  webhookId: string,
  limit = 50,
): OutboundWebhookDelivery[] {
  return db
    .prepare(
      `SELECT * FROM outbound_webhook_deliveries WHERE webhook_id = ? ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(webhookId, limit) as OutboundWebhookDelivery[];
}

// ─── Inter-agent messages ─────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
  sent_at: string;
  read_at?: string | null;
}

export function createAgentMessage(
  msg: Omit<AgentMessage, 'id' | 'sent_at' | 'read_at'>,
): AgentMessage {
  const id = `amsg_${Date.now()}_${randomUUID().split('-')[0]}`;
  const sent_at = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_messages (id, from_agent_id, to_agent_id, subject, body, sent_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, msg.from_agent_id, msg.to_agent_id, msg.subject, msg.body, sent_at);
  return { id, sent_at, read_at: null, ...msg };
}

export function getAgentInbox(agentId: string, limit = 50): AgentMessage[] {
  return db
    .prepare(
      `SELECT * FROM agent_messages WHERE to_agent_id = ? ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as AgentMessage[];
}

/**
 * Unread inter-agent messages, oldest first — the set a cycle should surface into its
 * context, mirroring getPendingHandoffsByAgent. Before this, agent_messages had a
 * read_at column and a markAgentMessageRead function but nothing ever called either
 * from a cycle: the only readers were the dashboard's inbox view. A message written to
 * workspace/inbox/msg-*.json sat there until the recipient happened to browse its own
 * inbox directory — which cycle context-building explicitly skips listing (SKIP_TOP in
 * _syncTrackedItems's caller). Found 2026-08-15: Mailer flagged a duplicate-lead bug to
 * Finder this way and it went unread for the rest of the day.
 */
export function getUnreadAgentMessages(agentId: string): AgentMessage[] {
  return db
    .prepare(
      `SELECT * FROM agent_messages WHERE to_agent_id = ? AND read_at IS NULL ORDER BY sent_at ASC`,
    )
    .all(agentId) as AgentMessage[];
}

export function getAgentOutbox(agentId: string, limit = 50): AgentMessage[] {
  return db
    .prepare(
      `SELECT * FROM agent_messages WHERE from_agent_id = ? ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as AgentMessage[];
}

export function markAgentMessageRead(messageId: string): void {
  db.prepare(
    `UPDATE agent_messages SET read_at = ? WHERE id = ? AND read_at IS NULL`,
  ).run(new Date().toISOString(), messageId);
}

// ─── Workspace file registry (Step 3) ────────────────────────────────────────

export interface WorkspaceFileRecord {
  id: string;
  context: string;
  context_id: string;
  chat_jid?: string | null;
  path: string;
  filename: string;
  extension?: string | null;
  size_bytes?: number | null;
  checksum?: string | null;
  created_at: string;
  modified_at: string;
}

export function upsertWorkspaceFile(file: WorkspaceFileRecord): void {
  db.prepare(
    `
    INSERT INTO workspace_files
      (id, context, context_id, chat_jid, path, filename, extension, size_bytes, checksum, created_at, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      size_bytes  = excluded.size_bytes,
      checksum    = excluded.checksum,
      modified_at = excluded.modified_at
  `,
  ).run(
    file.id,
    file.context,
    file.context_id,
    file.chat_jid ?? null,
    file.path,
    file.filename,
    file.extension ?? null,
    file.size_bytes ?? null,
    file.checksum ?? null,
    file.created_at,
    file.modified_at,
  );
}

export function listWorkspaceFiles(filter: {
  context?: string;
  contextId?: string;
  chatJid?: string;
}): WorkspaceFileRecord[] {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.context) {
    conditions.push('context = ?');
    values.push(filter.context);
  }
  if (filter.contextId) {
    conditions.push('context_id = ?');
    values.push(filter.contextId);
  }
  if (filter.chatJid) {
    conditions.push('chat_jid = ?');
    values.push(filter.chatJid);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM workspace_files ${where} ORDER BY modified_at DESC`)
    .all(...values) as WorkspaceFileRecord[];
}

/** Placeholder used by files.ts — not needed for disk-scan path but keeps the import valid. */
export function getWorkspaceFileContent(
  _id: string,
): WorkspaceFileRecord | undefined {
  return db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(_id) as
    | WorkspaceFileRecord
    | undefined;
}

// ─── Agent Pipelines ──────────────────────────────────────────────────────────

export interface Pipeline {
  id: string;
  name: string;
  enabled: boolean;
  source_agent_id: string | null;
  trigger_cycle_type: string | null;
  trigger_status: 'completed' | 'failed';
  target_agent_id: string;
  target_cycle_type: string;
  inject_output: boolean;
  project_id: string | null;
  created_at: string;
  owner_id?: string | null; // Stage 28 — owning user
}

function pipelineRow(r: any): Pipeline {
  return {
    ...r,
    enabled: r.enabled === 1,
    inject_output: r.inject_output === 1,
    source_agent_id: r.source_agent_id ?? null,
    trigger_cycle_type: r.trigger_cycle_type ?? null,
    project_id: r.project_id ?? null,
  };
}

export function getPipelines(): Pipeline[] {
  return (
    db
      .prepare('SELECT * FROM pipelines ORDER BY created_at DESC')
      .all() as any[]
  ).map(pipelineRow);
}

export function getPipeline(id: string): Pipeline | null {
  const r = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as any;
  return r ? pipelineRow(r) : null;
}

/**
 * Returns enabled pipelines that match the source cycle. If a pipeline has a
 * project_id set, the cycle's projectId must match (a pipeline scoped to one
 * project never fires for cycles in a different project — or for project-less
 * cycles). Pipelines with null project_id fire regardless of project context.
 */
export function getMatchingPipelines(
  agentId: string,
  cycleType: string,
  status: 'completed' | 'failed',
  projectId?: string | null,
): Pipeline[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM pipelines
    WHERE enabled = 1
      AND trigger_status = ?
      AND (source_agent_id IS NULL OR source_agent_id = ?)
      AND (trigger_cycle_type IS NULL OR trigger_cycle_type = ?)
      AND (project_id IS NULL OR project_id = ?)
  `,
    )
    .all(status, agentId, cycleType, projectId ?? null) as any[];
  return rows.map(pipelineRow);
}

export function createPipeline(
  p: Omit<Pipeline, 'id' | 'created_at'>,
): Pipeline {
  const id = `pipe_${Date.now()}_${randomUUID().split('-')[0]}`;
  const created_at = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO pipelines (id, name, enabled, source_agent_id, trigger_cycle_type, trigger_status, target_agent_id, target_cycle_type, inject_output, project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    p.name,
    p.enabled ? 1 : 0,
    p.source_agent_id ?? null,
    p.trigger_cycle_type ?? null,
    p.trigger_status,
    p.target_agent_id,
    p.target_cycle_type,
    p.inject_output ? 1 : 0,
    p.project_id ?? null,
    created_at,
  );
  return { id, created_at, ...p };
}

export function updatePipeline(
  id: string,
  patch: Partial<Omit<Pipeline, 'id' | 'created_at'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.source_agent_id !== undefined) {
    fields.push('source_agent_id = ?');
    values.push(patch.source_agent_id ?? null);
  }
  if (patch.trigger_cycle_type !== undefined) {
    fields.push('trigger_cycle_type = ?');
    values.push(patch.trigger_cycle_type ?? null);
  }
  if (patch.trigger_status !== undefined) {
    fields.push('trigger_status = ?');
    values.push(patch.trigger_status);
  }
  if (patch.target_agent_id !== undefined) {
    fields.push('target_agent_id = ?');
    values.push(patch.target_agent_id);
  }
  if (patch.target_cycle_type !== undefined) {
    fields.push('target_cycle_type = ?');
    values.push(patch.target_cycle_type);
  }
  if (patch.inject_output !== undefined) {
    fields.push('inject_output = ?');
    values.push(patch.inject_output ? 1 : 0);
  }
  if (patch.project_id !== undefined) {
    fields.push('project_id = ?');
    values.push(patch.project_id ?? null);
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE pipelines SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deletePipeline(id: string): void {
  db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
}

// ─── Pipeline runs (audit log) ────────────────────────────────────────────────

export interface PipelineRun {
  id: string;
  pipeline_id: string;
  source_cycle_id: string | null;
  target_cycle_id: string | null;
  source_agent_id: string | null;
  source_cycle_type: string | null;
  source_status: 'completed' | 'failed' | null;
  target_agent_id: string;
  target_cycle_type: string;
  project_id: string | null;
  trigger_kind: 'auto' | 'manual';
  status: 'fired' | 'failed' | 'skipped';
  reason: string | null;
  fired_at: string;
}

export function logPipelineRun(
  r: Omit<PipelineRun, 'id' | 'fired_at'>,
): PipelineRun {
  const id = `prun_${Date.now()}_${randomUUID().split('-')[0]}`;
  const fired_at = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO pipeline_runs (id, pipeline_id, source_cycle_id, target_cycle_id, source_agent_id, source_cycle_type, source_status, target_agent_id, target_cycle_type, project_id, trigger_kind, status, reason, fired_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    r.pipeline_id,
    r.source_cycle_id ?? null,
    r.target_cycle_id ?? null,
    r.source_agent_id ?? null,
    r.source_cycle_type ?? null,
    r.source_status ?? null,
    r.target_agent_id,
    r.target_cycle_type,
    r.project_id ?? null,
    r.trigger_kind,
    r.status,
    r.reason ?? null,
    fired_at,
  );
  return { id, fired_at, ...r };
}

export function updatePipelineRunTarget(
  runId: string,
  target_cycle_id: string,
): void {
  db.prepare('UPDATE pipeline_runs SET target_cycle_id = ? WHERE id = ?').run(
    target_cycle_id,
    runId,
  );
}

export function getPipelineRuns(pipelineId: string, limit = 50): PipelineRun[] {
  return db
    .prepare(
      'SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY fired_at DESC LIMIT ?',
    )
    .all(pipelineId, limit) as PipelineRun[];
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type NotificationType =
  | 'cycle_completed'
  | 'cycle_failed'
  | 'pipeline_fired'
  | 'agent_error'
  | 'budget_warning'
  | 'webhook_received'
  | 'subagent_done'
  | 'message_received'
  | 'agent_alert'
  | 'handoff_completed'
  | 'handoff_rejected'
  | 'handoff_updated'
  | 'usage_alert'
  // An agent is BLOCKED mid-cycle waiting on a human decision. Distinct from
  // 'agent_alert': the agent is not merely reporting, it has stopped and will
  // give up when the gate times out — so this one is actionable and time-bound.
  | 'approval_required'
  // Stage 54 phase 1 — the daily roll-up of what agents changed about themselves.
  // Deliberately a digest rather than one notification per change: six agents editing
  // their own settings produce enough volume that a per-change stream gets muted, and a
  // muted alert is worse than none because it still feels like coverage.
  | 'config_audit_digest';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  agent_id: string | null;
  meta: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
  owner_id?: string | null; // Stage 28 — owning user (derived from agent)
}

export function createNotification(
  n: Omit<Notification, 'id' | 'created_at' | 'read'>,
): Notification {
  const id = `notif_${Date.now()}_${randomUUID().split('-')[0]}`;
  const created_at = new Date().toISOString();
  // Stage 28 — a notification belongs to the owner of the agent it's about.
  const owner_id = n.owner_id ?? getAgentOwner(n.agent_id);
  db.prepare(
    `INSERT INTO notifications (id, type, title, body, agent_id, meta, read, created_at, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    n.type,
    n.title,
    n.body,
    n.agent_id ?? null,
    n.meta ? JSON.stringify(n.meta) : null,
    created_at,
    owner_id,
  );
  return { id, created_at, read: false, ...n };
}

// Stage 28: all accessors take an optional ownerId. When provided, the query is
// scoped to that user's notifications; omitted = system-wide (internal callers).
export function getNotifications(
  limit = 50,
  unreadOnly = false,
  ownerId?: string,
): Notification[] {
  const clauses = [];
  if (unreadOnly) clauses.push('read = 0');
  if (ownerId) clauses.push('owner_id = ?');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const params = ownerId ? [ownerId, limit] : [limit];
  const rows = db
    .prepare(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as any[];
  return rows.map((r) => ({
    ...r,
    read: r.read === 1,
    meta: r.meta ? JSON.parse(r.meta) : null,
  }));
}

export function getUnreadNotificationCount(ownerId?: string): number {
  const r = ownerId
    ? (db
        .prepare(
          'SELECT COUNT(*) as c FROM notifications WHERE read = 0 AND owner_id = ?',
        )
        .get(ownerId) as { c: number })
    : (db
        .prepare('SELECT COUNT(*) as c FROM notifications WHERE read = 0')
        .get() as { c: number });
  return r.c;
}

/** Returns true if a row was actually affected (i.e. the caller owned it). */
export function markNotificationRead(id: string, ownerId?: string): boolean {
  const res = ownerId
    ? db
        .prepare(
          'UPDATE notifications SET read = 1 WHERE id = ? AND owner_id = ?',
        )
        .run(id, ownerId)
    : db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  return res.changes > 0;
}

export function markAllNotificationsRead(ownerId?: string): void {
  if (ownerId)
    db.prepare(
      'UPDATE notifications SET read = 1 WHERE read = 0 AND owner_id = ?',
    ).run(ownerId);
  else db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
}

export function deleteNotification(id: string, ownerId?: string): boolean {
  const res = ownerId
    ? db
        .prepare('DELETE FROM notifications WHERE id = ? AND owner_id = ?')
        .run(id, ownerId)
    : db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
  return res.changes > 0;
}

export function clearAllNotifications(ownerId?: string): void {
  if (ownerId)
    db.prepare('DELETE FROM notifications WHERE owner_id = ?').run(ownerId);
  else db.prepare('DELETE FROM notifications').run();
}

// ─── Pipeline / Leads ─────────────────────────────────────────────────────────

// ─── Generic Entity Tracker ────────────────────────────────────────────────────

export interface TrackerStageRow {
  key: string;
  label: string;
  color: string;
}

export interface TrackerFieldRow {
  key: string;
  label: string;
  type: 'text' | 'url' | 'number' | 'date';
}

export interface EntitySchemaParsed {
  id: string;
  agent_id: string;
  name: string;
  namePlural: string;
  stages: TrackerStageRow[];
  fields: TrackerFieldRow[];
  created_at: string;
}

export function upsertEntitySchema(
  agentId: string,
  schema: {
    name: string;
    namePlural: string;
    stages: TrackerStageRow[];
    fields: TrackerFieldRow[];
  },
): void {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO entity_schemas (id, agent_id, name, name_plural, stages, fields, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name        = excluded.name,
      name_plural = excluded.name_plural,
      stages      = excluded.stages,
      fields      = excluded.fields
  `,
  ).run(
    id,
    agentId,
    schema.name,
    schema.namePlural,
    JSON.stringify(schema.stages),
    JSON.stringify(schema.fields),
    created_at,
  );
}

/**
 * How many tracked rows sit in one stage.
 *
 * Used before a tracker schema edit removes a stage. A row whose stage no longer exists
 * in the schema is not deleted — it becomes invisible to the funnel and to the agent's
 * own counts, which is worse, because nothing reports it missing.
 */
/**
 * Every tool this agent has ever actually called.
 *
 * cycle_steps is the complete record of what ran, which makes it the only safe basis for
 * widening a declared tool list before enforcement: a tool an agent depends on cannot be
 * missing from here, however wrong the declared list is.
 */
export function getToolsUsedByAgent(agentId: string): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT tool FROM cycle_steps WHERE agent_id = ? AND tool IS NOT NULL AND tool <> ''",
    )
    .all(agentId) as Array<{ tool: string }>;
  return rows.map((r) => r.tool).sort();
}

/**
 * How often an agent has actually called each of these tools, and when it last did.
 *
 * Stage 56 phase 2. `config.tools` says what an agent is permitted; this says what it has
 * done. A granted tool nobody has ever called is not evidence of capability, and routing
 * work on the strength of a grant is how you hand a job to an agent that has never done it.
 */
export function getToolUsageCounts(
  agentId: string,
  tools: string[],
): Record<string, { calls: number; lastAt: string | null }> {
  if (tools.length === 0) return {};
  const rows = db
    .prepare(
      `SELECT tool, COUNT(*) AS calls, MAX(created_at) AS lastAt
       FROM cycle_steps
      WHERE agent_id = ? AND tool IN (${tools.map(() => '?').join(',')})
      GROUP BY tool`,
    )
    .all(agentId, ...tools) as Array<{
    tool: string;
    calls: number;
    lastAt: string | null;
  }>;

  const out: Record<string, { calls: number; lastAt: string | null }> = {};
  for (const r of rows) out[r.tool] = { calls: r.calls, lastAt: r.lastAt };
  return out;
}

/**
 * Whether an agent answers when asked, and how fast.
 *
 * The single most useful fact about a potential collaborator and the one nothing could
 * compute before phase 1: an agent that has never answered a request is a worse choice
 * than one that answers in four hours, whatever tools it holds.
 */
export function getHandoffReplyStats(
  agentId: string,
): { answered: number; asked: number; medianHours: number | null } | null {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS asked,
            COALESCE(SUM(replied_at IS NOT NULL), 0) AS answered
       FROM agent_handoffs
      WHERE to_agent_id = ? AND COALESCE(performative, 'request') = 'request'`,
    )
    .get(agentId) as { asked: number; answered: number } | undefined;
  if (!row) return null;

  const times = db
    .prepare(
      `SELECT created_at, replied_at FROM agent_handoffs
      WHERE to_agent_id = ? AND ${IS_REQUEST} AND replied_at IS NOT NULL
      ORDER BY replied_at DESC LIMIT 50`,
    )
    .all(agentId) as Array<{ created_at: string; replied_at: string }>;

  let medianHours: number | null = null;
  if (times.length > 0) {
    const hrs = times
      .map(
        (t) =>
          (Date.parse(t.replied_at) - Date.parse(t.created_at)) / 3_600_000,
      )
      .filter((h) => Number.isFinite(h) && h >= 0)
      .sort((a, b) => a - b);
    if (hrs.length) medianHours = Math.round(hrs[Math.floor(hrs.length / 2)]);
  }

  return { asked: row.asked, answered: row.answered, medianHours };
}

/**
 * A capability the crew looked for and did not find.
 *
 * Deliberately not deduplicated at write time: the same query asked six times by three
 * agents is a stronger signal than the same query asked once, and collapsing it here
 * would throw that away. `getCapabilityGaps` groups on read.
 */
export function recordCapabilityGap(gap: {
  agentId: string;
  query: string;
  context?: string | null;
}): void {
  try {
    db.prepare(
      'INSERT INTO capability_gaps (id, agent_id, query, context, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      gap.agentId,
      gap.query.slice(0, 300),
      gap.context?.slice(0, 1000) ?? null,
      new Date().toISOString(),
    );
  } catch {
    /* bookkeeping must never break the caller — same rule as recordConfigAudit */
  }
}

export function getCapabilityGaps(
  sinceDays = 30,
): Array<{ query: string; asks: number; agents: number; last: string }> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  return db
    .prepare(
      `SELECT query, COUNT(*) AS asks, COUNT(DISTINCT agent_id) AS agents, MAX(created_at) AS last
       FROM capability_gaps WHERE created_at >= ?
      GROUP BY query ORDER BY asks DESC, last DESC`,
    )
    .all(since) as Array<{
    query: string;
    asks: number;
    agents: number;
    last: string;
  }>;
}

export function countTrackedItemsInStage(
  agentId: string,
  stage: string,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM tracked_items WHERE agent_id = ? AND stage = ?',
    )
    .get(agentId, stage) as { n: number };
  return row?.n ?? 0;
}

export function getEntitySchema(agentId: string): EntitySchemaParsed | null {
  const row = db
    .prepare('SELECT * FROM entity_schemas WHERE agent_id = ?')
    .get(agentId) as any;
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    namePlural: row.name_plural,
    stages: JSON.parse(row.stages),
    fields: JSON.parse(row.fields),
    created_at: row.created_at,
  };
}

// ─── C2: tracked items (ground-truth records) ────────────────────────────────

export interface TrackedItem {
  entity: string;
  item_key: string;
  stage: string | null;
  data: Record<string, any>;
  updated_at: string;
  stage_since: string;
}

/** Upsert one tracked item (deduped by agent+entity+item_key). */
export function upsertTrackedItem(
  agentId: string,
  entity: string,
  itemKey: string,
  stage: string | null,
  data: Record<string, any>,
  source = 'cycle',
  updatedAt?: string,
): void {
  // `updatedAt` exists so a caller with a real timestamp can supply it — backfilling
  // history, or a test that needs rows dated either side of an event. Omitted, it is now,
  // which is what every production caller wants.
  const now = updatedAt ?? new Date().toISOString();
  // C3: stage_since only advances when the STAGE actually changes — so "stuck for N days"
  // is real and a re-sync of the same item doesn't reset the clock.
  db.prepare(
    `
    INSERT INTO tracked_items (id, agent_id, entity, item_key, stage, data, source, updated_at, stage_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, entity, item_key) DO UPDATE SET
      data = excluded.data, source = excluded.source, updated_at = excluded.updated_at,
      stage_since = CASE WHEN tracked_items.stage IS excluded.stage THEN tracked_items.stage_since ELSE excluded.updated_at END,
      stage = excluded.stage
  `,
  ).run(
    randomUUID(),
    agentId,
    entity,
    itemKey,
    stage ?? null,
    JSON.stringify(data),
    source,
    now,
    now,
  );
}

/**
 * Build a `matched_post_url` -> canonical `item_key` index from existing tracked_items
 * rows, so a posting re-discovered under a different item_key can be folded back into its
 * original row instead of duplicating it.
 *
 * `item_key` is a human-readable slug the agent generates itself (e.g. from the role
 * title), not a stable id, so re-wording it on a later sweep produces a "new" row for a
 * posting that's already tracked — the DB's uniqueness is on (agent_id, entity, item_key),
 * so it can't catch this. `matched_post_url` is copied verbatim from the source and doesn't
 * drift the same way, so it's the stable identity to dedupe on instead.
 *
 * If a duplicate already exists (this fix landed after the drift happened), the row with
 * the earliest `data.found_date` wins, since that's the one that was actually found first
 * and may already carry outreach history against its item_key. Found 2026-08-15: the same
 * YC posting synced as both `landeed-crm-95120` (found 08-13, already emailed) and
 * `landeed-customer-relationship-manager-95120` (found 08-15, a re-discovery).
 */
export function buildTrackedUrlIndex(
  agentId: string,
  entity: string,
): Map<string, string> {
  const rows = db
    .prepare(
      'SELECT item_key, data FROM tracked_items WHERE agent_id = ? AND entity = ?',
    )
    .all(agentId, entity) as { item_key: string; data: string }[];
  const index = new Map<string, string>();
  const bestFoundDate = new Map<string, string>();
  for (const r of rows) {
    let d: any;
    try {
      d = JSON.parse(r.data);
    } catch {
      continue;
    }
    const url =
      typeof d?.matched_post_url === 'string' ? d.matched_post_url.trim() : '';
    if (!url) continue;
    const foundDate = typeof d?.found_date === 'string' ? d.found_date : '';
    const currentBest = bestFoundDate.get(url);
    if (
      !index.has(url) ||
      (foundDate && (!currentBest || foundDate < currentBest))
    ) {
      index.set(url, r.item_key);
      bestFoundDate.set(url, foundDate);
    }
  }
  return index;
}

/**
 * Advance a tracked item's stage without touching its data.
 *
 * Used by the reply poller: a reply should move a lead to 'replied' without the poller having
 * to know or rewrite the lead's fields. stage_since only moves when the stage actually
 * changes, matching upsertTrackedItem, so "stuck for N days" stays truthful.
 */
export function updateTrackedItemStage(
  agentId: string,
  entity: string,
  itemKey: string,
  stage: string,
): boolean {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `
    UPDATE tracked_items
       SET stage = ?, updated_at = ?,
           stage_since = CASE WHEN stage IS ? THEN stage_since ELSE ? END
     WHERE agent_id = ? AND entity = ? AND item_key = ?
  `,
    )
    .run(stage, now, stage, now, agentId, entity, itemKey);
  return r.changes > 0;
}

/** All tracked items for an agent (optionally one entity), newest first. */
export function getTrackedItems(
  agentId: string,
  entity?: string,
): TrackedItem[] {
  const rows = (
    entity
      ? db
          .prepare(
            'SELECT * FROM tracked_items WHERE agent_id = ? AND entity = ? ORDER BY updated_at DESC',
          )
          .all(agentId, entity)
      : db
          .prepare(
            'SELECT * FROM tracked_items WHERE agent_id = ? ORDER BY updated_at DESC',
          )
          .all(agentId)
  ) as any[];
  return rows.map((r) => ({
    entity: r.entity,
    item_key: r.item_key,
    stage: r.stage,
    data: (() => {
      try {
        return JSON.parse(r.data);
      } catch {
        return {};
      }
    })(),
    updated_at: r.updated_at,
    stage_since: r.stage_since ?? r.updated_at,
  }));
}

// ─── Stage 40: outreach sends + replies ───────────────────────────────────────

export interface OutreachSend {
  id: string;
  agent_id?: string | null;
  lead_key?: string | null;
  business?: string | null;
  to_email: string;
  subject?: string | null;
  message_id?: string | null;
  sent_at: string;
  via?: string | null;
}

export function recordOutreachSend(
  s: Omit<OutreachSend, 'id' | 'sent_at'> & { sent_at?: string },
): OutreachSend {
  const id = randomUUID();
  const sent_at = s.sent_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO outreach_sends (id, agent_id, lead_key, business, to_email, subject, message_id, sent_at, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    s.agent_id ?? null,
    s.lead_key ?? null,
    s.business ?? null,
    s.to_email,
    s.subject ?? null,
    s.message_id ?? null,
    sent_at,
    s.via ?? null,
  );
  return { ...s, id, sent_at };
}

/**
 * Every address we have ever emailed, for matching an inbound message by sender.
 *
 * The stored `message_id` keeps its RFC822 angle brackets (`<...>`), but the reply-poller
 * compares against a bracket-stripped, lowercased `normId()`. An exact `=` here made every
 * thread match fail — 2026-08-15, a real reply (Traffio) sat unrecorded for 21+ hours because
 * of this. Normalise both sides so callers can pass either form.
 */
export function getOutreachSendByMessageId(
  messageId: string,
): OutreachSend | null {
  if (!messageId) return null;
  const norm = messageId.replace(/[<>]/g, '').trim().toLowerCase();
  return (
    (db
      .prepare(
        "SELECT * FROM outreach_sends WHERE replace(replace(lower(message_id), '<', ''), '>', '') = ?",
      )
      .get(norm) as OutreachSend) ?? null
  );
}

/** Most recent send to an address — the fallback when a reply carries no In-Reply-To. */
export function getLatestOutreachSendTo(email: string): OutreachSend | null {
  return (
    (db
      .prepare(
        'SELECT * FROM outreach_sends WHERE lower(to_email) = lower(?) ORDER BY sent_at DESC LIMIT 1',
      )
      .get(email) as OutreachSend) ?? null
  );
}

/**
 * Most recent send for a lead, for threading a follow-up/closing reply onto the original
 * message. Callers should strip any `#suffix` a draft's own bookkeeping added to the lead_key
 * (e.g. `...#closing`) before calling this — the tracked lead_key never has one.
 */
export function getLatestOutreachSendForLead(
  leadKey: string,
): OutreachSend | null {
  if (!leadKey) return null;
  return (
    (db
      .prepare(
        'SELECT * FROM outreach_sends WHERE lead_key = ? ORDER BY sent_at DESC LIMIT 1',
      )
      .get(leadKey) as OutreachSend) ?? null
  );
}

export function listOutreachRecipients(): string[] {
  return (
    db
      .prepare('SELECT DISTINCT lower(to_email) e FROM outreach_sends')
      .all() as { e: string }[]
  ).map((r) => r.e);
}

export interface OutreachReply {
  id: string;
  send_id?: string | null;
  lead_key?: string | null;
  from_email: string;
  subject?: string | null;
  body_excerpt?: string | null;
  message_id?: string | null;
  in_reply_to?: string | null;
  is_auto: number;
  auto_reason?: string | null;
  received_at: string;
  seen_by_human: number;
}

/** Insert a reply. Returns null if this Message-ID was already recorded (poll overlap). */
export function recordOutreachReply(
  r: Omit<OutreachReply, 'id' | 'seen_by_human'>,
): OutreachReply | null {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO outreach_replies (id, send_id, lead_key, from_email, subject, body_excerpt,
                                     message_id, in_reply_to, is_auto, auto_reason, received_at, seen_by_human)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      id,
      r.send_id ?? null,
      r.lead_key ?? null,
      r.from_email,
      r.subject ?? null,
      r.body_excerpt ?? null,
      r.message_id ?? null,
      r.in_reply_to ?? null,
      r.is_auto,
      r.auto_reason ?? null,
      r.received_at,
    );
  } catch (e: any) {
    if (String(e?.message ?? '').includes('UNIQUE')) return null; // already have it
    throw e;
  }
  return { ...r, id, seen_by_human: 0 };
}

export function hasOutreachReply(messageId: string): boolean {
  if (!messageId) return false;
  return !!db
    .prepare('SELECT 1 FROM outreach_replies WHERE message_id = ?')
    .get(messageId);
}

/** Human replies only — autoresponders are excluded on purpose. */
export function getHumanReplies(limit = 50): OutreachReply[] {
  return db
    .prepare(
      'SELECT * FROM outreach_replies WHERE is_auto = 0 ORDER BY received_at DESC LIMIT ?',
    )
    .all(limit) as OutreachReply[];
}

/**
 * Stage 40 Phase 4 — leads that are due another touch.
 *
 * Most replies to cold outreach come from the second, third or fourth touch, so a strict
 * one-touch-and-stop rule leaves most of the value on the table. This is what makes a bounded
 * sequence possible without letting it run forever.
 *
 * A lead is due when: we have sent at least one email, fewer than `maxTouches`, the last one
 * was at least `gapDays` ago, and NOBODY HAS REPLIED. The reply check is the important one —
 * following up on someone who already answered is the worst outcome available, worse than
 * never following up at all.
 *
 * Autoresponders are excluded from the reply check on purpose (`is_auto = 0`): a "thanks for
 * contacting us" must not silence a follow-up.
 */
export interface DueFollowUp {
  lead_key: string;
  business: string | null;
  to_email: string;
  agent_id: string | null;
  touches: number;
  last_sent_at: string;
  last_subject: string | null;
  days_since: number;
}

export function getLeadsDueForFollowUp(
  opts: { gapDays?: number; maxTouches?: number; now?: Date } = {},
): DueFollowUp[] {
  const gapDays = opts.gapDays ?? 3;
  const maxTouches = opts.maxTouches ?? 3;
  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - gapDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  // Belt and braces: the SQL excludes bounced addresses, and so does the final filter, because
  // the follow-up goes to the most recent address for the lead rather than the one aggregated.
  const bounced = new Set(getBouncedAddresses());

  const rows = db
    .prepare(
      `
    SELECT s.lead_key                AS lead_key,
           MAX(s.business)           AS business,
           MAX(s.agent_id)           AS agent_id,
           COUNT(*)                  AS touches,
           MAX(s.sent_at)            AS last_sent_at
      FROM outreach_sends s
     WHERE s.lead_key IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM outreach_replies r
              WHERE r.is_auto = 0
                AND (r.lead_key = s.lead_key OR r.send_id = s.id)
           )
       -- Never follow up an address that bounced. Without this, DMV Dating would have been
       -- emailed twice more at info@dmvdatingroup.com, an address that does not exist:
       -- the sequence works off sends and knew nothing about delivery failure.
       AND NOT EXISTS (
             SELECT 1 FROM outreach_sends b
              WHERE b.bounced = 1
                AND lower(b.to_email) = lower(s.to_email)
           )
       -- A follow-up draft already sitting in the approval queue is not "due" again — it's
       -- waiting on the human, not on the scheduler. Without this, every 6h tick re-asked
       -- Mailer to draft the same touch for as long as the approval sat unactioned: the
       -- Abacus touch-2 draft was re-verified 5 times over ~30h ($0.57 across the pattern,
       -- measured 2026-08-20) before it was finally approved, because outreach_sends only
       -- counts SENT touches -- a pending, not-yet-approved draft never showed up here at all.
       AND NOT EXISTS (
             SELECT 1 FROM agent_checkins c
              WHERE c.status = 'pending'
                AND c.action_type = 'send_email'
                AND json_extract(c.action_payload, '$.lead_key') = s.lead_key
           )
     GROUP BY s.lead_key
    HAVING COUNT(*) < ? AND MAX(s.sent_at) <= ?
  `,
    )
    .all(maxTouches, cutoff) as Array<{
    lead_key: string;
    business: string | null;
    agent_id: string | null;
    touches: number;
    last_sent_at: string;
  }>;

  return rows
    .map((r) => {
      // The address and subject of the most recent touch — a follow-up goes to whoever we
      // reached last, not to the first address we ever tried.
      const last = db
        .prepare(
          'SELECT to_email, subject FROM outreach_sends WHERE lead_key = ? ORDER BY sent_at DESC LIMIT 1',
        )
        .get(r.lead_key) as
        | { to_email: string; subject: string | null }
        | undefined;
      return {
        ...r,
        to_email: last?.to_email ?? '',
        last_subject: last?.subject ?? null,
        days_since: Math.floor(
          (now.getTime() - new Date(r.last_sent_at).getTime()) / 86_400_000,
        ),
      };
    })
    .filter((r) => !!r.to_email && !bounced.has(r.to_email.toLowerCase()));
}

/** Has any human replied for this lead? Used to cancel a queued follow-up late. */
export function leadHasHumanReply(leadKey: string): boolean {
  if (!leadKey) return false;
  return !!db
    .prepare(
      'SELECT 1 FROM outreach_replies WHERE lead_key = ? AND is_auto = 0',
    )
    .get(leadKey);
}

/** Fill in a reply's body excerpt after the second IMAP pass has fetched it. */
export function setOutreachReplyExcerpt(
  messageId: string,
  excerpt: string,
): void {
  db.prepare(
    'UPDATE outreach_replies SET body_excerpt = ? WHERE message_id = ?',
  ).run(excerpt, messageId);
}

/**
 * Record that a send bounced.
 *
 * `info@dmvdatingroup.com` was verified `catch_all` by Reacher and then rejected the message
 * three seconds after it left, with "Address not found — the email account that you tried to
 * reach does not exist". A verifier's verdict is a prediction; a bounce is the truth.
 */
export function markOutreachSendBounced(sendId: string, reason: string): void {
  db.prepare(
    'UPDATE outreach_sends SET bounced = 1, bounce_reason = ? WHERE id = ?',
  ).run(reason.slice(0, 500), sendId);
}

/** Every address that has bounced, lowercased — the suppression list for follow-ups. */
export function getBouncedAddresses(): string[] {
  return (
    db
      .prepare(
        'SELECT DISTINCT lower(to_email) e FROM outreach_sends WHERE bounced = 1',
      )
      .all() as { e: string }[]
  ).map((r) => r.e);
}

/**
 * Which agent's tracker actually holds this lead, and under which entity.
 *
 * The agent that SENT an email is not necessarily the agent that TRACKS the lead. Finder
 * finds and tracks; Mailer sends. `outreach_sends.agent_id` records the sender, so staging a
 * bounce against it looked for a `Leads` tracker on Mailer, which has none — the write
 * no-opped and three dead addresses stayed `qualified` in Finder's tracker (2026-08-14). It
 * worked before only because Finder used to do its own sending.
 */
export function findTrackerOwnerForItem(
  itemKey: string,
): { agentId: string; entity: string } | null {
  const row = db
    .prepare(
      'SELECT agent_id, entity FROM tracked_items WHERE item_key = ? LIMIT 1',
    )
    .get(itemKey) as { agent_id: string; entity: string } | undefined;
  return row ? { agentId: row.agent_id, entity: row.entity } : null;
}

// ─── Agent self-report ────────────────────────────────────────────────────────

/**
 * Everything an agent can truthfully say about itself, read from the orchestrator DB.
 *
 * Exists because an agent had no route to its own history. The identity block injected
 * at cycle start (agent-service.ts, `selfContext`) carries name + id + role and nothing
 * else; `GET /:id/self` is forward-looking config only; and the agent container mounts
 * only its own workspace (nanobot-cycle-runner.ts), so `sql_query` cannot reach
 * `agent_cycles` at all. Asked "how many cycles have you run", Finder counted the
 * `sweep-results-*.json` files in its workspace — 210 — because that was the only
 * observable it had. The real number was 378.
 *
 * Every query is scoped by agentId. The caller proves the requester IS that agent;
 * nothing here filters by owner.
 */
export interface AgentSelfReportData {
  cycles: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    byType: Array<{ type: string; n: number }>;
    /** Last time each cycle_type actually ran — the input to the schedule-vs-reality check. */
    lastRunByType: Record<string, string>;
    /**
     * The 20 most recent start times per cycle_type, newest first.
     *
     * Lets the caller derive each entry's OWN typical cadence and flag a stop against
     * that, instead of one fixed staleness threshold. A fixed threshold cannot work for
     * both an hourly sweep and a weekly report: 48h misses a stopped hourly schedule for
     * two days, and libels a weekly one every week.
     */
    recentRunsByType: Record<string, string[]>;
    first: string | null;
    last: string | null;
    last24h: number;
    last7d: number;
    medianMinutes: number | null;
    tasksDone: number;
    topFailures: Array<{ reason: string; n: number }>;
    recent: Array<{
      startedAt: string;
      type: string;
      status: string;
      summary: string;
    }>;
  };
  spend: { today: number; last7d: number; lifetime: number };
  /**
   * The agent's own episode logs, newest first — what it wrote down about what happened,
   * as opposed to the one-line summary shown to a human. 800 of 1,327 cycles carry one
   * and nothing had ever read them back to the agent that wrote them.
   */
  episodes: Array<{ at: string; type: string; log: string }>;
  /**
   * Check-ins a human actually answered, newest first, with the reply verbatim.
   *
   * The only direct human judgement anywhere in the system, and it was invisible to the
   * agent being judged. Verbatim matters: a bare "reject" has once been LLM-summarised
   * into invented instructions and written to IDENTITY.md at high relevance, so the
   * renderer must show exactly what was typed and nothing inferred from it.
   */
  feedback: Array<{
    at: string;
    respondedAt: string | null;
    about: string;
    reply: string;
  }>;
  tracked: Array<{ entity: string; stage: string; n: number }>;
  handoffs: { sent: number; received: number; pendingIn: number };
  checkins: { total: number; pending: number; oldestPendingAt: string | null };
  memory: { memories: number; learnedBullets: number };
  /** Null when this agent has never sent outreach — an empty section is noise. */
  outreach: {
    sends: number;
    people: number;
    bounced: number;
    lastSentAt: string | null;
    replies: number;
    humanReplies: number;
  } | null;
}

export function getAgentSelfReport(agentId: string): AgentSelfReportData {
  const one = <T>(sql: string, ...params: unknown[]): T =>
    db.prepare(sql).get(...params) as T;
  const many = <T>(sql: string, ...params: unknown[]): T[] =>
    db.prepare(sql).all(...params) as T[];

  const counts = one<{
    total: number;
    completed: number;
    failed: number;
    running: number;
    tasks: number;
    first: string | null;
    last: string | null;
  }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'completed'), 0) AS completed,
            COALESCE(SUM(status = 'failed'), 0)    AS failed,
            COALESCE(SUM(status = 'running'), 0)   AS running,
            COALESCE(SUM(tasks_done), 0)           AS tasks,
            MIN(started_at) AS first, MAX(started_at) AS last
       FROM agent_cycles WHERE agent_id = ?`,
    agentId,
  );

  const byType = many<{ type: string; n: number }>(
    `SELECT cycle_type AS type, COUNT(*) AS n FROM agent_cycles
      WHERE agent_id = ? GROUP BY cycle_type ORDER BY n DESC`,
    agentId,
  );

  const lastRunRows = many<{ type: string; last: string }>(
    `SELECT cycle_type AS type, MAX(started_at) AS last FROM agent_cycles
      WHERE agent_id = ? GROUP BY cycle_type`,
    agentId,
  );
  const lastRunByType: Record<string, string> = {};
  for (const r of lastRunRows) lastRunByType[r.type] = r.last;

  const recentRunRows = many<{ type: string; startedAt: string }>(
    `SELECT cycle_type AS type, started_at AS startedAt FROM (
        SELECT cycle_type, started_at,
               ROW_NUMBER() OVER (PARTITION BY cycle_type ORDER BY started_at DESC) AS rn
          FROM agent_cycles WHERE agent_id = ?
     ) WHERE rn <= 20 ORDER BY cycle_type, startedAt DESC`,
    agentId,
  );
  const recentRunsByType: Record<string, string[]> = {};
  for (const r of recentRunRows)
    (recentRunsByType[r.type] ??= []).push(r.startedAt);

  const recentCounts = one<{ d1: number; d7: number }>(
    `SELECT COALESCE(SUM(started_at >= datetime('now', '-1 day')),  0) AS d1,
            COALESCE(SUM(started_at >= datetime('now', '-7 days')), 0) AS d7
       FROM agent_cycles WHERE agent_id = ?`,
    agentId,
  );

  // Median, not mean: one 40-minute stall skews an average enough to hide that the
  // typical cycle is fine, and "typical" is the number worth acting on.
  const durations = many<{ mins: number }>(
    `SELECT (julianday(ended_at) - julianday(started_at)) * 1440 AS mins
       FROM agent_cycles
      WHERE agent_id = ? AND ended_at IS NOT NULL AND status = 'completed'
      ORDER BY mins`,
    agentId,
  )
    .map((r) => r.mins)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const medianMinutes = durations.length
    ? Math.round(durations[Math.floor(durations.length / 2)] * 10) / 10
    : null;

  // Failure summaries are free text with a stack trace appended; the first 70 chars are
  // what distinguishes one cause from another.
  const topFailures = many<{ reason: string; n: number }>(
    `SELECT substr(COALESCE(summary, 'no summary recorded'), 1, 70) AS reason, COUNT(*) AS n
       FROM agent_cycles WHERE agent_id = ? AND status = 'failed'
      GROUP BY reason ORDER BY n DESC LIMIT 5`,
    agentId,
  );

  const recent = many<{
    startedAt: string;
    type: string;
    status: string;
    summary: string | null;
  }>(
    `SELECT started_at AS startedAt, cycle_type AS type, status, summary
       FROM agent_cycles WHERE agent_id = ? ORDER BY started_at DESC LIMIT 5`,
    agentId,
  ).map((r) => ({
    ...r,
    summary: (r.summary ?? '').replace(/\s+/g, ' ').slice(0, 180),
  }));

  const spend = one<{ today: number; last7d: number; lifetime: number }>(
    `SELECT COALESCE(SUM(CASE WHEN date(started_at) = date('now') THEN cost END), 0) AS today,
            COALESCE(SUM(CASE WHEN started_at >= datetime('now', '-7 days') THEN cost END), 0) AS last7d,
            COALESCE(SUM(cost), 0) AS lifetime
       FROM agent_cycles WHERE agent_id = ?`,
    agentId,
  );

  const episodes = many<{ at: string; type: string; log: string }>(
    `SELECT started_at AS at, cycle_type AS type, episode_log AS log
       FROM agent_cycles
      WHERE agent_id = ? AND episode_log IS NOT NULL AND TRIM(episode_log) <> ''
      ORDER BY started_at DESC LIMIT 5`,
    agentId,
  );

  const feedback = many<{
    at: string;
    respondedAt: string | null;
    about: string;
    reply: string;
  }>(
    `SELECT created_at AS at, responded_at AS respondedAt,
            substr(COALESCE(report_md, ''), 1, 90) AS about,
            user_reply AS reply
       FROM agent_checkins
      WHERE agent_id = ? AND status = 'responded'
        AND user_reply IS NOT NULL AND TRIM(user_reply) <> ''
      ORDER BY responded_at DESC LIMIT 8`,
    agentId,
  );

  const tracked = many<{ entity: string; stage: string; n: number }>(
    `SELECT entity, COALESCE(stage, '(no stage)') AS stage, COUNT(*) AS n
       FROM tracked_items WHERE agent_id = ?
      GROUP BY entity, stage ORDER BY entity, n DESC`,
    agentId,
  );

  // Requests only: these are counts of WORK, and since stage 56 an answer is a row too.
  // Without the filter, "3 pending for you" would include three replies to things this
  // agent asked about — the opposite of work owed.
  const handoffs = one<{ sent: number; received: number; pendingIn: number }>(
    `SELECT (SELECT COUNT(*) FROM agent_handoffs WHERE from_agent_id = ? AND ${IS_REQUEST}) AS sent,
            (SELECT COUNT(*) FROM agent_handoffs WHERE to_agent_id   = ? AND ${IS_REQUEST}) AS received,
            (SELECT COUNT(*) FROM agent_handoffs WHERE to_agent_id = ? AND ${IS_REQUEST} AND status = 'pending') AS pendingIn`,
    agentId,
    agentId,
    agentId,
  );

  const checkins = one<{
    total: number;
    pending: number;
    oldestPendingAt: string | null;
  }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'pending'), 0) AS pending,
            MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldestPendingAt
       FROM agent_checkins WHERE agent_id = ?`,
    agentId,
  );

  const memory = one<{ memories: number; learnedBullets: number }>(
    `SELECT (SELECT COUNT(*) FROM agent_memory          WHERE agent_id = ?) AS memories,
            (SELECT COUNT(*) FROM agent_learned_bullets WHERE agent_id = ?) AS learnedBullets`,
    agentId,
    agentId,
  );

  const sendStats = one<{
    sends: number;
    people: number;
    bounced: number;
    lastSentAt: string | null;
  }>(
    `SELECT COUNT(*) AS sends, COUNT(DISTINCT to_email) AS people,
            COALESCE(SUM(bounced), 0) AS bounced, MAX(sent_at) AS lastSentAt
       FROM outreach_sends WHERE agent_id = ?`,
    agentId,
  );
  let outreach: AgentSelfReportData['outreach'] = null;
  if (sendStats.sends > 0) {
    // Match on send_id where the reply threaded cleanly, and fall back to lead_key for
    // replies that arrived without a usable In-Reply-To header.
    const replies = one<{ replies: number; humanReplies: number }>(
      `SELECT COUNT(*) AS replies, COALESCE(SUM(is_auto = 0), 0) AS humanReplies
         FROM outreach_replies
        WHERE send_id IN (SELECT id FROM outreach_sends WHERE agent_id = ?)
           OR (lead_key IS NOT NULL
               AND lead_key IN (SELECT lead_key FROM outreach_sends
                                 WHERE agent_id = ? AND lead_key IS NOT NULL))`,
      agentId,
      agentId,
    );
    outreach = { ...sendStats, ...replies };
  }

  return {
    cycles: {
      total: counts.total,
      completed: counts.completed,
      failed: counts.failed,
      running: counts.running,
      byType,
      lastRunByType,
      recentRunsByType,
      first: counts.first,
      last: counts.last,
      last24h: recentCounts.d1,
      last7d: recentCounts.d7,
      medianMinutes,
      tasksDone: counts.tasks,
      topFailures,
      recent,
    },
    spend,
    episodes,
    feedback,
    tracked,
    handoffs,
    checkins,
    memory,
    outreach,
  };
}

// ─── Agent config audit (stage 54 phase 1) ────────────────────────────────────

/**
 * One recorded change to an agent's own configuration.
 *
 * See the CREATE TABLE for why this exists. The short version: two failures in August
 * 2026 went unnoticed for eleven and seventeen days, neither was a permissions problem,
 * and both would have been obvious within an hour from a diff.
 */
export interface AgentConfigAudit {
  id: string;
  agent_id: string;
  capability: string;
  actor: 'agent' | 'owner' | 'admin' | 'system';
  cycle_id: string | null;
  before_json: string;
  after_json: string;
  reason: string | null;
  reverted_by: string | null;
  created_at: string;
}

export interface RecordConfigAuditInput {
  agentId: string;
  capability: string;
  actor: AgentConfigAudit['actor'];
  cycleId?: string | null;
  before: unknown;
  after: unknown;
  reason?: string | null;
  /**
   * When the change happened, if not now. For backfilling real history — and for a test
   * that needs a change dated relative to the cycles either side of it, which is the only
   * way to exercise the impact comparison against a realistic timeline.
   */
  createdAt?: string;
}

/**
 * Record one change. Returns the row id, or null when nothing actually moved.
 *
 * The no-op check matters more than it looks: several call sites write a whole config
 * patch on every save, so without it the history fills with rows whose diff is empty and
 * the real changes become impossible to spot. A history nobody can scan is not a history.
 */
export function recordConfigAudit(
  input: RecordConfigAuditInput,
): string | null {
  try {
    const before = JSON.stringify(input.before ?? null);
    const after = JSON.stringify(input.after ?? null);
    if (before === after) return null;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO agent_config_audit
         (id, agent_id, capability, actor, cycle_id, before_json, after_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.agentId,
      input.capability,
      input.actor,
      input.cycleId ?? null,
      before,
      after,
      input.reason ?? null,
      input.createdAt ?? new Date().toISOString(),
    );
    return id;
  } catch (err) {
    // Bookkeeping must never take down the thing it is bookkeeping for. This is called
    // from the scheduler tick and from mid-cycle routes, and the FOREIGN KEY constraint
    // here can fail for reasons that have nothing to do with the caller — an agent
    // deleted between the change and the write, most obviously. Memory decay threw
    // exactly this error inside a cycle once and killed it outright; housekeeping does
    // not get to do that again.
    //
    // Logged at error level on purpose: a silent gap in the trail is the failure this
    // table exists to prevent, so a missing row must be loud even though it is survivable.
    logger.error(
      {
        agentId: input.agentId,
        capability: input.capability,
        err: err instanceof Error ? err.message : String(err),
      },
      'config audit write FAILED — the change was applied but is NOT recorded',
    );
    return null;
  }
}

export function getConfigAudit(
  agentId: string,
  limit = 100,
): AgentConfigAudit[] {
  return db
    .prepare(
      `SELECT * FROM agent_config_audit WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(agentId, limit) as AgentConfigAudit[];
}

export function getConfigAuditById(id: string): AgentConfigAudit | null {
  return (
    (db.prepare('SELECT * FROM agent_config_audit WHERE id = ?').get(id) as
      | AgentConfigAudit
      | undefined) ?? null
  );
}

/**
 * Link an entry to the entry that undid it.
 *
 * A revert is itself a recorded change rather than an erasure, so reverting a revert is
 * just another row and the trail never loses a step.
 */
export function markAuditReverted(
  originalId: string,
  revertAuditId: string,
): void {
  db.prepare('UPDATE agent_config_audit SET reverted_by = ? WHERE id = ?').run(
    revertAuditId,
    originalId,
  );
}

/** Recent changes across every agent an owner has — the input to the daily digest. */
export function getConfigAuditByOwner(
  ownerId: string,
  sinceIso: string,
): Array<AgentConfigAudit & { agent_name: string }> {
  return db
    .prepare(
      `SELECT c.*, a.name AS agent_name
       FROM agent_config_audit c JOIN agents a ON a.id = c.agent_id
      WHERE a.owner_id = ? AND c.created_at >= ?
      ORDER BY c.created_at DESC`,
    )
    .all(ownerId, sinceIso) as Array<AgentConfigAudit & { agent_name: string }>;
}

/**
 * How a cycle actually ran — the signals an agent cannot observe about itself.
 *
 * Stage 55. `self_report` gives an agent its cycle SUMMARY; I read `cycle_steps` — which
 * tool, with what arguments, what came back, and how long each gap took. That asymmetry
 * is why a 38-minute Mailer cycle spent re-running a command it had already run could be
 * diagnosed from outside in a minute and was described by Mailer itself as productive.
 *
 * Returning the raw trace is not the answer — it is a token bomb and the model would have
 * to derive the signal anyway. These are the derived numbers instead, which is the part
 * that changes behaviour:
 *
 *   - think time: the gap between steps is almost entirely the model, because the tools
 *     in question (a 2KB read_file, an `ls | grep`) are instant. Mailer's median was 85s
 *     on a model that took 43.9s to fail a one-word test.
 *   - repeats: the same tool with the same arguments twice in one cycle is the signature
 *     of a loop. Mailer ran an identical `ls | grep -i nestmed` 13 minutes apart.
 *   - failures: a tool erroring repeatedly is a broken approach, not bad luck.
 */
export interface CycleTraceSignals {
  cycleId: string;
  startedAt: string;
  cycleType: string;
  steps: number;
  toolCalls: number;
  /** Seconds between steps — overwhelmingly model latency. See gapIsAverage. */
  medianGapSeconds: number | null;
  /**
   * True when medianGapSeconds is the wall-clock AVERAGE rather than a real median,
   * because the step timestamps were all identical. Say which, rather than presenting an
   * average as a median.
   */
  gapIsAverage: boolean;
  slowestGapSeconds: number | null;
  /** Wall-clock minutes from first step to last. */
  spanMinutes: number | null;
  /** Same tool, same arguments, more than once in this cycle. */
  repeatedCalls: Array<{ tool: string; times: number; argsPreview: string }>;
  /** Tools whose output looked like an error. */
  failedCalls: Array<{ tool: string; times: number; sample: string }>;
  toolBreakdown: Array<{ tool: string; calls: number }>;
}

/** Output that means the call did not do what was asked. */
const TOOL_ERROR =
  /^\s*(error|traceback|exception)\b|"error"\s*:|\bpermission denied\b|\bnot found\b|blocked by safety guard|STDERR:/i;

/**
 * What became of the handoffs this agent sent.
 *
 * Stage 55 phase 3. Finder has sent 133 handoffs and could see nothing about any of them.
 * It asked for exactly this on 2026-08-24 — "leads sitting 7+ days without pipeline status
 * need Mailer's status before I spend more effort broadening the top of the funnel" — and
 * nothing answered. When later asked to summarise its results it filled that gap by
 * inventing an email address.
 *
 * Reports what the RECIPIENT did, joined by agent, which is the part the sender cannot
 * see. Same-owner is guaranteed: a handoff can only exist between two agents already.
 */
export interface HandoffOutcome {
  toAgent: string;
  sent: number;
  /** Reached their context and drew no answer. The honest form of the old 'acknowledged'. */
  seenOnly: number;
  /** Taken on, not yet answered. */
  agreed: number;
  completed: number;
  refused: number;
  cannot: number;
  failed: number;
  stillPending: number;
  oldestPendingAt: string | null;
  /** Cycles the recipient has run since the most recent handoff — did it even wake up? */
  recipientCyclesSince: number | null;
  /** The most recent answers in their own words. Stage 56 — before this there were none. */
  recentAnswers: Array<{
    performative: string;
    result: string;
    reason: string | null;
    at: string;
  }>;
}

export function getHandoffOutcomes(agentId: string): HandoffOutcome[] {
  const rows = db
    .prepare(
      `SELECT h.to_agent_id AS toId, a.name AS toName,
            COUNT(*) AS sent,
            COALESCE(SUM(h.status = 'seen'), 0)      AS seenOnly,
            COALESCE(SUM(h.status = 'agreed'), 0)    AS agreed,
            COALESCE(SUM(h.status = 'completed'), 0) AS completed,
            COALESCE(SUM(h.status = 'refused'), 0)   AS refused,
            COALESCE(SUM(h.status = 'cannot'), 0)    AS cannot,
            COALESCE(SUM(h.status = 'failed'), 0)    AS failed,
            COALESCE(SUM(h.status = 'pending'), 0)   AS stillPending,
            MIN(CASE WHEN h.status = 'pending' THEN h.created_at END) AS oldestPendingAt,
            MAX(h.created_at) AS lastSentAt
       FROM agent_handoffs h
       LEFT JOIN agents a ON a.id = h.to_agent_id
      WHERE h.from_agent_id = ? AND COALESCE(h.performative, 'request') = 'request'
      GROUP BY h.to_agent_id
      ORDER BY sent DESC`,
    )
    .all(agentId) as Array<{
    toId: string;
    toName: string | null;
    sent: number;
    seenOnly: number;
    agreed: number;
    completed: number;
    refused: number;
    cannot: number;
    failed: number;
    stillPending: number;
    oldestPendingAt: string | null;
    lastSentAt: string;
  }>;

  return rows.map((r) => {
    let recipientCyclesSince: number | null = null;
    try {
      const c = db
        .prepare(
          'SELECT COUNT(*) AS n FROM agent_cycles WHERE agent_id = ? AND started_at >= ?',
        )
        .get(r.toId, r.lastSentAt) as { n: number };
      recipientCyclesSince = c?.n ?? null;
    } catch {
      /* recipient deleted — the counts above still stand */
    }

    let recentAnswers: HandoffOutcome['recentAnswers'] = [];
    try {
      recentAnswers = db
        .prepare(
          `SELECT status AS performative, result, result_reason AS reason, replied_at AS at
           FROM agent_handoffs
          WHERE from_agent_id = ? AND to_agent_id = ? AND ${IS_REQUEST} AND replied_at IS NOT NULL
          ORDER BY replied_at DESC LIMIT 3`,
        )
        .all(agentId, r.toId) as HandoffOutcome['recentAnswers'];
    } catch {
      /* pre-migration DB — the counts above still stand */
    }

    return {
      toAgent: r.toName ?? r.toId.slice(0, 8),
      sent: r.sent,
      seenOnly: r.seenOnly,
      agreed: r.agreed,
      completed: r.completed,
      refused: r.refused,
      cannot: r.cannot,
      failed: r.failed,
      stillPending: r.stillPending,
      oldestPendingAt: r.oldestPendingAt,
      recipientCyclesSince,
      recentAnswers,
    };
  });
}

export function getCycleTraceSignals(
  cycleId: string,
): CycleTraceSignals | null {
  const cycle = db
    .prepare('SELECT id, started_at, cycle_type FROM agent_cycles WHERE id = ?')
    .get(cycleId) as
    | { id: string; started_at: string; cycle_type: string }
    | undefined;
  if (!cycle) return null;

  const steps = db
    .prepare(
      'SELECT seq, type, tool, input, output, created_at FROM cycle_steps WHERE cycle_id = ? ORDER BY seq',
    )
    .all(cycleId) as Array<{
    seq: number;
    type: string;
    tool: string | null;
    input: string | null;
    output: string | null;
    created_at: string;
  }>;

  // cycle_steps.created_at is the WRITE time, not the event time, and a finished cycle is
  // written in one batch — so all 28 steps of a Mailer cycle carry the same instant and
  // the per-step gaps are all zero. Real gaps only exist while a cycle is still running
  // and being upserted incrementally, which is exactly when nobody is asking.
  //
  // So: use real gaps when the timestamps are actually distinct, and otherwise fall back
  // to the wall-clock average, labelled as such. The average is less precise and still
  // decides the question — 84s/step is a broken model whichever way it is measured.
  const gaps: number[] = [];
  for (let i = 1; i < steps.length; i++) {
    const g =
      (Date.parse(steps[i].created_at) - Date.parse(steps[i - 1].created_at)) /
      1000;
    if (Number.isFinite(g) && g > 0) gaps.push(g);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  let median = sorted.length
    ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10
    : null;
  let gapIsAverage = false;

  if (median === null && steps.length > 1) {
    const row = db
      .prepare('SELECT started_at, ended_at FROM agent_cycles WHERE id = ?')
      .get(cycleId) as
      | { started_at: string; ended_at: string | null }
      | undefined;
    if (row?.ended_at) {
      const secs =
        (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000;
      if (Number.isFinite(secs) && secs > 0) {
        median = Math.round((secs / steps.length) * 10) / 10;
        gapIsAverage = true;
      }
    }
  }

  const calls = steps.filter((s) => s.tool);
  const byKey = new Map<
    string,
    { tool: string; times: number; argsPreview: string }
  >();
  const byTool = new Map<string, number>();
  const errors = new Map<
    string,
    { tool: string; times: number; sample: string }
  >();

  for (const s of calls) {
    const tool = s.tool!;
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);

    // Identical arguments, not just the same tool — calling read_file twice is normal,
    // calling it twice on the same path is the thing worth seeing.
    const key = `${tool}::${(s.input ?? '').trim()}`;
    const seen = byKey.get(key);
    if (seen) seen.times++;
    else
      byKey.set(key, {
        tool,
        times: 1,
        argsPreview: (s.input ?? '').replace(/\s+/g, ' ').slice(0, 120),
      });

    if (s.output && TOOL_ERROR.test(s.output)) {
      const e = errors.get(tool);
      if (e) e.times++;
      else
        errors.set(tool, {
          tool,
          times: 1,
          sample: s.output.replace(/\s+/g, ' ').slice(0, 140),
        });
    }
  }

  const first = steps[0]?.created_at;
  const last = steps[steps.length - 1]?.created_at;

  return {
    cycleId: cycle.id,
    startedAt: cycle.started_at,
    cycleType: cycle.cycle_type,
    steps: steps.length,
    toolCalls: calls.length,
    medianGapSeconds: median,
    gapIsAverage,
    slowestGapSeconds: sorted.length
      ? Math.round(sorted[sorted.length - 1] * 10) / 10
      : null,
    spanMinutes: (() => {
      const fromSteps =
        first && last ? (Date.parse(last) - Date.parse(first)) / 60000 : 0;
      if (fromSteps > 0) return Math.round(fromSteps * 10) / 10;
      const row = db
        .prepare('SELECT started_at, ended_at FROM agent_cycles WHERE id = ?')
        .get(cycleId) as
        | { started_at: string; ended_at: string | null }
        | undefined;
      if (!row?.ended_at) return null;
      const m = (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 60000;
      return Number.isFinite(m) && m >= 0 ? Math.round(m * 10) / 10 : null;
    })(),
    repeatedCalls: [...byKey.values()]
      .filter((r) => r.times > 1)
      .sort((a, b) => b.times - a.times)
      .slice(0, 6),
    failedCalls: [...errors.values()]
      .sort((a, b) => b.times - a.times)
      .slice(0, 6),
    toolBreakdown: [...byTool.entries()]
      .map(([tool, c]) => ({ tool, calls: c }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10),
  };
}

/** Trace signals for an agent's most recent finished cycles, newest first. */
export function getRecentTraceSignals(
  agentId: string,
  limit = 3,
): CycleTraceSignals[] {
  const ids = db
    .prepare(
      `SELECT id FROM agent_cycles
      WHERE agent_id = ? AND status IN ('completed','failed')
      ORDER BY started_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Array<{ id: string }>;
  return ids
    .map((r) => getCycleTraceSignals(r.id))
    .filter((x): x is CycleTraceSignals => !!x);
}
