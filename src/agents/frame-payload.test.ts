/**
 * stage45 item 2: the live browser frame carries WHERE the browser is, not just what
 * it looks like.
 *
 * The frame payload used to be `{ chatJid, cycleId, dataUrl }` — pixels and nothing
 * else — so the dashboard could show a picture of a page and not name it. The url and
 * title were state we already had on the agent side and threw away at the wire.
 *
 * Three legs have to agree or the field silently vanishes somewhere in the middle,
 * which is the exact shape of the PROXY_* failure that `proxy-env-passthrough.test.ts`
 * exists to prevent:
 *
 *   agent      react_loop._post_live_frame  ->  body carries url + title
 *   route      POST .../cycles/:id/frame    ->  reads them off the body
 *   transport  streamCycleFrame             ->  emits them on chat:frame
 *
 * The agent leg is Python and is covered by its own live harness
 * (`docs/research/stage45/spikes/frames_harness.py`, which asserts the posted body).
 * This pins the two TypeScript legs, by source, because both are a handful of lines
 * inside much larger files and neither has a seam worth mocking.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

const serverTs = readFileSync(join(SRC, 'api', 'server.ts'), 'utf-8');
const streamTs = readFileSync(join(SRC, 'cycle-activity-stream.ts'), 'utf-8');

describe('the live frame route', () => {
  it('reads url and title off the request body', () => {
    expect(serverTs).toMatch(/req\.body\?\.url/);
    expect(serverTs).toMatch(/req\.body\?\.title/);
  });

  it('caps both, because they are untrusted strings from a container', () => {
    // A page controls its own title, and a run can be steered to any URL. Neither
    // should be able to put an unbounded string into every watching dashboard.
    expect(serverTs).toMatch(
      /req\.body\?\.url === 'string'\s*\?\s*req\.body\.url\.slice\(\s*0,\s*\d+\s*\)/,
    );
    expect(serverTs).toMatch(
      /req\.body\?\.title === 'string'\s*\?\s*req\.body\.title\.slice\(\s*0,\s*\d+\s*\)/,
    );
  });

  it('still refuses anything that is not our own base64 JPEG', () => {
    // The XSS guard predates this change and must survive it: this route is
    // unauthenticated by design and the value lands in an <img src>.
    expect(serverTs).toContain("dataUrl.startsWith('data:image/jpeg;base64,')");
  });

  it('passes both through to streamCycleFrame', () => {
    // Matched on the tail of the call rather than the whole thing: the leading
    // arguments are String(req.params[...] ?? '') and a naive [^)]* cannot cross
    // their own parentheses.
    expect(serverTs).toMatch(
      /streamCycleFrame\([\s\S]*?dataUrl,\s*url,\s*title,?\s*\)/,
    );
  });
});

describe('the socket emit', () => {
  it('carries url and title alongside the pixels', () => {
    expect(streamTs).toMatch(
      /emit\('chat:frame',\s*\{[^}]*dataUrl[^}]*url[^}]*title[^}]*\}\)/s,
    );
  });

  it('defaults them to empty rather than undefined', () => {
    // Every existing caller passes three arguments. Defaults keep those working and
    // keep `undefined` out of a JSON payload the dashboard renders directly.
    expect(streamTs).toMatch(/url = '',\s*\n\s*title = '',/);
  });
});

describe('the archived-runs route', () => {
  const agentsTs = readFileSync(
    join(SRC, 'api', 'routes', 'agents.ts'),
    'utf-8',
  );

  it('exists, so the dashboard can list past browser runs', () => {
    expect(agentsTs).toContain("'/:id/browser-runs'");
  });

  it('serves no files itself — the JPEGs go through the existing workspace route', () => {
    // One file-serving path in the product means one traversal check to get right.
    // This route returns index metadata only; if it ever grows a sendFile, the
    // traversal check has to be reviewed with it.
    const route = agentsTs.slice(agentsTs.indexOf("'/:id/browser-runs'"));
    const body = route.slice(0, route.indexOf('agentsRouter.get', 10));
    expect(body).not.toMatch(/sendFile|createReadStream/);
  });
});
