/**
 * Stage 28 — realtime data isolation (Topic 03 follow-up).
 *
 * The dashboard broadcasts ~25 event types over Socket.IO via `io.emit(...)`. Left
 * global, every connected client would receive every other client's agent activity,
 * chat messages and job output — the realtime twin of the REST data-isolation work.
 *
 * Rather than edit ~60 emit call sites, we patch `io.emit` once. Every call site uses
 * `getSocketIO()?.emit(...)`, which IS this same `io.emit`, so a single override routes
 * them all. Each event is delivered only to the owning user's room (`user:<id>`), or to
 * the `admins` room for infra/operator events. Sockets join their room on connect.
 *
 * Security default: if we can't confidently derive an owner, the event goes to `admins`
 * only — never a broadcast. Worst case a client misses a live update (recovered on
 * refresh via the owner-scoped REST API); a cross-tenant leak is impossible.
 */
import type { Server } from 'socket.io';

import { getAgentOwner, getProject } from '../db.js';

/** Exported for tests: which user's room an event belongs to (null = operator only). */
export function ownerForEvent(event: string, payload: any): string | null {
  const p = payload ?? {};
  try {
    if (event.startsWith('agent:')) {
      return getAgentOwner(p.agentId ?? p.id ?? p.agent_id);
    }
    if (event.startsWith('chat:')) {
      const jid: string = p.chatJid ?? p.jid ?? '';
      if (typeof jid === 'string' && jid.startsWith('agent:'))
        return getAgentOwner(jid.slice('agent:'.length));
      if (typeof jid === 'string' && jid.startsWith('project:'))
        return getProject(jid.slice('project:'.length))?.owner_id ?? null;
      if (p.agentId) return getAgentOwner(p.agentId);
      return null;
    }
    // Stage 35 — the conversation event stream. Its owner is the thread it belongs to,
    // exactly as for `chat:`. Without this case the event derives no owner and the
    // fallback below routes it to `admins` only: every non-admin client silently loses
    // every live update, and the conversation only appears on reload via REST. Which is
    // precisely what happened in prod — and never locally, because the local tester was
    // the admin and so sat in the one room that still received them.
    if (event.startsWith('conversation:')) {
      const conv: string = p.conversation ?? '';
      if (typeof conv === 'string' && conv.startsWith('agent:'))
        return getAgentOwner(conv.slice('agent:'.length));
      if (typeof conv === 'string' && conv.startsWith('project:'))
        return getProject(conv.slice('project:'.length))?.owner_id ?? null;
      return null;
    }
    if (event.startsWith('project:')) {
      const pid = p.projectId ?? p.id;
      return pid ? (getProject(pid)?.owner_id ?? null) : null;
    }
    if (event.startsWith('computer_use:')) {
      return p.agentId ? getAgentOwner(p.agentId) : null;
    }
    if (event === 'notification:new' || event === 'policy_notification') {
      return p.owner_id ?? getAgentOwner(p.agent_id);
    }
    if (event === 'file:created') {
      if (p.agentId) return getAgentOwner(p.agentId);
      if (p.projectId) return getProject(p.projectId)?.owner_id ?? null;
      return null;
    }
    if (event === 'lane_event') {
      return p.agentId ? getAgentOwner(p.agentId) : null;
    }
  } catch {
    return null;
  }
  // container_stats, worker:log:relay, and anything underivable → operator only.
  return null;
}

/** Room a socket joins for its user. Exported so the connection handler stays in sync. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Patch io.emit so every broadcast is delivered only to the owning user's room
 * (or `admins` for infra/underivable events). Call once, right after io is created.
 */
export function installSocketScoping(io: Server): void {
  const emitToRooms = io.to.bind(io);
  (io as unknown as { emit: (...a: any[]) => boolean }).emit = (
    event: string,
    ...args: any[]
  ) => {
    const owner = ownerForEvent(event, args[0]);
    const target = owner ? userRoom(owner) : 'admins';
    (emitToRooms(target).emit as any)(event, ...args);
    return true;
  };
}
