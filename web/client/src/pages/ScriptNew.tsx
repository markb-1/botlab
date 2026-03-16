import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useScripts } from '../hooks/useScripts';
import { useSettings } from '../hooks/useSettings';
import { ScriptEditor } from '../components/ScriptEditor';
import { ConfigSchemaBuilder } from '../components/ConfigSchemaBuilder';
import { ScriptAssistant } from '../components/ScriptAssistant';
import { parseConfigSchemaFromSource, configParamsToSchema } from '../utils/configSchemaParser';

const DEFAULT_SOURCE = `/**
 * My Custom Bot
 *
 * Edit this script to implement your trading logic.
 * The 'ctx' object provides trading, market data, and storage APIs.
 *
 * Two patterns:
 *   Simple:   export onTick(ctx) — called automatically every pollingIntervalMs
 *   Advanced: export onStart(ctx) — set up your own intervals and logic
 */

export const meta = {
  name: 'My Custom Bot',
  description: 'A custom trading bot',
  version: '1.0.0',
  configSchema: {
    type: 'object',
    properties: {
      pollingIntervalMs: {
        type: 'number',
        title: 'Polling Interval (ms)',
        default: 10000,
        minimum: 1000,
      },
    },
  },
};

// Called once when the bot starts (optional)
export async function onStart(ctx) {
  ctx.log.info(\`Bot started! Balance: $\${(await ctx.getBalance()).toFixed(2)}\`);
}

// Called every tick (pollingIntervalMs). Put your strategy here.
export async function onTick(ctx) {
  // Your trading logic here — this runs automatically every pollingIntervalMs
  ctx.log.debug('Tick');
}

// Called once when the bot stops (optional)
export async function onStop(ctx) {
  ctx.log.info('Bot stopped');
}

export function onHeartbeat(ctx) {
  return { status: 'running' };
}
`;

export function ScriptNew() {
  const navigate = useNavigate();
  const { createScript, isCreating, compileScript, isCompiling } = useScripts();
  const { settings } = useSettings();

  const [name, setName] = useState('My Custom Bot');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [error, setError] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showAssistant, setShowAssistant] = useState(false);

  const handleCompile = async () => {
    setCompileError(null);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await compileScript(source);
      if (result.compiled) {
        setSuccessMsg('Compilation successful');
        setTimeout(() => setSuccessMsg(null), 3000);
      } else {
        setCompileError(result.error || 'Compilation failed');
      }
    } catch (err: any) {
      setCompileError(err.message || 'Compilation failed');
    }
  };

  const handleSourceChange = (val: string) => {
    setSource(val);
    setCompileError(null);
    setSuccessMsg(null);
  };

  const saveAndNavigate = async (openBacktest = false) => {
    if (!name.trim()) {
      setError('Script name is required');
      return;
    }

    setError(null);
    try {
      // Extract configSchema from source to store in DB
      const parsed = parseConfigSchemaFromSource(source);
      const configSchema = parsed.success
        ? configParamsToSchema(parsed.params, parsed.required)
        : undefined;

      const script = await createScript({
        name: name.trim(),
        description: description.trim(),
        source,
        configSchema,
      });
      const query = openBacktest ? '?backtest=true' : '';
      navigate(`/scripts/${script.id}${query}`, { replace: true });
    } catch (err: any) {
      setError(err.message || 'Failed to save script');
    }
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <Link to="/scripts" className="text-sm text-gray-500 hover:text-gray-300">
            ← Back to Scripts
          </Link>
          <h2 className="mt-1 text-xl font-bold text-white">New Script</h2>
        </div>
        <div className="flex items-center gap-3">
          {/* AI Toggle */}
          {settings?.hasClaudeApiKey && (
            <button
              onClick={() => setShowAssistant(!showAssistant)}
              className={`inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                showAssistant
                  ? 'text-accent border-accent/30 bg-accent/10'
                  : 'text-gray-300 border-[#333] hover:bg-surface-light hover:text-white'
              }`}
              title="AI Assistant"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
              </svg>
              AI
            </button>
          )}
          <button
            onClick={handleCompile}
            disabled={isCompiling}
            className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-300 border border-[#333] rounded-lg hover:bg-surface-light hover:text-white transition-colors disabled:opacity-50"
            title="Check for compilation errors"
          >
            {isCompiling ? (
              <>
                <svg className="animate-spin w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Compiling...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
                </svg>
                Compile
              </>
            )}
          </button>
          <button
            onClick={() => saveAndNavigate(true)}
            disabled={isCreating || !name.trim()}
            className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-300 border border-[#333] rounded-lg hover:bg-surface-light hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Save and open backtest"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
            Backtest
          </button>
          <button
            onClick={() => saveAndNavigate(false)}
            disabled={isCreating || !name.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 flex-shrink-0">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
      {compileError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 flex-shrink-0">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-300">Compilation Error</p>
              <pre className="text-xs text-red-300/80 mt-1 whitespace-pre-wrap font-mono">{compileError}</pre>
            </div>
          </div>
        </div>
      )}
      {successMsg && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-2 flex-shrink-0">
          <p className="text-sm text-green-300">{successMsg}</p>
        </div>
      )}

      {/* Name & description */}
      <div className="flex gap-4 flex-shrink-0">
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-400 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Custom Bot"
            className="block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm"
          />
        </div>
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-400 mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this bot do?"
            className="block w-full rounded-md border-[#2a2a2a] bg-[#111] text-white shadow-sm focus:border-accent focus:ring-accent sm:text-sm"
          />
        </div>
      </div>

      {/* Config Builder + Editor + AI Panel */}
      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          <div className="flex-shrink-0">
            <ConfigSchemaBuilder
              source={source}
              onSourceChange={handleSourceChange}
            />
          </div>
          <div className="flex-1 min-h-0">
            <ScriptEditor
              value={source}
              onChange={handleSourceChange}
              height="100%"
            />
          </div>
        </div>
        {showAssistant && (
          <div className="w-[380px] flex-shrink-0 min-h-0">
            <ScriptAssistant
              source={source}
              onApply={handleSourceChange}
              onClose={() => setShowAssistant(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
