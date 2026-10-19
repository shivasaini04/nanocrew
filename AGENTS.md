# Working on NanoCrew (for contributors and coding agents)

NanoCrew is a self-hosted multi-agent platform. A Node/TypeScript orchestrator (SQLite) runs agents as Docker
containers; each container runs the Python `nanoagent` runtime. A React dashboard talks to the orchestrator, and a
LiteLLM gateway sits in front of the model providers. See [docs/architecture.md](docs/architecture.md).

## Layout

| Path | What it is |
|---|---|
| `src/` | Orchestrator. `index.ts` is the entry; `agents/` (agent lifecycle, scheduling, memory, handoffs), `api/` (REST + sockets), `swarm/`, `channels/` (dashboard, WhatsApp), `owner-notify/`, `db.ts` (SQLite schema and queries) |
| `dashboard/` | React + Vite SPA, its own `package.json`. Built into the orchestrator image; `dashboard/dist` is never committed |
| `container/Dockerfile` | The agent sandbox image (built by `container/build.sh`) |
| `container/nanoagent/` | The Python agent runtime: `agent/` (loop, tools, memory, browser "effector"), `providers/`, `channels/`, `skills/` (built-in skills), `tests/` |
| `container/agent-runner/` | Small Node runner used inside group-chat containers |
| `skills-engine/` | Applies and updates skills that change the orchestrator source |
| `.claude/skills/` | Install-time skill templates (Discord, Slack, Telegram, Gmail...). Not loaded by the agents |
| `setup/` | The `npm run setup` helper |
| `companion/`, `extension/` | Local browser companion and Chrome extension |
| `docs/` | User docs. `groups/*/CLAUDE.md` are the agents' own instructions, not contributor notes |

## Commands

```bash
npm install && npm run build      # orchestrator, output in dist/
npm run dev                       # orchestrator with reload
npm run typecheck                 # tsc --noEmit
npm test                          # vitest (orchestrator, dashboard lib tests, companion, skills-engine)
npm run format                    # prettier, src/ only
cd dashboard && npm install && npm run dev      # dashboard on :5173
cd dashboard && npx tsc -b && npm run build     # dashboard types and build
cd container/nanoagent && pip install -e ".[dev]" && pytest    # agent runtime
bash container/build.sh && docker compose up --build            # full stack, see README
```

CI (`.github/workflows/`) runs format check, typecheck, tests and the dashboard build on Linux, and a Docker
quickstart that builds the agent image and runs `docker compose up`. Run the same before you push.

## Conventions

- TypeScript is ESM with `.js` extensions on relative imports. Prettier formats `src/**/*.ts`; a husky pre-commit hook
  runs `npm run format:fix`.
- Put a test next to the code (`foo.ts` and `foo.test.ts`). A bug fix comes with a test that fails without it.
- Database changes are additive: new tables use `CREATE TABLE IF NOT EXISTS`, new columns an `ALTER TABLE` in a
  try/catch (see `db.ts`). Do not rewrite existing rows' meaning.
- Config comes from `.env` (see `.env.example`). Read optional numbers carefully: an empty `VAR=` arrives as `""`,
  and `Number("")` is 0. Keep numeric overrides commented out in `.env.example`.
- Never commit `.env`, anything under `data/` or `store/`, databases, tokens or real customer data. Use fictional
  names in tests and fixtures.
- Adding third-party code: MIT-compatible only, keep the notice, list it in `THIRD_PARTY.md`.

## Gotchas

- Agents run in containers and see **host** paths through `HOST_PROJECT_ROOT`; a wrong value shows up as cycles
  failing to find files.
- `dist/` is mounted into the orchestrator container: after changing `src/`, run `npm run build` and restart.
- Warm `NanoCrew-daemon-*` containers survive image rebuilds; remove them to pick up container changes.
- Windows: clone to a short path (the `better-sqlite3` build fails on long ones). Some `skills-engine` and `setup`
  tests assume Linux/macOS paths and fail on Windows; they pass in CI.
- The companion tests that drive a real Chrome are skipped on CI unless `RUN_BROWSER_TESTS=1`.

## Before you open a PR

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep PRs small, explain the why, and say how you tested it.
