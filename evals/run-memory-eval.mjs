#!/usr/bin/env node
/**
 * Memory-recall eval — does an agent still know what you told it, N turns later?
 *
 * Every number governing how an agent forgets was chosen by feel and has never been
 * measured: the 100k compaction threshold, the 100-message replay window, keep_tail=8,
 * and the 20/45/70 phase boundaries. This turns "I feel like it gets worse in long
 * conversations" into a number that moves when those knobs move.
 *
 * Deliberately objective — no judge model. Each planted fact is a random token the
 * agent cannot infer, guess, or reconstruct from context, so grading is exact-substring
 * presence and there is no self-grading bias to argue about. Contrast run-eval.mjs,
 * which needs a judge because "is this dossier good?" has no ground truth.
 *
 * Four phases:
 *   1. plant    — one cycle per fact, each stating one unguessable value
 *   2. bury     — filler cycles, each padded, to drive context depth. Padding rather
 *                 than sheer turn count because compaction triggers on TOKENS; reaching
 *                 the threshold by conversation length alone would cost hours.
 *   3. probe    — ask for every fact back, cold
 *   4. recover  — ask again, this time explicitly allowed to grep memory/HISTORY.md
 *
 * The probe→recover delta is the interesting number: it is exactly what the archive of
 * compaction-evicted context buys. If recall@probe is low and recall@recover is high,
 * forgetting is recoverable and the fix is retrieval. If both are low, the information
 * is genuinely gone and the fix is upstream — a lower threshold, or writing state to
 * files instead of trusting the conversation.
 *
 * Usage:
 *   node evals/run-memory-eval.mjs [options]
 *
 *   --base <url>     API base (default http://localhost:3002). Works against a remote
 *                    instance — answers are read back over the files API when the
 *                    harness is not on the same host as the agent data.
 *   --agent <id>     Run against an existing agent. Omit to create a disposable one,
 *                    which is strongly preferred: the eval plants junk facts into
 *                    whatever session it touches, and a disposable agent is deleted
 *                    afterwards so nothing is left contaminated.
 *   --facts <n>      Facts to plant (default 5)
 *   --turns <n>      Filler turns between planting and probing (default 12)
 *   --pad <chars>    Filler text per bury turn (default 35000; 0 disables padding).
 *                    Defaults are sized to actually cross the 100k compaction threshold
 *                    — 12 x 35k chars is roughly 105k tokens once the session replays.
 *                    Lower them and the run finishes without ever compacting, which
 *                    measures nothing; the harness warns when that happens.
 *   --keep           Don't clean up afterwards (keeps the agent + its session)
 *
 * Auth: --email/--password, or NANOCREW_EMAIL / NANOCREW_PASSWORD. Required — every
 * /api route sits behind requireAuth. (Note: run-eval.mjs in this directory still
 * sends no cookie, so it 401s against any build after auth landed.)
 *
 * Cost: roughly (facts + turns + 2) real cycles. At default settings ~17.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = 'eval-output/recall.txt';

// ─── args ─────────────────────────────────────────────────────────────────────

const args = (() => {
    const out = { base: 'http://localhost:3002', facts: 5, turns: 12, pad: 35000 };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--keep') out.keep = true;
        else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    }
    for (const k of ['facts', 'turns', 'pad']) out[k] = Number(out[k]);
    out.email ??= process.env.NANOCREW_EMAIL;
    out.password ??= process.env.NANOCREW_PASSWORD;
    return out;
})();

if (!args.email || !args.password) {
    console.error('Need --email and --password (or NANOCREW_EMAIL / NANOCREW_PASSWORD).');
    process.exit(1);
}
let createdAgent = false;   // set when this run provisioned its own throwaway agent

// ─── facts ────────────────────────────────────────────────────────────────────
// Values must be unguessable: if a model could reconstruct one from context, a
// "recall" would really be a lucky inference and the whole measurement is worthless.
// Random hex satisfies that and stays short enough to survive a truncating summary.

const ADJ = ['velvet', 'amber', 'crooked', 'quiet', 'copper', 'hollow', 'brisk', 'salted'];
const NOUN = ['otter', 'lantern', 'harbor', 'thistle', 'ledger', 'compass', 'marrow', 'kestrel'];

function makeFacts(n) {
    const facts = [];
    for (let i = 0; i < n; i++) {
        const id = `CANARY-${i + 1}`;
        const value = `${ADJ[i % ADJ.length]}-${NOUN[(i * 3) % NOUN.length]}-${randomUUID().slice(0, 6)}`;
        facts.push({ id, value });
    }
    return facts;
}

// ─── http ─────────────────────────────────────────────────────────────────────

let cookie = '';

async function api(method, endpoint, body) {
    const res = await fetch(`${args.base}${endpoint}`, {
        method,
        headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of setCookies) if (c.startsWith('nanocrew_sid=')) cookie = c.split(';')[0];
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Run one cycle and wait for it. The SSE closes when the cycle ends. */
async function cycle(instruction) {
    const res = await fetch(`${args.base}/api/agents/${args.agent}/cycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
        body: JSON.stringify({ cycleType: 'custom', instruction }),
    });
    if (!res.ok || !res.body) throw new Error(`cycle dispatch failed: ${res.status}`);
    // Watch the stream for compaction events — the whole point is to know whether the
    // run actually exercised the path under test. A run that never compacted proves
    // nothing about compaction, and would otherwise look like a clean pass.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', compactions = 0, unarchived = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const line of buf.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            if (!line.includes('compaction_phases')) continue;
            compactions++;
            if (/"archived"\s*:\s*false/.test(line)) unarchived++;
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
    }
    return { compactions, unarchived };
}

/** Read the agent's answer file — disk first (harness runs on the host), API as fallback. */
async function readAnswer() {
    const candidates = [
        path.join(ROOT, 'data', 'agents', args.agent, 'workspace', OUTPUT_FILE),
        path.join(ROOT, 'data', 'agents', args.agent, OUTPUT_FILE),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8'); } catch { /* next */ }
    }
    try {
        const r = await api('GET', `/api/files/content?context=agent&contextId=${args.agent}&path=${encodeURIComponent(OUTPUT_FILE)}`);
        return typeof r === 'string' ? r : (r.raw ?? r.content ?? '');
    } catch { return ''; }
}

function score(answer, facts) {
    const hay = answer.toLowerCase();
    const per = facts.map(f => ({ id: f.id, value: f.value, recalled: hay.includes(f.value.toLowerCase()) }));
    const hits = per.filter(p => p.recalled).length;
    return { hits, total: facts.length, pct: Math.round((hits / facts.length) * 100), per };
}

// ─── run ──────────────────────────────────────────────────────────────────────

const PAD_SENTENCE =
    'For background, the team reviewed the quarterly operating notes and confirmed the ' +
    'existing process documentation remains accurate for the current reporting period. ';

async function main() {
    const facts = makeFacts(args.facts);
    const stats = { compactions: 0, unarchived: 0 };
    const note = (r) => { stats.compactions += r.compactions; stats.unarchived += r.unarchived; };

    await api('POST', '/api/auth/login', { email: args.email, password: args.password });

    if (!args.agent) {
        // on_demand so it can never schedule itself; the eval drives every cycle by hand.
        const agent = await api('POST', '/api/agents', {
            name: `Memory Eval ${new Date().toISOString().slice(0, 16)}`,
            type: 'custom',
            emoji: '🧪',
            config: {
                role: 'Memory Eval Subject',
                goals: 'Answer exactly what is asked. Never guess a value you were not given.',
                schedule: [], triggerMode: 'on_demand', escalationRules: [], tools: [],
                budget: { daily: 5, monthly: 20, onExhaust: 'pause' },
            },
        });
        args.agent = agent.id;
        createdAgent = true;
        console.log(`✓ logged in — created disposable agent ${agent.id}`);
    } else {
        console.log(`✓ logged in — using existing agent ${args.agent}`);
        console.log('  ! this run will plant junk facts into that agent\'s real session.');
    }
    console.log(`  plan: ${args.facts} facts, ${args.turns} filler turns, ${args.pad} pad chars/turn`);
    console.log(`  cost: ~${args.facts + args.turns + 2} real cycles\n`);

    // 1. Plant
    for (const f of facts) {
        note(await cycle(
            `Remember this exactly, it will be needed later: the value of ${f.id} is "${f.value}". ` +
            `Reply with just "noted". Do not write any files.`
        ));
        console.log(`  planted ${f.id} = ${f.value}`);
    }

    // 2. Bury
    const pad = args.pad > 0 ? PAD_SENTENCE.repeat(Math.ceil(args.pad / PAD_SENTENCE.length)).slice(0, args.pad) : '';
    for (let i = 1; i <= args.turns; i++) {
        note(await cycle(
            `Filler turn ${i} of ${args.turns} — no action needed, reply "ok". ` +
            `Do not write any files.${pad ? `\n\nContext for the record:\n${pad}` : ''}`
        ));
        process.stdout.write(`\r  buried ${i}/${args.turns} (compactions so far: ${stats.compactions})   `);
    }
    console.log('');

    // 3. Probe — cold recall
    const ask = facts.map(f => f.id).join(', ');
    note(await cycle(
        `List the exact values of ${ask} that I gave you earlier. ` +
        `Write them to ${OUTPUT_FILE}, one "ID = value" per line, and nothing else. ` +
        `If you genuinely do not remember one, write "ID = UNKNOWN" — do NOT guess or invent a value.`
    ));
    const cold = score(await readAnswer(), facts);
    console.log(`\n  recall@probe:   ${cold.hits}/${cold.total} (${cold.pct}%)`);

    // 4. Recover — same question, retrieval allowed
    note(await cycle(
        `Again list the exact values of ${ask}. This time, if you do not remember one, ` +
        `search for it: grep memory/HISTORY.md and your memory files before answering. ` +
        `Overwrite ${OUTPUT_FILE} with one "ID = value" per line, and nothing else. ` +
        `Write "ID = UNKNOWN" only if the search genuinely finds nothing — never guess.`
    ));
    const warm = score(await readAnswer(), facts);
    console.log(`  recall@recover: ${warm.hits}/${warm.total} (${warm.pct}%)`);
    console.log(`  retrieval gain: +${warm.pct - cold.pct} points`);
    console.log(`  compactions: ${stats.compactions}${stats.unarchived ? ` (${stats.unarchived} with NO archive — history lost unrecoverably)` : ''}`);

    if (stats.compactions === 0) {
        console.log('\n  ! No compaction fired — this run did not exercise the path under test.');
        console.log('    Raise --pad or --turns, or lower compaction.threshold_tokens.');
    }

    const result = {
        at: new Date().toISOString(),
        agent: args.agent,
        config: { facts: args.facts, turns: args.turns, pad: args.pad },
        compactions: stats.compactions,
        compactionsWithoutArchive: stats.unarchived,
        recallCold: cold,
        recallWarm: warm,
        retrievalGain: warm.pct - cold.pct,
    };
    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `memory-${result.at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`\n→ ${path.relative(ROOT, out)}`);

    if (!args.keep) await cleanup();
}

/**
 * Dispose of the planted facts, which is harder than it looks.
 *
 * `DELETE /api/agents/:id/chat/history` only drops the DB rows the chat UI renders. In
 * persistent-session mode the conversation the model actually replays lives in a nanobot
 * session JSONL on disk that no API touches — so clearing via that endpoint alone leaves
 * every planted fact in place and contaminates the next run's cold-recall number with
 * facts the agent never had to remember.
 *
 * Deleting a disposable agent sidesteps that entirely: it hard-deletes the workspace, so
 * the session goes with it. That is the only reset that works against a remote instance,
 * which is why creating one is the default.
 */
async function cleanup() {
    if (createdAgent) {
        try {
            await api('DELETE', `/api/agents/${args.agent}`);
            console.log('  disposable agent deleted — session gone with it (--keep to preserve)');
        } catch (e) {
            console.log(`  ! could not delete agent ${args.agent}: ${e.message}. Remove it by hand.`);
        }
        return;
    }

    // Existing agent: best effort, and only possible when running on the agent's own host.
    let cleared = 0;
    try {
        const dir = path.join(ROOT, 'data', 'agents', args.agent, 'sessions');
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(`agent-${args.agent}`) && f.endsWith('.jsonl')) {
                fs.rmSync(path.join(dir, f)); cleared++;
            }
        }
    } catch { /* not on this host, or no sessions dir */ }
    await api('DELETE', `/api/agents/${args.agent}/chat/history`).catch(() => { /* best effort */ });

    if (cleared > 0) console.log(`  session reset — ${cleared} file(s) cleared`);
    else console.log('  ! session file not reachable from here, so the planted facts are STILL in that agent\'s memory. Clear them on the agent host before the next run, or use a disposable agent next time.');
}

main().catch(err => { console.error(`\n✗ ${err.message}`); process.exit(1); });
