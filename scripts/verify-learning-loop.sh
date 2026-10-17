#!/usr/bin/env bash
#
# Post-deploy proof that the stage 42 learning loop actually RUNS.
#
# Why this exists
# ---------------
# On 2026-08-23 three of the loop's mechanisms were merged, deployed, covered by
# passing tests, and reachable by nothing:
#
#   * the post-turn review fork was spawned and then cancelled at process exit,
#     so it never finished a write — and the cancellation was swallowed;
#   * the curator's sweep was only callable from a tool whose documented trigger
#     (a self_improve cycle) never reaches a container;
#   * so the judgment half had no trigger either.
#
# The unit suite was green throughout. It proved the pieces worked and said
# nothing about whether anything called them. Nothing in the system would have
# reported the gap; it was found by reading call sites by hand.
#
# This script closes that hole the only way that actually works: it runs the real
# agent image, gives it something worth learning, and asserts the artifacts appear
# on disk. If the wiring breaks again, this goes red.
#
# What it does NOT touch
# ----------------------
# No prod agent, no prod database, no prod workspace. Everything happens in a
# throwaway directory that is removed on exit. It costs one cheap model call.
#
# Usage
#   bash scripts/verify-learning-loop.sh            # run and clean up
#   bash scripts/verify-learning-loop.sh --keep     # leave the workspace to inspect
#
# Exit codes: 0 all checks passed, 1 a check failed, 2 the environment is unusable.

set -uo pipefail

IMAGE="${AGENT_IMAGE:-nanocrew-agent:latest}"
ORCH="${ORCH_CONTAINER:-nanocrew-orchestrator}"
ENV_FILE="${ENV_FILE:-/opt/nanocrew/nanocrew-main/.env}"
NETWORK="${DOCKER_NETWORK:-nanocrew_default}"
LITELLM="${LITELLM_URL:-http://nanocrew-litellm:4000}"
MODEL="${VERIFY_MODEL:-deepseek/deepseek-v4-flash}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WS="$(mktemp -d /tmp/verify-loop.XXXXXX)"
PASS=0; FAIL=0; WARNED=0; REVIEW_RAN=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARNED=$((WARNED+1)); }
info() { printf '        %s\n' "$1"; }
die()  { printf '\033[31mabort:\033[0m %s\n' "$1" >&2; exit 2; }

cleanup() {
  if [ "$KEEP" = "1" ]; then
    printf '\nworkspace kept at %s\n' "$WS"
  else
    rm -rf "$WS"
    docker exec "$ORCH" rm -rf /verify-loop >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# ── environment ──────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not on PATH"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found — run container/build.sh"
docker inspect "$ORCH" >/dev/null 2>&1 || die "container $ORCH not running"
[ -f "$ENV_FILE" ] || die "env file $ENV_FILE not found (override with ENV_FILE=)"

echo "verify-learning-loop"
echo "  image     $IMAGE ($(docker images "$IMAGE" --format '{{.ID}}'))"
echo "  workspace $WS"
echo

# The container runs as a non-root user; a root-owned bind mount fails at
# SessionManager init with a bare PermissionError.
CUID="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u' 2>/dev/null | tr -d '\r')"
[ -n "$CUID" ] || die "could not determine the image's uid"
mkdir -p "$WS/skills"
chown -R "$CUID:$CUID" "$WS" 2>/dev/null || die "cannot chown $WS (run as root)"
# The foreground agent is forbidden from saving skills, so any skill that appears
# provably came from the post-turn fork. Without this the test can pass for the
# wrong reason: asking the agent to "save this as a skill" makes the FOREGROUND
# call save_skill, which is stamped assistant_tool (user-owned, correctly off
# limits to the curator) and never exercises the fork at all. Observed doing
# exactly that on 2026-08-23.
cat > "$WS/IDENTITY.md" <<'IDENT'
You are a verification agent. Answer in one short sentence.

Never call save_skill yourself. Just reply.
IDENT
chown "$CUID:$CUID" "$WS/IDENTITY.md"

# ── phase 1: the agent writes a skill from its own turn ──────────────────────
#
# The prompt describes a reusable technique and does NOT ask for it to be saved.
# That is the point: the fork has to decide on its own, which is the behaviour in
# production. Asking for a save would route the write through the foreground and
# prove nothing about the loop.
#
# The cost is that the decision is a model judgement, and declining is a legitimate
# answer the review prompt explicitly invites ("Most turns are worth neither").
# Measured decline rate on this input is roughly 1 turn in 2. A verifier that is red
# that often gets ignored, and then the next real regression is invisible — exactly
# the failure this script exists to prevent.
#
# So the turn is retried, and the outcomes are graded rather than lumped together:
#
#   no evidence the fork ever ran   -> FAIL. The 2026-08-23 drain regression.
#   fork ran, declined every time   -> WARN. Valid judgement; write path untested.
#   fork ran and wrote              -> PASS, and the artifact checks below apply.
#
# A broken write path cannot hide in the WARN bucket: if save_skill throws, the
# review dies without a conclusion and lands in the FAIL bucket instead.
echo "phase 1 — post-turn review writes a skill (#1 #2 #3 #5 #6)"

PROMPT='I fixed a flaky upload by retrying with exponential backoff: 1s, 2s, then 4s, and only on HTTP 503 — retrying on 400 made it worse because the request was malformed. Acknowledge in one sentence.'
ATTEMPTS="${VERIFY_ATTEMPTS:-4}"

SIDECAR="$WS/skills/.origins.json"
LEDGER="$WS/skills/.ledger.jsonl"
WROTE=""; RAN_ANY=0; ATTEMPT=0

while [ "$ATTEMPT" -lt "$ATTEMPTS" ]; do
  ATTEMPT=$((ATTEMPT+1))
  printf '{"prompt":%s,"groupFolder":"verify-loop","chatJid":"verify@g.us","isMain":false}\n' \
    "$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
  | timeout 420 docker run -i --rm \
      --network "$NETWORK" \
      --env-file "$ENV_FILE" \
      -e NANOAGENT_BACKGROUND_REVIEW=on \
      -e NANOBOT_MODEL="$MODEL" \
      -e LITELLM_PROXY_URL="$LITELLM" \
      -e AGENT_ID=verify-loop \
      -v "$WS:/workspace/group" \
      "$IMAGE" > "$WS/run.out" 2> "$WS/run.err"
  RUN_RC=$?

  if [ "$RUN_RC" -ne 0 ]; then
    bad "the agent run itself failed (exit $RUN_RC)"
    info "$(tail -3 "$WS/run.err")"
    echo; echo "cannot verify the loop when the cycle does not complete."; exit 1
  fi

  grep -qi 'Background review:' "$WS/run.err" 2>/dev/null && RAN_ANY=1

  # Specifically the skill the FORK wrote, identified by its origin — not merely
  # the first SKILL.md on disk. Retries can leave a foreground-written skill
  # (origin assistant_tool) beside the fork's, and picking arbitrarily between
  # them made this fail on a loop that was working.
  WROTE="$(python3 - "$SIDECAR" <<'PY' 2>/dev/null
import json, sys
try:
    skills = json.load(open(sys.argv[1])).get("skills", {})
except Exception:
    sys.exit(0)
for name, e in sorted(skills.items()):
    if isinstance(e, dict) and e.get("origin") == "background_review":
        print(name); break
PY
)"
  [ -n "$WROTE" ] && break
  [ "$ATTEMPT" -lt "$ATTEMPTS" ] && info "attempt $ATTEMPT: the review declined to save — retrying"
done

ok "the agent completed its turn            ($ATTEMPT attempt$([ "$ATTEMPT" -eq 1 ] || echo s))"

# A written skill is itself proof the fork survived: the write happens inside the
# review's own tool loop. The log line alone is too strict a signal - the fork
# logs a conclusion only when its final response is prose, so a review whose last
# act is the save_skill call completes successfully and logs nothing. That read as
# a drain regression on a loop that was working.
[ -n "$WROTE" ] && RAN_ANY=1

# The drain assertion. The fork logs its conclusion only after finishing its rounds,
# so no line on any attempt means it was cancelled at process exit.
if [ "$RAN_ANY" = "1" ]; then
  ok "the review ran to completion            (survived process exit)"
else
  bad "the review never reached a conclusion — it was killed before finishing"
  info "this is the exact 2026-08-23 regression: spawn() with nothing awaiting it"
  info "check that nanocrew_adapter.py still awaits reviewer.drain()"
fi

if [ -n "$WROTE" ]; then
  ok "the fork wrote a skill                ($WROTE)"
elif [ "$RAN_ANY" = "1" ]; then
  # The fork ran and chose not to save. That is a legitimate answer the review
  # prompt explicitly invites, so it is NOT a wiring failure and must not turn the
  # run red — a verifier that cries wolf gets ignored, which is the whole problem
  # this script exists to solve. Measured decline rate is roughly 1 turn in 2, so
  # even four attempts leave a real chance of an honest no.
  #
  # A genuinely broken write path does not land here: if save_skill throws, the
  # review dies without a conclusion and is caught as a hard failure above.
  warn "the review ran $ATTEMPTS times and declined each time — write path not exercised"
  info "not a wiring fault: declining is a valid answer the review prompt invites"
  info "last conclusion: $(grep -i 'Background review:' "$WS/run.err" | tail -1 | cut -c1-110)"
else
  bad "no skill was written (the review never ran — see above)"
fi

if [ -f "$SIDECAR" ]; then
  ok "provenance sidecar written              (.origins.json)"
  if grep -q '"origin": *"background_review"' "$SIDECAR"; then
    ok "the write is stamped agent-created     (curator eligibility)"
  else
    bad "no background_review origin in the sidecar — the curator could never touch it"
  fi
  if grep -q '"usage_count"' "$SIDECAR"; then
    ok "usage telemetry recorded               (built-in skills counted)"
  else
    bad "no usage_count recorded — telemetry is not running"
  fi
else
  bad "no .origins.json — provenance and telemetry both dead"
fi

if [ -f "$LEDGER" ] && [ -s "$LEDGER" ]; then
  ok "mutation ledger has $(wc -l < "$LEDGER" | tr -d ' ') entr$([ "$(wc -l < "$LEDGER")" -eq 1 ] && echo y || echo ies)"
  if grep -q '"action": *"create"' "$LEDGER"; then
    ok "the create is ledgered"
  else
    bad "ledger exists but records no create"
  fi
  BLOBS="$(find "$WS/skills/.blobs" -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$BLOBS" -gt 0 ]; then
    ok "content-addressed blobs stored          ($BLOBS)"
  else
    bad "ledger entries reference blobs that were never written — history is unrecoverable"
  fi
else
  bad "no .ledger.jsonl — nothing about this write is auditable or reversible"
fi

# ── phase 2: the orchestrator retires an aged skill ──────────────────────────
# The cheap half of the curator, in the process that actually schedules it. Runs
# the DEPLOYED dist, not the source tree, so a stale image shows up here.
echo
echo "phase 2 — orchestrator sweep retires an aged skill (#4, cheap half)"

if [ -z "$WROTE" ] || [ ! -f "$SIDECAR" ]; then
  if [ "$RAN_ANY" = "1" ]; then
    warn "skipped — the review declined, so there is no agent-written skill to age"
  else
    bad "skipped — phase 1 produced nothing to age"
  fi
else
  SKILL_NAME="$WROTE"
  docker cp "$WS" "$ORCH:/verify-loop" >/dev/null 2>&1 || die "could not copy the workspace into $ORCH"

  docker exec "$ORCH" node -e "
    (async () => {
      const fs = require('fs');
      const inv = await import('/app/dist/agents/skill-inventory.js');
      const cur = await import('/app/dist/agents/skill-curator.js');
      const WS = '/verify-loop';
      const NAME = '$SKILL_NAME';

      const t = inv.telemetryFor(inv.readOrigins(WS)[NAME]);
      if (!t.agentCreated) { console.log('ERR reader does not see the skill as agent-created'); process.exit(1); }
      console.log('OK  the orchestrator reads it back as agent-created');

      // A fresh skill must survive: archiving something in active use would be worse
      // than never archiving at all.
      if (cur.sweep(WS, { dryRun: true }).archived.length !== 0) {
        console.log('ERR a fresh skill was marked for archiving'); process.exit(1);
      }
      console.log('OK  a fresh skill is left alone');

      const sidecar = JSON.parse(fs.readFileSync(WS + '/skills/.origins.json', 'utf-8'));
      const old = new Date(Date.now() - 120 * 86400000).toISOString().replace(/\.\d{3}Z\$/, 'Z');
      sidecar.skills[NAME].last_used_at = old;
      sidecar.skills[NAME].created_at = old;
      fs.writeFileSync(WS + '/skills/.origins.json', JSON.stringify(sidecar));

      const before = inv.readLedger(WS).length;
      const swept = cur.sweep(WS);
      if (!swept.archived.includes(NAME)) { console.log('ERR a 120-day skill was not archived'); process.exit(1); }
      console.log('OK  a 120-day skill is archived');

      if (!fs.existsSync(WS + '/skills/.archive/' + NAME + '/SKILL.md')) {
        console.log('ERR archived but not present under .archive/ — the body is gone'); process.exit(1);
      }
      console.log('OK  archive never deletes — the body is still on disk');

      const after = inv.readLedger(WS);
      if (after.length !== before + 1 || after[0].actor !== 'curator') {
        console.log('ERR the retirement was not ledgered as the curator'); process.exit(1);
      }
      console.log('OK  the retirement is ledgered as actor=curator');

      if (inv.readBlob(WS, after[0].before) === null) {
        console.log('ERR the pre-archive body is not recoverable'); process.exit(1);
      }
      console.log('OK  the pre-archive body is recoverable');

      if (cur.sweep(WS).archived.length !== 0) { console.log('ERR the sweep is not idempotent'); process.exit(1); }
      console.log('OK  a second sweep is a no-op');
    })().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
  " > "$WS/phase2.out" 2>&1
  PHASE2_RC=$?

  # Read from a file, not a pipe: a `while` on the right of `|` runs in a subshell
  # and every PASS/FAIL increment inside it would be discarded at the closing done.
  while IFS= read -r line; do
    case "$line" in
      OK*)  ok  "${line#OK  }" ;;
      ERR*) bad "${line#ERR }" ;;
      *)    [ -n "$line" ] && info "$line" ;;
    esac
  done < "$WS/phase2.out"

  # A crash before the first assertion prints nothing at all, which would
  # otherwise read as a clean pass.
  if [ "$PHASE2_RC" -ne 0 ] && ! grep -q '^ERR' "$WS/phase2.out"; then
    bad "the orchestrator check crashed before it could assert anything"
  fi
fi

# ── verdict ──────────────────────────────────────────────────────────────────
echo
if [ "$FAIL" -eq 0 ]; then
  if [ "$WARNED" -gt 0 ]; then
    printf '\033[32m%d checks passed\033[0m, \033[33m%d skipped\033[0m — the loop is wired; the fork declined to write this run.\n' "$PASS" "$WARNED"
    printf 'Re-run, or raise VERIFY_ATTEMPTS, to exercise the write path.\n'
  else
    printf '\033[32mall %d checks passed\033[0m — the learning loop runs end to end.\n' "$PASS"
  fi
  exit 0
fi
printf '\033[31m%d check(s) failed\033[0m, %d passed.\n' "$FAIL" "$PASS"
echo "a mechanism is shipped but not running. re-run with --keep and inspect the workspace."
exit 1
