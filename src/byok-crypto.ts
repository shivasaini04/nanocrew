/**
 * BYOK key encryption — AES-256-GCM keyed by nanocrew_SECRET_KEY. Shared by the account
 * route (encrypt on save) and the cycle runner (decrypt to inject the client's key).
 */
import crypto from 'crypto';

function secretKey(): Buffer {
  const seed = process.env.nanocrew_SECRET_KEY || 'nanocrew-secrets-fallback';
  return crypto.createHash('sha256').update(seed).digest();
}

export function encryptByok(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const e = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
}

export function decryptByok(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  d.setAuthTag(authTag);
  return d.update(encrypted) + d.final('utf8');
}
