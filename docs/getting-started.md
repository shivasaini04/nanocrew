# Getting started

## Requirements

- Docker with Compose v2
- Node.js 20 or newer
- At least one LLM API key (Anthropic, OpenRouter, DeepSeek, Gemini, Groq or Moonshot)
- Bash (Git Bash or WSL on Windows)
- At least 20 GB of free disk for the initial image build (the agent image has measured about 13 GB)

## Install with Docker

```bash
git clone https://github.com/shivasaini04/nanocrew.git
cd nanocrew
cp .env.example .env
```

In `.env`, set:

| Variable | Why |
|---|---|
| one provider key, e.g. `ANTHROPIC_API_KEY` | the agents need a model |
| `MODEL_PRIORITY` | choose a model for that provider; default `claude-sonnet-4-6` needs an Anthropic key; OpenRouter example: `openrouter/anthropic/claude-sonnet-4.6` |
| `HOST_PROJECT_ROOT` | absolute path of this checkout; the orchestrator passes it to the agent containers it starts |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the first admin account, created on first boot |
| `SESSION_SECRET`, `SESSION_ENCRYPTION_KEY`, `nanocrew_SECRET_KEY`, `LITELLM_PROXY_KEY` | generate each separately with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Build and start:

```bash
bash container/build.sh        # agent sandbox image: nanocrew-agent:latest
npm install && npm run build   # orchestrator -> dist/
docker compose up --build      # orchestrator + LiteLLM gateway
```

Wait for `Dashboard API server listening`, then open <http://localhost:3002>.

The orchestrator runs from the host-compiled `dist/` (mounted into the container). After changing TypeScript:
`npm run build && docker compose restart nanocrew-orchestrator`. After changing `package.json` dependencies, rebuild
the image: `docker compose up -d --build nanocrew-orchestrator`.

## Run without Docker for the orchestrator

You still need Docker for the agent sandboxes.

```bash
npm install
npm run dev                                   # API on :3002
cd dashboard && npm install && npm run dev    # dashboard on :5173
```

## Your first agent

1. Sign in and open **Agents**.
2. Create an agent from a template, or start blank and describe the job in plain language.
3. Open its page, pick a model, and send it a message in the chat.
4. Watch the cycle in **Logs**. A cycle is one run of the agent in a container.
5. Add a schedule or a webhook when you want it to run without you.

## Tests

```bash
npm test                                                       # orchestrator + dashboard logic (vitest)
cd container/nanoagent && pip install -e ".[dev]" && pytest    # agent runtime
```

Some tests need a real Chrome or git, or behave differently on Windows. Failures there are known; CI runs on Linux.

## Troubleshooting

- **`set HOST_PROJECT_ROOT` error on `docker compose up`**: add it to `.env`.
- **Cycles die with "can't open file /app/nanoagent/bridge/..."**: `HOST_PROJECT_ROOT` points at the wrong folder.
- **`ERR_MODULE_NOT_FOUND` in the orchestrator**: you added a dependency; rebuild the orchestrator image.
- **Agents answer with a model error**: check the provider key in `.env` and `docker logs nanocrew-litellm`.
- **Container changes have no effect**: warm `NanoCrew-daemon-*` containers survive an image rebuild. Remove them
  with `docker rm -f $(docker ps -aq --filter name=NanoCrew-daemon)`.
- **`npm install` fails building `better-sqlite3` on Windows** (`link.exe` / path errors): clone into a short path such as `C:\nc` (long folder paths break the native build), and use Node 20 or 22 LTS if no prebuilt binary exists for your Node version.
