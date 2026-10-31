/**
 * npm audit round: @polymarket/clob-client 4.x pins axios 0.27 (high-severity advisories on the path that
 * carries the L2 API credentials). package.json `overrides` gives it the root axios 1.x instead. This
 * checks the client's HTTP layer still works against a local stand-in CLOB: JSON and bare-number bodies,
 * query params, and the error shape (`{ error, status }`) that orders.ts interprets.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { ethers } from 'ethers';
import { ClobClient, OrderType } from '@polymarket/clob-client';
import { buildPolyHmacSignature } from '@polymarket/clob-client/dist/signing/hmac';
import '../../packages/core/src/exchange/polymarket/redactCredentials';

let server: http.Server;
let host: string;
const seen: string[] = [];
const posts: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let postStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        posts.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(postStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(postStatus === 200 ? { success: true, orderID: '0xabc', status: 'live' } : { error: 'not enough balance / allowance' }));
      });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/time') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('1793443411');
    } else if (url.pathname === '/book' && url.searchParams.get('token_id') === 't1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ market: 'm1', asset_id: 't1', bids: [{ price: '0.49', size: '10' }], asks: [{ price: '0.51', size: '5' }], tick_size: '0.01' }));
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad token' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('clob-client with the overridden axios', () => {
  it('resolves axios 1.x for clob-client (override in package.json)', () => {
    const clobRequire = createRequire(require.resolve('@polymarket/clob-client'));
    const axiosPkg = clobRequire(path.join(path.dirname(clobRequire.resolve('axios')), '..', '..', 'package.json')) as { name: string; version: string };
    expect(axiosPkg.name).toBe('axios');
    expect(Number(axiosPkg.version.split('.')[0])).toBeGreaterThanOrEqual(1);
  });

  it('GETs bare-number and JSON bodies with query params', async () => {
    const clob = new ClobClient(host, 137);
    expect(await clob.getServerTime()).toBe(1793443411);
    const book = await clob.getOrderBook('t1');
    expect(book).toMatchObject({ asset_id: 't1', bids: [{ price: '0.49', size: '10' }] });
    expect(seen).toContain('/book?token_id=t1');
  });

  it('HTTP errors come back as { error, status } (what orders.ts interprets)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const clob = new ClobClient(host, 137);
      const r = (await clob.getOrderBook('nope')) as unknown as { error: string; status: number };
      expect(r).toMatchObject({ error: 'bad token', status: 400 });
    } finally {
      spy.mockRestore();
    }
  });

  it('no nested axios under clob-client (the override must hold after every install)', () => {
    const root = path.join(__dirname, '..', '..', 'node_modules');
    expect(fs.existsSync(path.join(root, '@polymarket', 'clob-client', 'node_modules', 'axios'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'axios', 'package.json'))).toBe(true);
  });
});

describe('L2-authenticated POST through the overridden axios, and credential redaction', () => {
  const creds = { key: 'api-key-0000-1111-SECRETKEY', secret: Buffer.from('hmac-secret-bytes-0123456789').toString('base64'), passphrase: 'pass-phrase-SECRETPASS' };
  const wallet = ethers.Wallet.createRandom();
  const signedOrder = {
    salt: '123456789',
    maker: wallet.address,
    signer: wallet.address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: '71321045679252212594626385532706912750332728571942532289631379312455583992563',
    makerAmount: '9000000',
    takerAmount: '20000000',
    side: 0,
    expiration: '0',
    nonce: '0',
    feeRateBps: '0',
    signatureType: 0,
    signature: '0xdeadbeef',
  };

  it('sends a body byte-identical to the HMAC-signed string', async () => {
    postStatus = 200;
    posts.length = 0;
    const clob = new ClobClient(host, 137, wallet, creds);
    const r = await clob.postOrder(signedOrder as never, OrderType.GTC);
    expect(r).toMatchObject({ success: true, orderID: '0xabc' });
    expect(posts).toHaveLength(1);
    const { headers, body } = posts[0];
    expect(headers['poly_api_key']).toBe(creds.key);
    const ts = Number(headers['poly_timestamp']);
    // What clob-client signed: JSON.stringify of the payload; the server must receive exactly that
    expect(headers['poly_signature']).toBe(buildPolyHmacSignature(creds.secret, ts, 'POST', '/order', body));
    expect(JSON.parse(body)).toMatchObject({ owner: creds.key, orderType: 'GTC', order: { salt: 123456789, side: 'BUY' } });
  });

  it('on an HTTP error, clob-client still returns { error, status } and logs no credential', async () => {
    postStatus = 400;
    posts.length = 0;
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    try {
      const clob = new ClobClient(host, 137, wallet, creds);
      const r = (await clob.postOrder(signedOrder as never, OrderType.GTC)) as unknown as { error: string; status: number };
      expect(r).toMatchObject({ error: 'not enough balance / allowance', status: 400 });
      const sent = posts[0].headers;
      const out = logged.join('\n');
      expect(out).toContain('request error'); // clob-client did log the failure
      for (const secret of [creds.key, creds.passphrase, creds.secret, String(sent['poly_signature']), String(sent['poly_address'])]) {
        expect(out).not.toContain(secret);
      }
      expect(out).not.toContain(wallet.address);
      expect(out).not.toMatch(/"POLY_[A-Z_]+":"(?!\[redacted\])/);
    } finally {
      spy.mockRestore();
    }
  });
});

