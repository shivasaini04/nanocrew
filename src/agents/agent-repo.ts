/**
 * agent-repo — attach a git repository to an agent.
 *
 * Devin mode, piece 3 of 4 (spec item D). An agent that manages a codebase needs three
 * things that did not exist together anywhere: the repo on disk at a path the cycle runner
 * will mount, a token it can push with, and a written brief telling it what the project is
 * and what the rules are.
 *
 * `config.repoPath` and the `/workspace/repo` mount already existed — nothing could reach
 * them. This is the reachable path.
 *
 * Three things worth knowing before changing this file:
 *
 * 1. **The token never ends up in the clone.** Cloning from
 *    `https://<token>@github.com/...` is the obvious move and it writes the token straight
 *    into `.git/config` as the remote URL, where it survives forever and can be committed.
 *    We clone the tokenless URL and supply credentials through a throwaway `GIT_ASKPASS`
 *    helper, exactly as `git_tool.py` does for push. Same reasoning, same shape.
 *
 * 2. **Every path is confined under REPOS_DIR.** The repo name comes from a URL the caller
 *    supplied, so it is validated against a strict pattern AND the resolved destination is
 *    re-checked to be inside REPOS_DIR. Neither check alone is enough: the pattern could be
 *    loosened later, and a symlink could defeat the pattern.
 *
 * 3. **git is invoked with an argument array, never a shell string.** A repo URL is
 *    caller-controlled input; `spawn` with args cannot be turned into command injection.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

export const REPOS_DIR = path.join(DATA_DIR, 'repos');

// HTTPS GitHub only, for now. SSH would need key management, and other hosts need their own
// auth story — better to refuse clearly than half-support them.
const REPO_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(?:\.git)?$/;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export interface AttachRepoInput {
  agentId: string;
  url: string;
  token?: string;
  branch?: string;
  buildCommand?: string;
  deployUrl?: string;
  stack?: string;
}

export interface AttachRepoResult {
  repoPath: string;
  repo: string;
  branch: string;
  buildCommand: string | null;
  stack: string | null;
  claudeMdPath: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let out = '';
    const cap = (b: Buffer) => {
      out += b.toString();
    };
    p.stdout.on('data', cap);
    p.stderr.on('data', cap);
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, CLONE_TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(e) });
    });
  });
}

/** A one-shot GIT_ASKPASS helper, so the token never reaches the repo on disk. */
function withAskpass<T>(
  token: string | undefined,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (!token) return fn(process.env);
  const file = path.join(
    os.tmpdir(),
    `gitaskpass-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  );
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) echo 'x-access-token' ;;\n  *) echo '${token}' ;;\nesac\n`,
    { mode: 0o700 },
  );
  const env = { ...process.env, GIT_ASKPASS: file, GIT_TERMINAL_PROMPT: '0' };
  return fn(env).finally(() => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  });
}

function detectProject(repoPath: string): {
  stack: string | null;
  buildCommand: string | null;
} {
  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return { stack: null, buildCommand: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const stack = deps.next
      ? 'Next.js'
      : deps.nuxt
        ? 'Nuxt'
        : deps['@remix-run/react']
          ? 'Remix'
          : deps.astro
            ? 'Astro'
            : deps.vite
              ? 'Vite'
              : deps.react
                ? 'React'
                : deps.express
                  ? 'Express'
                  : 'Node';
    return { stack, buildCommand: pkg.scripts?.build ? 'npm run build' : null };
  } catch {
    return { stack: 'Node', buildCommand: 'npm run build' };
  }
}

function claudeMd(
  i: AttachRepoInput,
  d: {
    stack: string | null;
    buildCommand: string | null;
    branch: string;
    repo: string;
  },
): string {
  return `# ${d.repo}

Brief for the agent managing this repository. Written by NanoCrew when the repo was
attached; edit it as the project changes.

## What this is

- **Stack:** ${i.stack ?? d.stack ?? 'unknown — inspect the repo and update this line'}
- **Repository:** ${i.url}
- **Default branch:** ${d.branch}
- **Deployed at:** ${i.deployUrl ?? '(not set — deploys cannot be verified until this is filled in)'}

## Build

\`\`\`bash
${d.buildCommand ?? '(no build command detected)'}
\`\`\`

You do not have to remember to run this. Committing runs it for you and **refuses the
commit if it fails** — there is no flag to skip that. If the build fails, the refusal
carries the output; fix the cause and commit again.

If it fails complaining about missing modules rather than about your change, dependencies
are not installed — install them first.

## Rules

1. **Never commit to \`${d.branch}\`.** Push is refused for it. Create a branch, push that,
   and report the branch name so a human can review and merge.
2. **Never force-push.** It is not available, and asking for it is refused.
3. **Never commit secrets.** \`.env\` files, keys and tokens are refused at commit time.
   If you need a value that lives in one, say so in your report — do not inline it.
4. **You cannot see rendered output.** For anything visual, describe what you changed and
   let a human confirm it looks right. Do not claim a page "looks correct".
5. **If a tool refuses you, read the refusal.** It says why and what to do instead. Do not
   work around it; the refusals are the safety design, not obstacles.

## Where things are

The repo is mounted at \`/workspace/repo\` inside your container. Your own workspace is
separate, at \`/workspace/group\` — scratch files and notes belong there, not in the repo.
`;
}

export async function attachRepo(
  input: AttachRepoInput,
): Promise<AttachRepoResult> {
  const url = String(input.url ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!REPO_URL_RE.test(url)) {
    throw new Error(
      'url must be an https github.com repository URL, e.g. https://github.com/owner/repo',
    );
  }

  const repo = (url.split('/').pop() ?? '').replace(/\.git$/, '');
  if (!repo || !SAFE_NAME_RE.test(repo))
    throw new Error('could not derive a safe repository name from the url');
  if (!SAFE_NAME_RE.test(input.agentId)) throw new Error('invalid agent id');

  const agentDir = path.join(REPOS_DIR, input.agentId);
  const dest = path.resolve(path.join(agentDir, repo));
  // Belt and braces: the pattern above should make this impossible, but a resolved path
  // outside REPOS_DIR must never be written to regardless of how it got there.
  if (!dest.startsWith(path.resolve(REPOS_DIR) + path.sep))
    throw new Error('refusing to clone outside the repos directory');
  if (fs.existsSync(dest)) {
    throw new Error(
      `${dest} already exists — detach the repo first, or remove it by hand if you are sure`,
    );
  }

  fs.mkdirSync(agentDir, { recursive: true });

  // `-c credential.helper=` disables any inherited helper, exactly as git_tool.py does.
  // Without it the clone can silently succeed on a cached system credential instead of the
  // token supplied here — which both hides a bad token until push time and means the repo
  // may have been fetched as somebody else entirely. Caught by a test asserting that an
  // invalid token FAILS; it passed until this flag was added.
  const cloned = await withAskpass(input.token, (env) =>
    run(
      'git',
      ['-c', 'credential.helper=', 'clone', '--no-single-branch', url, dest],
      { env },
    ),
  );
  if (cloned.code !== 0) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* nothing to clean */
    }
    // Never echo the token back, even if git embedded it in an error.
    const safe = input.token
      ? cloned.out.split(input.token).join('***')
      : cloned.out;
    throw new Error(`git clone failed: ${safe.trim().slice(-600)}`);
  }

  if (input.branch) {
    const co = await run('git', ['checkout', input.branch], { cwd: dest });
    if (co.code !== 0)
      logger.warn(
        { branch: input.branch },
        '[agent-repo] requested branch not found; staying on default',
      );
  }
  const headOut = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dest,
  });
  const branch = headOut.out.trim() || 'main';

  const detected = detectProject(dest);
  const buildCommand = input.buildCommand ?? detected.buildCommand;
  const claudeMdPath = path.join(dest, 'CLAUDE.md');
  // Written only when absent: a repo that already briefs its agents knows better than we do.
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      claudeMd(input, { ...detected, buildCommand, branch, repo }),
      'utf-8',
    );
  }

  logger.info(
    { agentId: input.agentId, repo, branch },
    '[agent-repo] attached',
  );
  return {
    repoPath: dest,
    repo,
    branch,
    buildCommand,
    stack: input.stack ?? detected.stack,
    claudeMdPath,
  };
}

export function detachRepo(agentId: string, repoPath: string): void {
  const resolved = path.resolve(repoPath);
  if (!resolved.startsWith(path.resolve(REPOS_DIR) + path.sep)) {
    throw new Error('refusing to delete a path outside the repos directory');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  logger.info({ agentId, repoPath: resolved }, '[agent-repo] detached');
}
