/**
 * Master key loading (spec §8.3). Order:
 * 1. `BOTLAB_MASTER_KEY` — 64 hex characters;
 * 2. `BOTLAB_MASTER_KEY_FILE` — a file containing them (whitespace ignored);
 * 3. `<dataDir>/master.key`, if it exists;
 * 4. not production: a new key is generated into `<dataDir>/master.key` (mode 0600 where the OS
 *    supports it) with a warning. In production a missing key is fatal (generate one with
 *    `npm run cli -- gen-key --prod`, or set the variables).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isValidMasterKey } from '../../../packages/core/src/security/masterKey';

export type MasterKeySource = 'env' | 'file' | 'data-dir' | 'generated';

export interface LoadedMasterKey {
  key: string;
  source: MasterKeySource;
  file?: string;
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

export function defaultKeyFile(dataDir: string): string {
  return path.join(dataDir, 'master.key');
}

function readKeyFile(file: string, what: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new MasterKeyError(`${what}: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const key = text.replace(/\s+/g, '');
  if (!isValidMasterKey(key)) throw new MasterKeyError(`${what}: ${file} must contain 64 hex characters (32 bytes)`);
  return key.toLowerCase();
}

/** Writes a new random key to `file` (fails if it exists). Returns the key. */
export function generateKeyFile(file: string): string {
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 'wx': never overwrite an existing key; mode 0600 (ignored on Windows, where the per-user profile ACL applies)
  fs.writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return key;
}

export function loadMasterKey(opts: { env?: NodeJS.ProcessEnv; dataDir: string; production: boolean; log?: (msg: string) => void }): LoadedMasterKey {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.warn(m));
  if (env.BOTLAB_MASTER_KEY) {
    const key = env.BOTLAB_MASTER_KEY.trim();
    if (!isValidMasterKey(key)) throw new MasterKeyError('BOTLAB_MASTER_KEY must be 64 hex characters (32 bytes); generate one with `openssl rand -hex 32`');
    return { key: key.toLowerCase(), source: 'env' };
  }
  if (env.BOTLAB_MASTER_KEY_FILE) {
    const file = path.resolve(env.BOTLAB_MASTER_KEY_FILE);
    return { key: readKeyFile(file, 'BOTLAB_MASTER_KEY_FILE'), source: 'file', file };
  }
  const file = defaultKeyFile(opts.dataDir);
  if (fs.existsSync(file)) return { key: readKeyFile(file, 'master key'), source: 'data-dir', file };
  if (opts.production) {
    throw new MasterKeyError(
      `No master key. Set BOTLAB_MASTER_KEY (64 hex) or BOTLAB_MASTER_KEY_FILE, or create ${file} with \`npm run cli -- gen-key --prod\`. ` +
        'Keep a copy of the key somewhere safe: without it the wallet keys in the database cannot be decrypted.'
    );
  }
  const key = generateKeyFile(file);
  log(
    `[Server] WARNING: no BOTLAB_MASTER_KEY / BOTLAB_MASTER_KEY_FILE set; generated a new master key in ${file}. ` +
      'It encrypts wallet keys and exchange credentials: back it up, and keep it out of git and shared folders.'
  );
  return { key, source: 'generated', file };
}
