/**
 * Stage 54 — the owner boundary on teammate reads.
 *
 * This is the only thing between "an agent reads a teammate" and "an agent reads another
 * tenant's data". Production runs 11 agents across 5 accounts, so the distance between
 * those two sentences is one filter. It gets a test rather than a careful reading.
 */
import { describe, it, expect } from 'vitest';
import { resolveSibling } from './self-manage.js';

const scout = { id: 'a1', name: 'Finder', owner_id: 'me' };
const herald = { id: 'a2', name: 'Mailer', owner_id: 'me' };
const scrapy = { id: 'a3', name: 'Crawler', owner_id: 'me' };
const theirs = { id: 'b1', name: 'Recruiter', owner_id: 'someone-else' };
const orphan = { id: 'c1', name: 'Orphan', owner_id: null };
const ALL = [scout, herald, scrapy, theirs, orphan];

describe('resolveSibling — owner boundary', () => {
  it('never returns an agent belonging to another owner, by name', () => {
    const { target } = resolveSibling(scout, 'Recruiter', ALL);
    expect(target).toBeUndefined();
  });

  it('never returns an agent belonging to another owner, by id', () => {
    const { target } = resolveSibling(scout, 'b1', ALL);
    expect(target).toBeUndefined();
  });

  it("does not leak another owner's agents in the visible crew list", () => {
    const { siblings } = resolveSibling(scout, 'Mailer', ALL);
    const names = siblings.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['Mailer', 'Crawler']));
    expect(names).not.toContain('Recruiter');
    expect(names).not.toContain('Orphan');
  });

  it('an unowned agent has no teammates at all', () => {
    // Without an explicit guard, a null owner_id would match every other null and an
    // orphan would read the whole orphan pool.
    const { siblings, target } = resolveSibling(orphan, 'Finder', ALL);
    expect(siblings).toEqual([]);
    expect(target).toBeUndefined();
  });

  it('an agent with a null owner is never returned as a teammate', () => {
    const { target } = resolveSibling(scout, 'Orphan', ALL);
    expect(target).toBeUndefined();
  });
});

describe('resolveSibling — addressing', () => {
  it('resolves a teammate by name', () => {
    expect(resolveSibling(scout, 'Mailer', ALL).target).toEqual(herald);
  });

  it('resolves case-insensitively and ignores surrounding space', () => {
    expect(resolveSibling(scout, '  mAiLeR ', ALL).target).toEqual(herald);
  });

  it('resolves by id', () => {
    expect(resolveSibling(scout, 'a3', ALL).target).toEqual(scrapy);
  });

  it('never resolves an agent to itself', () => {
    expect(resolveSibling(scout, 'Finder', ALL).target).toBeUndefined();
    expect(resolveSibling(scout, 'a1', ALL).target).toBeUndefined();
  });

  it('returns nothing for a name that does not exist', () => {
    expect(resolveSibling(scout, 'Nobody', ALL).target).toBeUndefined();
  });
});
