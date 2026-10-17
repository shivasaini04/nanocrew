/**
 * Stage 57 phase 4 — the page checker must never become a way into the server's own network.
 */
import dns from 'dns';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchPage,
  htmlToText,
  isBlockedAddress,
  looksBlocked,
  urlProblem,
} from './page-fetch.js';
import { sandboxArgs, failureLine } from './sandbox.js';
import {
  buildJudgeMessage,
  familyOf,
  parseVote,
  pickJudges,
  runPanel,
  type JudgeSpec,
} from './judge.js';

afterEach(() => vi.restoreAllMocks());

describe('SSRF guard', () => {
  it('refuses private, loopback, link-local, shared and mapped addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.18.0.3',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isBlockedAddress(a), a).toBe(false);
  });
  it('refuses internal names, other schemes, ports and credentials before any lookup', () => {
    expect(urlProblem('http://litellm:4000/v1/models')).toMatch(/port|public/);
    expect(urlProblem('http://reacher-verifier/v0/check_email')).toMatch(
      /public/,
    );
    expect(urlProblem('http://localhost/')).toMatch(/public/);
    expect(urlProblem('file:///etc/passwd')).toMatch(/not allowed/);
    expect(urlProblem('http://169.254.169.254/latest/meta-data/')).toMatch(
      /private/,
    );
    expect(urlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
    expect(urlProblem('https://example.com/about')).toBeNull();
  });
  it('refuses a public-looking name that resolves to a private address', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _h: string,
      _o: unknown,
      cb: (e: null, a: Array<{ address: string; family: number }>) => void,
    ) => cb(null, [{ address: '10.0.0.5', family: 4 }])) as never);
    const p = await fetchPage('https://innocent.example/page');
    expect(p.ok).toBe(false);
    expect(p.via).toBe('none');
    expect(p.error).toMatch(/private address/);
  });
});

describe('page text', () => {
  it('keeps visible text and drops scripts and styles', () => {
    const t = htmlToText(
      '<html><head><style>.x{}</style><script>var secret=1</script></head><body><h1>Acme&nbsp;Corp</h1><p>HQ: San&#32;Francisco</p></body></html>',
    );
    expect(t).toContain('Acme Corp');
    expect(t).toContain('HQ: San Francisco');
    expect(t).not.toContain('secret');
  });
  it('knows a bot wall from a page', () => {
    expect(looksBlocked(403, 'x'.repeat(500))).toBe(true);
    expect(
      looksBlocked(
        200,
        'Just a moment... checking your browser' + 'x'.repeat(500),
      ),
    ).toBe(true);
    expect(looksBlocked(200, 'short')).toBe(true);
    expect(looksBlocked(200, 'Acme builds tools. '.repeat(30))).toBe(false);
  });
});

describe('sandbox — the command check is isolated', () => {
  it('has no network, no capabilities, a read-only copy of the files, and runs as nobody', () => {
    const a = sandboxArgs('run-x-t0-a1', 'pytest -q').join(' ');
    expect(a).toContain('--network none');
    expect(a).toContain('--read-only');
    expect(a).toContain('--cap-drop ALL');
    expect(a).toContain('no-new-privileges');
    expect(a).toContain('--user 65534:65534');
    expect(a).toMatch(/run-x-t0-a1:\/src:ro/);
    expect(a).toContain('--memory 512m');
    expect(a).not.toMatch(/-e [A-Z_]*(KEY|TOKEN|PASS)/);
  });
  it('explains a failure by its ERROR line, else its last line', () => {
    expect(failureLine('a\nERROR 2 rows missing\nb')).toBe(
      'ERROR 2 rows missing',
    );
    expect(failureLine('a\n\n1 failed, 2 passed\n')).toBe('1 failed, 2 passed');
  });
});

describe('judge panel', () => {
  const J: JudgeSpec[] = [
    { model: 'openrouter/z-ai/glm-5.3', weight: 1 },
    { model: 'openrouter/deepseek/deepseek-v4-flash', weight: 0.9 },
    { model: 'openrouter/deepseek/deepseek-v4-pro', weight: 0.95 },
    { model: 'openrouter/google/gemini-3.5-flash', weight: 0.8 },
  ];
  it('never lets a family judge its own work, and takes one judge per family', () => {
    expect(familyOf('openrouter/z-ai/glm-5.3-flash')).toBe('zhipu');
    expect(familyOf('gemini/gemini-3.5-flash')).toBe('google');
    expect(
      pickJudges(['openrouter/z-ai/glm-5.3-flash'], J).map((j) => j.model),
    ).toEqual([
      'openrouter/deepseek/deepseek-v4-flash',
      'openrouter/google/gemini-3.5-flash',
    ]);
  });
  it('reads a clean answer and treats anything else as a reject', () => {
    expect(
      parseVote('```json\n{"verdict":"accept","reason":"all on page"}\n```'),
    ).toMatchObject({ verdict: 'accept', readable: true });
    expect(parseVote('I think it is fine')).toMatchObject({
      verdict: 'reject',
      readable: false,
    });
    expect(parseVote('{"verdict":"maybe"}')).toMatchObject({
      verdict: 'reject',
      readable: false,
    });
  });
  it('accepts only on a strict weighted majority; a tie, an error or a mumble rejects', async () => {
    const two = [
      { model: 'a/x', weight: 1 },
      { model: 'b/y', weight: 1 },
    ];
    const say = (m: Record<string, string>) => async (model: string) => ({
      text: m[model],
      costUsd: 0.001,
    });
    const input = { objective: 'o', rubric: 'r', result: {}, pages: [] };
    expect(
      (
        await runPanel(
          input,
          two,
          say({ 'a/x': '{"verdict":"accept"}', 'b/y': '{"verdict":"accept"}' }),
        )
      ).accepted,
    ).toBe(true);
    expect(
      (
        await runPanel(
          input,
          two,
          say({ 'a/x': '{"verdict":"accept"}', 'b/y': '{"verdict":"reject"}' }),
        )
      ).accepted,
    ).toBe(false);
    expect(
      (
        await runPanel(
          input,
          two,
          say({ 'a/x': '{"verdict":"accept"}', 'b/y': 'hmm' }),
        )
      ).accepted,
    ).toBe(false);
    const failing = async (model: string) => {
      if (model === 'b/y') throw new Error('502');
      return { text: '{"verdict":"accept"}', costUsd: 0.001 };
    };
    const r = await runPanel(input, two, failing);
    expect(r.accepted).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.001);
    expect((await runPanel(input, [], failing)).accepted).toBe(false);
  });
  it('shows the judge the line holding the true value on a long page, whatever the rubric says', () => {
    const filler = Array.from(
      { length: 400 },
      (_, i) =>
        `Climbers on Mount Everest in ${1950 + (i % 70)} reached the summit ridge; metres of rope were fixed on Everest ${i}.`,
    ).join('\n');
    const page = `${filler}\nElevation 8,848.86 m (29,031.7 ft)\n${filler}`;
    const msg = buildJudgeMessage({
      objective: 'What is the elevation of Mount Everest in metres?',
      rubric:
        'The result answers the task, and every fact the task asked for is stated on a cited page. A value the worker could not find is reported as missing, not guessed.',
      result: { elevation_m: '8,849' },
      pages: [
        { url: 'https://en.wikipedia.org/wiki/Mount_Everest', text: page },
      ],
    });
    expect(msg).toContain('8,848.86');
  });
  it('gives the judge no worker identity, and varies page order between judges', () => {
    const input = {
      objective: 'o',
      rubric: 'r',
      result: { a: 1 },
      pages: [
        { url: 'https://p1.example', text: 'one' },
        { url: 'https://p2.example', text: 'two' },
        { url: 'https://p3.example', text: 'three' },
      ],
    };
    const m1 = buildJudgeMessage(input, 1);
    const m2 = buildJudgeMessage(input, 2);
    expect(m1).not.toMatch(/glm|worker model|z-ai/i);
    const order = (m: string) =>
      [...m.matchAll(/Page \d: (\S+)/g)].map((x) => x[1]).join(',');
    expect(order(m1)).not.toBe(order(m2));
  });
});
