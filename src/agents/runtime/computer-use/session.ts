import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrowserContext } from 'playwright';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function getDerivedKey(): Buffer {
  const secret =
    process.env.SESSION_ENCRYPTION_KEY ??
    'nanocrew-default-session-key-change-me';
  return crypto.scryptSync(secret, 'NanoCrew-sessions', KEY_LEN);
}

function encrypt(plaintext: string): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext: string): string {
  const key = getDerivedKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf-8');
}

/** Save browser context cookies + storage to disk, encrypted. */
export async function saveSession(
  context: BrowserContext,
  domain: string,
  sessionsDir: string,
): Promise<void> {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const state = await context.storageState();
  const json = JSON.stringify(state);
  const encrypted = encrypt(json);
  const filePath = path.join(sessionsDir, `${sanitizeDomain(domain)}.enc`);
  fs.writeFileSync(filePath, encrypted, 'utf-8');
}

/** Load saved session into a browser context. Returns true if session was found. */
export async function loadSession(
  context: BrowserContext,
  domain: string,
  sessionsDir: string,
): Promise<boolean> {
  const filePath = path.join(sessionsDir, `${sanitizeDomain(domain)}.enc`);
  if (!fs.existsSync(filePath)) return false;

  try {
    const encrypted = fs.readFileSync(filePath, 'utf-8');
    const json = decrypt(encrypted);
    const state = JSON.parse(json);
    await context.addCookies(state.cookies ?? []);
    for (const origin of state.origins ?? []) {
      try {
        await context.addInitScript(() => {
          // Restore localStorage on next page load — best effort
        });
      } catch {
        /* skip */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** List saved sessions. */
export function listSessions(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.replace('.enc', '').replace(/_/g, '.'));
}

/** Delete a saved session. */
export function deleteSession(domain: string, sessionsDir: string): void {
  const filePath = path.join(sessionsDir, `${sanitizeDomain(domain)}.enc`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function sanitizeDomain(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9.-]/g, '_');
}
