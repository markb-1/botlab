/**
 * IPC handlers for backtesting.
 * Registered in Phase A (no encryption key needed).
 */

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import type { ScriptRepository } from '../../database/repositories/ScriptRepository';
import { BacktestRepository } from '../../database/repositories/BacktestRepository';
import { BacktestEngine, type BacktestSource } from '../../backtest/BacktestEngine';
import type { FeeRatesInput } from '../../backtest/snapshotSimulate';
import type { OrderbookSnapshotRepository } from '../../database/repositories/OrderbookSnapshotRepository';

/** Polymarket snapshot backtests (spec §10) */
export interface SnapshotBacktestDeps {
  snapshotRepo: Pick<OrderbookSnapshotRepository, 'range'>;
  getFeeRates: (tokenId: string) => FeeRatesInput;
  getMaxTtlMinutes: () => number | undefined;
}

export function registerBacktestHandlers(
  db: Database.Database,
  scriptRepo: ScriptRepository,
  backtestRepo: BacktestRepository,
  snapshots?: SnapshotBacktestDeps
): void {
  /**
   * Run a backtest for a given script + symbol + time range.
   */
  ipcMain.handle(
    'backtest:run',
    async (
      _event,
      data: {
        scriptId: string;
        symbol: string;
        interval?: string;
        startTime: number;
        endTime: number;
        initialBalance: number;
        config?: Record<string, unknown>;
        /** Default 'binance-klines' (unchanged); 'polymarket-snapshots' replays recorded order books */
        source?: BacktestSource;
        /** polymarket-snapshots: tokens to replay */
        tokenIds?: string[];
      }
    ) => {
      try {
        // Validate inputs
        const source: BacktestSource = data.source ?? 'binance-klines';
        if (source !== 'binance-klines' && source !== 'polymarket-snapshots') return { success: false, error: `unknown source ${String(source)}` };
        if (!data.scriptId) return { success: false, error: 'scriptId is required' };
        if (source === 'binance-klines' && !data.symbol) return { success: false, error: 'symbol is required' };
        if (source === 'polymarket-snapshots') {
          if (!snapshots) return { success: false, error: 'Snapshot backtests are not available' };
          if (!Array.isArray(data.tokenIds) || data.tokenIds.length === 0 || data.tokenIds.some((t) => typeof t !== 'string' || !t)) {
            return { success: false, error: 'tokenIds (non-empty array of token ids) is required' };
          }
          if (data.tokenIds.length > 50) return { success: false, error: 'at most 50 tokens per backtest' };
        }
        if (!data.startTime || !data.endTime) return { success: false, error: 'startTime and endTime are required' };
        if (data.startTime >= data.endTime) return { success: false, error: 'startTime must be before endTime' };
        if (!data.initialBalance || data.initialBalance <= 0) return { success: false, error: 'initialBalance must be positive' };

        // Fetch the script
        const script = scriptRepo.findById(data.scriptId);
        if (!script) return { success: false, error: 'Script not found' };
        if (!script.compiled) return { success: false, error: 'Script has not been compiled. Save the script first.' };

        // Create and run the engine
        const engine = new BacktestEngine({
          db,
          backtestRepo,
          compiledScript: script.compiled,
          symbol: data.symbol ?? '',
          interval: data.interval || '1h',
          startTime: data.startTime,
          endTime: data.endTime,
          initialBalance: data.initialBalance,
          config: data.config || {},
          scriptId: data.scriptId,
          scriptName: script.name,
          source,
          ...(source === 'polymarket-snapshots' && snapshots
            ? {
                tokenIds: data.tokenIds,
                loadSnapshots: (tokens: string[], from: number, to: number) => snapshots.snapshotRepo.range(tokens, from, to),
                getFeeRates: snapshots.getFeeRates,
                maxTtlMinutes: snapshots.getMaxTtlMinutes(),
              }
            : {}),
        });

        const result = await engine.run();

        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  /**
   * List backtest runs, optionally filtered by script ID.
   */
  ipcMain.handle('backtest:list', async (_event, scriptId?: string) => {
    try {
      const runs = backtestRepo.listRuns(scriptId);
      return {
        success: true,
        data: runs.map((run) => ({
          id: run.id,
          scriptId: run.script_id,
          scriptName: run.script_name,
          symbol: run.symbol,
          interval: run.interval,
          startTime: run.start_time,
          endTime: run.end_time,
          initialBalance: run.initial_balance,
          finalBalance: run.final_balance,
          totalTrades: run.total_trades,
          winTrades: run.win_trades,
          loseTrades: run.lose_trades,
          totalPnl: run.total_pnl,
          maxDrawdown: run.max_drawdown,
          sharpeRatio: run.sharpe_ratio,
          config: run.config ? JSON.parse(run.config) : null,
          status: run.status,
          error: run.error,
          durationMs: run.duration_ms,
          createdAt: run.created_at,
        })),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get a single backtest run with its trades.
   */
  ipcMain.handle('backtest:get', async (_event, runId: string) => {
    try {
      const run = backtestRepo.getRun(runId);
      if (!run) return { success: false, error: 'Backtest run not found' };

      const trades = backtestRepo.getTradesForRun(runId);

      return {
        success: true,
        data: {
          run: {
            id: run.id,
            scriptId: run.script_id,
            scriptName: run.script_name,
            symbol: run.symbol,
            interval: run.interval,
            startTime: run.start_time,
            endTime: run.end_time,
            initialBalance: run.initial_balance,
            finalBalance: run.final_balance,
            totalTrades: run.total_trades,
            winTrades: run.win_trades,
            loseTrades: run.lose_trades,
            totalPnl: run.total_pnl,
            maxDrawdown: run.max_drawdown,
            sharpeRatio: run.sharpe_ratio,
            config: run.config ? JSON.parse(run.config) : null,
            status: run.status,
            error: run.error,
            durationMs: run.duration_ms,
            createdAt: run.created_at,
          },
          trades: trades.map((t) => ({
            id: t.id,
            runId: t.run_id,
            side: t.side,
            symbol: t.symbol,
            price: t.price,
            quantity: t.quantity,
            quoteAmount: t.quote_amount,
            timestamp: t.timestamp,
            balanceAfter: t.balance_after,
            createdAt: t.created_at,
          })),
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Delete a backtest run and its trades.
   */
  ipcMain.handle('backtest:delete', async (_event, runId: string) => {
    try {
      const deleted = backtestRepo.deleteRun(runId);
      if (!deleted) return { success: false, error: 'Backtest run not found' };
      return { success: true, data: { deleted: true } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
