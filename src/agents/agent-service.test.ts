/**
 * Milestone 1.3 — AgentService
 * Tests the full lifecycle: create → start → pause → stop → delete → runCycle.
 * Uses in-memory DB + temp filesystem. Container execution is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  _initTestDatabase,
  createAgentMessage,
  getAgent,
  getCyclesByAgent,
  getMemoryByAgent,
  getUnreadAgentMessages,
} from '../db.js';
import {
  AgentService,
  CHECKIN_SECTIONS,
  missingCheckinSections,
  type CycleRunner,
} from './agent-service.js';
import type { AgentConfig } from '../types.js';

let tmpDir: string;
let svc: AgentService;

const defaultConfig: AgentConfig = {
  schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: ['apollo'],
  goals: 'Find SaaS leads',
  escalationRules: [],
};

const mockRunner: CycleRunner = {
  run: vi.fn(async () => ({
    summary: 'Found 3 leads',
    cost: 0.05,
    tasksDone: 3,
  })),
};

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-svc-test-'));
  svc = new AgentService(tmpDir, mockRunner);
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── createAgent ─────────────────────────────────────────────────────────────

describe('createAgent', () => {
  it('returns an Agent with id, created_at, and status=idle', async () => {
    const agent = await svc.createAgent({
      name: 'Lead Hunter',
      type: 'lead_hunter',
      emoji: '🔍',
      config: defaultConfig,
    });
    expect(agent.id).toBeTruthy();
    expect(agent.created_at).toBeTruthy();
    expect(agent.status).toBe('idle');
    expect(agent.type).toBe('lead_hunter');
  });

  it('persists the agent in the DB', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    const fetched = getAgent(agent.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('A');
  });

  it('provisions the workspace directory on disk', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    expect(svc.workspaceExists(agent.id)).toBe(true);
  });

  it('writes IDENTITY.md containing CORE section', async () => {
    const agent = await svc.createAgent({
      name: 'LH',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    const identityPath = path.join(tmpDir, agent.id, 'IDENTITY.md');
    const content = fs.readFileSync(identityPath, 'utf-8');
    expect(content).toContain('## CORE');
    expect(content).toContain('## LEARNED');
    expect(content).toContain('Find SaaS leads'); // goals interpolated
  });

  it('writes config.json with the agent config', async () => {
    const agent = await svc.createAgent({
      name: 'LH',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    const configPath = path.join(tmpDir, agent.id, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.goals).toBe('Find SaaS leads');
    expect(config.budget.daily).toBe(5);
  });

  it('archives v1 of IDENTITY.md', async () => {
    const agent = await svc.createAgent({
      name: 'LH',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    const v1Path = path.join(tmpDir, agent.id, 'identity-history', 'v1.md');
    expect(fs.existsSync(v1Path)).toBe(true);
  });

  it('identity_version starts at 1', async () => {
    const agent = await svc.createAgent({
      name: 'LH',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    expect(getAgent(agent.id)!.identity_version).toBe(1);
  });
});

// ─── startAgent / pauseAgent / stopAgent ────────────────────────────────────

describe('startAgent', () => {
  it('changes status from idle to running', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    expect(getAgent(agent.id)!.status).toBe('running');
  });

  it('is idempotent — calling start on a running agent does not error', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    await expect(svc.startAgent(agent.id)).resolves.not.toThrow();
  });

  it('throws for unknown agent id', async () => {
    await expect(svc.startAgent('no-such-id')).rejects.toThrow('not found');
  });
});

describe('pauseAgent', () => {
  it('changes status to paused', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    await svc.pauseAgent(agent.id);
    expect(getAgent(agent.id)!.status).toBe('paused');
  });
});

describe('stopAgent', () => {
  it('changes status to idle and preserves workspace', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    await svc.stopAgent(agent.id);
    expect(getAgent(agent.id)!.status).toBe('idle');
    expect(svc.workspaceExists(agent.id)).toBe(true);
  });
});

// ─── deleteAgent ─────────────────────────────────────────────────────────────

describe('deleteAgent', () => {
  it('removes agent from DB and workspace from disk', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    expect(svc.workspaceExists(agent.id)).toBe(true);
    await svc.deleteAgent(agent.id);
    expect(getAgent(agent.id)).toBeNull();
    expect(svc.workspaceExists(agent.id)).toBe(false);
  });
});

// ─── runCycle ────────────────────────────────────────────────────────────────

describe('runCycle', () => {
  it('creates a completed cycle record and calls the runner', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    const cycle = await svc.runCycle(agent.id, 'lead_search');

    expect(cycle.status).toBe('completed');
    expect(cycle.cycle_type).toBe('lead_search');
    expect(cycle.summary).toBe('Found 3 leads');
    expect(cycle.cost).toBe(0.05);
    expect(cycle.tasks_done).toBe(3);
    expect(mockRunner.run).toHaveBeenCalledOnce();
  });

  it('tells the runner when a person directly asked for the cycle', async () => {
    // The container's what/when gates (rotation, cooldowns, write/contact gates) yield to
    // this; on 2026-09-10 an owner's explicit "call yc_jobs" was refused by rotation.
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    (mockRunner.run as ReturnType<typeof vi.fn>).mockClear();

    await svc.runCycle(
      agent.id,
      'custom',
      'call yc_jobs',
      undefined,
      undefined,
      undefined,
      { humanRequested: true },
    );

    expect(
      (mockRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .humanRequested,
    ).toBe(true);
  });

  it('a scheduled cycle is never marked human — it stays rotated', async () => {
    // The whole value of rotation is on the schedule. If this defaulted to true, every
    // scheduled cycle would skip it and the starvation it exists to prevent comes back.
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    (mockRunner.run as ReturnType<typeof vi.fn>).mockClear();

    await svc.runCycle(agent.id, 'lead_search');

    expect(
      (mockRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .humanRequested,
    ).toBe(false);
  });

  it('cycle is persisted in DB', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    const cycle = await svc.runCycle(agent.id, 'lead_search');
    const fromDb = getCyclesByAgent(agent.id);
    expect(fromDb).toHaveLength(1);
    expect(fromDb[0].id).toBe(cycle.id);
    expect(fromDb[0].status).toBe('completed');
  });

  it('updates last_active after a successful cycle', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    await svc.runCycle(agent.id, 'lead_search');
    expect(getAgent(agent.id)!.last_active).toBeTruthy();
  });

  it('marks cycle as failed and re-throws when runner throws', async () => {
    const failRunner: CycleRunner = {
      run: vi.fn(async () => {
        throw new Error('Apollo API error');
      }),
    };
    const failSvc = new AgentService(tmpDir, failRunner);
    const agent = await failSvc.createAgent({
      name: 'B',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await failSvc.startAgent(agent.id);

    await expect(failSvc.runCycle(agent.id, 'lead_search')).rejects.toThrow(
      'Apollo API error',
    );

    const cycles = getCyclesByAgent(agent.id);
    expect(cycles[0].status).toBe('failed');
    expect(cycles[0].summary).toContain('Apollo API error');
  });

  it('throws for unknown agent id', async () => {
    await expect(svc.runCycle('ghost', 'lead_search')).rejects.toThrow(
      'not found',
    );
  });

  it('enforces daily budget — pauses agent when budget is exhausted', async () => {
    const tightConfig: AgentConfig = {
      ...defaultConfig,
      budget: { daily: 0.04, monthly: 1, onExhaust: 'pause' },
    };
    // mockRunner costs $0.05 per cycle — over the $0.04 daily limit after 1 cycle
    const agent = await svc.createAgent({
      name: 'C',
      type: 'lead_hunter',
      config: tightConfig,
    });
    await svc.startAgent(agent.id);

    // First cycle succeeds
    await svc.runCycle(agent.id, 'lead_search');

    // Second cycle should hit the budget gate (cost is now $0.05 > $0.04 daily)
    await expect(svc.runCycle(agent.id, 'lead_search')).rejects.toThrow(
      /budget exhausted/i,
    );
    expect(getAgent(agent.id)!.status).toBe('paused');
  });
});

// ─── unread inter-agent messages (2026-08-15 inbox-surfacing fix) ─────────────
// Before this, agent_messages had a read_at column nothing ever set from a cycle —
// a message another agent sent sat in workspace/inbox/msg-*.json until the recipient
// happened to browse its own inbox directory, which context-building never does.
// Real incident: Mailer flagged a duplicate-lead bug to Finder this way and it went
// unread the rest of the day.

describe('runCycle — unread agent messages', () => {
  it('surfaces an unread message into the cycle context', async () => {
    const agent = await svc.createAgent({
      name: 'Finder',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    createAgentMessage({
      from_agent_id: 'herald-id',
      to_agent_id: agent.id,
      subject: 'Dedupe: Landeed handoff duplicates an already-sent lead',
      body: 'landeed-customer-relationship-manager-95120 duplicates landeed-crm-95120.',
    });

    await svc.runCycle(agent.id, 'lead_search');

    const ctx = (mockRunner.run as any).mock.calls[0][0]
      .handoffContext as string;
    expect(ctx).toContain('## Messages From Other Agents');
    expect(ctx).toContain(
      'Dedupe: Landeed handoff duplicates an already-sent lead',
    );
    expect(ctx).toContain(
      'landeed-customer-relationship-manager-95120 duplicates landeed-crm-95120.',
    );
  });

  it('marks the message read after the cycle completes, so it is not surfaced again', async () => {
    const agent = await svc.createAgent({
      name: 'Finder',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    createAgentMessage({
      from_agent_id: 'herald-id',
      to_agent_id: agent.id,
      subject: 'Note',
      body: 'body',
    });
    expect(getUnreadAgentMessages(agent.id)).toHaveLength(1);

    await svc.runCycle(agent.id, 'lead_search');
    expect(getUnreadAgentMessages(agent.id)).toHaveLength(0);

    await svc.runCycle(agent.id, 'lead_search');
    const ctx = (mockRunner.run as any).mock.calls[1][0].handoffContext as
      | string
      | undefined;
    expect(ctx ?? '').not.toContain('Messages From Other Agents');
  });

  it('does not add a Messages section when the inbox is empty', async () => {
    const agent = await svc.createAgent({
      name: 'Finder',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);

    await svc.runCycle(agent.id, 'lead_search');

    const ctx = (mockRunner.run as any).mock.calls[0][0].handoffContext as
      | string
      | undefined;
    expect(ctx ?? '').not.toContain('Messages From Other Agents');
  });
});

// ─── getAgent / getAllAgents ──────────────────────────────────────────────────

describe('getAgent / getAllAgents', () => {
  it('getAgent returns null for unknown id', () => {
    expect(svc.getAgent('nope')).toBeNull();
  });

  it('getAllAgents returns all created agents', async () => {
    await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.createAgent({
      name: 'B',
      type: 'outreach',
      config: defaultConfig,
    });
    expect(svc.getAllAgents()).toHaveLength(2);
  });
});

// ─── check-in report validation ──────────────────────────────────────────────

/**
 * These guard a bug that made the weekly check-in fail 100% of the time in prod:
 * the report is generated by deepseek-v4-flash, whose reasoning pass consumed the
 * entire 1200-token output budget and returned an empty string. Empty output does not
 * throw, so the old try/catch never fired; the caller then threw on the missing
 * headings and the whole cycle failed, discarding the report.
 */
describe('missingCheckinSections', () => {
  const goodReport = `# Weekly Check-in: Finder
Period: Aug 1 – Aug 7, 2026

## What I Did
- Ran 12 lead searches

## Wins
- 3 qualified leads

## Observations
- Job postings outperform X

## What's Next
- Expand job-board coverage

## Questions for You
**Q: Should I drop the X source?**
Options: [Yes, drop it] | [Keep both] | [Let's discuss]
`;

  it('accepts a well-formed report', () => {
    expect(missingCheckinSections(goodReport)).toEqual([]);
  });

  it('treats empty output as missing every section', () => {
    // The actual prod failure: reasoning_tokens == max_tokens, content === ''.
    expect(missingCheckinSections('')).toEqual([...CHECKIN_SECTIONS]);
  });

  it('treats an error string as missing every section', () => {
    expect(
      missingCheckinSections(
        'Error calling LLM: litellm.ServiceUnavailableError: too busy',
      ),
    ).toEqual([...CHECKIN_SECTIONS]);
  });

  it('names only the sections actually absent', () => {
    const partial = `# Weekly Check-in: Finder

## What I Did
- Some work

## Wins
- A win
`;
    expect(missingCheckinSections(partial)).toEqual([
      '## Observations',
      "## What's Next",
      '## Questions for You',
    ]);
  });

  it("matches What's Next with a straight apostrophe only", () => {
    // A curly apostrophe is a real risk from LLM output — assert the behaviour is
    // known rather than accidental, so a future prompt change has a failing signal.
    const curly = goodReport.replace("## What's Next", '## What\u2019s Next');
    expect(missingCheckinSections(curly)).toEqual(["## What's Next"]);
  });
});

// ─── self_improve → skill curation (stage 42 #4, judgment half) ──────────────
//
// self_improve normally never reaches a container: it distils, decays, evolves and
// returns. That is why `curate_skills` was registered on every loop and triggered by
// nothing. It now falls through to the container path — but only when the sweep left
// something on the warning shelf, so an agent with nothing to curate still pays
// $0.002 and spawns nothing.

describe('runCycle — self_improve skill curation', () => {
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString();

  function seedSkill(
    agentId: string,
    name: string,
    entry: Record<string, unknown>,
  ) {
    const skills = path.join(tmpDir, agentId, 'skills');
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `# ${name}\n\nbody`);
    const file = path.join(skills, '.origins.json');
    const data = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf-8'))
      : { version: 1, skills: {} };
    data.skills[name] = entry;
    fs.writeFileSync(file, JSON.stringify(data));
  }

  const agentWrote = (idleDays: number) => ({
    origin: 'background_review',
    created_at: daysAgo(idleDays + 5),
    last_used_at: daysAgo(idleDays),
    usage_count: 2,
  });

  async function newAgent() {
    return svc.createAgent({
      name: 'Curator Test',
      type: 'lead_hunter',
      config: defaultConfig,
    });
  }

  it('does not spawn a container when there is nothing to curate', async () => {
    const agent = await newAgent();
    seedSkill(agent.id, 'fresh', agentWrote(1));

    const cycle = await svc.runCycle(agent.id, 'self_improve');

    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(cycle.status).toBe('completed');
    expect(cycle.cost).toBe(0.002);
  });

  it('spawns a container leg when an agent-written skill has gone stale', async () => {
    const agent = await newAgent();
    seedSkill(agent.id, 'drifting-technique', agentWrote(45));

    await svc.runCycle(agent.id, 'self_improve');

    expect(mockRunner.run).toHaveBeenCalledTimes(1);
    const ctx = (mockRunner.run as any).mock.calls[0][0]
      .handoffContext as string;
    expect(ctx).toContain('drifting-technique');
    expect(ctx).toContain('curate_skills');
  });

  it('reuses the same cycle record rather than opening a second one', async () => {
    const agent = await newAgent();
    seedSkill(agent.id, 'drifting-technique', agentWrote(45));

    await svc.runCycle(agent.id, 'self_improve');

    const cycles = getCyclesByAgent(agent.id, 10);
    expect(cycles.filter((c) => c.cycle_type === 'self_improve')).toHaveLength(
      1,
    );
  });

  it('leaves a user-written stale skill alone and spawns nothing', async () => {
    const agent = await newAgent();
    seedSkill(agent.id, 'user-rule', {
      origin: 'user',
      last_used_at: daysAgo(400),
    });

    const cycle = await svc.runCycle(agent.id, 'self_improve');

    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(cycle.cost).toBe(0.002);
    expect(
      fs.existsSync(
        path.join(tmpDir, agent.id, 'skills', 'user-rule', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('archives a 90-day skill and does not escalate for it', async () => {
    // Archiving is the deterministic half's job; there is nothing left to judge.
    const agent = await newAgent();
    seedSkill(agent.id, 'ancient', agentWrote(120));

    const cycle = await svc.runCycle(agent.id, 'self_improve');

    expect(
      fs.existsSync(
        path.join(tmpDir, agent.id, 'skills', '.archive', 'ancient'),
      ),
    ).toBe(true);
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(cycle.summary).toContain('Retired 1 unused skill');
  });

  it('an agent with no skills at all behaves exactly as before', async () => {
    const agent = await newAgent();

    const cycle = await svc.runCycle(agent.id, 'self_improve');

    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(cycle.status).toBe('completed');
    expect(cycle.summary).not.toContain('Retired');
  });
});
