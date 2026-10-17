/**
 * Stage 54 phase 1 — regression test for the 2026-08-28 identity loss.
 *
 * On 2026-08-28 07:24 a self_improve cycle rewrote Crawler's IDENTITY.md as an empty
 * `## CORE` plus its learned bullets, discarding six sections of a hand-written system
 * prompt — which sources to sweep, which one was banned, the daily target, the handoff
 * shape. The agent ran eleven more days on nothing but the bullets. Nothing detected it;
 * it was found by reading an archived file by hand.
 *
 * Two separate failures made that possible, and this file pins both:
 *
 *   1. the parse only kept text under a literal `## CORE`, so a prompt organised under any
 *      other headings was silently dropped        → `readCurrentIdentity` / `writeUpdatedIdentity`
 *   2. nothing recorded the change, so a total prompt loss looked exactly like a normal
 *      evolution                                   → `agent_config_audit`
 *
 * The fixture is the real archived v2.md — the last good version before the loss.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  _initTestDatabase,
  recordConfigAudit,
  getConfigAudit,
  insertAgent,
} from '../db.js';
import { IdentityEvolutionEngine } from './identity-evolution.js';
import type { AgentConfig } from '../types.js';

/** The shape of the real prompt: six sections, none of them called CORE. */
const REAL_PROMPT = `# Crawler — System Prompt (updated 2026-08-17, terminology corrected)

## Identity

You are **Crawler**, a high-volume LEAD FINDER — not a qualifier.

## Daily volume goal

**200 leads/day**, handed to Finder across your source rotation.

## Sources

You now have four: **RemoteOK**, **linkedin_jobs**, **yc_jobs**, **reddit_search**.

**Dead, do not retry:** Google Jobs direct scraping and Serper.dev.

## Workflow

1. Pick this cycle's source in rotation.
2. Dedupe against what has already been handed off.

## Compliance Guardrails (still non-negotiable)

- NO CAPTCHA solving, NO fingerprint spoofing.

## WORKSPACE

- \`workspace/scrapybaby/\`

## LEARNED
- an old bullet
`;

const LOST_HEADINGS = [
  '## Identity',
  '## Daily volume goal',
  '## Sources',
  '## Workflow',
  '## Compliance Guardrails (still non-negotiable)',
  '## WORKSPACE',
];

let tmpDir: string;
let engine: IdentityEvolutionEngine;
const AGENT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

function writeIdentity(content: string): void {
  fs.mkdirSync(path.join(tmpDir, AGENT_ID), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, AGENT_ID, 'IDENTITY.md'),
    content,
    'utf-8',
  );
}
function readIdentity(): string {
  return fs.readFileSync(path.join(tmpDir, AGENT_ID, 'IDENTITY.md'), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-regression-'));
  engine = new IdentityEvolutionEngine(tmpDir);
  _initTestDatabase();

  // agent_config_audit has a foreign key to agents, so the row has to exist.
  insertAgent({
    id: AGENT_ID,
    name: 'Crawler',
    type: 'custom',
    status: 'idle',
    workspace: tmpDir,
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools: [],
      goals: 'find leads',
      escalationRules: [],
    } as AgentConfig,
    identity_version: 2,
    created_at: new Date().toISOString(),
  });
});

describe('2026-08-28 identity loss — the parse', () => {
  it('keeps every section of a prompt that has no ## CORE heading', () => {
    writeIdentity(REAL_PROMPT);

    const parsed = engine.readCurrentIdentity(AGENT_ID);
    engine.writeUpdatedIdentity(AGENT_ID, parsed, '- a freshly learned bullet');
    const after = readIdentity();

    for (const heading of LOST_HEADINGS) {
      expect(after, `"${heading}" must survive an evolution`).toContain(
        heading,
      );
    }
  });

  it('still applies the new bullets, and replaces rather than appends the old ones', () => {
    writeIdentity(REAL_PROMPT);

    const parsed = engine.readCurrentIdentity(AGENT_ID);
    engine.writeUpdatedIdentity(AGENT_ID, parsed, '- a freshly learned bullet');
    const after = readIdentity();

    expect(after).toContain('- a freshly learned bullet');
    expect(after).not.toContain('- an old bullet');
  });

  it('round-trips a template identity unchanged — its body simply IS ## CORE', () => {
    writeIdentity(
      '# Agent\n\n## CORE\n**Role:** Custom Agent\n\n## LEARNED\n- old\n',
    );

    const parsed = engine.readCurrentIdentity(AGENT_ID);
    engine.writeUpdatedIdentity(AGENT_ID, parsed, '- new');
    const after = readIdentity();

    expect(after).toContain('## CORE');
    expect(after).toContain('**Role:** Custom Agent');
    expect(after).toContain('- new');
  });

  it('does not lose a prompt that uses no ## headings at all', () => {
    // Recruiter's shape: a plain numbered list. Under the old parse this produced an
    // empty core exactly like Crawler's, so it was one evolution from the same loss.
    writeIdentity(
      '# Recruiter\n\nYou are the Recruiter.\n\n1. INTERVIEW first.\n2. Bias toward FOCUSED agents.\n\n## LEARNED\n- old\n',
    );

    const parsed = engine.readCurrentIdentity(AGENT_ID);
    engine.writeUpdatedIdentity(AGENT_ID, parsed, '- new');
    const after = readIdentity();

    expect(after).toContain('You are the Recruiter.');
    expect(after).toContain('1. INTERVIEW first.');
    expect(after).toContain('2. Bias toward FOCUSED agents.');
  });
});

describe('2026-08-28 identity loss — the audit trail', () => {
  it('a total prompt loss is visible in the recorded diff', () => {
    // Replay the loss exactly as it happened: 4.8 KB of sections in, an empty CORE out.
    const destroyed =
      '# Crawler — System Prompt (updated 2026-08-17, terminology corrected)\n\n## CORE\n\n\n## LEARNED\n- a bullet\n';

    recordConfigAudit({
      agentId: AGENT_ID,
      capability: 'identity',
      actor: 'system',
      before: { version: 2, bytes: REAL_PROMPT.length, identity: REAL_PROMPT },
      after: { version: 3, bytes: destroyed.length, identity: destroyed },
      reason: 'self_improve evolution to v3',
    });

    const [entry] = getConfigAudit(AGENT_ID, 10);
    expect(entry).toBeDefined();
    expect(entry.capability).toBe('identity');

    const before = JSON.parse(entry.before_json);
    const after = JSON.parse(entry.after_json);

    // The headline signal, and the one a human would spot in a list without opening
    // anything: the prompt got dramatically smaller.
    expect(after.bytes).toBeLessThan(before.bytes / 2);

    // And the specific sections that went are recoverable from the row itself — which is
    // what turns "something changed" into "here is exactly what to put back".
    for (const heading of LOST_HEADINGS) {
      expect(before.identity).toContain(heading);
      expect(after.identity).not.toContain(heading);
    }
  });

  it('records nothing when an evolution changes nothing', () => {
    const same = { version: 3, bytes: 10, identity: 'unchanged' };
    const id = recordConfigAudit({
      agentId: AGENT_ID,
      capability: 'identity',
      actor: 'system',
      before: same,
      after: same,
    });
    expect(id).toBeNull();
    expect(getConfigAudit(AGENT_ID, 10)).toHaveLength(0);
  });
});
