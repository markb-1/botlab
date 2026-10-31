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
import { ClobClient } from '@polymarket/clob-client';

let server: http.Server;
let host: string;
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
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
});
