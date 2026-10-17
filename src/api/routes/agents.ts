/**
 * Agent API routes — Phase 2, Milestone 2.5
 * Full CRUD + lifecycle + onboarding chat for persistent agents.
 */
import { Router } from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  DATA_DIR,
  STAGING_DIR,
  planAgentLimit,
  hasActivePlan,
} from '../../config.js';
import {
  getMemoryByAgent,
  deleteAgentMemory,
  incrementMemoryUsed,
  getToolAnalytics,
  setAgentInterruptFlag,
  clearAgentInterruptFlag,
  getAgentInterruptFlag,
  getCheckinsByAgent,
  getPendingCheckins,
  getPendingCheckinByAgent,
  getCheckinById,
  createAgentCheckin,
  updateAgentCheckin,
  getCyclesByAgent,
  getCycleCostToday,
  getCompletedCycleCountsToday,
  getFileEventsByCycle,
  getHandoffsByAgent,
  getPendingHandoffsByAgent,
  getRecentHandoffs,
  getChatHistory,
  deleteMessagesByJid,
  deleteConversationEvents,
  getAgentInbox,
  getAgentOutbox,
  markAgentMessageRead,
  getSubAgents,
  createAgentMessage,
  getAgentProjects,
  getCompletedCycleCounts,
  getAgentCycleById,
  getCycleSteps,
  storeChatMetadata,
  storeMessageDirect,
  setAgentOwner,
  countUserAgents,
  getUserById,
  isAgentWhatsAppDmEnabled,
  setAgentWhatsAppDm,
  getAgentGroupBindings,
  addAgentGroupBinding,
  removeAgentGroupBinding,
  setAgentGroupBindingEnabled,
  getAgentWhatsAppDmBinding,
  getToolApproval,
  decideToolApproval,
  getAgentStarters,
  setAgentStarters,
  getAgentBusinessContext,
} from '../../db.js';
import type { HandoffStatus } from '../../db.js';
import { getHandoffById, getConversations } from '../../db.js';
import { batchCheckinRefusal } from '../../agents/batch-send-limit.js';
import { ownerCheckins } from '../../agents/batch-send-owner.js';
import { whatsAppSessions } from '../../channels/whatsapp-session.js';
import {
  ownershipParam,
  filterOwned,
  ownsResource,
} from '../middleware/ownership.js';
import { listTemplates, getTemplate } from '../../agents/agent-templates.js';
import { PROJECTS_DIR } from '../../config.js';
import { AgentWorkspaceManager } from '../../agents/agent-workspace.js';
import { guardFileResponse } from '../file-serving.js';
import { addSteer } from '../../agents/run-steering.js';
import { searchAgentMemoryRanked } from '../../agents/memory-retrieval.js';
import { agentService, agentScheduler } from '../../agents/agent-registry.js';
import {
  validateSchedule,
  normaliseSchedule,
  describeTimers,
  averageRunCost,
  previewInterval,
  isValidTimezone,
} from '../../agents/agent-scheduler.js';
import {
  validateRule,
  makeRule,
  APPROVAL_ACTIONS,
  type ApprovalRule,
} from '../../agents/approval-policy.js';
import { autoApproveIfRuled } from '../../agents/approval-apply.js';
import {
  isLiveClarifyAwaitingReply,
  respondToCheckin,
} from '../../agents/checkin-respond.js';
import { generateAgentStarters } from '../../agents/agent-service.js';
import { resolveInternalModel } from '../../services/model-router.js';
import { streamCycleSteps } from '../../cycle-activity-stream.js';
import { credentialManager } from '../../agents/credential-manager.js';
import {
  isServiceConnectedViaSecrets,
  requiredEnvNamesFor,
} from '../../agents/credential-catalog.js';
import { normaliseTrackerSchema } from '../../agents/agent-service.js';
import { upsertEntitySchema } from '../../db.js';
import {
  getConfigAudit,
  getConfigAuditById,
  recordConfigAudit,
  markAuditReverted,
} from '../../db.js';
import { auditSnapshot, REVERTABLE_CONFIG_KEYS } from './self-manage.js';
import {
  proposeTools,
  generateAgentTools,
  writeAgentEnv,
} from '../../agents/tool-generator.js';
import { sidecarRegistry } from '../../agents/agent-sidecar.js';
import {
  runFullTest,
  readLatestResult,
  readResultHistory,
  runStructuralCheck,
  runCustomCase,
} from '../../agents/agent-tester.js';
import { generateMissionTask } from '../../agents/tool-generator.js';
import { logger } from '../../logger.js';
import fs from 'fs';
import { spawn as spawnProcess } from 'child_process';
import { getSocketIO } from '../server.js';
import { readEnvFile } from '../../env.js';
import type { CreateAgentInput, CycleType, AgentConfig } from '../../types.js';
import {
  globalEventBus,
  type AgentEvent,
} from '../../agents/runtime/event-bus.js';
import {
  agentHandoffService,
  resolveHandoffTarget,
  createHandoffFromRequest,
} from '../../agents/agent-handoff.js';
import { recordMemory } from '../../agents/memory-service.js';
import { loadSkillsForChat } from '../../agents/runtime/tools/chat-tools.js';
import {
  authoredSkillDirs,
  readOrigins,
  readArchived,
  readLedger,
  readLedgerEntryContents,
  telemetryFor,
  summarise,
  type SkillTelemetry,
} from '../../agents/skill-inventory.js';
import { notify } from '../../notifications.js';
import {
  appendConversationEvent,
  appendChatMessageEvent,
} from '../../conversation-events.js';
import multer from 'multer';

// Phase A5 Task 1.2 — accept up to 20 reference files, 10 MB each, in memory.
// Small enough to fit comfortably; we write to disk synchronously after parsing.
// files:300 matches the largest per-route .array('references', N) declared below — a lower
// instance cap here would silently truncate those routes regardless of their own N. 300 is
// enough for a real source-tree upload (the dashboard filters node_modules/.git/build/etc.
// client-side first, so this ceiling covers genuine source files, not vendored/generated ones).
/**
 * Reject unsupported uploads while multer is still parsing, before their bytes land in
 * memory.
 *
 * This changes no security outcome. All three upload handlers already refuse anything
 * `refTypeForFilename` does not recognise, so an `.svg` or an `.exe` was never written
 * into a workspace by this route. What it changes is memory: with `memoryStorage` and
 * no filter, a client could push 300 x 10MB into RAM and have every byte rejected
 * afterwards. Each one is now dropped as it arrives.
 *
 * `cb(null, false)` rather than `cb(new Error(...))` on purpose. Erroring fails the
 * whole request, and uploading a folder that happens to contain one PNG currently
 * succeeds for every other file — turning that into a hard failure would be a real
 * regression in exchange for a resource fix. The dropped names are recorded on the
 * request so the handlers can still list them in `skipped`, which is the only way a
 * caller learns a file did not make it.
 */
export function rejectedUploads(req: unknown): string[] {
  return (req as { _rejectedUploads?: string[] })._rejectedUploads ?? [];
}

const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 300 },
  fileFilter: (req, file, cb) => {
    // `originalname` is all multer can see here. Two of the handlers prefer a
    // client-supplied relative path and re-check it — that remains the
    // authoritative gate; this is an early reject, never a replacement for it.
    if (refTypeForFilename(file.originalname)) return cb(null, true);
    const r = req as unknown as { _rejectedUploads?: string[] };
    (r._rejectedUploads ??= []).push(file.originalname);
    cb(null, false);
  },
});

/** Sanitize a workspace folder name. Phase A5 Task 1.5. */
function sanitiseWorkspaceDirName(raw: string): string | null {
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return null;
  if (!/^[a-z0-9_-]+$/.test(s)) return null;
  if (s.length > 40) return null;
  return s;
}

// Text-readable + structured-data file types an agent can use as a reference.
// (Binary types — images, archives, executables, media — are rejected; they'd
// corrupt as text and aren't readable by read_file. PDF is allowed — read_pdf handles it.)
const TEXT_REF_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'rst',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'swift',
  'scala',
  'lua',
  'r',
  'jl',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'sql',
  'graphql',
  'gql',
  'proto',
]);
const EXTLESS_REF_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'gitignore',
  'gitattributes',
  'editorconfig',
]);

/** Filename → reference type (the extension), or null if unsupported (binary). */
export function refTypeForFilename(name: string): string | null {
  const base = path.basename(name).toLowerCase();
  const ext = path.extname(base).replace('.', '');
  if (ext === 'pdf') return 'pdf';
  if (TEXT_REF_EXTS.has(ext)) return ext;
  if (!ext && EXTLESS_REF_NAMES.has(base)) return 'txt';
  return null;
}

/** Sanitise a (possibly folder-nested) reference path: keep the tree, scrub each
 *  segment, block traversal. Folder uploads send names like "docs/notes.md". */
export function sanitiseRefPath(raw: string): string | null {
  const parts = String(raw)
    .split(/[\\/]+/)
    .filter(Boolean);
  const clean: string[] = [];
  for (const p of parts) {
    if (p === '..' || p === '.') return null;
    const s = p.replace(/[^\w.\- ]/g, '_').slice(0, 120);
    if (!s) return null;
    clean.push(s);
  }
  if (clean.length === 0 || clean.length > 8) return null; // cap nesting depth
  return clean.join('/');
}

// ─── Chat provider types ──────────────────────────────────────────────────────

type ChatProvider = 'auto' | 'groq' | 'deepseek' | 'moonshot' | 'gemini';

interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Stream an OpenAI-compatible SSE response, writing chunks to res. Returns full text. */
async function streamOpenAIProvider(
  endpoint: string,
  apiKey: string,
  model: string,
  messages: LLMMessage[],
  maxTokens: number,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
      stream: true,
      temperature: 0.7,
    }),
  });
  if (!upstream.ok)
    throw new Error(`${endpoint} ${upstream.status}: ${await upstream.text()}`);

  let fullText = '';
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        const chunk: string = evt.choices?.[0]?.delta?.content ?? '';
        if (chunk) {
          fullText += chunk;
          onChunk(chunk);
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return fullText;
}

/** Stream a Gemini SSE response (different wire format). Returns full text. */
async function streamGeminiProvider(
  apiKey: string,
  systemPrompt: string,
  messages: LLMMessage[],
  maxTokens: number,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const userMessages = messages.filter((m) => m.role !== 'system');
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: userMessages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      }),
    },
  );
  if (!upstream.ok)
    throw new Error(`Gemini ${upstream.status}: ${await upstream.text()}`);

  let fullText = '';
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6).trim());
        const chunk: string =
          evt.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (chunk) {
          fullText += chunk;
          onChunk(chunk);
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return fullText;
}

/**
 * Stream a chat response.
 * provider = 'auto' (the default, used by onboarding/greeting) routes through the
 *   litellm proxy on the model-router-resolved model (Settings -> Models / the
 *   agent's own override) — same governance real cycles get, instead of a hardcoded
 *   literal. Falls back to the direct multi-provider waterfall (Groq -> DeepSeek ->
 *   Moonshot -> Gemini) only when the proxy isn't configured.
 * provider = a specific name forces that provider/model directly, bypassing the
 *   router — an explicit caller choice, not a silent default.
 */
async function streamAgentChat(
  provider: ChatProvider,
  systemPrompt: string,
  messages: LLMMessage[],
  maxTokens: number,
  onChunk: (chunk: string) => void,
  agentId?: string,
): Promise<string> {
  const withSystem: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  if (provider === 'auto') {
    const proxyUrl = process.env.LITELLM_PROXY_URL || '';
    const proxyKey = process.env.LITELLM_PROXY_KEY;
    if (proxyUrl && proxyKey) {
      const resolvedModel = resolveInternalModel(agentId, 'chat_onboarding');
      try {
        return await streamOpenAIProvider(
          `${proxyUrl}/v1/chat/completions`,
          proxyKey,
          resolvedModel,
          withSystem,
          maxTokens,
          onChunk,
        );
      } catch (err) {
        logger.warn(
          { err, resolvedModel },
          'streamAgentChat: litellm proxy call failed — falling back to direct-provider waterfall',
        );
        // fall through to the waterfall below
      }
    }
  }

  const env = readEnvFile([
    'GROQ_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_KIMI_API_KEY',
    'GEMINI_API_KEY',
  ]);
  const keys = {
    groq: process.env.GROQ_API_KEY || env['GROQ_API_KEY'] || '',
    deepseek: process.env.DEEPSEEK_API_KEY || env['DEEPSEEK_API_KEY'] || '',
    moonshot:
      process.env.MOONSHOT_KIMI_API_KEY || env['MOONSHOT_KIMI_API_KEY'] || '',
    gemini: process.env.GEMINI_API_KEY || env['GEMINI_API_KEY'] || '',
  };

  const tryGroq = async () => {
    if (!keys.groq) throw new Error('No GROQ_API_KEY');
    return streamOpenAIProvider(
      'https://api.groq.com/openai/v1/chat/completions',
      keys.groq,
      'llama-3.3-70b-versatile',
      withSystem,
      maxTokens,
      onChunk,
    );
  };
  const tryDeepSeek = async () => {
    if (!keys.deepseek) throw new Error('No DEEPSEEK_API_KEY');
    return streamOpenAIProvider(
      'https://api.deepseek.com/chat/completions',
      keys.deepseek,
      'deepseek-v4-flash',
      withSystem,
      maxTokens,
      onChunk,
    );
  };
  const tryMoonshot = async () => {
    if (!keys.moonshot) throw new Error('No MOONSHOT_KIMI_API_KEY');
    return streamOpenAIProvider(
      'https://api.moonshot.cn/v1/chat/completions',
      keys.moonshot,
      'moonshot-v1-8k',
      withSystem,
      maxTokens,
      onChunk,
    );
  };
  const tryGemini = async () => {
    if (!keys.gemini) throw new Error('No GEMINI_API_KEY');
    return streamGeminiProvider(
      keys.gemini,
      systemPrompt,
      messages,
      maxTokens,
      onChunk,
    );
  };

  if (provider === 'groq') return tryGroq();
  if (provider === 'deepseek') return tryDeepSeek();
  if (provider === 'moonshot') return tryMoonshot();
  if (provider === 'gemini') return tryGemini();

  // auto — waterfall
  for (const fn of [tryGroq, tryDeepSeek, tryMoonshot, tryGemini]) {
    try {
      return await fn();
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'No LLM provider available — set GROQ_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_KIMI_API_KEY, or GEMINI_API_KEY',
  );
}

// ─── Agentic Chat: Tool definitions ──────────────────────────────────────────

const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full content of a file from your workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file in your workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files in your workspace with sizes.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern across all workspace files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          extension: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description:
        'Read your persistent memory: MEMORY.md, HISTORY.md, and recent episode logs.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_memory',
      description: 'Add a fact or note to your persistent memory (MEMORY.md).',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_cycle',
      description: 'Trigger a new autonomous work cycle in the background.',
      parameters: {
        type: 'object',
        properties: {
          cycleType: {
            type: 'string',
            enum: ['custom', 'self_improve', 'checkin'],
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cycle_history',
      description: 'Get recent cycle history with summaries and costs.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_use',
      description:
        'Full browser automation — navigate, click, fill forms, extract content from web pages.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string' }, url: { type: 'string' } },
        required: ['action'],
      },
    },
  },
];

// ─── Agentic Chat: Context snapshot ──────────────────────────────────────────

function buildContextSnapshot(
  agentId: string,
  agentDir: string,
  agentStatus: string,
  dailyBudget: number,
): string {
  const lines: string[] = ['\n\n## Your Current State'];
  const workspaceDir = path.join(agentDir, 'workspace');

  try {
    const todayCost = getCycleCostToday(agentId);
    lines.push(
      `\nStatus: ${agentStatus} | Budget today: $${todayCost.toFixed(3)}${dailyBudget > 0 ? ` / $${dailyBudget} daily limit` : ''}`,
    );
  } catch {
    /* skip */
  }

  try {
    const SKIP_DIRS = new Set([
      '.nanocrew',
      'sessions',
      'logs',
      'memory',
      'tools',
      'inbox',
      'identity-history',
    ]);
    const SKIP_FILES = new Set([
      'config.json',
      'schema.md',
      'identity.md',
      'activity.json',
    ]);
    const SKIP_EXT = new Set(['.jsonl', '.pyc']);
    const fileList: string[] = [];
    if (fs.existsSync(workspaceDir)) {
      for (const entry of fs.readdirSync(workspaceDir)) {
        if (SKIP_DIRS.has(entry.toLowerCase())) continue;
        const fp = path.join(workspaceDir, entry);
        if (!fs.statSync(fp).isFile()) continue;
        if (
          SKIP_FILES.has(entry.toLowerCase()) ||
          SKIP_EXT.has(path.extname(entry).toLowerCase())
        )
          continue;
        fileList.push(
          `  - ${entry} (${(fs.statSync(fp).size / 1024).toFixed(1)}KB)`,
        );
      }
    }
    lines.push(
      `\nWorkspace files:\n${fileList.length > 0 ? fileList.join('\n') : '  (none yet — run a cycle to produce output)'}`,
    );
  } catch {
    /* skip */
  }

  try {
    const cycles = getCyclesByAgent(agentId, 5);
    if (cycles.length > 0) {
      lines.push('\nRecent cycles:');
      for (const c of cycles) {
        const when = c.ended_at
          ? new Date(c.ended_at).toLocaleString()
          : 'running';
        const cost =
          Number(c.cost) > 0 ? ` ($${Number(c.cost).toFixed(3)})` : '';
        lines.push(
          `  - [${c.status}] ${c.cycle_type} at ${when}${cost}${c.summary ? ': ' + c.summary.slice(0, 120) : ''}`,
        );
      }
    }
  } catch {
    /* skip */
  }

  try {
    const handoffs = getPendingHandoffsByAgent(agentId);
    if (handoffs.length > 0)
      lines.push(`\nPending handoffs: ${handoffs.length}`);
  } catch {
    /* skip */
  }

  // Append dynamic tool names so the LLM knows they exist
  try {
    const toolsDir = path.join(agentDir, 'tools');
    if (fs.existsSync(toolsDir)) {
      const dynNames = fs
        .readdirSync(toolsDir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replace('.js', ''));
      const dynPart = dynNames.length > 0 ? `, ${dynNames.join(', ')}` : '';
      lines.push(
        `\nYou have tools: read_file, write_file, list_files, search_memory, append_memory, run_cycle, get_cycle_history${dynPart}. Use them to take real action when asked.`,
      );
    } else {
      lines.push(
        '\nYou have tools: read_file, write_file, list_files, search_memory, append_memory, run_cycle, get_cycle_history. Use them to take real action when asked.',
      );
    }
  } catch {
    lines.push(
      '\nYou have tools: read_file, write_file, list_files, search_memory, append_memory, run_cycle, get_cycle_history. Use them to take real action when asked.',
    );
  }
  return lines.join('\n');
}

const AGENTS_DIR = path.join(DATA_DIR, 'agents');

const workspaceMgr = new AgentWorkspaceManager(AGENTS_DIR);

export const agentsRouter = Router();

// ─── Data isolation (Stage 28, Phase 5) ──────────────────────────────────────
// Any route with an :id param loads the agent and rejects (404) unless the caller
// owns it. This single guard protects every /api/agents/:id/* route at once.
agentsRouter.param(
  'id',
  ownershipParam((id) => agentService.getAgent(id), 'ownedAgent'),
);

// ─── Helper: emit socket event if connected ───────────────────────────────────

function emit(event: string, data: unknown) {
  getSocketIO()?.emit(event, data);
}

// ─── GET /api/agents — list all agents ───────────────────────────────────────

agentsRouter.get('/', (req, res) => {
  try {
    const agents = filterOwned(req, agentService.getAllAgents());
    const cycleCounts = getCompletedCycleCounts();
    const cycleCountsToday = getCompletedCycleCountsToday();
    res.json(
      agents.map((a) => {
        const next = agentScheduler.getNextCycle(a.id);
        return {
          ...a,
          cycles: cycleCounts.get(a.id) ?? 0,
          cyclesToday: cycleCountsToday.get(a.id) ?? 0,
          nextRunAt: next?.dueAt ? next.dueAt.toISOString() : null,
          // Live "working right now". `status: 'running'` only means the
          // agent is started, and stays true between scheduled cycles.
          isExecuting: agentService.isExecutingCycle(a.id),
        };
      }),
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Onboarding: agent templates (Stage 28 Topic 06) ──────────────────────────
// Registered BEFORE the /:id routes so 'templates'/'from-template' aren't treated
// as agent ids by the ownership param guard.

/** Post a proactive welcome message into a new agent's dashboard chat thread. */
function postAgentWelcome(
  agentId: string,
  agentName: string,
  welcome: string,
): void {
  const now = new Date().toISOString();
  const jid = `agent:${agentId}`;
  const id = `welcome_${agentId}`;
  try {
    storeChatMetadata(jid, now, agentName, 'dashboard', false);
    storeMessageDirect({
      id,
      chat_jid: jid,
      sender: agentName,
      sender_name: agentName,
      content: welcome,
      timestamp: now,
      is_from_me: false,
      is_bot_message: true,
    });
    appendChatMessageEvent(jid, {
      content: welcome,
      sender: agentName,
      source: 'dashboard',
      legacyMsgId: id,
    });
    emit('chat:message', {
      id,
      chatJid: jid,
      text: welcome,
      timestamp: now,
      sender: agentName,
    });
  } catch {
    /* greeting is best-effort */
  }
}

/** Plan agent-cap gate. Returns a friendly error string if the user is at their
 *  tier's agent limit, else null. Admins and unlimited (Business) tiers pass. */
function agentCapError(userId: string | undefined): string | null {
  if (!userId) return null;
  const user = getUserById(userId);
  if (!user || user.role === 'admin') return null;
  if (!hasActivePlan(user.plan))
    return 'Choose a plan to activate your crew before adding agents.';
  const limit = planAgentLimit(user.plan);
  if (countUserAgents(userId) >= limit) {
    return `You've reached your plan's limit of ${limit} agents. Upgrade to add more.`;
  }
  return null;
}

// GET /api/agents/templates — the hire-a-specialist picker
agentsRouter.get('/templates', (_req, res) => {
  res.json({ templates: listTemplates() });
});

// POST /api/agents/from-template { templateId } — two-click hire
agentsRouter.post('/from-template', async (req, res) => {
  try {
    const tpl = getTemplate(String(req.body?.templateId ?? ''));
    if (!tpl) return res.status(400).json({ error: 'Unknown template' });
    const capErr = agentCapError(req.user?.id);
    if (capErr) return res.status(403).json({ error: capErr });
    const agent = await agentService.createAgent({
      name: tpl.name,
      type: 'custom',
      emoji: tpl.emoji,
      config: { ...tpl.config },
    });
    if (req.user) setAgentOwner(agent.id, req.user.id);
    postAgentWelcome(agent.id, agent.name, tpl.welcome);
    emit('agent:created', {
      agentId: agent.id,
      name: agent.name,
      type: agent.type,
    });
    res.status(201).json(agent);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/activity — recent cycle events across all agents ─────────

agentsRouter.get('/activity', (req, res) => {
  try {
    const agents = filterOwned(req, agentService.getAllAgents());
    const allCycles = agents.flatMap((a) => agentService.getCycles(a.id, 10));
    // Sort by started_at desc, take latest 30
    allCycles.sort(
      (a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );
    res.json(allCycles.slice(0, 30));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/checkins/pending — the caller's pending check-ins ───────
//
// This path has no `:id`, so the router.param ownership guard never runs for it. It used
// to return getPendingCheckins() as-is — every account's pending approvals, report text
// and action payloads (email drafts included) — to any logged-in user, and the dashboard
// fetches it on load for the inbox badge. Found 2026-09-14; nothing was pending on any
// account at the time.

agentsRouter.get('/checkins/pending', (req, res) => {
  try {
    const mine = new Set(
      filterOwned(req, agentService.getAllAgents()).map((a) => a.id),
    );
    res.json(getPendingCheckins().filter((c) => mine.has(c.agent_id)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/conversations — exchanges between agents, grouped ────────
//
// Stage 56. Until replies existed there was nothing to group: a handoff went one way and
// nothing came back, so every "conversation" was one row. Now that a reply is a row in the
// same thread the data is a transcript, and reading it meant joining rows up by eye or
// trusting an agent's own summary of what it was told.
//
// Owner-scoped through the same `filterOwned` every other route here uses: you see threads
// among your own agents and nobody else's.

agentsRouter.get('/conversations', (req, res) => {
  try {
    const mine = filterOwned(req, agentService.getAllAgents()).map((a) => a.id);
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? '40'), 10) || 40, 1),
      200,
    );
    // `?agent=<id>` scopes to one agent's exchanges, for its own Manage tab. Still
    // intersected with what the caller owns, so the parameter narrows and never widens.
    const only = typeof req.query.agent === 'string' ? req.query.agent : null;
    const ids = only ? mine.filter((id) => id === only) : mine;
    res.json(getConversations(ids, limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/handoffs/recent — recent handoffs across all agents ──────

agentsRouter.get('/handoffs/recent', (_req, res) => {
  try {
    const limit = Number(_req.query.limit) || 20;
    res.json(getRecentHandoffs(limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/propose-tools — propose tools for a given mission ──────

agentsRouter.post('/propose-tools', async (req, res) => {
  try {
    const { mission, context } = req.body as {
      mission?: string;
      context?: string;
    };
    if (!mission?.trim()) {
      return res.status(400).json({ error: 'mission is required' });
    }
    const { tools, trackerSchema } = await proposeTools(
      mission.trim(),
      (context ?? '').trim(),
    );

    // Collect unique credential services and check connection status
    const allServices = new Set<string>();
    for (const tool of tools) {
      for (const svc of tool.requiredCredentials) {
        if (svc && svc !== 'none') allServices.add(svc);
      }
    }
    // Connected means "the agent will actually find this at runtime", which is not the
    // same as "an admin stored it in the credential store". The credentials API is
    // admin-only and platform-wide, so a customer's own connections live in secrets —
    // checking only credentialManager reports a working setup as missing. No agent
    // exists yet at propose time, so owner + platform scope is all there is to check.
    const ownerSecrets = secretsManager.getAll('', req.user?.id);
    const credentialStatus: Record<string, { connected: boolean }> = {};
    for (const svc of allServices) {
      credentialStatus[svc] = {
        connected:
          credentialManager.get(svc) !== null ||
          isServiceConnectedViaSecrets(svc, ownerSecrets),
      };
    }

    res.json({ tools, credentialStatus, trackerSchema });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Validate a schedule array. Returns an error string or null.
 *
 * Delegates to the scheduler's own validator so the check and the consumer can never
 * disagree. The previous implementation lived here and validated `entry.cron` — a key
 * nothing writes and `AgentScheduler.register()` never reads — while the field that
 * actually drives scheduling, `entry.interval`, went unchecked. See validateSchedule
 * in agent-scheduler.ts for what that cost.
 */
function validateScheduleCrons(schedule: any[]): string | null {
  return validateSchedule(schedule);
}

// ─── POST /api/agents — create a new agent ───────────────────────────────────

// ─── GET /api/tools/catalog — Phase A5 Task 1.3 ───────────────────────────
// Returns the canonical chat-side built-in tools so the dashboard can show
// users what an agent gets without an LLM proposal call. AI proposal stays
// as the escape hatch for novel tools (existing /api/agents/propose-tools).
agentsRouter.get('/tools/catalog', (_req, res) => {
  const catalog = [
    // Workspace file ops — present in every chat session, no config needed
    {
      id: 'read_file',
      category: 'workspace',
      source: 'builtin',
      alwaysOn: true,
      name: 'Read file',
      description: 'Read a file from the agent workspace.',
    },
    {
      id: 'write_file',
      category: 'workspace',
      source: 'builtin',
      alwaysOn: true,
      name: 'Write file',
      description: 'Create or overwrite a file in the agent workspace.',
    },
    {
      id: 'list_files',
      category: 'workspace',
      source: 'builtin',
      alwaysOn: true,
      name: 'List files',
      description: 'List files and folders under a workspace path.',
    },
    {
      id: 'search_files',
      category: 'workspace',
      source: 'builtin',
      alwaysOn: true,
      name: 'Search files',
      description: 'Search file contents across the agent workspace.',
    },
    {
      id: 'computer_use',
      category: 'workspace',
      source: 'builtin',
      alwaysOn: false,
      name: 'Computer use',
      description: 'Browse the web / use a virtual machine for visual tasks.',
    },
    // Memory + skills — Phase A1 + A2 unified store
    {
      id: 'search_memory',
      category: 'memory',
      source: 'builtin',
      alwaysOn: true,
      name: 'Search memory',
      description:
        'FTS5 search over the shared DB-backed memory store (chat + cycle share it).',
    },
    {
      id: 'append_memory',
      category: 'memory',
      source: 'builtin',
      alwaysOn: true,
      name: 'Append memory',
      description: 'Save a fact/note to the shared memory store.',
    },
    {
      id: 'save_skill',
      category: 'skills',
      source: 'builtin',
      alwaysOn: true,
      name: 'Save skill',
      description:
        'Persist a reusable SKILL.md to workspace/skills/ — usable by chat and cycles.',
    },
    // Orchestration — Phase A3
    {
      id: 'delegate_task',
      category: 'crew',
      source: 'builtin',
      alwaysOn: true,
      name: 'Delegate task',
      description:
        'Hand off a task to another agent in the crew (starts a custom cycle on them).',
    },
    {
      id: 'run_cycle',
      category: 'crew',
      source: 'builtin',
      alwaysOn: true,
      name: 'Run own cycle',
      description: 'Trigger a background work cycle on this same agent.',
    },
    {
      id: 'get_cycle_history',
      category: 'crew',
      source: 'builtin',
      alwaysOn: true,
      name: 'Get cycle history',
      description: 'See recent cycle summaries, costs, and outcomes.',
    },
  ];
  res.json({
    catalog,
    note: 'These tools are always available in chat. Use POST /api/agents/propose-tools for custom domain-specific tools.',
  });
});

agentsRouter.post(
  '/',
  referenceUpload.array('references', 20),
  async (req, res) => {
    try {
      // Phase A5 Task 1.2 — parse multipart-or-json
      let input: CreateAgentInput;
      const contentType = req.headers['content-type'] || '';
      const uploadedFiles =
        (req.files as Express.Multer.File[] | undefined) ?? [];

      if (contentType.includes('multipart/form-data')) {
        // multipart: payload JSON arrives as a string field
        const payloadStr = (req.body?.payload as string) ?? '{}';
        try {
          input = JSON.parse(payloadStr) as CreateAgentInput;
        } catch {
          return res
            .status(400)
            .json({ error: "Invalid 'payload' JSON in multipart request" });
        }
      } else {
        input = req.body;
      }

      if (!input.name || !input.type || !input.config) {
        return res
          .status(400)
          .json({ error: 'name, type, and config are required' });
      }

      // Phase A5 Task 1.4 — skip cron validation entirely for on_demand / event_driven agents
      const triggerMode = input.config.triggerMode ?? 'scheduled';
      if (
        triggerMode === 'scheduled' &&
        Array.isArray(input.config?.schedule)
      ) {
        const cronErr = validateScheduleCrons(input.config.schedule);
        if (cronErr) return res.status(422).json({ error: cronErr });
      }
      // Force empty schedule for non-scheduled modes so the scheduler doesn't fire stale entries
      if (triggerMode !== 'scheduled') {
        input.config.schedule = [];
      }

      const { daily, monthly } = input.config?.budget ?? {};
      if (daily !== undefined && (typeof daily !== 'number' || daily <= 0)) {
        return res
          .status(422)
          .json({ error: 'Daily budget must be greater than 0' });
      }
      if (
        monthly !== undefined &&
        (typeof monthly !== 'number' || monthly <= 0)
      ) {
        return res
          .status(422)
          .json({ error: 'Monthly budget must be greater than 0' });
      }

      // Phase A5 Task 1.5 — sanitise custom workspace dirs
      if (Array.isArray(input.config?.customWorkspaceDirs)) {
        const cleaned: Array<{ name: string; description?: string }> = [];
        for (const d of input.config.customWorkspaceDirs) {
          const safe = sanitiseWorkspaceDirName(d?.name ?? '');
          if (!safe) {
            return res.status(422).json({
              error: `Invalid workspace folder name: ${JSON.stringify(d?.name)}. Allowed: a-z 0-9 _ - (max 40 chars).`,
            });
          }
          cleaned.push({ name: safe, description: d.description });
        }
        input.config.customWorkspaceDirs = cleaned;
      }

      const capErr = agentCapError(req.user?.id);
      if (capErr) return res.status(403).json({ error: capErr });

      const proposedTools = input.proposedTools ?? [];
      const agent = await agentService.createAgent(input);
      // Stage 28 — the creating user owns the new agent.
      if (req.user) setAgentOwner(agent.id, req.user.id);
      // Stage 28 Topic 06 — proactive greeting so the new agent's chat isn't empty.
      {
        const role = agent.config?.role ? `, your ${agent.config.role}` : '';
        postAgentWelcome(
          agent.id,
          agent.name,
          `Hi 👋 I'm ${agent.name}${role}. Tell me what you need — or type 'help' to see what I can do.`,
        );
      }

      // Phase A5 Task 1.2 — persist uploaded reference files
      const refMetadata: NonNullable<AgentConfig['references']> = [];
      if (uploadedFiles.length > 0) {
        const refDir = path.join(AGENTS_DIR, agent.id, 'references');
        fs.mkdirSync(refDir, { recursive: true });
        for (const f of uploadedFiles) {
          const type = refTypeForFilename(f.originalname);
          if (!type) {
            logger.warn(
              { filename: f.originalname },
              'Skipping reference file — unsupported type',
            );
            continue;
          }
          // Sanitise filename to prevent path traversal
          const safeName = path
            .basename(f.originalname)
            .replace(/[^\w.\- ]/g, '_')
            .slice(0, 120);
          const destPath = path.join(refDir, safeName);
          fs.writeFileSync(destPath, f.buffer);
          refMetadata.push({
            filename: safeName,
            type,
            size: f.size,
            addedAt: new Date().toISOString(),
          });
        }
        // Persist reference metadata back to the agent's config
        if (refMetadata.length > 0) {
          const refreshed = agentService.getAgent(agent.id);
          if (refreshed) {
            refreshed.config.references = refMetadata;
            agentService.updateAgent(agent.id, { config: refreshed.config });
          }
        }
      }

      emit('agent:created', {
        agentId: agent.id,
        name: agent.name,
        type: agent.type,
      });
      res.status(201).json(agent);

      // Generate tool files in the background — agent is already created and returned.
      // agent-env.json written synchronously first so sidecar can read it immediately.
      if (proposedTools.length > 0) {
        writeAgentEnv(agent.id, AGENTS_DIR, proposedTools);
        const agentForTest = agent;
        generateAgentTools(agent.id, AGENTS_DIR, proposedTools)
          .then(async () => {
            // Generate mission-task.json, then run the full test suite
            try {
              const task = await generateMissionTask(
                agentForTest.config.goals ?? '',
                agentForTest.config.goals ?? '',
                proposedTools,
                agentForTest.id,
              );
              const resultsDir = path.join(
                AGENTS_DIR,
                agentForTest.id,
                'test-results',
              );
              fs.mkdirSync(resultsDir, { recursive: true });
              fs.writeFileSync(
                path.join(resultsDir, 'mission-task.json'),
                JSON.stringify(task, null, 2),
                'utf-8',
              );
            } catch (err) {
              logger.warn(
                { agentId: agentForTest.id, err },
                'Mission task generation failed',
              );
            }
            const hasEnabledSchedule =
              agentForTest.config.schedule?.some((s) => s.enabled) ?? false;
            if (hasEnabledSchedule) {
              runFullTest(
                agentForTest.id,
                AGENTS_DIR,
                'agent_created',
                (id, cycleType, context) =>
                  agentService.runCycle(id, cycleType, context),
              ).catch((err) =>
                logger.warn(
                  { agentId: agentForTest.id, err },
                  'Creation test run failed',
                ),
              );
            }
          })
          .catch((err) => {
            logger.error(
              { agentId: agent.id, err },
              'Background tool generation failed',
            );
          });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── GET /api/agents/:id ──────────────────────────────────────────────────────

agentsRouter.get('/:id', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/starters — three concrete jobs to open a chat with ───
//
// Generated on first request rather than at hire time, deliberately: the model
// call takes seconds, and hiring is the moment that most needs to feel instant.
// The chat page asks for these after it has already rendered, so the wait is
// invisible. Cached on the agent afterwards, so this costs one call ever.
//
// Failure is silent by design — no suggestions simply means no chips, which is
// the behaviour before this existed. It must never break opening a chat.
agentsRouter.get('/:id/starters', async (req, res) => {
  try {
    const cached = getAgentStarters(req.params.id);
    if (cached.length > 0) return res.json({ starters: cached });

    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const starters = await generateAgentStarters(
      agent.name,
      agent.type.replace(/_/g, ' '),
      agent.config?.goals ?? '',
      getAgentBusinessContext(agent.id),
      agent.id,
    );
    if (starters.length > 0) setAgentStarters(agent.id, starters);
    res.json({ starters });
  } catch (err: any) {
    logger.warn(
      { agentId: req.params.id, err: err.message },
      'Starters unavailable',
    );
    res.json({ starters: [] });
  }
});

// ─── GET /api/agents/:id/audit — "does this agent have what it was promised?" ─
// Ownership is enforced by the router.param('id') guard above. Re-runnable any time,
// not just at creation — pinned files can be deleted later, credentials can be
// disconnected. See AgentService.auditAgent for exactly what's checked.
agentsRouter.get('/:id/audit', (req, res) => {
  try {
    res.json(agentService.auditAgent(req.params.id));
  } catch (err: any) {
    res
      .status(err.message?.includes('not found') ? 404 : 500)
      .json({ error: err.message });
  }
});

// ─── Stage 30 Phase 2 — per-agent channel bindings (WhatsApp reachability) ────
// Ownership is enforced by the router.param('id') guard above.

agentsRouter.get('/:id/channels', async (req, res) => {
  try {
    const agentId = req.params.id;
    const ownerId = req.user!.id;
    const wa = whatsAppSessions.status(ownerId);
    const dbBindings = getAgentGroupBindings(agentId);

    let activeGroups: any[] = [];
    if (wa.state === 'connected') {
      try {
        const fetched = await whatsAppSessions.getGroups(ownerId);
        activeGroups = dbBindings.map((b) => {
          const match = fetched.find((f) => f.jid === b.target_jid);
          return {
            id: b.id,
            jid: b.target_jid,
            name: match ? match.name : b.target_jid || 'Unknown Group',
            enabled: b.enabled,
            triggerMode: b.trigger_mode,
          };
        });
      } catch (e) {
        activeGroups = dbBindings.map((b) => ({
          id: b.id,
          jid: b.target_jid,
          name: b.target_jid || 'Unknown Group',
          enabled: b.enabled,
          triggerMode: b.trigger_mode,
        }));
      }
    } else {
      activeGroups = dbBindings.map((b) => ({
        id: b.id,
        jid: b.target_jid,
        name: b.target_jid || 'Unknown Group',
        enabled: b.enabled,
        triggerMode: b.trigger_mode,
      }));
    }

    res.json({
      whatsapp: {
        state: wa.state,
        connected: wa.state === 'connected',
        number: wa.number,
        dmEnabled: isAgentWhatsAppDmEnabled(agentId),
        dmTriggerMode:
          getAgentWhatsAppDmBinding(agentId)?.trigger_mode || 'mention',
        groups: activeGroups,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.put('/:id/channels/whatsapp', (req, res) => {
  try {
    const { enabled, triggerMode } = req.body as {
      enabled?: boolean;
      triggerMode?: 'mention' | 'all';
    };
    if (typeof enabled !== 'boolean')
      return res.status(400).json({ error: 'enabled (boolean) required' });
    setAgentWhatsAppDm(req.user!.id, req.params.id, enabled, triggerMode);
    res.json({ ok: true, dmEnabled: enabled, dmTriggerMode: triggerMode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/channels/whatsapp/groups', async (req, res) => {
  try {
    const ownerId = req.user!.id;
    const groups = await whatsAppSessions.getGroups(ownerId);
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.post('/:id/channels/whatsapp/groups', (req, res) => {
  try {
    const { groupJid } = req.body as { groupJid?: string };
    if (!groupJid) return res.status(400).json({ error: 'groupJid required' });
    addAgentGroupBinding(req.user!.id, req.params.id, groupJid);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.put('/:id/channels/whatsapp/groups/:jid', (req, res) => {
  try {
    const { enabled, triggerMode } = req.body as {
      enabled?: boolean;
      triggerMode?: 'mention' | 'all';
    };
    if (typeof enabled !== 'boolean')
      return res.status(400).json({ error: 'enabled (boolean) required' });
    setAgentGroupBindingEnabled(
      req.params.id,
      req.params.jid,
      enabled,
      triggerMode,
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.delete('/:id/channels/whatsapp/groups/:jid', (req, res) => {
  try {
    removeAgentGroupBinding(req.params.id, req.params.jid);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/agents/:id — update name/emoji/config ────────────────────────

agentsRouter.patch('/:id', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { name, emoji, config, whatsapp_jid, trackerSchema } = req.body as {
      name?: string;
      emoji?: string;
      config?: AgentConfig;
      whatsapp_jid?: string | null;
      trackerSchema?: unknown;
    };

    // A tracker could only ever be set at creation, so adding a stage to a live agent
    // meant editing entity_schemas by hand. Same gap the Recruiter had — the capability
    // existed and nothing could reach it after the agent existed.
    if (trackerSchema !== undefined) {
      const normalised = normaliseTrackerSchema(trackerSchema);
      if (!normalised)
        return res.status(422).json({
          error:
            'trackerSchema needs a name plus at least one stage and one field',
        });
      upsertEntitySchema(req.params.id, normalised);
    }
    if (config !== undefined && Array.isArray(config.schedule)) {
      const cronErr = validateScheduleCrons(config.schedule);
      if (cronErr) return res.status(422).json({ error: cronErr });
      config.schedule = normaliseSchedule(config.schedule);
    }
    const updates: Partial<{
      name: string;
      emoji: string;
      config: AgentConfig;
      whatsapp_jid: string | null;
    }> = {};
    if (name !== undefined) updates.name = name;
    if (emoji !== undefined) updates.emoji = emoji;
    if (config !== undefined) updates.config = config;
    if ('whatsapp_jid' in req.body) updates.whatsapp_jid = whatsapp_jid ?? null;

    // Snapshot every capability the owner could be touching, so their edits land in the
    // same history as the agent's own. A timeline that shows only what the agent
    // changed is a timeline that lies by omission the first time the two disagree.
    const auditCaps = ['schedule', 'model', 'budget', 'approvals'] as const;
    const auditBefore = Object.fromEntries(
      auditCaps.map((c) => [c, auditSnapshot(req.params.id, c)]),
    );

    const updated = await agentService.updateAgent(req.params.id, updates);

    for (const cap of auditCaps) {
      recordConfigAudit({
        agentId: req.params.id,
        capability: cap,
        actor: req.user?.role === 'admin' ? 'admin' : 'owner',
        before: auditBefore[cap],
        after: auditSnapshot(req.params.id, cap),
        reason: 'Edited from the dashboard',
      });
    }

    // If the schedule changed, sync the in-memory scheduler with the new config.
    // Without this, the old schedule keeps firing even after the user disables it.
    if (
      config !== undefined &&
      (Array.isArray(config.schedule) || config.triggerMode !== undefined)
    ) {
      // From the SAVED config, not the request body: the page now sends only the keys
      // it changed, so the body can lack triggerMode (or the schedule) and registering
      // from it would arm an on-demand agent's whole schedule.
      const hasEnabledEntry = (updated.config.schedule ?? []).some(
        (s: { enabled?: boolean; interval?: string }) =>
          s.enabled && s.interval && s.interval.toLowerCase() !== 'manual',
      );
      if (hasEnabledEntry) {
        try {
          agentScheduler.register(req.params.id, updated.config);
        } catch (e: any) {
          logger.warn(
            { agentId: req.params.id, err: e?.message },
            'Schedule re-register failed',
          );
        }
      } else {
        agentScheduler.unregister(req.params.id);
      }
    }

    emit('agent:updated', { agentId: req.params.id });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/agents/:id ───────────────────────────────────────────────────

agentsRouter.delete('/:id', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Stage 28 — protected agents (e.g. the Recruiter) are account infrastructure and
    // cannot be fired; without the Recruiter the account couldn't hire anyone.
    if ((agent.config as any)?.protected) {
      return res.status(403).json({
        error: `${agent.name} is a built-in agent and can't be removed.`,
      });
    }
    await sidecarRegistry.teardown(req.params.id);
    await agentService.deleteAgent(req.params.id);
    emit('agent:deleted', { agentId: req.params.id });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/start ───────────────────────────────────────────────

agentsRouter.post('/:id/start', async (req, res) => {
  try {
    await agentService.startAgent(req.params.id);
    const agent = agentService.getAgent(req.params.id)!;
    agentScheduler.register(agent.id, agent.config);
    emit('agent:status_changed', {
      agentId: req.params.id,
      status: agent.status,
    });
    res.json({ status: agent.status });
  } catch (err: any) {
    if (err.message.includes('not found'))
      return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/pause ───────────────────────────────────────────────

agentsRouter.post('/:id/pause', async (req, res) => {
  try {
    await agentService.pauseAgent(req.params.id);
    const agent = agentService.getAgent(req.params.id)!;
    emit('agent:status_changed', {
      agentId: req.params.id,
      status: agent.status,
    });
    res.json({ status: agent.status });
  } catch (err: any) {
    if (err.message.includes('not found'))
      return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/stop ────────────────────────────────────────────────

agentsRouter.post('/:id/stop', async (req, res) => {
  try {
    await agentService.stopAgent(req.params.id);
    const agent = agentService.getAgent(req.params.id)!;
    emit('agent:status_changed', {
      agentId: req.params.id,
      status: agent.status,
    });
    res.json({ status: agent.status });
  } catch (err: any) {
    if (err.message.includes('not found'))
      return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/interrupt — soft interrupt (polled by NanoBot) ────
// ─── GET  /api/agents/:id/interrupt-flag — NanoBot polls this each iteration ─

agentsRouter.post('/:id/interrupt', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.status !== 'running')
      return res.status(400).json({ error: 'Agent not running' });
    setAgentInterruptFlag(req.params.id);
    emit('agent:interrupt_requested', { agentId: req.params.id });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/interrupt-flag', (req, res) => {
  try {
    res.json({ interrupted: getAgentInterruptFlag(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/chat/history — load persisted chat history ──────────

// ─── GET /api/agents/:id/tools/platform — actual platform tool list ───────────

agentsRouter.get('/:id/tools/platform', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const tools = CHAT_TOOLS.map((t) => ({
      id: t.function.name,
      name: t.function.name,
      label: t.function.name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      description: t.function.description,
      isGlobal: true,
    }));
    res.json({ tools });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/tools/inventory — full tool catalog across all surfaces ──

agentsRouter.get('/:id/tools/inventory', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { getAgentToolInventory } =
      await import('../../agents/tool-catalog.js');
    const inventory = getAgentToolInventory(req.params.id);

    // Which of this agent's tools can actually authenticate. Resolved from the same
    // merged env the container receives (platform → owner → agent), so it reflects
    // runtime reality rather than only what an admin put in the credential store.
    // Previously the dashboard hardcoded "all required credentials are connected",
    // which was true by assertion and unrelated to whether anything was configured.
    const env = secretsManager.getAll(
      req.params.id,
      agent.owner_id ?? undefined,
    );
    const services = new Set<string>();
    for (const t of [...inventory.cycle, ...inventory.dynamic]) {
      for (const s of t.requiresCredential ?? []) services.add(s);
    }

    const credentialStatus: Record<
      string,
      { connected: boolean; missing: string[] }
    > = {};
    for (const svc of services) {
      const connected =
        credentialManager.get(svc) !== null ||
        isServiceConnectedViaSecrets(svc, env);
      credentialStatus[svc] = {
        connected,
        missing: connected
          ? []
          : requiredEnvNamesFor(svc).filter((n) => !env[n]),
      };
    }

    res.json({ ...inventory, credentialStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/chat/history', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const limit = parseInt((req.query.limit as string) || '60', 10);
    const raw = getChatHistory(`agent:${req.params.id}`, '');
    const messages = raw.slice(-limit).map((m) => ({
      id: m.id,
      agent_id: req.params.id,
      role: m.is_from_me ? 'user' : 'assistant',
      content: m.content,
      created_at: m.timestamp,
      source: m.source,
    }));
    res.json({ messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/agents/:id/chat/history — clear chat history ────────────────

agentsRouter.delete('/:id/chat/history', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Both stores key on the same conversation id — clear both or the
    // conversation_events log (what the UI renders by default) survives.
    deleteMessagesByJid(`agent:${req.params.id}`);
    deleteConversationEvents(`agent:${req.params.id}`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/chat — chat with the agent ─────────────────────────
// mode: 'onboard' — onboarding flow
// mode: 'chat'    — persistent conversation (history loaded from DB, streamed response)

/**
 * Record a /:id/chat failure into the conversation log (Stage 35).
 *
 * This endpoint is the one producer that never persisted anything: replies go out
 * over SSE only (by design — it serves onboarding/greetings, which are deliberately
 * ephemeral and are not part of `messages` history), and errors did too. That made
 * its failures strictly worse than a cycle's: they existed only in the open
 * response stream, so a reload erased them and the thread showed the last
 * successful reply as if nothing had happened.
 *
 * The reply-persistence asymmetry stays for now — unifying greetings into the
 * stream belongs to the read-path switch, not here. The failure is what has to be
 * durable, because a failure the user can't see is the bug this stage exists to kill.
 */
function recordChatError(conversation: string, message: string): void {
  appendConversationEvent(conversation, {
    type: 'error',
    role: 'assistant',
    status: 'error',
    content: `⚠️ Chat failed: ${message}`,
    metadata: JSON.stringify({ source: 'chat_sse' }),
  });
}

agentsRouter.post('/:id/chat', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const {
      message,
      mode = 'chat',
      model: modelPref = 'auto',
      chatJid,
      skipMcp,
    } = req.body as {
      message: string;
      mode?: 'onboard' | 'chat';
      model?: ChatProvider;
      // Stage 20 gap A — when set (e.g. "agent:<id>"), this conversation is the
      // unified `messages` thread. Read history from / persist to that table
      // instead of the legacy agent_chat_messages, killing the split-brain.
      chatJid?: string;
      // Stage 20 gap J — skip MCP loading for fast conversational replies.
      skipMcp?: boolean;
    };

    const agentDir = path.join(AGENTS_DIR, agent.id);
    const isGreeting = message === '__chat_open__';
    const isOnboard = mode === 'onboard';

    // Read IDENTITY.md
    let identityMd = `You are ${agent.name}, a specialized AI agent. Your goals: ${agent.config.goals || 'help the user'}. Stay in character at all times.`;
    try {
      identityMd = fs.readFileSync(path.join(agentDir, 'IDENTITY.md'), 'utf-8');
    } catch {
      /* use default */
    }

    // SSE headers first so greetings and errors both stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (payload: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify(payload)}\n\n`);

    // ── Onboarding mode: simple streaming, no tools ───────────────────────
    if (isOnboard || isGreeting) {
      const onboardPrompt = isOnboard
        ? identityMd +
          '\n\nYou are being onboarded by your manager. Ask 2-3 brief clarifying questions about your mission, then confirm you are ready to start.'
        : identityMd +
          '\n\nGreet your manager in one sentence, in character. Reference your role and current mission.';
      const effectiveMsg = isGreeting ? '__greet__' : message;
      const apiMsgs: LLMMessage[] = [
        {
          role: 'user',
          content: isGreeting
            ? 'Greet your manager briefly — one sentence, in character.'
            : effectiveMsg,
        },
      ];
      let fullText = '';
      try {
        fullText = await streamAgentChat(
          modelPref as ChatProvider,
          onboardPrompt,
          apiMsgs,
          isGreeting ? 80 : 800,
          (chunk) => send({ chunk }),
          agent.id,
        );
      } catch (err: any) {
        recordChatError(
          chatJid ?? `agent:${agent.id}`,
          err?.message ?? 'LLM error',
        );
        send({ error: err.message });
      }
      send({ done: true, reply: fullText });
      return res.end();
    }

    // ── Chat mode: full agentic loop ──────────────────────────────────────

    // Build rich context snapshot
    const contextSnapshot = buildContextSnapshot(
      agent.id,
      agentDir,
      agent.status,
      agent.config.budget?.daily ?? 0,
    );

    // Read memory content upfront so it leads the system prompt — LLMs anchor on early tokens
    let memoryPreamble = '';
    try {
      const memPath = path.join(agentDir, 'memory', 'MEMORY.md');
      if (fs.existsSync(memPath)) {
        const mc = fs.readFileSync(memPath, 'utf-8').trim();
        if (mc)
          memoryPreamble = `CRITICAL FACTS FROM YOUR MEMORY (these are ground truth — always prefer over training data):\n${mc}\n\n`;
      }
    } catch {
      /* non-fatal */
    }

    // Load any skills the agent has previously authored (Phase A2 — same store as cycle's nanobot save_skill)
    const skillsBlock = (() => {
      try {
        return loadSkillsForChat(path.join(agentDir, 'workspace'));
      } catch {
        return '';
      }
    })();

    const systemPrompt =
      memoryPreamble +
      identityMd +
      contextSnapshot +
      skillsBlock +
      '\n\nYou are in a direct conversation with your manager via the dashboard. ' +
      'You have full access to your workspace, memory, and can trigger cycles. ' +
      'Use your tools proactively — if asked about a file, read it. If asked to write something, write it. ' +
      'Be concise and action-oriented. Always confirm what you actually did, not just what you plan to do.';

    // Load DB history (last ~20 turns). Always read from the unified `messages` thread.
    const historyJid = chatJid ?? `agent:${agent.id}`;
    const unified = getChatHistory(historyJid, '')
      .map((m) => ({
        role: (m.is_from_me ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }))
      .filter((m) => m.content && m.content.trim())
      .slice(-21);
    // Ensure the current user message is present exactly once as the final user turn.
    const last = unified[unified.length - 1];
    if (!last || last.role !== 'user' || last.content !== message) {
      unified.push({ role: 'user', content: message });
    }
    const allMsgs = unified;

    let fullText = '';
    try {
      // The tooled in-process "light" runtime (AgentRuntime) was removed — without
      // real grounding tools it confabulated. This endpoint now serves onboarding
      // and basic streamed replies only; all real work runs as a grounded nanobot
      // cycle (agentService.runCycle) via the dashboard channel.
      fullText = await streamAgentChat(
        modelPref as ChatProvider,
        systemPrompt,
        allMsgs as LLMMessage[],
        1500,
        (chunk) => send({ chunk }),
        agent.id,
      );
    } catch (err: any) {
      // Stage 35: this failure used to exist only in the SSE stream — nothing was
      // written anywhere, so reloading the page made it vanish and the thread
      // showed the previous reply as though nothing had gone wrong. Record it.
      recordChatError(historyJid, err?.message ?? 'LLM error');
      send({ error: err.message ?? 'LLM error' });
      send({ done: true, reply: '' });
      return res.end();
    }

    send({ done: true, reply: fullText });
    res.end();
  } catch (err: any) {
    recordChatError(`agent:${req.params.id}`, err?.message ?? 'Chat failed');
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── GET /api/agents/:id/cycle/stream — persistent SSE subscription ──────────
// Subscribe once; events arrive whenever any cycle runs for this agent.
// This lets a dashboard open the stream before triggering a cycle via a
// separate POST call (e.g. from the UI or a scheduler).

agentsRouter.get('/:id/cycle/stream', (req, res) => {
  const agentId = req.params.id;
  const agent = agentService.getAgent(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const handler = (event: AgentEvent) => {
    switch (event.type) {
      case 'run_start':
        if (event.agentId !== agentId) return;
        send({ type: 'run_start', runId: event.runId });
        break;
      case 'llm_chunk':
        send({ type: 'chunk', text: event.text });
        break;
      case 'tool_start':
        send({
          type: 'tool_start',
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case 'tool_end':
        send({
          type: 'tool_end',
          toolName: event.toolName,
          result: event.result,
        });
        break;
      case 'run_end':
        send({
          type: 'run_end',
          totalTokens: event.totalTokens,
          cost: event.cost,
          durationMs: event.durationMs,
        });
        break;
      case 'run_error':
        send({ type: 'error', error: event.error });
        break;
      case 'cycle_progress':
        if (event.agentId !== agentId) return;
        send({
          type: 'cycle_progress',
          runId: event.runId,
          event: event.event,
        });
        break;
      case 'notification':
        if (event.agentId !== agentId) return;
        send({
          type: 'notification',
          message: event.message,
          urgency: event.urgency,
          timestamp: event.timestamp,
        });
        break;
    }
  };

  globalEventBus.on_agent(handler);
  send({ type: 'connected', agentId });

  req.on('close', () => {
    globalEventBus.removeListener('agent_event', handler);
  });
});

// ─── POST /api/agents/:id/cycle — trigger a cycle with live SSE streaming ────

agentsRouter.post('/:id/cycle', async (req, res) => {
  const agentId = req.params.id;
  const agent = agentService.getAgent(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const cycleType: CycleType = req.body.cycleType ?? 'custom';
  const projectId: string | undefined = req.body.projectId;
  const instruction: string | undefined = req.body.instruction;

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // Subscribe to runtime events for this agent
  const handler = (event: AgentEvent) => {
    switch (event.type) {
      case 'run_start':
        if (event.agentId !== agentId) return;
        send({ type: 'run_start', runId: event.runId });
        break;
      case 'llm_chunk':
        send({ type: 'chunk', text: event.text });
        break;
      case 'tool_start':
        send({
          type: 'tool_start',
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case 'tool_end':
        send({
          type: 'tool_end',
          toolName: event.toolName,
          result: event.result,
        });
        break;
      case 'run_end':
        send({
          type: 'run_end',
          totalTokens: event.totalTokens,
          cost: event.cost,
          durationMs: event.durationMs,
        });
        break;
      case 'run_error':
        send({ type: 'error', error: event.error });
        break;
      case 'cycle_progress':
        if (event.agentId !== agentId) return;
        send({
          type: 'cycle_progress',
          runId: event.runId,
          event: event.event,
        });
        break;
      case 'notification':
        if (event.agentId !== agentId) return;
        send({
          type: 'notification',
          message: event.message,
          urgency: event.urgency,
          timestamp: event.timestamp,
        });
        break;
    }
  };

  globalEventBus.on_agent(handler);

  try {
    // Persist the user's request into the UNIFIED chat thread (the one the chat
    // UI reads) BEFORE running, so the request→response pair shows regardless of
    // trigger source. The cycle RESULT is already posted to this thread by
    // runCycle's _emitCycleChat, so we no longer write the assistant side here
    // (that used the legacy agent_chat_messages table the chat UI doesn't read).
    const trigger = instruction?.trim();
    if (trigger) {
      try {
        const jid = `agent:${agentId}`;
        const ts = new Date().toISOString();
        const uid = `user-${randomUUID()}`;
        storeChatMetadata(
          jid,
          ts,
          agent.name ?? 'Agent Chat',
          'dashboard',
          false,
        );
        storeMessageDirect({
          id: uid,
          chat_jid: jid,
          sender: 'User',
          sender_name: 'User',
          content: trigger,
          timestamp: ts,
          is_from_me: true,
        });
        appendChatMessageEvent(jid, {
          content: trigger,
          fromUser: true,
          source: 'dashboard',
          legacyMsgId: uid,
        });
        getSocketIO()?.emit('chat:message', {
          id: uid,
          chatJid: jid,
          text: trigger,
          timestamp: ts,
          sender: 'User',
          fromUser: true,
        });
      } catch {
        /* non-fatal — request still runs, just won't show the prompt */
      }
    }

    emit('agent:cycle_started', { agentId, cycleType });
    // A person clicked Run now, so the what/when gates in the source tools yield to them.
    const cycle = await agentService.runCycle(
      agentId,
      cycleType,
      instruction,
      projectId,
      undefined,
      undefined,
      { humanRequested: true },
    );
    emit('agent:cycle_completed', {
      agentId,
      cycleId: cycle.id,
      summary: cycle.summary,
      cost: cycle.cost,
    });

    send({ type: 'done', cycle });
  } catch (err: any) {
    send({ type: 'error', error: err.message });
  } finally {
    globalEventBus.removeListener('agent_event', handler);
    res.end();
  }
});

// ─── GET /api/agents/:id/cycles — cycle history ───────────────────────────────

agentsRouter.get('/:id/cycles', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const limit = parseInt((req.query.limit as string) ?? '50', 10);
    res.json(agentService.getCycles(req.params.id, limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/activity-trace — last cycle's full step trace ──────────

agentsRouter.get('/:id/activity-trace', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const tracePath = path.join(AGENTS_DIR, req.params.id, 'activity.json');
    if (!fs.existsSync(tracePath)) return res.json({ steps: [] });
    const raw = fs.readFileSync(tracePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/cycles/:cycleId/activity-trace — per-cycle trace ────
// Three cases:
//   1. Per-cycle snapshot exists  → return it (accurate)
//   2. Cycle still running       → live activity.json IS this cycle's data, no warning
//   3. Cycle finished, no snapshot → legacy fallback (Python overwrites activity.json
//                                    on the next run, so the trace may belong to a later cycle)

agentsRouter.get('/:id/cycles/:cycleId/activity-trace', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // 1. Durable per-cycle steps in the DB (the source of truth for finished
    //    cycles — keyed by cycle_id, never overwritten by a later cycle).
    const dbSteps = getCycleSteps(req.params.cycleId);
    if (dbSteps.length) return res.json({ steps: dbSteps });

    // 2. Legacy: a per-cycle file snapshot from before the DB migration.
    const perCyclePath = path.join(
      AGENTS_DIR,
      req.params.id,
      'cycles',
      `${req.params.cycleId}.activity.json`,
    );
    if (fs.existsSync(perCyclePath)) {
      const raw = fs.readFileSync(perCyclePath, 'utf-8');
      return res.json(JSON.parse(raw));
    }
    // Determine if the cycle is still running — if so, the live trace IS its data
    const cycle = getAgentCycleById(req.params.cycleId);
    const isRunning = cycle?.status === 'running';

    const latestPath = path.join(AGENTS_DIR, req.params.id, 'activity.json');
    if (!fs.existsSync(latestPath))
      return res.json({ steps: [], _legacy: !isRunning });
    const raw = fs.readFileSync(latestPath, 'utf-8');
    const data = JSON.parse(raw);
    // Only mark legacy when the cycle has finished — for in-progress cycles, the
    // live activity.json is the authoritative trace of this cycle.
    res.json({ ...data, _legacy: !isRunning });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/cycles/:cycleId/steps — push activity (Phase 2) ───────
// The nanobot adapter posts a *window* of the current activity-steps array as the
// cycle runs (recent steps only, not the full cumulative history — see startSeq
// below) — we persist it (durable) and stream the delta to the chat in real time.
// Body: { startSeq?: number, steps: [...] }. startSeq is the real sequence number
// steps[0] corresponds to (0 if omitted, for older adapter images that still send
// the full array from the beginning).

agentsRouter.post('/:id/cycles/:cycleId/steps', (req, res) => {
  try {
    const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    const startSeq = Number.isInteger(req.body?.startSeq)
      ? req.body.startSeq
      : 0;
    streamCycleSteps(req.params.id, req.params.cycleId, steps, startSeq);
    res.json({ ok: true, received: steps.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/staging — stage files for a pending action (agent creation) ──
// Files attached to an approval card upload here first (any size, on disk), returning
// a token. The approval payload carries that token; on approve the files materialize
// into the new agent's references/ (atomic, durable, size-safe). Abandoned stagings
// are swept by TTL. This is the bridge for seeding a not-yet-created agent.
agentsRouter.post(
  '/staging',
  referenceUpload.array('references', 300),
  (req, res) => {
    try {
      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0)
        return res.status(400).json({ error: 'No files provided' });
      let relPaths: string[] = [];
      try {
        relPaths = JSON.parse(String(req.body?.paths ?? '[]'));
      } catch {
        /* fall back to originalname */
      }

      // Re-attach appends to the same staging dir (one token per approval card).
      const existingToken = String(req.body?.token ?? '').replace(
        /[^a-f0-9-]/gi,
        '',
      );
      const token =
        existingToken && fs.existsSync(path.join(STAGING_DIR, existingToken))
          ? existingToken
          : randomUUID();
      const dir = path.join(STAGING_DIR, token);
      fs.mkdirSync(dir, { recursive: true });
      const files: Array<{ filename: string; type: string; size: number }> = [];
      // Seeded with whatever the multer fileFilter dropped: those files were never
      // buffered, so the loop below cannot see them.
      const skipped: string[] = [...rejectedUploads(req)];
      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        const rawName = (relPaths[i] && String(relPaths[i])) || f.originalname;
        const type = refTypeForFilename(rawName);
        const rel = sanitiseRefPath(rawName);
        if (!type || !rel) {
          skipped.push(rawName);
          continue;
        }
        const dest = path.join(dir, rel);
        if (!path.resolve(dest).startsWith(path.resolve(dir))) {
          skipped.push(rawName);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.buffer);
        files.push({ filename: rel, type, size: f.size });
      }
      if (files.length === 0) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        return res.status(400).json({
          error: 'No supported files — text, code, data & pdf only',
          skipped,
        });
      }
      res.json({ token, files, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// Sweep abandoned stagings (approval cancelled / never approved) older than 24h.
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(
  () => {
    try {
      if (!fs.existsSync(STAGING_DIR)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(STAGING_DIR)) {
        const p = path.join(STAGING_DIR, name);
        try {
          if (now - fs.statSync(p).mtimeMs > STAGING_TTL_MS)
            fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* skip */
        }
      }
    } catch {
      /* best-effort */
    }
  },
  60 * 60 * 1000,
).unref();

// ─── POST /api/agents/:id/references — hand an existing agent files/folders ──────
// The keystone of file-sharing: write uploaded files into the agent's references/
// dir (mounted into its container, surfaced in its identity every cycle). Merges
// with existing references (same path overwrites). Folder uploads preserve their
// relative tree. Used by the chat attach UI and (later) conversational creation.
agentsRouter.post(
  '/:id/references',
  referenceUpload.array('references', 300),
  async (req, res) => {
    try {
      const agentId = String(req.params.id);
      const agent = agentService.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0)
        return res.status(400).json({ error: 'No files provided' });

      const refDir = path.join(AGENTS_DIR, agent.id, 'references');
      fs.mkdirSync(refDir, { recursive: true });

      // Relative paths come in a separate field (multer strips dirs from filenames),
      // matched to files by index, so folder uploads keep their tree.
      let relPaths: string[] = [];
      try {
        relPaths = JSON.parse(String(req.body?.paths ?? '[]'));
      } catch {
        /* fall back to originalname */
      }

      // Start from existing references; new uploads merge/overwrite by path.
      const byPath = new Map(
        (agent.config.references ?? []).map((r) => [r.filename, r]),
      );
      const added: string[] = [];
      // Seeded with whatever the multer fileFilter dropped: those files were never
      // buffered, so the loop below cannot see them.
      const skipped: string[] = [...rejectedUploads(req)];

      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        const rawName = (relPaths[i] && String(relPaths[i])) || f.originalname;
        const type = refTypeForFilename(rawName);
        const rel = sanitiseRefPath(rawName);
        if (!type || !rel) {
          skipped.push(f.originalname);
          continue;
        }
        const destPath = path.join(refDir, rel);
        // Guard: ensure the resolved path stays inside refDir.
        if (!path.resolve(destPath).startsWith(path.resolve(refDir))) {
          skipped.push(f.originalname);
          continue;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, f.buffer);
        byPath.set(rel, {
          filename: rel,
          type,
          size: f.size,
          addedAt: new Date().toISOString(),
        });
        added.push(rel);
      }

      if (added.length === 0) {
        return res.status(400).json({
          error:
            'No supported files — text, code, data (md/txt/json/csv/code…) and pdf only; binary files (images, archives, media) are rejected',
          skipped,
        });
      }

      // Persist + regenerate identity so the REFERENCES section reflects the new docs.
      agent.config.references = [...byPath.values()];
      agentService.updateAgent(agent.id, { config: agent.config });

      res.json({ added, skipped, references: agent.config.references });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /api/agents/:id/workspace/files — upload files/folders into workspace ──
// Project-folder model: the user drops files straight into the agent's workspace tree
// (alongside the agent's own output), into an optional target subfolder. Folder uploads
// preserve their relative tree. Same safe file-type filter as references.
agentsRouter.post(
  '/:id/workspace/files',
  referenceUpload.array('references', 300),
  async (req, res) => {
    try {
      const agentId = String(req.params.id);
      const agent = agentService.getAgent(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0)
        return res.status(400).json({ error: 'No files provided' });

      const wsDir = path.join(AGENTS_DIR, agent.id, 'workspace');
      // Optional target subfolder (e.g. "docs") — sanitized; files land under it.
      const targetDir = sanitiseRefPath(String(req.body?.dir ?? '')) ?? '';
      const baseDir = path.join(wsDir, targetDir);
      fs.mkdirSync(baseDir, { recursive: true });

      let relPaths: string[] = [];
      try {
        relPaths = JSON.parse(String(req.body?.paths ?? '[]'));
      } catch {
        /* fall back to originalname */
      }

      const added: string[] = [];
      // Seeded with whatever the multer fileFilter dropped: those files were never
      // buffered, so the loop below cannot see them.
      const skipped: string[] = [...rejectedUploads(req)];
      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        const rawName = (relPaths[i] && String(relPaths[i])) || f.originalname;
        const type = refTypeForFilename(rawName);
        const rel = sanitiseRefPath(rawName);
        if (!type || !rel) {
          skipped.push(f.originalname);
          continue;
        }
        const destPath = path.join(baseDir, rel);
        // Guard: resolved path must stay inside the agent's workspace.
        if (!path.resolve(destPath).startsWith(path.resolve(wsDir))) {
          skipped.push(f.originalname);
          continue;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, f.buffer);
        added.push(path.posix.join(targetDir, rel));
      }

      if (added.length === 0) {
        return res.status(400).json({
          error:
            'No supported files — text, code, data (md/txt/json/csv/code…) and pdf only; binary files (images, archives, media) are rejected',
          skipped,
        });
      }
      res.json({ added, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── DELETE /api/agents/:id/workspace/file — remove a file or folder from the workspace ──
// Ownership is enforced by the router.param('id') guard above. `path` may name either a
// file or a directory — rmSync handles both in one call (recursive removes a whole folder).
agentsRouter.delete('/:id/workspace/file', (req, res) => {
  try {
    const agentId = String(req.params.id);
    const agent = agentService.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const relPath = sanitiseRefPath(String(req.query.path ?? ''));
    if (!relPath) return res.status(400).json({ error: 'path required' });

    const wsDir = path.join(AGENTS_DIR, agent.id, 'workspace');
    const target = path.resolve(path.join(wsDir, relPath));
    if (!target.startsWith(path.resolve(wsDir))) {
      return res.status(403).json({ error: 'Path traversal rejected' });
    }
    if (!fs.existsSync(target))
      return res.status(404).json({ error: 'Not found' });

    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/agents/:id/workspace/file — rename or move a file/folder ────────
// Body: { from: string, to: string }. Same operation either way — renaming is just
// a move within the same parent directory. Rejects if `to` already exists (no
// silent overwrite) or either path escapes the workspace.
agentsRouter.patch('/:id/workspace/file', (req, res) => {
  try {
    const agentId = String(req.params.id);
    const agent = agentService.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const fromRel = sanitiseRefPath(String(req.body?.from ?? ''));
    const toRel = sanitiseRefPath(String(req.body?.to ?? ''));
    if (!fromRel || !toRel)
      return res.status(400).json({ error: 'from and to are required' });

    const wsDir = path.join(AGENTS_DIR, agent.id, 'workspace');
    const wsResolved = path.resolve(wsDir);
    const src = path.resolve(path.join(wsDir, fromRel));
    const dest = path.resolve(path.join(wsDir, toRel));
    if (!src.startsWith(wsResolved) || !dest.startsWith(wsResolved)) {
      return res.status(403).json({ error: 'Path traversal rejected' });
    }
    if (!fs.existsSync(src))
      return res.status(404).json({ error: 'Not found' });
    if (fs.existsSync(dest))
      return res
        .status(409)
        .json({ error: 'A file or folder already exists at the destination' });

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    res.json({ ok: true, path: toRel });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/workspace/file/copy — duplicate a file/folder ─────────
// Body: { from: string, to: string }. Rejects if `to` already exists.
agentsRouter.post('/:id/workspace/file/copy', (req, res) => {
  try {
    const agentId = String(req.params.id);
    const agent = agentService.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const fromRel = sanitiseRefPath(String(req.body?.from ?? ''));
    const toRel = sanitiseRefPath(String(req.body?.to ?? ''));
    if (!fromRel || !toRel)
      return res.status(400).json({ error: 'from and to are required' });

    const wsDir = path.join(AGENTS_DIR, agent.id, 'workspace');
    const wsResolved = path.resolve(wsDir);
    const src = path.resolve(path.join(wsDir, fromRel));
    const dest = path.resolve(path.join(wsDir, toRel));
    if (!src.startsWith(wsResolved) || !dest.startsWith(wsResolved)) {
      return res.status(403).json({ error: 'Path traversal rejected' });
    }
    if (!fs.existsSync(src))
      return res.status(404).json({ error: 'Not found' });
    if (fs.existsSync(dest))
      return res
        .status(409)
        .json({ error: 'A file or folder already exists at the destination' });

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    res.json({ ok: true, path: toRel });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/pins — toggle a workspace file as must-read ────────────
// Body: { path: string }. Toggles the path in config.pins. Pinned files are surfaced
// to the agent every cycle as "read these first" (the references replacement).
agentsRouter.post('/:id/pins', (req, res) => {
  try {
    const agentId = String(req.params.id);
    const agent = agentService.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const p = String(req.body?.path ?? '')
      .replace(/^\/+/, '')
      .trim();
    if (!p) return res.status(400).json({ error: 'path required' });

    const pins = new Set(agent.config.pins ?? []);
    if (pins.has(p)) pins.delete(p);
    else pins.add(p);
    agent.config.pins = [...pins];
    agentService.updateAgent(agent.id, { config: agent.config });
    res.json({ pins: agent.config.pins, pinned: pins.has(p) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/agents/:id/references — remove reference file(s) ────────────────
// Body: { paths: string[] }. Deletes the files and drops them from config.references,
// regenerating identity (the REFERENCES section disappears when none remain).
agentsRouter.delete('/:id/references', (req, res) => {
  try {
    const agent = agentService.getAgent(String(req.params.id));
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const paths: string[] = Array.isArray(req.body?.paths)
      ? req.body.paths
      : [];
    if (paths.length === 0)
      return res.status(400).json({ error: 'paths required' });

    const refDir = path.join(AGENTS_DIR, agent.id, 'references');
    const removed: string[] = [];
    for (const p of paths) {
      const rel = sanitiseRefPath(String(p));
      if (!rel) continue;
      const dest = path.join(refDir, rel);
      if (!path.resolve(dest).startsWith(path.resolve(refDir))) continue;
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* already gone */
      }
      removed.push(rel);
      // Prune now-empty parent dirs up to refDir.
      let dir = path.dirname(dest);
      while (
        path.resolve(dir) !== path.resolve(refDir) &&
        path.resolve(dir).startsWith(path.resolve(refDir))
      ) {
        try {
          if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } else break;
        } catch {
          break;
        }
      }
    }
    const removeSet = new Set(removed);
    agent.config.references = (agent.config.references ?? []).filter(
      (r) => !removeSet.has(r.filename),
    );
    agentService.updateAgent(agent.id, { config: agent.config });
    res.json({ removed, references: agent.config.references });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/schedule — current schedule state with next run times ─

agentsRouter.get('/:id/schedule', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Judged against the status the agent settles back to, not the DB value: a chat
    // turn on an idle agent writes 'running' for its duration, and the page asked
    // mid-turn would otherwise report a switched-off schedule as live.
    const status = agentService.getSettledStatus(agent.id) ?? agent.status;
    const schedule = describeTimers(
      agent,
      status,
      agentScheduler.getEntryNextRuns(agent.id),
    );

    res.json({
      agentId: req.params.id,
      status,
      triggerMode: agent.config.triggerMode ?? 'scheduled',
      // A timer without its own zone is read in UTC (calcNextRun).
      timezone: 'UTC',
      schedule,
      // For the page's cost estimate: typical cost of one unattended run.
      avgRunCost: averageRunCost(agent.id),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/schedule/:entryId/run — run one timer now ───────────

agentsRouter.post('/:id/schedule/:entryId/run', (req, res) => {
  try {
    const out = agentScheduler.runNow(
      String(req.params.id),
      String(req.params.entryId),
    );
    if (!out.ok) return res.status(409).json({ error: out.error });
    res.status(202).json({
      ok: true,
      message: 'Started — follow it in the chat or Activity.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/schedule-preview — next fires for an unsaved timer ────
//
// Computed by the same calcNextRun-family code the scheduler uses, so the page's preview
// cannot drift from what will actually happen. (The page used to walk crons in its own
// JavaScript on the browser's clock, and showed 9 AM for a timer that fired at 2:30 PM.)

agentsRouter.get('/:id/schedule-preview', (req, res) => {
  try {
    const interval = String(req.query.interval ?? '');
    const tz = String(req.query.tz ?? 'UTC') || 'UTC';
    if (!isValidTimezone(tz))
      return res.status(422).json({ error: `Unknown time zone "${tz}"` });
    const err = validateSchedule([{ type: 'work', interval, enabled: true }]);
    if (err)
      return res
        .status(422)
        .json({ error: err.replace(/^schedule\[0\]: /, '') });
    res.json(previewInterval(interval, tz));
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/budget — today's and this month's spend ──────────────

agentsRouter.get('/:id/budget', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const costToday = getCycleCostToday(req.params.id);

    const allCycles = agentService.getCycles(req.params.id, 500);
    const costMonth = allCycles
      .filter(
        (c) => new Date(c.started_at).getTime() > Date.now() - 30 * 86400000,
      )
      .reduce((s: number, c: any) => s + (c.cost ?? 0), 0);

    res.json({
      daily: { used: costToday, limit: agent.config.budget.daily },
      monthly: { used: costMonth, limit: agent.config.budget.monthly },
      onExhaust: agent.config.budget.onExhaust,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/memory/search — FTS5 ranked search ─────────────────

agentsRouter.get('/:id/memory/search', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const {
      q,
      limit = '20',
      type,
      track,
    } = req.query as Record<string, string>;
    if (!q || !q.trim())
      return res.status(400).json({ error: 'q parameter required' });
    // Semantic-ranked when the agent has embedded memories, transparently falling back
    // to FTS5/trigram otherwise — see memory-retrieval.ts (Stage 34 Gaps 3/4).
    const rows = await searchAgentMemoryRanked(
      req.params.id,
      q,
      parseInt(limit, 10) || 20,
      type,
    );
    // `track=1` marks an EXPLICIT retrieval (the search_memory tool): bump used_count so
    // decay keeps used memories longer. Passive per-turn injection omits it (no runaway).
    if (track && rows.length) {
      try {
        for (const r of rows) incrementMemoryUsed(r.id);
      } catch {
        /* non-fatal */
      }
    }
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/memory ───────────────────────────────────────────────

agentsRouter.get('/:id/memory', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(getMemoryByAgent(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/tool-analytics — per-tool performance stats ─────────

agentsRouter.get('/:id/tool-analytics', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const days = parseInt(req.query.days as string, 10) || 7;
    const rows = getToolAnalytics(req.params.id, days);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/memory — manually add a memory entry ───────────────

agentsRouter.post('/:id/memory', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { type, content, relevance } = req.body;
    if (!type || !content)
      return res.status(400).json({ error: 'type and content required' });
    // Single write path: DB first (durable), view refresh deferred off the response path
    // since the calling cycle agent is awaiting this response.
    const mem = recordMemory(
      req.params.id,
      {
        type,
        content,
        relevance: typeof relevance === 'number' ? relevance : undefined,
      },
      { syncNow: false },
    );
    res.status(201).json(mem);
    return;
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/agents/:id/memory/:memoryId ─────────────────────────────────

agentsRouter.delete('/:id/memory/:memoryId', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    deleteAgentMemory(req.params.memoryId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/memory/file — raw MEMORY.md written by append_memory ──

agentsRouter.get('/:id/memory/file', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const memPath = path.join(
      DATA_DIR,
      'agents',
      req.params.id,
      'memory',
      'MEMORY.md',
    );
    const content = fs.existsSync(memPath)
      ? fs.readFileSync(memPath, 'utf-8')
      : null;
    res.json({ content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/identity-history — list archived IDENTITY.md versions

// ─── GET /api/agents/:id/identity — the live IDENTITY.md ─────────────────────
// Only past versions were readable (identity-history/vN.md), never the one actually in
// force. The Identity tab is even labelled "IDENTITY.md" while showing a single field of
// it, so an agent's real operating rules — often thousands of words that decide
// everything it does — were not visible anywhere in the product.
//
// Read-only on purpose: this file is GENERATED by renderIdentity() from the type
// template (or customSystemPrompt), personality, references, workspace dirs and the
// LEARNED section, and is rewritten whenever config changes. Editing it in place would
// have those edits silently overwritten on the next config save, which is worse than not
// offering the edit at all.
// ─── Config history + revert (stage 54 phase 1) ───────────────────────────────
//
// The owner-facing half of the audit trail. Lives on agentsRouter, not the self-manage
// router, because these are read and undone by a human with a session — not by an agent
// with a cycle token. An agent must never be able to erase or rewrite its own history.

/** GET /api/agents/:id/config-history — what changed, newest first, with diffs. */
agentsRouter.get('/:id/config-history', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = getConfigAudit(agent.id, limit).map((r) => ({
      id: r.id,
      capability: r.capability,
      actor: r.actor,
      cycleId: r.cycle_id,
      reason: r.reason,
      before: JSON.parse(r.before_json),
      after: JSON.parse(r.after_json),
      revertedBy: r.reverted_by,
      createdAt: r.created_at,
    }));
    res.json({ entries: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:id/config-history/:auditId/revert — put a change back.
 *
 * Applies before_json over the same subtree and records the revert as its own entry, so
 * the trail never loses a step and reverting a revert is just another row. Nothing is
 * deleted, ever.
 */
agentsRouter.post('/:id/config-history/:auditId/revert', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const entry = getConfigAuditById(String(req.params.auditId));
    if (!entry || entry.agent_id !== agent.id) {
      return res
        .status(404)
        .json({ error: 'No such history entry for this agent' });
    }

    const target = JSON.parse(entry.before_json) as Record<
      string,
      unknown
    > | null;
    if (!target)
      return res
        .status(422)
        .json({ error: 'That entry has no prior state to restore' });

    const beforeRevert = auditSnapshot(agent.id, entry.capability);

    // Status lives on the agent row, not in config, so it takes a different setter.
    if (entry.capability === 'status') {
      const want = String(target.status ?? '');
      if (want !== 'running' && want !== 'paused' && want !== 'idle') {
        return res
          .status(422)
          .json({ error: `Cannot restore status "${want}"` });
      }
      agentService.setSelfStatus(agent.id, want as 'running' | 'paused');
      if (want === 'running') agentScheduler.register(agent.id, agent.config);
      else agentScheduler.unregister(agent.id);
    } else {
      // Everything else is a config subtree whose keys ARE config keys — but only
      // write the ones we know are, and say so when an old entry carries something
      // else. The first live revert wrote a `systemPrompt` key that AgentConfig has
      // never had (the real field is `customSystemPrompt`), missed the field it meant
      // to restore, and returned ok — because nothing checked what it was writing.
      const unknown = Object.keys(target).filter(
        (k) => !REVERTABLE_CONFIG_KEYS.has(k),
      );
      const writable = Object.fromEntries(
        Object.entries(target).filter(([k]) => REVERTABLE_CONFIG_KEYS.has(k)),
      );
      if (Object.keys(writable).length === 0) {
        return res.status(422).json({
          error:
            'That entry holds no restorable fields — it predates the current audit format.',
          unknownKeys: unknown,
        });
      }
      const updated = await agentService.updateAgent(agent.id, {
        config: writable as unknown as AgentConfig,
      });
      if (entry.capability === 'schedule')
        resyncScheduleForOwner(agent.id, updated.config);
      if (unknown.length) {
        logger.warn(
          { agentId: agent.id, entryId: entry.id, unknown },
          'revert skipped keys it does not recognise',
        );
      }
    }

    const revertId = recordConfigAudit({
      agentId: agent.id,
      capability: entry.capability,
      actor: 'owner',
      before: beforeRevert,
      after: auditSnapshot(agent.id, entry.capability),
      reason: `Reverted change ${entry.id.slice(0, 8)} (${entry.capability}, ${entry.created_at})`,
    });
    if (revertId) markAuditReverted(entry.id, revertId);

    getSocketIO()?.emit('agent:updated', { agentId: agent.id });
    logger.info(
      { agentId: agent.id, entryId: entry.id, revertId },
      'Owner reverted an agent config change',
    );
    res.json({ ok: true, revertedEntry: entry.id, newEntry: revertId });
  } catch (err: any) {
    logger.error(
      { agentId: req.params.id, err: err?.message },
      'config revert failed',
    );
    res.status(500).json({ error: err.message });
  }
});

/** Re-arm the scheduler after an owner-side schedule revert. Mirrors resyncSchedule. */
function resyncScheduleForOwner(agentId: string, config: AgentConfig): void {
  const hasEnabled = (config.schedule ?? []).some(
    (s) => s.enabled && s.interval && s.interval.toLowerCase() !== 'manual',
  );
  try {
    if (hasEnabled) agentScheduler.register(agentId, config);
    else agentScheduler.unregister(agentId);
  } catch (e: any) {
    logger.warn(
      { agentId, err: e?.message },
      'Schedule reverted but could not be re-armed',
    );
  }
}

agentsRouter.get('/:id/identity', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const content = workspaceMgr.readFile(req.params.id, 'IDENTITY.md');
    if (content === null)
      return res.status(404).json({ error: 'IDENTITY.md not found' });
    res.json({
      content,
      version: agent.identity_version ?? 1,
      // What the reader can actually change, so the page can say so rather than
      // leaving them guessing which parts are theirs.
      editable: {
        mission: 'config.goals — the Mission field above',
        operatingRules: agent.config?.customSystemPrompt
          ? `config.customSystemPrompt (mode: ${agent.config.customSystemPrompt.mode})`
          : null,
        learned: 'rewritten by the agent itself on each self_improve cycle',
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/identity-history', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(workspaceMgr.listIdentityVersions(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/identity-history/:version — get a specific version ───

agentsRouter.get('/:id/identity-history/:version', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const filePath = `identity-history/v${req.params.version}.md`;
    const content = workspaceMgr.readFile(req.params.id, filePath);
    if (content === null)
      return res.status(404).json({ error: 'Version not found' });
    res.json({ version: parseInt(req.params.version), content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/identity-history/:version/restore — rollback ─────────

agentsRouter.post('/:id/identity-history/:version/restore', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const filePath = `identity-history/v${req.params.version}.md`;
    const content = workspaceMgr.readFile(req.params.id, filePath);
    if (content === null)
      return res.status(404).json({ error: 'Version not found' });
    const identityPath = path.join(
      DATA_DIR,
      'agents',
      req.params.id,
      'IDENTITY.md',
    );
    fs.writeFileSync(identityPath, content, 'utf-8');
    res.json({ success: true, restoredVersion: parseInt(req.params.version) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/checkins — create checkin (used by nanobot request_approval) ──

agentsRouter.post('/:id/checkins', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Checked here too, not only by the router.param guard: check-ins carry approvals and
    // drafts, and a route that relies on a guard elsewhere loses it the day it moves.
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const { status, report_md, action_type, action_payload } = req.body;

    // Stage 60 phase 3: a list of sends from the user's own browser is checked against
    // the site's daily limit here, where the agent can't miscount it. Counted across
    // all of this owner's agents, because it's one account being protected.
    const refusal = batchCheckinRefusal(
      (agent as { owner_id?: string | null }).owner_id,
      action_type,
      action_payload,
      ownerCheckins,
    );
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const checkin = createAgentCheckin({
      agent_id: req.params.id,
      status: status ?? 'pending',
      report_md: report_md ?? null,
      action_type: action_type ?? null,
      action_payload: action_payload ?? null,
    });

    // The owner's approval rules for this agent — shared with the container route.
    const auto = await autoApproveIfRuled(agent, checkin);
    if (auto) {
      emit('agent:checkin_responded', {
        agentId: req.params.id,
        checkinId: checkin.id,
      });
      return res.status(201).json({ ...checkin, status: 'responded', ...auto });
    }

    emit('agent:checkin_created', {
      agentId: req.params.id,
      checkinId: checkin.id,
    });
    res.status(201).json(checkin);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Approval rules (owner) ────────────────────────────────────────────────────
//
// GET returns the rules, the catalogue of actions a rule can cover, and what the rules
// auto-approved lately — the owner's way to check a "don't ask" rule is doing only what
// they meant. PUT replaces the rule list (the tab edits the whole list at once).

agentsRouter.get('/:id/approvals', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const recent = getCheckinsByAgent(agent.id)
      .filter(
        (c) =>
          typeof c.user_reply === 'string' &&
          c.user_reply.includes('auto-approved by your rule'),
      )
      .slice(0, 20)
      .map((c) => ({
        id: c.id,
        at: c.responded_at ?? c.created_at,
        actionType: c.action_type,
        rule: c.user_reply!.replace(
          /^approve — auto-approved by your rule: /,
          '',
        ),
        summary: (c.report_md ?? '').slice(0, 200),
      }));
    const ownerEmail = agent.owner_id
      ? (getUserById(agent.owner_id)?.email ?? null)
      : null;
    res.json({
      rules: agent.config.approvalRules ?? [],
      actions: APPROVAL_ACTIONS,
      recentAutoApproved: recent,
      ownerEmail,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.put('/:id/approvals', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const incoming = (req.body as { rules?: unknown }).rules;
    if (!Array.isArray(incoming))
      return res.status(422).json({ error: 'rules must be a list' });
    for (const r of incoming) {
      const err = validateRule(r);
      if (err) return res.status(422).json({ error: err });
    }
    const rules: ApprovalRule[] = incoming.map((r) =>
      makeRule(
        r as Partial<ApprovalRule>,
        (r as ApprovalRule).createdBy === 'agent' ? 'agent' : 'owner',
      ),
    );
    const before = { approvalRules: agent.config.approvalRules ?? [] };
    const updated = await agentService.updateAgent(agent.id, {
      config: { approvalRules: rules } as AgentConfig,
    });
    recordConfigAudit({
      agentId: agent.id,
      capability: 'approvals',
      actor: req.user?.role === 'admin' ? 'admin' : 'owner',
      before,
      after: { approvalRules: updated.config.approvalRules ?? [] },
      reason: 'Edited in the Approval rules tab',
    });
    emit('agent:updated', { agentId: agent.id });
    res.json({ ok: true, rules: updated.config.approvalRules ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/checkins ─────────────────────────────────────────────

agentsRouter.get('/:id/checkins', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Checked here too, not only by the router.param guard: check-ins carry approvals and
    // drafts, and a route that relies on a guard elsewhere loses it the day it moves.
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(getCheckinsByAgent(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/checkins/pending — latest pending check-in ───────────

agentsRouter.get('/:id/checkins/pending', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Checked here too, not only by the router.param guard: check-ins carry approvals and
    // drafts, and a route that relies on a guard elsewhere loses it the day it moves.
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const checkin = getPendingCheckinByAgent(req.params.id);
    res.json(checkin ?? null);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/checkins/:checkinId — single check-in ────────────────

agentsRouter.get('/:id/checkins/:checkinId', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Checked here too, not only by the router.param guard: check-ins carry approvals and
    // drafts, and a route that relies on a guard elsewhere loses it the day it moves.
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const checkin = getCheckinById(req.params.checkinId);
    if (!checkin || checkin.agent_id !== req.params.id)
      return res.status(404).json({ error: 'Check-in not found' });
    res.json(checkin);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Moved to agents/checkin-respond.ts (stage 64 phase 1) — re-exported for existing importers.
export { isLiveClarifyAwaitingReply };

// ─── POST /api/agents/:id/checkins/:checkinId/respond ─────────────────────────

agentsRouter.post('/:id/checkins/:checkinId/respond', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Checked here too, not only by the router.param guard: check-ins carry approvals and
    // drafts, and a route that relies on a guard elsewhere loses it the day it moves.
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const checkin = getCheckinById(req.params.checkinId);
    if (!checkin || checkin.agent_id !== req.params.id)
      return res.status(404).json({ error: 'Check-in not found' });
    if (checkin.status === 'responded')
      return res.status(409).json({ error: 'Already responded' });

    const { reply, action_payload_override } = req.body;
    if (!reply || typeof reply !== 'string')
      return res.status(400).json({ error: 'reply field required' });

    // Shared with the owner's WhatsApp replies — see agents/checkin-respond.ts.
    const outcome = await respondToCheckin(
      req.params.id,
      req.params.checkinId,
      reply,
      action_payload_override,
    );
    if (!outcome.ok) {
      return outcome.reason === 'already_responded'
        ? res.status(409).json({ error: 'Already responded' })
        : res.status(404).json({ error: 'Check-in not found' });
    }
    const updated = getCheckinById(req.params.checkinId);
    res.json(
      outcome.deliveredTo === 'live-cycle'
        ? { checkin: updated, deliveredTo: 'live-cycle' }
        : { checkin: updated },
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/checkins/batch-respond ──────────────────────────────
// Decide a whole queue in one action. Per-check-in approval made the human the
// throughput ceiling: a morning's drafts meant one click and one agent cycle each.
// No path conflict with `/:checkinId/respond` — that route has a segment after the id.

agentsRouter.post('/:id/checkins/batch-respond', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { ids, reply } = req.body as { ids?: unknown; reply?: unknown };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (ids.length > 50)
      return res.status(400).json({ error: 'at most 50 check-ins per batch' });
    if (!ids.every((i) => typeof i === 'string')) {
      return res.status(400).json({ error: 'ids must be strings' });
    }
    if (!reply || typeof reply !== 'string')
      return res.status(400).json({ error: 'reply field required' });

    // Stage 60 phase 3: a live question or batch approval is answered straight into the
    // run that is waiting on it — the same as the single respond route. Sending it
    // through processFeedback would start a second cycle for a run still sitting there.
    const liveResults: Array<{ id: string; ok: boolean; error?: string }> = [];
    const deferredIds: string[] = [];
    for (const cid of ids as string[]) {
      const c = getCheckinById(cid);
      if (
        c &&
        c.agent_id === req.params.id &&
        c.status !== 'responded' &&
        isLiveClarifyAwaitingReply(c)
      ) {
        updateAgentCheckin(cid, {
          status: 'responded',
          user_reply: reply,
          responded_at: new Date().toISOString(),
        });
        liveResults.push({ id: cid, ok: true });
      } else {
        deferredIds.push(cid);
      }
    }
    const results = [
      ...liveResults,
      ...(deferredIds.length
        ? await agentService.processFeedbackBatch(
            req.params.id,
            deferredIds,
            reply,
          )
        : []),
    ];
    for (const r of results.filter((x) => x.ok)) {
      emit('agent:checkin_responded', {
        agentId: req.params.id,
        checkinId: r.id,
      });
    }
    res.json({
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/tool-approvals/:approvalId/respond ──────────────────
// The human half of the Strict posture. The agent container is blocked polling
// for this decision; the creation and polling endpoints live before the auth gate
// in server.ts, but approving is an owner action and stays behind it.

agentsRouter.post('/:id/tool-approvals/:approvalId/respond', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!ownsResource(req, (agent as { owner_id?: string | null }).owner_id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const approval = getToolApproval(req.params.approvalId);
    if (!approval || approval.agent_id !== req.params.id) {
      return res.status(404).json({ error: 'Approval not found' });
    }

    const { decision, note } = req.body as { decision?: string; note?: string };
    if (decision !== 'approve' && decision !== 'deny') {
      return res
        .status(400)
        .json({ error: "decision must be 'approve' or 'deny'" });
    }

    const updated = decideToolApproval(
      approval.id,
      decision === 'approve' ? 'approved' : 'denied',
      req.user!.id,
      note ?? null,
    );
    // Already settled — most often it expired while the tab sat open, and the
    // agent has moved on. Report the settled state rather than pretending.
    if (!updated)
      return res.status(409).json({
        error: 'Already decided',
        approval: getToolApproval(approval.id),
      });

    emit('agent:approval_resolved', {
      agentId: updated.agent_id,
      approvalId: updated.id,
      status: updated.status,
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/handoffs ────────────────────────────────────────────

agentsRouter.get('/:id/handoffs', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(getHandoffsByAgent(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/handoffs/pending ─────────────────────────────────────

agentsRouter.get('/:id/handoffs/pending', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(getPendingHandoffsByAgent(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/handoffs — create a handoff FROM this agent ─────────

agentsRouter.post('/:id/handoffs', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Delegates to the same function server.ts uses. There were two copies of this and
    // Express matches server.ts's first for an agent's request, so anything fixed here
    // alone was fixed for the dashboard and nobody else — three times over. The only
    // difference that remains is the one that should: this route sees the caller's own
    // agents, the internal one sees all of them.
    const result = createHandoffFromRequest(
      req.params.id,
      req.body,
      filterOwned(req, agentService.getAllAgents()),
      getHandoffById,
    );
    if (result.status === 201) {
      const h = result.body as {
        id: string;
        to_agent_id: string;
        type: string;
      };
      emit('agent:handoff_created', {
        fromAgentId: req.params.id,
        toAgentId: h.to_agent_id,
        handoffId: h.id,
        type: h.type,
      });
    }
    res.status(result.status).json(result.body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/agents/:id/handoffs/:handoffId — update handoff status ────────

agentsRouter.patch('/:id/handoffs/:handoffId', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { status, note } = req.body;
    // Stage 56 vocabulary. `acknowledged`/`accepted`/`rejected` are accepted as aliases
    // for the terms that replaced them, because this is the route the dashboard and any
    // saved script call — refusing a word we ourselves used last week would break them
    // for no gain. They are normalised on the way in so only one vocabulary is stored.
    const ALIASES: Record<string, HandoffStatus> = {
      acknowledged: 'seen',
      accepted: 'agreed',
      rejected: 'refused',
    };
    const VALID: HandoffStatus[] = [
      'pending',
      'seen',
      'agreed',
      'completed',
      'refused',
      'cannot',
      'failed',
    ];
    const normalised = (ALIASES[status] ?? status) as HandoffStatus;
    if (!status || !VALID.includes(normalised)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${VALID.join(', ')}` });
    }

    // Snapshot the previous state so we only notify on actual transitions
    const before = getHandoffById(req.params.handoffId);
    agentHandoffService.updateStatus(req.params.handoffId, normalised, note);
    const after = getHandoffById(req.params.handoffId);

    // Notify the SENDER when the recipient answers. The sender is the one who needs to
    // know "my delegated work got an answer".
    if (
      after &&
      before &&
      before.status !== normalised &&
      before.from_agent_id !== before.to_agent_id
    ) {
      const senderId = before.from_agent_id;
      const recipient = agentService.getAgent(before.to_agent_id);
      const recipientName = recipient?.name ?? before.to_agent_id.slice(0, 8);
      const VERB: Record<string, string> = {
        completed: 'completed',
        refused: 'refused',
        agreed: 'took on',
        seen: 'has seen',
        cannot: 'cannot do',
        failed: 'failed on',
      };
      const verb = VERB[normalised] ?? normalised;
      try {
        notify(
          normalised === 'completed'
            ? 'handoff_completed'
            : normalised === 'refused' ||
                normalised === 'cannot' ||
                normalised === 'failed'
              ? 'handoff_rejected'
              : 'handoff_updated',
          `${recipientName} ${verb} your handoff`,
          note?.slice(0, 200) || `${before.type} handoff is now ${normalised}`,
          senderId,
          {
            handoffId: before.id,
            type: before.type,
            recipientId: before.to_agent_id,
          },
        );
      } catch (e: any) {
        logger.warn({ err: e?.message }, 'Handoff status notify failed');
      }
      // Real-time emit so any open UI updates immediately
      emit('agent:handoff_updated', {
        handoffId: before.id,
        fromAgentId: senderId,
        toAgentId: before.to_agent_id,
        prevStatus: before.status,
        newStatus: normalised,
      });
    }

    res.json(after ?? { ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/cycles/:cycleId/steer — talk to a run in flight ────
//
// stage45 item 5. The owner half of steering. Everything else a human could say to a
// running agent was a DECISION — approve/reject/comment on one action the agent chose to
// ask about. This is the other direction: "it is the second tab", "stop, try the search
// box", to a run that is going wrong and not asking.
//
// Session-gated like its neighbours here; the agent reads them back through the
// cycle-token route on self-manage.ts. The note is delivered to the model as clearly
// marked OWNER instruction, which is why this route is the authenticated one — page
// content must never be able to reach that channel.
agentsRouter.post('/:id/cycles/:cycleId/steer', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    const waiting = addSteer(String(req.params.cycleId ?? ''), text);
    res.json({ ok: true, waiting });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/browser-runs — archived effector frame runs ─────────
//
// stage45 item 1. The agent writes one frame per step into its own workspace
// (container/nanoagent/.../effector/frame_archive.py); this lists what is there so the
// dashboard can offer "look at that run again". The JPEGs themselves are served by the
// existing workspace/file?path=…&raw=1 route — no second file-serving path, and no
// second traversal check to get wrong.
agentsRouter.get('/:id/browser-runs', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const root = path.join(
      DATA_DIR,
      'agents',
      req.params.id,
      'workspace',
      '.effector',
      'frames',
    );
    if (!fs.existsSync(root)) return res.json([]);

    const runs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(root, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(dir).mtimeMs;
        } catch {
          /* raced with a prune */
        }
        return { name: d.name, dir, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20)
      .flatMap((r) => {
        // A run whose index is missing or half-written is skipped rather than
        // reported empty: the archive rewrites index.json atomically, so the
        // only way to see broken JSON is a directory being pruned underneath
        // us, and an entry the UI cannot open is worse than no entry.
        try {
          const raw = fs.readFileSync(path.join(r.dir, 'index.json'), 'utf-8');
          const parsed = JSON.parse(raw);
          const frames = Array.isArray(parsed.frames) ? parsed.frames : [];
          if (!frames.length) return [];
          return [
            {
              runId: String(parsed.run_id ?? r.name),
              frames,
              updatedAt: r.mtime,
              lastUrl: String(frames[frames.length - 1]?.url ?? ''),
            },
          ];
        } catch {
          return [];
        }
      });

    res.json(runs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/workspace/files — file tree ─────────────────────────

agentsRouter.get('/:id/workspace/files', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const subdir = req.query.subdir as string | undefined;
    const files = workspaceMgr.listFiles(req.params.id, subdir);
    res.json(files);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/workspace/file — single file content ─────────────────

agentsRouter.get('/:id/workspace/file', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const filePath = req.query.path as string;
    if (!filePath)
      return res.status(400).json({ error: 'path query param required' });

    // For raw binary serving (images), resolve the file directly and send with proper MIME
    const raw = req.query.raw as string;
    if (raw) {
      const IMG_TYPES: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
      };
      const wsDir = path.join(DATA_DIR, 'agents', req.params.id, 'workspace');
      const fullPath = path.resolve(wsDir, filePath);
      // Prevent path traversal
      if (!fullPath.startsWith(path.resolve(wsDir))) {
        return res.status(403).json({ error: 'Path traversal denied' });
      }
      if (!fs.existsSync(fullPath))
        return res.status(404).json({ error: 'File not found' });
      // stage45 item 4: the files an agent downloads are the point of gap E, and
      // they are not images. A PDF invoice should open when clicked rather than
      // land as an octet-stream blob.
      //
      // Anything not on this list is forced to `attachment`, which is what stops a
      // workspace file (an .html an agent wrote, say) from running as same-origin
      // script when someone clicks it. `octet-stream` happened to make browsers
      // download anyway; this makes that a rule rather than a side effect.
      //
      // SVG stays inline and is sandboxed by guardFileResponse instead. An earlier
      // pass today forced it to download; that closed the hole and also broke every
      // legitimate <img> of a workspace SVG, which is a worse trade than it looked.
      // An SVG in <img src> cannot execute script — only direct navigation can, and
      // that is exactly what the sandbox header stops. See file-serving.ts.
      const INLINE_TYPES: Record<string, string> = {
        ...IMG_TYPES,
        '.pdf': 'application/pdf',
        '.csv': 'text/plain; charset=utf-8',
        '.json': 'text/plain; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/plain; charset=utf-8',
      };
      const ext = path.extname(fullPath).toLowerCase();
      const inline = INLINE_TYPES[ext] || undefined;
      const buf = fs.readFileSync(fullPath);
      if (!inline) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${path.basename(fullPath).replace(/"/g, '')}"`,
        );
      }
      const served = inline ?? 'application/octet-stream';
      guardFileResponse(res, served);
      return res.type(served).send(buf);
    }

    const content = workspaceMgr.readFile(req.params.id, filePath);
    if (content === null)
      return res.status(404).json({ error: 'File not found' });
    res.json({ path: filePath, content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/cycles/:cycleId/file-events ─────────────────────────

agentsRouter.get('/:id/cycles/:cycleId/file-events', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(getFileEventsByCycle(req.params.cycleId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/tools — generate tools from approved proposals ─────

agentsRouter.post('/:id/tools', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { proposals } = req.body as { proposals?: any[] };
    if (!Array.isArray(proposals) || proposals.length === 0) {
      return res.status(400).json({ error: 'proposals array is required' });
    }

    res.json({
      queued: proposals.map((p) => p.name),
      message: 'Tool generation started in background',
    });

    // Update agent-env.json first, then generate tool files in background
    const regenAgentId = req.params.id;
    writeAgentEnv(regenAgentId, AGENTS_DIR, proposals);
    generateAgentTools(regenAgentId, AGENTS_DIR, proposals)
      .then(() => {
        logger.info(
          { agentId: regenAgentId, count: proposals.length },
          'On-demand tool generation complete',
        );
        // Regression: re-run structural check + mission test after tool change
        runFullTest(
          regenAgentId,
          AGENTS_DIR,
          'tool_regenerated',
          (id, cycleType, context) =>
            agentService.runCycle(id, cycleType, context),
        ).catch((err) =>
          logger.warn(
            { agentId: regenAgentId, err },
            'Regression test run failed',
          ),
        );
      })
      .catch((err) => {
        logger.error(
          { agentId: regenAgentId, err },
          'On-demand tool generation failed',
        );
      });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-agent secrets routes ─────────────────────────────────────────────────

import { secretsManager } from '../../agents/secrets-manager.js';
import { attachRepo, detachRepo } from '../../agents/agent-repo.js';

agentsRouter.get('/:id/secrets', (req, res) => {
  try {
    res.json(secretsManager.list({ agentId: req.params.id }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Repository attachment (Devin mode, piece 3) ──────────────────────────────
// `config.repoPath` and the /workspace/repo mount already existed with nothing able to
// reach them. These three routes are that path: clone the repo, store the push token as an
// agent secret, and write a CLAUDE.md brief.

agentsRouter.post('/:id/repo', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Cloning code and storing a push token is meaningful access — check ownership
    // rather than relying on the router-level auth alone.
    if (!ownsResource(req, agent.owner_id) && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your agent' });
    }

    const { url, token, branch, buildCommand, deployUrl, stack } =
      req.body as Record<string, string | undefined>;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const result = await attachRepo({
      agentId: agent.id,
      url,
      token,
      branch,
      buildCommand,
      deployUrl,
      stack,
    });

    // The token goes to the secret store, never into agent config — config is returned
    // by GET /api/agents/:id and would expose it to anything that reads an agent.
    if (token) secretsManager.set({ agentId: agent.id }, 'GITHUB_TOKEN', token);
    if (result.buildCommand)
      secretsManager.set(
        { agentId: agent.id },
        'PROJECT_BUILD_COMMAND',
        result.buildCommand,
      );
    // deploy_check defaults to this, so the agent does not have to carry the URL around
    // in its prompt — and a deploy cannot be verified at all without it.
    if (deployUrl)
      secretsManager.set(
        { agentId: agent.id },
        'PROJECT_DEPLOY_URL',
        deployUrl,
      );

    const config = { ...(agent.config ?? {}) } as AgentConfig &
      Record<string, unknown>;
    config.repoPath = result.repoPath;
    await agentService.updateAgent(agent.id, { config });

    emit('agent:updated', { agentId: agent.id });
    res.json({ ...result, tokenStored: !!token });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

agentsRouter.get('/:id/repo', (req, res) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const repoPath = (agent.config as any)?.repoPath as string | undefined;
  if (!repoPath) return res.json({ attached: false });
  res.json({
    attached: fs.existsSync(repoPath),
    repoPath,
    // Reported so a stale repoPath — the mount silently not appearing — is visible here
    // rather than only as an agent that mysteriously cannot find its code.
    exists: fs.existsSync(repoPath),
    hasClaudeMd: fs.existsSync(path.join(repoPath, 'CLAUDE.md')),
  });
});

agentsRouter.delete('/:id/repo', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!ownsResource(req, agent.owner_id) && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your agent' });
    }
    const repoPath = (agent.config as any)?.repoPath as string | undefined;
    if (repoPath) detachRepo(agent.id, repoPath);

    const config = { ...(agent.config ?? {}) } as AgentConfig &
      Record<string, unknown>;
    delete config.repoPath;
    await agentService.updateAgent(agent.id, { config });
    try {
      secretsManager.delete({ agentId: agent.id }, 'GITHUB_TOKEN');
    } catch {
      /* may not exist */
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

agentsRouter.post('/:id/secrets', (req, res) => {
  const { name, value } = req.body as { name?: string; value?: string };
  if (!name || !value)
    return res.status(400).json({ error: 'name and value are required' });
  try {
    secretsManager.set({ agentId: req.params.id }, name, value);
    const entry = secretsManager
      .list({ agentId: req.params.id })
      .find((s) => s.name === name);
    res.json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

agentsRouter.delete('/:id/secrets/:name', (req, res) => {
  try {
    secretsManager.delete({ agentId: req.params.id }, req.params.name);
    res.json({ deleted: true, name: req.params.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sidecar management routes ───────────────────────────────────────────────

agentsRouter.post('/:id/sidecar/start', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const sidecar = sidecarRegistry.get(req.params.id);
    // Allow retrying a failed sidecar — reset back to stopped first
    sidecar.reset();
    // Start non-blocking — caller polls /sidecar/status
    sidecar
      .ensure()
      .catch((err) =>
        logger.warn({ agentId: req.params.id, err }, 'Sidecar start failed'),
      );
    res.json({
      status: sidecar.getStatus().state,
      message: 'Sidecar starting',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/sidecar/status', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const status = sidecarRegistry.get(req.params.id).getStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.post('/:id/sidecar/ping', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const sidecar = sidecarRegistry.get(req.params.id);
    const start = Date.now();
    const result = await sidecar.call('__ping__', {});
    res.json({
      ok: result.status === 'ok' || result.error?.includes('not found'),
      latencyMs: Date.now() - start,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/sidecar/call — invoke a sidecar tool directly ────────
agentsRouter.post('/:id/sidecar/call', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { tool, args = {} } = req.body as {
      tool?: string;
      args?: Record<string, unknown>;
    };
    if (!tool) return res.status(400).json({ error: 'tool name required' });
    const sidecar = sidecarRegistry.get(req.params.id);
    await sidecar.ensure();
    const result = await sidecar.call(tool, args);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agents/:id/sidecar/verify — verify a candidate tool in the sidecar ──
// Used at tool creation for sidecar-tier tools: installs the tool's deps onto the cached
// volume (reused at runtime) and runs its test cases in the real isolation env, instead of
// installing+running them in the throwaway cycle container. nanobot falls back to its local
// sandbox if this is unreachable.
agentsRouter.post('/:id/sidecar/verify', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const {
      files,
      entrypoint,
      language,
      dependencies,
      test_cases,
      timeout,
      capabilities,
    } = req.body as {
      files?: Record<string, string>;
      entrypoint?: string;
      language?: string;
      dependencies?: string[];
      test_cases?: unknown[];
      timeout?: number;
      capabilities?: string[];
    };
    if (!files || typeof files !== 'object')
      return res.status(400).json({ error: 'files required' });
    const sidecar = sidecarRegistry.get(req.params.id);
    await sidecar.ensure();
    const result = await sidecar.call('__verify__', {
      files,
      entrypoint,
      language,
      dependencies,
      test_cases,
      timeout,
      capabilities,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/env', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const envPath = path.join(AGENTS_DIR, req.params.id, 'agent-env.json');
    if (!fs.existsSync(envPath))
      return res.json({ pythonPackages: [], aptPackages: [] });
    res.json(JSON.parse(fs.readFileSync(envPath, 'utf-8')));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Agent testing routes (Phase 5) ──────────────────────────────────────────

agentsRouter.post('/:id/test/mission', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Run in background — test can take minutes
    res.json({
      queued: true,
      message: 'Test started in background — poll /test/results',
    });

    runFullTest(req.params.id, AGENTS_DIR, 'manual', (id, cycleType, context) =>
      agentService.runCycle(id, cycleType, context),
    ).catch((err) =>
      logger.warn({ agentId: req.params.id, err }, 'Manual test run failed'),
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/test/results', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const result = readLatestResult(req.params.id, AGENTS_DIR);
    if (!result)
      return res.json({
        verdict: 'no_results',
        message: 'No test has been run yet',
      });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/test/results/history', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(readResultHistory(req.params.id, AGENTS_DIR));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/test/cases', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const casesPath = path.join(
      AGENTS_DIR,
      req.params.id,
      'test-results',
      'custom-cases.json',
    );
    const cases = fs.existsSync(casesPath)
      ? JSON.parse(fs.readFileSync(casesPath, 'utf-8'))
      : [];
    res.json(cases);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.delete('/:id/test/cases/:caseId', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const casesPath = path.join(
      AGENTS_DIR,
      req.params.id,
      'test-results',
      'custom-cases.json',
    );
    if (!fs.existsSync(casesPath))
      return res.status(404).json({ error: 'No cases found' });
    const cases: any[] = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
    const filtered = cases.filter((c: any) => c.id !== req.params.caseId);
    if (filtered.length === cases.length)
      return res.status(404).json({ error: 'Case not found' });
    fs.writeFileSync(casesPath, JSON.stringify(filtered, null, 2), 'utf-8');
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.post('/:id/test/cases/:caseId/run', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const casesPath = path.join(
      AGENTS_DIR,
      req.params.id,
      'test-results',
      'custom-cases.json',
    );
    if (!fs.existsSync(casesPath))
      return res.status(404).json({ error: 'No custom cases found' });

    const cases: any[] = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
    const caseObj = cases.find((c: any) => c.id === req.params.caseId);
    if (!caseObj) return res.status(404).json({ error: 'Case not found' });

    const result = await runCustomCase(
      req.params.id,
      AGENTS_DIR,
      caseObj,
      (id, cycleType, context) => agentService.runCycle(id, cycleType, context),
    );

    // Persist result back onto the case for future display
    const updatedCases = cases.map((c: any) =>
      c.id === req.params.caseId ? { ...c, lastResult: result } : c,
    );
    fs.writeFileSync(casesPath, JSON.stringify(updatedCases, null, 2), 'utf-8');

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.post('/:id/test/cases', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { name, task, structuralChecks, behavioralCriteria } = req.body as {
      name?: string;
      task?: string;
      structuralChecks?: any[];
      behavioralCriteria?: string;
    };
    if (!task?.trim())
      return res.status(400).json({ error: 'task is required' });

    const casesPath = path.join(
      AGENTS_DIR,
      req.params.id,
      'test-results',
      'custom-cases.json',
    );
    fs.mkdirSync(path.dirname(casesPath), { recursive: true });

    const existing: any[] = fs.existsSync(casesPath)
      ? JSON.parse(fs.readFileSync(casesPath, 'utf-8'))
      : [];

    const newCase = {
      id: randomUUID(),
      name: name ?? `case-${existing.length + 1}`,
      task: task.trim(),
      structuralChecks: structuralChecks ?? [],
      behavioralCriteria: behavioralCriteria ?? '',
      createdAt: new Date().toISOString(),
    };
    existing.push(newCase);
    fs.writeFileSync(casesPath, JSON.stringify(existing, null, 2), 'utf-8');

    res.status(201).json(newCase);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Output file serving (Phase 4) ───────────────────────────────────────────
// Sidecar tools write binary outputs (video, images, PDFs) to workspace/output/.
// These endpoints serve them to the dashboard for inline rendering.

// NOTE (2026-09-02 audit): the two consumers of this map decide inline-vs-attachment by
// testing `mimeType.startsWith('image/')`. That means adding an entry here is enough to
// change a file's disposition — adding `.svg` would silently make SVGs render as
// top-level documents on this origin. guardFileResponse() below is what keeps that from
// being an XSS if it ever happens; do not remove it on the grounds that this map looks
// harmless today.
const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

agentsRouter.get('/:id/outputs', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const outputDir = path.join(AGENTS_DIR, req.params.id, 'output');
    if (!fs.existsSync(outputDir)) return res.json({ files: [] });

    const files = fs
      .readdirSync(outputDir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const stat = fs.statSync(path.join(outputDir, f));
        const ext = path.extname(f).toLowerCase();
        return {
          name: f,
          size: stat.size,
          mimeType: MIME_MAP[ext] ?? 'application/octet-stream',
          createdAt: (stat.birthtime.getTime() > 0
            ? stat.birthtime
            : stat.mtime
          ).toISOString(),
          url: `/api/agents/${req.params.id}/outputs/${encodeURIComponent(f)}`,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

agentsRouter.get('/:id/outputs/:filename', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const filename = decodeURIComponent(req.params.filename);
    const outputDir = path.join(AGENTS_DIR, req.params.id, 'output');
    const filePath = path.join(outputDir, filename);

    // Prevent path traversal
    if (!filePath.startsWith(outputDir + path.sep) && filePath !== outputDir) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'File not found' });

    const ext = path.extname(filename).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
    const stat = fs.statSync(filePath);

    // Inline for video/audio/image so browser renders them; attachment for everything else
    const isInline =
      mimeType.startsWith('video/') ||
      mimeType.startsWith('audio/') ||
      mimeType.startsWith('image/');
    guardFileResponse(res, mimeType);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `${isInline ? 'inline' : 'attachment'}; filename="${filename}"`,
    );
    res.setHeader('Accept-Ranges', 'bytes');

    // Support range requests so video/audio players can seek
    const range = req.headers.range;
    if (range && isInline) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = Math.min(
        endStr ? parseInt(endStr, 10) : stat.size - 1,
        stat.size - 1,
      );
      if (isNaN(start) || start >= stat.size || start > end) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      const chunk = end - start + 1;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunk);
      res.status(206);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/artifacts ───────────────────────────────────────────
// Returns artifacts.json written by emit_artifact tool during cycles.

agentsRouter.get('/:id/artifacts', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const manifestPath = path.join(
      AGENTS_DIR,
      req.params.id,
      'workspace',
      'artifacts.json',
    );
    if (!fs.existsSync(manifestPath)) return res.json({ artifacts: [] });

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const artifacts = (manifest.artifacts ?? []).map((a: any) => ({
      ...a,
      // Resolve a serve URL for the file based on its type/location
      url: `/api/agents/${req.params.id}/artifacts/${a.id}/file`,
    }));

    // Most recent first
    artifacts.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
    res.json({ artifacts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agents/:id/artifacts/:artifactId/file ─────────────────────────
// Serve the artifact's actual file content.

agentsRouter.get('/:id/artifacts/:artifactId/file', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const manifestPath = path.join(
      AGENTS_DIR,
      req.params.id,
      'workspace',
      'artifacts.json',
    );
    if (!fs.existsSync(manifestPath))
      return res.status(404).json({ error: 'No artifacts' });

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const artifact = (manifest.artifacts ?? []).find(
      (a: any) => a.id === req.params.artifactId,
    );
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

    // Resolve the physical file path.
    // Artifacts stored in the project shared workspace use the absolute container
    // path /workspace/shared/... which maps to PROJECTS_DIR/{projectId}/workspace/.
    // All other artifacts are relative to the agent's own workspace dir.
    let filePath: string;
    let safeRoot: string;

    const sharedPrefix = '/workspace/shared/';
    if (artifact.file.startsWith(sharedPrefix)) {
      // Look up which project this cycle belonged to
      const cycle = artifact.cycleId
        ? getAgentCycleById(artifact.cycleId)
        : null;
      const projectId = cycle?.project_id;
      if (!projectId)
        return res.status(404).json({ error: 'File not found on disk' });
      safeRoot = path.join(PROJECTS_DIR, projectId, 'workspace');
      const relative = artifact.file.slice(sharedPrefix.length);
      filePath = path.join(safeRoot, relative);
    } else {
      safeRoot = path.join(AGENTS_DIR, req.params.id);
      filePath = path.join(safeRoot, artifact.file);
    }

    // Prevent path traversal
    if (!filePath.startsWith(safeRoot + path.sep)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'File not found on disk' });

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const filename = path.basename(filePath);

    const isInline =
      mimeType.startsWith('video/') ||
      mimeType.startsWith('audio/') ||
      mimeType.startsWith('image/') ||
      mimeType === 'text/html';
    guardFileResponse(res, mimeType);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `${isInline ? 'inline' : 'attachment'}; filename="${filename}"`,
    );
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range && isInline) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = Math.min(
        endStr ? parseInt(endStr, 10) : stat.size - 1,
        stat.size - 1,
      );
      if (isNaN(start) || start >= stat.size || start > end) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      res.status(206);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Skills ───────────────────────────────────────────────────────────────────
// Two sources, mirroring how tools split into built-in vs generated:
//   • authored — data/agents/{id}/skills/{name}/SKILL.md (agent's own, via save_skill)
//   • builtin  — nanobot/skills/{name}/SKILL.md (ship-with-the-runtime, available to every agent)
// Both are reusable how-to docs the agent loads as context (chat + cycles).
//
// `dir` is the on-disk directory name and `name` is the display name from
// frontmatter, which are not always the same. The Stage 42 provenance sidecar is
// keyed by directory name (save_skill's sanitised `safe_name`), so telemetry must
// join on `dir` — joining on `name` silently finds nothing for any skill whose
// frontmatter renames it.
interface SkillEntry {
  name: string;
  dir: string;
  description: string;
  category: string;
  always: boolean;
  content: string;
  updatedAt: string;
  source: 'authored' | 'builtin';
  telemetry?: SkillTelemetry;
}

function readSkillsFrom(
  dir: string,
  source: 'authored' | 'builtin',
): SkillEntry[] {
  if (!fs.existsSync(dir)) return [];
  const out: SkillEntry[] = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      !dirent.isDirectory() ||
      dirent.name.startsWith('__') ||
      dirent.name.startsWith('.')
    )
      continue;
    const skillFile = path.join(dir, dirent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let content: string;
    try {
      content = fs.readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }

    // Optional YAML frontmatter may carry `description:` / `name:` / `always:`.
    // Tolerate CRLF and a leading BOM (built-in skills ship with CRLF line endings).
    let always = false,
      fmDesc = '',
      fmName = '',
      fmCat = '',
      body = content;
    const fm = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      const f = fm[1];
      always = /always:\s*true/i.test(f);
      fmDesc = (
        f.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? ''
      ).trim();
      fmName = (f.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? '').trim();
      fmCat = (f.match(/^category:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? '').trim();
      body = content.slice(fm[0].length);
    }
    // Category: prefer frontmatter; else infer from the flattened dir name's known prefix.
    let category = fmCat;
    if (!category) {
      const KNOWN = [
        'autonomous-ai-agents',
        'smart-home',
        'social-media',
        'software-development',
        'data-science',
        'note-taking',
        'red-teaming',
        'web-development',
      ];
      const pre = KNOWN.find((k) => dirent.name.startsWith(k + '-'));
      category =
        pre ||
        (dirent.name.includes('-') ? dirent.name.split('-')[0] : 'general');
    }
    let description = fmDesc;
    if (!description) {
      for (const raw of body.split('\n')) {
        const line = raw
          .replace(/^#+\s*/, '')
          .replace(/^#\s*Skill:\s*/i, '')
          .trim();
        if (line) {
          description = line;
          break;
        }
      }
    }
    out.push({
      name: fmName || dirent.name,
      dir: dirent.name,
      description: description.slice(0, 220),
      category,
      always,
      content,
      updatedAt: fs.statSync(skillFile).mtime.toISOString(),
      source,
    });
  }
  return out;
}

agentsRouter.get('/:id/skills', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const agentRoot = path.join(AGENTS_DIR, req.params.id);

    // Two locations, current first. save_skill writes to <agentRoot>/skills
    // (the container's /workspace/group) but this endpoint used to read only
    // <agentRoot>/workspace/skills, so anything the agent authored was invisible
    // here. Both are read now; on a directory-name collision the current one wins.
    const seen = new Set<string>();
    const authored: SkillEntry[] = [];
    for (const dir of authoredSkillDirs(agentRoot)) {
      for (const entry of readSkillsFrom(dir, 'authored')) {
        if (seen.has(entry.dir)) continue;
        seen.add(entry.dir);
        authored.push(entry);
      }
    }

    const builtinDir =
      process.env.NANOBOT_BUILTIN_SKILLS_DIR || '/nanoagent/nanoagent/skills';
    const builtin = readSkillsFrom(builtinDir, 'builtin');

    // Stage 42 learning-loop state. This covers BOTH sources: skill_origins
    // records a use wherever a skill reaches the model, and in practice most
    // usage so far is on built-ins. Attaching telemetry to authored skills only
    // would report zero uses on an agent whose sidecar counts dozens.
    const origins = readOrigins(agentRoot);
    const archived = readArchived(agentRoot);
    // Attached only where the sidecar actually has an entry. A skill with no
    // entry has no history — rendering a default "never used, origin unknown"
    // row for every untouched built-in would be noise, not information.
    for (const entry of [...authored, ...builtin]) {
      const o = origins[entry.dir];
      if (o) entry.telemetry = telemetryFor(o);
    }

    // Summarised over both sources for the same reason, de-duplicated because a
    // built-in and an authored skill can share a directory name.
    const allDirs = [...new Set([...authored, ...builtin].map((s) => s.dir))];

    const sort = (a: SkillEntry, b: SkillEntry) => a.name.localeCompare(b.name);
    const ordered = [...authored.sort(sort), ...builtin.sort(sort)];

    // Bodies are dropped by default. The list renders name/description/telemetry;
    // only an expanded card needs the markdown, and shipping all of it made this
    // the largest response in the app — measured at 2.4MB on prod for 203 built-in
    // skills, on every visit to the tab. The UI fetches one body on expand via
    // /skills/:dir/content. `?full=1` restores the old shape for any caller that
    // genuinely wants everything at once.
    const full = req.query.full === '1' || req.query.full === 'true';
    const skills = full
      ? ordered
      : ordered.map(({ content: _content, ...rest }) => rest);

    res.json({
      skills,
      authored: authored.length,
      builtin: builtin.length,
      archived,
      summary: summarise(agentRoot, allDirs),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Mutation history for the agent's skills — who changed what, when, from where.
// Read-only on purpose: rollback and archiving stay inside the container so the
// host never writes into a workspace a cycle may be using.
agentsRouter.get('/:id/skills/ledger', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    const entries = readLedger(path.join(AGENTS_DIR, req.params.id), limit);
    res.json({ entries, count: entries.length, limit });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// One ledger entry with its before/after bodies resolved, for a diff view.
agentsRouter.get('/:id/skills/ledger/:entryId', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const entry = readLedgerEntryContents(
      path.join(AGENTS_DIR, req.params.id),
      req.params.entryId,
    );
    if (!entry)
      return res.status(404).json({ error: 'Ledger entry not found' });
    res.json(entry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// One skill's markdown body, fetched when a card is expanded.
//
// Declared AFTER the ledger routes on purpose: Express matches in order, so a skill
// directory literally named "ledger" would otherwise be shadowed by them. That name
// is reserved in practice — save_skill would have to be asked for it by name — and
// losing the history view to a naming collision is the worse trade.
agentsRouter.get('/:id/skills/:dir/content', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // `dir` reaches a path join, and only ever names one directory level. Anything
    // with a separator or a dot-segment is refused rather than resolved.
    const dir = req.params.dir;
    if (
      !/^[A-Za-z0-9._-]+$/.test(dir) ||
      dir.startsWith('.') ||
      dir.includes('..')
    ) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }

    const builtinDir =
      process.env.NANOBOT_BUILTIN_SKILLS_DIR || '/nanoagent/nanoagent/skills';
    const candidates = [
      ...authoredSkillDirs(path.join(AGENTS_DIR, req.params.id)),
      builtinDir,
    ];
    for (const base of candidates) {
      const file = path.join(base, dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      return res.json({
        dir,
        content: fs.readFileSync(file, 'utf-8'),
        source: base === builtinDir ? 'builtin' : 'authored',
      });
    }
    res.status(404).json({ error: 'Skill not found' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dynamic Tool Management ──────────────────────────────────────────────────
// Tools live in data/agents/{id}/tools/ as .py or .js files.
// Each tool has an optional sidecar {name}.json with status metadata.

interface ToolMeta {
  label: string;
  description: string;
  status: 'untested' | 'ok' | 'error' | 'needs_credentials';
  complexity: 'simple' | 'complex';
  requiredCredentials: string[];
  generatedAt: string;
  lastTestedAt: string | null;
  lastTestOutput: string | null;
  lastTestError: string | null;
}

function getToolMeta(toolsDir: string, baseName: string): ToolMeta {
  const metaPath = path.join(toolsDir, `${baseName}.json`);
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ToolMeta;
  } catch {
    return {
      label: baseName,
      description: '',
      status: 'untested',
      complexity: 'simple',
      requiredCredentials: [],
      generatedAt: '',
      lastTestedAt: null,
      lastTestOutput: null,
      lastTestError: null,
    };
  }
}

function saveToolMeta(
  toolsDir: string,
  baseName: string,
  meta: Partial<ToolMeta>,
): void {
  const metaPath = path.join(toolsDir, `${baseName}.json`);
  const existing = getToolMeta(toolsDir, baseName);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ ...existing, ...meta }, null, 2),
    'utf-8',
  );
}

// Tools built by the nanobot tool factory are stored as a DIRECTORY per tool
// (tools/<name>/manifest.yaml + impl.py + src/ + test_results.json), not as a flat
// .py file. Build a dynamic-tool entry from that directory so the UI can list them.
function readDirTool(
  toolsDir: string,
  dirName: string,
):
  | (ToolMeta & {
      name: string;
      ext: 'py' | 'js';
      size: number;
      modifiedAt: string;
      code: string;
    })
  | null {
  const dir = path.join(toolsDir, dirName);
  const manifestPath = path.join(dir, 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }

  const entrypoint: string = manifest.entrypoint || 'implementation.py';
  let code: string = manifest.implementation || '';
  if (!code && manifest.files && typeof manifest.files === 'object')
    code = manifest.files[entrypoint] || '';
  if (!code) {
    try {
      code = fs.readFileSync(path.join(dir, 'impl.py'), 'utf-8');
    } catch {
      /* none */
    }
  }

  const ext: 'py' | 'js' = manifest.language === 'javascript' ? 'js' : 'py';
  const filesCount =
    manifest.files && typeof manifest.files === 'object'
      ? Object.keys(manifest.files).length
      : 1;

  // Derive status from the factory's test_results.json.
  let status: ToolMeta['status'] = 'untested';
  let lastTestedAt: string | null = null;
  let lastTestOutput: string | null = null;
  let lastTestError: string | null = null;
  const trPath = path.join(dir, 'test_results.json');
  if (fs.existsSync(trPath)) {
    try {
      const tr = JSON.parse(fs.readFileSync(trPath, 'utf-8'));
      status = tr.failed > 0 ? 'error' : tr.passed > 0 ? 'ok' : 'untested';
      lastTestedAt = fs.statSync(trPath).mtime.toISOString();
      const results: any[] = Array.isArray(tr.results) ? tr.results : [];
      const failed = results.find((r) => r && r.passed === false);
      const first = results[0];
      lastTestOutput = failed?.actual_output ?? first?.actual_output ?? null;
      lastTestError = failed?.error ?? first?.error ?? null;
    } catch {
      /* leave untested */
    }
  }

  let modifiedAt = new Date().toISOString();
  try {
    modifiedAt = fs.statSync(dir).mtime.toISOString();
  } catch {
    /* keep */
  }

  return {
    name: manifest.name || dirName,
    ext,
    size: Buffer.byteLength(code, 'utf-8'),
    modifiedAt,
    code,
    label: manifest.name || dirName,
    description: manifest.description || '',
    status,
    complexity: filesCount > 1 ? 'complex' : 'simple',
    requiredCredentials: Array.isArray(manifest.required_credentials)
      ? manifest.required_credentials
      : [],
    generatedAt: manifest.created_at || '',
    lastTestedAt,
    lastTestOutput,
    lastTestError,
  };
}

// GET /api/agents/:id/tools/dynamic — list all dynamic tools with metadata
agentsRouter.get('/:id/tools/dynamic', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const toolsDir = path.join(AGENTS_DIR, req.params.id, 'tools');
    if (!fs.existsSync(toolsDir)) return res.json({ tools: [] });

    const entries: any[] = [];
    for (const dirent of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (dirent.isDirectory()) {
        // Tool-factory format: tools/<name>/manifest.yaml + impl.py + src/
        const t = readDirTool(toolsDir, dirent.name);
        if (t) entries.push(t);
      } else if (dirent.name.endsWith('.py') || dirent.name.endsWith('.js')) {
        // Legacy flat-file format: tools/<name>.py + sidecar <name>.json
        const f = dirent.name;
        const baseName = f.replace(/\.(py|js)$/, '');
        const ext = f.endsWith('.py') ? 'py' : 'js';
        const filePath = path.join(toolsDir, f);
        const stat = fs.statSync(filePath);
        const code = fs.readFileSync(filePath, 'utf-8');
        const meta = getToolMeta(toolsDir, baseName);
        entries.push({
          name: baseName,
          ext,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          code,
          ...meta,
        });
      }
    }

    res.json({ tools: entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/agents/:id/tools/dynamic/:name — overwrite tool code, reset status to untested
agentsRouter.put('/:id/tools/dynamic/:name', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { code, ext = 'py' } = req.body as { code: string; ext?: string };
    if (!code) return res.status(400).json({ error: 'code required' });
    if (!['py', 'js'].includes(ext))
      return res.status(400).json({ error: 'ext must be py or js' });

    const toolsDir = path.join(AGENTS_DIR, req.params.id, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });

    const baseName = req.params.name.replace(/\.(py|js)$/, '');
    fs.writeFileSync(path.join(toolsDir, `${baseName}.${ext}`), code, 'utf-8');
    saveToolMeta(toolsDir, baseName, {
      status: 'untested',
      lastTestedAt: null,
      lastTestOutput: null,
      lastTestError: null,
    });

    res.json({ ok: true, name: baseName, ext });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/tools/dynamic/:name/test — syntax check + optional import test
agentsRouter.post('/:id/tools/dynamic/:name/test', async (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const baseName = req.params.name.replace(/\.(py|js)$/, '');
    const toolsDir = path.join(AGENTS_DIR, req.params.id, 'tools');

    // Find the file (.py takes precedence over .js)
    const pyFile = path.join(toolsDir, `${baseName}.py`);
    const jsFile = path.join(toolsDir, `${baseName}.js`);
    const filePath = fs.existsSync(pyFile)
      ? pyFile
      : fs.existsSync(jsFile)
        ? jsFile
        : null;
    if (!filePath)
      return res.status(404).json({ error: 'Tool file not found' });

    const isPython = filePath.endsWith('.py');
    const args =
      req.body?.arguments && typeof req.body.arguments === 'object'
        ? req.body.arguments
        : null;
    // Two modes:
    //   - syntax-check (no args)   → fast static parse, marks tool ok/error
    //   - real-invoke  (args given) → actually runs execute(**args) and returns its output
    const mode: 'syntax' | 'invoke' = args ? 'invoke' : 'syntax';

    const result = await new Promise<{
      ok: boolean;
      output: string;
      error: string;
    }>((resolve) => {
      let cmd: string, spawnArgs: string[];
      if (mode === 'syntax') {
        cmd = isPython ? 'python3' : 'node';
        spawnArgs = isPython
          ? ['-m', 'py_compile', filePath]
          : ['--check', filePath];
      } else if (isPython) {
        // Generate a wrapper that imports the tool module, finds the class with
        // an execute() method, and invokes it. Args are passed as JSON via argv.
        const wrapper = `
import asyncio, json, sys, importlib.util, inspect
spec = importlib.util.spec_from_file_location("__tool__", ${JSON.stringify(filePath)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cls = None
for nm in dir(m):
    obj = getattr(m, nm)
    if isinstance(obj, type) and hasattr(obj, "execute") and not nm.startswith("_"):
        cls = obj; break
if cls is None:
    print("__TOOL_ERROR__: no class with execute() method found", file=sys.stderr); sys.exit(2)
inst = cls()
args = json.loads(sys.argv[1])
out = inst.execute(**args)
if inspect.iscoroutine(out):
    out = asyncio.run(out)
print(out if isinstance(out, str) else json.dumps(out))
`.trim();
        cmd = 'python3';
        spawnArgs = ['-c', wrapper, JSON.stringify(args)];
      } else {
        // .js tool — assume CommonJS export with .execute()
        const wrapper = `
const tool = require(${JSON.stringify(filePath)});
const cls = tool.default || Object.values(tool).find(v => typeof v === "function" && v.prototype && v.prototype.execute);
const inst = typeof cls === "function" ? new cls() : tool;
Promise.resolve(inst.execute(JSON.parse(process.argv[2]))).then(r => console.log(typeof r === "string" ? r : JSON.stringify(r))).catch(e => { console.error(String(e)); process.exit(1); });
`.trim();
        cmd = 'node';
        spawnArgs = ['-e', wrapper, JSON.stringify(args)];
      }

      const child = spawnProcess(cmd, spawnArgs, { timeout: 30000 });
      let stdout = '',
        stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('close', (code) => {
        resolve({
          ok: code === 0,
          output: stdout.trim(),
          error: stderr.trim(),
        });
      });
      child.on('error', (err) => {
        resolve({ ok: false, output: '', error: err.message });
      });
    });

    const newStatus: ToolMeta['status'] = result.ok ? 'ok' : 'error';
    saveToolMeta(toolsDir, baseName, {
      status: newStatus,
      lastTestedAt: new Date().toISOString(),
      lastTestOutput: result.output || null,
      lastTestError: result.error || null,
    });

    res.json({
      ok: result.ok,
      output: result.output,
      error: result.error,
      status: newStatus,
      mode,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/agents/:id/tools/dynamic/:name — remove tool file + sidecar
agentsRouter.delete('/:id/tools/dynamic/:name', (req, res) => {
  try {
    const agent = agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const baseName = req.params.name.replace(/\.(py|js)$/, '');
    const toolsDir = path.join(AGENTS_DIR, req.params.id, 'tools');

    // Tool-factory format: tools/<name>/ is a directory (manifest.yaml + impl.py + src/).
    const toolDir = path.join(toolsDir, baseName);
    if (fs.existsSync(toolDir) && fs.statSync(toolDir).isDirectory()) {
      fs.rmSync(toolDir, { recursive: true, force: true });
    }
    // Legacy flat-file format: tools/<name>.py|.js + sidecar <name>.json
    for (const ext of ['py', 'js']) {
      const f = path.join(toolsDir, `${baseName}.${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    const metaFile = path.join(toolsDir, `${baseName}.json`);
    if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sub-agents ──────────────────────────────────────────────────────────────

/** GET /api/agents/:id/sub-agents — list sub-agents spawned by this agent */
agentsRouter.get('/:id/sub-agents', (req, res) => {
  try {
    res.json(getSubAgents(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Inter-agent messages ─────────────────────────────────────────────────────

/** GET /api/agents/:id/messages?direction=inbox|outbox&limit=50 */
agentsRouter.get('/:id/messages', (req, res) => {
  try {
    const { direction = 'inbox', limit = '50' } = req.query as Record<
      string,
      string
    >;
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const messages =
      direction === 'outbox'
        ? getAgentOutbox(req.params.id, lim)
        : getAgentInbox(req.params.id, lim);
    res.json(messages);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/agents/:id/messages/:msgId/read */
agentsRouter.patch('/:id/messages/:msgId/read', (req, res) => {
  try {
    markAgentMessageRead(req.params.msgId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents/:id/messages/send — send a direct inter-agent message */
agentsRouter.post('/:id/messages/send', (req, res) => {
  const fromAgent = agentService.getAgent(req.params.id);
  if (!fromAgent)
    return res.status(404).json({ error: 'Sender agent not found' });

  const { toAgentId, subject, body } = req.body as {
    toAgentId?: string;
    subject?: string;
    body?: string;
  };
  if (!toAgentId || !subject || !body)
    return res
      .status(400)
      .json({ error: 'toAgentId, subject, and body are required' });
  if (!agentService.getAgent(toAgentId))
    return res
      .status(404)
      .json({ error: `Target agent '${toAgentId}' not found` });

  try {
    const msg = createAgentMessage({
      from_agent_id: req.params.id,
      to_agent_id: toAgentId,
      subject: subject.slice(0, 120),
      body,
    });
    res.status(201).json({ id: msg.id, delivered: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gap 2: On-demand credential fetch ───────────────────────────────────────

/** GET /api/agents/:id/credentials/:service — return stored credential fields (server-side only) */
agentsRouter.get('/:id/credentials/:service', (req, res) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // `browser:*` is an ownerless store of per-person site logins — never serve it to an agent.
  if (String(req.params.service).startsWith('browser:')) {
    return res.status(404).json({
      error: `No credential stored for service '${req.params.service}'`,
    });
  }

  const creds = credentialManager.get(req.params.service);
  if (!creds)
    return res.status(404).json({
      error: `No credential stored for service '${req.params.service}'`,
    });

  // Return fields but never log them
  res.json(creds);
});

// ─── Gap 3: Bulletin board read/update ───────────────────────────────────────

/** GET /api/agents/:id/bulletin — return current project bulletin content */
agentsRouter.get('/:id/bulletin', (req, res) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    const projects = getAgentProjects(req.params.id);
    const projectId = projects[0]?.id;
    if (!projectId)
      return res.json({
        content: null,
        note: 'Agent is not linked to a project',
      });

    const bulletinPath = path.join(
      PROJECTS_DIR,
      projectId,
      'workspace',
      'BULLETIN.md',
    );
    if (!fs.existsSync(bulletinPath)) return res.json({ content: null });
    res.json({ content: fs.readFileSync(bulletinPath, 'utf-8'), projectId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents/:id/bulletin — write agent notes to shared workspace */
agentsRouter.post('/:id/bulletin', (req, res) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { section, content } = req.body as {
    section?: string;
    content?: string;
  };
  if (!section || !content)
    return res.status(400).json({ error: 'section and content are required' });

  try {
    const projects = getAgentProjects(req.params.id);
    const projectId = projects[0]?.id;
    if (!projectId)
      return res
        .status(400)
        .json({ error: 'Agent is not linked to a project' });

    const notesPath = path.join(
      PROJECTS_DIR,
      projectId,
      'workspace',
      `notes_${req.params.id}.md`,
    );
    const header = `## ${section} (${agent.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')})\n\n`;
    fs.appendFileSync(notesPath, header + content + '\n\n', 'utf-8');

    const version = fs.readFileSync(notesPath, 'utf-8').split('## ').length - 1;
    res.json({ updated: true, version });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mid-cycle notifications ──────────────────────────────────────────────────

/** POST /api/agents/:id/notify — agent pushes an urgent mid-cycle notification */
agentsRouter.post('/:id/notify', async (req, res) => {
  const agent = agentService.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const {
    message,
    urgency = 'normal',
    cycleId,
  } = req.body as {
    message?: string;
    urgency?: 'normal' | 'high' | 'critical';
    cycleId?: string;
  };
  if (!message) return res.status(400).json({ error: 'message is required' });

  const timestamp = new Date().toISOString();

  // Emit to dashboard SSE subscribers
  globalEventBus.emit_agent({
    type: 'notification',
    agentId: req.params.id,
    cycleId,
    message: message.slice(0, 500),
    urgency,
    timestamp,
  });

  // Persist as a notification record
  notify(
    'agent_alert',
    `${agent.name}: ${urgency} alert`,
    message.slice(0, 500),
    req.params.id,
    { urgency, cycleId },
  );

  const channel = 'dashboard';
  res.json({ sent: true, channel, timestamp });
});

/** Expose the service singleton so other modules (scheduler, etc.) can share it */
export { agentService };
