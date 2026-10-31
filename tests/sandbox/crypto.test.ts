/**
 * Secrets at rest (spec §8.3): AES-256-GCM v2, legacy CryptoJS payloads, one-time migration.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { decrypt, encrypt, isV2 } from '../../packages/core/src/security/crypto';
import { migrateSecretsToV2 } from '../../packages/core/src/security/migrateSecrets';
import { openTestDb, sqliteAvailable } from '../orders/db';

const KEY = '0f'.repeat(32);
const OTHER_KEY = 'a1'.repeat(32);

// Generated with crypto-js 4.2.0: CryptoJS.AES.encrypt(plaintext, KEY).toString()
const LEGACY = {
  privateKey: {
    payload: 'U2FsdGVkX19cSO3LUIeWs1U+snmVcXROtB9/a15XXMkhgVSTPCWIiNElZYiiIntFYlGe1nH5ynCmYcJE96LDWGAWhmH2r/94hqoSOu5MqSMn5K4tgiUp4G/FS5YncrBT',
    plain: 'ab'.repeat(32),
  },
  apiKey: { payload: 'U2FsdGVkX18flE9STa57zD6xMbVtR+wcPiQob8AHqd32mMCpFsxzrLGvHbIjRdZu', plain: 'binance-api-key-123' },
  unicode: { payload: 'U2FsdGVkX1/lnuCtU1ZKjBG0hkSkzODOBg3sgxFSPI4=', plain: 'sécret ✓' },
};

describe('AES-256-GCM v2', () => {
  it('round-trips with a random IV per encryption', () => {
    const a = encrypt('hello ✓', KEY);
    const b = encrypt('hello ✓', KEY);
    expect(a).toMatch(/^v2:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe('hello ✓');
    expect(decrypt(b, KEY)).toBe('hello ✓');
  });

  it('detects tampering (auth tag) and a wrong key', () => {
    const payload = encrypt('secret value', KEY);
    const [v, iv, tag, ct] = payload.split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64')].join(':'), KEY)).toThrow(/Decryption failed/);
    const badTag = Buffer.from(tag, 'base64');
    badTag[0] ^= 1;
    expect(() => decrypt([v, iv, badTag.toString('base64'), ct].join(':'), KEY)).toThrow(/Decryption failed/);
    expect(() => decrypt(payload, OTHER_KEY)).toThrow(/Decryption failed/);
  });

  it('requires a 64-hex key', () => {
    expect(() => encrypt('x', 'short')).toThrow(/64 hex/);
  });

  it('decrypts legacy CryptoJS payloads', () => {
    for (const { payload, plain } of Object.values(LEGACY)) {
      expect(isV2(payload)).toBe(false);
      expect(decrypt(payload, KEY)).toBe(plain);
    }
    expect(() => decrypt(LEGACY.apiKey.payload, OTHER_KEY)).toThrow(/Decryption failed/);
  });
});

describe.skipIf(!sqliteAvailable)('migrateSecretsToV2', () => {
  it('re-encrypts wallet keys and settings secrets once (idempotent) and audits', () => {
    const t = openTestDb();
    try {
      const { db } = t;
      db.prepare('UPDATE wallets SET private_key_encrypted = ? WHERE id = ?').run(LEGACY.privateKey.payload, 'w1');
      const alreadyV2 = encrypt('cd'.repeat(32), KEY);
      db.prepare(`INSERT INTO wallets (id, name, address, private_key_encrypted) VALUES ('w2', 'w2', '0xdef', ?)`).run(alreadyV2);
      db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES ('global')`).run();
      db.prepare(`UPDATE settings SET binance_api_key_encrypted = ?, binance_api_secret_encrypted = ? WHERE id = 'global'`).run(LEGACY.apiKey.payload, LEGACY.unicode.payload);

      const audit = { record: vi.fn() };
      const first = migrateSecretsToV2(db, KEY, audit as never);
      expect(first).toEqual({ wallets: 1, settingsFields: ['binance_api_key_encrypted', 'binance_api_secret_encrypted'], failed: [] });
      expect(audit.record).toHaveBeenCalledWith('system', 'secrets.migrate_v2', null, first, 'ok');

      const w1 = db.prepare(`SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'`).get() as { v: string };
      const w2 = db.prepare(`SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w2'`).get() as { v: string };
      const s = db.prepare(`SELECT * FROM settings WHERE id = 'global'`).get() as Record<string, string | null>;
      expect(isV2(w1.v)).toBe(true);
      expect(decrypt(w1.v, KEY)).toBe(LEGACY.privateKey.plain);
      expect(w2.v).toBe(alreadyV2); // untouched
      expect(decrypt(s.binance_api_key_encrypted!, KEY)).toBe(LEGACY.apiKey.plain);
      expect(decrypt(s.binance_api_secret_encrypted!, KEY)).toBe(LEGACY.unicode.plain);
      expect('claude_api_key_encrypted' in s).toBe(false); // column dropped with the AI assistant (3b)

      // Second run: nothing to do, nothing changes, no audit row
      audit.record.mockClear();
      const second = migrateSecretsToV2(db, KEY, audit as never);
      expect(second).toEqual({ wallets: 0, settingsFields: [], failed: [] });
      expect(audit.record).not.toHaveBeenCalled();
      const w1After = db.prepare(`SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'`).get() as { v: string };
      expect(w1After.v).toBe(w1.v);
    } finally {
      t.close();
    }
  });

  it('leaves undecryptable rows untouched and reports them', () => {
    const t = openTestDb();
    try {
      const { db } = t;
      db.prepare('UPDATE wallets SET private_key_encrypted = ? WHERE id = ?').run(LEGACY.privateKey.payload, 'w1');
      const audit = { record: vi.fn() };
      const r = migrateSecretsToV2(db, OTHER_KEY, audit as never);
      expect(r.failed).toEqual(['wallet:w1']);
      expect(audit.record).toHaveBeenCalledWith('system', 'secrets.migrate_v2', null, r, 'partial');
      const w1 = db.prepare(`SELECT private_key_encrypted AS v FROM wallets WHERE id = 'w1'`).get() as { v: string };
      expect(w1.v).toBe(LEGACY.privateKey.payload);
    } finally {
      t.close();
    }
  });
});
