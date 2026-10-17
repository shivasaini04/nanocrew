/**
 * MCP server management routes — Stage 32: per-user, not global. Each user manages only
 * their own MCP servers, and a server only ever runs against agents that same user owns
 * (enforced again at read-time in mcp-config.ts's getServersForAgent, defense in depth).
 *
 * GET    /api/mcp/servers           — list the caller's own servers
 * GET    /api/mcp/servers/catalog   — well-known server templates (read-only reference data)
 * POST   /api/mcp/servers           — register a new server, owned by the caller
 * PATCH  /api/mcp/servers/:id       — update (enable/disable, rename, etc.) — own servers only
 * DELETE /api/mcp/servers/:id       — remove — own servers only
 * POST   /api/mcp/servers/:id/test  — connect and list available tools — own servers only
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listMcpServersForOwner,
  getMcpServer,
  upsertMcpServer,
  removeMcpServer,
  WELL_KNOWN_SERVERS,
  type McpServerConfig,
} from '../../agents/runtime/mcp-config.js';
import { mcpToolResolver } from '../../agents/runtime/mcp-client.js';
import { getAgent } from '../../db.js';
import { logger } from '../../logger.js';

export const mcpRouter = Router();

/** True if the server exists and belongs to the caller (admins are not special-cased —
 *  they manage their own MCP servers like anyone else; use impersonation to debug a client's). */
function ownsServer(req: Request, id: string): McpServerConfig | null {
  const s = getMcpServer(id);
  if (!s || s.owner_id !== req.user!.id) return null;
  return s;
}

/** Every agentId in the list must belong to the caller — prevents attaching a server to
 *  (and thereby running arbitrary MCP commands against) another tenant's agent. */
function invalidAgentIds(
  req: Request,
  agentIds: string[] | undefined,
): boolean {
  if (!agentIds?.length) return false;
  return agentIds.some((id) => getAgent(id)?.owner_id !== req.user!.id);
}

// ─── List (own only) ────────────────────────────────────────────────────────────

mcpRouter.get('/servers', (req: Request, res: Response) => {
  try {
    res.json(listMcpServersForOwner(req.user!.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Well-known catalog ───────────────────────────────────────────────────────

mcpRouter.get('/servers/catalog', (_req, res) => {
  res.json(WELL_KNOWN_SERVERS);
});

// ─── Register ─────────────────────────────────────────────────────────────────

mcpRouter.post('/servers', (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<McpServerConfig>;

    if (!body.name) return res.status(400).json({ error: 'name is required' });
    if (!body.transport)
      return res
        .status(400)
        .json({ error: 'transport is required (stdio | sse)' });
    if (body.transport === 'stdio' && !body.command) {
      return res
        .status(400)
        .json({ error: 'command is required for stdio transport' });
    }
    if (body.transport === 'sse' && !body.url) {
      return res
        .status(400)
        .json({ error: 'url is required for sse transport' });
    }
    if (invalidAgentIds(req, body.agentIds)) {
      return res
        .status(400)
        .json({ error: 'agentIds must only reference your own agents' });
    }

    const server = upsertMcpServer({
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: body.args ?? [],
      env: body.env,
      url: body.url,
      agentIds: body.agentIds ?? [],
      enabled: body.enabled ?? true,
      owner_id: req.user!.id, // stamped server-side — a client can never set another owner
    });

    res.status(201).json(server);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update ───────────────────────────────────────────────────────────────────

mcpRouter.patch('/servers/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = ownsServer(req, id);
    if (!existing)
      return res.status(404).json({ error: 'MCP server not found' });
    if (invalidAgentIds(req, req.body?.agentIds)) {
      return res
        .status(400)
        .json({ error: 'agentIds must only reference your own agents' });
    }

    const updated = upsertMcpServer({
      ...existing,
      ...req.body,
      id,
      owner_id: existing.owner_id,
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────

mcpRouter.delete('/servers/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!ownsServer(req, id))
      return res.status(404).json({ error: 'MCP server not found' });
    removeMcpServer(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test — connect, list tools, disconnect ───────────────────────────────────

mcpRouter.post('/servers/:id/test', async (req: Request, res: Response) => {
  const cfg = ownsServer(req, String(req.params.id));
  if (!cfg) return res.status(404).json({ error: 'MCP server not found' });

  try {
    const { tools, close } = await mcpToolResolver.loadServerTools(cfg, {
      agentId: 'test',
      runId: 'test',
      workspacePath: '.',
      agentDir: '.',
    });

    const toolNames = Object.keys(tools);
    await close();

    logger.info(
      { server: cfg.name, toolCount: toolNames.length },
      'MCP server test succeeded',
    );
    res.json({
      status: 'connected',
      server: cfg.name,
      toolCount: toolNames.length,
      tools: toolNames,
    });
  } catch (err: any) {
    logger.warn(
      { server: cfg.name, err: err.message },
      'MCP server test failed',
    );
    res
      .status(500)
      .json({ status: 'error', server: cfg.name, error: err.message });
  }
});
