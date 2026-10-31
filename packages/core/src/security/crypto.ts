/**
 * Secret encryption at rest (spec §8.3): AES-256-GCM with Node `crypto`.
 *
 * Format: `v2:<iv>:<tag>:<ciphertext>`, each part base64; 12-byte random IV, 16-byte auth tag.
 * The key is the 64-char hex (32-byte) key from passwordManager (PBKDF2-SHA512), used directly.
 *
 * `decrypt` also reads legacy CryptoJS payloads (no `v2:` prefix): CryptoJS passphrase mode, i.e. the
 * OpenSSL format `base64("Salted__" | salt(8) | ciphertext)` with key+IV from EVP_BytesToKey(MD5, 1 round)
 * over the hex key *string* as passphrase, AES-256-CBC/PKCS7. Only used to migrate old rows to v2.
 */

import crypto from 'crypto';

const V2_PREFIX = 'v2:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(keyHex: string): Buffer {
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('Encryption key must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

/** True if the payload is already in the current (v2, AES-256-GCM) format. */
export function isV2(payload: string | null | undefined): boolean {
  return typeof payload === 'string' && payload.startsWith(V2_PREFIX);
}

export function encrypt(plaintext: string, keyHex: string): string {
  const key = keyBytes(keyHex);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${V2_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypts a v2 payload (auth tag verified) or a legacy CryptoJS payload. Throws on a wrong key or tampering. */
export function decrypt(payload: string, keyHex: string): string {
  if (!payload) throw new Error('Nothing to decrypt');
  return isV2(payload) ? decryptV2(payload, keyHex) : decryptLegacyCryptoJs(payload, keyHex);
}

function decryptV2(payload: string, keyHex: string): string {
  const key = keyBytes(keyHex);
  const parts = payload.slice(V2_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted payload');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed encrypted payload');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Decryption failed - wrong key or corrupted data');
  }
}

/** EVP_BytesToKey with MD5, one iteration (what CryptoJS uses for passphrases). */
function evpBytesToKey(passphrase: Buffer, salt: Buffer, keyLen: number, ivLen: number): { key: Buffer; iv: Buffer } {
  const out: Buffer[] = [];
  let total = 0;
  let prev = Buffer.alloc(0);
  while (total < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, passphrase, salt])).digest();
    out.push(prev);
    total += prev.length;
  }
  const all = Buffer.concat(out);
  return { key: all.subarray(0, keyLen), iv: all.subarray(keyLen, keyLen + ivLen) };
}

function decryptLegacyCryptoJs(payload: string, keyHex: string): string {
  // The legacy key is the same hex string, used by CryptoJS as a UTF-8 passphrase
  keyBytes(keyHex);
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 32 || raw.subarray(0, 8).toString('latin1') !== 'Salted__') {
    throw new Error('Malformed legacy encrypted payload');
  }
  const salt = raw.subarray(8, 16);
  const ct = raw.subarray(16);
  const { key, iv } = evpBytesToKey(Buffer.from(keyHex, 'utf8'), salt, 32, 16);
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('Decryption failed - wrong key or corrupted data');
  }
  // CBC has no integrity check: a wrong key can still pass the padding check, so require valid UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    if (!text) throw new Error('empty');
    return text;
  } catch {
    throw new Error('Decryption failed - wrong key or corrupted data');
  }
}
