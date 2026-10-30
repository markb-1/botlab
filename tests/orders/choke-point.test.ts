import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Static guard for the single order choke point (spec §4, §14): only the exchange adapter
 * modules may post orders, and only OrderService's adapter layer may import them.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['electron', 'src', 'web/client/src', 'scripts'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'release']);

/** Modules that talk to exchange order endpoints directly */
const ORDER_ENDPOINT_MODULES = ['electron/exchange/polymarket/orders.ts', 'electron/sdk/binance.ts'];
/** The only module that may import the order-endpoint functions */
const ADAPTER_MODULE = 'electron/orders/ExchangeAdapter.ts';
/** Modules allowed to build live adapters (they hand them to OrderService) */
const ADAPTER_USERS = (f: string) => f.startsWith('electron/orders/') || f === 'src/core/BotManager.ts';

const RULES: Array<{ name: string; pattern: RegExp; allowed: (file: string) => boolean }> = [
  {
    name: 'CLOB order creation/posting call',
    pattern: /\.\s*(postOrders?|createOrder|createMarketOrder|createAndPostOrder|createAndPostMarketOrder)\s*\(/,
    allowed: (f) => ORDER_ENDPOINT_MODULES.includes(f),
  },
  {
    name: 'Binance order endpoint',
    pattern: /\/(api|sapi)\/v3\/order/,
    allowed: (f) => ORDER_ENDPOINT_MODULES.includes(f),
  },
  {
    name: 'import of the Polymarket order adapter',
    pattern: /from\s+['"][^'"]*exchange\/polymarket\/orders['"]|require\(\s*['"][^'"]*exchange\/polymarket\/orders['"]/,
    allowed: (f) => f === ADAPTER_MODULE,
  },
  {
    name: 'use of Binance order functions',
    pattern: /\bexecuteBinance(Buy|Sell)\b/,
    allowed: (f) => f === ADAPTER_MODULE || f === 'electron/sdk/binance.ts',
  },
  {
    name: 'construction of live exchange adapters',
    pattern: /\bcreate(Polymarket|Binance)Adapter\b/,
    allowed: ADAPTER_USERS,
  },
];

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(path.join(dir, entry.name), out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Strip comments so documentation that names the functions does not trip the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function findViolations(file: string, source: string): string[] {
  const code = stripComments(source);
  return RULES.filter((r) => r.pattern.test(code) && !r.allowed(file)).map((r) => `${file}: ${r.name}`);
}

describe('order choke point', () => {
  it('no module outside the adapters posts orders or imports order functions', () => {
    const files = SCAN_DIRS.flatMap((d) => listFiles(path.join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50);

    const violations = files.flatMap((abs) => {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      return findViolations(rel, fs.readFileSync(abs, 'utf8'));
    });
    expect(violations).toEqual([]);
  });

  it('the adapters actually contain the calls the guard looks for', () => {
    const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    expect(read('electron/exchange/polymarket/orders.ts')).toMatch(/\.postOrder\(/);
    expect(read('electron/sdk/binance.ts')).toMatch(/\/api\/v3\/order/);
  });

  it('detects violations', () => {
    expect(findViolations('electron/runtime/RpcHandler.ts', 'await clob.postOrder(o, OrderType.FOK)')).toHaveLength(1);
    expect(findViolations('src/x.ts', 'const s = await client.createMarketOrder({})')).toHaveLength(1);
    expect(findViolations('src/x.ts', "fetch(`${BASE}/api/v3/order?x=1`)")).toHaveLength(1);
    expect(findViolations('src/x.ts', "import { postLimitOrder } from '../exchange/polymarket/orders';")).toHaveLength(1);
    expect(findViolations('electron/runtime/X.ts', 'executeBinanceBuy(creds, s, 1)')).toHaveLength(1);
    expect(findViolations('electron/runtime/X.ts', 'createPolymarketAdapter(clob)')).toHaveLength(1);
    expect(findViolations('electron/x.ts', '// clob.postOrder( is documented here')).toHaveLength(0);
    expect(findViolations('electron/x.ts', 'orderRepo.create({})')).toHaveLength(0);
  });
});
