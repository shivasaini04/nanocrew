/**
 * Is a browser profile ACTUALLY signed into a site?
 *
 * Extracted from an earlier spike because it is the one piece of that
 * throwaway spike worth keeping. Not yet wired into anything — this is the seed of the
 * companion's "is this site connected?" check, kept runnable so the next person does not
 * have to rediscover it.
 *
 * ## Why this exists at all
 *
 * The obvious check — load the site and see whether it renders a logged-in page — is
 * WRONG, and the stage 52 spike proved it wrong on live data. Run 2 of that spike showed
 * the real LinkedIn feed while the profile held only `JSESSIONID` and `chp_token`, both
 * session-scoped. The moment Chrome closed, the login was gone. A rendered page proves
 * the CURRENT process is authenticated; it says nothing about whether anything survives.
 *
 * That distinction matters more for an agent than for a person. A human who gets logged
 * out sees a login form and logs in again. An unattended 3am cycle sees an auth wall,
 * reports "no results", and nobody finds out for days — the exact failure shape recorded
 * in reference_agent_records_are_not_evidence.
 *
 * So the real question is not "does the page look right" but "will this session still be
 * here after a restart", and that is answerable only from the cookie store on disk:
 *
 *     the site's auth cookie exists  AND  is_persistent = 1
 *
 * ## Why it never decrypts anything
 *
 * Chrome encrypts cookie VALUES with a DPAPI key tied to the Windows account, and reading
 * them needs elevation. That admin prompt is precisely the friction stage 52 chose to
 * avoid (see the design note: Codex demands it, we do not). We never need the value —
 * presence plus the persistence flag answers the question — so this reads metadata only
 * and stays out of the credential store entirely.
 *
 * ## Usage
 *
 *   node scripts/spikes/profile_session_check.mjs <profile-dir> [site...]
 *   node scripts/spikes/profile_session_check.mjs "%TEMP%\nanocrew-agent-profile" linkedin
 *
 * Exit code is 0 when every requested site has a durable session, 1 otherwise, so it can
 * gate a script.
 */

import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

/**
 * The site registry lives in companion/sites.mjs so the CLI, the desktop app and the
 * dashboard cannot disagree about what a durable login looks like. See that file for why
 * each per-site note exists — every one of them cost a live spike run to learn.
 */
// Imported AND re-exported: `export ... from` alone re-exports without creating a local
// binding, so every SITE_AUTH[...] below would have thrown a ReferenceError.
import { SITE_AUTH } from '../../companion/sites.mjs';
export { SITE_AUTH };

/**
 * Read cookie metadata for one host pattern out of a Chrome profile.
 *
 * Chrome holds an exclusive lock on the DB while running, so we copy it first. The copy
 * is deleted immediately — it contains encrypted values we cannot read and have no use
 * for, but leaving a cookie DB lying in temp is the kind of thing that ages badly.
 */
export function readCookies(profileDir, hostLike) {
  const dbPath = join(profileDir, 'Default', 'Network', 'Cookies');
  if (!existsSync(dbPath)) {
    return { error: `no cookie DB at ${dbPath} — profile never created, or wrong path` };
  }

  const tmp = join(tmpdir(), `nc-cookies-${process.pid}-${Date.now()}.db`);
  try {
    copyFileSync(dbPath, tmp);
  } catch (e) {
    // EBUSY here means Chrome is running with this profile. That is not fatal for the
    // caller — it just means "ask the live browser instead" — so say so precisely.
    return {
      error:
        e.code === 'EBUSY'
          ? 'cookie DB is locked — Chrome is running on this profile; close it or query ' +
            'the live session over CDP instead'
          : e.message,
    };
  }

  try {
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `select name, is_persistent, expires_utc, length(encrypted_value) as len
           from cookies where host_key like ? order by name`,
      )
      .all(hostLike);
    db.close();
    return { rows };
  } catch (e) {
    return { error: e.message };
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Does `profileDir` hold a session for `site` that will survive a restart?
 *
 * Returns a verdict object rather than a boolean, because the *reason* is what a caller
 * needs to act: "log in again" and "tick Keep me signed in" and "finish the 2FA" are
 * three different instructions to put in front of a person.
 */
export function checkSession(profileDir, site) {
  const cfg = SITE_AUTH[site];
  if (!cfg) return { site, ok: false, reason: `unknown site "${site}"` };

  const { rows, error } = readCookies(profileDir, cfg.hostLike);
  if (error) return { site, ok: false, reason: error };

  const hit = rows.find((r) => r.name === cfg.cookie);

  if (!hit) {
    const warn = Object.entries(cfg.warnIf ?? {})
      .filter(([name]) => rows.some((r) => r.name === name))
      .map(([, msg]) => msg);
    return {
      site,
      ok: false,
      reason:
        `${cfg.cookie} absent — no durable session` +
        (warn.length ? ` (${warn.join('; ')})` : ''),
      cookieCount: rows.length,
      rows,
    };
  }

  if (hit.is_persistent !== 1) {
    return {
      site,
      ok: false,
      reason:
        `${cfg.cookie} is SESSION-ONLY — it dies when the browser closes. ` +
        `The login likely omitted a "keep me signed in" / "remember me" option.`,
      cookieCount: rows.length,
      rows,
    };
  }

  const corroborating = (cfg.corroborating ?? []).filter((n) =>
    rows.some((r) => r.name === n && r.is_persistent === 1),
  );
  return {
    site,
    ok: true,
    reason: `${cfg.cookie} present and persistent`,
    corroborating,
    cookieCount: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// pathToFileURL, not string-mangling: argv[1] may be relative, and on Windows the
// drive letter and separators make a hand-rolled `file://` + path comparison wrong.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [profileArg, ...siteArgs] = process.argv.slice(2);

  if (!profileArg) {
    console.error('usage: node profile_session_check.mjs <profile-dir> [site...]');
    console.error(`sites: ${Object.keys(SITE_AUTH).join(', ')} (default: all)`);
    process.exit(2);
  }

  const profileDir = profileArg.replace(/%TEMP%/gi, tmpdir());
  const sites = siteArgs.length ? siteArgs : Object.keys(SITE_AUTH);

  console.log(`\nprofile: ${profileDir}`);
  if (!existsSync(profileDir)) {
    console.error('  profile directory does not exist\n');
    process.exit(1);
  }

  let allOk = true;
  for (const site of sites) {
    const v = checkSession(profileDir, site);
    // A site the profile has simply never visited is not a failure worth shouting about;
    // it is just absent. Only count sites that were asked for explicitly.
    const silentAbsence = !siteArgs.length && v.cookieCount === 0;
    if (silentAbsence) continue;

    console.log(`\n  ${site}`);
    console.log(`    ${v.ok ? 'CONNECTED' : 'NOT CONNECTED'} — ${v.reason}`);
    if (v.corroborating?.length) {
      console.log(`    corroborating: ${v.corroborating.join(', ')}`);
    }
    if (!v.ok) allOk = false;
  }

  console.log('');
  process.exit(allOk ? 0 : 1);
}
