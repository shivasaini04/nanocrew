#!/usr/bin/env node
/**
 * nanocrew agent evaluation harness — Stage 20 capability work.
 *
 * For each case in cases.json:
 *   1. Dispatch the agent on a fixed task (real heavy cycle).
 *   2. Read the agent's output file.
 *   3. Score the output against criteria with an INDEPENDENT judge model
 *      (Gemini — different from the deepseek-chat the agents run on, to avoid
 *      self-grading bias). Each criterion scored 1–10, plus an overall.
 *   4. Save results to evals/results/<timestamp>.json and print a summary.
 *
 * Usage:  node evals/run-eval.mjs            (run all cases)
 *         node evals/run-eval.mjs <caseId>   (run one case)
 *
 * This is how we turn "I feel the agents could be better" into a number we can
 * track across prompt/model/verification changes.
 */
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API = 'http://localhost:3002';
const JUDGE_MODEL = 'gemini-2.0-flash';

// ─── env ────────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch { /* none */ }
  return env;
}
const ENV = loadEnv();
const GEMINI_KEY = process.env.GEMINI_API_KEY || ENV.GEMINI_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || ENV.DEEPSEEK_API_KEY;
const JUDGE_ONLY = process.argv.includes('--judge-only'); // skip the agent run; judge existing output
if (!GEMINI_KEY && !DEEPSEEK_KEY) { console.error('No GEMINI_API_KEY or DEEPSEEK_API_KEY (needed for the judge).'); process.exit(1); }

// ─── dispatch an agent cycle and wait for it to finish ────────────────────────
async function runAgent(agentId, instruction) {
  const res = await fetch(`${API}/api/agents/${agentId}/cycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cycleType: 'custom', instruction }),
  });
  if (!res.ok || !res.body) throw new Error(`cycle dispatch failed: ${res.status}`);
  // Drain the SSE — the stream closes when the cycle completes.
  const reader = res.body.getReader();
  while (true) { const { done } = await reader.read(); if (done) break; }
}

async function readOutput(agentId, outputFile) {
  // Read straight from disk (the harness runs on the host). Agents write either
  // under workspace/ or at the agent root depending on the path they chose, so
  // check both before falling back to the API.
  const candidates = [
    path.join(ROOT, 'data', 'agents', agentId, 'workspace', outputFile),
    path.join(ROOT, 'data', 'agents', agentId, outputFile),
    path.join(ROOT, 'data', 'agents', agentId, 'workspace', 'workspace', outputFile),
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8'); } catch { /* next */ } }
  try {
    const r = await fetch(`${API}/api/files/content?context=agent&contextId=${agentId}&path=${encodeURIComponent(outputFile)}`);
    if (r.ok) return await r.text();
  } catch { /* none */ }
  return '';
}

// ─── objective URL reachability (the real anti-fabrication metric) ────────────
// Extract every URL the agent stated and actually HEAD/GET-check it. A fabricated
// URL is unreachable — so % reachable is a bias-free measure of fabrication.
async function checkUrls(output) {
  const urls = [...new Set((output.match(/https?:\/\/[^\s)\]>"'`]+/g) || [])
    .map(u => u.replace(/[.,;:]+$/, '')))];
  if (urls.length === 0) return { total: 0, reachable: 0, pct: null, dead: [] };
  const dead = [];
  let reachable = 0;
  for (const u of urls) {
    let ok = false;
    for (const method of ['HEAD', 'GET']) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch(u, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (eval-harness)' } });
        clearTimeout(t);
        if (res.status < 400) { ok = true; break; }
      } catch { /* try next method */ }
    }
    if (ok) reachable++; else dead.push(u);
  }
  return { total: urls.length, reachable, pct: Math.round((reachable / urls.length) * 100), dead };
}

// ─── objective code correctness (the real anti-fabrication metric for coding) ─
// Locate the agent's solution file, copy it next to a HIDDEN ground-truth test
// the agent never saw, and run pytest. % passing is a bias-free correctness
// score — the agent can't game it by writing weak tests of its own.
function findAgentFile(agentId, fileName) {
  const base = path.join(ROOT, 'data', 'agents', agentId);
  const direct = [path.join(base, 'workspace', fileName), path.join(base, fileName)];
  for (const p of direct) { if (fs.existsSync(p)) return p; }
  const skip = new Set(['sessions', 'logs', 'memory', 'identity-history', '__pycache__', 'cycles']);
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) stack.push(fp); }
      else if (e.name === fileName) return fp;
    }
  }
  return null;
}

function runPytest(agentId, codeCheck) {
  const sol = findAgentFile(agentId, codeCheck.solutionFile);
  if (!sol) return { found: false, passed: 0, failed: 0, total: 0, pct: 0, tail: `solution file '${codeCheck.solutionFile}' not found` };
  const truth = path.join(__dirname, codeCheck.truthTest);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-eval-'));
  // Preserve the module name so the truth test's `from <module> import ...` resolves.
  fs.copyFileSync(sol, path.join(tmp, path.basename(codeCheck.solutionFile)));
  fs.copyFileSync(truth, path.join(tmp, path.basename(truth)));
  let out = '';
  try { out = execSync('python -m pytest -q --no-header', { cwd: tmp, encoding: 'utf-8', timeout: 60000 }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const num = (re) => parseInt((out.match(re) || [])[1] || '0', 10);
  const passed = num(/(\d+) passed/);
  const failed = num(/(\d+) failed/) + num(/(\d+) error/);
  const total = passed + failed;
  return {
    found: true, passed, failed, total, pct: total ? Math.round((passed / total) * 100) : 0,
    tail: out.trim().split('\n').slice(-2).join(' | ').slice(0, 300)
  };
}

// ─── judge ────────────────────────────────────────────────────────────────────
async function judge(instruction, criteria, output, urlCheck = null, codeCheck = null) {
  const rubric = criteria.map(c => `- ${c.name}: ${c.desc}`).join('\n');

  let codeCheckSection = '';
  if (codeCheck && codeCheck.found) {
    codeCheckSection = `\nOBJECTIVE CODE-CORRECTNESS EVIDENCE (Absolute Ground Truth):
The agent's solution was run against a HIDDEN test suite it never saw. Treat this as absolute ground truth for the correctness criterion:
- Ground-truth tests passed: ${codeCheck.passed}/${codeCheck.total} (${codeCheck.pct}%)
- pytest result: ${codeCheck.tail}
Score 'correctness' primarily from this pass rate (100% = correct, lower = proportionally wrong). Do not be swayed by the agent's own claims that its tests passed.
`;
  }

  let urlCheckSection = '';
  if (urlCheck && urlCheck.total > 0) {
    const allUrls = [...new Set((output.match(/https?:\/\/[^\s)\]>"'`]+/g) || [])
      .map(u => u.replace(/[.,;:]+$/, '')))];
    const reachable = allUrls.filter(u => !urlCheck.dead.includes(u));

    urlCheckSection = `\nOBJECTIVE URL CHECK EVIDENCE (Absolute Ground Truth):
We have programmatically checked the reachability of URLs in the agent's output. Treat this as absolute ground truth:
- Reachable URLs (100% REAL and functioning, NOT fabricated):
${reachable.map(u => `  - ${u}`).join('\n') || '  (None)'}
- Dead/Unreachable URLs (failed to resolve or connect):
${urlCheck.dead.map(u => `  - ${u}`).join('\n') || '  (None)'}

CRITICAL INSTRUCTION FOR THE JUDGE: 
Do NOT penalize the agent for fabrication of any company, entity, or website whose URL is listed above as REACHABLE / REAL. If a URL is reachable, it means the entity and the website exist. However, if a URL is listed as DEAD/UNREACHABLE, it is highly likely to be fabricated or incorrect, and you should penalize it accordingly under the fabrication criteria.
`;
  }

  const prompt = `You are a STRICT, skeptical evaluator of an AI agent's work. Be harsh on fabrication.

TASK GIVEN TO THE AGENT:
${instruction}
${codeCheckSection}${urlCheckSection}
CRITERIA (score each 1-10, where 10 = excellent, 1 = terrible):
${rubric}

AGENT OUTPUT:
"""
${output.slice(0, 12000)}
"""

Respond ONLY with strict JSON, no prose, in this exact shape:
{"scores":{${criteria.map(c => `"${c.name}":{"score":<1-10>,"why":"<one line>"}`).join(',')}},"overall":<1-10>,"biggest_weakness":"<2-3 lines>"}`;

  const parse = (text) => {
    let t = text.replace(/```json|```/g, '').trim();
    // Models sometimes wrap the JSON in prose or truncate it — grab the outermost object.
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s !== -1 && e > s) t = t.slice(s, e + 1);
    try { return JSON.parse(t); }
    catch {
      // Last resort: trim to the last balanced brace so a trailing-truncation still parses.
      let depth = 0, cut = -1;
      for (let i = 0; i < t.length; i++) { if (t[i] === '{') depth++; else if (t[i] === '}') { depth--; if (depth === 0) cut = i; } }
      if (cut !== -1) return JSON.parse(t.slice(0, cut + 1));
      throw new Error('judge returned unparseable JSON');
    }
  };

  // Prefer Gemini (independent of the deepseek-chat the agents run on). Fall back to
  // DeepSeek if Gemini is unavailable (note: that's same-family judging — less ideal
  // for catching its own fabrications; re-judge with Gemini when quota allows).
  if (GEMINI_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } })
        },
      );
      if (res.ok) {
        const data = await res.json();
        return { judge: JUDGE_MODEL, ...parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '') };
      }
      console.log(`  (gemini judge unavailable: ${res.status} — falling back to deepseek)`);
    } catch (e) { console.log(`  (gemini judge error: ${e.message} — falling back)`); }
  }
  if (DEEPSEEK_KEY) {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`deepseek judge failed: ${res.status}`);
    const data = await res.json();
    return { judge: 'deepseek-chat (fallback)', ...parse(data?.choices?.[0]?.message?.content ?? '') };
  }
  throw new Error('no judge available');
}

// ─── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf-8'));
  const only = process.argv[2];
  const toRun = only ? cases.filter(c => c.id === only) : cases;
  if (toRun.length === 0) { console.error('No matching cases.'); process.exit(1); }

  const results = [];
  for (const c of toRun) {
    const t0 = Date.now();
    let elapsed = 0;
    try {
      if (JUDGE_ONLY) {
        console.log(`\n▶ ${c.id} (${c.agentName}) — judge-only (reading existing output)…`);
      } else {
        console.log(`\n▶ ${c.id} (${c.agentName}) — dispatching agent…`);
        await runAgent(c.agentId, c.instruction);
        elapsed = Number(((Date.now() - t0) / 1000).toFixed(0));
        console.log(`  cycle done in ${elapsed}s — reading output…`);
      }
      const output = await readOutput(c.agentId, c.outputFile);
      if (!output.trim()) { console.log(`  ⚠ no output at ${c.outputFile} — scoring 0`); results.push({ id: c.id, error: 'no_output', overall: 0 }); continue; }

      // Objective URL reachability (bias-free fabrication metric) when requested.
      let urlCheck = null;
      if (c.urlCheck) {
        console.log(`  output: ${output.length} chars — checking every URL is real…`);
        urlCheck = await checkUrls(output);
        console.log(`  ── URL reachability: ${urlCheck.reachable}/${urlCheck.total} real${urlCheck.pct !== null ? ` (${urlCheck.pct}%)` : ''} ──`);
        if (urlCheck.dead.length) urlCheck.dead.forEach(u => console.log(`     ✗ DEAD/FABRICATED: ${u}`));
      }

      // Objective code correctness (run the agent's solution against hidden tests).
      let codeCheck = null;
      if (c.codeCheck) {
        console.log(`  running HIDDEN ground-truth tests against ${c.codeCheck.solutionFile}…`);
        codeCheck = runPytest(c.agentId, c.codeCheck);
        console.log(`  ── ground-truth tests: ${codeCheck.passed}/${codeCheck.total} passed (${codeCheck.pct}%) ──`);
        console.log(`     ${codeCheck.tail}`);
      }

      console.log(`  judging with ${JUDGE_MODEL}…`);
      const verdict = await judge(c.instruction, c.criteria, output, urlCheck, codeCheck);
      console.log(`  ── scores ──`);
      for (const [k, v] of Object.entries(verdict.scores)) console.log(`     ${k.padEnd(18)} ${v.score}/10  ${v.why}`);
      console.log(`     ${'OVERALL'.padEnd(18)} ${verdict.overall}/10`);
      console.log(`     weakness: ${verdict.biggest_weakness}`);
      results.push({ id: c.id, agent: c.agentName, elapsed_s: Number(elapsed), urlCheck, codeCheck, ...verdict });
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      results.push({ id: c.id, error: err.message, overall: 0 });
    }
  }

  // Save
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), judge: JUDGE_MODEL, results }, null, 2));

  console.log(`\n══ SUMMARY ══`);
  for (const r of results) {
    const url = r.urlCheck && r.urlCheck.pct !== null ? `  URLs real: ${r.urlCheck.reachable}/${r.urlCheck.total} (${r.urlCheck.pct}%)` : '';
    const code = r.codeCheck && r.codeCheck.found ? `  tests: ${r.codeCheck.passed}/${r.codeCheck.total} (${r.codeCheck.pct}%)` : '';
    console.log(`  ${r.id.padEnd(24)} ${String(r.overall ?? '—').padStart(2)}/10${url}${code}`);
  }
  console.log(`\nSaved → ${path.relative(ROOT, file)}`);
})();
