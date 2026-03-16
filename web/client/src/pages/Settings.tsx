import { useState, useEffect, useCallback } from 'react';
import { useSettings } from '../hooks/useSettings';

export function Settings() {
  const {
    settings,
    isLoading,
    updateSettings,
    testRpc,
    testClob,
    saveBinance,
    clearBinance,
    testBinance,
    saveClaude,
    clearClaude,
    testClaude,
    saveAiSystemPrompt,
    getAiSystemPrompt,
    isUpdating,
    isTestingRpc,
    isTestingClob,
    isSavingBinance,
    isTestingBinance,
    isSavingClaude,
    isTestingClaude,
  } = useSettings();

  const [rpcUrl, setRpcUrl] = useState('');
  const [clobHttpUrl, setClobHttpUrl] = useState('');
  const [clobWsUrl, setClobWsUrl] = useState('');
  const [usdcContractAddress, setUsdcContractAddress] = useState('');
  const [alchemyApiKey, setAlchemyApiKey] = useState('');

  // Binance fields
  const [binanceApiKey, setBinanceApiKey] = useState('');
  const [binanceApiSecret, setBinanceApiSecret] = useState('');

  // Claude fields
  const [claudeApiKey, setClaudeApiKey] = useState('');
  const [claudeMessage, setClaudeMessage] = useState<{ success: boolean; message: string } | null>(null);
  const [claudeTestResult, setClaudeTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [customSystemPrompt, setCustomSystemPrompt] = useState('');
  const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);
  const [systemPromptLoaded, setSystemPromptLoaded] = useState(false);
  const [systemPromptMessage, setSystemPromptMessage] = useState<{ success: boolean; message: string } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [rpcTestResult, setRpcTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [clobTestResult, setClobTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [binanceTestResult, setBinanceTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [binanceMessage, setBinanceMessage] = useState<{ success: boolean; message: string } | null>(null);

  // Load settings into form
  useEffect(() => {
    if (settings) {
      setRpcUrl(settings.rpcUrl || '');
      setClobHttpUrl(settings.clobHttpUrl || '');
      setClobWsUrl(settings.clobWsUrl || '');
      setUsdcContractAddress(settings.usdcContractAddress || '');
      setAlchemyApiKey(settings.alchemyApiKey || '');
    }
  }, [settings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      await updateSettings({
        rpcUrl: rpcUrl.trim(),
        clobHttpUrl: clobHttpUrl.trim(),
        clobWsUrl: clobWsUrl.trim(),
        usdcContractAddress: usdcContractAddress.trim(),
        alchemyApiKey: alchemyApiKey.trim(),
      });
      setSuccess('Settings saved successfully');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save settings');
    }
  };

  const handleTestRpc = async () => {
    setRpcTestResult(null);
    try {
      const result = await testRpc(rpcUrl.trim());
      if (result.success) {
        setRpcTestResult({ success: true, message: `Connected! Block: ${result.data?.blockNumber}` });
      } else {
        setRpcTestResult({ success: false, message: result.message || 'Connection failed' });
      }
    } catch (err: any) {
      setRpcTestResult({ success: false, message: err.response?.data?.message || err.message || 'Test failed' });
    }
  };

  const handleTestClob = async () => {
    setClobTestResult(null);
    try {
      const result = await testClob(clobHttpUrl.trim());
      if (result.success) {
        setClobTestResult({ success: true, message: 'CLOB API connection successful' });
      } else {
        setClobTestResult({ success: false, message: result.message || 'Connection failed' });
      }
    } catch (err: any) {
      setClobTestResult({ success: false, message: err.response?.data?.message || err.message || 'Test failed' });
    }
  };

  const handleTestBinance = async () => {
    setBinanceTestResult(null);
    try {
      const creds = binanceApiKey.trim() && binanceApiSecret.trim()
        ? { apiKey: binanceApiKey.trim(), apiSecret: binanceApiSecret.trim() }
        : undefined;
      const result = await testBinance(creds);
      if (result.success) {
        setBinanceTestResult({ success: true, message: 'Binance API connected successfully' });
      } else {
        setBinanceTestResult({ success: false, message: result.error || result.message || 'Connection failed' });
      }
    } catch (err: any) {
      setBinanceTestResult({ success: false, message: err.message || 'Test failed' });
    }
  };

  const handleSaveBinance = async () => {
    setBinanceMessage(null);
    if (!binanceApiKey.trim() || !binanceApiSecret.trim()) {
      setBinanceMessage({ success: false, message: 'Both API Key and Secret are required' });
      return;
    }
    try {
      const result = await saveBinance({ apiKey: binanceApiKey.trim(), apiSecret: binanceApiSecret.trim() });
      if (result.success) {
        setBinanceMessage({ success: true, message: 'Binance credentials saved' });
        setBinanceApiKey('');
        setBinanceApiSecret('');
      } else {
        setBinanceMessage({ success: false, message: result.error || 'Failed to save' });
      }
    } catch (err: any) {
      setBinanceMessage({ success: false, message: err.message || 'Failed to save' });
    }
  };

  const handleClearBinance = async () => {
    setBinanceMessage(null);
    try {
      const result = await clearBinance();
      if (result.success) {
        setBinanceMessage({ success: true, message: 'Binance credentials removed' });
      } else {
        setBinanceMessage({ success: false, message: result.error || 'Failed to clear' });
      }
    } catch (err: any) {
      setBinanceMessage({ success: false, message: err.message || 'Failed to clear' });
    }
  };

  const handleSaveClaude = async () => {
    setClaudeMessage(null);
    if (!claudeApiKey.trim()) {
      setClaudeMessage({ success: false, message: 'API Key is required' });
      return;
    }
    try {
      const result = await saveClaude({ apiKey: claudeApiKey.trim() });
      if (result.success) {
        setClaudeMessage({ success: true, message: 'Claude API key saved' });
        setClaudeApiKey('');
      } else {
        setClaudeMessage({ success: false, message: result.error || 'Failed to save' });
      }
    } catch (err: any) {
      setClaudeMessage({ success: false, message: err.message || 'Failed to save' });
    }
  };

  const handleClearClaude = async () => {
    setClaudeMessage(null);
    try {
      const result = await clearClaude();
      if (result.success) {
        setClaudeMessage({ success: true, message: 'Claude API key removed' });
      } else {
        setClaudeMessage({ success: false, message: result.error || 'Failed to clear' });
      }
    } catch (err: any) {
      setClaudeMessage({ success: false, message: err.message || 'Failed to clear' });
    }
  };

  const handleTestClaude = async () => {
    setClaudeTestResult(null);
    try {
      const creds = claudeApiKey.trim() ? { apiKey: claudeApiKey.trim() } : undefined;
      const result = await testClaude(creds);
      if (result.success) {
        setClaudeTestResult({ success: true, message: 'Claude API connected successfully' });
      } else {
        setClaudeTestResult({ success: false, message: result.error || result.message || 'Connection failed' });
      }
    } catch (err: any) {
      setClaudeTestResult({ success: false, message: err.message || 'Test failed' });
    }
  };

  const loadSystemPrompt = useCallback(async () => {
    if (systemPromptLoaded) return;
    try {
      const result = await getAiSystemPrompt() as { prompt: string };
      setCustomSystemPrompt(result.prompt || '');
      setSystemPromptLoaded(true);
    } catch {
      // Ignore
    }
  }, [getAiSystemPrompt, systemPromptLoaded]);

  const handleExpandSystemPrompt = () => {
    if (!systemPromptExpanded) {
      loadSystemPrompt();
    }
    setSystemPromptExpanded(!systemPromptExpanded);
  };

  const handleSaveSystemPrompt = async () => {
    setSystemPromptMessage(null);
    try {
      const result = await saveAiSystemPrompt({ prompt: customSystemPrompt });
      if (result.success) {
        setSystemPromptMessage({ success: true, message: 'System prompt saved' });
        setTimeout(() => setSystemPromptMessage(null), 3000);
      } else {
        setSystemPromptMessage({ success: false, message: result.error || 'Failed to save' });
      }
    } catch (err: any) {
      setSystemPromptMessage({ success: false, message: err.message || 'Failed to save' });
    }
  };

  if (isLoading) {
    return <div className="text-center py-8 text-gray-500">Loading settings...</div>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Settings</h2>
        <p className="mt-1 text-sm text-gray-400">
          Configure global settings for your multi-bot system
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {success && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
          <p className="text-sm text-green-300">{success}</p>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Blockchain Settings */}
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-medium text-white">Blockchain Settings</h3>

          <div>
            <label className="block text-sm font-medium text-gray-300">RPC URL</label>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                placeholder="https://polygon-rpc.com"
                className="flex-1 rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm"
              />
              <button
                type="button"
                onClick={handleTestRpc}
                disabled={!rpcUrl || isTestingRpc}
                className="px-3 py-2 border border-[#333] rounded-lg text-sm font-medium text-gray-300 hover:bg-[#222222] disabled:opacity-50"
              >
                {isTestingRpc ? 'Testing...' : 'Test'}
              </button>
            </div>
            {rpcTestResult && (
              <p className={`mt-1 text-sm ${rpcTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {rpcTestResult.message}
              </p>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Polygon RPC endpoint for blockchain interactions
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300">USDC Contract Address</label>
            <input
              type="text"
              value={usdcContractAddress}
              onChange={(e) => setUsdcContractAddress(e.target.value)}
              placeholder="0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
              className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm font-mono"
            />
            <p className="mt-1 text-xs text-gray-500">
              USDC token contract address on Polygon
            </p>
          </div>
        </div>

        {/* Polymarket API Settings */}
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-medium text-white">Polymarket API Settings</h3>

          <div>
            <label className="block text-sm font-medium text-gray-300">CLOB HTTP URL</label>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={clobHttpUrl}
                onChange={(e) => setClobHttpUrl(e.target.value)}
                placeholder="https://clob.polymarket.com"
                className="flex-1 rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm"
              />
              <button
                type="button"
                onClick={handleTestClob}
                disabled={!clobHttpUrl || isTestingClob}
                className="px-3 py-2 border border-[#333] rounded-lg text-sm font-medium text-gray-300 hover:bg-[#222222] disabled:opacity-50"
              >
                {isTestingClob ? 'Testing...' : 'Test'}
              </button>
            </div>
            {clobTestResult && (
              <p className={`mt-1 text-sm ${clobTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {clobTestResult.message}
              </p>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Polymarket CLOB API endpoint for trading
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300">CLOB WebSocket URL</label>
            <input
              type="text"
              value={clobWsUrl}
              onChange={(e) => setClobWsUrl(e.target.value)}
              placeholder="wss://ws-subscriptions-clob.polymarket.com/ws"
              className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              Polymarket WebSocket endpoint for real-time updates
            </p>
          </div>
        </div>

        {/* API Keys */}
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-medium text-white">API Keys</h3>

          <div>
            <label className="block text-sm font-medium text-gray-300">Alchemy API Key</label>
            <input
              type="password"
              value={alchemyApiKey}
              onChange={(e) => setAlchemyApiKey(e.target.value)}
              placeholder="Enter your Alchemy API key"
              className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm font-mono"
            />
            <p className="mt-1 text-xs text-gray-500">
              Required for Kelly Criterion sizing (trader win rate analysis). Get a free key at{' '}
              <a href="https://alchemy.com" target="_blank" rel="noopener noreferrer" className="text-[#e8622c] hover:text-[#ff7a3d]">
                alchemy.com
              </a>
            </p>
          </div>
        </div>

        {/* Default Values Info */}
        <div className="bg-[#e8622c]/5 border border-[#e8622c]/20 rounded-xl p-4">
          <h4 className="text-sm font-medium text-[#e8622c] mb-2">Default Values</h4>
          <ul className="text-sm text-gray-400 space-y-1">
            <li>RPC URL: https://polygon-rpc.com</li>
            <li>CLOB HTTP: https://clob.polymarket.com</li>
            <li>CLOB WS: wss://ws-subscriptions-clob.polymarket.com/ws</li>
            <li>USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359</li>
          </ul>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isUpdating}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#e8622c] hover:bg-[#ff7a3d] disabled:opacity-50"
          >
            {isUpdating ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* Binance Settings - separate from the main form since credentials are saved independently */}
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-white">Binance Settings</h3>
          {settings?.hasBinanceCredentials && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
              Configured
            </span>
          )}
        </div>
        <p className="text-sm text-gray-400">
          Connect your Binance account to enable spot trading via <code className="text-gray-300">ctx.binance.*</code> in scripts.
          Credentials are encrypted and never sent to the renderer.
        </p>

        {binanceMessage && (
          <div className={`rounded-lg p-3 ${binanceMessage.success ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
            <p className={`text-sm ${binanceMessage.success ? 'text-green-300' : 'text-red-300'}`}>{binanceMessage.message}</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-300">API Key</label>
          <input
            type="password"
            value={binanceApiKey}
            onChange={(e) => setBinanceApiKey(e.target.value)}
            placeholder={settings?.hasBinanceCredentials ? '(saved - enter new to replace)' : 'Enter your Binance API key'}
            className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm font-mono"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300">API Secret</label>
          <input
            type="password"
            value={binanceApiSecret}
            onChange={(e) => setBinanceApiSecret(e.target.value)}
            placeholder={settings?.hasBinanceCredentials ? '(saved - enter new to replace)' : 'Enter your Binance API secret'}
            className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm font-mono"
          />
        </div>

        {binanceTestResult && (
          <p className={`text-sm ${binanceTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {binanceTestResult.message}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleTestBinance}
            disabled={isTestingBinance || (!binanceApiKey.trim() && !settings?.hasBinanceCredentials)}
            className="px-3 py-2 border border-[#333] rounded-lg text-sm font-medium text-gray-300 hover:bg-[#222222] disabled:opacity-50"
          >
            {isTestingBinance ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            type="button"
            onClick={handleSaveBinance}
            disabled={isSavingBinance || !binanceApiKey.trim() || !binanceApiSecret.trim()}
            className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-[#e8622c] hover:bg-[#ff7a3d] disabled:opacity-50"
          >
            {isSavingBinance ? 'Saving...' : 'Save Credentials'}
          </button>
          {settings?.hasBinanceCredentials && (
            <button
              type="button"
              onClick={handleClearBinance}
              className="px-3 py-2 border border-red-500/30 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              Remove
            </button>
          )}
        </div>

        <p className="text-xs text-gray-500">
          Create API keys at{' '}
          <a href="https://www.binance.com/en/my/settings/api-management" target="_blank" rel="noopener noreferrer" className="text-[#e8622c] hover:text-[#ff7a3d]">
            Binance API Management
          </a>
          . Enable Spot trading permissions only.
        </p>
      </div>

      {/* Claude AI Settings */}
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-white">Claude AI</h3>
          {settings?.hasClaudeApiKey && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
              Configured
            </span>
          )}
        </div>
        <p className="text-sm text-gray-400">
          Connect your Anthropic API key to enable AI-powered script generation and editing in the script editor.
          The key is encrypted and only used in the main process.
        </p>

        {claudeMessage && (
          <div className={`rounded-lg p-3 ${claudeMessage.success ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
            <p className={`text-sm ${claudeMessage.success ? 'text-green-300' : 'text-red-300'}`}>{claudeMessage.message}</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-300">API Key</label>
          <input
            type="password"
            value={claudeApiKey}
            onChange={(e) => setClaudeApiKey(e.target.value)}
            placeholder={settings?.hasClaudeApiKey ? '(saved - enter new to replace)' : 'sk-ant-...'}
            className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-[#111] text-gray-100 placeholder-gray-500 shadow-sm focus:border-[#e8622c] focus:ring-[#e8622c] sm:text-sm font-mono"
          />
        </div>

        {claudeTestResult && (
          <p className={`text-sm ${claudeTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
            {claudeTestResult.message}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleTestClaude}
            disabled={isTestingClaude || (!claudeApiKey.trim() && !settings?.hasClaudeApiKey)}
            className="px-3 py-2 border border-[#333] rounded-lg text-sm font-medium text-gray-300 hover:bg-[#222222] disabled:opacity-50"
          >
            {isTestingClaude ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            type="button"
            onClick={handleSaveClaude}
            disabled={isSavingClaude || !claudeApiKey.trim()}
            className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-[#e8622c] hover:bg-[#ff7a3d] disabled:opacity-50"
          >
            {isSavingClaude ? 'Saving...' : 'Save API Key'}
          </button>
          {settings?.hasClaudeApiKey && (
            <button
              type="button"
              onClick={handleClearClaude}
              className="px-3 py-2 border border-red-500/30 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              Remove
            </button>
          )}
        </div>

        <p className="text-xs text-gray-500">
          Get an API key at{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-[#e8622c] hover:text-[#ff7a3d]">
            console.anthropic.com
          </a>
        </p>

        {/* Custom System Prompt */}
        <div className="border-t border-[#2a2a2a] pt-4">
          <button
            type="button"
            onClick={handleExpandSystemPrompt}
            className="flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
          >
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform ${systemPromptExpanded ? 'rotate-0' : '-rotate-90'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            Custom System Prompt
          </button>

          {systemPromptExpanded && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-gray-500">
                Add custom instructions that will be appended to the AI system prompt.
                Use this to enforce coding patterns, preferred strategies, or constraints.
              </p>
              <textarea
                value={customSystemPrompt}
                onChange={(e) => setCustomSystemPrompt(e.target.value)}
                placeholder="e.g. Always use ctx.log.info for important events. Prefer the onTick pattern. Always check balance before trading."
                className="w-full h-32 text-sm px-3 py-2 rounded-lg border border-[#2a2a2a] bg-[#111] text-white placeholder-gray-600 focus:outline-none focus:border-[#e8622c] resize-y"
              />
              {systemPromptMessage && (
                <p className={`text-sm ${systemPromptMessage.success ? 'text-green-400' : 'text-red-400'}`}>
                  {systemPromptMessage.message}
                </p>
              )}
              <button
                type="button"
                onClick={handleSaveSystemPrompt}
                className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-[#e8622c] hover:bg-[#ff7a3d]"
              >
                Save Prompt
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
