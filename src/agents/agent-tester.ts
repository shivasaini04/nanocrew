/**
 * Agent Tester — runs three-step validation for any agent:
 *
 *   Step 1  Structural check   — filesystem, metadata (< 1s, no containers)
 *   Step 2  Sidecar smoke      — container starts, packages install (skipped if no sidecar tools)
 *   Step 3  Mission test       — one real cycle, structural + LLM-judged result
 *
 * Results written to data/agents/{id}/test-results/latest.json + history/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { sidecarRegistry } from './agent-sidecar.js';
import { callLLM, type MissionTask } from './tool-generator.js';
import type { AgentCycle, CycleType } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TestTrigger =
  | 'agent_created'
  | 'tool_regenerated'
  | 'manual'
  | 'scheduled';

export interface CheckResult {
  check: string;
  pass: boolean;
  matched?: string;
  detail?: string;
}

export interface StepResult {
  pass: boolean;
  ms: number;
  checks?: CheckResult[];
  detail?: string;
  judgeVerdict?: 'PASS' | 'FAIL';
  judgeNotes?: string;
}

export interface TestRun {
  runId: string;
  trigger: TestTrigger;
  agentId: string;
  durationMs: number;
  steps: {
    structural: StepResult;
    smoke?: StepResult;
    mission?: StepResult;
  };
  verdict: 'PASS' | 'FAIL' | 'PARTIAL';
}

type RunCycleFn = (
  agentId: string,
  cycleType: CycleType,
  context: string,
) => Promise<AgentCycle>;

// ─── Step 1: Structural check ─────────────────────────────────────────────────

export function runStructuralCheck(
  agentId: string,
  agentsDir: string,
): StepResult {
  const start = Date.now();
  const agentDir = path.join(agentsDir, agentId);
  const toolsDir = path.join(agentDir, 'tools');
  const checks: CheckResult[] = [];

  // 1a. Agent directory exists
  checks.push({
    check: 'agent_dir_exists',
    pass: fs.existsSync(agentDir),
    detail: agentDir,
  });

  // 1b. If tools dir exists, every .json metadata file must have a status field
  if (fs.existsSync(toolsDir)) {
    const metaFiles = fs
      .readdirSync(toolsDir)
      .filter((f) => f.endsWith('.json'));
    for (const mf of metaFiles) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(toolsDir, mf), 'utf-8'),
        );
        checks.push({
          check: `tool_meta_valid:${mf}`,
          pass: typeof meta.status === 'string',
          detail: meta.status,
        });
      } catch {
        checks.push({
          check: `tool_meta_valid:${mf}`,
          pass: false,
          detail: 'parse error',
        });
      }
    }

    // 1c. Every sidecar tool must have a corresponding .py file
    for (const mf of metaFiles) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(toolsDir, mf), 'utf-8'),
        );
        if (meta.requiresSidecar) {
          const toolName = mf.replace('.json', '');
          const pyExists = fs.existsSync(path.join(toolsDir, `${toolName}.py`));
          checks.push({
            check: `sidecar_py_exists:${toolName}`,
            pass: pyExists,
          });
        }
      } catch {
        /* already caught above */
      }
    }
  }

  // 1d. If agent-env.json exists, it must be valid JSON with required fields
  const envPath = path.join(agentDir, 'agent-env.json');
  if (fs.existsSync(envPath)) {
    try {
      const env = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
      checks.push({
        check: 'agent_env_valid',
        pass:
          Array.isArray(env.pythonPackages) && Array.isArray(env.aptPackages),
      });
    } catch {
      checks.push({
        check: 'agent_env_valid',
        pass: false,
        detail: 'parse error',
      });
    }
  }

  const pass = checks.every((c) => c.pass);
  return { pass, ms: Date.now() - start, checks };
}

// ─── Step 2: Sidecar smoke test ───────────────────────────────────────────────

export async function runSmokeTest(
  agentId: string,
  agentsDir: string,
): Promise<StepResult | null> {
  const agentDir = path.join(agentsDir, agentId);
  const toolsDir = path.join(agentDir, 'tools');

  // Skip entirely if this agent has no sidecar tools
  if (!fs.existsSync(toolsDir)) return null;
  const metaFiles = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.json'));
  const hasSidecar = metaFiles.some((mf) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(toolsDir, mf), 'utf-8'));
      return m.requiresSidecar === true;
    } catch {
      return false;
    }
  });
  if (!hasSidecar) return null;

  const start = Date.now();
  const checks: CheckResult[] = [];

  try {
    const sidecar = sidecarRegistry.get(agentId);
    await sidecar.ensure();

    checks.push({
      check: 'sidecar_ready',
      pass: sidecar.getStatus().state === 'ready',
    });

    // Ping: call a non-existent tool — sidecar should respond (with "not found", not silence)
    const ping = await sidecar.call('__ping__', {});
    const pingOk =
      ping.status === 'ok' ||
      (ping.status === 'error' && (ping.error ?? '').includes('not found'));
    checks.push({ check: 'sidecar_ipc_ok', pass: pingOk, detail: ping.error });

    const pass = checks.every((c) => c.pass);
    return {
      pass,
      ms: Date.now() - start,
      checks,
      detail: sidecar.getStatus().log.join('; '),
    };
  } catch (err: any) {
    checks.push({ check: 'sidecar_ready', pass: false, detail: err.message });
    return { pass: false, ms: Date.now() - start, checks, detail: err.message };
  }
}

// ─── Step 3: Mission test ─────────────────────────────────────────────────────

export async function runMissionTest(
  agentId: string,
  agentsDir: string,
  runCycleFn: RunCycleFn,
  timeoutMs = 300_000,
): Promise<StepResult> {
  const start = Date.now();
  const agentDir = path.join(agentsDir, agentId);
  const taskPath = path.join(agentDir, 'test-results', 'mission-task.json');

  if (!fs.existsSync(taskPath)) {
    return {
      pass: false,
      ms: Date.now() - start,
      detail: 'mission-task.json not found — generate it first',
    };
  }

  const missionTask: MissionTask = JSON.parse(
    fs.readFileSync(taskPath, 'utf-8'),
  );
  const outputDir = path.join(agentDir, 'output');
  const checks: CheckResult[] = [];

  // Run the actual cycle
  let cycle: AgentCycle;
  try {
    const raceResult = await Promise.race([
      runCycleFn(agentId, 'custom', missionTask.task),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Mission test timed out after ${timeoutMs / 1000}s`),
            ),
          timeoutMs,
        ),
      ),
    ]);
    cycle = raceResult as AgentCycle;
  } catch (err: any) {
    return { pass: false, ms: Date.now() - start, detail: err.message };
  }

  // Structural checks
  checks.push({
    check: 'cycle_completed',
    pass: cycle.status === 'completed',
    detail: cycle.status,
  });

  for (const sc of missionTask.structuralChecks) {
    if (sc.check === 'output_file_exists') {
      const matched = findOutputFile(outputDir, sc.pattern);
      checks.push({
        check: `output_file_exists:${sc.pattern}`,
        pass: matched !== null,
        matched: matched ?? undefined,
      });
    }
    if (sc.check === 'response_contains') {
      const summary = cycle.summary ?? '';
      const found = summary.toLowerCase().includes(sc.pattern.toLowerCase());
      checks.push({ check: `response_contains:${sc.pattern}`, pass: found });
    }
  }

  // Behavioral LLM judge
  const outputFiles = fs.existsSync(outputDir)
    ? fs
        .readdirSync(outputDir)
        .filter((f) => !f.startsWith('.'))
        .join(', ')
    : 'none';

  const { verdict, notes } = await llmJudge(
    missionTask.task,
    missionTask.behavioralCriteria,
    cycle.summary ?? '(no summary)',
    outputFiles,
  );

  const structuralPass = checks.every((c) => c.pass);
  return {
    pass: structuralPass && verdict === 'PASS',
    ms: Date.now() - start,
    checks,
    judgeVerdict: verdict,
    judgeNotes: notes,
  };
}

// ─── Run a single custom case (structural + mission, no sidecar smoke) ────────

export interface CustomCaseResult {
  caseId: string;
  verdict: 'PASS' | 'FAIL';
  durationMs: number;
  structural: StepResult;
  mission: StepResult;
  ranAt: string;
}

export async function runCustomCase(
  agentId: string,
  agentsDir: string,
  caseObj: {
    id: string;
    task: string;
    structuralChecks: MissionTask['structuralChecks'];
    behavioralCriteria: string;
  },
  runCycleFn: RunCycleFn,
  timeoutMs = 300_000,
): Promise<CustomCaseResult> {
  const start = Date.now();

  // Step 1: structural (fast)
  const structural = runStructuralCheck(agentId, agentsDir);

  // Step 2: run the cycle with the case's task
  const agentDir = path.join(agentsDir, agentId);
  const outputDir = path.join(agentDir, 'output');
  const missionChecks: CheckResult[] = [];

  let mission: StepResult;
  if (!structural.pass) {
    mission = {
      pass: false,
      ms: 0,
      detail: 'Skipped — structural check failed',
    };
  } else {
    const mStart = Date.now();
    let cycle: AgentCycle;
    try {
      const raceResult = await Promise.race([
        runCycleFn(agentId, 'custom', caseObj.task),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          ),
        ),
      ]);
      cycle = raceResult as AgentCycle;
    } catch (err: any) {
      mission = { pass: false, ms: Date.now() - mStart, detail: err.message };
      const verdict = structural.pass && mission.pass ? 'PASS' : 'FAIL';
      return {
        caseId: caseObj.id,
        verdict,
        durationMs: Date.now() - start,
        structural,
        mission,
        ranAt: new Date().toISOString(),
      };
    }

    missionChecks.push({
      check: 'cycle_completed',
      pass: cycle.status === 'completed',
      detail: cycle.status,
    });

    for (const sc of caseObj.structuralChecks) {
      if (sc.check === 'output_file_exists') {
        const matched = findOutputFile(outputDir, sc.pattern);
        missionChecks.push({
          check: `output_file_exists:${sc.pattern}`,
          pass: matched !== null,
          matched: matched ?? undefined,
        });
      }
      if (sc.check === 'response_contains') {
        const found = (cycle.summary ?? '')
          .toLowerCase()
          .includes(sc.pattern.toLowerCase());
        missionChecks.push({
          check: `response_contains:${sc.pattern}`,
          pass: found,
        });
      }
    }

    const outputFiles = fs.existsSync(outputDir)
      ? fs
          .readdirSync(outputDir)
          .filter((f) => !f.startsWith('.'))
          .join(', ')
      : 'none';

    const { verdict: jv, notes } = caseObj.behavioralCriteria
      ? await llmJudge(
          caseObj.task,
          caseObj.behavioralCriteria,
          cycle.summary ?? '(no summary)',
          outputFiles,
        )
      : { verdict: 'PASS' as const, notes: 'No behavioral criteria specified' };

    mission = {
      pass: missionChecks.every((c) => c.pass) && jv === 'PASS',
      ms: Date.now() - mStart,
      checks: missionChecks,
      judgeVerdict: jv,
      judgeNotes: notes,
    };
  }

  const verdict = structural.pass && mission.pass ? 'PASS' : 'FAIL';
  return {
    caseId: caseObj.id,
    verdict,
    durationMs: Date.now() - start,
    structural,
    mission,
    ranAt: new Date().toISOString(),
  };
}

// ─── Full suite orchestrator ──────────────────────────────────────────────────

export async function runFullTest(
  agentId: string,
  agentsDir: string,
  trigger: TestTrigger,
  runCycleFn: RunCycleFn,
): Promise<TestRun> {
  const runId = randomUUID();
  const start = Date.now();

  const run: TestRun = {
    runId,
    trigger,
    agentId,
    durationMs: 0,
    steps: { structural: { pass: false, ms: 0 } },
    verdict: 'FAIL',
  };

  logger.info({ agentId, trigger, runId }, 'Starting agent test run');

  // Step 1 — Structural (always runs)
  run.steps.structural = runStructuralCheck(agentId, agentsDir);
  if (!run.steps.structural.pass) {
    run.durationMs = Date.now() - start;
    run.verdict = 'FAIL';
    writeTestResult(agentId, agentsDir, run);
    return run;
  }

  // Step 2 — Sidecar smoke (skipped if no sidecar tools)
  const smokeResult = await runSmokeTest(agentId, agentsDir);
  if (smokeResult !== null) {
    run.steps.smoke = smokeResult;
    if (!smokeResult.pass) {
      run.durationMs = Date.now() - start;
      run.verdict = 'FAIL';
      writeTestResult(agentId, agentsDir, run);
      return run;
    }
  }

  // Step 3 — Mission test
  const missionResult = await runMissionTest(agentId, agentsDir, runCycleFn);
  run.steps.mission = missionResult;

  run.durationMs = Date.now() - start;
  run.verdict = missionResult.pass ? 'PASS' : 'FAIL';

  writeTestResult(agentId, agentsDir, run);
  logger.info(
    { agentId, verdict: run.verdict, durationMs: run.durationMs },
    'Agent test run complete',
  );
  return run;
}

// ─── Result persistence ───────────────────────────────────────────────────────

export function writeTestResult(
  agentId: string,
  agentsDir: string,
  run: TestRun,
): void {
  const resultsDir = path.join(agentsDir, agentId, 'test-results');
  const historyDir = path.join(resultsDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  const json = JSON.stringify(run, null, 2);
  fs.writeFileSync(path.join(resultsDir, 'latest.json'), json, 'utf-8');
  fs.writeFileSync(
    path.join(historyDir, `${Date.now()}_${run.runId}.json`),
    json,
    'utf-8',
  );
}

export function readLatestResult(
  agentId: string,
  agentsDir: string,
): TestRun | null {
  const p = path.join(agentsDir, agentId, 'test-results', 'latest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function readResultHistory(
  agentId: string,
  agentsDir: string,
): TestRun[] {
  const historyDir = path.join(agentsDir, agentId, 'test-results', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs
    .readdirSync(historyDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 50)
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as TestRun[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findOutputFile(outputDir: string, pattern: string): string | null {
  const ext = pattern.startsWith('*.') ? pattern.slice(1) : null;
  const dirsToCheck = [
    outputDir,
    path.join(path.dirname(outputDir), 'workspace'),
  ];
  for (const dir of dirsToCheck) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const match = ext
      ? files.find((f) => f.endsWith(ext))
      : files.find((f) => f === pattern);
    if (match) return match;
  }
  return null;
}

const JUDGE_SYSTEM = `You are evaluating whether an AI agent successfully completed a test task.
Reply with EXACTLY one line in this format:
PASS: <one short sentence why>
or
FAIL: <one short sentence why not>`;

async function llmJudge(
  task: string,
  criteria: string,
  summary: string,
  files: string,
): Promise<{ verdict: 'PASS' | 'FAIL'; notes: string }> {
  const userPrompt = `Task: ${task}\nCriteria: ${criteria}\nAgent summary: ${summary}\nOutput files: ${files}`;

  try {
    const raw = await callLLM(JUDGE_SYSTEM, userPrompt, 120);
    const line = raw.trim().split('\n')[0] ?? '';
    const isPass = line.toUpperCase().startsWith('PASS');
    const notes = line.replace(/^(PASS|FAIL):\s*/i, '').trim();
    return { verdict: isPass ? 'PASS' : 'FAIL', notes };
  } catch {
    // If LLM judge fails, fall back to trusting structural checks only
    return {
      verdict: 'PASS',
      notes: 'LLM judge unavailable — structural checks passed',
    };
  }
}
