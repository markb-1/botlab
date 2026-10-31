import { useParams, Link } from 'react-router-dom';
import { useBotTrades } from '../hooks/useBots';
import type { BotTrade } from '../types';

/** Shorten a long token ID or symbol for display */
function formatSymbol(trade: BotTrade): string {
  if (trade.market) return trade.market;
  if (trade.symbol) {
    // Token IDs are very long numbers — truncate them
    if (trade.symbol.length > 20) {
      return `${trade.symbol.slice(0, 8)}...${trade.symbol.slice(-6)}`;
    }
    return trade.symbol;
  }
  return '-';
}

function formatPrice(price?: number): string {
  if (price == null) return '-';
  if (price < 0.01) return `$${price.toPrecision(4)}`;
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${price.toFixed(4)}`;
}

function formatAmount(amount?: number): string {
  if (amount == null) return '-';
  return `$${amount.toFixed(2)}`;
}

export function BotTrades() {
  const { id } = useParams<{ id: string }>();
  const { trades, count, isLoading, error, refetch } = useBotTrades(id!, 24);

  if (isLoading) {
    return <div className="text-center py-8 text-gray-500">Loading trades...</div>;
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-red-500 mb-4">Error loading trades</p>
        <Link to="/" className="text-accent hover:text-accent-hover">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← Back to Dashboard
          </Link>
          <h2 className="mt-2 text-2xl font-bold text-white">
            Bot Trades
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Last 24 hours ({count} trades)
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="px-4 py-2 border border-[#333] text-gray-300 rounded-md hover:bg-[#222222] font-medium"
        >
          Refresh
        </button>
      </div>

      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl">
        {trades.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No trades in the last 24 hours
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[#2a2a2a]">
              <thead className="bg-[#111111]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Exchange</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Market</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Bet</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Side</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Quantity</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Mode</th>
                </tr>
              </thead>
              <tbody className="bg-[#1a1a1a] divide-y divide-[#2a2a2a]">
                {trades.map((trade) => (
                  <tr key={trade.id} className="hover:bg-[#222222]">
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-400">
                      {new Date(trade.executedAt).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        trade.exchange === 'binance'
                          ? 'bg-yellow-500/10 text-yellow-400'
                          : 'bg-blue-500/10 text-blue-400'
                      }`}>
                        {trade.exchange || 'polymarket'}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="text-sm text-gray-100 max-w-xs truncate" title={trade.market || trade.symbol}>
                        {formatSymbol(trade)}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      {trade.outcome ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400">
                          {trade.outcome}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-500">-</span>
                      )}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        trade.side === 'BUY'
                          ? 'bg-green-500/10 text-green-400'
                          : 'bg-red-500/10 text-red-400'
                      }`}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-right text-sm text-gray-100">
                      {formatPrice(trade.price)}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-right text-sm text-gray-100">
                      {trade.quantity != null ? trade.quantity.toFixed(4) : '-'}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-100">
                      {formatAmount(trade.quoteAmount || trade.botBetSize)}
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        trade.simulated
                          ? 'bg-amber-500/10 text-amber-400'
                          : 'bg-green-500/10 text-green-400'
                      }`}>
                        {trade.simulated ? 'Paper' : 'Live'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
