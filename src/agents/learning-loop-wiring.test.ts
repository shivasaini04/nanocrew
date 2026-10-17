/**
 * Wiring guards for the stage 42 learning loop.
 *
 * These do not test behaviour — every mechanism already has a behavioural suite,
 * and all of them were green on 2026-08-23 while three of the mechanisms were
 * reachable by nothing in production. That is the failure these guard against:
 * not "does the unit work" but "is anything still calling it".
 *
 * `scripts/verify-learning-loop.sh` is the real answer, but it needs a built agent
 * image and a running orchestrator, so it cannot run in CI. These are the cheap
 * half — they read the source and assert the specific seams that silently broke,
 * and they run on every push.
 *
 * A test here failing means the loop has been disconnected, not that a refactor is
 * wrong. Fix the wiring or, if the seam genuinely moved, update the assertion and
 * say where it moved to.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const AGENT_PY = path.join(REPO, 'container/nanoagent/nanoagent/agent');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf-8');

// ─── seam 1: the review fork is awaited before its process exits ─────────────
//
// spawn() is fire-and-forget. A cycle ends at asyncio.run(), which cancels every
// pending task, so without an explicit drain the review is killed partway through
// its rounds and writes nothing — silently, since CancelledError is a
// BaseException and slips past the `except Exception` that guards the fork.

describe('background review is drained before the process exits', () => {
  const adapter = read('container/nanoagent/bridge/nanocrew_adapter.py');

  it('the adapter awaits the reviewer', () => {
    expect(adapter).toMatch(/await\s+reviewer\.drain\(/);
  });

  it('it drains before emitting the final result, not after', () => {
    // Everything after print_success is racing the orchestrator's read of the
    // output markers.
    const drain = adapter.indexOf('reviewer.drain(');
    const emit = adapter.indexOf('print_success(');
    expect(drain).toBeGreaterThan(-1);
    expect(emit).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(emit);
  });

  it('the drain is bounded, so a hung review cannot hold a container open', () => {
    const review = fs.readFileSync(
      path.join(AGENT_PY, 'background_review.py'),
      'utf-8',
    );
    expect(review).toMatch(/async def drain/);
    expect(review).toMatch(/asyncio\.wait\(/);
    expect(review).toMatch(/timeout=/);
  });

  it('the drain cancels what it could not wait for', () => {
    const review = fs.readFileSync(
      path.join(AGENT_PY, 'background_review.py'),
      'utf-8',
    );
    const body = review.slice(review.indexOf('async def drain'));
    expect(body).toMatch(/\.cancel\(\)/);
  });

  it('the loop still spawns the review at the end of a turn', () => {
    // The other half of the pair: a drain with nothing to drain is just as dead.
    expect(read('container/nanoagent/nanoagent/agent/loop.py')).toMatch(
      /_reviewer\.spawn\(/,
    );
  });
});

// ─── seam 2: the curator has a trigger that reaches it ───────────────────────
//
// curator.sweep() was reachable only from the curate_skills tool, whose documented
// trigger was a self_improve cycle — which returns without ever reaching a
// container. Registered, imported, and called by nothing.

describe('the curator is reachable from a cycle', () => {
  const service = read('src/agents/agent-service.ts');

  it('the deterministic sweep runs on the orchestrator-side self_improve path', () => {
    expect(service).toMatch(/sweepQuietly\(/);
    // Must be inside the self_improve branch, not somewhere unreachable.
    const branch = service.indexOf("if (cycleType === 'self_improve')");
    expect(branch).toBeGreaterThan(-1);
    expect(service.indexOf('sweepQuietly(')).toBeGreaterThan(branch);
  });

  it('a stale skill escalates to the container leg', () => {
    expect(service).toMatch(/skillSweep\?\.stale\.length/);
    expect(service).toMatch(/curationContext\s*=/);
  });

  it('the curation prompt actually reaches the container', () => {
    // Being assigned is not the same as being sent. It has to be in the array
    // that becomes handoffContext.
    const combined = service.match(/const combinedContext\s*=\s*\[([^\]]*)\]/);
    expect(combined, 'combinedContext array not found').not.toBeNull();
    expect(combined![1]).toContain('curationContext');
  });

  it('the prompt names the tool the agent has to call', () => {
    expect(service).toMatch(/curate_skills/);
  });

  it('curate_skills is still registered on the agent loop', () => {
    expect(read('container/nanoagent/nanoagent/agent/loop.py')).toMatch(
      /register\(CurateSkillsTool\(/,
    );
  });
});

// ─── seam 3: writes are attributed, or the curator must not act ──────────────

describe('provenance stays wired to the write path', () => {
  it('save_skill records origin and ledgers the write', () => {
    const save = read(
      'container/nanoagent/nanoagent/agent/tools/save_skill.py',
    );
    expect(save).toMatch(/skill_origins\.record_write\(/);
    expect(save).toMatch(/skill_ledger\.record\(/);
  });

  it('the review fork writes under the background_review origin', () => {
    const review = fs.readFileSync(
      path.join(AGENT_PY, 'background_review.py'),
      'utf-8',
    );
    expect(review).toMatch(/ToolRegistry\(write_origin=BACKGROUND_REVIEW\)/);
  });

  it('use is still counted where a skill reaches the model', () => {
    expect(read('container/nanoagent/nanoagent/agent/skills.py')).toMatch(
      /skill_origins\.record_use\(/,
    );
  });

  it('only background_review counts as agent-created', () => {
    // Widening this would let the curator retire skills the user wrote.
    expect(read('container/nanoagent/nanoagent/agent/tool_origin.py')).toMatch(
      /return origin == BACKGROUND_REVIEW/,
    );
  });
});

// ─── seam 4: the dashboard reads the same files the agent writes ─────────────

describe('the API reads where the agent actually writes', () => {
  const routes = read('src/api/routes/agents.ts');

  it('the skills endpoint reads the agent root, not only the legacy path', () => {
    // It used to read <agentRoot>/workspace/skills while save_skill wrote to
    // <agentRoot>/skills, so authored skills were invisible.
    expect(routes).toMatch(/authoredSkillDirs\(/);
  });

  it('telemetry joins on the directory name, not the display name', () => {
    // The sidecar is keyed by save_skill's sanitised dir name; joining on the
    // frontmatter name silently finds nothing.
    expect(routes).toMatch(/origins\[entry\.dir\]/);
  });

  it('the ledger routes are declared before the :dir route that could shadow them', () => {
    const ledger = routes.indexOf("'/:id/skills/ledger'");
    const entry = routes.indexOf("'/:id/skills/ledger/:entryId'");
    const dir = routes.indexOf("'/:id/skills/:dir/content'");
    expect(ledger).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(-1);
    expect(dir).toBeGreaterThan(-1);
    expect(dir).toBeGreaterThan(ledger);
    expect(dir).toBeGreaterThan(entry);
  });
});

// ─── the script itself ───────────────────────────────────────────────────────

describe('the end-to-end verifier exists and is runnable', () => {
  it('is present and executable content, not an empty placeholder', () => {
    const script = read('scripts/verify-learning-loop.sh');
    expect(script.length).toBeGreaterThan(1000);
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
  });

  it('asserts on the artifacts that prove the loop closed', () => {
    const script = read('scripts/verify-learning-loop.sh');
    for (const artifact of [
      'SKILL.md',
      '.origins.json',
      '.ledger.jsonl',
      '.blobs',
      '.archive',
    ]) {
      expect(script, `verifier never checks ${artifact}`).toContain(artifact);
    }
  });

  it('fails the build rather than reporting success on a broken loop', () => {
    expect(read('scripts/verify-learning-loop.sh')).toMatch(/exit 1/);
  });
});
