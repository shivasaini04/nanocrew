import { EventEmitter } from 'node:events';

// ─── Event types ──────────────────────────────────────────────────────────────

export type CycleProgressEvent =
  | { type: 'iteration'; n: number; of: number }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; preview: string }
  | { type: 'error'; tool: string; message: string }
  | { type: 'cache_hit'; tool: string }
  | { type: 'retry'; tool: string; attempt: number };

export type AgentEvent =
  | { type: 'run_start'; agentId: string; runId: string; trigger: string }
  | { type: 'llm_chunk'; text: string }
  | { type: 'tool_start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; result: unknown; durationMs: number }
  | {
      type: 'run_end';
      runId: string;
      totalTokens: number;
      durationMs: number;
      cost: number;
    }
  | { type: 'run_error'; error: string }
  | {
      type: 'cycle_progress';
      agentId: string;
      runId: string;
      event: CycleProgressEvent;
    }
  | {
      type: 'notification';
      agentId: string;
      cycleId?: string;
      message: string;
      urgency: 'normal' | 'high' | 'critical';
      timestamp: string;
    };

// ─── EventBus ─────────────────────────────────────────────────────────────────

export class EventBus extends EventEmitter {
  emit_agent(event: AgentEvent): void {
    this.emit('agent_event', event);
  }

  on_agent(handler: (event: AgentEvent) => void): this {
    return this.on('agent_event', handler);
  }
}

/** Singleton per process — the agent runtime emits here; SSE routes subscribe. */
export const globalEventBus = new EventBus();
