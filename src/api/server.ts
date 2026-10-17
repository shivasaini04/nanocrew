/**
 * Dashboard API Server for nanocrew
 * Provides HTTP + WebSocket endpoints for the React dashboard.
 * Runs inside the same process as the orchestrator to share the SQLite connection.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import http from 'http';
import path from 'path';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';

import { SESSION_SECRET, APP_URL } from '../config.js';
import { authRouter } from './routes/auth.js';
import { desktopAuthRouter } from './routes/desktop-auth.js';
import { adminRouter } from './routes/admin.js';
import {
  attachUser,
  requireAuth,
  requireAdmin,
  resolveUserFromCookieHeader,
  type SafeUser,
} from './middleware/auth.js';
import { ownsResource } from './middleware/ownership.js';
import { installSocketScoping, userRoom } from './socket-scope.js';
import {
  getAgent,
  getAgentInterruptFlag,
  createAgentMessage,
  getProject,
  getProjectAgents,
  getHandoffById,
} from '../db.js';
import { agentService } from '../agents/agent-registry.js';
import { sidecarRegistry } from '../agents/agent-sidecar.js';
import { credentialManager } from '../agents/credential-manager.js';
import type { NextFunction } from 'express';

import { statusRouter } from './routes/status.js';
import { accountRouter } from './routes/account.js';
import { messagesRouter } from './routes/messages.js';
import { conversationsRouter } from './routes/conversations.js';
import { containersRouter } from './routes/containers.js';
import {
  getContainers,
  getContainerStats,
  streamContainerLogs,
} from '../container-runtime.js';
import { ChildProcess } from 'child_process';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter } from './routes/chat.js';
import { usageRouter } from './routes/usage.js';
import { filesRouter } from './routes/files.js';
import { settingsRouter } from './routes/settings.js';
import { agentsRouter } from './routes/agents.js';
import {
  streamCycleFrame,
  streamCycleSteps,
} from '../cycle-activity-stream.js';
import { securityHeaders } from './security-headers.js';
import {
  registerAgentWaker,
  registerFollowupRunner,
} from './browser-attach-wake.js';
import { followupPrompt, localFollowups } from '../agents/local-followups.js';
import { batchCheckinRefusal } from '../agents/batch-send-limit.js';
import { autoApproveIfRuled } from '../agents/approval-apply.js';
import { ownerCheckins } from '../agents/batch-send-owner.js';
import { installBrowserControlWs } from './browser-control-ws.js';
import {
  installCycleChannelWs,
  sendToCycle,
  agentForCycleChannel,
} from './cycle-channel-ws.js';
import { installCycleVncWs } from './cycle-vnc-ws.js';
import { browserControlRouter } from './routes/browser-control.js';
import { cycleVncRouter } from './routes/cycle-vnc.js';
import { browserControlDispatchRouter } from './routes/browser-control-dispatch.js';
import { recordMemory } from '../agents/memory-service.js';
import {
  incrementMemoryUsed,
  createAgentCheckin,
  getAgentProjects,
} from '../db.js';
import {
  createToolApproval,
  getToolApproval,
  expireToolApproval,
} from '../db.js';
import { searchAgentMemoryRanked } from '../agents/memory-retrieval.js';
import {
  agentHandoffService,
  resolveHandoffTarget,
  createHandoffFromRequest,
  shouldWakeOnHandoff,
} from '../agents/agent-handoff.js';
import type { HandoffPerformative } from '../agents/agent-handoff.js';
import { globalEventBus } from '../agents/runtime/event-bus.js';
import { notify as sendNotification } from '../notifications.js';
import { PROJECTS_DIR } from '../config.js';
import fs from 'fs';
import { credentialsRouter } from './routes/credentials.js';
import { secretsRouter } from './routes/secrets.js';
import { ownerSecretsRouter } from './routes/owner-secrets.js';
import { projectsRouter } from './routes/projects.js';
import { webhooksRouter } from './routes/webhooks.js';
import { mcpRouter } from './routes/mcp.js';
import toolsRouter, { setToolLifecycleManager } from './routes/tools.js';
import { computerUseRouter } from './routes/computer-use.js';
import {
  listPendingApprovals,
  resolveApproval,
  setEscalationSocketIO,
  restorePendingApprovals,
} from '../agents/runtime/computer-use/escalation.js';
import { crewRouter } from './routes/crew.js';
import { pipelinesRouter } from './routes/pipelines.js';
import { notificationsRouter } from './routes/notifications.js';
import { selfManageRouter } from './routes/self-manage.js';
import { swarmRunsRouter } from './routes/swarm-runs.js';
import { runsRouter } from './routes/runs.js';
import { verifyCycleToken, extractCycleToken } from '../agents/cycle-token.js';
import { modelConfigRouter } from './routes/model-config.js';
import { artifactDocsRouter } from './routes/artifact-docs.js';

import { logger } from '../logger.js';
import { setSocketIO, getSocketIO } from './instances.js';
import { laneEventBus } from '../agents/lane-events.js';
import {
  initSelfHealing,
  toolLifecycleManager,
} from '../agents/agent-registry.js';
import { setSidecarSocketIO } from '../agents/agent-sidecar.js';
import { getAllAgents } from '../db.js';
import type { Request, Response } from 'express';
import { llmRelayHandler, RELAY_PATH } from '../agents/llm-relay.js';

// The Socket.IO accessor lives in ./instances.js — a leaf module — so
// that modules needing to emit an event don't have to import this one and drag the
// whole router graph (and a cycle) in with it. See instances.ts for the full why.
export { getSocketIO } from './instances.js';

/**
 * Create and start the Express API server with Socket.IO.
 * Called from the orchestrator's main() function.
 */
export function createApiServer(port: number): void {
  const app = express();

  // Baseline security response headers — see security-headers.ts for the full
  // reasoning, in particular why the CSP is split into an enforced half that cannot
  // break this app and a Report-Only half that might.
  app.use(securityHeaders);

  const server = http.createServer(app);

  // Socket.IO for real-time events. Published to ./instances.js so other modules
  // can emit without importing this one (see instances.ts).
  const io = new SocketIOServer(server, {
    cors: {
      origin: true,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });
  setSocketIO(io);

  // Stage 28 — realtime data isolation: route every broadcast to the owning user's
  // room only. Installed before anything can emit.
  installSocketScoping(io);

  // Stage 28 — authenticate the Socket.IO handshake: reject sockets without a valid
  // session cookie so unauthenticated clients can't subscribe to events at all.
  io.use((socket, next) => {
    const user = resolveUserFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) return next(new Error('unauthorized'));
    (socket.data as { user?: unknown }).user = user;
    next();
  });

  // Wire socket.io into sidecar and escalation gate (avoids circular imports)
  setSidecarSocketIO(io);
  setEscalationSocketIO(io);

  // Pick approvals an agent is still blocked on back up after a restart. Must run
  // AFTER setEscalationSocketIO: restoring can settle asks whose deadline passed
  // while we were down, and those updates go out over this socket.
  restorePendingApprovals();

  // Behind Caddy in prod — trust the first proxy hop so req.ip reflects the real
  // client (used by the login rate limiter).
  app.set('trust proxy', 1);

  // Middleware
  // CORS allow-list: the production app origin (APP_URL) + local dev. In prod the
  // dashboard is served same-origin behind Caddy, so this is belt-and-suspenders —
  // but it means we never hardcode localhost into a production deployment.
  const corsOrigins = Array.from(
    new Set(
      [APP_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'].filter(
        Boolean,
      ),
    ),
  );
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true, // browser must send/receive the session cookie
    }),
  );
  // Stage 64 phase 2: agent containers call model providers through here with their
  // cycle token, and get the real key swapped in (agents/llm-relay.ts). Mounted before
  // the JSON parser so request and response bodies stream through untouched.
  app.use(RELAY_PATH, llmRelayHandler);

  app.use(
    express.json({
      // Cycle activity pushes re-send a growing step array (tool outputs ~4kb
      // each over a long cycle), so the default 100kb is too small.
      limit: '8mb',
      verify: (req: any, _res, buf) => {
        // Capture raw body bytes so webhook HMAC verification works
        req.rawBody = buf;
      },
    }),
  );
  // Parse signed cookies (session id) and resolve req.user for every request.
  app.use(cookieParser(SESSION_SECRET));
  app.use(attachUser);

  // ── Lane events: SSE endpoint + Socket.IO forwarding ─────────────────────
  // Forward every lane event to Socket.IO so existing dashboard clients get
  // real-time updates without polling.
  laneEventBus.onEvent((event) => {
    io?.emit('lane_event', event);
  });

  // Raw SSE stream at GET /api/events for non-Socket.IO consumers.
  // Replays the last 100 events on connect so clients don't miss history.
  app.get('/api/events', requireAuth, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Replay recent events so a freshly connected client gets current state
    for (const event of laneEventBus.getRecentEvents(100)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const listener = (event: object) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    laneEventBus.onEvent(listener as any);

    req.on('close', () => {
      laneEventBus.offEvent(listener as any);
    });
  });

  // Health check — used by Docker HEALTHCHECK, load balancers, and uptime monitors.
  // Intentionally outside /api/ so it's reachable without the API prefix.
  const healthStartTime = Date.now();
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - healthStartTime) / 1000),
      agentCount: getAllAgents().length,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Public API routes (no session required) ──────────────────────────────
  // Auth endpoints (login must be reachable while logged out) and webhooks
  // (called by EXTERNAL services, authenticated via per-agent HMAC, not cookies).
  app.use('/api', authRouter);
  // Desktop sign-in: the app never sees a password — see desktop-auth.ts.
  app.use('/api', desktopAuthRouter);
  app.use('/api/webhooks', webhooksRouter);

  // Internal: nanoagent containers push live cycle steps here. No session cookie
  // is available inside containers; agentId + cycleId UUIDs serve as the bearer
  // token. No sensitive data is read — only steps are written to cycle_steps.
  app.post(
    '/api/agents/:id/cycles/:cycleId/steps',
    (req: Request, res: Response) => {
      try {
        const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
        const startSeq = Number.isInteger(req.body?.startSeq)
          ? req.body.startSeq
          : 0;
        streamCycleSteps(
          String(req.params['id'] ?? ''),
          String(req.params['cycleId'] ?? ''),
          steps,
          startSeq,
        );
        res.json({ ok: true, received: steps.length });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Internal: nanoagent containers push live browser frames here (stage44 doc 01,
  // step 2 of 5). Same public-route reasoning as /steps directly above — no session
  // cookie exists inside a container, and agentId + cycleId UUIDs are the bearer.
  // Nothing is persisted — a frame is a live view, not a record (see
  // streamCycleFrame's own note on why cycle_steps is the wrong home for these).
  app.post(
    '/api/agents/:id/cycles/:cycleId/frame',
    (req: Request, res: Response) => {
      try {
        const dataUrl =
          typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
        if (!dataUrl)
          return res.status(400).json({ error: 'dataUrl required' });
        // Only ever a base64 JPEG data URL from our own screencast. Checked
        // because this route is unauthenticated by design and the value lands
        // straight in an <img src> in the dashboard — a `javascript:` or
        // `data:text/html` payload here would be stored XSS against whoever is
        // watching. The agent side builds exactly this prefix and nothing else.
        if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
          return res
            .status(400)
            .json({ error: 'dataUrl must be a base64 JPEG data URL' });
        }
        // stage45 item 2: where the browser is, not just what it looks like. Both
        // are untrusted strings from a container and both land in the dashboard, so
        // they are length-capped here and rendered as text (never as a link target)
        // on the other side. A title is page-controlled by definition.
        const url =
          typeof req.body?.url === 'string' ? req.body.url.slice(0, 2048) : '';
        const title =
          typeof req.body?.title === 'string'
            ? req.body.title.slice(0, 300)
            : '';
        streamCycleFrame(
          String(req.params['id'] ?? ''),
          String(req.params['cycleId'] ?? ''),
          dataUrl,
          url,
          title,
        );
        res.json({ ok: true, bytes: dataUrl.length });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Internal: agent containers write memory here (no session cookie available).
  // agentId UUID serves as the implicit bearer token — no sensitive data is read.
  app.post('/api/agents/:id/memory', (req: Request, res: Response) => {
    try {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const { type, content, relevance } = req.body;
      if (!type || !content)
        return res.status(400).json({ error: 'type and content required' });
      const mem = recordMemory(
        String(req.params['id'] ?? ''),
        {
          type,
          content,
          relevance: typeof relevance === 'number' ? relevance : undefined,
        },
        { syncNow: false },
      );
      res.status(201).json(mem);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Internal: agent containers search memory here (FTS5 ranked, no auth required).
  app.get(
    '/api/agents/:id/memory/search',
    async (req: Request, res: Response) => {
      try {
        const agent = getAgent(String(req.params['id'] ?? ''));
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        const {
          q,
          limit = '20',
          type,
          track,
        } = req.query as Record<string, string>;
        if (!q || !q.trim())
          return res.status(400).json({ error: 'q parameter required' });
        const rows = await searchAgentMemoryRanked(
          String(req.params['id'] ?? ''),
          q,
          parseInt(limit, 10) || 20,
          type,
        );
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
    },
  );

  // Internal: agent containers create HITL check-ins (request_approval tool).
  app.post('/api/agents/:id/checkins', async (req: Request, res: Response) => {
    try {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const { status, report_md, action_type, action_payload } = req.body;
      // Stage 60 phase 3: THIS is the copy containers reach, so the daily send limit
      // has to be enforced here — see batchCheckinRefusal.
      const refusal = batchCheckinRefusal(
        (agent as { owner_id?: string | null }).owner_id,
        action_type,
        action_payload,
        ownerCheckins,
      );
      if (refusal) return res.status(refusal.status).json(refusal.body);
      const checkin = createAgentCheckin({
        agent_id: String(req.params['id'] ?? ''),
        status: status ?? 'pending',
        report_md: report_md ?? null,
        action_type: action_type ?? null,
        action_payload: action_payload ?? null,
      });
      // The owner's "don't ask" rules. THIS is the route containers reach — the first
      // version checked only the dashboard's copy and never fired for a real send.
      const auto = await autoApproveIfRuled(agent, checkin);
      if (auto) {
        getSocketIO()?.emit('agent:checkin_responded', {
          agentId: req.params['id'],
          checkinId: checkin.id,
        });
        return res
          .status(201)
          .json({ ...checkin, status: 'responded', ...auto });
      }
      getSocketIO()?.emit('agent:checkin_created', {
        agentId: req.params['id'],
        checkinId: checkin.id,
      });
      res.status(201).json(checkin);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Internal: agent containers push mid-cycle notifications (notify tool).
  app.post('/api/agents/:id/notify', (req: Request, res: Response) => {
    try {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const {
        message,
        urgency = 'normal',
        cycleId,
      } = req.body as { message?: string; urgency?: string; cycleId?: string };
      if (!message)
        return res.status(400).json({ error: 'message is required' });
      const timestamp = new Date().toISOString();
      globalEventBus.emit_agent({
        type: 'notification',
        agentId: String(req.params['id'] ?? ''),
        cycleId,
        message: message.slice(0, 500),
        urgency,
        timestamp,
      } as any);
      sendNotification(
        'agent_alert',
        `${agent.name}: ${urgency} alert`,
        message.slice(0, 500),
        String(req.params['id'] ?? ''),
        { urgency, cycleId },
      );
      res.json({ sent: true, channel: 'dashboard', timestamp });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Internal: agent containers create handoffs (handoff_to tool).
  app.post('/api/agents/:id/handoffs', (req: Request, res: Response) => {
    try {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      // THIS is the handler the handoff_to tool actually reaches. It is registered
      // directly on `app` before the agents router mounts, so Express matches it first
      // and the router's copy at routes/agents.ts never runs for an agent's request.
      //
      // That has now cost three fixes applied to the wrong copy: twice on target
      // resolution, and once when stage 56 added threading and deadlines to the
      // router's version — producing handoffs with a thread and no deadline, which is
      // a deadline that does not exist. So neither route implements this any more.
      // Both call createHandoffFromRequest, and a route's job is authentication.
      const result = createHandoffFromRequest(
        String(req.params['id'] ?? ''),
        req.body,
        getAllAgents(),
        getHandoffById,
      );
      if (result.status === 201) {
        const h = result.body as {
          id: string;
          to_agent_id: string;
          type: string;
          performative?: string;
        };
        getSocketIO()?.emit('agent:handoff_created', {
          fromAgentId: req.params['id'],
          toAgentId: h.to_agent_id,
          handoffId: h.id,
          type: h.type,
        });

        // Stage 59 (small fix, 2026-09-13) — see shouldWakeOnHandoff for why.
        const target = getAgent(h.to_agent_id);
        if (
          target &&
          shouldWakeOnHandoff(
            h.performative as HandoffPerformative | undefined,
            target,
          )
        ) {
          void agentService
            .runCycle(
              h.to_agent_id,
              'custom',
              `${agent.name} has handed you work via handoff_to (id ${h.id}). Check your pending handoffs and act on it.`,
            )
            .catch((err) => {
              logger.warn(
                {
                  from: req.params['id'],
                  to: h.to_agent_id,
                  err: err?.message,
                },
                'handoff: recipient wake cycle failed',
              );
            });
        }
      }
      res.status(result.status).json(result.body);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Internal: agent containers read/write shared project bulletin (bulletin tool).
  app.get('/api/agents/:id/bulletin', (req: Request, res: Response) => {
    try {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const projects = getAgentProjects(String(req.params['id'] ?? ''));
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

  app.post('/api/agents/:id/bulletin', (req: Request, res: Response) => {
    try {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const { section, content } = req.body as {
        section?: string;
        content?: string;
      };
      if (!section || !content)
        return res
          .status(400)
          .json({ error: 'section and content are required' });
      const projects = getAgentProjects(String(req.params['id'] ?? ''));
      const projectId = projects[0]?.id;
      if (!projectId)
        return res
          .status(400)
          .json({ error: 'Agent is not linked to a project' });
      const notesPath = path.join(
        PROJECTS_DIR,
        projectId,
        'workspace',
        `notes_${req.params['id']}.md`,
      );
      const header = `## ${section} (${agent.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')})\n\n`;
      fs.appendFileSync(notesPath, header + content + '\n\n', 'utf-8');
      const version =
        fs.readFileSync(notesPath, 'utf-8').split('## ').length - 1;
      res.json({ updated: true, version });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Public Container Callback Endpoints ─────────────────────────────────
  // Internal: agent containers query if they have been interrupted mid-cycle.
  app.get('/api/agents/:id/interrupt-flag', (req: Request, res: Response) => {
    try {
      res.json({ interrupted: getAgentInterruptFlag(req.params.id as string) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Internal: agent containers fetch on-demand credentials from the vault.
  //
  // Requires the per-cycle token, NOT just the agent UUID the neighbouring internal
  // routes rely on. Those routes only append rows; this one hands back live provider
  // secrets, and `credentialManager` is a platform-wide store, so every one of them was
  // readable by anyone who learned any agent id. Agent ids are not secrets — they appear
  // in logs, socket payloads and dashboard URLs — so this was an unauthenticated
  // credential-exfiltration endpoint reachable with a single GET.
  //
  // The token is minted per cycle and revoked when that cycle ends, so the window in
  // which this route answers at all is the window in which the agent is legitimately
  // running. Scope is unchanged on purpose: an agent already receives these same
  // platform credentials as injected env vars every cycle (see fetchAgentCredentials),
  // so requiring the token closes the hole without narrowing what a running agent can
  // legitimately reach — narrowing that would need an entitlement model the platform
  // does not currently have.
  app.get(
    '/api/agents/:id/credentials/:service',
    (req: Request, res: Response) => {
      try {
        const agentId = req.params.id as string;
        const token = extractCycleToken(
          req.headers.authorization,
          req.headers['x-cycle-token'],
        );
        if (!verifyCycleToken(token, agentId)) {
          logger.warn(
            { agentId, service: req.params.service },
            'Credential fetch rejected — invalid or expired cycle token',
          );
          return res
            .status(401)
            .json({ error: 'Invalid or expired cycle token' });
        }

        const agent = getAgent(agentId);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        // `browser:*` holds logins a person stored for a site, in a store with no owner
        // in its key. Serving it here would hand one customer's login to another
        // customer's agent. User credentials reach an agent through the secrets store
        // (scoped platform → owner → agent, injected as env vars) — see stage 51.
        if (String(req.params.service).startsWith('browser:')) {
          return res.status(404).json({
            error: `No credential stored for service '${req.params.service}'`,
          });
        }

        const creds = credentialManager.get(req.params.service as string);
        if (!creds)
          return res.status(404).json({
            error: `No credential stored for service '${req.params.service}'`,
          });

        res.json(creds);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Internal: agent containers send a message to another agent.
  app.post('/api/agents/:id/messages/send', (req: Request, res: Response) => {
    try {
      const fromAgent = getAgent(req.params.id as string);
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
      if (!getAgent(toAgentId))
        return res
          .status(404)
          .json({ error: `Target agent '${toAgentId}' not found` });

      const msg = createAgentMessage({
        from_agent_id: req.params.id as string,
        to_agent_id: toAgentId,
        subject: subject.slice(0, 120),
        body,
      });
      res.status(201).json({ id: msg.id, delivered: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Internal: agent containers search FTS5 memory of all crew agents in this project.
  app.get(
    '/api/projects/:id/memory/search',
    async (req: Request, res: Response) => {
      try {
        const project = getProject(req.params.id as string);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const { q, limit = '20' } = req.query as Record<string, string>;
        if (!q || !q.trim())
          return res.status(400).json({ error: 'q parameter required' });

        const agents = getProjectAgents(req.params.id as string);
        if (agents.length === 0) return res.json([]);

        const lim = Math.min(parseInt(limit, 10) || 20, 100);
        const perAgent = Math.max(1, Math.ceil(lim / agents.length));

        const rows: unknown[] = [];
        for (const agent of agents) {
          const results = await searchAgentMemoryRanked(
            (agent as any).id,
            q,
            perAgent,
          );
          for (const r of results) {
            rows.push({
              ...(r as object),
              agent_name: (agent as any).name,
              agent_emoji: (agent as any).emoji,
            });
          }
        }

        rows.sort(
          (a: any, b: any) => (a.search_rank ?? 0) - (b.search_rank ?? 0),
        );
        res.json(rows.slice(0, lim));
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Internal: agent containers verify a candidate tool in the isolated Docker sidecar.
  app.post(
    '/api/agents/:id/sidecar/verify',
    async (req: Request, res: Response) => {
      try {
        const agent = getAgent(req.params.id as string);
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
        const sidecar = sidecarRegistry.get(req.params.id as string);
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
    },
  );

  // Internal: agent containers invoke a sidecar tool.
  app.post(
    '/api/agents/:id/sidecar/call',
    async (req: Request, res: Response) => {
      try {
        const agent = getAgent(req.params.id as string);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        const { tool, args = {} } = req.body as {
          tool?: string;
          args?: Record<string, unknown>;
        };
        if (!tool) return res.status(400).json({ error: 'tool name required' });
        const sidecar = sidecarRegistry.get(req.params.id as string);
        await sidecar.ensure();
        const result = await sidecar.call(tool, args);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Internal: an agent container holds an outside-world tool call here while a
  // human decides (Strict posture). Unauthenticated for the same reason as the
  // sidecar routes above — the container has no session — and safe in the same
  // way: these three can only *create*, *read*, or *deny* a request. Approving
  // one requires the owner's session on the authenticated route.
  app.post('/api/agents/:id/tool-approvals', (req: Request, res: Response) => {
    try {
      const agent = getAgent(req.params.id as string);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const { tool, args_preview, reason, cycle_id } = req.body as {
        tool?: string;
        args_preview?: string;
        reason?: string;
        cycle_id?: string;
      };
      if (!tool) return res.status(400).json({ error: 'tool required' });
      const approval = createToolApproval({
        agent_id: req.params.id as string,
        tool,
        args_preview: args_preview ?? null,
        reason: reason ?? null,
        cycle_id: cycle_id ?? null,
      });
      getSocketIO()?.emit('agent:approval_required', {
        agentId: approval.agent_id,
        approvalId: approval.id,
        tool: approval.tool,
        reason: approval.reason,
      });
      res.status(201).json(approval);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(
    '/api/agents/:id/tool-approvals/:approvalId',
    (req: Request, res: Response) => {
      const approval = getToolApproval(req.params.approvalId as string);
      if (!approval || approval.agent_id !== req.params.id) {
        return res.status(404).json({ error: 'Approval not found' });
      }
      res.json(approval);
    },
  );

  app.post(
    '/api/agents/:id/tool-approvals/:approvalId/expire',
    (req: Request, res: Response) => {
      const approval = getToolApproval(req.params.approvalId as string);
      if (!approval || approval.agent_id !== req.params.id) {
        return res.status(404).json({ error: 'Approval not found' });
      }
      const expired = expireToolApproval(approval.id) ?? approval;
      getSocketIO()?.emit('agent:approval_resolved', {
        agentId: expired.agent_id,
        approvalId: expired.id,
        status: expired.status,
      });
      res.json(expired);
    },
  );

  // ─── POST /api/agents/:id/trigger — event-driven cycle (token-authenticated) ──
  // C4: lets any external system (a reply webhook, a form submission, an alert) wake an
  // agent in response to an event. Auth via the agent's webhookToken. Fire-and-forget.
  // Must be mounted here, above the requireAuth gate below — it was previously registered
  // on agentsRouter (mounted after the gate), so every token-only caller got a blanket 401
  // before the route's own token check ever ran. Verified 2026-08-21: a valid webhookToken
  // still 401'd.
  app.post('/api/agents/:id/trigger', async (req: Request, res: Response) => {
    const agentId = String(req.params.id);
    const agent = agentService.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const token = String(
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        (req.body && req.body.token) ||
        (req.query && (req.query as any).token) ||
        '',
    ).trim();
    const expected = agent.config.webhookToken;
    if (!expected || token !== expected)
      return res.status(401).json({ error: 'Invalid or missing token' });

    const { event, data, instruction } = (req.body ?? {}) as {
      event?: string;
      data?: unknown;
      instruction?: string;
    };
    const parts: string[] = ['## Event Trigger'];
    if (event) parts.push(`Event: ${String(event)}`);
    if (data !== undefined) {
      try {
        parts.push(
          'Data:\n```json\n' +
            JSON.stringify(data, null, 2).slice(0, 6000) +
            '\n```',
        );
      } catch {
        /* non-serializable */
      }
    }
    if (instruction) parts.push(String(instruction));
    parts.push(
      'Handle this event: take the appropriate action, update your tracked records if relevant, and report what you did.',
    );
    const ctx = parts.join('\n\n');

    // Fire-and-forget — external callers don't wait for the cycle to finish.
    // An explicit instruction means someone is directing this run, so the source tools'
    // what/when gates yield to it. A bare event (a reply webhook, a form post) is
    // automation reporting that something happened, and stays rotated like a schedule.
    void agentService
      .runCycle(agentId, 'custom', ctx, undefined, undefined, undefined, {
        humanRequested:
          typeof instruction === 'string' && instruction.trim().length > 0,
      })
      .catch((err: any) => {
        logger.warn(
          { agentId, err: String(err?.message ?? err) },
          'Event-trigger cycle failed',
        );
      });
    res.status(202).json({ accepted: true, agent: agent.name });
  });

  // Internal: an agent container manages its OWN schedule, model, budget, status and
  // WhatsApp replies. Mounted above the gate like the other container-facing routes, but
  // unlike them it is not open to anyone holding an agent UUID — every route inside
  // requires the per-cycle token minted in cycle-token.ts. These routes spend money and
  // decide whether an agent runs, so a non-secret identifier is not an adequate key.
  app.use('/api/agents', selfManageRouter);
  // Stage 57 — a boss agent's delegated runs. Same gate as self-management: the per-cycle
  // token. Workers get none, so they cannot raise workers.
  app.use('/api/agents', swarmRunsRouter);
  // stage45 doc 05 phase 3 — the container's end of the real-browser lane. Mounted here,
  // before requireAuth, for the same reason selfManageRouter is: a cycle container has no
  // session cookie. Its gate is the per-cycle token, not the absence of one.
  app.use('/api/agents', browserControlDispatchRouter);

  // ── Auth gate ────────────────────────────────────────────────────────────
  // Everything mounted below requires a valid login session.
  app.use('/api', requireAuth);

  // API routes (protected)
  app.use('/api', accountRouter);
  app.use('/api', statusRouter);
  app.use('/api', messagesRouter);
  app.use('/api', conversationsRouter);
  app.use('/api', tasksRouter);
  app.use('/api', chatRouter);
  app.use('/api', filesRouter);
  app.use('/api', artifactDocsRouter);
  app.use('/api/agents', agentsRouter);
  // Stage 51 gap 2 — a customer's own secrets, owner taken from the session (not admin-only).
  app.use('/api/owner-secrets', ownerSecretsRouter);
  // stage45 doc 05 phase 2 — browser-extension registration. Behind requireAuth above;
  // the WebSocket it points at authenticates with the ticket this mints, not the cookie.
  app.use('/api', browserControlRouter);
  app.use('/api', cycleVncRouter);
  app.use('/api/tools', toolsRouter);

  // ── Operator/platform config — admin only (Stage 28, Phase 5) ─────────────
  // These manage platform-wide secrets, models, infra and usage — not per-client
  // data — so a logged-in client must not reach them. (Also closes Topic-07: the
  // credentials/secrets API previously had no auth at all.)
  //
  // IMPORTANT: requireAdmin must be scoped to each router's OWN path prefix. Mounting
  // it at the bare '/api' (e.g. `app.use('/api', requireAdmin, containersRouter)`)
  // leaks the guard onto every /api route registered afterwards (notifications,
  // projects, pipelines…), 403-ing clients on their own data. containers/usage/
  // model-config live under '/api' so they get a dedicated path-scoped guard;
  // credentials/secrets/settings already mount at their own prefix.
  app.use('/api/containers', requireAdmin);
  app.use('/api/usage', requireAdmin);
  app.use('/api/model-config', requireAdmin);
  app.use('/api', containersRouter);
  app.use('/api', usageRouter);
  app.use('/api/credentials', requireAdmin, credentialsRouter);
  app.use('/api/secrets', requireAdmin, secretsRouter);
  app.use('/api/settings', requireAdmin, settingsRouter);
  app.use('/api/admin', requireAdmin, adminRouter);
  // MCP servers are per-user (Stage 32) — every logged-in client manages their own,
  // enforced inside mcpRouter itself; no requireAdmin gate here (see mcp.ts).
  app.use('/api/mcp', mcpRouter);

  // Per-agent computer-use is mounted at app level (outside agentsRouter), so it
  // needs its own ownership guard — reject unless the caller owns the agent.
  app.use(
    '/api/agents/:id/computer-use',
    (req: Request, res: Response, next: NextFunction) => {
      const agent = getAgent(String(req.params['id'] ?? ''));
      if (!agent || !ownsResource(req, agent.owner_id)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      next();
    },
    computerUseRouter,
  );

  // Escalations across the caller's OWN agents (admin sees all). Scoped so a client can't
  // see or resolve another tenant's computer-use approvals.
  const ownsApproval = (req: Request, approvalId: string): boolean => {
    const appr = listPendingApprovals().find((a) => a.id === approvalId);
    if (!appr) return false;
    return (
      req.user?.role === 'admin' ||
      ownsResource(req, getAgent(appr.agentId)?.owner_id)
    );
  };
  app.get('/api/computer-use/escalations', (req: Request, res: Response) => {
    const all = listPendingApprovals();
    const scoped =
      req.user?.role === 'admin'
        ? all
        : all.filter((e) => ownsResource(req, getAgent(e.agentId)?.owner_id));
    res.json({ escalations: scoped });
  });
  app.post(
    '/api/computer-use/escalations/:approvalId/approve',
    (req: Request, res: Response) => {
      const approvalId = String(req.params['approvalId'] ?? '');
      if (!ownsApproval(req, approvalId))
        return res
          .status(404)
          .json({ error: 'Approval not found or already resolved' });
      const ok = resolveApproval(approvalId, 'approved');
      if (!ok)
        return res
          .status(404)
          .json({ error: 'Approval not found or already resolved' });
      io?.emit('computer_use:escalation_resolved', {
        approvalId,
        decision: 'approved',
      });
      res.json({ decision: 'approved' });
    },
  );
  app.post(
    '/api/computer-use/escalations/:approvalId/deny',
    (req: Request, res: Response) => {
      const approvalId = String(req.params['approvalId'] ?? '');
      if (!ownsApproval(req, approvalId))
        return res
          .status(404)
          .json({ error: 'Approval not found or already resolved' });
      const ok = resolveApproval(approvalId, 'denied');
      if (!ok)
        return res
          .status(404)
          .json({ error: 'Approval not found or already resolved' });
      io?.emit('computer_use:escalation_resolved', {
        approvalId,
        decision: 'denied',
      });
      res.json({ decision: 'denied' });
    },
  );
  app.use('/api', projectsRouter);
  app.use('/api/crew', crewRouter);
  app.use('/api/pipelines', pipelinesRouter);
  // Stage 57 phase 5 — the owner's view of delegated runs (behind requireAuth, owner-scoped).
  app.use('/api/runs', runsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api', modelConfigRouter);

  // Serve production dashboard build (when available)
  const dashboardDistPath = path.resolve(
    import.meta.dirname ?? __dirname,
    '../../dashboard/dist',
  );
  // Static assets (JS/CSS chunks) have content-hashed filenames — cache forever.
  // index.html must never be cached: after a deploy its chunk references change.
  app.use(express.static(dashboardDistPath, { index: false }));
  // SPA fallback — serve index.html for any non-API route
  app.get('{*path}', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(dashboardDistPath, 'index.html'), (err) => {
      if (err) {
        // Dashboard not built yet — show a helpful message
        res
          .status(200)
          .send(
            '<h1>nanocrew Dashboard</h1><p>Run <code>cd dashboard && npm run build</code> to build the dashboard, or use <code>npm run dev</code> for development.</p>',
          );
      }
    });
  });

  // Global error handler — must be registered LAST (after all routes) and take 4 args
  // for Express to recognize it as error middleware. Catches errors thrown by middleware
  // BEFORE a route handler runs (e.g. multer file-count/size limits), which would
  // otherwise bypass every route's own try/catch and fall through to Express's default
  // bare-HTML 500 page instead of the JSON the dashboard expects.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'A file is too large (max 10MB each).'
          : err.code === 'LIMIT_FILE_COUNT' ||
              err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'Too many files in one upload (max 50).'
            : `Upload error: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    const message =
      err instanceof Error ? err.message : 'Internal server error';
    logger.error({ err }, 'Unhandled request error');
    res.status(500).json({ error: message });
  });

  // Container stat polling interval
  let statsInterval: NodeJS.Timeout | null = null;
  const activeLogStreams = new Map<string, ChildProcess>();

  // Socket.IO connection handler
  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'Dashboard client connected');

    // Stage 28 — join the room scoped emits target. Admins also get infra events.
    const user = (socket.data as { user?: SafeUser }).user;
    if (user) {
      socket.join(userRoom(user.id));
      if (user.role === 'admin') socket.join('admins');
      // DEBUG — remove after streaming confirmed working
      logger.info(
        { socketId: socket.id, userId: user.id, room: userRoom(user.id) },
        '[socket] client joined room',
      );
    } else {
      logger.warn(
        { socketId: socket.id },
        '[socket] client connected but no user in socket.data',
      );
    }

    // Start polling stats if this is the first client
    if (io?.engine.clientsCount === 1) {
      statsInterval = setInterval(() => {
        (async () => {
          try {
            const containers = await getContainers();
            const running = containers.filter((c) => c.state === 'running');
            const stats = (
              await Promise.all(running.map((c) => getContainerStats(c.id)))
            ).filter(Boolean);

            if (stats.length > 0) {
              io?.emit('container_stats', stats);
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to poll container stats');
          }
        })();
      }, 3000);
    }

    socket.on('container:logs:subscribe', ({ containerId }) => {
      if (activeLogStreams.has(containerId)) return;

      logger.info({ containerId }, 'Client subscribed to container logs');
      try {
        const proc = streamContainerLogs(
          containerId,
          (data) => {
            socket.emit('container:log:data', { containerId, data });
          },
          (err) => {
            logger.error({ containerId, err }, 'Log stream error');
            socket.emit('container:log:error', {
              containerId,
              error: err.message,
            });
          },
        );

        proc.on('close', () => {
          activeLogStreams.delete(containerId);
        });

        activeLogStreams.set(containerId, proc);
      } catch (err) {
        logger.error(
          { containerId, err },
          'Failed to subscribe to container logs',
        );
      }
    });

    // stage 49 phase 5.3 — human input into an agent's browser.
    //
    // Sent over the socket rather than POSTed because this is per-EVENT: a human
    // moving a mouse produces dozens a second, and an HTTP round trip each would be
    // both slow and pointless. It relays into the cycle channel, which is the only
    // inbound path a running container has.
    //
    // Authorisation is checked HERE and on every event, never once at subscribe
    // time: the socket is long-lived, a cycle id is guessable, and the far end of
    // this is a real browser that may be signed into things. Frames out are already
    // scoped by owner room; this is the same rule pointed inward.
    /** May this socket drive that cycle's browser? The agent id comes from the live
     *  channel, never from the client, so a caller cannot name someone else's agent. */
    const mayDriveCycle = (cycleId: string): string | null => {
      const agentId = agentForCycleChannel(cycleId);
      if (!agentId) return null; // no live cycle by that id — nothing to drive
      const sender = (socket.data as { user?: SafeUser }).user;
      if (!sender) return null;
      const ownerId = getAgent(agentId)?.owner_id ?? undefined;
      if (sender.role !== 'admin' && (!ownerId || ownerId !== sender.id)) {
        logger.warn(
          { userId: sender.id, agentId, cycleId },
          '[socket] refused browser control for an agent this user does not own',
        );
        return null;
      }
      return agentId;
    };

    socket.on(
      'browser:input',
      (payload: { cycleId?: string; input?: Record<string, unknown> }) => {
        const cycleId = String(payload?.cycleId ?? '');
        const input = payload?.input;
        if (!cycleId || !input || typeof input !== 'object') return;
        if (!mayDriveCycle(cycleId)) return;

        sendToCycle(cycleId, {
          t: 'input',
          kind: String(input.kind ?? '') as never,
          ...input,
        });
      },
    );

    // The human says they have finished. Authorised exactly like input: handing the
    // wheel back restarts an agent working in a browser, so it is not a lesser act.
    socket.on('browser:release', (payload: { cycleId?: string }) => {
      const cycleId = String(payload?.cycleId ?? '');
      if (!cycleId) return;
      const agentId = mayDriveCycle(cycleId);
      if (!agentId) return;
      logger.info(
        { agentId, cycleId },
        '[socket] human handed the browser back',
      );
      sendToCycle(cycleId, { t: 'release' });
    });

    socket.on('container:logs:unsubscribe', ({ containerId }) => {
      const proc = activeLogStreams.get(containerId);
      if (proc) {
        proc.kill();
        activeLogStreams.delete(containerId);
        logger.info({ containerId }, 'Client unsubscribed from container logs');
      }
    });

    socket.on('disconnect', () => {
      logger.debug({ socketId: socket.id }, 'Dashboard client disconnected');

      // Cleanup active log streams for this socket if needed
      // For now, if no clients left, kill all streams and stats polling
      if (io?.engine.clientsCount === 0) {
        if (statsInterval) {
          clearInterval(statsInterval);
          statsInterval = null;
        }
        for (const [id, proc] of activeLogStreams.entries()) {
          proc.kill();
          activeLogStreams.delete(id);
        }
      }
    });
  });

  // Must be installed before listen so no upgrade can arrive before the handler exists.
  installBrowserControlWs(server);

  // stage 52 step 4: teach the browser socket how to wake an agent whose cycle was
  // deferred for want of a browser. Registered rather than imported by the socket
  // layer — see browser-attach-wake.ts for why the direction matters.
  registerAgentWaker((agentId) =>
    agentService.runCycle(
      agentId,
      'custom',
      'Your browser has just connected. This cycle was waiting for it — carry on with ' +
        'the work that needed your signed-in session.',
    ),
  );
  // stage 60 phase 6: work queued for someone's computer runs when it connects, on
  // "This computer", streaming into the agent's chat like any message would.
  registerFollowupRunner(async (f) => {
    try {
      return await agentService.runCycle(
        f.agentId,
        'custom',
        followupPrompt(f),
        f.projectId,
        undefined,
        undefined,
        {
          laneHint: 'local',
          humanRequested: f.source === 'chat',
        },
      );
    } catch (err) {
      // A cycle already running would drop the queued work on the floor. Put it back;
      // it runs on the next connection.
      if (String((err as Error)?.message ?? err).includes('already running')) {
        localFollowups.add({
          agentId: f.agentId,
          principal: f.principal,
          task: f.task,
          source: f.source,
          projectId: f.projectId,
          reason: f.reason,
        });
      }
      throw err;
    }
  });
  // stage 49 phase 5.2. Both register their own 'upgrade' listener and each
  // returns quietly for a path it does not own, so they coexist with socket.io
  // and with each other.
  installCycleChannelWs(server);
  // stage 50 phase 3 — the VNC bridge, on its own socket so a framebuffer stream can
  // never queue ahead of the cycle channel's `release` or interrupt.
  installCycleVncWs(server);

  server.listen(port, () => {
    logger.info({ port }, 'Dashboard API server listening');
    // Wire self-healing pipeline now that Socket.IO is ready
    initSelfHealing();
    // Register the tool lifecycle manager for the tools router
    setToolLifecycleManager(toolLifecycleManager);
  });
}
