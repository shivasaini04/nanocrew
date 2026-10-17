/**
 * Stage 57 — the engine wired to the real platform: Docker workers, the agent registry,
 * the wake policy, the boss's inbox. Started from index.ts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { createAgentCheckin, getAgent } from '../db.js';
import { getSocketIO } from '../api/instances.js';
import { logger } from '../logger.js';
import { notify } from '../notifications.js';
import { agentService } from '../agents/agent-registry.js';
import { canWake } from '../agents/wake-policy.js';
import { copyWorkerFiles } from './artifacts.js';
import { SwarmEngine } from './engine.js';
import { pickJudges, runPanel } from './judge.js';
import { checkEmail, complete, knownToOwner } from './live-checks.js';
import { fetchPage } from './page-fetch.js';
import { runCommandInSandbox } from './sandbox.js';
import { markTaintedByWorkerData } from './taint.js';
import type { VerifyContext } from './verify.js';
import {
  killWorker,
  runWorkerAttempt,
  workerModelFor,
  workerRoot,
} from './worker.js';

function verifyContextFor(
  ownerUserId: string | null,
  ownerAgentId: string,
  attemptId: string,
  workerModel: string | null,
): VerifyContext {
  const models = workerModelFor(ownerAgentId);
  return {
    fetchPage,
    checkEmail,
    knownToOwner: (value) => knownToOwner(ownerUserId, value),
    runCommand: (command, timeoutMs, files) =>
      runCommandInSandbox(attemptId, command, timeoutMs, files),
    judge: (input) =>
      runPanel(
        input,
        pickJudges([
          workerModel ?? '',
          models?.model ?? '',
          models?.strongerModel ?? '',
        ]),
        complete,
      ),
  };
}

let engine: SwarmEngine | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const slotWaiters = new Map<string, Array<() => void>>();
let listening = false;

/** Resolves when this agent's turn slot next frees, or after `maxMs` as a backstop. */
function nextFreeSlot(agentId: string, maxMs: number): Promise<void> {
  if (!listening) {
    listening = true;
    agentService.onCycleSlotFreed((id) => {
      for (const fn of slotWaiters.get(id)?.splice(0) ?? []) fn();
    });
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    timer.unref?.();
    const list = slotWaiters.get(agentId) ?? [];
    list.push(() => {
      clearTimeout(timer);
      resolve();
    });
    slotWaiters.set(agentId, list);
  });
}

/**
 * Wake the boss, waiting out a turn already in flight. Started by the slot-freed signal, not
 * a 30 s poll; the owner's queued chat messages start first on the same signal, and the wake
 * follows them. Bounded: 20 turns or two hours, whichever comes first.
 */
async function wakeWhenFree(
  agentId: string,
  context: string,
  attempt = 0,
): Promise<string | null> {
  try {
    const cycle = await agentService.runCycle(
      agentId,
      'custom',
      context,
      undefined,
      undefined,
      undefined,
      { chatJid: `agent:${agentId}` },
    );
    return cycle?.summary ?? null;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/already running a cycle/i.test(msg) && attempt < 20) {
      await nextFreeSlot(agentId, 6 * 60_000);
      return wakeWhenFree(agentId, context, attempt + 1);
    }
    throw err;
  }
}

export function getSwarmEngine(): SwarmEngine {
  if (engine) return engine;
  engine = new SwarmEngine({
    runAttempt: runWorkerAttempt,
    kill: killWorker,
    modelsFor: workerModelFor,
    ownerUserOf: (agentId) => getAgent(agentId)?.owner_id ?? null,
    deliver: (run, digest, markdown) => {
      const inbox = path.join(
        DATA_DIR,
        'agents',
        run.owner_agent_id,
        'workspace',
        'inbox',
      );
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, `run-${run.id}.md`), markdown, 'utf-8');
      fs.writeFileSync(
        path.join(inbox, `run-${run.id}.json`),
        JSON.stringify(digest, null, 2),
        'utf-8',
      );
    },
    canWake: (agentId) => {
      const agent = getAgent(agentId);
      return !!agent && canWake(agent, 'swarm');
    },
    wake: wakeWhenFree,
    taint: markTaintedByWorkerData,
    cleanup: (attemptId) => {
      // Keep the result and the files the worker made; drop its conversation state.
      try {
        fs.rmSync(path.join(workerRoot(attemptId), 'sessions'), {
          recursive: true,
          force: true,
        });
      } catch {
        /* gone */
      }
    },
    verifyContext: (run, attemptId, workerModel) =>
      verifyContextFor(
        run.owner_user_id,
        run.owner_agent_id,
        attemptId,
        workerModel,
      ),
    reloadContract: (attemptId) => {
      try {
        return JSON.parse(
          fs.readFileSync(
            path.join(workerRoot(attemptId), 'result.json'),
            'utf-8',
          ),
        );
      } catch {
        return undefined;
      }
    },
    alert: (run, title, body) =>
      notify('agent_alert', title, body, run.owner_agent_id),
    // The boss's /workspace/group is data/agents/<id>; its files live under workspace/.
    collectFiles: (run, task, attemptId) => {
      const rel = `workspace/runs/${run.id}/task-${task.idx}`;
      const { copied, skipped } = copyWorkerFiles(
        workerRoot(attemptId),
        path.join(DATA_DIR, 'agents', run.owner_agent_id, rel),
      );
      if (skipped)
        logger.info(
          { runId: run.id, attemptId, skipped },
          'worker files skipped (links, limits)',
        );
      return copied.map((f) => `/workspace/group/${rel}/${f}`);
    },
    // A held run's plan goes to the owner as an ordinary approval on the boss agent: Approve
    // starts it (agent-service → approvePlan), Reject cancels it. No approval rule matches
    // 'run_plan', so it is never auto-approved.
    requestPlanApproval: (run, planMarkdown) => {
      const created = createAgentCheckin({
        agent_id: run.owner_agent_id,
        status: 'pending',
        report_md: planMarkdown,
        action_type: 'run_plan',
        action_payload: JSON.stringify({
          runId: run.id,
          goal: run.goal,
          budget_usd: run.budget_usd,
        }),
        created_at: new Date().toISOString(),
      } as Parameters<typeof createAgentCheckin>[0]);
      getSocketIO()?.emit('agent:checkin_created', {
        agentId: run.owner_agent_id,
        checkinId: created.id,
      });
      notify(
        'agent_alert',
        `Approve a run? ${run.goal.slice(0, 60)}`,
        `Up to $${run.budget_usd.toFixed(2)} — over the $1 you approve runs above. Open the agent's approvals to start or cancel it.`,
        run.owner_agent_id,
      );
    },
  });
  return engine;
}

/** Resume runs a restart interrupted, then keep a slow safety tick for expired leases. */
export function startSwarmService(): void {
  const e = getSwarmEngine();
  const lost = e.recover();
  if (lost)
    logger.warn(
      { lost },
      'swarm: attempts interrupted by the restart were retried or failed',
    );
  if (!timer) {
    timer = setInterval(() => {
      try {
        e.reap();
        e.tick();
        e.detectStalls();
      } catch (err) {
        logger.warn({ err: String(err) }, 'swarm tick failed');
      }
    }, 30_000);
    timer.unref?.();
  }
  logger.info('Swarm service started');
}
