/**
 * In-memory SQLite for order tests, using the real schema and migrations.
 *
 * If better-sqlite3's native binary cannot load (e.g. built for another Node ABI), tests that
 * need it are skipped with a warning. CI installs it for Node, so they always run there.
 */

import { closeDatabase, initializeDatabase, type Database } from '../../packages/core/src/db/index';
import { BotRepository } from '../../packages/core/src/db/repositories/BotRepository';
import { BotTradeRepository } from '../../packages/core/src/db/repositories/BotTradeRepository';
import { BotStorageRepository } from '../../packages/core/src/db/repositories/BotStorageRepository';
import { OrderRepository } from '../../packages/core/src/db/repositories/OrderRepository';
import { RiskStateRepository } from '../../packages/core/src/db/repositories/RiskStateRepository';

export const sqliteAvailable: boolean = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sqlite = require('better-sqlite3');
    new Sqlite(':memory:').close();
    return true;
  } catch (err) {
    console.warn(`[tests/orders] better-sqlite3 unavailable under Node, skipping DB tests: ${err}`);
    return false;
  }
})();

export interface TestDb {
  db: Database.Database;
  botRepo: BotRepository;
  tradeRepo: BotTradeRepository;
  storageRepo: BotStorageRepository;
  orderRepo: OrderRepository;
  riskStateRepo: RiskStateRepository;
  /** Insert a bot (with its script and wallet); returns its id */
  addBot(id: string, fields?: Partial<{ stage: string; strategy: string | null; market_ids: string | null; allocation_usd: number | null }>): string;
  close(): void;
}

export function openTestDb(): TestDb {
  const origLog = console.log;
  console.log = () => {};
  let db: Database.Database;
  try {
    db = initializeDatabase(':memory:');
  } finally {
    console.log = origLog;
  }
  db.prepare(`INSERT INTO scripts (id, name, source) VALUES ('s1', 'script', '')`).run();
  db.prepare(`INSERT INTO wallets (id, name, address, private_key_encrypted) VALUES ('w1', 'wallet', '0xabc', 'x')`).run();

  return {
    db,
    botRepo: new BotRepository(db),
    tradeRepo: new BotTradeRepository(db),
    storageRepo: new BotStorageRepository(db),
    orderRepo: new OrderRepository(db),
    riskStateRepo: new RiskStateRepository(db),
    addBot(id, fields = {}) {
      db.prepare(
        `INSERT INTO bots (id, name, script_id, wallet_id, stage, strategy, market_ids, allocation_usd)
         VALUES (?, ?, 's1', 'w1', ?, ?, ?, ?)`
      ).run(id, id, fields.stage ?? 'full', fields.strategy ?? null, fields.market_ids ?? null, fields.allocation_usd ?? null);
      return id;
    },
    close() {
      const l = console.log;
      console.log = () => {};
      try {
        closeDatabase();
      } finally {
        console.log = l;
      }
    },
  };
}
