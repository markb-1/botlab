import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getBinanceBalances, queryBinanceOrder, SIGNED_REDIRECT } from '../../packages/core/src/exchange/binance/client';

/** fetch forwards custom headers (X-MBX-APIKEY) across hosts on a redirect: signed requests must not follow one. */
describe('Binance signed requests never follow redirects', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signed GETs pass redirect: "error"', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response(JSON.stringify({ balances: [], code: -2013 }), { status: 200 });
    });
    await getBinanceBalances({ apiKey: 'k', apiSecret: 's' }).catch(() => undefined);
    await queryBinanceOrder({ apiKey: 'k', apiSecret: 's' }, 'BTCUSDT', 'id1').catch(() => undefined);
    expect(SIGNED_REDIRECT).toBe('error');
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init.redirect).toBe('error');
  });

  it('every request carrying X-MBX-APIKEY in client.ts sets the redirect policy (signed POST included)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'packages/core/src/exchange/binance/client.ts'), 'utf8');
    const uses = src.split("'X-MBX-APIKEY'").slice(1);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const after of uses) expect(after.slice(0, 80)).toMatch(/redirect: SIGNED_REDIRECT/);
  });
});
