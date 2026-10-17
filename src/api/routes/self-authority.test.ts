/**
 * What an agent may change about itself.
 *
 * Every agent may change everything on the self-management router: per-agent grants and
 * the "always ask first" list were removed on 2026-09-14 at the owner's request, after
 * they turned out to still be in force long after the owner believed they were gone.
 * These pin that they stay gone, and pin the short list of changes that still wait for
 * the owner — each for a reason of its own, none of them a grant.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'src/api/routes/self-manage.ts'),
  'utf-8',
);

describe('no per-agent self-change restrictions', () => {
  it('no route checks a grant', () => {
    expect(routeSource).not.toMatch(
      /denyWithoutGrant|grantsFor\(|needsApproval\(/,
    );
  });

  it('an identity edit is held only when it would delete a large share of the text', () => {
    // The 2026-08-28 loss: a 4.8 KB system prompt replaced with an empty section. That
    // data-loss guard stays; "every identity edit needs approval" does not. Since
    // 2026-09-24 the owner can waive it with an explicit approval rule, and only that.
    expect(routeSource).toMatch(
      /if \(shrinkPct > 0\.3 && !ruleAllows\(agent, 'identity_rewrite'\)\) \{/,
    );
  });

  it('the changes that still wait for the owner are the fixed, named few', () => {
    // budget ×2 (over ceiling), identity (>30% shrink), tracker (stage still holds rows),
    // tools (outbound), credentials. A new deferral here is a new restriction — decide it.
    //
    // 2026-09-23: sources and settings were added when those became self-manageable at all
    // (before, the agent could not reach them). Each holds one direction only — switching a
    // sweep gate OFF, and switching ON the owner's browser or an outbound webhook — the same
    // "reaches outside / removes a floor" line the 09-14 removal kept.
    const deferrals =
      routeSource.match(
        /deferToApproval\(\s*(agent\.id|agentId),\s*'(\w+)'/g,
      ) ?? [];
    const kinds = deferrals.map((d) => d.match(/'(\w+)'$/)![1]).sort();
    // 2026-09-24: approvals — loosening an approval rule from a run the owner did not start.
    expect(kinds).toEqual([
      'approvals',
      'budget',
      'budget',
      'credentials',
      'identity',
      'settings',
      'tools',
      'tracker',
    ]);
  });
});

// The two schedule bugs from 01-current-state.md, as pure functions matching the route.
type Entry = { type: string; interval: string; enabled: boolean };

function applyOp(
  current: Entry[],
  incoming: Entry[],
  op: 'set' | 'add' | 'remove',
): Entry[] {
  if (op === 'add') {
    const byType = new Map(current.map((e) => [e.type, e]));
    for (const e of incoming) byType.set(e.type, e);
    return [...byType.values()];
  }
  if (op === 'remove') {
    const drop = new Set(incoming.map((e) => e.type));
    return current.filter((e) => !drop.has(e.type));
  }
  return incoming;
}

describe('schedule operations', () => {
  const current: Entry[] = [
    { type: 'lead_search', interval: '45 */2 * * *', enabled: true },
    { type: 'self_improve', interval: '7d', enabled: true },
    { type: 'checkin', interval: '7d', enabled: true },
  ];

  it('add keeps everything else — the bug that made "add a check-in" a silent delete', () => {
    const out = applyOp(
      current,
      [{ type: 'followup', interval: '1d', enabled: true }],
      'add',
    );
    expect(out.map((e) => e.type).sort()).toEqual([
      'checkin',
      'followup',
      'lead_search',
      'self_improve',
    ]);
  });

  it('add replaces an entry of the same type rather than duplicating it', () => {
    const out = applyOp(
      current,
      [{ type: 'lead_search', interval: '0 6 * * *', enabled: true }],
      'add',
    );
    expect(out).toHaveLength(3);
    expect(out.find((e) => e.type === 'lead_search')!.interval).toBe(
      '0 6 * * *',
    );
  });

  it('remove drops by type and leaves the rest', () => {
    const out = applyOp(
      current,
      [{ type: 'checkin', interval: 'ignored', enabled: true }],
      'remove',
    );
    expect(out.map((e) => e.type)).toEqual(['lead_search', 'self_improve']);
  });

  it('set still replaces everything — destructive, but now it has to be asked for', () => {
    const out = applyOp(
      current,
      [{ type: 'checkin', interval: '7d', enabled: true }],
      'set',
    );
    expect(out.map((e) => e.type)).toEqual(['checkin']);
  });
});

describe('switching away from a scheduled trigger mode', () => {
  // Was `patch.schedule = []`, which discarded hand-written cron strings and made
  // "make yourself on-demand" an unrecoverable edit.
  const disable = (entries: Entry[]): Entry[] =>
    entries.map((e) => ({ ...e, enabled: false }));

  it('keeps the entries and disables them', () => {
    const out = disable([
      { type: 'lead_search', interval: '45 */2 * * *', enabled: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].interval).toBe('45 */2 * * *');
    expect(out[0].enabled).toBe(false);
  });

  it('is reversible — the cron string survives the round trip', () => {
    const original: Entry[] = [
      { type: 'lead_search', interval: '45 */2 * * *', enabled: true },
    ];
    const off = disable(original);
    const backOn = off.map((e) => ({ ...e, enabled: true }));
    expect(backOn).toEqual(original);
  });
});
