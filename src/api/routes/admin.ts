/**
 * Stage 28 — Admin panel API (Topic 03, Phase 6). Operator-only: the whole router is
 * mounted behind requireAdmin in server.ts. Surfaces the client list, usage stats,
 * and account management (suspend / set plan / delete).
 */
import path from 'path';
import fs from 'fs';
import { randomUUID, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router } from 'express';
import type { Request, Response } from 'express';

import { DATA_DIR, PLAN_KEYS } from '../../config.js';

/** An admin-set plan must be blank (clear) or a known tier key. Returns an error string if invalid. */
function invalidPlan(plan: string | null | undefined): string | null {
  if (plan === undefined || plan === null || String(plan).trim() === '')
    return null;
  return PLAN_KEYS.includes(String(plan).toLowerCase())
    ? null
    : `Invalid plan. Use one of: ${PLAN_KEYS.join(', ')}.`;
}
import {
  getAdminStats,
  getAdminClientList,
  getAdminClientDetail,
  setUserStatus,
  setUserPlan,
  deleteUserAccount,
  getUserById,
  getUserByEmail,
  createUser,
  setUserPassword,
  setSessionImpersonation,
} from '../../db.js';
import { hashPassword } from '../../auth/password.js';
import { runWorkerAttempt } from '../../swarm/worker.js';
import { startResourceSampler } from '../../swarm/resource-sampler.js';
import { agentService } from '../../agents/agent-registry.js';
import { sidecarRegistry } from '../../agents/agent-sidecar.js';
import { logger } from '../../logger.js';

export const adminRouter = Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const execFileP = promisify(execFile);
// Allow-listed containers the operator can tail logs from (the prod compose service names).
const LOG_CONTAINERS: Record<string, string> = {
  orchestrator: 'nanocrew-orchestrator',
  litellm: 'nanocrew-litellm',
  reacher: 'reacher-verifier',
};

// GET /api/admin/logs?service=orchestrator&lines=400 — tail a container's logs.
// The orchestrator has the docker socket mounted, so it can read sibling containers'
// logs. WhatsApp QR ascii-art lines are stripped so the output is readable.
adminRouter.get('/logs', async (req: Request, res: Response) => {
  const service = String(req.query.service ?? 'orchestrator');
  const container = LOG_CONTAINERS[service];
  if (!container) {
    return res.status(400).json({
      error: `Unknown service. Use one of: ${Object.keys(LOG_CONTAINERS).join(', ')}`,
    });
  }
  const lines = Math.min(
    Math.max(parseInt(String(req.query.lines ?? '400'), 10) || 400, 10),
    2000,
  );
  try {
    // container is from the allow-list and lines is a sanitized int, so this sh -c is safe.
    const { stdout } = await execFileP(
      'sh',
      ['-c', `docker logs ${container} --tail ${lines} 2>&1`],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000,
      },
    );
    const cleaned = stdout
      .split('\n')
      .filter((l) => !/[█▀▄]/.test(l))
      .join('\n');
    res.type('text/plain').send(cleaned);
  } catch (err: any) {
    res.status(500).json({ error: `Could not read logs: ${err.message}` });
  }
});

// GET /api/admin/stats — platform headline numbers
adminRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(getAdminStats());
});

// GET /api/admin/clients — all accounts + usage
adminRouter.get('/clients', (_req: Request, res: Response) => {
  res.json({ clients: getAdminClientList() });
});

// POST /api/admin/clients — create a client account (invite-only onboarding).
// Mirrors the signup flow (createUser + Recruiter provisioning) MINUS the session, so
// SIGNUP_OPEN can stay false while the operator adds clients by hand. If no password is
// supplied, one is generated and returned once so the operator can share it.
adminRouter.post('/clients', async (req: Request, res: Response) => {
  const { email, password, plan } = (req.body ?? {}) as {
    email?: string;
    password?: string;
    plan?: string | null;
  };
  const normEmail = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(normEmail)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (getUserByEmail(normEmail)) {
    return res
      .status(409)
      .json({ error: 'An account with that email already exists.' });
  }
  const planErr = invalidPlan(plan);
  if (planErr) return res.status(400).json({ error: planErr });

  let plainPassword = String(password ?? '').trim();
  const generated = !plainPassword;
  if (generated) {
    plainPassword = randomBytes(12)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 14);
  }
  if (plainPassword.length < 8) {
    return res
      .status(400)
      .json({ error: 'Password must be at least 8 characters.' });
  }

  const id = randomUUID();
  const password_hash = await hashPassword(plainPassword);
  createUser({
    id,
    email: normEmail,
    password_hash,
    role: 'user',
    created_at: new Date().toISOString(),
  });
  if (plan) setUserPlan(id, String(plan));
  try {
    await agentService.ensureRecruiterAgent(id);
  } catch (err) {
    logger.warn(
      { err, userId: id },
      'Recruiter provisioning on admin-create failed (will backfill on boot)',
    );
  }

  logger.info({ userId: id, by: req.user?.id }, 'Admin created client account');
  const detail = getAdminClientDetail(id);
  res.status(201).json({
    user: detail?.user ?? getUserById(id),
    tempPassword: generated ? plainPassword : undefined,
  });
});

// GET /api/admin/clients/:id — one account + per-agent breakdown
adminRouter.get('/clients/:id', (req: Request, res: Response) => {
  const detail = getAdminClientDetail(String(req.params.id));
  if (!detail) return res.status(404).json({ error: 'Client not found' });
  res.json(detail);
});

// PATCH /api/admin/clients/:id — manage account (status / plan)
adminRouter.patch('/clients/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { status, plan } = (req.body ?? {}) as {
    status?: 'active' | 'suspended';
    plan?: string | null;
  };
  if (status && status !== 'active' && status !== 'suspended') {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const planErr = invalidPlan(plan);
  if (planErr) return res.status(400).json({ error: planErr });
  if (id === req.user!.id) {
    return res
      .status(400)
      .json({ error: "You can't change your own account here." });
  }
  if (status) setUserStatus(id, status);
  if (plan !== undefined) setUserPlan(id, plan);
  const detail = getAdminClientDetail(id);
  if (!detail) return res.status(404).json({ error: 'Client not found' });
  res.json(detail.user);
});

// POST /api/admin/clients/:id/impersonate — start "view as client" on this session.
// Runs while still admin (requireAdmin passes); takes effect on the next request.
adminRouter.post('/clients/:id/impersonate', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'Client not found' });
  if (target.role === 'admin')
    return res.status(400).json({ error: "Can't view as another admin." });
  if (!req.sessionId) return res.status(400).json({ error: 'No session' });
  setSessionImpersonation(req.sessionId, id);
  logger.info(
    { adminId: req.user!.id, clientId: id },
    'Admin started view-as-client',
  );
  res.json({ ok: true });
});

// POST /api/admin/clients/:id/reset-password — operator resets a client's password
// (support: "I can't log in"). Returns a generated temp password to share if none given.
adminRouter.post(
  '/clients/:id/reset-password',
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const target = getUserById(id);
    if (!target) return res.status(404).json({ error: 'Client not found' });
    const { password } = (req.body ?? {}) as { password?: string };
    let plain = String(password ?? '').trim();
    const generated = !plain;
    if (generated)
      plain = randomBytes(12)
        .toString('base64')
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 14);
    if (plain.length < 8)
      return res
        .status(400)
        .json({ error: 'Password must be at least 8 characters.' });
    setUserPassword(id, await hashPassword(plain));
    logger.info(
      { userId: id, by: req.user?.id },
      'Admin reset client password',
    );
    res.json({ ok: true, password: generated ? plain : undefined });
  },
);

// DELETE /api/admin/clients/:id — hard-delete an account + its data
adminRouter.delete('/clients/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (id === req.user!.id) {
    return res
      .status(400)
      .json({ error: "You can't delete your own account." });
  }
  let agentIds: string[];
  try {
    agentIds = deleteUserAccount(id);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  // Best-effort cleanup of each agent's sidecar + on-disk workspace.
  for (const aid of agentIds) {
    try {
      await sidecarRegistry.teardown(aid);
    } catch {
      /* may not be running */
    }
    try {
      fs.rmSync(path.join(DATA_DIR, 'agents', aid), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
  }
  logger.info(
    { userId: id, agents: agentIds.length },
    'Admin deleted client account',
  );
  res.json({ ok: true, deletedAgents: agentIds.length });
});

// POST /api/admin/swarm-spike — stage 57 phase 2 measurement. Runs up to 12 worker attempts for one
// owner agent at once and reports timings, cost, usage and container/host memory. Admin
// only (this router is mounted behind requireAdmin). Temporary: phase 3's runs replace it.
//
// Body: { agentId, prompts: string[] } or { agentId, prompt, n }, optional timeoutMs.
adminRouter.post('/swarm-spike', async (req: Request, res: Response) => {
  const { agentId, prompts, prompt, n, timeoutMs } = req.body as {
    agentId?: string;
    prompts?: string[];
    prompt?: string;
    n?: number;
    timeoutMs?: number;
  };
  const owner = agentId ? agentService.getAgent(agentId) : undefined;
  if (!owner) return res.status(404).json({ error: 'agentId not found' });
  const list: string[] =
    Array.isArray(prompts) && prompts.length
      ? prompts.map(String)
      : prompt
        ? Array.from(
            { length: Math.max(1, Math.min(Number(n) || 1, 12)) },
            () => String(prompt),
          )
        : [];
  if (list.length === 0 || list.length > 12)
    return res.status(400).json({ error: 'give 1–12 prompts' });

  const spikeId = `spike${Date.now().toString(36)}`;
  const sampler = startResourceSampler(`NanoCrew-worker-${spikeId}`);
  const startedAt = Date.now();
  logger.info(
    { spikeId, agentId, workers: list.length },
    'swarm spike started',
  );
  try {
    const results = await Promise.all(
      list.map((p, i) =>
        runWorkerAttempt({
          ownerAgentId: owner.id,
          attemptId: `${spikeId}-${i}`,
          prompt: p,
          timeoutMs: Math.min(Number(timeoutMs) || 8 * 60_000, 15 * 60_000),
        }),
      ),
    );
    const resources = await sampler.stop();
    const wallMs = Date.now() - startedAt;
    const totalCostUsd = results.reduce((a, r) => a + r.costUsd, 0);
    logger.info(
      { spikeId, wallMs, totalCostUsd, ok: results.filter((r) => r.ok).length },
      'swarm spike finished',
    );
    res.json({
      spikeId,
      workers: list.length,
      wallMs,
      totalCostUsd,
      results,
      resources,
    });
  } catch (err: any) {
    await sampler.stop();
    res.status(500).json({ spikeId, error: err?.message ?? String(err) });
  }
});
