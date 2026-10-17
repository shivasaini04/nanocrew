/**
 * Memory decay must not be able to stop an agent from working.
 *
 * Found in prod 2026-09-02, in the orchestrator log:
 *
 *   SqliteError: FOREIGN KEY constraint failed   (db.js:2788)
 *   msg: "[scheduler] runCycle threw — cycle did not run"
 *
 * `agent_memory.supersedes_id` is a self-referential FK declared ON DELETE NO ACTION.
 * When a memory that some newer memory had superseded decayed below the prune floor,
 * the DELETE violated it, the whole single-transaction pass aborted, and the
 * self_improve cycle's catch marked the cycle failed and rethrew. Forgetting an old
 * fact cancelled everything else the agent was going to do that cycle.
 *
 * The shape is one this repo has been bitten by before — an agent silently not running.
 * See the memory note `reference_silent_paywall_stopped_scheduler`: zero cycles for 35
 * hours.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createAgent,
  createAgentMemory,
  getMemoryByAgent,
  decayAndPruneMemories,
  _testBackdateMemory,
} from '../db.js';

let AGENT = '';

/** Faded enough that one decay pass takes it below the prune floor. */
function ancient(content: string, supersedes?: string) {
  return createAgentMemory({
    agent_id: AGENT,
    type: 'fact',
    content,
    relevance: 0.01,
    used_count: 0,
    supersedes_id: supersedes,
  } as never);
}

beforeEach(() => {
  _initTestDatabase();
  AGENT = createAgent({
    name: 'Pruner',
    type: 'worker',
    emoji: '\u{1F9F9}',
    status: 'idle',
    workspace: '/data/agents/prune-fk',
    config: {
      schedule: [],
      budget: { daily: 1, monthly: 10, onExhaust: 'pause' },
      tools: [],
      goals: 'test',
      escalationRules: [],
    },
    identity_version: 1,
  } as never).id;
});

describe('decayAndPruneMemories', () => {
  it('prunes a superseded memory instead of throwing FOREIGN KEY constraint failed', () => {
    // The exact prod shape: B says it supersedes A, and A is the one that fades.
    const a = ancient('the old fact');
    ancient('the new fact', a.id);

    // Backdate A past the prune age. Done through the same DB the function uses,
    // because the age gate is what turns a decay into a delete.
    _testBackdateMemory(a.id, 400);

    expect(() => decayAndPruneMemories(AGENT)).not.toThrow();

    const left = getMemoryByAgent(AGENT);
    // A is gone...
    expect(left.find((m) => m.id === a.id)).toBeUndefined();
    // ...and B survived, with its now-meaningless pointer cleared rather than the
    // row deleted with it. Losing the newer fact to prune the older one would be a
    // worse bug than the crash.
    const b = left.find((m) => m.content === 'the new fact');
    expect(b).toBeDefined();
    expect(b?.supersedes_id ?? null).toBeNull();
  });

  it('handles a whole chain fading at once', () => {
    // A <- B <- C, all faded and old. Every DELETE in the pass has a pointer at it.
    const a = ancient('oldest');
    const b = ancient('middle', a.id);
    ancient('newest', b.id);

    _testBackdateMemory(a.id, 400);
    _testBackdateMemory(b.id, 400);

    expect(() => decayAndPruneMemories(AGENT)).not.toThrow();
    const left = getMemoryByAgent(AGENT);
    expect(left.find((m) => m.content === 'oldest')).toBeUndefined();
    expect(left.find((m) => m.content === 'middle')).toBeUndefined();
    expect(left.find((m) => m.content === 'newest')).toBeDefined();
  });

  it('still decays what it does not prune', () => {
    // The feature has to keep working, not just stop crashing.
    const fresh = createAgentMemory({
      agent_id: AGENT,
      type: 'fact',
      content: 'recent',
      relevance: 1,
      used_count: 0,
    } as never);

    const res = decayAndPruneMemories(AGENT);
    expect(res.decayed).toBeGreaterThan(0);

    const after = getMemoryByAgent(AGENT).find((m) => m.id === fresh.id);
    expect(after!.relevance).toBeLessThan(1);
  });

  it('never touches user_profile facts', () => {
    const profile = createAgentMemory({
      agent_id: AGENT,
      type: 'user_profile',
      content: 'the manager prefers X',
      relevance: 0.01,
      used_count: 0,
    } as never);
    _testBackdateMemory(profile.id, 400);

    decayAndPruneMemories(AGENT);
    const after = getMemoryByAgent(AGENT).find((m) => m.id === profile.id);
    expect(after).toBeDefined();
    expect(after!.relevance).toBe(0.01); // not even decayed
  });
});
