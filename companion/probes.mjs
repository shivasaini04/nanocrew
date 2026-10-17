/**
 * The named probes the container asks for, for the companion lane.
 *
 * ## Why this file exists at all — found by the first live cycle, 2026-09-06
 *
 * The companion originally carried one probe (`ping`) on the assumption that the
 * container would SEND the script it wanted, since — unlike MV3 — nothing here forbids
 * evaluating a string. That assumption was wrong, and the unit tests agreed with it
 * because they exercised the `script:` path the container never uses.
 *
 * The container NAMES a probe: `{ probe: 'installFrameBridge' }`. It has to, because the
 * extension lane it was written for cannot receive a script at all, so the vocabulary is
 * a fixed registry on the controller side. The first real cycle failed with
 * `unknown probe: installFrameBridge` twice and gave up — correctly refusing to fall back
 * to another tool.
 *
 * So the companion needs the same registry the extension has. `script:` still works and
 * remains the richer path, but names are what the container actually speaks today.
 *
 * ## Why `snapshot` is imported rather than written here
 *
 * `extension/probes.generated.js` is generated from `dom_snapshot.py` precisely so there
 * is one source of truth and not a copy that drifts — the shape of bug this repo keeps
 * paying for. A third hand-written copy in the companion would defeat that entirely, so
 * this imports the generated module. Regenerate with `python extension/build_probes.py`
 * and both controllers move together.
 *
 * The other four probes live inline in `extension/background.js` rather than in the
 * generated file, so they are ported here deliberately and must stay in step with it.
 *
 * ## Why the frame bridge is kept even though Playwright does not need it
 *
 * Playwright can address frames directly, so the companion could compute frame origins
 * without any in-page postMessage bridge. It still installs the bridge, because the
 * container reads `window.__nc_origin` through the `frameOrigin` probe and places every
 * in-frame element with it. Replacing that here would make the two lanes disagree about
 * coordinates — the one thing that must not differ between controllers.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Pull `snapshot` and the selector list out of the generated module as SOURCE TEXT.
 *
 * Read as text rather than imported: these functions are stringified and evaluated inside
 * the page, so what matters is their source, and importing them would give us live
 * bindings we would have to stringify back anyway. Reading the file also means a
 * regenerated probes file is picked up on the next companion start with no build step.
 */
function loadGeneratedProbe(name) {
    const path = join(HERE, '..', 'extension', 'probes.generated.js');
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch (err) {
        throw new Error(
            `could not read ${path} — the companion shares the extension's generated ` +
            `probes so the two lanes cannot drift. Run: python extension/build_probes.py ` +
            `(${err.message})`,
        );
    }

    // `export const <name> = ` up to whatever comes next at the top level.
    //
    // "Whatever comes next" is the fiddly part. Slicing only at the next `export` was
    // fine while every export was adjacent, and broke the moment one carried a doc
    // comment: the slice then ended with `};` followed by `/** … */`, which is not an
    // expression, and every probe using it failed with "Unexpected token ';'". So the
    // boundary is the next top-level `export` OR the comment that introduces it, and the
    // trailing semicolon comes off after that.
    //
    // Line endings are CRLF in this checkout, so the patterns must not assume \n alone.
    const start = text.indexOf(`export const ${name} =`);
    if (start === -1) throw new Error(`probes.generated.js has no export named ${name}`);

    const rest = text.slice(text.indexOf('=', start) + 1);
    const ends = [/\r?\nexport /.exec(rest), /\r?\n\/\*\*/.exec(rest)]
        .filter(Boolean)
        .map(m => m.index);
    const raw = (ends.length ? rest.slice(0, Math.min(...ends)) : rest).trim();

    return raw.replace(/;+$/, '');
}

/** The selector list travels as an argument, so it is a value rather than source. */
export const INTERACTIVE_SELECTORS = JSON.parse(loadGeneratedProbe('INTERACTIVE_SELECTORS'));

/**
 * The registry. Each entry mirrors `extension/background.js`'s PROBES:
 *
 *   source     the function, as text, evaluated in the page
 *   allFrames  default frame scope when the command does not say
 *   args       default argument when the command does not supply one
 */
export const NAMED_PROBES = {
    /** capture_dom_snapshot's element query, from the generated module. */
    snapshot: {
        source: loadGeneratedProbe('snapshot'),
        allFrames: true,
        args: () => INTERACTIVE_SELECTORS,
    },

    /** Where this frame sits on the page, as placed by its parent. */
    frameOrigin: {
        source: '() => (window.__nc_origin ?? null)',
        allFrames: true,
    },

    /**
     * Install the placement bridge in every frame. Each frame measures its own iframes
     * and tells each child its page-absolute origin; the child stores it and recurses.
     *
     * Ported from extension/background.js. Must stay in step with it — the container
     * places in-frame elements using what this writes.
     */
    installFrameBridge: {
        allFrames: true,
        source: `() => {
            if (window.__nc_seed) return true;         // already installed in this frame
            window.__nc_origin = (window === window.top) ? { x: 0, y: 0 } : null;
            window.__nc_seed = () => {
                const mine = window.__nc_origin;
                if (!mine) return false;
                const frames = document.querySelectorAll('iframe, frame');
                for (const f of frames) {
                    try {
                        const r = f.getBoundingClientRect();
                        if (r.width < 4 || r.height < 4) continue;
                        const off = { x: r.left, y: r.top };
                        f.contentWindow.postMessage(
                            { __nc: 'origin', x: mine.x + off.x, y: mine.y + off.y }, '*');
                    } catch (e) { /* a child we cannot reach is a frame we will drop */ }
                }
                return true;
            };
            window.addEventListener('message', ev => {
                const d = ev.data;
                if (!d || d.__nc !== 'origin') return;
                if (ev.source !== window.parent) return;   // only our own parent may place us
                window.__nc_origin = { x: d.x, y: d.y };
                window.__nc_seed();
            }, false);
            return true;
        }`,
    },

    /**
     * What the page SAYS, not just what can be clicked.
     *
     * Read from the same generated module as `snapshot`, so the content rules live in
     * dom_snapshot.py with everything else and there is no hand-copied twin to drift.
     */
    pageContent: {
        source: loadGeneratedProbe('pageContent'),
        allFrames: false,
    },

    /** Re-place the whole tree from the top. Runs immediately before every snapshot. */
    seedFrames: {
        allFrames: false,
        source: '() => (window.__nc_seed ? window.__nc_seed() : false)',
    },

    /**
     * Read text, because the extension lane has no Locator to read it with.
     *
     * The companion DOES have locators (locator.mjs), but this probe stays: the container
     * calls it by name today, and a lane that answered differently would be a lane that
     * behaves differently.
     */
    extractText: {
        allFrames: true,
        source: `(spec) => {
            const CAP = 6000;
            const clean = el => ((el && (el.innerText || el.textContent)) || '').replace(/\\s+\\n/g, '\\n').trim().slice(0, CAP);

            if (spec && Array.isArray(spec.selectors) && spec.selectors.length) {
                const out = {};
                for (const sel of spec.selectors) {
                    try {
                        const el = document.querySelector(sel);
                        if (el) out[sel] = clean(el);
                    } catch (e) { /* a selector this frame cannot parse is not this frame's */ }
                }
                return out;
            }

            if (spec && spec.point) {
                const origin = (window === window.top) ? { x: 0, y: 0 } : window.__nc_origin;
                if (!origin) return null;
                const el = document.elementFromPoint(spec.point.x - origin.x, spec.point.y - origin.y);
                return el ? { point: clean(el) } : null;
            }

            return { body: clean(document.body) };
        }`,
    },

    /** Cheap liveness check, for diagnosing a lane that attached but does nothing. */
    ping: {
        allFrames: false,
        source: '() => ({ ok: true, url: location.href })',
    },
};

export function probeNames() {
    return Object.keys(NAMED_PROBES);
}
