import { useRef, useCallback, useMemo } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';

let editorCounter = 0;

// BotContext type definitions for autocomplete
const BOT_CONTEXT_TYPES = `
declare interface OrderOpts {
  maxPrice?: number;
  maxSlippage?: number;
  retries?: number;
}

declare interface TradeResult {
  success: boolean;
  executedAmount: number;
  price: number;
  tokenAmount: number;
  error?: string;
  reasoning?: string;
}

declare interface OrderBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

declare interface Position {
  tokenId: string;
  market?: string;
  conditionId?: string;
  outcome?: string;
  size: number;
  currentValue: number;
  avgPrice: number;
}

declare interface MarketQuery {
  search?: string;
  tag?: string;
  active?: boolean;
  closed?: boolean;
  limit?: number;
  offset?: number;
}

declare interface Market {
  conditionId: string;
  questionId: string;
  slug: string;
  title: string;
  description: string;
  outcomes: string[];
  outcomePrices: string[];
  tokens: Array<{ tokenId: string; outcome: string; price: number; winner?: boolean }>;
  active: boolean;
  closed: boolean;
  volume: string;
  liquidity: string;
  endDate?: string;
  createdAt: string;
}

declare interface MarketPrice {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
}

declare interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  markets: Market[];
  startDate?: string;
  endDate?: string;
  createdAt: string;
}

declare interface BinanceTradeResult {
  success: boolean;
  orderId?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  executedQty: number;
  cummulativeQuoteQty: number;
  avgPrice: number;
  error?: string;
}

declare interface BinanceOrderBook {
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
}

declare interface BinancePosition {
  asset: string;
  free: number;
  locked: number;
  total: number;
  estimatedValueUsdt?: number;
}

declare interface BinancePrice {
  symbol: string;
  price: number;
}

declare interface BinanceContext {
  /** Market buy on Binance spot */
  buy(symbol: string, quoteAmountUsdt: number): Promise<BinanceTradeResult>;
  /** Market sell on Binance spot */
  sell(symbol: string, quantity: number): Promise<BinanceTradeResult>;
  /** Get balance for an asset (defaults to USDT) */
  getBalance(asset?: string): Promise<number>;
  /** Get Binance order book */
  getOrderBook(symbol: string, limit?: number): Promise<BinanceOrderBook>;
  /** Get current spot price */
  getPrice(symbol: string): Promise<BinancePrice>;
  /** Get all non-zero balances */
  getPositions(): Promise<BinancePosition[]>;
}

declare interface BotLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

declare interface BotStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The BotContext is provided to your script's onStart, onStop, and onHeartbeat functions.
 * It gives you access to trading, market data, scheduling, logging, and storage APIs.
 */
declare interface BotContext {
  /** User-configured values from the config form */
  readonly config: Readonly<Record<string, unknown>>;
  /** Bot ID */
  readonly botId: string;
  /** Bot name */
  readonly botName: string;

  // === Trading ===
  /** Place a buy order for a token */
  buy(tokenId: string, amountUsd: number, opts?: OrderOpts): Promise<TradeResult>;
  /** Place a sell order for a token */
  sell(tokenId: string, amountTokens: number, opts?: OrderOpts): Promise<TradeResult>;
  /** Get the order book for a token */
  getOrderBook(tokenId: string): Promise<OrderBook>;
  /** Get current positions */
  getPositions(): Promise<Position[]>;
  /** Get wallet USDC balance */
  getBalance(): Promise<number>;

  // === Market Data ===
  /** Search and filter Polymarket markets */
  getMarkets(query?: MarketQuery): Promise<Market[]>;
  /** Get bid/ask/mid price for a token */
  getMarketPrice(tokenId: string): Promise<MarketPrice>;
  /** Get event details including markets */
  getEvent(eventSlug: string): Promise<PolymarketEvent>;

  // === Binance Spot Trading ===
  /** Binance spot trading API */
  binance: BinanceContext;

  // === HTTP ===
  /** Make HTTP requests to external APIs */
  /** https GET/POST to allowlisted hosts only (limits.yaml server.script_fetch_allowlist); 10 s, 2 MB */
  fetch(url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; statusText: string; url: string; headers: { get(name: string): string | null }; text(): Promise<string>; json<T = any>(): Promise<T> }>;

  // === Scheduling (auto-cleaned on stop) ===
  /** Run a function on an interval. Returns a handle for clearInterval. */
  setInterval(fn: () => void | Promise<void>, ms: number): string;
  /** Run a function after a delay. Returns a handle for clearTimeout. */
  setTimeout(fn: () => void | Promise<void>, ms: number): string;
  /** Clear a scheduled interval */
  clearInterval(handle: string): void;
  /** Clear a scheduled timeout */
  clearTimeout(handle: string): void;

  // === Logging (visible in the Logs tab) ===
  log: BotLogger;

  // === Events (forwarded to UI) ===
  /** Emit a custom event to the dashboard */
  emit(type: string, data?: Record<string, unknown>): void;

  // === Storage (persisted to SQLite) ===
  storage: BotStorage;

  // === Wallet Info ===
  readonly wallet: { address: string; proxyAddress?: string };
}

declare const ctx: BotContext;
`;

interface ScriptEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  className?: string;
}

export function ScriptEditor({
  value,
  onChange,
  readOnly = false,
  height = '500px',
  className = '',
}: ScriptEditorProps) {
  const editorRef = useRef<any>(null);
  // Unique .ts path so Monaco treats the model as TypeScript (prevents
  // "Type annotations can only be used in TypeScript files" errors)
  const editorPath = useMemo(() => `file:///bot-script-${++editorCounter}.ts`, []);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Configure TypeScript compiler options
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution:
          monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowJs: true,
        strict: false,
        noEmit: true,
        esModuleInterop: true,
        allowNonTsExtensions: true,
      });

      // Add BotContext type definitions for autocomplete
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        BOT_CONTEXT_TYPES,
        'file:///botcontext.d.ts'
      );

      // Set editor options
      editor.updateOptions({
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "'SF Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
        fontLigatures: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: 'on',
        padding: { top: 12, bottom: 12 },
        readOnly,
      });
    },
    [readOnly]
  );

  const handleChange = useCallback(
    (val: string | undefined) => {
      if (onChange && val !== undefined) {
        onChange(val);
      }
    },
    [onChange]
  );

  return (
    <div className={`rounded-lg overflow-hidden border border-[#2a2a2a] ${height === '100%' ? 'h-full' : ''} ${className}`}>
      <Editor
        height={height}
        defaultLanguage="typescript"
        path={editorPath}
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        theme="vs-dark"
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          fontFamily: "'SF Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace",
          scrollBeyondLastLine: false,
          tabSize: 2,
          padding: { top: 12, bottom: 12 },
        }}
        loading={
          <div className="flex items-center justify-center h-full bg-[#1e1e1e] text-gray-500">
            Loading editor...
          </div>
        }
      />
    </div>
  );
}
