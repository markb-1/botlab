import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBots } from '../hooks/useBots';
import { useScripts, useScriptSchema } from '../hooks/useScripts';
import { useWallets } from '../hooks/useWallets';
import type { Script } from '../types';
import { useOverview } from '../hooks/useRisk';

/** Which exchanges a script uses, from its source (ctx.binance.* vs Polymarket calls) */
function scriptExchanges(source: string): { binance: boolean; polymarket: boolean } {
  return {
    binance: /ctx\.binance\b/.test(source),
    polymarket: /ctx\.(polymarket|clob|buy|sell|ledger)\b/.test(source),
  };
}

// Trader entry with address and nickname
interface TraderEntry {
  address: string;
  nickname: string;
}

export function BotCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { createBot, isCreating } = useBots();
  const { scripts, isLoading: scriptsLoading } = useScripts();
  const { wallets, isLoading: walletsLoading } = useWallets();

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [scriptId, setScriptId] = useState<string>(searchParams.get('scriptId') || '');
  const [walletId, setWalletId] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<'live' | 'paper'>('paper');
  const { data: overview } = useOverview();
  /** live_trading.enabled is false (or the config is invalid): live bots could not start */
  const liveDisabled = overview ? overview.liveTradingEnabled !== true : false;
  const effectiveMode: 'live' | 'paper' = liveDisabled ? 'paper' : mode;
  const [paperBalance, setPaperBalance] = useState(10000);
  const [error, setError] = useState<string | null>(null);

  // Trader input state
  const [traderAddress, setTraderAddress] = useState('');
  const [traderNickname, setTraderNickname] = useState('');
  const [traders, setTraders] = useState<TraderEntry[]>([]);

  // Category input state
  const [categoryInput, setCategoryInput] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  const { schema } = useScriptSchema(scriptId || '');
  const selectedScript = scripts.find((s) => s.id === scriptId);
  const defaultName = selectedScript ? `${selectedScript.name} Bot` : '';
  const venues = scriptExchanges(selectedScript?.source ?? '');
  // Paper balances: USDC for Polymarket, USDT for Binance (USDT-quoted pairs only)
  const quoteCurrency = venues.binance && !venues.polymarket ? 'USDT' : venues.polymarket && !venues.binance ? 'USDC' : 'USDC / USDT';
  const exchangeLabel = venues.binance && !venues.polymarket ? 'Binance' : venues.polymarket && !venues.binance ? 'Polymarket' : 'Polymarket / Binance';
  const availableWallets = wallets.filter((w) => !w.currentBotId);

  // Auto-advance to step 2 if scriptId is set from URL
  useEffect(() => {
    if (searchParams.get('scriptId') && scripts.length > 0) {
      const script = scripts.find((s) => s.id === searchParams.get('scriptId'));
      if (script) {
        setStep(2);
        setName('');
      }
    }
  }, [searchParams, scripts]);

  // Initialize config with default values when schema loads
  useEffect(() => {
    if (schema?.properties) {
      const defaults: Record<string, unknown> = {};
      Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
        if (prop.default !== undefined) {
          defaults[key] = prop.default;
        }
      });
      setConfig(defaults);
    }
  }, [schema]);

  // Sync traders to config
  useEffect(() => {
    if (traders.length > 0 || config.traders) {
      setConfig((prev) => ({
        ...prev,
        traders: traders.map((t) => t.address),
      }));
    }
  }, [traders]);

  // Sync categories to config
  useEffect(() => {
    if (categories.length > 0 || config.categories) {
      setConfig((prev) => ({
        ...prev,
        categories: categories,
      }));
    }
  }, [categories]);

  const handleSelectScript = (script: Script) => {
    setScriptId(script.id);
    setName(''); // the suggested name is the placeholder, so typing does not append to it
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const finalName = name.trim() || defaultName;
    if (!finalName) { setError('Name is required'); return; }
    if (!scriptId) { setError('Script is required'); return; }
    if (effectiveMode === 'live' && !walletId) { setError('Wallet is required'); return; }

    try {
      const finalConfig = effectiveMode === 'paper' ? { ...config, paperBalance } : config;
      await createBot({
        scriptId,
        name: finalName,
        walletId: effectiveMode === 'paper' ? undefined : walletId,
        config: finalConfig,
        mode: effectiveMode,
      });
      navigate('/bots');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to create bot');
    }
  };

  // Trader helpers
  const handleAddTrader = () => {
    const address = traderAddress.trim().toLowerCase();
    if (!address) return;
    if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      setError('Invalid Ethereum address format');
      return;
    }
    if (traders.some((t) => t.address.toLowerCase() === address)) {
      setError('Trader already added');
      return;
    }
    setError(null);
    setTraders([...traders, { address, nickname: traderNickname.trim() || '' }]);
    setTraderAddress('');
    setTraderNickname('');
  };

  // Category helpers
  const COMMON_CATEGORIES = ['NBA', 'NFL', 'NHL', 'MLB', 'Soccer', 'Tennis', 'MMA', 'Boxing'];
  const handleAddCategory = (cat?: string) => {
    const val = (cat || categoryInput).trim();
    if (!val) return;
    if (categories.some((c) => c.toLowerCase() === val.toLowerCase())) return;
    setCategories([...categories, val]);
    setCategoryInput('');
  };

  const renderConfigField = (key: string, prop: any) => {
    const value = config[key];

    // Custom traders field
    if (key === 'traders') {
      return (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-300">{prop.title || 'Traders'}</label>
          {prop.description && <p className="text-xs text-gray-500">{prop.description}</p>}
          <div className="flex gap-2">
            <input type="text" value={traderAddress}
              onChange={(e) => setTraderAddress(e.target.value)}
              placeholder="0x... wallet address"
              className="flex-1 rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm font-mono" />
            <input type="text" value={traderNickname}
              onChange={(e) => setTraderNickname(e.target.value)}
              placeholder="Nickname"
              className="w-28 rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm sm:text-sm" />
            <button type="button" onClick={handleAddTrader}
              className="px-3 py-2 bg-accent text-white rounded-md hover:bg-accent-hover text-sm font-medium">
              Add
            </button>
          </div>
          {traders.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {traders.map((t) => (
                <span key={t.address} className="inline-flex items-center gap-1 bg-accent-muted text-accent rounded-full px-3 py-1 text-sm">
                  {t.nickname || `${t.address.slice(0, 6)}...${t.address.slice(-4)}`}
                  <button type="button" onClick={() => setTraders(traders.filter((x) => x.address !== t.address))}
                    className="ml-1 text-accent hover:text-white">&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Custom categories field
    if (key === 'categories') {
      return (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-300">{prop.title || 'Categories'}</label>
          {prop.description && <p className="text-xs text-gray-500">{prop.description}</p>}
          <div className="flex flex-wrap gap-2">
            {COMMON_CATEGORIES.filter((c) => !categories.includes(c)).map((c) => (
              <button key={c} type="button" onClick={() => handleAddCategory(c)}
                className="px-3 py-1 text-sm bg-[#2a2a2a] text-gray-300 rounded-full hover:bg-[#333]">
                + {c}
              </button>
            ))}
          </div>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 bg-accent-muted text-accent rounded-full px-3 py-1 text-sm">
                  {c}
                  <button type="button" onClick={() => setCategories(categories.filter((x) => x !== c))}
                    className="ml-1 text-accent hover:text-white">&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Boolean
    if (prop.type === 'boolean') {
      return (
        <label className="flex items-center">
          <input type="checkbox" checked={!!value}
            onChange={(e) => setConfig({ ...config, [key]: e.target.checked })}
            className="rounded border-[#2a2a2a] bg-[#111] text-accent focus:ring-accent" />
          <span className="ml-2 text-sm text-gray-300">{prop.title || key}</span>
          {prop.description && <span className="ml-2 text-xs text-gray-500">({prop.description})</span>}
        </label>
      );
    }

    // Number
    if (prop.type === 'number' || prop.type === 'integer') {
      return (
        <div>
          <label className="block text-sm font-medium text-gray-300">{prop.title || key}</label>
          {prop.description && <p className="text-xs text-gray-500 mb-1">{prop.description}</p>}
          <input type="number" value={value as number ?? ''}
            onChange={(e) => setConfig({ ...config, [key]: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
            min={prop.minimum} max={prop.maximum} step={prop.type === 'integer' ? 1 : 0.01}
            className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm" />
        </div>
      );
    }

    // Enum
    if (prop.enum) {
      return (
        <div>
          <label className="block text-sm font-medium text-gray-300">{prop.title || key}</label>
          {prop.description && <p className="text-xs text-gray-500 mb-1">{prop.description}</p>}
          <select value={value as string || ''}
            onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
            className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm">
            <option value="">Select...</option>
            {prop.enum.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </div>
      );
    }

    // Array
    if (prop.type === 'array') {
      const arrVal = (value as string[]) || [];
      return (
        <div>
          <label className="block text-sm font-medium text-gray-300">{prop.title || key}</label>
          {prop.description && <p className="text-xs text-gray-500 mb-1">{prop.description}</p>}
          <textarea value={arrVal.join('\n')}
            onChange={(e) => setConfig({ ...config, [key]: e.target.value.split('\n').filter(Boolean) })}
            placeholder="One item per line" rows={3}
            className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm font-mono text-sm" />
        </div>
      );
    }

    // Default text
    return (
      <div>
        <label className="block text-sm font-medium text-gray-300">{prop.title || key}</label>
        {prop.description && <p className="text-xs text-gray-500 mb-1">{prop.description}</p>}
        <input type="text" value={value as string || ''}
          onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
          className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm" />
      </div>
    );
  };

  // Step 1: Script picker
  if (step === 1) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white">Create Bot</h2>
          <p className="mt-1 text-sm text-gray-400">Choose a script to power your bot</p>
        </div>

        {scriptsLoading ? (
          <div className="text-center py-12 text-gray-500">Loading scripts...</div>
        ) : (
          <div className="space-y-6">
            {/* Templates */}
            <div>
              <h3 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider">Templates</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {scripts.filter((s) => s.isTemplate).map((script) => (
                  <button key={script.id} type="button" onClick={() => handleSelectScript(script)}
                    aria-label={`Use template ${script.name}`} title={script.description || script.name}
                    className="text-left bg-surface border border-[#2a2a2a] rounded-xl p-4 hover:border-accent/50 transition-colors group">
                    <h4 className="text-base font-medium text-white group-hover:text-accent transition-colors">{script.name}</h4>
                    <p className="text-sm text-gray-400 mt-1 line-clamp-2">{script.description}</p>
                    <span className="inline-block mt-2 text-xs text-accent">v{script.version}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom scripts */}
            {scripts.filter((s) => !s.isTemplate).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider">Custom Scripts</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {scripts.filter((s) => !s.isTemplate).map((script) => (
                    <button key={script.id} type="button" onClick={() => handleSelectScript(script)}
                      aria-label={`Use script ${script.name}`} title={script.description || script.name}
                      className="text-left bg-surface border border-[#2a2a2a] rounded-xl p-4 hover:border-accent/50 transition-colors group">
                      <h4 className="text-base font-medium text-white group-hover:text-accent transition-colors">{script.name}</h4>
                      <p className="text-sm text-gray-400 mt-1 line-clamp-2">{script.description || 'No description'}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-4">
              <button onClick={() => navigate('/bots')}
                className="px-4 py-2 border border-[#333] rounded-xl text-sm font-medium text-gray-300 hover:bg-surface-light">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Step 2: Configure & create
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <button onClick={() => { setStep(1); setScriptId(''); }}
          className="text-sm text-gray-500 hover:text-gray-300 mb-2 block">
          ← Choose different script
        </button>
        <h2 className="text-2xl font-bold text-white">Create Bot</h2>
        <p className="mt-1 text-sm text-gray-400">
          Using <span className="text-accent">{selectedScript?.name || 'Unknown Script'}</span>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Basic info */}
        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-medium text-white">Basic Information</h3>
          <div>
            <label htmlFor="bot-name" className="block text-sm font-medium text-gray-300">Name</label>
            <input id="bot-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={defaultName || 'My Trading Bot'}
              className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm" />
          </div>
          {/* Mode toggle */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Mode</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode('live')} disabled={liveDisabled}
                title={liveDisabled ? 'Live trading is disabled in limits.yaml (live_trading.enabled: false)' : undefined}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  effectiveMode === 'live'
                    ? 'bg-accent/15 border-accent text-accent'
                    : 'bg-[#111] border-[#2a2a2a] text-gray-400 hover:border-[#444]'
                }`}>
                Live Trading
              </button>
              <button type="button" onClick={() => setMode('paper')}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  effectiveMode === 'paper'
                    ? 'bg-amber-500/15 border-amber-500 text-amber-400'
                    : 'bg-[#111] border-[#2a2a2a] text-gray-400 hover:border-[#444]'
                }`}>
                Paper Trading
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              {effectiveMode === 'paper'
                ? 'Simulates trades with virtual funds using real market data. A wallet is auto-generated.'
                : `Executes real trades on ${exchangeLabel}.`}
            </p>
            {liveDisabled && (
              <p className="text-xs text-yellow-400 mt-1.5">
                Live trading is disabled (<code>live_trading.enabled: false</code> in limits.yaml, Risk page). New bots are paper bots.
              </p>
            )}
            {mode === 'live' && !liveDisabled && (
              <div className="mt-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-200">
                <strong>Real money.</strong> The bot trades the selected wallet’s funds within the risk limits. Bots on a new script still start in the paper stage and must
                earn probation through the ramp; check the limits and the mandate on the Risk page first.
              </div>
            )}
          </div>

          {/* Paper balance */}
          {effectiveMode === 'paper' && (
            <div>
              <label htmlFor="paper-balance" className="block text-sm font-medium text-gray-300">Starting Balance ({quoteCurrency})</label>
              <input id="paper-balance" type="number" value={paperBalance}
                onChange={(e) => setPaperBalance(Math.max(1, parseFloat(e.target.value) || 0))}
                min={1} step="any"
                className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-amber-500 focus:ring-amber-500 sm:text-sm" />
              <p className="text-xs text-gray-500 mt-1">
                Virtual {quoteCurrency} balance for paper trading. Orders are also capped by the bot&apos;s stage allocation
                (risk limits), which is usually the smaller number.
              </p>
            </div>
          )}

          {/* Wallet selector (live mode only) */}
          {effectiveMode === 'live' && (
            <div>
              <label className="block text-sm font-medium text-gray-300">Wallet</label>
              {walletsLoading ? (
                <p className="mt-1 text-sm text-gray-500">Loading wallets...</p>
              ) : availableWallets.length === 0 ? (
                <p className="mt-1 text-sm text-red-300">No available wallets. Please create a wallet first.</p>
              ) : (
                <select value={walletId} onChange={(e) => setWalletId(e.target.value)}
                  className="mt-1 block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm">
                  <option value="">Select wallet...</option>
                  {availableWallets.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.address.slice(0, 6)}...{w.address.slice(-4)})</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {/* Config fields */}
        {schema?.properties && Object.keys(schema.properties).length > 0 && (
          <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6 space-y-4">
            <h3 className="text-lg font-medium text-white">Configuration</h3>
            {Object.entries(schema.properties as Record<string, any>).map(([key, prop]) => (
              <div key={key}>{renderConfigField(key, prop)}</div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-4">
          <button type="button" onClick={() => navigate('/bots')}
            className="px-4 py-2 border border-[#333] rounded-xl text-sm font-medium text-gray-300 hover:bg-surface-light">
            Cancel
          </button>
          <button type="submit" disabled={isCreating || !(name.trim() || defaultName) || !scriptId || (effectiveMode === 'live' && !walletId)}
            className="px-4 py-2 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed">
            {isCreating ? 'Creating...' : 'Create Bot'}
          </button>
        </div>
      </form>
    </div>
  );
}
