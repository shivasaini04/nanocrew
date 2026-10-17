/**
 * Holders for the singletons the API server creates at startup (Socket.IO).
 *
 * This module exists to be a LEAF: it imports nothing at runtime (the type below is
 * `import type`, erased at compile time). That is the entire point.
 *
 * These accessors used to live in server.ts, which imports every router — and the
 * routers import agent-registry, which constructs AgentService. So any module that
 * merely wanted to emit a socket event (`import { getSocketIO } from './api/server.js'`)
 * pulled in the whole server graph and created a cycle:
 *
 *   agent-service → api/server → routes/agents → agent-registry → agent-service
 *
 * At runtime the orchestrator survives it because index.ts happens to enter the
 * cycle at a point where it resolves, but anything entering elsewhere hits
 * "Cannot access 'AgentService' before initialization" — which is why
 * agent-service.test.ts and agent-scheduler.test.ts could not even import their
 * subjects.
 *
 * Rule: to emit an event from a non-server module, import from HERE, never from
 * server.ts. Adding a runtime import to this file re-creates the cycle.
 */
import type { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

/** Set by createApiServer once Socket.IO is constructed. */
export function setSocketIO(instance: SocketIOServer | null): void {
  io = instance;
}

/** The Socket.IO instance, or null before the server has started (e.g. in tests). */
export function getSocketIO(): SocketIOServer | null {
  return io;
}

/**
 * Sends a message to a chat JID on whichever channel owns it (WhatsApp, dashboard, …).
 * `sender` lets an agent's messages carry its own name/emoji instead of the assistant's.
 */
export type ChannelSender = (
  jid: string,
  text: string,
  sender?: { name: string; emoji?: string },
) => Promise<void>;

let channelSender: ChannelSender | null = null;

/**
 * Set by index.ts once the channel list is built.
 *
 * The `channels` array and the `whatsapp` instance are both module-local `let`s in
 * index.ts and neither is exported, so every subsystem that needs to send (the task
 * scheduler, the IPC watcher, the job worker) is handed a `sendMessage` callback at
 * construction time. Routes have no such constructor, so they get the callback here
 * instead — same dependency, same direction, registered once at startup.
 */
export function setChannelSender(fn: ChannelSender | null): void {
  channelSender = fn;
}

/**
 * The channel sender, or null when no channel is up yet (tests, or WhatsApp disabled).
 * Callers must handle null rather than assuming a channel exists — WHATSAPP_ENABLED is
 * off in plenty of deployments.
 */
export function getChannelSender(): ChannelSender | null {
  return channelSender;
}
