/**
 * Computer use management routes.
 *
 * POST   /api/agents/:id/computer-use/run       — execute a browser task directly (bypasses agent cycle)
 * GET    /api/agents/:id/computer-use/sessions  — list saved browser sessions
 * DELETE /api/agents/:id/computer-use/sessions/:domain — delete a saved session
 * GET    /api/agents/:id/computer-use/logs      — list action logs
 * GET    /api/agents/:id/computer-use/logs/:runId — read a specific action log
 */
import { Router, type Request } from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ComputerUseArgsSchema } from '../../agents/runtime/computer-use/types.js';
import { startSandbox } from '../../agents/runtime/computer-use/sandbox.js';
import { executeSteps } from '../../agents/runtime/computer-use/executor.js';
import { extractPageText } from '../../agents/runtime/computer-use/screenshot.js';
import {
  listSessions,
  deleteSession,
} from '../../agents/runtime/computer-use/session.js';
import {
  appendActionLog,
  buildLogEntry,
  getLogPath,
  readActionLog,
} from '../../agents/runtime/computer-use/action-log.js';
import {
  listPendingApprovals,
  resolveApproval,
} from '../../agents/runtime/computer-use/escalation.js';
import { credentialManager } from '../../agents/credential-manager.js';
import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import fs from 'node:fs';

export const computerUseRouter = Router({ mergeParams: true });

// Helper to get agentId from merged params
function agentId(req: Request): string {
  return (req.params as Record<string, string>)['id'] ?? '';
}

const agentsDir = path.join(DATA_DIR, 'agents');

// ─── Run a browser task directly ─────────────────────────────────────────────

computerUseRouter.post('/run', async (req, res) => {
  const aid = agentId(req);
  const runId = randomUUID();

  let parsed: ReturnType<typeof ComputerUseArgsSchema.parse>;
  try {
    parsed = ComputerUseArgsSchema.parse(req.body);
  } catch (err: any) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: err.issues ?? err.message,
    });
  }

  const { task, url, steps, sessionDomain, maxExternalActions } = parsed;
  const sessionsDir = path.join(agentsDir, aid, 'sessions');
  const logPath = getLogPath(agentsDir, aid, runId);

  logger.info(
    { agentId: aid, runId, task, stepCount: steps.length },
    'computer-use: run started',
  );

  const sandbox = await startSandbox({
    sessionsDir,
    sessionDomain,
    headless: true,
  });

  try {
    if (url) {
      await sandbox.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    }

    const requireApproval = req.body?.requireApproval !== false;

    const results = await executeSteps(steps, sandbox.page, {
      maxExternalActions: maxExternalActions ?? 5,
      agentId: aid,
      runId,
      requireApproval,
      onStepEnd: (step, result) => {
        const entry = buildLogEntry(step, result, runId, aid);
        appendActionLog(logPath, entry);
      },
    });

    const finalUrl = sandbox.page.url();
    const pageText = await extractPageText(sandbox.page);

    res.json({
      runId,
      task,
      finalUrl,
      stepCount: steps.length,
      succeeded: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      stepResults: results,
      pageText: pageText.slice(0, 2000),
      logPath,
    });
  } catch (err: any) {
    logger.error({ agentId: aid, runId, err }, 'computer-use: run error');
    res.status(500).json({ error: err.message, runId });
  } finally {
    await sandbox.stop();
  }
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

computerUseRouter.get('/sessions', (req, res) => {
  const sessionsDir = path.join(agentsDir, agentId(req), 'sessions');
  res.json({ sessions: listSessions(sessionsDir) });
});

computerUseRouter.delete('/sessions/:domain', (req, res) => {
  const sessionsDir = path.join(agentsDir, agentId(req), 'sessions');
  try {
    deleteSession(req.params['domain'] ?? '', sessionsDir);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Action logs ──────────────────────────────────────────────────────────────

computerUseRouter.get('/logs', (req, res) => {
  const logsDir = path.join(agentsDir, agentId(req), 'computer-use-logs');
  if (!fs.existsSync(logsDir)) return res.json({ logs: [] });

  const logs = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => {
      const rid = f.replace('.ndjson', '');
      const stat = fs.statSync(path.join(logsDir, f));
      const createdAt = stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
      return {
        runId: rid,
        createdAt: createdAt.toISOString(),
        size: stat.size,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({ logs });
});

computerUseRouter.get('/logs/:runId', (req, res) => {
  const rid = req.params['runId'] ?? '';
  const logPath = getLogPath(agentsDir, agentId(req), rid);
  if (!fs.existsSync(logPath))
    return res.status(404).json({ error: 'Log not found' });

  const entries = readActionLog(logPath);
  res.json({ runId: rid, entries });
});

// ─── Escalation gate ──────────────────────────────────────────────────────────

// Shape must match the app-level /api/computer-use/escalations route in server.ts —
// both read the same state, and returning a bare array here while that one returns
// { escalations } is a trap for the next caller that reads `.escalations` and gets
// undefined.
//
// Scoped to THIS agent (stage 60, found while wiring chat approvals). The router.param
// guard proves the caller owns :id, but these used to list and resolve every pending
// escalation in the process — any owner could see, approve or deny another account's
// browser actions by naming one of their own agents in the URL.
const belongsToAgent = (req: Request, approvalId: string): boolean =>
  listPendingApprovals().some(
    (a) => a.id === approvalId && a.agentId === agentId(req),
  );

computerUseRouter.get('/escalations', (req, res) => {
  res.json({
    escalations: listPendingApprovals().filter(
      (a) => a.agentId === agentId(req),
    ),
  });
});

computerUseRouter.post('/escalations/:approvalId/approve', (req, res) => {
  if (!belongsToAgent(req, req.params['approvalId'] ?? '')) {
    return res
      .status(404)
      .json({ error: 'Approval not found or already resolved' });
  }
  const ok = resolveApproval(req.params['approvalId'] ?? '', 'approved');
  if (!ok)
    return res
      .status(404)
      .json({ error: 'Approval not found or already resolved' });
  res.json({ decision: 'approved' });
});

computerUseRouter.post('/escalations/:approvalId/deny', (req, res) => {
  if (!belongsToAgent(req, req.params['approvalId'] ?? '')) {
    return res
      .status(404)
      .json({ error: 'Approval not found or already resolved' });
  }
  const ok = resolveApproval(req.params['approvalId'] ?? '', 'denied');
  if (!ok)
    return res
      .status(404)
      .json({ error: 'Approval not found or already resolved' });
  res.json({ decision: 'denied' });
});
