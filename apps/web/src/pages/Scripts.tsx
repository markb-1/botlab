import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useScripts } from '../hooks/useScripts';
import type { Script } from '../types';

interface ExportResult { exported: boolean; filePath?: string }
interface ImportResult { imported: number; scripts: Script[]; errors?: string[] }

const SCRIPT_ICONS: Record<string, ReactNode> = {
  'Copy Trading': (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
    </svg>
  ),
  'Odds Threshold': (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  ),
  'Trader Discovery': (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
};

const DEFAULT_ICON = (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
  </svg>
);

export function Scripts() {
  const navigate = useNavigate();
  const { scripts, isLoading, forkScript, deleteScript, exportScript, importScripts, isImporting } = useScripts();
  const [filter, setFilter] = useState<'all' | 'templates' | 'custom'>('all');
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [showApiRef, setShowApiRef] = useState(false);

  const templates = scripts.filter((s) => s.isTemplate);
  const custom = scripts.filter((s) => !s.isTemplate);

  const filteredScripts =
    filter === 'templates' ? templates :
    filter === 'custom' ? custom :
    scripts;

  const handleFork = async (script: Script) => {
    setForkingId(script.id);
    try {
      const forked = await forkScript({ id: script.id });
      navigate(`/scripts/${forked.id}`);
    } catch (err) {
      console.error('Failed to fork script:', err);
    } finally {
      setForkingId(null);
    }
  };

  const handleDelete = async (script: Script) => {
    if (script.isTemplate) return;
    if (!confirm(`Delete "${script.name}"? This cannot be undone.`)) return;
    try {
      await deleteScript(script.id);
    } catch (err) {
      console.error('Failed to delete script:', err);
    }
  };

  const handleExport = async (script: Script) => {
    try {
      const result = await exportScript(script.id) as ExportResult;
      if (result.exported) {
        setImportResult({ message: `Exported "${script.name}" successfully`, type: 'success' });
        setTimeout(() => setImportResult(null), 3000);
      }
    } catch (err) {
      console.error('Failed to export script:', err);
      setImportResult({ message: 'Failed to export script', type: 'error' });
      setTimeout(() => setImportResult(null), 3000);
    }
  };

  const handleImport = async () => {
    try {
      const result = await importScripts() as ImportResult;
      if (result.imported > 0) {
        setImportResult({
          message: `Imported ${result.imported} script${result.imported > 1 ? 's' : ''} successfully${
            result.errors?.length ? ` (${result.errors.length} failed)` : ''
          }`,
          type: 'success',
        });
      } else if (result.errors?.length) {
        setImportResult({
          message: `Import failed: ${result.errors[0]}`,
          type: 'error',
        });
      }
      // Auto-clear message after 5s
      setTimeout(() => setImportResult(null), 5000);
    } catch (err) {
      console.error('Failed to import scripts:', err);
      setImportResult({ message: 'Failed to import scripts', type: 'error' });
      setTimeout(() => setImportResult(null), 5000);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div>
            <h2 className="text-2xl font-bold text-white">Scripts</h2>
            <p className="mt-1 text-sm text-gray-400">
              Browse templates and manage your custom bot scripts
            </p>
          </div>
          <button
            onClick={() => setShowApiRef(true)}
            className="flex-shrink-0 w-7 h-7 rounded-full border border-[#333] text-gray-500 hover:text-white hover:border-accent hover:bg-accent/10 transition-colors flex items-center justify-center text-sm font-semibold"
            title="Script API Reference"
          >
            ?
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleImport}
            disabled={isImporting}
            className="inline-flex items-center px-4 py-2 border border-[#333] text-sm font-medium rounded-lg text-gray-300 hover:bg-surface-light hover:text-white transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {isImporting ? 'Importing...' : 'Import'}
          </button>
          <Link
            to="/scripts/new"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
          >
            + New Script
          </Link>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-surface border border-[#2a2a2a] rounded-lg p-1 w-fit">
        {(['all', 'templates', 'custom'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              filter === f
                ? 'bg-accent text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-light'
            }`}
          >
            {f === 'all' ? `All (${scripts.length})` :
             f === 'templates' ? `Templates (${templates.length})` :
             `Custom (${custom.length})`}
          </button>
        ))}
      </div>

      {/* Import/Export result notification */}
      {importResult && (
        <div className={`rounded-lg px-4 py-2 ${
          importResult.type === 'success'
            ? 'bg-green-500/10 border border-green-500/20'
            : 'bg-red-500/10 border border-red-500/20'
        }`}>
          <p className={`text-sm ${
            importResult.type === 'success' ? 'text-green-300' : 'text-red-300'
          }`}>{importResult.message}</p>
        </div>
      )}

      {/* Script grid */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-500">Loading scripts...</div>
      ) : filteredScripts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">
            {filter === 'custom'
              ? 'No custom scripts yet. Fork a template or create a new one.'
              : 'No scripts found.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredScripts.map((script) => (
            <div
              key={script.id}
              className="bg-surface border border-[#2a2a2a] rounded-xl p-5 flex flex-col hover:border-[#3a3a3a] transition-colors"
            >
              {/* Header */}
              <div className="flex items-start gap-3 mb-3">
                <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                  script.isTemplate ? 'bg-accent/10 text-accent' : 'bg-blue-500/10 text-blue-400'
                }`}>
                  {SCRIPT_ICONS[script.name] || DEFAULT_ICON}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-medium text-white truncate">{script.name}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      script.isTemplate
                        ? 'bg-accent/10 text-accent'
                        : 'bg-blue-500/10 text-blue-400'
                    }`}>
                      {script.isTemplate ? 'Template' : 'Custom'}
                    </span>
                    <span className="text-xs text-gray-600">v{script.version}</span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <p className="text-sm text-gray-400 mb-4 flex-1 line-clamp-2">
                {script.description || 'No description'}
              </p>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-3 border-t border-[#2a2a2a]">
                {script.isTemplate ? (
                  <>
                    <Link
                      to={`/scripts/${script.id}`}
                      className="flex-1 px-3 py-1.5 text-center text-sm font-medium text-gray-300 border border-[#333] rounded-lg hover:bg-surface-light transition-colors"
                    >
                      View
                    </Link>
                    <button
                      onClick={() => handleFork(script)}
                      disabled={forkingId === script.id}
                      className="flex-1 px-3 py-1.5 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50"
                    >
                      {forkingId === script.id ? 'Forking...' : 'Fork'}
                    </button>
                  </>
                ) : (
                  <>
                    <Link
                      to={`/scripts/${script.id}`}
                      className="flex-1 px-3 py-1.5 text-center text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover transition-colors"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => handleExport(script)}
                      className="px-2.5 py-1.5 text-sm text-gray-400 border border-[#333] rounded-lg hover:bg-surface-light hover:text-white transition-colors"
                      title="Export script"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(script)}
                      className="px-2.5 py-1.5 text-sm text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-colors"
                      title="Delete script"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* API Reference Modal */}
      {showApiRef && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowApiRef(false)}>
          <div
            className="bg-[#141414] border border-[#2a2a2a] rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2a2a2a]">
              <div>
                <h3 className="text-lg font-semibold text-white">Script API Reference</h3>
                <p className="text-xs text-gray-500 mt-0.5">Available via <code className="text-accent">ctx</code> in onStart, onTick, onStop, and onHeartbeat</p>
              </div>
              <button
                onClick={() => setShowApiRef(false)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal body */}
            <div className="overflow-y-auto px-6 py-5 space-y-6 text-sm">
              {/* Trading */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Trading</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.buy(tokenId, amountUsd, opts?)" ret="Promise<TradeResult>" desc="One fill-or-kill order for amountUsd at best ask + maxSlippage (or opts.maxPrice). Risk-checked; a rejection is returned (status 'rejected_risk', failedCheck), not thrown." />
                  <ApiMethod sig="ctx.sell(tokenId, amountTokens, opts?)" ret="Promise<TradeResult>" desc="Fill-or-kill sell of held tokens at best bid − maxSlippage (or opts.minPrice). opts.riskExit marks an exit (exempt from hold time and rate limits)." />
                  <ApiMethod sig="ctx.getOrderBook(tokenId)" ret="Promise<OrderBook>" desc="Get the full order book (bids and asks)" />
                  <ApiMethod sig="ctx.getPositions()" ret="Promise<Position[]>" desc="Get all current open positions for this wallet" />
                  <ApiMethod sig="ctx.getBalance()" ret="Promise<number>" desc="Get wallet USDC balance" />
                </div>
              </section>

              {/* Orders v2 */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Limit orders (ctx.polymarket)</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.polymarket.placeLimit(tokenId, side, price, size, opts?)" ret="Promise<OrderResult>" desc="GTD limit order. Post-only by default (rejected if it would cross); ttlMinutes capped by limits.orders.resting_order_ttl_minutes. Returns ok/status/failedCheck; never throws on a rejection." />
                  <ApiMethod sig="ctx.polymarket.cancel(orderId)" ret="Promise<void>" desc="Cancel one of this bot's orders (throws if not found or not cancellable)" />
                  <ApiMethod sig="ctx.polymarket.cancelAll()" ret="Promise<{ cancelled, failed, unknownOutcome }>" desc="Cancel all of this bot's open orders; orders with an unknown outcome expire on their own" />
                  <ApiMethod sig="ctx.polymarket.getOpenOrders()" ret="Promise<OpenOrder[]>" desc="This bot's open orders" />
                  <ApiMethod sig="ctx.polymarket.getFee(tokenId)" ret="Promise<{ takerRate, makerRate, formula, source }>" desc="The market's fee schedule (taker fee = shares × rate × p × (1 − p), in USDC; makers 0); category table when the market has none, unknown market ⇒ highest rate" />
                </div>
              </section>

              {/* Risk and ledger */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Risk budget & forecast ledger (read-only)</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.risk.getBudget()" ret="Promise<{ remainingAllocation, remainingMarket, halted }>" desc="What this bot can still add before its allocation, the total cap or a per-market cap bites" />
                  <ApiMethod sig="ctx.ledger.getActiveForecasts(filter?)" ret="Promise<BotForecast[]>" desc="Active forecasts ({ category?, tradeableOnly? }); tradeable = its (category, horizon) bucket trades now" />
                  <ApiMethod sig="ctx.ledger.getForecast(tokenId)" ret="Promise<BotForecast | null>" desc="The active forecast on a token. Pass opts.forecastId when ordering on it (ledger-driven orders)." />
                </div>
              </section>

              {/* Market Data */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Market Data</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.getMarkets(query?)" ret="Promise<Market[]>" desc="Search and filter Polymarket markets by title, tag, active/closed status" />
                  <ApiMethod sig="ctx.getMarketPrice(tokenId)" ret="Promise<MarketPrice>" desc="Get current bid, ask, mid price, and spread" />
                  <ApiMethod sig="ctx.getEvent(eventSlug)" ret="Promise<PolymarketEvent>" desc="Fetch event details including all its markets" />
                </div>
              </section>

              {/* HTTP */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">HTTP</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.fetch(url, init?)" ret="Promise<Response-like>" desc="https only, port 443, exact host in limits.yaml server.script_fetch_allowlist (default: Polymarket gamma/data/clob, api.binance.com). GET/POST, string body ≤ 256 KB, Cookie/Authorization/Host headers dropped, ≤ 3 redirects, 10 s, 2 MB, max 6 in flight. Response: ok, status, headers.get(), text(), json()." />
                </div>
              </section>

              {/* Scheduling */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Scheduling</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.setInterval(fn, ms)" ret="string" desc="Run a function repeatedly. Returns a handle. Auto-cleaned on stop." />
                  <ApiMethod sig="ctx.setTimeout(fn, ms)" ret="string" desc="Run a function after a delay. Returns a handle." />
                  <ApiMethod sig="ctx.clearInterval(handle)" ret="void" desc="Cancel a scheduled interval" />
                  <ApiMethod sig="ctx.clearTimeout(handle)" ret="void" desc="Cancel a scheduled timeout" />
                </div>
              </section>

              {/* Logging & Events */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Logging & Events</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.log.info(...args)" ret="void" desc="Log info message (visible in bot Logs tab)" />
                  <ApiMethod sig="ctx.log.warn(...args)" ret="void" desc="Log warning" />
                  <ApiMethod sig="ctx.log.error(...args)" ret="void" desc="Log error" />
                  <ApiMethod sig="ctx.log.debug(...args)" ret="void" desc="Log debug message" />
                  <ApiMethod sig="ctx.emit(type, data?)" ret="void" desc="Emit a custom event to the dashboard UI" />
                </div>
              </section>

              {/* Storage */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Storage (per-bot, persisted)</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.storage.get<T>(key)" ret="Promise<T | null>" desc="Retrieve a persisted value by key" />
                  <ApiMethod sig="ctx.storage.set(key, value)" ret="Promise<void>" desc="Store a value (survives restarts)" />
                  <ApiMethod sig="ctx.storage.delete(key)" ret="Promise<void>" desc="Delete a stored key" />
                </div>
              </section>

              {/* Metadata */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Metadata</h4>
                <div className="space-y-2">
                  <ApiMethod sig="ctx.config" ret="Record<string, unknown>" desc="User-configured values from the bot config form (read-only)" />
                  <ApiMethod sig="ctx.botId" ret="string" desc="Unique bot instance ID" />
                  <ApiMethod sig="ctx.botName" ret="string" desc="Bot display name" />
                  <ApiMethod sig="ctx.wallet.address" ret="string" desc="Wallet public address" />
                  <ApiMethod sig="ctx.wallet.proxyAddress" ret="string?" desc="Polymarket proxy wallet address (where USDC lives)" />
                </div>
              </section>

              {/* Key Types */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Key Types</h4>
                <div className="space-y-3 text-xs">
                  <TypeBlock name="OrderOpts" fields={['maxPrice?: number', 'minPrice?: number', 'maxSlippage?: number', 'reason?: string', 'forecastId?: string', 'riskExit?: boolean']} />
                  <TypeBlock name="TradeResult" fields={['success: boolean', 'executedAmount: number', 'price: number', 'tokenAmount: number', 'error?: string', 'orderId?: string | null', 'status?: string', 'failedCheck?: string']} />
                  <TypeBlock name="LimitOrderOpts" fields={['postOnly?: boolean (default true)', 'ttlMinutes?: number', 'reason?: string', 'forecastId?: string', 'riskExit?: boolean']} />
                  <TypeBlock name="OrderResult" fields={['ok: boolean', 'orderId: string | null', 'status: string', 'filledSize: number', 'avgFillPrice: number | null', 'feeUsd: number', 'expiresAt: string | null', 'failedCheck?: string', 'error?: string']} />
                  <TypeBlock name="BotForecast" fields={['id: string', 'tokenId: string', 'probability: number', 'marketPriceAtForecast: number', 'ambiguityScore: number', 'tradeable: boolean', 'bucketState: string | null', 'horizonBucket: short | medium | long']} />
                  <TypeBlock name="MarketPrice" fields={['bid: number', 'ask: number', 'mid: number', 'spread: number']} />
                  <TypeBlock name="Position" fields={['tokenId: string', 'market?: string', 'outcome?: string', 'size: number', 'currentValue: number', 'avgPrice: number']} />
                  <TypeBlock name="Market" fields={['conditionId: string', 'slug: string', 'title: string', 'outcomes: string[]', 'tokens: MarketToken[]', 'active: boolean', 'volume: string']} />
                </div>
              </section>

              {/* Script Exports */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-widest text-accent mb-3">Script Exports</h4>
                <div className="space-y-2">
                  <ApiMethod sig="export const meta = { name, description?, version?, configSchema? }" ret="ScriptMeta" desc="Script metadata and config schema for the UI form" />
                  <ApiMethod sig="export async function onTick(ctx)" ret="Promise<void>" desc="Called every pollingIntervalMs. Put your strategy here. Framework handles the loop." />
                  <ApiMethod sig="export async function onStart(ctx)" ret="Promise<void>" desc="Optional. Called once when the bot starts. Use for one-time setup." />
                  <ApiMethod sig="export async function onStop(ctx)" ret="Promise<void>" desc="Optional. Called once when the bot stops. Clean up resources." />
                  <ApiMethod sig="export function onHeartbeat(ctx)" ret="Record<string, unknown>" desc="Optional. Called every 60s. Return metrics for the dashboard." />
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiMethod({ sig, ret, desc }: { sig: string; ret: string; desc: string }) {
  return (
    <div className="bg-[#0f0f0f] border border-[#222] rounded-lg px-3 py-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <code className="text-white text-xs font-mono">{sig}</code>
        <span className="text-gray-600 text-xs font-mono">{'->'} {ret}</span>
      </div>
      <p className="text-gray-400 text-xs mt-1">{desc}</p>
    </div>
  );
}

function TypeBlock({ name, fields }: { name: string; fields: string[] }) {
  return (
    <div className="bg-[#0f0f0f] border border-[#222] rounded-lg px-3 py-2 font-mono">
      <span className="text-accent">{name}</span>
      <span className="text-gray-600">{' {'}</span>
      {fields.map((f, i) => (
        <div key={i} className="pl-4 text-gray-300">{f}{i < fields.length - 1 ? ';' : ';'}</div>
      ))}
      <span className="text-gray-600">{'}'}</span>
    </div>
  );
}
