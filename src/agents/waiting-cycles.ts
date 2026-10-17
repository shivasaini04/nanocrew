/**
 * Finding agents that are waiting on each other.
 *
 * Stage 56, closing the last item `06` named and phase 4 did not build.
 *
 * The failure this catches is dangerous specifically because it looks fine. A waits on B,
 * B waits on A; both requests sit in `pending`/`seen`/`agreed`, both agents report
 * healthy, and nothing anywhere says the pair has stopped making progress. That is the
 * same shape as the bug this whole stage exists to fix — 347 handoffs reading as
 * `acknowledged` — one level up, in the graph rather than the row.
 *
 * Deadlines already stop a wait lasting forever, so this is not the safety net; expiry is.
 * This exists because a cycle that keeps re-forming after each expiry is a design problem,
 * and the owner should hear about it from a digest rather than from a month of quiet
 * agents.
 *
 * Plain DFS over a graph with one node per agent. At six agents — or six hundred — this is
 * not worth an algorithm.
 */
import { getWaitingEdges } from '../db.js';

export interface WaitingCycle {
  /** Agent names in order, first repeated at the end: A → B → A. */
  path: string[];
  /** How long the oldest request in the cycle has been waiting. */
  oldest: string;
}

/**
 * Every distinct cycle in the "is waiting on" graph.
 *
 * Deduplicated by the set of members, not the path: A→B→A and B→A→B are one deadlock, and
 * reporting it twice would train the reader to skim.
 */
export function findWaitingCycles(edges = getWaitingEdges()): WaitingCycle[] {
  const out = new Map<string, WaitingCycle>();
  if (edges.length === 0) return [];

  const byFrom = new Map<string, typeof edges>();
  const nameOf = new Map<string, string>();
  for (const e of edges) {
    nameOf.set(e.from, e.fromName);
    nameOf.set(e.to, e.toName);
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from)!.push(e);
  }

  const walk = (
    start: string,
    at: string,
    path: string[],
    since: string[],
    seen: Set<string>,
  ) => {
    for (const edge of byFrom.get(at) ?? []) {
      if (edge.to === start) {
        const nodes = [...path]; // n0 … nk, without the closing repeat
        const waits = [...since, edge.since]; // waits[i] is the edge nodes[i] → nodes[i+1]
        const key = [...new Set(nodes)].sort().join('|');
        if (!out.has(key)) {
          // Rotate so the report starts with whoever has been waiting longest. Two
          // reasons, and the second is the real one: it is the most useful place to start
          // reading, and it makes the rendering DETERMINISTIC. Otherwise the same deadlock
          // prints as "Finder → Mailer → Finder" one day and "Mailer → Finder → Mailer" the
          // next, depending on map iteration order, and a digest that changes shape while
          // the situation does not is a digest people stop reading.
          let first = 0;
          for (let i = 1; i < waits.length; i++)
            if (waits[i] < waits[first]) first = i;
          const rotated = [...nodes.slice(first), ...nodes.slice(0, first)];
          out.set(key, {
            path: [...rotated, rotated[0]].map(
              (id) => nameOf.get(id) ?? id.slice(0, 8),
            ),
            oldest: waits[first],
          });
        }
        continue;
      }
      // Bounded at 6 hops. A longer chain is real but rarer than the pathological input
      // this would otherwise choke on, and a report nobody can read is not a report.
      if (seen.has(edge.to) || path.length >= 6) continue;
      seen.add(edge.to);
      walk(start, edge.to, [...path, edge.to], [...since, edge.since], seen);
      seen.delete(edge.to);
    }
  };

  for (const from of byFrom.keys()) {
    walk(from, from, [from], [], new Set([from]));
  }

  return [...out.values()].sort((a, b) => a.oldest.localeCompare(b.oldest));
}

/** One line per deadlock, for the digest. Empty string when there are none. */
export function renderWaitingCycles(cycles: WaitingCycle[]): string {
  if (cycles.length === 0) return '';
  const lines = [
    `${cycles.length} pair${cycles.length === 1 ? '' : 's'} of agents waiting on each other:`,
  ];
  for (const c of cycles) {
    lines.push(
      `  ${c.path.join(' → ')} · oldest request ${c.oldest.slice(0, 16)}`,
    );
  }
  lines.push(
    '',
    'Neither side can finish until one of them answers. Each request expires on its own ' +
      'deadline, so this resolves itself — but if it keeps re-forming, the two agents are ' +
      'asking each other for something neither can produce.',
  );
  return lines.join('\n');
}
