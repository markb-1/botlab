/**
 * ctx.risk.getFlaggedTokens (Mac test F3, review): open exit flags on any bot's position, scoped to the asking bot's
 * mode in SQL — a live flag is never shown to a paper bot and vice versa; latest per token, no reasons.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable, openTestDb, type TestDb } from './db';
import { PositionExitFlagRepository } from '../../packages/core/src/db/repositories/AgentRepository';
import { flaggedTokensInMode } from '../../packages/core/src/bots/BotManager';

describe.skipIf(!sqliteAvailable)('flaggedTokensInMode', () => {
  let t: TestDb;
  let flags: PositionExitFlagRepository;
  beforeEach(() => {
    t = openTestDb();
    flags = new PositionExitFlagRepository(t.db);
  });
  afterEach(() => t.close());

  it('paper bots see paper flags only, live bots live flags only, of any bot', () => {
    flags.create({ botId: 'exec-a', tokenId: 'paperTok', marketId: 'm1', simulated: true, reason: 'paper thesis', createdBy: 'agent', at: '2026-06-01T10:00:00.000Z' });
    flags.create({ botId: 'exec-b', tokenId: 'paperTok', marketId: 'm1', simulated: true, reason: 'later', createdBy: 'human', at: '2026-06-01T11:00:00.000Z' });
    flags.create({ botId: 'live-bot', tokenId: 'liveTok', marketId: 'm2', simulated: false, reason: 'live thesis', createdBy: 'agent', at: '2026-06-01T10:00:00.000Z' });
    const handled = flags.create({ botId: 'exec-a', tokenId: 'doneTok', marketId: 'm3', simulated: true, reason: 'x', createdBy: 'agent', at: '2026-06-01T09:00:00.000Z' });
    t.db.prepare("UPDATE position_exit_flags SET status = 'done' WHERE id = ?").run(handled.id);

    expect(flaggedTokensInMode(flags, true)).toEqual([{ tokenId: 'paperTok', marketId: 'm1', flaggedAt: '2026-06-01T11:00:00.000Z' }]);
    expect(flaggedTokensInMode(flags, false)).toEqual([{ tokenId: 'liveTok', marketId: 'm2', flaggedAt: '2026-06-01T10:00:00.000Z' }]);
    // No reasons or owners leak
    expect(Object.keys(flaggedTokensInMode(flags, false)[0]).sort()).toEqual(['flaggedAt', 'marketId', 'tokenId']);
  });
});
