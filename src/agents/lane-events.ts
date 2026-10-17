/**
 * Lane Events — typed event bus for NanoCrew agent orchestration.
 *
 * Ported from claw-code-main/rust/crates/runtime/src/lane_events.rs.
 *
 * A "lane" is a logical work-stream — in NanoCrew terms, one agent running
 * one cycle type (e.g. agentId + "lead_search"). The LaneEventBus replaces
 * ad-hoc log parsing with a structured event stream that the dashboard SSE
 * endpoint and the future policy engine can consume without polling.
 */

import { EventEmitter } from 'events';

// ─── Failure taxonomy ─────────────────────────────────────────────────────────

/** Every failure falls into exactly one class. Enables rule-based routing:
 *  "escalate TrustGate, retry PromptDelivery, abort BranchDivergence." */
export enum LaneFailureClass {
  PromptDelivery = 'PromptDelivery', // Worker didn't receive the prompt
  TrustGate = 'TrustGate', // Blocked on trust approval
  BranchDivergence = 'BranchDivergence', // Branch too far from base
  Compile = 'Compile', // Build failed
  Test = 'Test', // Test suite failed
  PluginStartup = 'PluginStartup', // Plugin didn't load
  McpStartup = 'McpStartup', // MCP server failed to start
  McpHandshake = 'McpHandshake', // MCP initialize handshake failed
  GatewayRouting = 'GatewayRouting', // API gateway sent request to wrong provider
  ToolRuntime = 'ToolRuntime', // Tool execution failed (bash exit 1, etc.)
  ModelProvider = 'ModelProvider', // LLM/provider call failed (rate limit, mid-stream drop, etc.)
  Infra = 'Infra', // Disk full, network partition, process crash
}

// ─── Worker state machine ─────────────────────────────────────────────────────

/** Legal transitions:
 *  Spawning → TrustRequired → ReadyForPrompt → Running → Finished
 *             ↘               ↘                ↘
 *              Failed          Failed           Failed
 */
export enum WorkerState {
  Spawning = 'Spawning', // Process starting; not yet responsive
  TrustRequired = 'TrustRequired', // Waiting for trust-gate resolution
  ReadyForPrompt = 'ReadyForPrompt', // Booted, tools loaded, waiting for work
  Running = 'Running', // Executing a prompt
  Finished = 'Finished', // Completed work, can be terminated cleanly
  Failed = 'Failed', // Crashed or hit unrecoverable error
}

// ─── Lane status (aggregated from events) ────────────────────────────────────

export type LaneStatus = 'idle' | 'running' | 'green' | 'red' | 'blocked';

// ─── Lane events discriminated union ─────────────────────────────────────────

export type LaneEvent =
  | {
      type: 'LaneStarted';
      lane: string;
      agentId: string;
      cycleId: string;
      ts: string;
    }
  | { type: 'LaneReady'; lane: string; agentId: string; ts: string }
  | {
      type: 'LaneBlocked';
      lane: string;
      agentId: string;
      reason: string;
      class: LaneFailureClass;
      ts: string;
    }
  | {
      type: 'LaneRed';
      lane: string;
      agentId: string;
      details: string;
      class: LaneFailureClass;
      ts: string;
    }
  | {
      type: 'LaneGreen';
      lane: string;
      agentId: string;
      cycleId: string;
      ts: string;
    }
  | { type: 'LaneFinished'; lane: string; agentId: string; ts: string }
  | {
      type: 'BranchStaleAgainstMain';
      lane: string;
      agentId: string;
      behindBy: number;
      ts: string;
    }
  | { type: 'TrustRequired'; agentId: string; ts: string }
  | { type: 'TrustResolved'; agentId: string; approved: boolean; ts: string }
  | {
      type: 'TurnStarted';
      lane: string;
      agentId: string;
      cycleId: string;
      ts: string;
    }
  | {
      type: 'TurnCompleted';
      lane: string;
      agentId: string;
      cycleId: string;
      cost: number;
      tasksDone: number;
      ts: string;
    }
  | {
      type: 'TurnFailed';
      lane: string;
      agentId: string;
      cycleId: string;
      reason: string;
      class: LaneFailureClass;
      ts: string;
    }
  | {
      type: 'WorkerStateChanged';
      agentId: string;
      from: WorkerState;
      to: WorkerState;
      ts: string;
    };

// ─── LaneState (aggregated per lane) ─────────────────────────────────────────

/** Conditions test aggregated state, not raw events — idempotent and testable. */
export interface LaneState {
  agentId: string;
  lane: string;
  currentStatus: LaneStatus;
  lastGreenAt: string | null;
  lastRedAt: string | null;
  redStreak: number;
  failureClass: LaneFailureClass | null;
  finished: boolean;
}

// ─── LaneEventBus ────────────────────────────────────────────────────────────

const LANE_EVENT = 'lane_event';

export class LaneEventBus extends EventEmitter {
  private recentEvents: LaneEvent[] = [];
  private readonly maxRecent = 500;
  private laneStates = new Map<string, LaneState>(); // key: `${agentId}:${lane}`

  /** Emit a lane event, update aggregated lane state, notify subscribers. */
  emit_event(event: LaneEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecent) {
      this.recentEvents.shift();
    }
    this._updateLaneState(event);
    this.emit(LANE_EVENT, event);
  }

  /** Subscribe to all lane events. */
  onEvent(listener: (event: LaneEvent) => void): void {
    this.on(LANE_EVENT, listener);
  }

  /** Remove an event listener. */
  offEvent(listener: (event: LaneEvent) => void): void {
    this.off(LANE_EVENT, listener);
  }

  /** Get the last N events (for SSE catch-up replay on connect). */
  getRecentEvents(limit = 100): LaneEvent[] {
    return this.recentEvents.slice(-limit);
  }

  /** Get current aggregated state for a specific lane. */
  getLaneState(agentId: string, lane: string): LaneState | undefined {
    return this.laneStates.get(`${agentId}:${lane}`);
  }

  /** Get all aggregated lane states (snapshot for dashboard initial load). */
  getAllLaneStates(): LaneState[] {
    return Array.from(this.laneStates.values());
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _getOrCreate(agentId: string, lane: string): LaneState {
    const key = `${agentId}:${lane}`;
    if (!this.laneStates.has(key)) {
      this.laneStates.set(key, {
        agentId,
        lane,
        currentStatus: 'idle',
        lastGreenAt: null,
        lastRedAt: null,
        redStreak: 0,
        failureClass: null,
        finished: false,
      });
    }
    return this.laneStates.get(key)!;
  }

  private _updateLaneState(event: LaneEvent): void {
    // Only events that carry a lane + agentId affect lane state
    if (!('lane' in event) || !('agentId' in event)) return;
    const { lane, agentId } = event as { lane: string; agentId: string };
    const state = this._getOrCreate(agentId, lane);

    switch (event.type) {
      case 'LaneStarted':
      case 'TurnStarted':
        state.currentStatus = 'running';
        state.finished = false;
        break;

      case 'LaneGreen':
      case 'TurnCompleted':
        state.currentStatus = 'green';
        state.lastGreenAt = event.ts;
        state.redStreak = 0;
        state.failureClass = null;
        break;

      case 'LaneRed':
      case 'TurnFailed':
        state.currentStatus = 'red';
        state.lastRedAt = event.ts;
        state.redStreak += 1;
        state.failureClass = (event as any).class ?? null;
        break;

      case 'LaneBlocked':
        state.currentStatus = 'blocked';
        state.failureClass = (event as any).class ?? null;
        break;

      case 'LaneFinished':
        state.currentStatus = 'green';
        state.finished = true;
        break;
    }
  }
}

/** Shared singleton — imported by AgentService and the API server. */
export const laneEventBus = new LaneEventBus();

/** Helper: create a now-timestamped LaneEvent. */
export function ts(): string {
  return new Date().toISOString();
}
