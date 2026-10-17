# Configuration

All settings are environment variables, read from `.env` (copy `.env.example`). The file is commented; this page
covers the ones you are most likely to change.

## Models

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MOONSHOT_KIMI_API_KEY` | Provider keys. Set the ones you use. |
| `LITELLM_PROXY_URL`, `LITELLM_PROXY_KEY` | The gateway address and its master key. Compose sets them. |
| `MODEL_PRIORITY` | Comma-separated model list; the first is the default, the rest are fallbacks. |
| `NANOBOT_MODEL`, `NANOBOT_MODEL_PREMIUM`, `NANOBOT_MODEL_MINI`, `LIGHT_MODEL`, `VISION_MODEL` | Per-tier overrides. |

The gateway's model list is `litellm_config.yaml`. Anything under `openrouter/<provider>/<model>` works without an
entry. To add another provider, add a `model_list` entry and forward its key in `docker-compose.yml`.

## Limits and budget

| Variable | Default | Meaning |
|---|---|---|
| `GLOBAL_DAILY_BUDGET_USD` | unset | Daily spend cap across all agents. Checked after every model call. |
| `CYCLE_IDLE_TIMEOUT_MS` | 30 min | A silent cycle is ended after this long. |
| `CYCLE_MAX_MS` | 0 (none) | Optional hard ceiling for a cycle. |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Agent containers at once. |
| `DEFAULT_MEMORY_LIMIT_MAIN` / `_WORKER` | 2g / 1g | Per-container memory. |
| `DEFAULT_CPU_LIMIT_MAIN` / `_WORKER` | 2 / 1 | Per-container CPUs. |

## Agent behaviour toggles

`VERIFY_LOOP`, `PLAN_FIRST_ENFORCE`, `LEAN_EXPLORE`, `SELF_EXTEND`, `DEFERRED_TOOLS`, `PERSISTENT_SESSION`,
`NANOBOT_PERSISTENT`. Each is `on` or `off`; see `.env.example` for what they do.

## Accounts and access

| Variable | Meaning |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Bootstrap admin, created on first boot. Change it later in the admin panel. |
| `SESSION_SECRET` | Signs login cookies. Keep it stable. |
| `SESSION_ENCRYPTION_KEY` | Encrypts stored session tokens. |
| `ENFORCE_PLANS` | `false` (default) means no paywall and no run, agent or project caps. `true` applies the Standard/Pro/Business tiers in `src/config.ts`; admins are always exempt. |
| `SIGNUP_OPEN` | `true` lets anyone sign up; `false` is invite-only. |
| `APP_URL` | Public base URL, used in emails and links. |
| `EMAIL_SERVER_*`, `EMAIL_FROM`, `RESEND_API_KEY` | Optional, for password-reset and welcome emails. |

## Optional integrations

`BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, `TINYFISH_API_KEY` (web search and fetch), `SENTRY_DSN` (error tracking),
`WHATSAPP_ENABLED` (WhatsApp channel, pairs by QR on first run), `PROXY_*` (outbound proxy).
