# nanocrew Agent Container
# Runs NanoAgent Python engine in isolated Linux VM with browser automation

FROM python:3.12-slim

# Install system dependencies for Chromium, Node.js, and building packages
#
# The font set is part of the browser fingerprint, not cosmetics. Font detection
# measures rendered text width, so it cannot be patched from JS — an image with
# only fonts-liberation presents a font list no real desktop has, which
# contradicts whatever OS the effector's device profile claims. liberation2 +
# dejavu + noto-core + the Carlito/Caladea metric substitutes (Calibri/Cambria)
# give a plausible Linux desktop set, which is what the profile pool now claims.
# See effector/stealth/fingerprint_pool.py.
#
# x11vnc (stage 50 phase 2) serves the Xvfb display the browser already renders onto,
# so a human taking over gets the real screen rather than a JPEG every second. It
# ATTACHES to an existing display, which is why it and not tigervnc-standalone-server
# (that one starts its own X server, and ours is already running with the browser on
# it). Listens on 127.0.0.1 only; the boundary is the cycle token on the relay, never
# the VNC port. See effector/desktop/vnc_session.py.
RUN apt-get update && apt-get install -y \
    chromium \
    tesseract-ocr \
    xvfb \
    xauth \
    xdotool \
    scrot \
    xclip \
    x11vnc \
    fonts-liberation \
    fonts-liberation2 \
    fonts-dejavu \
    fonts-noto-core \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    build-essential \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Upgrade to Node.js LTS for modern tooling (npx, etc.)
RUN npm install -g n && n lts && hash -r

# Pre-install the common MCP servers so `npx -y <pkg>` resolves them instantly from the
# global cache instead of cold-downloading on first agent use (which risks a startup
# timeout). Users can still add any other npx/uvx server — those cold-download once and
# are covered by the generous startup_timeout_ms. `|| true` keeps a transient npm hiccup
# from failing the whole image build; a missing server just falls back to cold download.
RUN npm install -g --no-fund --no-audit \
    @modelcontextprotocol/server-filesystem \
    @modelcontextprotocol/server-memory \
    @modelcontextprotocol/server-everything \
    @modelcontextprotocol/server-sequential-thinking \
    @modelcontextprotocol/server-github \
    mcp-server-fetch-typescript \
    || true

# Set Chromium path for future browser-use compatibility
ENV CHROME_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /app

# Copy nanoagent source into build context.
COPY nanoagent/ ./nanoagent/

# Install nanoagent without editable flag and set PYTHONPATH.
# --timeout/--retries make the build resilient to slow/flaky PyPI connections
# (otherwise a single slow download read-times-out and kills the whole build).
ENV PYTHONPATH=/app/nanoagent
ENV PIP_DEFAULT_TIMEOUT=180
# ddgs and playwright are both declared in pyproject.toml, so `.` installs them at their
# pinned versions. They used to be named here as bare, unpinned extras.
RUN cd nanoagent && python -m pip install --timeout 180 --retries 8 .

# Fetch the browser binary for our inlined engine fork (agent/effector/engine/).
#
# The engine is vendored, not pip-installed, so nothing fetches its browser for us —
# and without the binary the whole native-engine path is dead code that silently falls
# back to plain Chromium. Availability is probed by
# effector/stealth/camoufox_driver.py:engine_status(), which deliberately never
# downloads: fetching happens HERE, as an explicit build step, or not at all.
#
# `|| true` matches the MCP block above: a transient GitHub hiccup degrades the image
# to Chromium-only rather than failing the build. That degradation is visible at
# runtime in the capability manifest, not silent — check `capabilities.engine` in an
# effector result to confirm which engine a deployed image is actually running.
#
# XDG_CACHE_HOME is load-bearing and must be set BEFORE the fetch and stay set at
# runtime. The engine resolves its install directory through platformdirs, i.e.
# per-user: the build runs as root and would write /root/.cache/camoufox, while the
# container runs as `node` (created below) and would look in /home/node/.cache —
# which cannot even read root's copy. Verified live 2026-08-31: the first build
# downloaded the browser successfully and engine_status() in the finished image still
# reported "not installed (no active install)", with /root/.cache/camoufox unreadable
# as `node`. A fixed, world-readable path makes build-time and run-time agree.
ENV XDG_CACHE_HOME=/opt/engine-cache
ENV EFFECTOR_ENGINE=auto
RUN mkdir -p "$XDG_CACHE_HOME" \
    && python -m nanoagent.agent.effector.engine fetch || true
# Readable AND WRITABLE by the non-root runtime user. The engine does not merely read
# this tree: at launch it generates a fontconfig file under
# $XDG_CACHE_HOME/camoufox/fontconfig, so a read-only cache dies with
# "PermissionError: [Errno 13] ... /opt/engine-cache/camoufox/fontconfig". Found
# 2026-08-31, two layers below the missing-WebGL-database failure that was masking it.
RUN chmod -R a+rwX "$XDG_CACHE_HOME" || true

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Secrets and inputs are passed via stdin JSON
# The python adapter reads stdin and outputs wrapped JSON
RUN printf '#!/bin/bash\nset -e\nexport PYTHONPATH=/app/nanoagent\ncat > /tmp/input.json\npython /app/nanoagent/bridge/nanocrew_adapter.py < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to python user (non-root) for writable directories
# Create the user first since it doesn't exist in python base image
RUN useradd -m -u 1000 node
RUN chown -R node:node /workspace && chmod 777 /home/node

# Xvfb (desktop/xvfb_session.py) runs as the non-root `node` user below, but X11's
# own transport layer refuses to auto-create /tmp/.X11-unix unless running as root
# (_XSERVTransmkdir: "euid != 0, directory /tmp/.X11-unix will not be created" —
# confirmed live, 2026-08-24, by running Xvfb directly inside this exact image: this
# is the actual reason every headed-browser Effector launch failed with "no XServer
# running", a distinct root cause from the stale-lock-file issue xvfb_session.py's
# own retry logic addresses separately). The restriction is only on CREATING the
# directory, not using an existing one — pre-create it here as root, with the
# standard 1777 (world-writable + sticky bit) mode real X11 installs use, so Xvfb
# just finds it already there at runtime.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Switch to non-root user
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
