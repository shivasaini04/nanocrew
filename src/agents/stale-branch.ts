/**
 * Stale-branch detection utility.
 *
 * Ported from claw-code-main/rust/crates/runtime/src/stale_branch.rs.
 *
 * Agents that work with code repositories accumulate divergence from the base
 * branch over time. Detecting this early prevents shipping work that conflicts
 * or lands on a broken base.
 *
 * Usage:
 *   const freshness = checkBranchFreshness('/path/to/workspace');
 *   if (!freshness.fresh) {
 *     bus.emit_event({ type: 'BranchStaleAgainstMain', ... behindBy: freshness.behindBy });
 *   }
 */

import { execSync } from 'child_process';

export interface BranchFreshness {
  /** True when the current branch has 0 commits behind the base. */
  fresh: boolean;
  /** How many commits this branch is ahead of the base. */
  aheadBy: number;
  /** How many commits this branch is behind the base (0 = fresh). */
  behindBy: number;
}

/**
 * Run `git rev-list --left-right --count <base>...HEAD` in the workspace
 * directory and parse the result.
 *
 * Returns `{ fresh: true, aheadBy: 0, behindBy: 0 }` if the workspace is not
 * a git repository or if the remote is not reachable — we prefer false-fresh
 * over blocking agents when git isn't relevant to their work.
 *
 * @param workspacePath  Absolute path to the git working tree.
 * @param base           The ref to compare against. Defaults to 'origin/main'.
 *                       Falls back to 'origin/master' automatically on error.
 */
export function checkBranchFreshness(
  workspacePath: string,
  base = 'origin/main',
): BranchFreshness {
  const SAFE: BranchFreshness = { fresh: true, aheadBy: 0, behindBy: 0 };

  const run = (ref: string): BranchFreshness | null => {
    try {
      const out = execSync(`git rev-list --left-right --count ${ref}...HEAD`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const parts = out.split(/\s+/);
      if (parts.length !== 2) return null;

      const behindBy = parseInt(parts[0], 10) || 0;
      const aheadBy = parseInt(parts[1], 10) || 0;
      return { fresh: behindBy === 0, aheadBy, behindBy };
    } catch {
      return null;
    }
  };

  // Try the configured base, then fall back to origin/master
  return run(base) ?? run('origin/master') ?? SAFE;
}
