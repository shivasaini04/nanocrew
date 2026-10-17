/**
 * Stage 52, step 1 — the CDP spike.  THROWAWAY. Not product code.
 *
 * Answers the questions in docs/research/stage52-companion/README.md that decide
 * whether a local companion is worth building:
 *
 *   Q1  Can a DEDICATED Chrome profile open a debug port while the user's normal
 *       Chrome stays open?  (Codex demanded you close Chrome. If we don't have to,
 *       our onboarding door is far lighter than theirs.)
 *   Q2  Does connectOverCDP hand back a full-fat Playwright Page — real Locator,
 *       real evaluate?  (Exactly what the MV3 extension lane cannot do:
 *       remote_page.py:410 and :365-369.)
 *   Q3  Does an authenticated session PERSIST across a restart of that profile?
 *   Q4  Did anything demand admin/UAC?  (Observed, not asserted.)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT WAS REWRITTEN (2026-09-05, after two failed runs)
 *
 * v1 tested Q3 against LinkedIn only, and judged success by the landing URL.
 * Both choices were wrong:
 *
 *   - Judging by URL lies. Run 2 showed the real feed, yet the profile held NO
 *     `li_at` (LinkedIn's durable auth token) — only `JSESSIONID` and `chp_token`,
 *     both with expires_utc=0, i.e. session-scoped and gone on close. A feed can
 *     render on a session cookie before a persistent one is ever granted. So the
 *     script must assert on what is ON DISK, not on where the page landed.
 *
 *   - LinkedIn conflates two different questions. "Does a dedicated profile persist
 *     sessions?" (our mechanism) got tangled with "will LinkedIn grant a durable
 *     token to a fresh CDP-driven profile?" (their anti-bot policy). `chp_token`
 *     appearing means LinkedIn issued a CHALLENGE. That is a site policy result,
 *     not a verdict on the companion architecture.
 *
 * So Q3 now runs against TWO sites and reports them separately:
 *
 *   github   — the MECHANISM test. A normal login, no anti-automation stance.
 *              This one is the go/no-go for stage 52 as an architecture.
 *   linkedin — the JOB test. The actual use case, known hostile. Failing here
 *              while github passes is a real finding about LinkedIn, and does not
 *              invalidate the companion.
 *
 * Run:
 *   node scripts/spikes/cdp_spike.mjs            # pass 1 — Q1, Q2, Q4; you log in
 *   node scripts/spikes/cdp_spike.mjs --verify   # pass 2 — Q3, after a restart
 *
 *   --only=github | --only=linkedin              # test just one site
 *   --keep                                       # do not wipe the profile on pass 1
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const PORT = 9333; // deliberately not 9222 — avoid colliding with anything already up
const PROFILE = join(process.env.TEMP ?? '.', 'nanocrew-agent-profile-spike');
const COOKIE_DB = join(PROFILE, 'Default', 'Network', 'Cookies');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * The cookie that proves a DURABLE login, per site. `persistentOnly` is the whole
 * point: Chrome sets is_persistent=0 for session cookies, which vanish on close.
 * A durable session means the named cookie exists AND is persistent.
 */
const SITES = {
  github: {
    label: 'GitHub  (MECHANISM — go/no-go for stage 52)',
    url: 'https://github.com/',
    loggedInUrl: 'https://github.com/settings/profile',
    hostLike: '%github.com',
    authCookie: 'user_session',
    hint: 'Sign in with username + password. Tick "remember me" if offered.',
  },
  linkedin: {
    label: 'LinkedIn (JOB — known hostile, may legitimately fail)',
    url: 'https://www.linkedin.com/login/',
    loggedInUrl: 'https://www.linkedin.com/feed/',
    hostLike: '%linkedin%',
    authCookie: 'li_at',
    hint:
      'Use EMAIL + PASSWORD, not "Continue with Google" (the Google popup hung in run 1).\n' +
      '      TICK "Keep me signed in" — without it LinkedIn never issues li_at.\n' +
      '      Finish any email/device verification fully, then browse a page or two.',
  },
};

const verifyMode = process.argv.includes('--verify');
const keepProfile = process.argv.includes('--keep');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const sites = onlyArg
  ? [onlyArg.split('=')[1]].filter((s) => SITES[s])
  : Object.keys(SITES);

const results = [];

function record(id, question, pass, detail) {
  results.push({ id, question, pass, detail });
  const mark = pass === true ? 'PASS' : pass === false ? 'FAIL' : '??  ';
  console.log(`  [${mark}] ${id}  ${detail}`);
}

/**
 * Read the auth cookie straight out of Chrome's SQLite. This is the assertion that
 * matters — it is on-disk truth, and it survives the browser being closed.
 *
 * Chrome keeps the DB locked while running, so copy it first. We never decrypt the
 * value (that would need DPAPI and is exactly the admin-prompt path we are avoiding);
 * presence + is_persistent is all we need.
 */
function readAuthCookie(hostLike, name) {
  if (!existsSync(COOKIE_DB)) return { error: 'no cookie DB — profile never created' };
  const tmp = join(process.env.TEMP ?? '.', `nc-cookies-${Date.now()}.db`);
  try {
    copyFileSync(COOKIE_DB, tmp);
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    const all = db
      .prepare(
        `select name, expires_utc, is_persistent, length(encrypted_value) len
           from cookies where host_key like ? order by name`,
      )
      .all(hostLike);
    db.close();
    return { all, hit: all.find((r) => r.name === name) };
  } catch (e) {
    return { error: e.message };
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function reportCookies(site, cfg) {
  const { all, hit, error } = readAuthCookie(cfg.hostLike, cfg.authCookie);
  if (error) return { pass: false, detail: `cookie read failed: ${error}` };

  const persistent = all.filter((r) => r.is_persistent === 1).length;
  console.log(`      cookies on disk: ${all.length} (${persistent} persistent)`);
  for (const r of all) {
    const kind = r.is_persistent === 1 ? 'persistent' : 'SESSION-ONLY';
    const star = r.name === cfg.authCookie ? ' <-- auth' : '';
    console.log(`        ${r.name.padEnd(16)} ${kind}${star}`);
  }

  if (!hit) {
    return {
      pass: false,
      detail:
        `${cfg.authCookie} NOT present — the login never produced a durable session ` +
        `(a rendered page does not prove one)`,
    };
  }
  if (hit.is_persistent !== 1) {
    return {
      pass: false,
      detail: `${cfg.authCookie} exists but is SESSION-ONLY — it dies when Chrome closes`,
    };
  }
  return { pass: true, detail: `${cfg.authCookie} present and persistent (len=${hit.len})` };
}

async function countUserChrome() {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      '@(Get-Process chrome -ErrorAction SilentlyContinue).Count',
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(parseInt(out.trim(), 10) || 0));
    p.on('error', () => resolve(0));
  });
}

function launchDedicatedChrome() {
  mkdirSync(PROFILE, { recursive: true });
  return spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
  ], { detached: false, stdio: 'ignore' });
}

async function waitForDebugPort(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log(`\nStage 52 CDP spike — ${verifyMode ? 'PASS 2 (verify)' : 'PASS 1'}`);
  console.log(`profile: ${PROFILE}`);
  console.log(`port:    ${PORT}`);
  console.log(`sites:   ${sites.join(', ')}\n`);

  if (!existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME} — fix the CHROME const and rerun.`);
    process.exit(1);
  }

  if (!verifyMode && !keepProfile && existsSync(PROFILE)) {
    rmSync(PROFILE, { recursive: true, force: true });
    console.log('cleared previous spike profile (pass 1 starts clean)\n');
  }

  const before = await countUserChrome();
  console.log(`Chrome processes already running: ${before}`);
  if (before === 0 && !verifyMode) {
    console.log('NOTE: open your normal Chrome first — Q1 is only a real test if');
    console.log('      there is a user Chrome running for ours to coexist with.\n');
  }

  // ---- Q1 -----------------------------------------------------------------
  console.log("\nQ1 — dedicated profile + debug port, alongside the user's Chrome");
  const proc = launchDedicatedChrome();
  const version = await waitForDebugPort();

  if (!version) {
    record('Q1', 'debug port on dedicated profile', false,
      'Chrome never opened the debug port — it refused a second instance, or the ' +
      'flags were rejected.');
    console.log('\nStopping — nothing downstream is testable without the port.\n');
    proc.kill();
    return summarise();
  }

  const after = await countUserChrome();
  record('Q1', 'debug port on dedicated profile', true,
    `${version.Browser} on ${PORT}; chrome procs ${before} -> ${after} ` +
    `(user's browser untouched)`);

  // ---- Q2 -----------------------------------------------------------------
  console.log('\nQ2 — is it a full-fat Playwright Page?');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

  let ok = false, detail = '';
  try {
    const t = await page.evaluate(() => document.title + '|' + location.host);
    ok = t.includes('example.com');
    detail = `page.evaluate returned ${JSON.stringify(t)}`;
  } catch (e) { detail = `page.evaluate threw: ${e.message}`; }
  record('Q2a', 'page.evaluate', ok, detail);

  ok = false;
  try {
    const text = await page.getByRole('heading').first().innerText({ timeout: 5000 });
    ok = text.length > 0;
    detail = `getByRole('heading') auto-waited and read ${JSON.stringify(text)}`;
  } catch (e) { detail = `Locator threw: ${e.message}`; }
  record('Q2b', 'Locator / auto-wait', ok, detail);

  // ---- Q3 -----------------------------------------------------------------
  if (!verifyMode) {
    console.log('\nQ3 — log in now (pass 1). Assertion is on the cookie DB, not the URL.\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    for (const key of sites) {
      const cfg = SITES[key];
      console.log(`\n  --- ${cfg.label} ---`);
      console.log(`      ${cfg.hint}`);
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await rl.question(`\n      Logged into ${key}? Press Enter (or type "skip"): `);

      const r = reportCookies(key, cfg);
      console.log(`      -> ${r.pass ? 'durable session captured' : 'NO durable session'}`);
      if (!r.pass) console.log(`         ${r.detail}`);
    }

    console.log('\n  Closing the browser so pass 2 is a genuine restart.');
    await rl.question('  Press Enter to close> ');
    rl.close();

    await browser.close().catch(() => {});
    proc.kill();
    record('Q3', 'session persistence', null, 'pass 1 done — rerun with --verify');
    record('Q4', 'admin/UAC prompt', null, 'did Windows ask for admin? (expected: no)');
    return summarise();
  }

  // ---- verify pass --------------------------------------------------------
  console.log('\nQ3 — did the sessions survive the restart?');
  for (const key of sites) {
    const cfg = SITES[key];
    console.log(`\n  --- ${cfg.label} ---`);

    const cookie = reportCookies(key, cfg);

    // Cookie on disk is the real assertion; the live page is corroboration.
    let landed = '(not checked)';
    try {
      await page.goto(cfg.loggedInUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      landed = page.url();
    } catch (e) { landed = `navigation failed: ${e.message}`; }

    const bounced = /login|signin|authwall|session_redirect/i.test(landed);
    record(`Q3.${key}`, `session persistence — ${key}`, cookie.pass,
      `${cookie.detail}; landed on ${landed}${bounced ? ' (bounced to a login wall)' : ''}`);
  }
  record('Q4', 'admin/UAC prompt', null, 'did Windows ask for admin? (expected: no)');

  await browser.close().catch(() => {});
  proc.kill();
  summarise();
}

function summarise() {
  console.log('\n' + '-'.repeat(70));
  console.log('SPIKE RESULT');
  console.log('-'.repeat(70));
  for (const r of results) {
    const mark = r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'MANUAL';
    console.log(`${mark.padEnd(7)} ${r.id.padEnd(12)} ${r.question}`);
  }
  console.log('-'.repeat(70));

  const gh = results.find((r) => r.id === 'Q3.github');
  const li = results.find((r) => r.id === 'Q3.linkedin');

  if (gh?.pass === true) {
    console.log('MECHANISM PROVEN: a dedicated profile persists a real session across a');
    console.log('restart. The companion architecture is sound — stage 52 step 2 is unblocked.');
    if (li && li.pass === false) {
      console.log('');
      console.log('LinkedIn separately refused a durable session. That is a SITE finding,');
      console.log('not an architecture one — write it into the stage doc and treat');
      console.log('LinkedIn as its own problem (see the Codex note: it inherited a profile');
      console.log('a human had used normally for months).');
    }
  } else if (gh?.pass === false) {
    console.log('MECHANISM NOT PROVEN on github — the neutral control failed. Do NOT build');
    console.log('steps 2-4 yet. Either the login did not complete, or a CDP-launched');
    console.log('profile genuinely cannot hold a durable session. Diagnose before building.');
  } else {
    console.log('Q3 not yet answered — run pass 1, log in, then rerun with --verify.');
  }
  console.log('');
}

main().catch((e) => {
  console.error('\nspike crashed:', e);
  process.exit(1);
});
