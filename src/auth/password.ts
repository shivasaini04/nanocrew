import bcrypt from 'bcryptjs';

// Cost factor for bcrypt. 10 is the standard default — ~50-100ms per hash, a good
// balance of brute-force resistance and login latency.
const SALT_ROUNDS = 10;

/** Hash a plaintext password for storage. Never store the plaintext. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/** Verify a plaintext password against a stored bcrypt hash. */
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
