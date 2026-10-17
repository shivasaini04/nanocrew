#!/usr/bin/env bash
#
# Stage 61 phase 0 — run the live Effector baseline on the real agent image.
#
#
# Same shape as verify-learning-loop.sh: the real image, the live nanoagent source
# mounted the way cycles mount it, a throwaway workspace. Touches no prod agent,
# workspace or database. Browses public read-only / public test sites only.
#
# Usage
#   bash scripts/effector-baseline.sh                       # all tasks + repeats
#   bash scripts/effector-baseline.sh --only books-price    # extra args go to the runner
#   KEEP_DIR=/root/effector-baseline bash scripts/effector-baseline.sh   # keep results
#
# Exit codes: 0 ran (read the table for pass/fail), 2 environment unusable.

set -uo pipefail

IMAGE="${AGENT_IMAGE:-nanocrew-agent:latest}"
ENV_FILE="${ENV_FILE:-/opt/nanocrew/nanocrew-main/.env}"
NETWORK="${DOCKER_NETWORK:-nanocrew_default}"
SRC="${NANOAGENT_SRC:-/opt/nanocrew/nanocrew-main/container/nanoagent}"
WS="${KEEP_DIR:-$(mktemp -d /tmp/effector-baseline.XXXXXX)}"

die() { printf 'abort: %s\n' "$1" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || die "docker not on PATH"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found — run container/build.sh"
[ -f "$ENV_FILE" ] || die "env file $ENV_FILE not found"
[ -d "$SRC/nanoagent" ] || die "nanoagent source not found at $SRC"

mkdir -p "$WS"
CUID="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u' 2>/dev/null | tr -d '\r')"
[ -n "$CUID" ] || die "could not determine the image's uid"
chown -R "$CUID:$CUID" "$WS" 2>/dev/null || die "cannot chown $WS (run as root)"

echo "effector-baseline  image $IMAGE ($(docker images "$IMAGE" --format '{{.ID}}'))  workspace $WS"

docker run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  --shm-size=1g \
  -e PYTHONPATH=/app/nanoagent \
  -e AGENT_ID=effector-baseline \
  -e EFFECTOR_DECIDER="${EFFECTOR_DECIDER:-}" \
  -e EFFECTOR_ENGINE="${EFFECTOR_ENGINE:-}" \
  -e EFFECTOR_WARM_BROWSER="${EFFECTOR_WARM_BROWSER:-}" \
  -e EFFECTOR_JEV_MIN_CONF="${EFFECTOR_JEV_MIN_CONF:-}" \
  -e EFFECTOR_SETTLE="${EFFECTOR_SETTLE:-}" \
  -v "$SRC:/app/nanoagent:ro" \
  -v "$WS:/workspace/group" \
  --entrypoint python \
  "$IMAGE" /app/nanoagent/scripts/effector_baseline.py --workspace /workspace/group "$@"
RC=$?

echo
echo "results: $WS/baseline/  decision records: $WS/.effector/decisions/"
exit $RC
