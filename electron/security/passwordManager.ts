import crypto from 'crypto';

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256-bit key
const HASH_LENGTH = 32;
const DIGEST = 'sha512';

/** Used when user skips password setup */
export const FALLBACK_PASSWORD = 'botlab-default-no-password';

/**
 * Generate a random 32-byte salt as hex string.
 */
export function generateSalt(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Derive a 256-bit AES encryption key from a password and salt.
 * Returns 64-char hex string.
 */
export function deriveEncryptionKey(password: string, salt: string): string {
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    DIGEST
  );
  return key.toString('hex');
}

/**
 * Create a verification hash for password checking.
 * Uses a different purpose prefix so the hash differs from the encryption key.
 */
export function hashForVerification(password: string, salt: string): string {
  const hash = crypto.pbkdf2Sync(
    `verify:${password}`,
    salt,
    PBKDF2_ITERATIONS,
    HASH_LENGTH,
    DIGEST
  );
  return hash.toString('hex');
}

/**
 * Verify a password against a stored hash and salt.
 */
export function verifyPassword(
  password: string,
  storedHash: string,
  salt: string
): boolean {
  const computed = hashForVerification(password, salt);
  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(storedHash, 'hex')
  );
}
