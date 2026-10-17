# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub's "Report a vulnerability" button on this
repository's Security tab. Include what you found, how to reproduce it, and the version or commit.

You can expect an acknowledgement within a few days. We will work with you on a fix and credit you in the release
notes if you wish.

## Things to know when running NanoCrew

- The orchestrator mounts the Docker socket. Anyone who controls the orchestrator can control the host's Docker.
  Run it on a dedicated machine and keep the dashboard behind authentication and TLS.
- Agents execute code and use a browser. Give them only the credentials and tools they need, and use approval rules
  for anything that sends data out or changes things.
- Change every `change-me` value in `.env` before exposing the service. Keep `.env`, `data/` and `store/` private.
- Do not expose the LiteLLM port (4000) to the internet.
- Set `GLOBAL_DAILY_BUDGET_USD` to cap spend.
