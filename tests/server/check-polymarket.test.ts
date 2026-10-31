import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ethers } from 'ethers';
import { initializeDatabase, closeDatabase } from '../../packages/core/src/db/index';
import { encrypt } from '../../packages/core/src/security/crypto';
import { makeKeyCheck } from '../../packages/core/src/security/masterKey';
import { buildAuth, bypassesProxy, effectiveProxy, envProxy, openReadOnly } from '../../apps/server/src/checkPolymarket';
import { createClobReadOnlyAuth } from '../../packages/core/src/exchange/polymarket/authHeaders';

const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const PK = '0x' + '11'.repeat(32);
let dir: string;
let dbFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-checkpm-'));
  dbFile = path.join(dir, 'botlab.db');
  const db = initializeDatabase(dbFile);
  db.prepare("UPDATE settings SET key_check = ? WHERE id = 'global'").run(makeKeyCheck(KEY));
  db.prepare(
    "INSERT INTO wallets (id, name, address, proxy_address, private_key_encrypted) VALUES ('w1', 'Main', ?, '0x00000000000000000000000000000000000000aa', ?)"
  ).run(new ethers.Wallet(PK).address, encrypt(PK, KEY));
  closeDatabase(db);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('check-polymarket: database', () => {
  it('opens read-only: reads work, writes fail', () => {
    const opened = openReadOnly(dbFile);
    expect(opened.db).not.toBeNull();
    try {
      expect(opened.db!.prepare('SELECT COUNT(*) AS n FROM wallets').get()).toEqual({ n: 1 });
      expect(() => opened.db!.prepare("UPDATE settings SET key_check = NULL WHERE id = 'global'").run()).toThrow(/readonly/i);
    } finally {
      opened.db?.close();
    }
  });

  it('a missing file and an unopenable path give their own messages', () => {
    const missing = openReadOnly(path.join(dir, 'nope.db'));
    expect(missing).toMatchObject({ db: null });
    expect((missing as { error: string }).error).toMatch(/no BotLab database at/);
    // A directory where the file should be: exists, but SQLite cannot open it
    const notADb = path.join(dir, 'dir.db');
    fs.mkdirSync(notADb);
    const bad = openReadOnly(notADb);
    const err = (bad as { error: string }).error;
    expect(err).toMatch(/^cannot open .*dir\.db read-only: \S/);
    expect(err).not.toMatch(/no BotLab database/);
  });
});

describe('check-polymarket: credentials', () => {
  it('master key matches ⇒ a probe labelled with the wallet; data checks use its proxy address', () => {
    const opened = openReadOnly(dbFile);
    try {
      const a = buildAuth(opened, dir, { 'with-credentials': true }, { BOTLAB_MASTER_KEY: KEY });
      expect(a.auth).not.toHaveProperty('skip');
      expect((a.auth as { label: string }).label).toContain('"Main"');
      expect(a.address).toBe('0x00000000000000000000000000000000000000aa');
    } finally {
      opened.db?.close();
    }
  });

  it('a master key that does not match ⇒ skipped, nothing decrypted', () => {
    const opened = openReadOnly(dbFile);
    try {
      const a = buildAuth(opened, dir, {}, { BOTLAB_MASTER_KEY: OTHER_KEY });
      expect(a.auth).toEqual({ skip: 'the master key does not match this database' });
    } finally {
      opened.db?.close();
    }
  });

  it('no master key anywhere ⇒ skipped, and no key file is generated', () => {
    const opened = openReadOnly(dbFile);
    try {
      const a = buildAuth(opened, dir, {}, {});
      expect((a.auth as { skip: string }).skip).toMatch(/^no master key/);
      expect(fs.existsSync(path.join(dir, 'master.key'))).toBe(false);
    } finally {
      opened.db?.close();
    }
  });

  it('no database ⇒ skipped with the open error', () => {
    const a = buildAuth(openReadOnly(path.join(dir, 'nope.db')), dir, {}, { BOTLAB_MASTER_KEY: KEY });
    expect((a.auth as { skip: string }).skip).toMatch(/no BotLab database at/);
  });

  it('unknown --wallet ⇒ skipped', () => {
    const opened = openReadOnly(dbFile);
    try {
      expect(buildAuth(opened, dir, { wallet: 'Other' }, { BOTLAB_MASTER_KEY: KEY }).auth).toEqual({ skip: 'no wallet matches --wallet Other' });
    } finally {
      opened.db?.close();
    }
  });
});

describe('check-polymarket: read-only auth headers', () => {
  it('L1 / L2 headers carry the expected names and never the private key', async () => {
    const probe = createClobReadOnlyAuth(PK, 'wallet');
    const l1 = await probe.l1Headers();
    expect(Object.keys(l1).sort()).toEqual(['POLY_ADDRESS', 'POLY_NONCE', 'POLY_SIGNATURE', 'POLY_TIMESTAMP']);
    expect(l1.POLY_ADDRESS).toBe(new ethers.Wallet(PK).address);
    const creds = { key: 'k-0000', secret: Buffer.from('secret-bytes').toString('base64'), passphrase: 'p-0000' };
    const l2 = await probe.l2Headers(creds, 'GET', '/auth/api-keys');
    expect(Object.keys(l2).sort()).toEqual(['POLY_ADDRESS', 'POLY_API_KEY', 'POLY_PASSPHRASE', 'POLY_SIGNATURE', 'POLY_TIMESTAMP']);
    const all = JSON.stringify([l1, l2, probe]);
    expect(all).not.toContain(PK.slice(2));
    expect(all).not.toContain(creds.secret);
  });
});

describe('check-polymarket: proxy', () => {
  it('follows Node: lowercase first, ?? semantics, http_proxy fallback, host:port only', () => {
    expect(envProxy({ https_proxy: 'http://a:1', HTTPS_PROXY: 'http://b:2' })?.display).toBe('a:1');
    expect(envProxy({ https_proxy: '', HTTPS_PROXY: 'http://b:2' })).toBeNull();
    expect(envProxy({ HTTPS_PROXY: 'http://user:s3cret@proxy.example:3128' })?.display).toBe('proxy.example:3128');
    expect(envProxy({ http_proxy: 'http://10.0.0.1:8080' })?.display).toBe('10.0.0.1:8080');
    expect(envProxy({})).toBeNull();
  });

  it('reports a proxy only when Node uses it for the Polymarket hosts', () => {
    expect(effectiveProxy({ HTTPS_PROXY: 'http://p:1' }, true)).toBe('p:1');
    expect(effectiveProxy({ HTTPS_PROXY: 'http://p:1' }, false)).toBeNull();
    expect(effectiveProxy({ HTTPS_PROXY: 'http://p:1', NO_PROXY: '.polymarket.com' }, true)).toBeNull();
    expect(effectiveProxy({ HTTPS_PROXY: 'http://p:1', no_proxy: '', NO_PROXY: '*' }, true)).toBe('p:1');
    expect(bypassesProxy('clob.polymarket.com', { no_proxy: 'localhost, *.polymarket.com' })).toBe(true);
    expect(bypassesProxy('clob.polymarket.com', { no_proxy: 'polymarket.co' })).toBe(false);
  });
});
