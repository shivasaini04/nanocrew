# Deployment

NanoCrew runs from the same `docker-compose.yml` on a server. Treat the host as sensitive: the orchestrator mounts
the Docker socket, which is root-equivalent on the machine.

## Checklist

1. A Linux host with Docker and Compose, 2 vCPU and 4 GB RAM or more.
2. Clone the repo, create `.env`, set strong values for `ADMIN_PASSWORD`, `SESSION_SECRET`,
   `SESSION_ENCRYPTION_KEY` and `LITELLM_PROXY_KEY`. Set `SIGNUP_OPEN=false` unless you want public sign-ups.
3. Set `HOST_PROJECT_ROOT` to the absolute checkout path and `APP_URL` to your public URL.
4. Build and start:
   ```bash
   bash container/build.sh
   npm ci && npm run build
   docker compose up -d --build
   ```
5. Put a reverse proxy with TLS (Caddy, nginx, Traefik) in front of port 3002. Do not expose port 4000 (the model
   gateway) publicly.
6. Back up `data/` and `store/`. They hold the database and encrypted secrets.
7. Set `GLOBAL_DAILY_BUDGET_USD` so a runaway agent cannot spend without limit.

## Updating

```bash
git pull
bash container/build.sh                       # only if container/ changed
npm ci && npm run build
docker compose up -d --build nanocrew-orchestrator
docker rm -f $(docker ps -aq --filter name=NanoCrew-daemon) 2>/dev/null   # warm containers keep old code
```

Check that a deploy took effect by looking at the running image or `dist/`, not just at the build succeeding.

## Agent secrets

The orchestrator does not pass `.env` through to agent containers. Give an agent credentials through the dashboard
(encrypted store, scoped per agent or per owner).
