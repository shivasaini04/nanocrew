# The NanoCrew companion

A small process that runs on **your** machine and lends the agent your browser.

Stage 52, step 2. See `docs/research/stage52-companion/README.md` for why this exists;
the short version is that the cloud can never have your logged-in session, your local
files, or your residential IP — and identity is the one thing that can be lent from the
machine that has it.

## What it is

A second kind of **controller** for the browser broker that already exists
(`src/agents/browser-broker.ts`). The Chrome extension is the first. Both register the
same way, speak the same protocol, and are indistinguishable to the orchestrator:
`onlineControllersFor()` returns whichever attached.

    orchestrator  ──ws──  companion (this)  ──CDP──  Chrome on your machine

The difference is underneath. The extension drives Chrome through MV3 APIs and cannot
evaluate a script it was sent (MV3's CSP forbids building a function from a string, even
in an isolated world — measured 2026-08-30). This is an ordinary Node process with no CSP
at all, attached over CDP, so it can.

## What it can do that the extension cannot

It speaks the extension's eight capabilities, so anything that worked on that lane still
works. On top of those it serves two the extension could never have (`locator.mjs`):

    locator.query   resolve a selector -> count, bounds, text, with auto-wait
    locator.act     click / fill / hover / select it, actionability-checked

These are **not** a higher privilege tier. `locator.act` clicks and types, which
`input.mouse` and `input.key` already did. What changes is aim. A coordinate is resolved
once, when the snapshot is taken, and fired blind some seconds later at whatever now
occupies that pixel — so a cookie banner rendering in between sends the click to the wrong
element, and it *succeeds*. A locator re-resolves at the moment of the action, waits for
the element to be actionable, and retries.

`companion/locator.test.ts` pins exactly that: it moves the page 100px between deciding
and acting, proves the old coordinate now points somewhere else, and shows the locator
still hitting the right button.

The container discovers which lane it is on by itself — `RemotePage.discover_capabilities()`
asks the broker, and marks its elements `coordinate_only` only when locators are absent.
An extension therefore behaves exactly as before, with nothing to configure.

Still not done: file transport, and `page.eval` (MAIN-world arbitrary JS), which stays
fail-closed in the developer tier where it was.

## The live view

The companion serves its own browser at `http://127.0.0.1:9223` — open it in any tab.

This is the half of Codex's panel a container could never have. NanoCrew's existing live
view streams frames from the container, over the internet, to your dashboard; every cost
in that path is distance. Here the browser and the person watching are on the same
machine, so frames never leave it. It is an MJPEG stream, which an `<img>` renders
natively.

It binds to loopback only, and that is the security model rather than a default: this
serves a live picture of a browser signed into your accounts, with no authentication.
`view.test.ts` asserts the bound address for that reason.

## Setup

    cd companion
    npm install
    node index.mjs --host https://your-nanocrew --session <cookie>

It will:

1. Launch a **dedicated** Chrome profile with a debug port — not your everyday browser.
   Your normal Chrome keeps running; nothing is closed and no admin prompt appears.
   (Measured 2026-09-05, stage 52 spike: Q1 and Q4 both passed.)
2. Register with the orchestrator and open the control socket.
3. Wait. It does nothing until a cycle asks it to.

The first time, sign into the sites you want the agent to use, **in that window**. Those
logins persist — the spike confirmed `li_at` and `user_session` surviving a full restart.

Read `--help` for the flags — `--view-port` moves the live view, `--no-view` turns it off.

## Making an agent wait for you

An agent can be set to *prefer* your browser or to *require* it (the second checkbox on
the agent's page, `requireUserBrowser`). The difference matters:

- **prefer** — no companion connected, the cycle runs in the container as usual
- **require** — no companion connected, the cycle is **deferred**, costs nothing, and
  starts the moment you connect one

Use *require* for work that is impossible without a signed-in session. Without it, a run
with no browser falls back to the container, hits a login wall, and reports finding
nothing — while billing for the attempt.

## Checking a login really took

`scripts/spikes/profile_session_check.mjs <profile-dir> linkedin` says whether a site's
session is actually durable, which is not the same question as whether the page looks
logged in. The stage 52 spike hit that difference twice: a rendered LinkedIn feed with no
`li_at` on disk is a session that dies the moment Chrome closes.

## Why a dedicated profile

Codex attaches to your real Chrome, which is why it makes you close every window and
approve an admin prompt: Chrome holds a one-process lock per profile directory, and
reading your existing credential store needs DPAPI elevation.

A separate profile costs one manual login per site and buys: no closing your browser, no
admin prompt, and an agent that cannot disturb your real session. For a product where a
client is trusting an agent with their accounts, that is the better trade.
