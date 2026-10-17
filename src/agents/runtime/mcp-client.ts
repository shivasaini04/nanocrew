/**
 * McpToolResolver — connects to MCP servers and wraps their tools as
 * Vercel AI SDK Tool objects that can be merged into an AgentRuntime run.
 *
 * Lifecycle per agent run:
 *   const { tools, close } = await resolver.loadServerTools(cfg, context);
 *   // ... use tools in streamText ...
 *   await close();
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { tool, jsonSchema, type ToolSet } from 'ai';
import { logger } from '../../logger.js';
import type { McpServerConfig } from './mcp-config.js';
import type { RunContext } from './tool-registry.js';

// ─── Response content → string ────────────────────────────────────────────────

function contentToString(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((item: unknown) => {
      if (typeof item === 'object' && item !== null) {
        const c = item as Record<string, unknown>;
        if (c.type === 'text') return String(c.text ?? '');
        if (c.type === 'resource') return String(c.text ?? c.uri ?? '');
        if (c.type === 'image') return `[image: ${c.mimeType ?? 'unknown'}]`;
      }
      return String(item);
    })
    .filter(Boolean)
    .join('\n');
}

// ─── Transport factory ────────────────────────────────────────────────────────

function createTransport(
  cfg: McpServerConfig,
): StdioClientTransport | SSEClientTransport {
  if (cfg.transport === 'sse') {
    if (!cfg.url)
      throw new Error(
        `MCP server "${cfg.name}" is SSE transport but has no url`,
      );
    return new SSEClientTransport(new URL(cfg.url));
  }

  if (!cfg.command)
    throw new Error(
      `MCP server "${cfg.name}" is stdio transport but has no command`,
    );
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env
      ? ({ ...process.env, ...cfg.env } as Record<string, string>)
      : undefined,
  });
}

// ─── McpToolResolver ─────────────────────────────────────────────────────────

/** Cached MCP connection with its tool set and expiry timestamp. */
interface CachedMcpEntry {
  tools: ToolSet;
  close: () => Promise<void>;
  expiresAt: number;
}

const MCP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class McpToolResolver {
  /** In-memory cache keyed by `serverName:agentId`. */
  private cache = new Map<string, CachedMcpEntry>();

  /**
   * Connect to one MCP server, list its tools, and return them as a Vercel
   * AI SDK ToolSet. Also returns a `close()` to clean up after the run.
   */
  async loadServerTools(
    cfg: McpServerConfig,
    _context: RunContext,
  ): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
    const client = new Client({ name: 'NanoCrew', version: '1.0.0' });
    const transport = createTransport(cfg);

    await client.connect(transport);

    const { tools: mcpTools } = await client.listTools();
    logger.debug(
      { server: cfg.name, count: mcpTools.length },
      'MCP tools loaded',
    );

    const vercelTools: ToolSet = {};

    for (const mcpTool of mcpTools) {
      const toolName = `${cfg.name.toLowerCase().replace(/\s+/g, '_')}__${mcpTool.name}`;

      vercelTools[toolName] = tool({
        description: mcpTool.description ?? mcpTool.name,
        inputSchema: jsonSchema<Record<string, unknown>>(
          (mcpTool.inputSchema ?? {
            type: 'object',
            properties: {},
          }) as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: Record<string, unknown>) => {
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: args,
            });
            return contentToString(result.content);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              { server: cfg.name, tool: mcpTool.name, err: msg },
              'MCP tool call failed',
            );
            return `Error calling ${mcpTool.name}: ${msg}`;
          }
        },
      }) as unknown as ToolSet[string];
    }

    const close = async () => {
      try {
        await client.close();
      } catch {
        /* ignore close errors */
      }
    };

    return { tools: vercelTools, close };
  }

  /**
   * Load tools from multiple servers, skipping any that fail to connect.
   * Uses an in-memory cache (TTL = 5 min) to avoid re-connecting to the
   * same server for the same agent within the cache window.
   * Returns merged ToolSet and a single close() for all connections.
   */
  async loadAll(
    configs: McpServerConfig[],
    context: RunContext,
  ): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
    const results: Array<{ tools: ToolSet; close: () => Promise<void> }> = [];
    const now = Date.now();

    for (const cfg of configs) {
      const cacheKey = `${cfg.name}:${context.agentId}`;
      const cached = this.cache.get(cacheKey);

      if (cached && cached.expiresAt > now) {
        // Cache hit — reuse the resolved tool schemas (connection stays alive).
        logger.debug(
          { server: cfg.name, agentId: context.agentId },
          'MCP cache hit — reusing tools',
        );
        results.push({ tools: cached.tools, close: async () => {} });
        continue;
      }

      try {
        const r = await this.loadServerTools(cfg, context);
        // Cache the result with its live connection.
        this.cache.set(cacheKey, {
          tools: r.tools,
          close: r.close,
          expiresAt: now + MCP_CACHE_TTL_MS,
        });
        // On close, only clean up the connection (the cache entry will expire naturally).
        results.push({ tools: r.tools, close: async () => {} });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { server: cfg.name, err: msg },
          'Failed to connect to MCP server — skipping',
        );
      }
    }

    const merged: ToolSet = Object.assign({}, ...results.map((r) => r.tools));
    const close = () =>
      Promise.all(results.map((r) => r.close())).then(() => undefined);

    return { tools: merged, close };
  }

  /** Evict all cached entries (e.g. on server config change). */
  clearCache(): void {
    for (const entry of this.cache.values()) {
      entry.close().catch(() => {});
    }
    this.cache.clear();
  }
}

export const mcpToolResolver = new McpToolResolver();
