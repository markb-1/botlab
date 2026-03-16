export interface BacktestRun {
  id: string;
  scriptId: string;
  scriptName: string | null;
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  initialBalance: number;
  finalBalance: number | null;
  totalTrades: number;
  winTrades: number;
  loseTrades: number;
  totalPnl: number | null;
  maxDrawdown: number | null;
  sharpeRatio: number | null;
  config: Record<string, unknown> | null;
  status: string;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface BacktestTrade {
  id: string;
  runId: string;
  side: string;
  symbol: string;
  price: number;
  quantity: number;
  quoteAmount: number;
  timestamp: number;
  balanceAfter: number | null;
  createdAt: string;
}

export interface BacktestRunResult {
  run: BacktestRun;
  trades: BacktestTrade[];
}

export interface BacktestEngineResult {
  runId: string;
  status: 'completed' | 'error';
  error?: string;
  stats: {
    initialBalance: number;
    finalBalance: number;
    totalPnl: number;
    totalPnlPct: number;
    totalTrades: number;
    winTrades: number;
    loseTrades: number;
    winRate: number;
    maxDrawdown: number;
    sharpeRatio: number;
    durationMs: number;
  };
}
