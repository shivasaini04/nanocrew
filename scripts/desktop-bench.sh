#!/usr/bin/env bash
#
# Stage 63 — run the computer-use benchmark in the real agent image.
#
#
# Brings up everything cua-driver needs to read elements on Linux, which is more than it
# looks: AT-SPI lives on the SESSION bus, so a system bus is not enough — that mistake
# cost an afternoon and reported "AT-SPI was unavailable" while dbus was plainly running.
#
# Usage
#   bash scripts/desktop-bench.sh
#   bash scripts/desktop-bench.sh --only ok-button
#   KEEP_DIR=/root/desktop-bench bash scripts/desktop-bench.sh
#
# Exit codes: 0 ran (read the table), 2 environment unusable.

set -uo pipefail

IMAGE="${AGENT_IMAGE:-nanocrew-agent:latest}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
NETWORK="${DOCKER_NETWORK:-nanocrew_default}"
SRC="${NANOAGENT_SRC:-$PROJECT_ROOT/container/nanoagent}"
WS="${KEEP_DIR:-$(mktemp -d /tmp/desktop-bench.XXXXXX)}"

die() { printf 'abort: %s\n' "$1" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || die "docker not on PATH"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found — run container/build.sh"
[ -f "$ENV_FILE" ] || die "env file $ENV_FILE not found"
[ -d "$SRC/nanoagent" ] || die "nanoagent source not found at $SRC"
mkdir -p "$WS"

# Runs as root: the benchmark installs the accessibility stack into a throwaway
# container. Nothing here touches a prod agent, workspace or database.
docker run --rm -u root \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  --shm-size=1g \
  -e PYTHONPATH=/app/nanoagent \
  -e DISPLAY=:99 \
  -e AGENT_ID=desktop-bench \
  -v "$SRC:/app/nanoagent:ro" \
  -v "$WS:/workspace/group" \
  --entrypoint sh \
  "$IMAGE" -c '
    set -e
    apt-get update -qq >/dev/null 2>&1
    # python3-gi / gir1.2-gtk-3.0 are for the GTK fixtures (menus, disabled controls,
    # slow repaint) — shapes zenity cannot express. They run under /usr/bin/python3,
    # since PyGObject is a Debian package the container'"'"'s own interpreter cannot see.
    apt-get install -y -qq at-spi2-core dbus dbus-x11 zenity python3-gi gir1.2-gtk-3.0 >/dev/null 2>&1
    pip install -q cua-driver >/dev/null 2>&1
    Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
    sleep 2
    # A SESSION bus, not the system bus. at-spi-bus-launcher publishes the
    # accessibility bus onto it, and the driver reads elements from there.
    exec dbus-run-session -- sh -c "
      /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
      sleep 3
      python /app/nanoagent/scripts/desktop_bench.py --workspace /workspace/group '"$*"'
    "
  ' 2>&1 | grep -vE 'dbus-daemon\[|Activating service|Successfully activated'
RC=$?

echo
echo "workspace: $WS"
exit $RC
