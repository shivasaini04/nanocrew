/**
 * Stage 57 phase 5 — a message sent while its agent is busy waits its turn; it is never dropped.
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase } from '../db.js';
import { AgentService, type CycleRunner } from './agent-service.js';
import { ChatQueue } from './chat-queue.js';

vi.mock('../notifications.js', async (orig) => ({
  ...(await orig<any>()),
  notify: vi.fn(),
}));

let busy: Set<string>;
let started: string[];
let q: ChatQueue;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A turn that occupies the agent until the test ends it. */
function turn(agentId: string, label: string, opts: { refuse?: boolean } = {}) {
  return {
    agentId,
    label,
    start: async () => {
      if (opts.refuse || busy.has(agentId))
        throw new Error(`Agent ${agentId} is already running a cycle`);
      busy.add(agentId);
      started.push(label);
    },
  };
}
const finish = (agentId: string) => {
  busy.delete(agentId);
  q.onFree(agentId);
};

beforeEach(() => {
  busy = new Set();
  started = [];
  q = new ChatQueue((id) => busy.has(id));
});

describe('chat queue', () => {
  it('holds a message while the agent is busy and starts it when the agent frees', async () => {
    busy.add('a');
    expect(q.mustWait('a')).toBe(true);
    expect(q.enqueue(turn('a', 'second'))).toEqual({ ok: true, position: 1 });
    await flush();
    expect(started).toEqual([]);
    finish('a');
    await flush();
    expect(started).toEqual(['second']);
  });

  it('keeps order: one turn per free slot, first in first out', async () => {
    busy.add('a');
    q.enqueue(turn('a', 'one'));
    expect(q.enqueue(turn('a', 'two')).ok && q.size('a')).toBe(2);
    finish('a');
    await flush();
    expect(started).toEqual(['one']);
    finish('a');
    await flush();
    expect(started).toEqual(['one', 'two']);
    expect(q.size('a')).toBe(0);
  });

  it('a new message waits behind queued ones even if the agent looks free', () => {
    busy.add('a');
    q.enqueue(turn('a', 'one'));
    busy.delete('a'); // freed, but "one" has not started yet
    expect(q.mustWait('a')).toBe(true);
  });

  it('when something else takes the slot first, the turn goes back to the front', async () => {
    busy.add('a');
    q.enqueue({
      ...turn('a', 'mine'),
      start: async () => {
        throw new Error('Agent a is already running a cycle');
      },
    });
    q.enqueue(turn('a', 'later'));
    finish('a');
    await flush();
    expect(q.size('a')).toBe(2); // refused, and still first in line
  });

  it('starts at once if the agent freed between the check and the enqueue', async () => {
    q.enqueue(turn('a', 'late'));
    await flush();
    expect(started).toEqual(['late']);
  });

  it('is bounded, and says so instead of dropping silently', () => {
    busy.add('a');
    for (let i = 0; i < 5; i++)
      expect(q.enqueue(turn('a', `m${i}`)).ok).toBe(true);
    const r = q.enqueue(turn('a', 'm5'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/5 requests are already waiting/);
  });

  it('with a real AgentService: the second message runs when the first turn ends, not before', async () => {
    _initTestDatabase();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-chatq-'));
    const releases: Array<() => void> = [];
    const prompts: string[] = [];
    const runner: CycleRunner = {
      run: vi.fn(async (p: { handoffContext?: string }) => {
        prompts.push(String(p.handoffContext ?? ''));
        await new Promise<void>((r) => releases.push(r));
        return { summary: 'ok', cost: 0, tasksDone: 1 };
      }) as never,
    };
    const svc = new AgentService(dir, runner);
    const queue = new ChatQueue((id) => svc.isExecutingCycle(id));
    svc.onCycleSlotFreed((id) => queue.onFree(id));
    const agent = await svc.createAgent({
      name: 'Q',
      type: 'lead_hunter',
      config: {
        schedule: [],
        budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
        tools: [],
        goals: 'g',
        escalationRules: [],
      } as never,
    });

    const first = svc.runCycle(agent.id, 'custom', 'first message');
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(queue.mustWait(agent.id)).toBe(true);
    expect(
      queue.enqueue({
        agentId: agent.id,
        label: 'second',
        start: () => svc.runCycle(agent.id, 'custom', 'second message'),
      }).ok,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts).toHaveLength(1); // still waiting

    releases[0]();
    await first;
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain('second message');
    releases[1]();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('agents do not wait on each other', async () => {
    busy.add('a');
    q.enqueue(turn('a', 'for-a'));
    expect(q.mustWait('b')).toBe(false);
    finish('b');
    await flush();
    expect(started).toEqual([]);
  });
});
