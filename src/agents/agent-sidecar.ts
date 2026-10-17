/**
 * Agent Sidecar — per-agent Docker container that runs Python tools with
 * declared system dependencies (pip packages, apt packages).
 *
 * Lifecycle:
 *   ensure()   → start container if not running, wait for SIDECAR_READY signal
 *   call()     → send JSON-RPC request, receive result (blocking per call)
 *   stop()     → close stdin, container exits cleanly (warm timeout)
 *   teardown() → stop + remove cache volume (agent deleted)
 *
 * IPC: one JSON object per line over stdin/stdout.
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { searchAgentMemory, createAgentCheckin } from '../db.js';
import type { AgentEnv } from './tool-generator.js';
import type { Server as SocketIOServer } from 'socket.io';

let _io: SocketIOServer | null = null;
export function setSidecarSocketIO(io: SocketIOServer): void {
  _io = io;
}

const execAsync = promisify(exec);

// How long to keep a warm sidecar alive with no tool calls before stopping it
const WARM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * DooD (Docker-out-of-Docker) path translation.
 * When the orchestrator runs inside Docker on a Windows host, bind-mount paths
 * must be translated from the container path (/app/...) to the Windows host
 * path (HOST_PROJECT_ROOT/...) so the Docker daemon can resolve them.
 */
function translatePath(containerPath: string): string {
  const hostRoot = process.env.HOST_PROJECT_ROOT;
  if (hostRoot && containerPath.startsWith(process.cwd())) {
    const rel = containerPath
      .slice(process.cwd().length)
      .replace(/^[\/\\]/, '');
    return `${hostRoot}/${rel}`.replace(/\\/g, '/');
  }
  return containerPath;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type SidecarState =
  | 'stopped'
  | 'starting'
  | 'installing'
  | 'ready'
  | 'failed';

export interface SidecarStatus {
  state: SidecarState;
  log: string[];
  failedReason?: string;
}

export interface SidecarCallResult {
  status: 'ok' | 'error';
  result?: string;
  error?: string;
}

interface PendingCall {
  resolve: (r: SidecarCallResult) => void;
  progressCb?: (msg: string, pct?: number) => void;
}

// ─── AgentSidecar ─────────────────────────────────────────────────────────────

export class AgentSidecar {
  private readonly agentId: string;
  private readonly agentDir: string;

  private proc: ChildProcess | null = null;
  private state: SidecarState = 'stopped';
  private failedReason: string | null = null;
  private installLog: string[] = [];
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private installTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending tool calls waiting for a response line
  private pending = new Map<string, PendingCall>();

  // Promises waiting for the container to reach 'ready' or 'failed'
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];

  // Stdout line buffer
  private stdoutBuf = '';

  // Phase 3a — Host RPC: anti-runaway budget for tool→host calls (sidecar lifetime).
  private hostCallCount = 0;
  // callId → tool name for in-flight calls, so a host_call can be attributed to the
  // tool that made it and checked against that tool's declared capabilities.
  private callTools = new Map<string, string>();
  // callId → declared capabilities for a `__verify__` call. A candidate tool isn't persisted
  // yet (no manifest on disk), so the gate can't read its capabilities the normal way — the
  // verify payload carries them and we authorize host calls during verification against these.
  private verifyCapabilities = new Map<string, string[]>();

  // Avengers fix: set when apt packages were actually installed this session (the runner only
  // emits an apt 'installing' event when something is missing). If so, we bake those system
  // libs into the per-agent snapshot image (via a builder container) for the next start.
  private aptInstalledThisSession = false;
  private snapshotInProgress = false;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.agentDir = path.join(DATA_DIR, 'agents', agentId);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  getStatus(): SidecarStatus {
    return {
      state: this.state,
      log: [...this.installLog],
      ...(this.failedReason ? { failedReason: this.failedReason } : {}),
    };
  }

  private _emitStatus(): void {
    _io?.emit('agent:sidecar_status', {
      agentId: this.agentId,
      ...this.getStatus(),
    });
  }

  /** Reset a failed sidecar back to stopped so it can be retried. */
  reset(): void {
    if (this.state === 'failed') {
      if (this.installTimer) {
        clearTimeout(this.installTimer);
        this.installTimer = null;
      }
      this.state = 'stopped';
      this.failedReason = null;
      this.installLog = [];
    }
  }

  /** Ensure the sidecar is running and ready. Waits for install to complete. */
  async ensure(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'failed')
      throw new Error(`Sidecar failed: ${this.failedReason}`);
    if (this.state === 'starting' || this.state === 'installing') {
      return new Promise<void>((resolve, reject) => {
        this.readyWaiters.push({ resolve, reject });
      });
    }
    // state === 'stopped' → start it
    return this.start();
  }

  /** Call a tool by name. Returns the tool's JSON string result. */
  async call(
    toolName: string,
    args: Record<string, unknown>,
    progressCb?: (msg: string, pct?: number) => void,
  ): Promise<SidecarCallResult> {
    await this.ensure();
    this.resetWarmTimer();

    const callId = randomUUID();
    // For a verify call, remember the candidate's declared capabilities so host calls it
    // makes DURING verification are authorized against them (it has no manifest on disk yet).
    if (
      toolName === '__verify__' &&
      Array.isArray((args as any).capabilities)
    ) {
      this.verifyCapabilities.set(
        callId,
        ((args as any).capabilities as unknown[]).map(String),
      );
    }
    return new Promise<SidecarCallResult>((resolve) => {
      this.pending.set(callId, { resolve, progressCb });
      this.callTools.set(callId, toolName);
      const line = JSON.stringify({ id: callId, tool: toolName, args }) + '\n';
      this.proc!.stdin!.write(line);
    });
  }

  /** Stop the sidecar (container exits; volumes kept for next start). */
  stop(): void {
    this.clearWarmTimer();
    if (this.proc) {
      this.proc.stdin!.end();
      this.proc = null;
    }
    if (this.state !== 'failed') {
      this.state = 'stopped';
      this._emitStatus();
    }
    // Reject any pending calls that won't get a response
    for (const [id, { resolve }] of this.pending) {
      resolve({ status: 'error', error: 'Sidecar stopped' });
      this.pending.delete(id);
    }
  }

  /** Stop and remove cache volumes. Call when agent is deleted. */
  async teardown(): Promise<void> {
    this.stop();
    const containerName = `NanoCrew-sidecar-${this.agentId}`;
    const vol = `NanoCrew-sidecar-cache-${this.agentId}`;
    // Force-remove the container first so the volume is no longer in use
    try {
      await execAsync(`docker rm -f ${containerName}`);
    } catch {
      /* may not exist */
    }
    try {
      await execAsync(`docker volume rm ${vol}`);
      logger.debug({ agentId: this.agentId }, 'Removed sidecar cache volume');
    } catch {
      // Volume may not exist if sidecar never started — fine
    }
    // Remove the per-agent snapshot image too (deps baked in), if any.
    try {
      await execAsync(`docker rmi -f ${this.snapshotImage()}`);
    } catch {
      /* may not exist */
    }
  }

  // ─── Private: container lifecycle ─────────────────────────────────────────

  private async start(): Promise<void> {
    this.state = 'starting';
    this.installLog = [];
    this.failedReason = null;

    // Copy the sidecar runner script into the agent dir so it's accessible
    // inside the container via the workspace mount.
    const runnerSrc = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'sidecar_runner.py',
    );
    const runnerDest = path.join(this.agentDir, 'sidecar_runner.py');
    // Normalize Windows path from file URL
    const normalizedSrc = runnerSrc.replace(/^\/([A-Za-z]):/, '$1:');
    if (fs.existsSync(normalizedSrc)) {
      fs.copyFileSync(normalizedSrc, runnerDest);
    } else {
      // Fallback: look relative to cwd
      const cwdSrc = path.join(
        process.cwd(),
        'src',
        'agents',
        'sidecar_runner.py',
      );
      if (fs.existsSync(cwdSrc)) fs.copyFileSync(cwdSrc, runnerDest);
    }

    // Ensure output dir exists (tools write to /workspace/group/output/ inside the
    // container, which maps to agentDir/output/ since agentDir is mounted at
    // /workspace/group — the same path the main agent container uses, see below)
    fs.mkdirSync(path.join(this.agentDir, 'output'), { recursive: true });

    const envPath = path.join(this.agentDir, 'agent-env.json');
    const env: AgentEnv = fs.existsSync(envPath)
      ? JSON.parse(fs.readFileSync(envPath, 'utf-8'))
      : {
          baseImage: 'python:3.12-slim',
          pythonPackages: [],
          aptPackages: [],
          createdAt: '',
          toolSources: {},
        };

    const containerName = `NanoCrew-sidecar-${this.agentId}`;
    const cacheVolume = `NanoCrew-sidecar-cache-${this.agentId}`;
    let baseImage = env.baseImage || 'python:3.12-slim';

    // Avengers fix: if we've snapshotted this agent's sidecar (apt deps baked in), boot
    // from that image so heavy SYSTEM libs aren't reinstalled every start. pip already
    // persists on the cache volume; apt installs into the --rm FS, so the snapshot is
    // what makes on-demand heavy (apt) tools stay fast after the first install.
    this.aptInstalledThisSession = false;
    const snap = this.snapshotImage();
    try {
      await execAsync(`docker image inspect ${snap}`);
      baseImage = snap;
      logger.info(
        { agentId: this.agentId, snap },
        'Sidecar booting from snapshot image (deps baked)',
      );
    } catch {
      /* no snapshot yet — boot from base and build one after install */
    }

    // Remove any leftover container with the same name before starting
    try {
      await execAsync(`docker rm -f ${containerName}`);
    } catch {
      /* not running */
    }

    // Forward LLM provider keys so sidecar tools can call AI APIs
    const envKeyNames = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'MOONSHOT_KIMI_API_KEY',
      'GROQ_API_KEY',
      'GEMINI_API_KEY',
      'REPLICATE_API_KEY',
    ];
    const envKeyArgs = envKeyNames.flatMap((k) => {
      const v = process.env[k];
      return v ? ['-e', `${k}=${v}`] : [];
    });

    // User-managed secrets (global + agent-scoped). Agent-scoped entries override
    // globals on name collision. Injected by NAME so tools read os.environ[NAME].
    const { secretsManager } = await import('./secrets-manager.js');
    const userSecrets = secretsManager.getAll(this.agentId);
    const userSecretArgs = Object.entries(userSecrets).flatMap(([k, v]) =>
      v ? ['-e', `${k}=${v}`] : [],
    );
    const nUserSecrets = Object.keys(userSecrets).length;
    if (nUserSecrets > 0) {
      logger.debug(
        { agentId: this.agentId, count: nUserSecrets },
        'Injecting user secrets into sidecar',
      );
    }

    const dockerArgs = [
      'run',
      '--rm',
      '-i',
      '--name',
      containerName,
      '--user',
      'root',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '-e',
      `TOOL_DIR=/workspace/group/tools`,
      ...envKeyArgs,
      ...userSecretArgs,
      // Mounted at /workspace/group, matching nanobot-cycle-runner's mount for the main
      // agent container. It used to be plain /workspace, which made the agent root have
      // two different absolute paths depending on which container you were in — and the
      // agent authors its tools while only ever seeing the main container's. On
      // 2026-08-21 a generated tool hardcoded WORKSPACE_ROOT=/workspace/group/workspace
      // (correct there), ran here, and silently wrote its output to agentDir/group/
      // workspace/... — a real file nothing could find, reported as success because the
      // path was self-consistent inside this container. Keeping the two mounts identical
      // removes the seam rather than asking every tool author to remember it.
      '-v',
      `${translatePath(this.agentDir)}:/workspace/group`,
      '-v',
      `${cacheVolume}:/root/.cache`,
      baseImage,
      'python',
      '/workspace/group/sidecar_runner.py',
    ];

    logger.info(
      { agentId: this.agentId, baseImage },
      'Starting sidecar container',
    );
    this.proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString();
      const lines = this.stdoutBuf.split('\n');
      this.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.handleLine(trimmed);
      }
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text)
        logger.debug(
          { agentId: this.agentId, stderr: text.slice(0, 200) },
          'Sidecar stderr',
        );
    });

    this.proc.on('exit', (code) => {
      logger.info({ agentId: this.agentId, code }, 'Sidecar exited');
      const wasReady = this.state === 'ready';
      if (this.state !== 'failed') this.state = 'stopped';
      this.proc = null;
      this.clearWarmTimer();
      // Reject any still-pending calls
      for (const [id, { resolve }] of this.pending) {
        resolve({ status: 'error', error: 'Sidecar exited unexpectedly' });
        this.pending.delete(id);
      }
      // Reject any still-waiting ready promises
      if (!wasReady) {
        const err = new Error(
          this.failedReason ?? 'Sidecar exited before ready',
        );
        for (const w of this.readyWaiters) w.reject(err);
        this.readyWaiters = [];
      }
    });

    // Set a startup timeout — how long to wait for SIDECAR_READY
    const timeoutMs = this.estimateInstallTimeout(env);
    if (this.installTimer) {
      clearTimeout(this.installTimer);
      this.installTimer = null;
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
      this.installTimer = setTimeout(() => {
        this.installTimer = null;
        if (this.state !== 'ready') {
          this.failedReason = `Sidecar install timed out after ${timeoutMs / 60000} minutes`;
          this.state = 'failed';
          this.stop();
          for (const w of this.readyWaiters)
            w.reject(new Error(this.failedReason));
          this.readyWaiters = [];
        }
      }, timeoutMs);
    });
  }

  // ─── Private: line handler ─────────────────────────────────────────────────

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Install progress events
    if (msg.status === 'installing') {
      this.state = 'installing';
      const pkgs = (msg.packages ?? []).join(', ');
      const entry = `[${msg.phase}] ${pkgs}`;
      this.installLog.push(entry);
      // apt installs into the --rm FS (don't persist) → mark for a post-ready snapshot.
      if (msg.phase === 'apt') this.aptInstalledThisSession = true;
      logger.debug(
        { agentId: this.agentId, phase: msg.phase, packages: msg.packages },
        'Sidecar installing',
      );
      this._emitStatus();
      return;
    }

    if (msg.status === 'ready') {
      this.state = 'ready';
      logger.info({ agentId: this.agentId }, 'Sidecar ready');
      this._emitStatus();
      this.resetWarmTimer();
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w.resolve();
      // If apt packages were installed this boot, bake them into a per-agent image so
      // the next start skips the (non-persistent) apt reinstall. Fire-and-forget.
      if (this.aptInstalledThisSession) {
        void this.commitSnapshot();
      }
      return;
    }

    if (msg.status === 'failed') {
      this.failedReason = msg.error ?? `${msg.phase ?? 'install'} failed`;
      this.installLog.push(`FAILED: ${this.failedReason}`);
      this.state = 'failed';
      logger.error(
        { agentId: this.agentId, reason: this.failedReason },
        'Sidecar install failed',
      );
      this._emitStatus();
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters)
        w.reject(new Error(this.failedReason ?? 'install failed'));
      return;
    }

    // Progress event from a running tool call
    if (msg.status === 'progress' && msg.id) {
      const call = this.pending.get(msg.id);
      if (call?.progressCb) call.progressCb(msg.message ?? '', msg.percent);
      return;
    }

    // Host RPC (Phase 3a): a running tool is asking to use one of the agent's powers.
    if (msg.type === 'host_call' && msg.host_id) {
      void this.handleHostCall(msg);
      return;
    }

    // Tool call result
    if (msg.id && (msg.status === 'ok' || msg.status === 'error')) {
      const call = this.pending.get(msg.id);
      if (call) {
        this.pending.delete(msg.id);
        this.callTools.delete(msg.id);
        this.verifyCapabilities.delete(msg.id);
        call.resolve(
          msg.status === 'ok'
            ? { status: 'ok', result: msg.result }
            : { status: 'error', error: msg.error },
        );
      }
    }
  }

  // ─── Private: Host RPC handler (Phase 3a) ─────────────────────────────────
  // Serves a tool's `host_call` and writes back a `host_response`. Each method is
  // fulfilled HERE (orchestrator-side) — never by calling back into the busy sidecar
  // or the blocked agent cycle — which is why the read-only methods can't deadlock.
  private async handleHostCall(msg: any): Promise<void> {
    const respond = (ok: boolean, result?: unknown, error?: string) => {
      try {
        this.proc?.stdin?.write(
          JSON.stringify({
            type: 'host_response',
            host_id: msg.host_id,
            ok,
            result,
            error,
          }) + '\n',
        );
      } catch {
        /* sidecar may have exited */
      }
    };

    // Anti-runaway budget across the sidecar's lifetime.
    if (++this.hostCallCount > 500) {
      respond(false, undefined, 'host-call budget exceeded');
      return;
    }

    try {
      const method = String(msg.method ?? '');
      const args = (msg.args ?? {}) as Record<string, any>;

      // Capability gate: the calling tool must have DECLARED this host method in
      // its capabilities. Undeclared → denied (the broker is the boundary). For a
      // verification run the candidate has no manifest yet, so authorize against the
      // capabilities carried in the verify payload (so host works DURING verify too).
      const callId = String(msg.call_id ?? '');
      const toolName = this.callTools.get(callId);
      const caps =
        toolName === '__verify__'
          ? (this.verifyCapabilities.get(callId) ?? [])
          : this.toolCapabilities(toolName);
      if (!caps.includes(method)) {
        const who =
          toolName === '__verify__'
            ? 'the tool under verification'
            : `tool '${toolName ?? '?'}'`;
        respond(
          false,
          undefined,
          `Not authorized: ${who} did not declare capability '${method}'. ` +
            `Add "${method}" to the tool's capabilities to use host.${method}().`,
        );
        return;
      }

      if (method === 'search_memory') {
        const rows = searchAgentMemory(
          this.agentId,
          String(args.query ?? ''),
          Math.min(Number(args.limit) || 20, 50),
        );
        const out = rows.map((r) => ({
          type: r.type,
          content: r.content,
          relevance: r.relevance,
        }));
        logger.info(
          { agentId: this.agentId, method, results: out.length },
          'host_call served',
        );
        respond(true, out);
      } else if (method === 'send_message') {
        // External side-effect → never fire directly. Queue an operator approval
        // (HITL check-in); the message is sent only when the operator approves.
        const text = String(args.text ?? '').trim();
        if (!text) {
          respond(false, undefined, 'send_message requires non-empty text');
          return;
        }
        createAgentCheckin({
          agent_id: this.agentId,
          status: 'pending',
          report_md: text,
          action_type: 'send_message',
          action_payload: JSON.stringify({ text, agentId: this.agentId }),
        });
        logger.info(
          { agentId: this.agentId, method },
          'host_call queued for approval',
        );
        respond(
          true,
          'Queued for operator approval — the message sends once approved.',
        );
      } else if (method === 'handoff') {
        // High-privilege agent-coordination → queue an operator approval (HITL); the
        // handoff is delivered only when approved (_fireCheckinAction).
        const toAgent = String(args.to_agent ?? '').trim();
        const type = String(args.type ?? '').trim();
        if (!toAgent || !type) {
          respond(
            false,
            undefined,
            'handoff requires non-empty to_agent and type',
          );
          return;
        }
        const payload =
          args.payload && typeof args.payload === 'object' ? args.payload : {};
        const note = String(args.note ?? '').trim();
        createAgentCheckin({
          agent_id: this.agentId,
          status: 'pending',
          report_md: `Hand off **${type}** to \`${toAgent}\`${note ? `\n\n${note}` : ''}`,
          action_type: 'handoff',
          action_payload: JSON.stringify({
            fromAgentId: this.agentId,
            toAgent,
            type,
            payload,
            note,
          }),
        });
        logger.info(
          { agentId: this.agentId, method, toAgent, type },
          'host_call queued for approval (handoff)',
        );
        respond(
          true,
          'Queued for operator approval — the handoff delivers once approved.',
        );
      } else if (method === 'call_tool') {
        // Authorize-only: the gate above already checked the caller declared "call_tool".
        // We block meta-tools and audit; the sidecar runs the target LOCALLY (so a
        // running tool calling another can't deadlock the single-threaded run-loop).
        const target = String(args.name ?? '').trim();
        const META = new Set([
          'generate_tool',
          'update_tool',
          'rollback_tool',
          'remove_tool',
          'register_tool_from_dir',
          'create_pipeline',
          'run_pipeline',
        ]);
        if (!target) {
          respond(false, undefined, 'call_tool requires a target tool name');
          return;
        }
        if (META.has(target)) {
          respond(
            false,
            undefined,
            `call_tool may not invoke the meta-tool '${target}'`,
          );
          return;
        }
        logger.info(
          { agentId: this.agentId, method, target },
          'host_call authorized (call_tool)',
        );
        respond(true, { authorized: true });
      } else {
        respond(false, undefined, `Unknown host method: '${method}'`);
      }
    } catch (e: any) {
      logger.warn(
        { agentId: this.agentId, err: e?.message },
        'host_call failed',
      );
      respond(false, undefined, e?.message ?? 'host call error');
    }
  }

  /** Declared host capabilities for a tool, read from its manifest (factory format).
   *  Orchestrator flat tools (no manifest.yaml) have none — so they're denied host calls. */
  private toolCapabilities(toolName?: string): string[] {
    if (!toolName) return [];
    try {
      const mp = path.join(
        DATA_DIR,
        'agents',
        this.agentId,
        'tools',
        toolName,
        'manifest.yaml',
      );
      if (!fs.existsSync(mp)) return [];
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
      return Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
    } catch {
      return [];
    }
  }

  // ─── Private: timers & utilities ──────────────────────────────────────────

  private resetWarmTimer(): void {
    this.clearWarmTimer();
    this.warmTimer = setTimeout(() => {
      logger.info({ agentId: this.agentId }, 'Sidecar warm timeout — stopping');
      this.stop();
    }, WARM_TIMEOUT_MS);
  }

  private clearWarmTimer(): void {
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
  }

  /** Collect deps the AGENT declared in its sidecar-tier tool manifests (split pip vs apt).
   *  These merge into the startup install via the runner's _collect_manifest_deps, so the
   *  install-timeout estimate must see them too — otherwise an agent-built heavy tool gets
   *  the short default budget and the sidecar times out (the bug test #4 exposed). */
  private collectManifestDeps(): { pip: string[]; apt: string[] } {
    const pip: string[] = [];
    const apt: string[] = [];
    try {
      const toolsDir = path.join(this.agentDir, 'tools');
      if (!fs.existsSync(toolsDir)) return { pip, apt };
      for (const name of fs.readdirSync(toolsDir)) {
        const mp = path.join(toolsDir, name, 'manifest.yaml');
        if (!fs.existsSync(mp)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
          if (String(m.tier) !== 'sidecar') continue;
          for (const d of m.dependencies ?? []) {
            const s = String(d);
            if (s.startsWith('apt:')) apt.push(s.slice(4));
            else pip.push(s);
          }
        } catch {
          /* skip unreadable manifest */
        }
      }
    } catch {
      /* skip */
    }
    return { pip, apt };
  }

  /** Per-agent snapshot image name (deps baked in).
   *
   *  Lowercase is mandatory: Docker rejects an image reference whose repository name has
   *  capitals ("repository name must be lowercase"), unlike container names, which allow
   *  them. The nanoclaw→nanocrew rename (abbea02, 2026-06-20) capitalised this one and the
   *  bake has failed on every start since — silently, because the failure is caught and
   *  logged as "will reinstall next start", which reads like a cache miss rather than a
   *  permanent break. The cost only became visible on 2026-08-22, when a sidecar tool with
   *  six apt dependencies (WeasyPrint) reinstalled them from scratch on every single call
   *  and eventually exceeded the 30-minute install timeout. */
  private snapshotImage(): string {
    return `nanocrew-sidecar-img-${this.agentId}:latest`;
  }

  /** Avengers fix: bake the agent's apt (system) deps into a per-agent image so they
   *  persist across the --rm sidecar's restarts (installed once, not every boot). pip
   *  lives on the cache volume already, so only apt needs baking.
   *
   *  We build the image with a real Dockerfile via `docker build` (buildkit). `docker commit`
   *  was tried and rejected: under Docker Desktop's containerd snapshotter, commit-created
   *  images carry an overlay layer the daemon can't lstat when computing usage, which breaks
   *  `docker ps --size` (the orchestrator's container monitoring). `docker build` produces
   *  clean content-addressed layers and avoids that. Runs async; the live sidecar already has
   *  the deps from its own install, so this only prepares the image for the NEXT boot. */
  private async commitSnapshot(): Promise<void> {
    if (this.snapshotInProgress) return;
    this.snapshotInProgress = true;
    const img = this.snapshotImage();
    const buildDir = path.join(this.agentDir, '.snapshot-build');
    try {
      // Collect the apt deps to bake (agent-env.json + tool manifests).
      const md = this.collectManifestDeps();
      let envApt: string[] = [];
      let base = 'python:3.12-slim';
      try {
        const e = JSON.parse(
          fs.readFileSync(path.join(this.agentDir, 'agent-env.json'), 'utf-8'),
        );
        envApt = (e.aptPackages ?? []).filter(Boolean);
        base = e.baseImage || base;
      } catch {
        /* no env */
      }
      const apt = Array.from(new Set([...envApt, ...md.apt])).filter((p) =>
        /^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/.test(p),
      ); // safe pkg names only
      if (apt.length === 0) return;

      // Always build FROM the base image (not FROM the existing snapshot). The apt list is
      // always the complete set, so FROM-base produces the same content as FROM-snapshot but
      // in a single layer — no layer accumulation across re-bakes. Docker's layer cache
      // makes this a cache-hit (instant) when the package list hasn't changed.
      const dockerfile =
        `FROM ${base}\n` +
        `LABEL NanoCrew.snapshot=true NanoCrew.agent_id=${this.agentId}\n` +
        `RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ` +
        `${apt.join(' ')} && apt-get clean && rm -rf /var/lib/apt/lists/*\n`;
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);

      // Context is read by the docker CLI in THIS (orchestrator) container and streamed to
      // the daemon, so the orchestrator-local path is correct (no DooD path translation).
      await execAsync(`docker build -t ${img} ${buildDir}`, {
        timeout: 30 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });
      logger.info(
        { agentId: this.agentId, img, apt },
        'Baked sidecar snapshot (apt deps) via docker build',
      );

      // Prune dangling snapshot images left over from the previous bake (the old :latest
      // loses its tag when the new image takes it). Scoped to our label so nothing else
      // on the host is touched.
      try {
        await execAsync(
          `docker image prune -f --filter label=NanoCrew.snapshot=true`,
        );
      } catch {
        /* non-fatal — stale layers just sit there until the next prune */
      }
    } catch (e: any) {
      logger.warn(
        { agentId: this.agentId, err: e?.message },
        'Snapshot bake failed (will reinstall next start)',
      );
    } finally {
      try {
        fs.rmSync(buildDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.snapshotInProgress = false;
    }
  }

  private estimateInstallTimeout(env: AgentEnv): number {
    // Budget across BOTH agent-env.json AND the agent's tool manifests — a heavy dep the
    // agent declared in a tool it built (e.g. manim) is just as slow to install as a
    // pre-provisioned one, and was previously invisible here → false 15-min timeouts.
    const md = this.collectManifestDeps();
    const pip = [...env.pythonPackages, ...md.pip];
    const apt = [...env.aptPackages, ...md.apt];
    const HEAVY_PIP =
      /^(torch|tensorflow|jax|manim|transformers|paddlepaddle|mxnet|detectron2)\b/i;
    const HEAVY_APT =
      /(blender|texlive|build-essential|libcairo|libpango|libgl1|ffmpeg|cmake)/i;
    const heavy =
      pip.some((p) => HEAVY_PIP.test(p)) ||
      apt.some((p) => HEAVY_APT.test(p)) ||
      apt.length >= 4; // many system pkgs → assume a long build
    const isCustomBase =
      !env.baseImage.startsWith('python:') &&
      !env.baseImage.startsWith('node:');
    if (heavy || isCustomBase) return 30 * 60 * 1000;
    return 15 * 60 * 1000;
  }
}

// ─── SidecarRegistry ─────────────────────────────────────────────────────────

class SidecarRegistry {
  private sidecars = new Map<string, AgentSidecar>();

  get(agentId: string): AgentSidecar {
    if (!this.sidecars.has(agentId)) {
      this.sidecars.set(agentId, new AgentSidecar(agentId));
    }
    return this.sidecars.get(agentId)!;
  }

  async teardown(agentId: string): Promise<void> {
    const sidecar = this.sidecars.get(agentId);
    if (sidecar) {
      await sidecar.teardown();
      this.sidecars.delete(agentId);
    }
  }

  stopAll(): void {
    for (const sidecar of this.sidecars.values()) sidecar.stop();
  }
}

export const sidecarRegistry = new SidecarRegistry();
