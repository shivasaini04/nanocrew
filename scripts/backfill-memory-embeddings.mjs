/**
 * Backfill NULL embeddings on agent_memory.
 *
 * Why this exists
 * ---------------
 * `src/agents/embeddings.ts` sends `encoding_format: "float"` (the AI SDK's OpenAI-compatible
 * embedding provider always does). Gemini's embedding API rejects that parameter, so every
 * embedding call through litellm raised UnsupportedParamsError. `embedTexts()` catches and
 * returns nulls by design — so memories kept being written, just with `embedding = NULL`, and
 * nothing looked broken. Semantic recall and the 0.72 supersession-similarity gate were both
 * silently dead for every row.
 *
 * The proxy-side fix is `drop_params: true` on the embedding deployment in litellm_config.yaml.
 * That fixes new rows. This script repairs the ones written while it was broken.
 *
 * Note: db.ts has had `setMemoryEmbedding()` since Stage 34 with zero callers — written for
 * exactly this backfill, which never got built. It is deliberately NOT used here. Calling it
 * requires `initDatabase()`, which runs createSchema plus ~40 ALTER migrations; firing that
 * much DDL at a live 1.2GB prod DB from a side process, to update 31 rows, is a worse trade
 * than issuing the one UPDATE it wraps. The packing still goes through the app's own
 * `embeddingToBlob`, which is the part that actually has to match memory-distiller.
 *
 * Usage (inside the orchestrator container, where STORE_DIR and LITELLM_* are already set):
 *   docker exec nanocrew-orchestrator node /app/scripts/backfill-memory-embeddings.mjs --dry-run
 *   docker exec nanocrew-orchestrator node /app/scripts/backfill-memory-embeddings.mjs
 *
 * Safe to re-run: it only ever touches rows where `embedding IS NULL`, and it never deletes
 * or rewrites `content`. If the embedding provider is down it writes nothing and exits non-zero
 * rather than leaving a half-filled table looking complete.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { embedTexts, embeddingToBlob } from '../dist/agents/embeddings.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 16; // embedMany is atomic per call — keep batches small so one bad row can't sink 31

const storeDir = process.env.STORE_DIR || '/app/store';
const dbPath = path.join(storeDir, 'messages.db');

const read = new Database(dbPath, { readonly: true });

// Separate write handle. WAL (set by the app at startup) lets this coexist with the running
// orchestrator; busy_timeout covers the moment a live cycle happens to hold the write lock.
const write = new Database(dbPath);
write.pragma('busy_timeout = 10000');
const setEmbedding = write.prepare('UPDATE agent_memory SET embedding = ? WHERE id = ? AND embedding IS NULL');

const rows = read
  .prepare(
    `SELECT m.id, m.agent_id, m.content, a.name AS agent_name
       FROM agent_memory m
       LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.embedding IS NULL
        AND m.content IS NOT NULL
        AND TRIM(m.content) != ''
      ORDER BY m.created_at`,
  )
  .all();

const total = read.prepare('SELECT COUNT(*) c FROM agent_memory').get().c;
const nullCount = read.prepare('SELECT COUNT(*) c FROM agent_memory WHERE embedding IS NULL').get().c;

console.log(`db          : ${dbPath}`);
console.log(`agent_memory: ${total} rows, ${nullCount} with NULL embedding`);
console.log(`backfillable: ${rows.length} (non-empty content)`);
if (nullCount !== rows.length) {
  console.log(`note        : ${nullCount - rows.length} NULL row(s) have empty content and cannot be embedded`);
}

const byAgent = {};
for (const r of rows) byAgent[r.agent_name ?? r.agent_id] = (byAgent[r.agent_name ?? r.agent_id] ?? 0) + 1;
for (const [name, n] of Object.entries(byAgent)) console.log(`  ${name}: ${n}`);

if (rows.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n--dry-run: no writes performed.');
  process.exit(0);
}

let written = 0;
let failed = 0;

for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const vecs = await embedTexts(chunk.map(r => r.content));

  // embedTexts returns all-null when the provider call fails. Distinguishing "provider is
  // down" from "this row is unembeddable" matters: the first should abort loudly, not
  // quietly write nothing and report success.
  if (vecs.every(v => v === null)) {
    console.error(
      `\nFAILED: batch ${i / BATCH + 1} came back all-null — the embedding provider is rejecting calls.`,
    );
    console.error('Check litellm: the embedding deployment needs `drop_params: true`.');
    console.error(`Wrote ${written} row(s) before aborting; re-run to resume (it is idempotent).`);
    process.exit(1);
  }

  for (let j = 0; j < chunk.length; j++) {
    const vec = vecs[j];
    if (!vec) { failed++; continue; }
    written += setEmbedding.run(embeddingToBlob(vec), chunk[j].id).changes;
  }
  console.log(`  batch ${i / BATCH + 1}: +${chunk.filter((_, j) => vecs[j]).length}`);
}

const stillNull = read.prepare('SELECT COUNT(*) c FROM agent_memory WHERE embedding IS NULL').get().c;
console.log(`\nwrote ${written}, skipped ${failed}`);
console.log(`agent_memory NULL embeddings: ${nullCount} -> ${stillNull}`);
process.exit(stillNull === 0 ? 0 : 1);
