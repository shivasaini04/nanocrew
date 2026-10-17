/**
 * MCP server config store — persisted as DATA_DIR/mcp-servers.json.
 * Each entry describes one MCP server: transport, command/URL, and enabled flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../config.js';
import { getAgent } from '../../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse fields
  url?: string;
  // shared
  enabled: boolean;
  /** Optional: restrict to specific agents (empty = available to all of the OWNER's agents) */
  agentIds?: string[];
  /** Stage 32 — the user who added this server. Each user manages only their own; a server
   *  only ever applies to agents owned by the SAME user (enforced in getServersForAgent).
   *  null = legacy/pre-multi-tenant entry (treated as unowned — no agent can use it). */
  owner_id: string | null;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORE_FILE = path.join(DATA_DIR, 'mcp-servers.json');

function load(): McpServerConfig[] {
  if (!fs.existsSync(STORE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(servers: McpServerConfig[]): void {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(servers, null, 2), 'utf-8');
}

// ─── CRUD helpers ─────────────────────────────────────────────────────────────

/** All servers belonging to one user. This is the only listing a route handler should use —
 *  there is no cross-tenant "list everyone's servers" API by design. */
export function listMcpServersForOwner(ownerId: string): McpServerConfig[] {
  return load().filter((s) => s.owner_id === ownerId);
}

export function getMcpServer(id: string): McpServerConfig | undefined {
  return load().find((s) => s.id === id);
}

export function upsertMcpServer(
  cfg: Omit<McpServerConfig, 'id'> & { id?: string },
): McpServerConfig {
  const servers = load();
  const id = cfg.id ?? randomUUID();
  const existing = servers.findIndex((s) => s.id === id);
  const entry: McpServerConfig = { ...cfg, id };
  if (existing === -1) servers.push(entry);
  else servers[existing] = entry;
  save(servers);
  return entry;
}

export function removeMcpServer(id: string): void {
  save(load().filter((s) => s.id !== id));
}

/** Returns all enabled servers available to an agent — scoped to the agent's OWN owner.
 *  A server can never apply to another tenant's agent, even if its agentIds list were somehow
 *  to contain that agent's id (defense in depth on top of the API-layer ownership checks). */
export function getServersForAgent(agentId: string): McpServerConfig[] {
  const ownerId = getAgent(agentId)?.owner_id;
  if (!ownerId) return [];
  return load().filter(
    (s) =>
      s.enabled &&
      s.owner_id === ownerId &&
      (!s.agentIds?.length || s.agentIds.includes(agentId)),
  );
}

// ─── Well-known server catalog ────────────────────────────────────────────────

export const WELL_KNOWN_SERVERS: Array<
  Omit<McpServerConfig, 'id' | 'enabled' | 'owner_id'>
> = [
  {
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
  },
  {
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp/agent-workspace',
    ],
  },
  {
    // The official fetch server (@modelcontextprotocol/server-fetch) is Python/uvx-only —
    // there's no such npm package, so the old entry here 404'd on every use. This is the
    // maintained npm/npx-installable equivalent.
    name: 'Fetch (web)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-fetch-typescript'],
  },
  {
    name: 'Postgres',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-postgres',
      'postgresql://localhost/db',
    ],
  },
];
