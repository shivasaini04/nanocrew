/**
 * Shared AES-256-GCM for the two encrypted stores, with key rotation that does not
 * destroy what is already stored.
 *
 * Both stores derived their key in a way that made the key impossible to change safely:
 *
 *   - `secrets-manager` fell back to sha256('nanocrew-secrets-fallback') when
 *     `nanocrew_SECRET_KEY` was unset — and it was unset in production, so every user
 *     secret sat under a constant any reader of this repo can compute. Setting the real
 *     key would have orphaned all of them.
 *   - `credential-manager` keyed off **`ANTHROPIC_API_KEY`**, a rotatable provider
 *     credential. Rotating that key — an ordinary, encouraged security action — silently
 *     made every stored credential undecryptable.
 *
 * In both cases the failure is silent: callers wrap `decrypt` in `catch { skip }`, so a
 * key change does not error, it just makes credentials quietly disappear and agents report
 * "not connected" for no visible reason.
 *
 * The fix is to accept several keys for READING and only ever write with the current one.
 * `decryptWithMigration` reports which key opened the value, so callers can re-encrypt in
 * place — the store converts itself as it is used, with no migration step to run and no
 * window where a value is unreadable.
 */
import crypto from 'crypto';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

let _warnedMissingKey = false;

function keyFrom(seed: string): Buffer {
  return crypto.createHash('sha256').update(seed).digest();
}

/** The key new values are written with. */
export function primaryKey(): Buffer {
  // process.env first, then the mounted .env file. The second lookup matters: prod mounts
  // .env into the container but only variables explicitly listed in the compose
  // `environment:` block reach process.env — the compose comment claiming `--env-file`
  // loads everything into the app's environment is wrong, and `--env-file` only feeds
  // compose's own ${VAR} interpolation. Without this fallback, setting the key in .env
  // looks like it worked and silently does nothing.
  const seed =
    process.env.nanocrew_SECRET_KEY ||
    readEnvFile(['nanocrew_SECRET_KEY'])['nanocrew_SECRET_KEY'];
  if (seed) return keyFrom(seed);
  if (!_warnedMissingKey) {
    _warnedMissingKey = true;
    logger.warn(
      'nanocrew_SECRET_KEY is not set — secrets and credentials are encrypted with a ' +
        'constant derivable from the source. Set it in .env; existing values re-encrypt ' +
        'themselves on next read.',
    );
  }
  return keyFrom('nanocrew-secrets-fallback');
}

/**
 * Keys accepted when reading, newest first. Every historical derivation stays here — a
 * value encrypted under any of them must remain readable, or setting the real key
 * destroys production data.
 */
function readKeys(): Buffer[] {
  const keys: Buffer[] = [primaryKey()];
  keys.push(keyFrom('nanocrew-secrets-fallback')); // secrets-manager legacy
  if (process.env.ANTHROPIC_API_KEY) {
    keys.push(keyFrom(process.env.ANTHROPIC_API_KEY)); // credential-manager legacy
  }
  keys.push(keyFrom('NanoCrew-default-key')); // credential-manager legacy default
  return keys;
}

/**
 * A stable per-agent seed for the effector browser-session vault (stage 49 phase 2).
 *
 * The vault used to key itself off `NANOCREW_CYCLE_TOKEN`, which is `randomBytes(32)`
 * minted fresh for every cycle and revoked when it ends (`cycle-token.ts`). So the vault
 * written in cycle A could never be decrypted in cycle B — `SessionVault.load_session`
 * caught the failure, returned None, and the agent silently opened a logged-out browser.
 * The effector tool's own promise, "logs in once, reuses the session on later calls",
 * only ever held inside a single cycle.
 *
 * Derived, not stored: HMAC of the server's master key over the agent id. Nothing new to
 * persist, stable for the life of the agent, and — the point — the secret stays on the
 * server. The workspace holds only ciphertext, so taking the workspace alone no longer
 * yields the logins. Rotating `nanocrew_SECRET_KEY` orphans saved sessions, which is
 * survivable in a way rotating it on `secrets`/`credentials` is not: a session is a
 * cache of a login, and the worst case is the agent logs in again.
 *
 * Per-agent rather than per-owner so one agent's stolen workspace cannot be combined
 * with the key to open a sibling agent's sessions.
 */
export function deriveVaultSecret(agentId: string): string {
  return crypto
    .createHmac('sha256', primaryKey())
    .update(`effector-session-vault:v1:${agentId}`)
    .digest('hex');
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', primaryKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptWith(key: Buffer, ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    buf.subarray(0, 12),
  );
  decipher.setAuthTag(buf.subarray(12, 28));
  return decipher.update(buf.subarray(28)) + decipher.final('utf8');
}

/**
 * Decrypt with whichever accepted key works.
 *
 * `staleKey` is true when a legacy key opened it, meaning the caller should re-encrypt and
 * save. GCM authenticates, so a wrong key throws rather than returning garbage — trying
 * keys in turn is safe, not a guess.
 */
export function decryptWithMigration(ciphertext: string): {
  plaintext: string;
  staleKey: boolean;
} {
  const keys = readKeys();
  for (let i = 0; i < keys.length; i++) {
    try {
      return { plaintext: decryptWith(keys[i], ciphertext), staleKey: i > 0 };
    } catch {
      // wrong key — try the next
    }
  }
  throw new Error('Could not decrypt with any known key');
}

/** Convenience for callers that do not re-encrypt. */
export function decrypt(ciphertext: string): string {
  return decryptWithMigration(ciphertext).plaintext;
}
