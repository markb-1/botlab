/**
 * IPC handlers for backtesting. Registered before unlock (no encryption key needed).
 */

import { ipcMain } from 'electron';
import type { BacktestService } from '../../../packages/core/src/services/BacktestService';
import { BacktestRunSchema, parseInput } from '../../../packages/core/src/services/schemas';
import { respond } from '../respond';

export function registerBacktestHandlers(backtests: BacktestService): void {
  /** Run a backtest for a given script + symbol (or tokens) + time range. */
  ipcMain.handle('backtest:run', (_event, data: unknown) => respond(() => backtests.run(parseInput(BacktestRunSchema, data))));

  /** List backtest runs, optionally filtered by script ID. */
  ipcMain.handle('backtest:list', (_event, scriptId?: string) => respond(() => backtests.list(scriptId)));

  /** Get a single backtest run with its trades. */
  ipcMain.handle('backtest:get', (_event, runId: string) => respond(() => backtests.get(runId)));

  /** Delete a backtest run and its trades. */
  ipcMain.handle('backtest:delete', (_event, runId: string) => respond(() => backtests.delete(runId)));
}
