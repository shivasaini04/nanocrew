/**
 * Renders an agent's self-report — the text an agent reads when asked what it has done.
 *
 * Pure on purpose: every input arrives as data, nothing here touches the DB, the clock
 * (beyond an injectable `now`) or the filesystem. The route gathers, this renders, and
 * the result can be exercised against real production rows without standing up express.
 *
 * Why the rendering lives on the orchestrator rather than in the Python tool: container
 * code needs `bash build.sh` to ship, a step a standard compose deploy skips entirely,
 * so the half most likely to need a wording fix belongs on the side that redeploys
 * normally. The tool stays a thin client.
 */
import type {
  AgentSelfReportData,
  CycleTraceSignals,
  HandoffOutcome,
} from '../db.js';
import { renderChangeImpacts, type ChangeImpact } from './change-impact.js';

/** Cycle types the scheduler runs as background housekeeping regardless of trigger mode. */
const BACKGROUND_CYCLE_TYPES = new Set(['self_improve', 'checkin']);

/**
 * Floor under the staleness test, so a type that happened to run twice a minute apart
 * is not called stopped an hour later.
 */
const MIN_STALE_MS = 3 * 60 * 60 * 1000;

/** Parse a stored timestamp that may or may not carry a zone. */
export function asEpoch(iso: string): number {
  return Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
}

/** "3d ago" / "4h ago" — an ISO instant is not a duration, and the model must not do the subtraction. */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const then = asEpoch(iso);
  if (!Number.isFinite(then)) return String(iso);
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

/**
 * The median gap between consecutive runs, in ms — a schedule entry's cadence as
 * observed rather than as declared.
 *
 * Median because a restart or a budget pause leaves one huge gap in an otherwise regular
 * series, and a mean would swallow the very stop this is meant to detect. Returns null
 * when there are too few runs to have a cadence at all.
 *
 * Observed rather than declared because one fixed staleness threshold cannot serve both
 * an hourly sweep and a weekly report: 48h misses a stopped hourly schedule for two
 * days, and libels a weekly one every week.
 */
export function typicalGapMs(startsNewestFirst: string[]): number | null {
  if (startsNewestFirst.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 0; i < startsNewestFirst.length - 1; i++) {
    const g = asEpoch(startsNewestFirst[i]) - asEpoch(startsNewestFirst[i + 1]);
    if (Number.isFinite(g) && g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export function humanDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface SelfReportInput {
  agent: {
    name: string;
    type: string;
    status: string;
    created_at: string;
    identity_version: number;
    last_evolved_at?: string | null;
    parent_agent_id?: string | null;
  };
  model: string;
  triggerMode: string;
  /** Enabled schedule entries only — a disabled entry is not a broken promise. */
  schedule: Array<{ type: string; interval: string }>;
  nextCycle: { type: string; dueAt: string } | null;
  budget?: { daily?: number; monthly?: number } | null;
  data: AgentSelfReportData;
  /** entity → row count in workspace/tracked/<entity>.json, for entities where it parsed. */
  trackedFileCounts: Record<string, number>;
  /** How the last few cycles actually ran — see the "How you ran" section. */
  traceSignals?: CycleTraceSignals[];
  /** What followed each recent change to this agent. */
  changeImpacts?: ChangeImpact[];
  /** What became of the handoffs this agent sent. */
  handoffOutcomes?: HandoffOutcome[];
  /** Messages addressed to this agent that it has never answered. Stage 56. */
  messagesOwed?: number;
  now?: number;
}

export function renderSelfReport(input: SelfReportInput): {
  report: string;
  warnings: string[];
} {
  const { agent, data: d, schedule, budget: b } = input;
  const now = input.now ?? Date.now();
  const c = d.cycles;
  const L: string[] = [];

  // ── Origin ────────────────────────────────────────────────────────────────
  const ageDays = Math.max(
    0,
    Math.floor((now - asEpoch(agent.created_at)) / 86_400_000),
  );
  L.push(`# ${agent.name} — self-report`);
  L.push('');
  L.push(
    `${agent.name} · type ${agent.type} · created ${agent.created_at.slice(0, 10)} (${ageDays} days old)`,
  );
  L.push(
    `identity v${agent.identity_version}${agent.last_evolved_at ? `, last evolved ${ago(agent.last_evolved_at, now)}` : ''}`,
  );
  L.push(
    `model: ${input.model} · status: ${agent.status} · trigger: ${input.triggerMode}`,
  );
  if (agent.parent_agent_id)
    L.push(`spawned by agent ${agent.parent_agent_id}`);
  L.push(
    `next scheduled run: ${input.nextCycle ? `${input.nextCycle.type} at ${input.nextCycle.dueAt}` : 'none scheduled'}`,
  );

  // ── Lifetime activity ─────────────────────────────────────────────────────
  const failPct = c.total ? Math.round((c.failed / c.total) * 100) : 0;
  L.push('');
  L.push('## Cycles');
  L.push(
    `${c.total} total${c.first ? ` since ${c.first.slice(0, 10)}` : ''} — ${c.completed} completed, ${c.failed} failed (${failPct}%)${c.running ? `, ${c.running} running now` : ''}`,
  );
  if (c.byType.length)
    L.push(`  by type: ${c.byType.map((t) => `${t.type} ${t.n}`).join(' · ')}`);
  L.push(
    `  last 24h: ${c.last24h} · last 7d: ${c.last7d} · median duration ${c.medianMinutes ?? '?'} min`,
  );
  L.push(
    `  last cycle: ${ago(c.last, now)} · tasks recorded done: ${c.tasksDone}`,
  );
  if (c.topFailures.length) {
    L.push('  most common failures:');
    for (const f of c.topFailures)
      L.push(`    ${f.n}x  ${f.reason.replace(/\s+/g, ' ')}`);
  }
  if (c.recent.length) {
    L.push('  most recent:');
    for (const r of c.recent) {
      L.push(
        `    ${r.startedAt.slice(0, 16).replace('T', ' ')} ${r.type}/${r.status} — ${r.summary || '(no summary)'}`,
      );
    }
  }

  // ── Spend ─────────────────────────────────────────────────────────────────
  const pct = b?.daily ? Math.round((d.spend.today / b.daily) * 100) : 0;
  L.push('');
  L.push('## Spend');
  L.push(
    `today $${d.spend.today.toFixed(2)} of $${b?.daily ?? '?'} daily (${pct}%) · last 7d $${d.spend.last7d.toFixed(2)} · lifetime $${d.spend.lifetime.toFixed(2)}`,
  );

  // ── What you wrote down ───────────────────────────────────────────────────
  // The episode log is the agent's own account of a cycle, richer than the one-line
  // summary a human reads. It has been written on every substantial cycle for months
  // and never once read back to the agent that wrote it.
  if (d.episodes.length) {
    L.push('');
    L.push('## Your recent episode logs (what you wrote at the time)');
    for (const e of d.episodes) {
      const log = e.log.replace(/\s+/g, ' ').trim();
      L.push(
        `  ${e.at.slice(0, 16).replace('T', ' ')} ${e.type} — ${log.slice(0, 320)}${log.length > 320 ? '…' : ''}`,
      );
    }
  }

  // ── What the human said ───────────────────────────────────────────────────
  // Verbatim, always. A bare "reject" has previously been summarised into invented
  // instructions and written to IDENTITY.md at relevance 0.9 — so the text is quoted
  // exactly and the instruction not to read past it is stated next to it, where it
  // applies, rather than only in the footer.
  if (d.feedback.length) {
    L.push('');
    L.push(
      '## What your owner actually said (verbatim — do not infer beyond the words)',
    );
    for (const f of d.feedback) {
      const about = f.about
        .replace(/\s+/g, ' ')
        .replace(/^#+\s*/, '')
        .trim();
      L.push(
        `  ${(f.respondedAt ?? f.at).slice(0, 10)} on "${about.slice(0, 60)}"`,
      );
      L.push(
        `      → ${JSON.stringify(f.reply.replace(/\s+/g, ' ').trim().slice(0, 240))}`,
      );
    }
    L.push(
      '  If a reply is just "approve" or "reject", that is the whole of it. It carries no',
    );
    L.push('  further instruction, and you must not invent one from it.');
  }

  // ── Effect on the world ───────────────────────────────────────────────────
  L.push('');
  L.push('## What you produced');
  if (d.tracked.length) {
    for (const entity of new Set(d.tracked.map((t) => t.entity))) {
      const rows = d.tracked.filter((t) => t.entity === entity);
      const total = rows.reduce((s, t) => s + t.n, 0);
      L.push(
        `  tracked ${entity}: ${total} rows — ${rows.map((t) => `${t.stage} ${t.n}`).join(', ')}`,
      );
    }
  } else {
    L.push('  tracked items: none');
  }
  L.push(
    `  handoffs: ${d.handoffs.sent} sent, ${d.handoffs.received} received, ${d.handoffs.pendingIn} pending for you`,
  );
  // What became of what you sent — the thing Finder asked for on 2026-08-24 and never got.
  for (const h of input.handoffOutcomes ?? []) {
    // Stage 56: the answered states are listed separately from `seenOnly`, because
    // conflating them is what this whole area got wrong. `seen` means a cycle had the
    // message in context — nothing more — and it read as "handled" 347 times.
    const answered = [
      h.completed ? `${h.completed} answered` : '',
      h.refused ? `${h.refused} refused` : '',
      h.cannot ? `${h.cannot} could not` : '',
      h.failed ? `${h.failed} failed` : '',
      h.agreed ? `${h.agreed} taken on` : '',
    ]
      .filter(Boolean)
      .join(', ');
    L.push(
      `    -> ${h.toAgent}: ${h.sent} sent` +
        (answered ? `, ${answered}` : '') +
        `, ${h.seenOnly} seen but never answered, ${h.stillPending} still pending` +
        `${h.recipientCyclesSince !== null ? ` · it has run ${h.recipientCyclesSince} cycles since your last one` : ''}`,
    );
    if (h.recipientCyclesSince === 0) {
      L.push(
        `       ${h.toAgent} has not run since you handed it work. It is not ignoring you — it is not awake.`,
      );
    }
    // Their answers, verbatim. Summarising them here is how a "0 found" becomes a
    // "found some" by the time it reaches the model.
    for (const a of h.recentAnswers ?? []) {
      L.push(
        `       ${h.toAgent} said (${a.performative}): ${a.result.slice(0, 220)}${a.reason ? ` — ${a.reason.slice(0, 120)}` : ''}`,
      );
    }
    if (
      h.seenOnly > 0 &&
      (h.recentAnswers ?? []).length === 0 &&
      h.recipientCyclesSince
    ) {
      L.push(
        `       ${h.toAgent} has run since, and answered none of it. Ask it directly rather than assuming the work was done.`,
      );
    }
  }
  L.push(
    `  check-ins raised: ${d.checkins.total} (${d.checkins.pending} still pending)`,
  );
  L.push(
    `  memory: ${d.memory.memories} stored, ${d.memory.learnedBullets} learned bullets`,
  );
  if (d.outreach) {
    const o = d.outreach;
    L.push(
      `  outreach you sent: ${o.sends} emails to ${o.people} people, ${o.bounced} bounced, last ${ago(o.lastSentAt, now)}`,
    );
    L.push(
      `  replies to those: ${o.replies} total, ${o.humanReplies} from a human (the rest automated)`,
    );
  }

  // ── How you ran ───────────────────────────────────────────────────────────
  //
  // The one thing an agent has never been able to see about itself. It gets its own
  // SUMMARY; the operator reads cycle_steps — which tool, what arguments, what came
  // back, how long each gap took. Mailer spent 38 minutes appending 12 lines to a file,
  // re-ran a command it had already run 13 minutes earlier, and described the cycle as
  // productive. Everything needed to notice that was recorded; none of it reached the
  // agent that did it.
  //
  // Derived numbers, not the raw trace: the trace is a token bomb and the model would
  // have to compute these anyway.
  const sigs = input.traceSignals ?? [];
  if (sigs.length) {
    L.push('');
    L.push('## How you ran (your last few cycles)');
    for (const s of sigs) {
      const when = s.startedAt.slice(0, 16).replace('T', ' ');
      L.push(
        `  ${when} ${s.cycleType} — ${s.steps} steps, ${s.spanMinutes ?? '?'} min`,
      );
      if (s.medianGapSeconds !== null) {
        // The tools here are near-instant (a 2KB read, an ls), so the gap is the
        // model. Say whether it is a median or an average rather than passing an
        // average off as a median — the step timestamps are often all identical.
        L.push(
          `      think time: ${s.medianGapSeconds}s ${s.gapIsAverage ? 'average' : 'median'} per step` +
            `${!s.gapIsAverage && s.slowestGapSeconds ? `, ${s.slowestGapSeconds}s slowest` : ''}` +
            `${s.medianGapSeconds > 30 ? '  <-- SLOW. That is your model, not your tools.' : ''}`,
        );
      }
      if (s.repeatedCalls.length) {
        L.push('      REPEATED yourself:');
        for (const r of s.repeatedCalls) {
          L.push(`        ${r.times}x  ${r.tool}(${r.argsPreview})`);
        }
        L.push(
          '        Running the same call twice means you lost track of an answer you',
        );
        L.push(
          '        already had. Re-read your earlier result instead of re-fetching it.',
        );
      }
      if (s.failedCalls.length) {
        L.push('      tools that errored:');
        for (const f of s.failedCalls)
          L.push(`        ${f.times}x  ${f.tool} — ${f.sample}`);
      }
      if (s.toolBreakdown.length) {
        L.push(
          `      tools: ${s.toolBreakdown.map((t) => `${t.tool} ${t.calls}`).join(' · ')}`,
        );
      }
    }
  }

  // ── What followed your changes ────────────────────────────────────────────
  // The half of self-improvement that has never existed. Crawler changed method on
  // 2026-08-22, ran ~200 cycles on the new one, and concluded it was working — nothing
  // anywhere compared before to after.
  for (const line of renderChangeImpacts(input.changeImpacts ?? []))
    L.push(line);

  // ── Reality checks ────────────────────────────────────────────────────────
  // The point of the whole report. Each line is a comparison already resolved, not two
  // numbers left for the model to reconcile — the failures that have actually hurt here
  // (a scheduler that came up registering nothing, leads that stopped syncing,
  // approvals nobody answered) all survived for days because the comparison was never
  // made by anyone.
  const warnings: string[] = [];
  const dueTypes = schedule.filter((s) => !BACKGROUND_CYCLE_TYPES.has(s.type));

  if (
    input.triggerMode === 'scheduled' &&
    dueTypes.length > 0 &&
    agent.status !== 'running'
  ) {
    warnings.push(
      `NOT ARMED — your status is '${agent.status}'. The scheduler registers only agents with ` +
        `status 'running', so none of your ${dueTypes.length} schedule entries can fire. Only a ` +
        `human, or self_manage action=status, can arm you.`,
    );
  }

  for (const s of dueTypes) {
    const last = c.lastRunByType[s.type];
    if (!last) {
      warnings.push(
        `SCHEDULE VS REALITY — '${s.type}' is scheduled "${s.interval}" but has NEVER run. ` +
          `A schedule entry that reads correctly can still be silently dropped.`,
      );
      continue;
    }
    const gap = typicalGapMs(c.recentRunsByType[s.type] ?? []);
    if (gap === null) continue; // too few runs to have a cadence to judge against
    if (now - asEpoch(last) > Math.max(3 * gap, MIN_STALE_MS)) {
      warnings.push(
        `SCHEDULE VS REALITY — '${s.type}' is scheduled "${s.interval}" and normally runs about ` +
          `every ${humanDuration(gap)}, but last ran ${ago(last, now)}. Something between the ` +
          `schedule and the runner has stopped firing.`,
      );
    }
  }

  // File-vs-DB divergence. The workspace file is what the agent reads and reports from;
  // tracked_items is what the dashboard and every other agent sees. When a write reaches
  // one and not the other, both sides stay internally consistent and silently disagree —
  // 63 of Finder's 183 leads, 25 of them carrying emails, never reached the DB, and
  // nothing surfaced it for two weeks.
  for (const [entity, fileCount] of Object.entries(input.trackedFileCounts)) {
    const dbCount = d.tracked
      .filter((t) => t.entity === entity)
      .reduce((s, t) => s + t.n, 0);
    if (fileCount !== dbCount) {
      warnings.push(
        `FILE VS DB — workspace/tracked/${entity}.json has ${fileCount} rows, tracked_items has ` +
          `${dbCount}. ${Math.abs(fileCount - dbCount)} row(s) are in one and not the other. Report ` +
          `both counts; do not silently pick one.`,
      );
    }
  }

  if (d.checkins.pending > 0) {
    warnings.push(
      `BLOCKED — ${d.checkins.pending} check-in(s) awaiting a human, oldest raised ` +
        `${ago(d.checkins.oldestPendingAt, now)}. Anything gated on those has not happened.`,
    );
  }
  if (d.handoffs.pendingIn > 0 && agent.status !== 'running') {
    warnings.push(
      `${d.handoffs.pendingIn} handoff(s) are queued for you and you are not armed, so nothing ` +
        `will wake you to collect them.`,
    );
  }
  // Signals that are worth promoting from "here are your numbers" to "this is wrong".
  const slow = sigs.filter((s) => (s.medianGapSeconds ?? 0) > 30);
  if (slow.length >= 2) {
    warnings.push(
      `SLOW MODEL — your median gap between steps is ${slow[0].medianGapSeconds}s across ` +
        `${slow.length} recent cycles. The tools you are calling are near-instant, so that time ` +
        `is the model thinking. A faster model would do the same work in a fraction of it; ` +
        `self_manage action=model can change it.`,
    );
  }
  const looping = sigs.find((s) => s.repeatedCalls.some((r) => r.times > 1));
  if (looping) {
    const worst = looping.repeatedCalls[0];
    warnings.push(
      `YOU REPEATED YOURSELF — ${worst.times} identical ${worst.tool} calls in one cycle. ` +
        `You are re-fetching answers you already had rather than re-reading them, which is how ` +
        `a cycle burns its budget without moving.`,
    );
  }

  // A change followed by an output collapse is the single most important thing this
  // report can say, so it does not sit quietly among the numbers.
  for (const imp of input.changeImpacts ?? []) {
    if (imp.insufficient) continue;
    const bOut = imp.before.outputRows;
    const aOut = imp.after.outputRows;
    if (bOut !== null && aOut !== null && bOut >= 3 && aOut <= bOut * 0.5) {
      warnings.push(
        `OUTPUT FELL AFTER A CHANGE — since your ${imp.changedAt.slice(0, 10)} ` +
          `${imp.capability} change, tracked rows went ${bOut} to ${aOut}. That is what ` +
          `FOLLOWED it, not proof it caused it — but check that change before doing more work ` +
          `on the current approach.`,
      );
    }
  }

  if (b?.daily && d.spend.today >= b.daily) {
    warnings.push(
      `BUDGET — you have spent $${d.spend.today.toFixed(2)} of your $${b.daily} daily cap.`,
    );
  }

  // Stage 56. Both directions of the silence, made into a comparison rather than two
  // numbers. The sending half is the one Finder asked for on 2026-08-24 and never got;
  // the receiving half is what stops this agent being the one who goes quiet.
  const unanswered = (input.handoffOutcomes ?? []).reduce(
    (n, h) => n + h.seenOnly,
    0,
  );
  if (unanswered > 0) {
    warnings.push(
      `NO ANSWER — ${unanswered} thing(s) you handed out were seen and never answered. ` +
        `'seen' only means a cycle ran with your message in front of it. Ask directly rather ` +
        `than assuming the work was done.`,
    );
  }
  if (input.messagesOwed && input.messagesOwed > 0) {
    warnings.push(
      `YOU OWE AN ANSWER — ${input.messagesOwed} message(s) addressed to you have never been ` +
        `answered. The sender cannot see what you did; reply with reply_to_handoff, and answer ` +
        `'cannot' naming what you lack rather than staying silent.`,
    );
  }

  L.push('');
  L.push('## Reality checks');
  if (warnings.length === 0)
    L.push('  none — schedule, records and approvals all line up.');
  else for (const w of warnings) L.push(`  [!] ${w}`);

  // ── Scope ─────────────────────────────────────────────────────────────────
  // Naming the boundary turns a guess into a referral. Asked about its one reply, Finder
  // wrote "zero recorded sends exist in my records" and then invented an address to
  // fill the gap it had just correctly identified.
  L.push('');
  L.push('## Not visible to you');
  L.push(
    "  - Any other agent's cycles, spend, leads or records. Ask them directly, or ask your owner.",
  );
  if (!d.outreach)
    L.push(
      '  - Email sends and replies: you have sent none. Whoever does the sending owns that record.',
    );
  L.push(
    '  - Per-cycle token counts, which are not persisted — call usage_report for token and cache figures.',
  );
  L.push(
    '  - What a human thought of your work, beyond an approve or reject on a check-in.',
  );
  L.push('');
  L.push(
    'These figures come from the orchestrator database at read time. Quote them as they are: ' +
      'do not recompute, round, or state a number that is not printed above.',
  );

  return { report: L.join('\n'), warnings };
}
