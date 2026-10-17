# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

See [docs/getting-started.md](docs/getting-started.md). You need Node 20+, Docker and Python 3.11+.

## Before you open a PR

```bash
npm run typecheck && npm test               # orchestrator
cd dashboard && npx tsc -b                  # dashboard types
cd container/nanoagent && pytest            # agent runtime
```

- Add or update a test with the change. A bug fix should come with a test that fails without it.
- Match the style of the surrounding code. `npm run format` formats the orchestrator.
- Explain the why in the PR description, and say how you tested it.
- Do not commit secrets, `.env` files, databases or anything under `data/` and `store/`.

## Adding code from elsewhere

Only add code whose license allows redistribution under MIT, keep its copyright notice, and add it to
[THIRD_PARTY.md](THIRD_PARTY.md).

## Reporting bugs

Open an issue with what you did, what you expected, and what happened. Include logs from `docker compose logs`
with secrets removed. For security problems, follow [SECURITY.md](SECURITY.md) instead.
