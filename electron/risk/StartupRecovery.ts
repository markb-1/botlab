/**
 * Startup recovery (spec §4.3).
 *
 * - Shutdown marker: a small JSON file in the data dir. `markRunning()` at start, `markClean()`
 *   after a graceful shutdown (bots stopped). If the previous run never marked clean and
 *   `server.start_halted_after_crash` is true (also when the limits config cannot be read),
 *   the app starts with a global halt ("unclean shutdown"), which only a human can clear.
 * - Orphan orders: no bot runs at startup (bots never auto-start), so every open order in the
 *   `orders` table is synced with the exchange (fills/cancels/expiry recorded) and the rest are
 *   cancelled. Bot rows left `running`/`starting`/`stopping` by a crash are reset to `stopped`.
 */

import fs from 'fs';
import path from 'path';
import type { AuditService } from '../audit/AuditService';
import type { BotRepository } from '../database/repositories/BotRepository';
import type { BotCancelResult, OrderCanceller } from '../orders/OrderCanceller';
import type { HaltService } from './HaltService';
import logger from '../../src/utils/logger';

export const SHUTDOWN_MARKER_FILE = 'shutdown-state.json';
export const UNCLEAN_SHUTDOWN_REASON = 'unclean shutdown';

export type PreviousShutdown = 'clean' | 'unclean' | 'unknown';

interface MarkerContents {
  clean: boolean;
  at: string;
  pid?: number;
}

export class ShutdownMarker {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, SHUTDOWN_MARKER_FILE);
  }

  /**
   * How the previous run ended. `unknown` = no marker (first start of a 1c+ build);
   * an unreadable marker counts as unclean.
   */
  readPrevious(): PreviousShutdown {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'unknown';
      return 'unclean';
    }
    try {
      const m = JSON.parse(text) as Partial<MarkerContents>;
      return m.clean === true ? 'clean' : 'unclean';
    } catch {
      return 'unclean';
    }
  }

  markRunning(): void {
    this.write({ clean: false, at: new Date().toISOString(), pid: process.pid });
  }

  markClean(): void {
    this.write({ clean: true, at: new Date().toISOString() });
  }

  /** Write via a temp file + rename so a crash mid-write never leaves a "clean" half-file. */
  private write(contents: MarkerContents): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(contents), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Read the previous shutdown state, apply the start-halted rule, then mark this run as running.
 * `startHaltedAfterCrash` is null when the config could not be read (treated as true).
 */
export function applyStartupHalt(deps: {
  marker: ShutdownMarker;
  startHaltedAfterCrash: boolean | null;
  halts: Pick<HaltService, 'setGlobalHaltFlag'>;
  audit: AuditService;
}): { previous: PreviousShutdown; halted: boolean } {
  const previous = deps.marker.readPrevious();
  const haltOnCrash = deps.startHaltedAfterCrash ?? true;
  let halted = false;
  deps.audit.record('system', 'app.start', null, { previousShutdown: previous, startHaltedAfterCrash: haltOnCrash });
  if (previous === 'unclean') {
    logger.warning(`[Startup] Previous shutdown was unclean${haltOnCrash ? '; starting with a global halt' : ''}`);
    if (haltOnCrash) {
      deps.halts.setGlobalHaltFlag(UNCLEAN_SHUTDOWN_REASON, 'system');
      halted = true;
    }
  }
  try {
    deps.marker.markRunning();
  } catch (err) {
    logger.error(`[Startup] Could not write shutdown marker ${deps.marker.file}: ${err instanceof Error ? err.message : err}`);
    deps.audit.record('system', 'app.marker_error', null, { file: deps.marker.file, error: String(err) }, 'warning');
  }
  return { previous, halted };
}

/** Sync and cancel orphaned open orders; reset stale bot statuses. */
export async function recoverOpenOrders(deps: {
  botRepo: Pick<BotRepository, 'findAll' | 'updateStatus'>;
  canceller: Pick<OrderCanceller, 'cancelAllBots'>;
  audit: AuditService;
  /** Skip bots that are running (none at startup unless started during recovery) */
  isBotRunning: (botId: string) => boolean;
}): Promise<BotCancelResult[]> {
  for (const bot of deps.botRepo.findAll()) {
    if (['running', 'starting', 'stopping'].includes(bot.status) && !deps.isBotRunning(bot.id)) {
      deps.botRepo.updateStatus(bot.id, 'stopped');
      deps.audit.record('system', 'startup.bot_status_reset', bot.id, { from: bot.status, to: 'stopped' });
    }
  }

  const results = await deps.canceller.cancelAllBots({ sync: true, skip: deps.isBotRunning });
  for (const r of results) {
    const ok = r.failed === 0 && r.errors.length === 0;
    deps.audit.record('system', 'startup.orphan_orders', r.botId, r, ok ? 'ok' : 'partial');
    const msg = `[Startup] Bot ${r.botId}: orphan orders cancelled ${r.cancelled}, failed ${r.failed}, unknown outcome ${r.unknownOutcome}`;
    if (ok) logger.info(msg);
    else logger.error(`${msg}; errors: ${r.errors.join('; ')}`);
  }
  return results;
}
