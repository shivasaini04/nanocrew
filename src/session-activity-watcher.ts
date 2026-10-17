/**
 * Shared activity watcher — Stage 20 gap B.
 *
 * Polls a nanobot cycle's `activity.json` (written incrementally by the Python
 * adapter, one entry per tool call) and emits `chat:activity` socket events
 * scoped to a given chatJid, so the dashboard chat shows live tool activity
 * while a heavy cycle runs.
 *
 * Extracted so both the group message loop (src/index.ts) and the per-agent
 * chat dispatch (src/channels/dashboard.ts) can reuse the exact same logic
 * without a circular import.
 */
import fs from 'fs';
import type { Server as SocketIOServer } from 'socket.io';

export function startActivityWatcher(
  io: SocketIOServer | undefined,
  activityFile: string,
  chatJid: string,
): () => void {
  let stopped = false;
  // null until first read, so we skip steps that pre-date this run.
  let baseline: number | null = null;
  let lastEmitted = 0;

  io?.emit('chat:activity', { chatJid, type: 'start' });

  const poll = () => {
    if (stopped) return;
    try {
      if (fs.existsSync(activityFile)) {
        const raw = fs.readFileSync(activityFile, 'utf-8');
        const data = JSON.parse(raw) as {
          steps?: Array<Record<string, unknown>>;
        };
        const steps = data.steps ?? [];

        if (baseline === null) {
          baseline = steps.length;
          lastEmitted = steps.length;
        }

        // New cycle overwrote the file (step count dropped) → reset and emit all.
        if (steps.length < lastEmitted) {
          baseline = 0;
          lastEmitted = 0;
        }

        for (let i = lastEmitted; i < steps.length; i++) {
          const step = steps[i] as {
            type?: string;
            id?: string;
            tool?: string;
            input?: string;
            output?: string;
            content?: string;
          };
          if (step.type === 'thinking' && step.content) {
            io?.emit('chat:activity', {
              chatJid,
              type: 'thinking',
              content: step.content,
            });
          } else if (step.type === 'tool_call' && step.tool) {
            io?.emit('chat:activity', {
              chatJid,
              type: 'tool_call',
              callId: step.id ?? `${step.tool}_${Date.now()}`,
              tool: step.tool,
              input: step.input ?? '{}',
            });
          } else if (step.type === 'tool_result' && step.id) {
            io?.emit('chat:activity', {
              chatJid,
              type: 'tool_result',
              callId: step.id,
              output: step.output ?? '',
            });
          }
        }
        lastEmitted = steps.length;
      }
    } catch {
      /* file not yet written or mid-write — retry next tick */
    }
    setTimeout(poll, 300);
  };

  setTimeout(poll, 300);

  return () => {
    stopped = true;
    io?.emit('chat:activity', { chatJid, type: 'done' });
  };
}
