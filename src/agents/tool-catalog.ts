/**
 * Unified tool catalog.
 *
 * One place to discover every tool an agent has access to, across:
 *   - Chat runtime (TS, in-process)        → 9 built-ins
 *   - Cycle runtime (Python, nanobot)      → ~53 built-ins
 *   - Per-agent generated tools            → from workspace/tools/*.json
 *   - MCP servers                          → from data/mcp-servers.json
 *
 * Used by GET /api/agents/:id/tools/inventory to render the Tools tab.
 *
 * The chat list is derived from the actual runtime arrays so it stays in sync.
 * The cycle list is hand-maintained — Python tools live in another process, so
 * we keep a frozen mirror of nanobot's loop.py registration. If a new Python
 * tool is added, append it here too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  getServersForAgent,
  type McpServerConfig,
} from './runtime/mcp-config.js';

export type ToolRuntime = 'chat' | 'cycle' | 'both';
export type ToolSource = 'builtin' | 'dynamic' | 'mcp';

export type ToolTier = 'sandbox' | 'sidecar';

export interface CatalogTool {
  name: string;
  description: string;
  category: string;
  runtime: ToolRuntime;
  source: ToolSource;
  // Phase 0 (stage25): unified execution model. 'sandbox' = isolated subprocess,
  // 'sidecar' = per-agent Docker container. Mirrors ToolManifest.tier on the nanobot side.
  tier?: ToolTier;
  requiresSidecar?: boolean;
  requiresCredential?: string[];
  // Phase 5b (stage25): tool quality, surfaced to the operator.
  testStatus?: 'passed' | 'failed' | 'untested'; // creation/eval-time test_cases result
  health?: { status: string; successRate: number; totalCalls: number }; // runtime (Phase 5a)
}

// ─── Cycle (Python) tool inventory ────────────────────────────────────────────
// Frozen mirror of nanoagent/nanobot/agent/loop.py _register_default_tools().
// Names match what the Python registry exposes to the LLM.

export const CYCLE_BUILTINS: CatalogTool[] = [
  // Filesystem
  {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    category: 'Filesystem',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the workspace.',
    category: 'Filesystem',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'append_file',
    description: 'Append content to an existing file.',
    category: 'Filesystem',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'edit_file',
    description: 'Targeted string replacement edit on a file.',
    category: 'Filesystem',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'list_dir',
    description: 'List entries in a directory.',
    category: 'Filesystem',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Execution
  {
    name: 'exec',
    description: 'Execute a shell command in the workspace.',
    category: 'Execution',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'python_repl',
    description: 'Run Python code in a persistent REPL session.',
    category: 'Execution',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Web
  {
    name: 'web_search',
    description: 'Web search via Brave Search API.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'web_fetch',
    description: 'Fetch and parse a URL as readable text.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'web_map',
    description:
      "List a site's URLs in one call, optionally filtered by keyword.",
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'browser',
    description: 'Headless browser automation (navigate, click, type).',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'url_check',
    description: 'Verify a URL is reachable before citing it.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'http_request',
    description: 'Generic REST API call to any URL.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Search (injection-safe)
  {
    name: 'glob_search',
    description: 'Find files by glob pattern.',
    category: 'Search',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'grep_search',
    description: 'Grep workspace content with regex.',
    category: 'Search',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'search_memory',
    description: "Search the agent's persistent memory.",
    category: 'Search',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'append_memory',
    description: 'Save a durable fact/lesson to persistent memory.',
    category: 'Memory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'search_crew_memory',
    description: 'FTS5 search across all agents on the current project crew.',
    category: 'Memory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'save_skill',
    description:
      'Persist a reusable skill playbook to workspace/skills/ for future sessions.',
    category: 'Skills',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'skill_search',
    description: 'Find relevant skill playbooks on demand (lazy skills).',
    category: 'Skills',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'session_search',
    description: "Search the agent's own past session transcripts.",
    category: 'Memory',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Planning / control
  {
    name: 'todo_write',
    description: "Manage the agent's in-cycle todo list.",
    category: 'Planning',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'enter_plan_mode',
    description: 'Enter a constrained planning-only mode.',
    category: 'Planning',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'exit_plan_mode',
    description: 'Exit planning mode and resume execution.',
    category: 'Planning',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'sleep',
    description: 'Pause the agent for a number of seconds.',
    category: 'Planning',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Output / artifacts
  {
    name: 'emit_artifact',
    description: 'Register a workspace file as a cycle artifact.',
    category: 'Output',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Messaging / agent comm
  {
    name: 'message',
    description: 'Send an outbound message via a channel.',
    category: 'Messaging',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'notify',
    description: 'Send a notification to the operator.',
    category: 'Messaging',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'handoff_to',
    description: 'Hand off the current task to another agent.',
    category: 'Messaging',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'send_message_to_agent',
    description: 'DM another agent in the crew.',
    category: 'Messaging',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Context / knowledge
  {
    name: 'extract_context',
    description: 'Extract structured context from text/files.',
    category: 'Knowledge',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'search_knowledge',
    description: "Search the agent's knowledge base.",
    category: 'Knowledge',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Media
  {
    name: 'read_image',
    description: 'Read and describe an image file via the LLM.',
    category: 'Media',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'read_pdf',
    description: 'Extract text content from a PDF.',
    category: 'Media',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Code / data
  {
    name: 'git',
    description: 'Run git commands in the workspace.',
    category: 'Code',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'sql_query',
    description: 'Run a SQL query against configured databases.',
    category: 'Code',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'github_api',
    description: 'GitHub REST API: repos, issues, PRs, comments, branches.',
    category: 'Code',
    runtime: 'cycle',
    source: 'builtin',
    requiresCredential: ['github'],
  },
  {
    name: 'test_runner',
    description:
      'Run project test suites and return structured pass/fail results.',
    category: 'Code',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Credentials
  {
    name: 'get_credential',
    description: 'Retrieve a stored credential by name.',
    category: 'Credentials',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Bulletin board
  {
    name: 'read_bulletin',
    description: 'Read shared bulletin board entries.',
    category: 'Bulletin',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'update_bulletin',
    description: 'Post or update a bulletin entry.',
    category: 'Bulletin',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Webhooks
  {
    name: 'register_webhook',
    description: 'Register a webhook endpoint to trigger this agent.',
    category: 'Integration',
    runtime: 'cycle',
    source: 'builtin',
  },

  // HITL approval layer
  // These are registered unconditionally by loop.py's _register_default_tools() but were
  // missing from this mirror, so naming one in an agent's config.tools made the readiness
  // check report it as an unknown tool. Seeker had no approval route at all as a result.
  {
    name: 'request_approval',
    description:
      'Surface a draft for human approval before firing a real-world action.',
    category: 'HITL',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'clarify',
    description: 'Ask the owner a specific question, with options, and stop.',
    category: 'HITL',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Self-management + owner messaging
  {
    name: 'self_manage',
    description:
      "Inspect and change this agent's own schedule, model, budget, or status.",
    category: 'Meta',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'send_whatsapp',
    description: "Send a WhatsApp message to the owner's linked chat.",
    category: 'Messaging',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Skills / self-reporting
  {
    name: 'curate_skills',
    description: "Prune and consolidate the agent's saved skill playbooks.",
    category: 'Skills',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'usage_report',
    description: "Report this agent's own tool-usage telemetry.",
    category: 'Meta',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Effector (browser/computer use)
  {
    name: 'effector',
    description: 'Drive a real browser to complete a goal end-to-end.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'effector_workflow',
    description: 'Run a recorded multi-step browser workflow.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'effector_swarm',
    description: 'Run several browser tasks in parallel.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'effector_escalate',
    description: 'Escalate a stuck browser task to a stronger model.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'learn_from_recording',
    description: 'Turn a recorded browser session into a replayable workflow.',
    category: 'Web',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Tool discovery + MCP browsing
  {
    name: 'tool_search',
    description: 'Search for tools by keyword (deferred catalog).',
    category: 'Meta',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'mcp_auth',
    description: 'Authenticate an MCP server.',
    category: 'Meta',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'list_mcp_resources',
    description: 'List resources exposed by attached MCP servers.',
    category: 'Meta',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'read_mcp_resource',
    description: 'Read an MCP resource by URI.',
    category: 'Meta',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Dynamic tool factory
  {
    name: 'generate_tool',
    description: 'Generate a new dynamic tool from a description.',
    category: 'Tool factory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'register_tool_from_dir',
    description:
      'Register a tool the agent built itself in a workspace folder (the coding-loop path).',
    category: 'Tool factory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'update_tool',
    description: "Update an existing dynamic tool's code.",
    category: 'Tool factory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'rollback_tool',
    description: 'Roll a dynamic tool back to a prior version.',
    category: 'Tool factory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'list_tools',
    description: 'List all tools currently available to the agent.',
    category: 'Tool factory',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'remove_tool',
    description: 'Delete a dynamic tool from the agent.',
    category: 'Tool factory',
    runtime: 'cycle',
    source: 'builtin',
  },

  // External services
  {
    name: 'gmail_send',
    description: 'Send an email via Gmail.',
    category: 'External',
    runtime: 'cycle',
    source: 'builtin',
    requiresCredential: ['gmail'],
  },
  {
    name: 'gmail_replies',
    description: 'Fetch recent Gmail replies.',
    category: 'External',
    runtime: 'cycle',
    source: 'builtin',
    requiresCredential: ['gmail'],
  },
  // No requiresCredential: uses a per-agent app-password mailbox (Seeker's own feature),
  // not the standard credential-catalog mechanism the other External tools rely on.
  {
    name: 'smtp_send',
    description: 'Send an email via a per-agent SMTP app-password mailbox.',
    category: 'External',
    runtime: 'cycle',
    source: 'builtin',
  },
  {
    name: 'hn_search',
    description: 'Search Hacker News.',
    category: 'External',
    runtime: 'cycle',
    source: 'builtin',
  },
  // No requiresCredential: the source is public and unauthenticated. Requests are paced at
  // one every 5s to honour its robots.txt, so a sweep takes minutes by design.
  // No requiresCredential: reads old.reddit.com's public RSS. The official API needs no
  // key from us either — it is unreachable from prod (oauth.reddit.com 403s), which is
  // why this uses the feed. Rate-limited hard, so sweeps retry with backoff.
  {
    name: 'deploy_check',
    description:
      'Poll a deployed URL until it serves a marker unique to the new build — confirms a push actually went live rather than trusting an HTTP 200, which the old version returns too.',
    category: 'Code',
    runtime: 'cycle',
    source: 'builtin',
  },

  // Cron (conditional — only registered if a cron service is wired in)
  {
    name: 'cron',
    description: 'Manage recurring schedules from inside the cycle.',
    category: 'Planning',
    runtime: 'cycle',
    source: 'builtin',
  },
];

// ─── Chat (TS) tool inventory ─────────────────────────────────────────────────
// Pulled directly from the runtime arrays so it stays in lock-step with code.

// ─── Per-agent inventory ──────────────────────────────────────────────────────

interface DynamicToolMeta {
  name?: string;
  label?: string;
  description?: string;
  tier?: ToolTier;
  requiresSidecar?: boolean;
  requiredCredentials?: string[];
  status?: string;
}

// Phase 5a/5b — runtime health, persisted by ToolHealthMonitor at tools/_health.json.
function readHealthMap(
  toolsDir: string,
): Record<string, { status: string; successRate: number; totalCalls: number }> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(toolsDir, '_health.json'), 'utf-8'),
    );
    const out: Record<
      string,
      { status: string; successRate: number; totalCalls: number }
    > = {};
    for (const [name, h] of Object.entries(raw as Record<string, any>)) {
      out[name] = {
        status: h?.status ?? 'healthy',
        successRate: h?.success_rate ?? 1,
        totalCalls: h?.total_calls ?? 0,
      };
    }
    return out;
  } catch {
    return {};
  } // no health yet (tool never run) — fine
}

// Creation/eval-time test result a factory tool persists at <name>/test_results.json.
function readFactoryTestStatus(dirPath: string): CatalogTool['testStatus'] {
  try {
    const r = JSON.parse(
      fs.readFileSync(path.join(dirPath, 'test_results.json'), 'utf-8'),
    );
    return r?.all_passed ? 'passed' : 'failed';
  } catch {
    return 'untested';
  }
}

function readDynamicTools(agentId: string): CatalogTool[] {
  const toolsDir = path.join(DATA_DIR, 'agents', agentId, 'tools');
  if (!fs.existsSync(toolsDir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(toolsDir);
  } catch {
    return [];
  }

  const jsonNames = new Set(
    files
      .filter((f) => f.endsWith('.json') && f !== '_health.json')
      .map((f) => f.slice(0, -5)),
  );
  const health = readHealthMap(toolsDir);

  const result: CatalogTool[] = [];
  for (const name of jsonNames) {
    let meta: DynamicToolMeta = {};
    try {
      meta = JSON.parse(
        fs.readFileSync(path.join(toolsDir, `${name}.json`), 'utf-8'),
      ) as DynamicToolMeta;
    } catch {
      /* malformed — treat as empty */
    }

    // Everything runs in the nanobot cycle now (the in-process chat runtime was
    // removed). A dynamic tool is a Python .py loaded by the cycle, optionally
    // proxied to the agent's Python sidecar (requiresSidecar) for heavy deps.
    result.push({
      name,
      description: meta.description ?? meta.label ?? '(no description)',
      category: 'Generated',
      runtime: 'cycle',
      source: 'dynamic',
      // Prefer explicit tier; fall back to deriving it from the legacy requiresSidecar flag.
      tier: meta.tier ?? (meta.requiresSidecar ? 'sidecar' : 'sandbox'),
      requiresSidecar: !!meta.requiresSidecar,
      requiresCredential: meta.requiredCredentials,
      testStatus: (meta.status as CatalogTool['testStatus']) ?? 'untested',
      health: health[name],
    });
  }

  // Tool-factory format: tools/<name>/manifest.yaml (+ impl.py, src/). These are Python
  // tools loaded by nanobot in the CYCLE runtime. Skip names already seen via legacy sidecars.
  const seen = new Set(result.map((r) => r.name));
  for (const dirent of files) {
    const dirPath = path.join(toolsDir, dirent);
    let isDir = false;
    try {
      isDir = fs.statSync(dirPath).isDirectory();
    } catch {
      /* skip */
    }
    if (!isDir) continue;
    const manifestPath = path.join(dirPath, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: any = {};
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }
    const name = manifest.name || dirent;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      description: manifest.description || '(no description)',
      category: 'Generated',
      runtime: 'cycle',
      source: 'dynamic',
      // Factory manifests carry tier directly (ToolManifest.tier); default sandbox.
      tier: manifest.tier === 'sidecar' ? 'sidecar' : 'sandbox',
      requiresSidecar: manifest.tier === 'sidecar',
      requiresCredential: Array.isArray(manifest.required_credentials)
        ? manifest.required_credentials
        : undefined,
      testStatus: readFactoryTestStatus(dirPath),
      health: health[name],
    });
  }
  return result;
}

function readMcpServers(agentId: string): Array<{
  id: string;
  server: string;
  transport: string;
  enabled: boolean;
  scope: 'global' | 'agent-specific';
}> {
  // getServersForAgent already applies enabled + owner + agentIds scoping — reuse it
  // instead of re-filtering here, so this view can never drift from the enforced rules.
  let servers: McpServerConfig[] = [];
  try {
    servers = getServersForAgent(agentId);
  } catch {
    /* mcp store not initialized */
  }

  const out: Array<{
    id: string;
    server: string;
    transport: string;
    enabled: boolean;
    scope: 'global' | 'agent-specific';
  }> = [];
  for (const s of servers) {
    const scope = Array.isArray(s.agentIds) ? s.agentIds : [];
    out.push({
      id: s.id,
      server: s.name,
      transport: s.transport,
      enabled: s.enabled !== false,
      scope: scope.length > 0 ? 'agent-specific' : 'global',
    });
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AgentToolInventory {
  summary: {
    total: number;
    cycle: number;
    dynamic: number;
    mcpServers: number;
  };
  cycle: CatalogTool[];
  dynamic: CatalogTool[];
  mcp: Array<{
    id: string;
    server: string;
    transport: string;
    enabled: boolean;
    scope: 'global' | 'agent-specific';
  }>;
}

// There is one execution runtime: the grounded nanobot cycle. (The in-process TS
// "chat" runtime was removed — every message now runs as a cycle.) So the inventory
// reports cycle built-ins + this agent's generated tools + MCP servers.
export function getAgentToolInventory(agentId: string): AgentToolInventory {
  const cycle = CYCLE_BUILTINS;
  const dynamic = readDynamicTools(agentId);
  const mcp = readMcpServers(agentId);

  return {
    summary: {
      total: cycle.length + dynamic.length,
      cycle: cycle.length,
      dynamic: dynamic.length,
      mcpServers: mcp.length,
    },
    cycle,
    dynamic,
    mcp,
  };
}
