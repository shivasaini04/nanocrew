/**
 * Stage 60 phase 6 — work waiting for the user's computer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FOLLOWUP_TTL_MS,
  LocalFollowupQueue,
  followupPrompt,
} from './local-followups.js';

let dir: string;
let q: LocalFollowupQueue;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-followups-'));
  q = new LocalFollowupQueue(path.join(dir, 'q.json'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('LocalFollowupQueue', () => {
  it('survives a restart — a new queue over the same file sees the item', () => {
    q.add({
      agentId: 'a1',
      principal: 'p1',
      task: 'send the notes',
      source: 'agent',
    });
    const again = new LocalFollowupQueue(path.join(dir, 'q.json'));
    expect(again.listFor('a1').map((f) => f.task)).toEqual(['send the notes']);
  });

  it('hands everything for one owner over exactly once, oldest first, and nothing of anyone else', () => {
    q.add(
      { agentId: 'a1', principal: 'p1', task: 'first', source: 'agent' },
      1000,
    );
    q.add(
      { agentId: 'a2', principal: 'p1', task: 'second', source: 'agent' },
      2000,
    );
    q.add(
      { agentId: 'b1', principal: 'p2', task: 'other owner', source: 'agent' },
      1500,
    );
    const now = 3000;
    expect(q.takeFor('p1', now).map((f) => f.task)).toEqual([
      'first',
      'second',
    ]);
    expect(q.takeFor('p1', now)).toEqual([]);
    expect(q.takeFor('p2', now).map((f) => f.task)).toEqual(['other owner']);
  });

  it('a new chat request replaces the earlier one for that agent; agent hand-offs accumulate', () => {
    q.add({
      agentId: 'a1',
      principal: 'p1',
      task: 'old message',
      source: 'chat',
    });
    q.add({
      agentId: 'a1',
      principal: 'p1',
      task: 'new message',
      source: 'chat',
    });
    q.add({
      agentId: 'a1',
      principal: 'p1',
      task: 'handoff 1',
      source: 'agent',
    });
    q.add({
      agentId: 'a1',
      principal: 'p1',
      task: 'handoff 2',
      source: 'agent',
    });
    expect(
      q
        .listFor('a1')
        .map((f) => f.task)
        .sort(),
    ).toEqual(['handoff 1', 'handoff 2', 'new message']);
  });

  it('drops items older than a day instead of running them late', () => {
    q.add(
      { agentId: 'a1', principal: 'p1', task: 'stale', source: 'agent' },
      0,
    );
    expect(q.takeFor('p1', FOLLOWUP_TTL_MS + 1)).toEqual([]);
  });

  it('caps a runaway agent at ten, dropping the oldest', () => {
    for (let i = 0; i < 12; i++)
      q.add(
        { agentId: 'a1', principal: 'p1', task: `t${i}`, source: 'agent' },
        1000 + i,
      );
    const tasks = q.listFor('a1', 2000).map((f) => f.task);
    expect(tasks).toHaveLength(10);
    expect(tasks).not.toContain('t0');
    expect(tasks).toContain('t11');
  });

  it('the resumed prompt says it waited and carries the task', () => {
    const f = q.add({
      agentId: 'a1',
      principal: 'p1',
      task: 'save leads.xlsx to Documents',
      source: 'chat',
      reason: 'laptop shut',
    });
    const p = followupPrompt(f);
    expect(p).toMatch(/connected now/);
    expect(p).toContain('save leads.xlsx to Documents');
    expect(p).toContain('laptop shut');
  });
});
