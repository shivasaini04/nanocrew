import { randomBytes } from 'crypto';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DEFAULT_MEMORY_LIMIT_MAIN',
  'DEFAULT_MEMORY_LIMIT_WORKER',
  'DEFAULT_CPU_LIMIT_MAIN',
  'DEFAULT_CPU_LIMIT_WORKER',
  'MODEL_PRIORITY',
  'LIGHT_MODEL',
  // Stage 28 — authentication (Topic 03)
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
  'APP_URL',
  'SIGNUP_OPEN',
  // Stage 28 Phase 8 — email (Gmail SMTP) + Google OAuth
  'EMAIL_FROM',
  'EMAIL_SERVER_HOST',
  'EMAIL_SERVER_PORT',
  'EMAIL_SERVER_USER',
  'EMAIL_SERVER_PASSWORD',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ENFORCE_PLANS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Nano';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

export const DEFAULT_MEMORY_LIMIT_MAIN =
  process.env.DEFAULT_MEMORY_LIMIT_MAIN ||
  envConfig.DEFAULT_MEMORY_LIMIT_MAIN ||
  '2g';
export const DEFAULT_MEMORY_LIMIT_WORKER =
  process.env.DEFAULT_MEMORY_LIMIT_WORKER ||
  envConfig.DEFAULT_MEMORY_LIMIT_WORKER ||
  '1g';
export const DEFAULT_CPU_LIMIT_MAIN =
  process.env.DEFAULT_CPU_LIMIT_MAIN || envConfig.DEFAULT_CPU_LIMIT_MAIN || '2';
export const DEFAULT_CPU_LIMIT_WORKER =
  process.env.DEFAULT_CPU_LIMIT_WORKER ||
  envConfig.DEFAULT_CPU_LIMIT_WORKER ||
  '1';

// Model routing: comma-separated provider/model fallback chain for heavy work.
// e.g. "deepseek/deepseek-chat,gemini/gemini-2.0-flash"
export const MODEL_PRIORITY =
  process.env.MODEL_PRIORITY || envConfig.MODEL_PRIORITY || '';

// Cheap/fast model for conversational (light) replies.
// e.g. "groq/llama-3.3-70b-versatile" or "deepseek/deepseek-v4-flash"
export const LIGHT_MODEL =
  process.env.LIGHT_MODEL || envConfig.LIGHT_MODEL || '';

// ─── Stage 28 — Authentication (Topic 03) ────────────────────────────────────
// The bootstrap admin account. On first boot the admin user is created from these
// and all pre-auth data is assigned to it. Changing them later does NOT rename the
// existing admin — manage the account from the admin panel instead.
export const ADMIN_EMAIL =
  process.env.ADMIN_EMAIL || envConfig.ADMIN_EMAIL || '';
export const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || envConfig.ADMIN_PASSWORD || '';
// Used to sign session cookies (Phase 2). Falls back to a random value so dev still
// works, but that invalidates sessions on every restart — set a fixed one in prod.
export const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  envConfig.SESSION_SECRET ||
  randomBytes(32).toString('hex');
// Public base URL of the app — used to build password-reset / welcome links (Phase 8).
export const APP_URL =
  process.env.APP_URL || envConfig.APP_URL || 'http://localhost:5173';
// true = anyone can self-serve at /signup; false = invite-only (admin creates accounts).
export const SIGNUP_OPEN =
  (process.env.SIGNUP_OPEN || envConfig.SIGNUP_OPEN || 'false') === 'true';
// Login session lifetime (Topic 03 open question — 7 days recommended).
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Plans, tiers & BYOK ──────────────────────────────────────────────────────
// Stage 32 canonical tier definition — single source of truth for feature gating.
// See docs/research/stage32/tier-definition.md. Tiers: Standard / Pro / Business.
// Infinity = unlimited. Legacy labels (starter/ultra) alias to the new tier keys
// via normalizePlan so pre-rename users.plan values keep resolving correctly.
export interface PlanFeatures {
  cycles: number; // monthly agent-run allowance
  agents: number; // max agents an owner may create
  projects: number; // max projects an owner may create
  byok: boolean; // may plug in own provider key (which also lifts the cycle cap)
}
export const PLAN_FEATURES: Record<string, PlanFeatures> = {
  standard: { cycles: 200, agents: 5, projects: 4, byok: false },
  pro: { cycles: 1000, agents: 10, projects: 10, byok: true },
  business: { cycles: 5000, agents: Infinity, projects: Infinity, byok: true },
};
export const DEFAULT_PLAN = 'standard';
export const PLAN_KEYS = Object.keys(PLAN_FEATURES); // for admin validation / dropdowns
// Pre-Stage32 plan labels → current tier keys.
const PLAN_ALIASES: Record<string, string> = {
  starter: 'standard',
  ultra: 'business',
};
/** Resolve any stored/legacy plan label to a known tier key. Unknown/null → standard. */
export function normalizePlan(plan: string | null | undefined): string {
  const p = String(plan ?? '')
    .toLowerCase()
    .trim();
  const aliased = PLAN_ALIASES[p] ?? p;
  return PLAN_FEATURES[aliased] ? aliased : DEFAULT_PLAN;
}
// Plan limits are a hosted-service feature and are OFF by default: a self-hosted install has no
// paywall, no monthly run cap and no agent or project cap. Set ENFORCE_PLANS=true to apply the
// tiers above (admins are always exempt).
export const ENFORCE_PLANS =
  (process.env.ENFORCE_PLANS || envConfig.ENFORCE_PLANS || 'false') === 'true';
const UNLIMITED: PlanFeatures = {
  cycles: Infinity,
  agents: Infinity,
  projects: Infinity,
  byok: true,
};
function planFeatures(plan: string | null | undefined): PlanFeatures {
  if (!ENFORCE_PLANS) return UNLIMITED;
  return PLAN_FEATURES[normalizePlan(plan)];
}
export function planCycleLimit(plan: string | null | undefined): number {
  return planFeatures(plan).cycles;
}
export function planAgentLimit(plan: string | null | undefined): number {
  return planFeatures(plan).agents;
}
export function planProjectLimit(plan: string | null | undefined): number {
  return planFeatures(plan).projects;
}
export function planAllowsByok(plan: string | null | undefined): boolean {
  return planFeatures(plan).byok;
}
/** Hard paywall: a user may run agents only with a real plan (paid subscription or admin-granted).
 *  A brand-new self-serve user has no plan (null/empty) and must subscribe before anything runs. */
export function hasActivePlan(plan: string | null | undefined): boolean {
  if (!ENFORCE_PLANS) return true;
  return typeof plan === 'string' && plan.trim() !== '';
}
// Supported BYOK providers → the env var the agent reads that provider's key from.
export const BYOK_PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

// Default model per BYOK provider (litellm-python format, used for DIRECT calls when a
// client BYOKs — the platform proxy is bypassed). A client can override via their key's
// model field. Adjust if a provider's model id changes.
export const BYOK_DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-4o',
  gemini: 'gemini/gemini-2.5-pro',
  deepseek: 'deepseek/deepseek-chat',
  groq: 'groq/llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
};

// ─── Email (Gmail SMTP) — Phase 8 ─────────────────────────────────────────────
export const EMAIL_FROM = process.env.EMAIL_FROM || envConfig.EMAIL_FROM || '';
export const EMAIL_SERVER_HOST =
  process.env.EMAIL_SERVER_HOST || envConfig.EMAIL_SERVER_HOST || '';
export const EMAIL_SERVER_PORT = parseInt(
  process.env.EMAIL_SERVER_PORT || envConfig.EMAIL_SERVER_PORT || '465',
  10,
);
export const EMAIL_SERVER_USER =
  process.env.EMAIL_SERVER_USER || envConfig.EMAIL_SERVER_USER || '';
export const EMAIL_SERVER_PASSWORD =
  process.env.EMAIL_SERVER_PASSWORD || envConfig.EMAIL_SERVER_PASSWORD || '';

// ─── Google OAuth — Phase 8 ───────────────────────────────────────────────────
export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || envConfig.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || envConfig.GOOGLE_CLIENT_SECRET || '';
// OAuth + email links resolve against APP_URL; callback path is fixed.
export const GOOGLE_REDIRECT_URI = `${(process.env.APP_URL || envConfig.APP_URL || 'http://localhost:5173').replace(/\/$/, '')}/api/auth/google/callback`;

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'NanoCrew',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const PROJECTS_DIR = path.resolve(PROJECT_ROOT, 'groups', 'projects');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
// Transient upload staging — files attached to a pending action (e.g. a create-agent
// approval) land here, then get materialized into the target on approval. Swept by TTL.
export const STAGING_DIR = path.resolve(DATA_DIR, 'staging');
export const MAIN_GROUP_FOLDER = 'main';

// Lowercase, and not merely by convention: Docker rejects an uppercase repository
// name outright ("invalid reference format: repository name must be lowercase"), so
// the old 'NanoCrew-agent:latest' default — a leftover from the nanoclaw→nanocrew
// rename — made every cycle die at spawn for anyone not setting CONTAINER_IMAGE.
// Matches what container/build.sh builds and what .env.example documents.
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanocrew-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
/**
 * An agent cycle has no wall-clock limit: it may work for hours or days. What ends it is
 * silence — no output at all (no model reply, no tool call, no progress line) for this long,
 * which means a wedged process, not a working one. Working agents emit a line every step.
 * Before 2026-09-30 every cycle died at CONTAINER_TIMEOUT (50 min on prod) however much it
 * was still doing.
 */
export const CYCLE_IDLE_TIMEOUT_MS = parseInt(
  process.env.CYCLE_IDLE_TIMEOUT_MS || String(30 * 60 * 1000),
  10,
);
/** An optional hard ceiling on one cycle's wall time. 0 (the default) = none. */
export const CYCLE_MAX_MS = parseInt(process.env.CYCLE_MAX_MS || '0', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
