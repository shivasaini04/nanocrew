# Architecture

## Components

| Component | Where | Role |
|---|---|---|
| Orchestrator | `src/` (TypeScript, Express, SQLite) | API, auth, scheduling, agent registry, cycle runner, approvals, cost tracking |
| Dashboard | `dashboard/` (React, Vite) | Web UI: agents, chat, logs, approvals, files, settings. Served by the orchestrator in production |
| Agent runtime ("nanoagent") | `container/nanoagent/` (Python) | The loop that runs inside a container: model calls, tools, skills, memory, browser |
| Agent sandbox image | `container/Dockerfile` | `nanocrew-agent:latest`, the image each cycle runs in |
| Model gateway | `litellm_config.yaml` | LiteLLM proxy: one endpoint for every provider, with fallbacks |
| Skills engine | `skills-engine/` | Applies and updates add-on skills to a checkout |
| Extension, companion | `extension/`, `companion/` | Optional browser extension and local helper that let an agent use your own browser |

## A cycle

1. A trigger arrives: a chat message, a cron schedule, a webhook, or another agent's handoff.
2. The orchestrator checks the daily budget, then picks or starts a container for that agent. Warm "daemon"
   containers are kept for a while so the next cycle starts instantly.
3. It mounts the agent's workspace and sends the task, the agent's identity and its allowed secrets.
4. `container/nanoagent/bridge/nanocrew_adapter.py` runs the loop. The model sees a small core of tools and loads the
   rest on demand (`DEFERRED_TOOLS`).
5. Model calls go to the LiteLLM gateway. Agents receive a short-lived relay token instead of the real provider key
   (`src/agents/llm-relay.ts`).
6. Sensitive actions pause and appear in the approvals inbox. The cycle resumes after a human answers.
7. The agent writes results, memory and files. The orchestrator records cost and logs, and may distill memories
   and update the agent's identity.

A cycle that goes silent for `CYCLE_IDLE_TIMEOUT_MS` is ended. Spend is checked after every model call.

## Crew features

- **Handoffs and messages** between agents (`src/agents/agent-handoff.ts`).
- **Tool borrowing**: an agent can ask a sibling to run a tool it lacks.
- **Swarm workers**: short-lived single-task workers that run on the owner agent's model without its memory or
  credentials (`src/swarm/`).

## Data and security

- State lives in SQLite under `data/` and `store/` (both gitignored). Secrets are stored encrypted.
- Agents never see platform provider keys. Secrets given to an agent are scoped to it.
- Agent containers run with memory and CPU limits, and only the mounts the orchestrator gives them
  (`src/mount-security.ts` validates them against an allowlist).
- If you configure an outbound proxy, its credentials stay in the orchestrator; agent containers get a gateway and a
  per-agent key instead (`src/agents/egress-gateway.ts`).
- The orchestrator needs the Docker socket to start containers. That is powerful access; see [SECURITY.md](../SECURITY.md).

## Where to read next

- `src/agents/agent-service.ts`: agent lifecycle and cycle entry points
- `src/agents/nanobot-cycle-runner.ts`: how a cycle container is built and run
- `container/nanoagent/nanoagent/agent/loop.py`: the agent loop
- `container/nanoagent/nanoagent/agent/tools/`: built-in tools
