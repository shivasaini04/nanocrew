/**
 * Container Runner for NanoCrew
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  PROJECTS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
  DEFAULT_MEMORY_LIMIT_MAIN,
  DEFAULT_MEMORY_LIMIT_WORKER,
  DEFAULT_CPU_LIMIT_MAIN,
  DEFAULT_CPU_LIMIT_WORKER,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  tryAcquireSpawnSlot,
  waitForSpawnSlot,
  releaseSpawnSlotAfterSettle,
} from './container-spawn-limiter.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup, ContainerConfig } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NanoCrew_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NanoCrew_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  systemTimeoutOverride?: number;
  model?: string;
  projectId?: string;
  projectName?: string;
  nanobotRole?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
          permissions: {
            allow: [
              'Bash(npm install*)',
              'Bash(npm ci*)',
              'Bash(npm run *)',
              'Bash(npm run build*)',
              'Bash(npm run dev*)',
              'Bash(npx *)',
              'Bash(node *)',
              'Bash(python *)',
              'Bash(python3 *)',
              'Bash(pip install*)',
              'Bash(pip3 install*)',
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ and container/synthesized_skills/ into each group's .claude/skills/
  const staticSkillsSrc = path.join(process.cwd(), 'container', 'skills');
  const synthSkillsSrc = path.join(DATA_DIR, 'synthesized_skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');

  const syncSkills = (srcDir: string) => {
    if (fs.existsSync(srcDir)) {
      for (const skillDir of fs.readdirSync(srcDir)) {
        const fullSrcDir = path.join(srcDir, skillDir);
        if (!fs.statSync(fullSrcDir).isDirectory()) continue;
        const fullDstDir = path.join(skillsDst, skillDir);
        fs.cpSync(fullSrcDir, fullDstDir, { recursive: true });
      }
    }
  };

  syncSkills(staticSkillsSrc);
  syncSkills(synthSkillsSrc);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy or mount nanoagent source.
  // Main agent needs a writable per-group location so it can customize tools/behavior.
  // Worker agents (!isMain) do not customize tools, so they can directly mount
  // the host's nanoagent source directory read-only, avoiding heavy copies.
  const agentRunnerSrc = path.join(projectRoot, '..', 'nanoagent');
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'nanoagent-src',
  );

  if (isMain) {
    if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
        recursive: true,
        filter: (src) => {
          const relative = path.relative(agentRunnerSrc, src);
          if (!relative) return true;
          const parts = relative.split(path.sep);
          const excludeDirs = [
            'node_modules',
            '.git',
            '.venv',
            '.pytest_cache',
            'dist',
          ];
          return !parts.some((part) => excludeDirs.includes(part));
        },
      });
    }
    mounts.push({
      hostPath: groupAgentRunnerDir,
      containerPath: '/app/nanoagent',
      readonly: false,
    });
  } else {
    // DooD: the readonly nanoagent mount must use the HOST path. `agentRunnerSrc` resolves to
    // the orchestrator-internal `/nanoagent`, which doesn't exist on the host, so the
    // sibling container got an empty mount → "can't open nanocrew_adapter.py" → group chat
    // (e.g. dash:default) hung forever. HOST_NANOBOT_DIR is the host path (same fix the agent
    // cycle runner uses); it passes through the /app→host translation untouched.
    mounts.push({
      hostPath: process.env.HOST_NANOBOT_DIR || agentRunnerSrc,
      containerPath: '/app/nanoagent',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Copy IDENTITY.md from global group folder into the group workspace.
  // NanoBot's ContextBuilder looks for bootstrap files (IDENTITY.md, etc.)
  // in the workspace root (/workspace/group/) to build the system prompt.
  // Skip overwrite if the group already has a project-specific IDENTITY.md
  // (written at project creation time with the correct workspace path).
  const identitySource = path.join(GROUPS_DIR, 'global', 'IDENTITY.md');
  if (fs.existsSync(identitySource)) {
    const groupIdentity = path.join(groupDir, 'IDENTITY.md');
    const hasProjectIdentity = fs.existsSync(
      path.join(groupDir, '.project-identity'),
    );
    if (!hasProjectIdentity) {
      // Standard group: always sync from the selected identity source so personality changes propagate
      fs.copyFileSync(identitySource, groupIdentity);
    }
    // Project groups: leave their custom IDENTITY.md in place
  }

  return mounts;
}

function buildProjectMounts(projectId: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const workspaceDir = path.join(projectDir, 'workspace');
  const contextDir = path.join(projectDir, 'context');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  mounts.push({
    hostPath: workspaceDir,
    containerPath: '/workspace/shared',
    readonly: false,
  });
  mounts.push({
    hostPath: contextDir,
    containerPath: '/workspace/context',
    readonly: true,
  });
  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'MOONSHOT_KIMI_API_KEY',
    'REPLICATE_API_KEY',
    'BRAVE_API_KEY',
    // Optional. web_search/web_fetch reach Firecrawl without a key, but keyless access is
    // capped per IP per day and every agent container egresses through this one host, so
    // they all share that budget. A key moves us onto our own.
    'FIRECRAWL_API_KEY',
    // TinyFish leads web_search and powers batched web_fetch. Search and Fetch are free
    // at any wallet balance, but unlike Firecrawl there is no keyless mode — without this
    // the agent silently drops to DuckDuckGo and one-URL-at-a-time fetching.
    'TINYFISH_API_KEY',
    'NANOBOT_MODEL',
    // Lead-source rotation weights, read by container/.../tools/source_rotation.py.
    // This list is an allowlist, so a knob absent from it is silently inert no matter
    // what prod's .env says — SOURCE_WEIGHTS was documented and read by the tool but
    // never actually passed in, so rotation has always run on its built-in defaults.
    'SOURCE_WEIGHTS',
    // Score thresholds for the lead-source tools. A threshold is only valid for the ICP it
    // was fitted to, so these need to be tunable without an image rebuild when the aim moves.
    'JOBS_MIN_SCORE',
    'REDDIT_MIN_SCORE',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  containerConfig?: ContainerConfig,
  model?: string,
  projectId?: string,
  projectName?: string,
  nanobotRole?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // On Linux Docker (production), host.docker.internal isn't resolvable by default.
  // --add-host wires it to the bridge gateway so Python tools can reach the orchestrator.
  if (process.platform === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  // Apply CPU and Memory resource limits
  const memoryLimit =
    containerConfig?.memoryLimit ||
    (isMain ? DEFAULT_MEMORY_LIMIT_MAIN : DEFAULT_MEMORY_LIMIT_WORKER);
  const cpuLimit =
    containerConfig?.cpuLimit ||
    (isMain ? DEFAULT_CPU_LIMIT_MAIN : DEFAULT_CPU_LIMIT_WORKER);

  if (memoryLimit) {
    args.push('--memory', memoryLimit);
  }
  if (cpuLimit) {
    args.push('--cpus', cpuLimit);
  }

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass API keys directly as environment variables so they're available
  // in the container before any Python code executes.
  const secrets = readSecrets();
  for (const [key, value] of Object.entries(secrets)) {
    if (value) {
      // Override the default model if a specific one was requested
      if (key === 'NANOBOT_MODEL' && model) {
        args.push('-e', `${key}=${model}`);
      } else {
        args.push('-e', `${key}=${value}`);
      }
    }
  }

  // Ensure model is set if it was passed specifically and not found in secrets
  if (model && !secrets.NANOBOT_MODEL) {
    args.push('-e', `NANOBOT_MODEL=${model}`);
  }

  if (nanobotRole) {
    args.push('-e', `NANOBOT_ROLE=${nanobotRole}`);
  }

  if (projectId) {
    args.push('-e', `PROJECT_ID=${projectId}`);
    if (projectName) args.push('-e', `PROJECT_NAME=${projectName}`);
  }

  // Set standard IPC directory for NanoBot tools
  args.push('-e', 'IPC_DIR=/workspace/ipc');

  // Run as host user so bind-mounted files are accessible.
  // In DooD mode (running inside a container as root), force root (0:0)
  // for the agent container to ensure write access to bind-mounts.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();

  const isDooD = process.env.HOST_PROJECT_ROOT != null;
  const isHostRoot = hostUid === 0;

  if (isDooD || (hostUid != null && hostUid !== 0 && hostUid !== 1000)) {
    const runAsUser = isDooD || isHostRoot ? '0:0' : `${hostUid}:${hostGid}`;
    args.push('--user', runAsUser);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    let hostPath = mount.hostPath;

    // DooD (Docker-out-of-Docker) Path Translation
    // When the orchestrator runs in a container, it mounts the host's docker socket.
    // It must provide the physical Host paths to `docker run -v` rather than its own internal container paths.
    if (process.env.HOST_PROJECT_ROOT && hostPath.startsWith(process.cwd())) {
      const relativePath = hostPath
        .slice(process.cwd().length)
        .replace(/^[\\\/]/, '');
      hostPath = `${process.env.HOST_PROJECT_ROOT}/${relativePath}`.replace(
        /\\/g,
        '/',
      );
    }

    if (mount.readonly) {
      args.push(...readonlyMountArgs(hostPath, mount.containerPath));
    } else {
      args.push('-v', `${hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  // Pre-create workspace subdirs on the host so the container's non-root user
  // doesn't hit PermissionError on bind-mounted volumes (Windows/Docker).
  // Agent state dirs at the root (nanobot's SessionManager/ToolPersistence/MemoryStore own these).
  // 'logs' was an unused stub — dropped.
  for (const sub of ['sessions', 'tools', 'memory']) {
    fs.mkdirSync(path.join(groupDir, sub), { recursive: true });
  }

  const mounts = buildVolumeMounts(group, input.isMain);
  if (input.projectId) {
    mounts.push(...buildProjectMounts(input.projectId));
  }
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `NanoCrew-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    input.isMain,
    group.containerConfig,
    input.model,
    input.projectId,
    input.projectName,
    input.nanobotRole,
  );

  // Log container args at INFO level for debugging (mask secret values)
  const maskedArgs = containerArgs.map((a) => {
    if (a.startsWith('gsk_') || a.startsWith('sk-'))
      return a.slice(0, 8) + '...';
    return a;
  });
  logger.info(
    {
      group: group.name,
      containerName,
      containerArgs: maskedArgs.join(' '),
    },
    'Container command',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  if (!tryAcquireSpawnSlot()) await waitForSpawnSlot();
  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    releaseSpawnSlotAfterSettle();

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    const stdoutDecoder = new StringDecoder('utf8');

    container.stdout.on('data', (data) => {
      const chunk = stdoutDecoder.write(data);

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout =
      input.systemTimeoutOverride ||
      group.containerConfig?.timeout ||
      CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.lastIndexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.lastIndexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
