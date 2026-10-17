/**
 * Locators — the thing the extension lane could never have (stage 52 step 3).
 *
 * ## What this actually buys
 *
 * `remote_page.py:26` says every element from the remote lane is `coordinate_only`, and
 * the resolver therefore skips its locator layers and fires at a page-absolute point.
 * That works, and it is how the lane has run since stage 45. It is also fragile in one
 * specific way: a coordinate is resolved ONCE, when the snapshot is taken, and used some
 * seconds later. Anything that moves the page in between — a cookie banner rendering, an
 * async list settling, an image finally loading and pushing everything down — sends the
 * click to whatever now occupies that pixel. The click succeeds. The wrong thing is
 * clicked. Nothing reports an error.
 *
 * A Locator re-resolves at the moment of the action, waits for the element to be visible,
 * stable, enabled and unobscured, and retries until it is or the timeout expires. That is
 * not a small refinement — on real pages it is the difference between an agent that
 * mostly works and one that quietly does the wrong thing.
 *
 * Playwright's Locator is not a selector string; it is an engine (auto-wait, actionability,
 * retry). `remote_page.py:365-369` refuses to reimplement it over the extension bridge
 * because that would be a second, subtly different engine. The companion does not need to
 * reimplement anything: it holds a real Playwright Page, so it runs the real engine and
 * only the RESULT crosses the wire.
 *
 * ## The selector vocabulary
 *
 * A spec, not a raw string, so the container can say what it means and this can pick the
 * right Playwright builder:
 *
 *     { css: '#submit' }
 *     { text: 'Sign in', exact: false }
 *     { role: 'button', name: 'Send' }
 *     { label: 'Email' } | { placeholder: 'Search' } | { testId: 'submit' }
 *
 * Plus optional refinements applied in order: `nth`, `hasText`, `within` (another spec).
 *
 * Raw CSS is included deliberately even though the role/text builders are better practice:
 * the container's DOM snapshot already yields CSS paths, so this is the form that needs no
 * change on the Python side to become useful.
 */

/** Build a Playwright Locator from a spec. Throws on a spec naming nothing. */
export function buildLocator(root, spec) {
    if (!spec || typeof spec !== 'object') throw new Error('locator spec must be an object');

    let loc;
    if (spec.css) loc = root.locator(String(spec.css));
    else if (spec.testId) loc = root.getByTestId(String(spec.testId));
    else if (spec.role) {
        const opts = {};
        if (spec.name != null) opts.name = String(spec.name);
        if (spec.exact != null) opts.exact = Boolean(spec.exact);
        loc = root.getByRole(String(spec.role), opts);
    } else if (spec.text != null) {
        loc = root.getByText(String(spec.text), { exact: Boolean(spec.exact) });
    } else if (spec.label != null) {
        loc = root.getByLabel(String(spec.label), { exact: Boolean(spec.exact) });
    } else if (spec.placeholder != null) {
        loc = root.getByPlaceholder(String(spec.placeholder), { exact: Boolean(spec.exact) });
    } else if (spec.altText != null) {
        loc = root.getByAltText(String(spec.altText), { exact: Boolean(spec.exact) });
    } else if (spec.title != null) {
        loc = root.getByTitle(String(spec.title), { exact: Boolean(spec.exact) });
    } else {
        throw new Error(
            `locator spec named nothing: expected one of css/role/text/label/placeholder/` +
            `testId/altText/title, got ${JSON.stringify(Object.keys(spec))}`,
        );
    }

    // Refinements, in the order Playwright applies them. `within` first because it
    // changes what the rest are relative to.
    if (spec.within) loc = buildLocator(root, spec.within).locator(loc);
    if (spec.hasText != null) loc = loc.filter({ hasText: String(spec.hasText) });
    if (typeof spec.nth === 'number') loc = loc.nth(spec.nth);
    else if (spec.first) loc = loc.first();
    else if (spec.last) loc = loc.last();

    return loc;
}

/**
 * `locator.query` — what is there, without touching it.
 *
 * Returns bounds so the caller can still fall back to a coordinate if it wants one, which
 * keeps this additive: a container that does not understand locators loses nothing, and a
 * container that does can check `count` before acting rather than clicking into the dark.
 */
export async function locatorQuery(page, payload) {
    const { spec, timeoutMs = 5000, includeText = true, limit = 20 } = payload;
    const loc = buildLocator(page, spec);

    // count() does not auto-wait — it answers about right now. Waiting for the first match
    // first is what makes a slow-rendering page report 1 rather than 0.
    let count = 0;
    try {
        await loc.first().waitFor({ state: 'attached', timeout: timeoutMs });
        count = await loc.count();
    } catch {
        return { count: 0, matches: [], timedOut: true };
    }

    const matches = [];
    for (let i = 0; i < Math.min(count, limit); i++) {
        const one = loc.nth(i);
        try {
            const box = await one.boundingBox();
            matches.push({
                index: i,
                // A detached or display:none element has no box. Reporting null rather
                // than skipping keeps indexes aligned with what count() said.
                bounds: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
                visible: await one.isVisible().catch(() => false),
                enabled: await one.isEnabled().catch(() => false),
                text: includeText ? (await one.innerText().catch(() => '')).slice(0, 500) : undefined,
            });
        } catch (err) {
            matches.push({ index: i, error: String(err?.message ?? err) });
        }
    }

    return { count, matches, timedOut: false };
}

/**
 * `locator.act` — do something to a match, with the full actionability engine behind it.
 *
 * Every action here has a coordinate equivalent the lane already had. The difference is
 * that these wait for the element to be ready and re-resolve if the page moved, so the
 * failure mode changes from "clicked the wrong thing silently" to "raised a timeout that
 * names the selector".
 */
export async function locatorAct(page, payload) {
    const { spec, action, value, timeoutMs = 15_000, force = false } = payload;
    const loc = buildLocator(page, spec);
    const opts = { timeout: timeoutMs, force };

    switch (action) {
        case 'click':
            await loc.click(opts);
            return { ok: true, action };

        case 'dblclick':
            await loc.dblclick(opts);
            return { ok: true, action };

        case 'hover':
            await loc.hover(opts);
            return { ok: true, action };

        case 'fill':
            // fill() clears first and dispatches the input events frameworks listen for.
            // Typing character-by-character into a React field without them leaves the
            // DOM right and the component's state empty.
            await loc.fill(String(value ?? ''), opts);
            return { ok: true, action };

        case 'type':
            // When a field genuinely needs per-character keystrokes (an autocomplete that
            // only fires on keydown), this is the escape hatch.
            await loc.pressSequentially(String(value ?? ''), opts);
            return { ok: true, action };

        case 'press':
            await loc.press(String(value ?? ''), opts);
            return { ok: true, action };

        case 'check':
            await loc.check(opts);
            return { ok: true, action };

        case 'uncheck':
            await loc.uncheck(opts);
            return { ok: true, action };

        case 'selectOption':
            await loc.selectOption(value, opts);
            return { ok: true, action };

        case 'scrollIntoView':
            await loc.scrollIntoViewIfNeeded(opts);
            return { ok: true, action };

        case 'text': {
            const text = await loc.innerText(opts);
            return { ok: true, action, text };
        }

        case 'attribute': {
            const attr = await loc.getAttribute(String(value ?? ''), opts);
            return { ok: true, action, value: attr };
        }

        default:
            throw new Error(
                `unknown locator action: ${action}. Expected click, dblclick, hover, fill, ` +
                `type, press, check, uncheck, selectOption, scrollIntoView, text or attribute.`,
            );
    }
}
