/**
 * Tool Generator — proposes and generates custom Python tools at agent creation time.
 *
 * Two-phase approach:
 *   1. proposeTools()  — one LLM call → returns structured tool specs (fast, < 3s)
 *   2. generateAgentTools() — one LLM call per approved tool → writes Python files
 *
 * Generated files land in data/agents/{id}/tools/{name}.py and are picked up
 * at runtime by load_workspace_tools() in the nanobot container (Gap 5).
 */

import fs from 'fs';
import path from 'path';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { resolveInternalModel } from '../services/model-router.js';
import type { TrackerSchema } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemDependencies {
  pythonPackages: string[]; // pip-installable packages, e.g. ["manim==0.18.0", "pillow"]
  aptPackages: string[]; // apt-installable system packages, e.g. ["ffmpeg", "texlive-full"]
  baseImage?: string; // override default python:3.12-slim only for GPU/specialist tools
}

export interface ProposedTool {
  id: string; // kebab-case unique ID (e.g. "crypto-price-fetch")
  name: string; // snake_case python name (e.g. "crypto_price_fetch")
  label: string; // human label (e.g. "Crypto Price Fetcher")
  description: string; // one sentence what it does
  category: string; // data / notify / search / write / finance / social
  rationale: string; // why this agent needs this tool
  requiredCredentials: string[]; // service names: "apollo", "gmail", "none", etc.
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  systemDependencies?: SystemDependencies; // absent = fetch-only tool, runs in-process
}

// ─── LLM helpers (non-streaming, JSON output) ────────────────────────────────

function readLLMKeys() {
  const f = readEnvFile([
    'GROQ_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_KIMI_API_KEY',
    'GEMINI_API_KEY',
  ]);
  return {
    groq: process.env.GROQ_API_KEY || f['GROQ_API_KEY'] || '',
    deepseek: process.env.DEEPSEEK_API_KEY || f['DEEPSEEK_API_KEY'] || '',
    moonshot:
      process.env.MOONSHOT_KIMI_API_KEY || f['MOONSHOT_KIMI_API_KEY'] || '',
    gemini: process.env.GEMINI_API_KEY || f['GEMINI_API_KEY'] || '',
  };
}

async function callOpenAICompat(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok)
    throw new Error(`${endpoint} ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGemini(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  agentId?: string,
): Promise<string> {
  // Model-router-governed first: same litellm-proxy + Settings->Models precedence
  // every other internal-writing call site now uses (see resolveInternalModel's
  // docstring). Falls back to the direct-provider waterfall below only when the
  // proxy isn't configured, so a key-only local/dev setup keeps working unchanged.
  const proxyUrl = process.env.LITELLM_PROXY_URL || '';
  const proxyKey = process.env.LITELLM_PROXY_KEY;
  if (proxyUrl && proxyKey) {
    const resolvedModel = resolveInternalModel(agentId, 'tool_proposal');
    try {
      return await callOpenAICompat(
        `${proxyUrl}/v1/chat/completions`,
        proxyKey,
        resolvedModel,
        systemPrompt,
        userPrompt,
        maxTokens,
      );
    } catch (err) {
      logger.warn(
        { err, resolvedModel },
        'tool-generator: litellm proxy call failed — falling back to direct-provider waterfall',
      );
      // fall through to the waterfall below
    }
  }

  const keys = readLLMKeys();

  const providers: Array<() => Promise<string>> = [
    () =>
      keys.groq
        ? callOpenAICompat(
            'https://api.groq.com/openai/v1/chat/completions',
            keys.groq,
            'llama-3.3-70b-versatile',
            systemPrompt,
            userPrompt,
            maxTokens,
          )
        : Promise.reject(new Error('No GROQ_API_KEY')),
    () =>
      keys.deepseek
        ? callOpenAICompat(
            'https://api.deepseek.com/chat/completions',
            keys.deepseek,
            'deepseek-v4-flash',
            systemPrompt,
            userPrompt,
            maxTokens,
          )
        : Promise.reject(new Error('No DEEPSEEK_API_KEY')),
    () =>
      keys.moonshot
        ? callOpenAICompat(
            'https://api.moonshot.cn/v1/chat/completions',
            keys.moonshot,
            'moonshot-v1-8k',
            systemPrompt,
            userPrompt,
            maxTokens,
          )
        : Promise.reject(new Error('No MOONSHOT_KIMI_API_KEY')),
    () =>
      keys.gemini
        ? callGemini(keys.gemini, systemPrompt, userPrompt, maxTokens)
        : Promise.reject(new Error('No GEMINI_API_KEY')),
  ];

  let lastErr: unknown;
  for (const fn of providers) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('No LLM provider available');
}

/** Strip markdown code fences from LLM output. */
function stripFences(text: string): string {
  return text
    .replace(/^```(?:json|python)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();
}

// ─── Phase 1: Propose tools + tracker schema ─────────────────────────────────

export interface ProposeResult {
  tools: ProposedTool[];
  trackerSchema: TrackerSchema;
}

const PROPOSE_SYSTEM = `You are a tool architect for an AI agent platform.
Given an agent's mission, return a JSON object with two keys: "tools" and "trackerSchema".

TOOLS (3-6 proposals):
- Each tool must be genuinely useful for the specific mission
- Prefer tools that fetch external data, send notifications, or write structured files
- Avoid duplicating built-in tools (gmail_send, gmail_check_replies, hn_search, web_search)
- Keep tool names in snake_case, labels in Title Case
- For requiredCredentials, use only: "apollo", "gmail", "twitter", "linkedin", "hunter", or "none"

SYSTEM DEPENDENCIES — declare when a tool needs Python packages or system software:
- If the tool only uses fetch() and JSON, omit systemDependencies entirely (runs faster in-process)
- pythonPackages: pip-installable packages. Pin versions only when critical (e.g. "manim==0.18.0")
- aptPackages: Debian bookworm apt packages needed at the system level
- baseImage: only set when python:3.12-slim won't work (e.g. GPU tools needing nvidia/cuda base)
- Common patterns:
    Manim animations    → pythonPackages: ["manim"], aptPackages: ["ffmpeg", "texlive-full", "libcairo2-dev", "libpango1.0-dev"]
    Data analysis       → pythonPackages: ["pandas", "matplotlib", "scipy"], aptPackages: []
    Image processing    → pythonPackages: ["pillow", "opencv-python"], aptPackages: ["libgl1"]
    PDF generation      → pythonPackages: ["reportlab", "weasyprint"], aptPackages: ["libpango1.0-dev"]
    Audio processing    → pythonPackages: ["pydub", "librosa"], aptPackages: ["ffmpeg"]
    Web scraping        → pythonPackages: ["beautifulsoup4", "playwright"], aptPackages: []
    ML inference        → pythonPackages: ["torch", "transformers"], aptPackages: []
    Video editing       → pythonPackages: ["moviepy"], aptPackages: ["ffmpeg"]
    Pure API fetch      → (no systemDependencies)

TRACKER SCHEMA — the core entity this agent tracks. Infer from mission:
- PhD researcher → Papers (stages: unread, reading, annotated, cited)
- Sales agent → Leads (stages: discovered, contacted, replied, closed)
- Recruiter → Candidates (stages: sourced, screened, interviewing, hired)
- Market researcher → Sources (stages: queued, reading, synthesised, archived)
- Content agent → Posts (stages: idea, drafting, review, published)
- Custom/unknown → Items (stages: todo, in_progress, done)

Return ONLY a valid JSON object with no markdown, no explanation:
{
  "tools": [
    {
      "id": "tool-name-kebab",
      "name": "tool_name_snake",
      "label": "Tool Label",
      "description": "One sentence: what it does and what API/source it uses.",
      "category": "data|notify|search|write|finance|social",
      "rationale": "One sentence: why this specific agent needs this tool.",
      "requiredCredentials": ["none"],
      "parameters": {
        "type": "object",
        "properties": {
          "param_name": { "type": "string", "description": "what it is" }
        },
        "required": ["param_name"]
      },
      "systemDependencies": {
        "pythonPackages": ["package-name"],
        "aptPackages": ["apt-package-name"],
        "baseImage": "python:3.12-slim"
      }
    }
  ],
  "trackerSchema": {
    "name": "Paper",
    "namePlural": "Papers",
    "stages": [
      { "key": "unread",     "label": "Unread",     "color": "#6b7280" },
      { "key": "reading",    "label": "Reading",    "color": "#3b82f6" },
      { "key": "annotated",  "label": "Annotated",  "color": "#8b5cf6" },
      { "key": "cited",      "label": "Cited",      "color": "#22c55e" }
    ],
    "fields": [
      { "key": "title",   "label": "Title",   "type": "text" },
      { "key": "authors", "label": "Authors", "type": "text" },
      { "key": "url",     "label": "URL",     "type": "url"  },
      { "key": "notes",   "label": "Notes",   "type": "text" }
    ]
  }
}`;

export async function proposeTools(
  mission: string,
  context: string,
): Promise<ProposeResult> {
  const userPrompt = `Mission: ${mission}${context ? `\nContext: ${context}` : ''}`;

  const raw = await callLLM(PROPOSE_SYSTEM, userPrompt, 2000);
  const cleaned = stripFences(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }

  const VALID_SERVICES = new Set([
    'apollo',
    'gmail',
    'twitter',
    'linkedin',
    'hunter',
    'none',
  ]);

  // Support both old array format and new object format
  const rawTools: any[] = Array.isArray(parsed) ? parsed : (parsed.tools ?? []);
  const rawSchema: any = parsed.trackerSchema ?? {};

  const tools: ProposedTool[] = rawTools
    .filter((t: any) => t && t.name && t.description)
    .map((t: any) => {
      const sd = t.systemDependencies;
      const hasDeps =
        sd &&
        ((Array.isArray(sd.pythonPackages) && sd.pythonPackages.length > 0) ||
          (Array.isArray(sd.aptPackages) && sd.aptPackages.length > 0));
      return {
        id: t.id || t.name.replace(/_/g, '-'),
        name: t.name,
        label: t.label || t.name,
        description: t.description,
        category: t.category || 'data',
        rationale: t.rationale || '',
        requiredCredentials: Array.isArray(t.requiredCredentials)
          ? t.requiredCredentials.filter((s: string) => VALID_SERVICES.has(s))
          : ['none'],
        parameters: t.parameters || {
          type: 'object',
          properties: {},
          required: [],
        },
        ...(hasDeps
          ? {
              systemDependencies: {
                pythonPackages: Array.isArray(sd.pythonPackages)
                  ? sd.pythonPackages
                  : [],
                aptPackages: Array.isArray(sd.aptPackages)
                  ? sd.aptPackages
                  : [],
                ...(sd.baseImage ? { baseImage: sd.baseImage } : {}),
              },
            }
          : {}),
      };
    });

  const trackerSchema: TrackerSchema = {
    name: rawSchema.name || 'Item',
    namePlural: rawSchema.namePlural || 'Items',
    stages: Array.isArray(rawSchema.stages)
      ? rawSchema.stages.map((s: any) => ({
          key: s.key || s.label?.toLowerCase().replace(/\s+/g, '_') || 'stage',
          label: s.label || s.key || 'Stage',
          color: s.color || '#6b7280',
        }))
      : [
          { key: 'todo', label: 'To Do', color: '#6b7280' },
          { key: 'in_progress', label: 'In Progress', color: '#3b82f6' },
          { key: 'done', label: 'Done', color: '#22c55e' },
        ],
    fields: Array.isArray(rawSchema.fields)
      ? rawSchema.fields.map((f: any) => ({
          key: f.key || f.label?.toLowerCase().replace(/\s+/g, '_') || 'field',
          label: f.label || f.key || 'Field',
          type: ['text', 'url', 'number', 'date'].includes(f.type)
            ? f.type
            : 'text',
        }))
      : [
          { key: 'title', label: 'Title', type: 'text' as const },
          { key: 'notes', label: 'Notes', type: 'text' as const },
        ],
  };

  return { tools, trackerSchema };
}

// ─── Phase 2: Generate Python Tool subclass files ────────────────────────────
// (The former "Phase 2a" generated ESM .js tools for the in-process chat runtime,
//  which has been removed — every message now runs as a nanobot cycle. Dynamic
//  tools are Python (.py) loaded by the cycle, or Python sidecar tools. The JS
//  generator + in-process loader were dead and have been deleted.)

// For fetch-only tools (legacy container runtime)
const GENERATE_SYSTEM = `You are a Python expert generating Tool subclasses for an AI agent.

The Tool base class is:
\`\`\`python
class Tool:
    name: str          # class attribute
    description: str   # class attribute
    parameters: dict   # class attribute — JSON Schema

    async def execute(self, **kwargs) -> str:
        ...  # must return a JSON string
\`\`\`

Rules:
1. Write a single Python file with one class that extends Tool
2. Use class attributes (not properties) for name, description, parameters
3. execute() must be async and return a JSON string (use json.dumps)
4. Only import from: json, re, os, datetime, time, asyncio, httpx, pathlib
5. Handle all exceptions — return json.dumps({"error": str(e)}) on failure
6. For HTTP calls, use httpx.AsyncClient with a timeout
7. No __init__ unless the tool needs no arguments
8. The class name must be the PascalCase version of the tool name

Return ONLY the Python code with no markdown fences.`;

// For sidecar tools — can import any declared package + use subprocess
const GENERATE_SIDECAR_SYSTEM = `You are a Python expert generating Tool subclasses for an AI agent sidecar.
The tool runs inside an isolated Docker container that has all declared packages pre-installed.

The Tool base class is:
\`\`\`python
class Tool:
    name: str
    description: str
    parameters: dict

    async def execute(self, **kwargs) -> str:
        ...  # must return a JSON string
\`\`\`

You also have access to two injected helpers (do NOT import them — they are injected at runtime):
  run_subprocess(cmd: list[str], cwd: str = None) -> str
    Runs a shell command synchronously, streams its stderr lines as progress events,
    and returns combined stdout+stderr as a string. Raises RuntimeError on non-zero exit.

  emit_progress(message: str, percent: int = None) -> None
    Emits a progress event visible to the LLM during long operations.

Rules:
1. One Python file, one class extending Tool
2. execute() is async, returns json.dumps(result)
3. You MAY import any package that was declared in systemDependencies — they are installed
4. You MAY use subprocess via run_subprocess() helper — prefer it over subprocess.run() directly
5. All output files MUST be written to /workspace/output/ — the agent reads them from there
6. Return a JSON object with at minimum: {"status": "ok"} or {"error": "..."}
7. For file-producing tools, include the output path: {"status": "ok", "file": "/workspace/output/..."}
8. Handle all exceptions — return json.dumps({"error": str(e)}) on failure
9. The class name must be the PascalCase version of the tool name

Return ONLY the Python code with no markdown fences.`;

async function generateToolFile(
  tool: ProposedTool,
  agentId?: string,
): Promise<string> {
  const className = tool.name
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  const isSidecar = !!(
    tool.systemDependencies &&
    ((tool.systemDependencies.pythonPackages?.length ?? 0) > 0 ||
      (tool.systemDependencies.aptPackages?.length ?? 0) > 0)
  );

  const systemPrompt = isSidecar ? GENERATE_SIDECAR_SYSTEM : GENERATE_SYSTEM;

  const depNote =
    isSidecar && tool.systemDependencies
      ? `\nAvailable packages (pre-installed): ${[
          ...(tool.systemDependencies.pythonPackages ?? []),
          ...(tool.systemDependencies.aptPackages ?? []),
        ].join(', ')}`
      : '';

  const userPrompt = `Generate a Python Tool subclass for:
Name: ${tool.name}
Class name: ${className}
Label: ${tool.label}
Description: ${tool.description}
Category: ${tool.category}
Parameters schema: ${JSON.stringify(tool.parameters, null, 2)}${depNote}

The tool should actually implement the described functionality.
${isSidecar ? 'Use the available packages. Write all output files to /workspace/output/.' : 'Use free public APIs where possible (no auth needed).'} Return a JSON string.`;

  const raw = await callLLM(systemPrompt, userPrompt, 2000, agentId);
  return stripFences(raw);
}

// ─── Public: generate all approved tools for a new agent ─────────────────────

export async function generateAgentTools(
  agentId: string,
  agentsDir: string,
  tools: ProposedTool[],
): Promise<void> {
  if (!tools || tools.length === 0) return;

  const toolsDir = path.join(agentsDir, agentId, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  const results = await Promise.allSettled(
    tools.map(async (tool) => {
      try {
        const code = await generateToolFile(tool, agentId);
        const filePath = path.join(toolsDir, `${tool.name}.py`);
        fs.writeFileSync(filePath, code, 'utf-8');
        // Write metadata sidecar so the UI can show status badges
        const requiresSidecar = !!(
          tool.systemDependencies &&
          ((tool.systemDependencies.pythonPackages?.length ?? 0) > 0 ||
            (tool.systemDependencies.aptPackages?.length ?? 0) > 0)
        );
        const meta = {
          label: tool.label,
          description: tool.description,
          status: 'untested',
          complexity: code.split('\n').length > 60 ? 'complex' : 'simple',
          requiredCredentials: tool.requiredCredentials.filter(
            (c) => c !== 'none',
          ),
          requiresSidecar,
          // Phase 0 (stage25): `tier` is the unified execution-model field shared with
          // the nanobot factory's ToolManifest. requiresSidecar is kept for back-compat.
          tier: requiresSidecar ? 'sidecar' : 'sandbox',
          // parameters are needed by the cycle sidecar proxy + the Tools-tab catalog.
          // (Previously written by the now-removed generateAgentToolsJS.)
          parameters: tool.parameters,
          generatedAt: new Date().toISOString(),
          lastTestedAt: null,
          lastTestOutput: null,
          lastTestError: null,
        };
        fs.writeFileSync(
          path.join(toolsDir, `${tool.name}.json`),
          JSON.stringify(meta, null, 2),
          'utf-8',
        );
        logger.info({ agentId, tool: tool.name }, 'Generated tool file');
      } catch (err) {
        logger.error(
          { agentId, tool: tool.name, err },
          'Failed to generate tool file',
        );
        throw err;
      }
    }),
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    logger.warn(
      { agentId, failed: failed.length, total: tools.length },
      'Some tools failed to generate',
    );
  }
}

// ─── Write agent-env.json — merged dependency manifest ───────────────────────

export interface AgentEnv {
  baseImage: string;
  pythonPackages: string[];
  aptPackages: string[];
  createdAt: string;
  toolSources: Record<string, string[]>; // toolName → packages it contributed
}

/**
 * Merges systemDependencies from all approved tools into a single agent-env.json.
 * Only written when at least one tool has system dependencies.
 * Safe to call multiple times — overwrites with the merged result.
 */
export function writeAgentEnv(
  agentId: string,
  agentsDir: string,
  tools: ProposedTool[],
): void {
  const toolsWithDeps = tools.filter(
    (t) =>
      t.systemDependencies &&
      ((t.systemDependencies.pythonPackages?.length ?? 0) > 0 ||
        (t.systemDependencies.aptPackages?.length ?? 0) > 0),
  );

  if (toolsWithDeps.length === 0) return;

  const pipSet = new Set<string>();
  const aptSet = new Set<string>();
  const sources: Record<string, string[]> = {};
  let baseImage = 'python:3.12-slim';

  for (const t of toolsWithDeps) {
    const sd = t.systemDependencies!;
    const contributed: string[] = [];

    for (const pkg of sd.pythonPackages ?? []) {
      pipSet.add(pkg);
      contributed.push(pkg);
    }
    for (const pkg of sd.aptPackages ?? []) {
      aptSet.add(pkg);
      contributed.push(pkg);
    }
    if (sd.baseImage && sd.baseImage !== 'python:3.12-slim') {
      baseImage = sd.baseImage;
    }
    sources[t.name] = contributed;
  }

  const env: AgentEnv = {
    baseImage,
    pythonPackages: [...pipSet],
    aptPackages: [...aptSet],
    createdAt: new Date().toISOString(),
    toolSources: sources,
  };

  const agentDir = path.join(agentsDir, agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'agent-env.json'),
    JSON.stringify(env, null, 2),
    'utf-8',
  );
  logger.info(
    { agentId, pip: env.pythonPackages.length, apt: env.aptPackages.length },
    'Wrote agent-env.json',
  );
}

// ─── Mission task generation (used by agent-tester.ts at creation time) ──────

export interface MissionTask {
  task: string; // concrete input to give the agent
  structuralChecks: Array<{
    check: 'output_file_exists' | 'response_contains';
    pattern: string;
  }>;
  behavioralCriteria: string; // one sentence for the LLM judge
}

const MISSION_TASK_SYSTEM = `You are writing a smoke-test task for an AI agent.
Given the agent's mission and its available tools, produce a minimal but realistic task
that exercises the agent's core capability in one shot.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "task": "One concrete instruction the agent can complete in a single cycle. Be specific (exact values, not placeholders).",
  "structuralChecks": [
    { "check": "output_file_exists", "pattern": "*.mp4" },
    { "check": "response_contains",  "pattern": ".mp4"  }
  ],
  "behavioralCriteria": "One sentence: what a passing response must demonstrate."
}

Rules for structuralChecks:
- Include output_file_exists only if the agent is expected to produce a file
- Include response_contains if the agent should mention a key term or path in its reply
- Omit both if the task is purely informational (e.g. a summary or analysis)`;

export async function generateMissionTask(
  mission: string,
  goals: string,
  tools: ProposedTool[],
  agentId?: string,
): Promise<MissionTask> {
  const toolSummary = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
  const userPrompt = `Mission: ${mission}\nGoals: ${goals}\nAvailable tools:\n${toolSummary}`;

  const raw = await callLLM(MISSION_TASK_SYSTEM, userPrompt, 600, agentId);
  const cleaned = stripFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    return {
      task:
        parsed.task ??
        `Complete one task that demonstrates your core capability: ${mission}`,
      structuralChecks: Array.isArray(parsed.structuralChecks)
        ? parsed.structuralChecks
        : [],
      behavioralCriteria:
        parsed.behavioralCriteria ?? `Agent responds relevantly to: ${mission}`,
    };
  } catch {
    // Fallback: a generic task that always works
    return {
      task: `Demonstrate your core capability with one concrete example. Mission: ${mission}`,
      structuralChecks: [],
      behavioralCriteria: `Agent responds relevantly to the mission and uses at least one of its tools.`,
    };
  }
}
