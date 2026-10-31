import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useScript, useScripts } from '../hooks/useScripts';
import { ScriptEditor } from '../components/ScriptEditor';
import { ConfigSchemaBuilder } from '../components/ConfigSchemaBuilder';
import { BacktestPanel } from '../components/BacktestPanel';
import { parseConfigSchemaFromSource, configParamsToSchema } from '../utils/configSchemaParser';

export function ScriptEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { script, isLoading } = useScript(id!);
  const { updateScript, forkScript, exportScript, compileScript, isCompiling } = useScripts();

  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showBacktest, setShowBacktest] = useState(searchParams.get('backtest') === 'true');
  const [compileError, setCompileError] = useState<string | null>(null);

  // Load script data
  useEffect(() => {
    if (script) {
      setSource(script.source);
      setName(script.name);
      setDescription(script.description);
      setHasChanges(false);
    }
  }, [script]);

  const handleSourceChange = (val: string) => {
    setSource(val);
    setHasChanges(true);
    setSuccessMsg(null);
    setCompileError(null);
  };

  const handleSave = async () => {
    if (!script || script.isTemplate) return;
    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      // Extract configSchema from source to keep DB in sync
      const parsed = parseConfigSchemaFromSource(source);
      const configSchema = parsed.success
        ? configParamsToSchema(parsed.params, parsed.required)
        : undefined;

      await updateScript({
        id: script.id,
        data: { name, description, source, configSchema },
      });
      setHasChanges(false);
      setSuccessMsg('Script saved successfully');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save script');
    } finally {
      setIsSaving(false);
    }
  };

  const handleForkAndEdit = async () => {
    if (!script) return;
    try {
      const forked = await forkScript({ id: script.id });
      navigate(`/scripts/${forked.id}`, { replace: true });
    } catch (err: any) {
      setError(err.message || 'Failed to fork script');
    }
  };

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

  const handleExport = async () => {
    if (!script) return;
    try {
      const result = await exportScript(script.id) as { exported: boolean };
      if (result.exported) {
        setSuccessMsg('Script exported successfully');
        setTimeout(() => setSuccessMsg(null), 3000);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to export script');
    }
  };

  if (isLoading) {
    return <div className="text-center py-8 text-gray-500">Loading script...</div>;
  }

  if (!script) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500 mb-4">Script not found</p>
        <Link to="/scripts" className="text-accent hover:text-accent-hover">
          Back to Scripts
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <Link to="/scripts" className="text-sm text-gray-500 hover:text-gray-300">
            ← Back to Scripts
          </Link>
          <div className="flex items-center gap-3 mt-1">
            {script.isTemplate ? (
              <h2 className="text-xl font-bold text-white">{script.name}</h2>
            ) : (
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setHasChanges(true); }}
                className="text-xl font-bold text-white bg-transparent border-none p-0 focus:ring-0 focus:outline-none"
                placeholder="Script name"
              />
            )}
            <span className={`text-xs px-2 py-0.5 rounded ${
              script.isTemplate
                ? 'bg-accent/10 text-accent'
                : 'bg-blue-500/10 text-blue-400'
            }`}>
              {script.isTemplate ? 'Template (read-only)' : 'Custom'}
            </span>
          </div>
          {script.isTemplate ? (
            <p className="text-sm text-gray-400 mt-1">{script.description}</p>
          ) : (
            <input
              type="text"
              value={description}
              onChange={(e) => { setDescription(e.target.value); setHasChanges(true); }}
              className="text-sm text-gray-400 bg-transparent border-none p-0 focus:ring-0 focus:outline-none w-full mt-1"
              placeholder="Script description"
            />
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowBacktest(!showBacktest)}
            className={`inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
              showBacktest
                ? 'text-accent border-accent/30 bg-accent/10'
                : 'text-gray-300 border-[#333] hover:bg-surface-light hover:text-white'
            }`}
            title="Backtest"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
            Backtest
          </button>
          <button
            onClick={handleExport}
            className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-300 border border-[#333] rounded-lg hover:bg-surface-light hover:text-white transition-colors"
            title="Export script as .botlab file"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </button>
          {script.isTemplate ? (
            <button
              onClick={handleForkAndEdit}
              className="px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover"
            >
              Fork & Edit
            </button>
          ) : (
            <>
              <Link
                to={`/bots/new?scriptId=${script.id}`}
                className="px-4 py-2 text-sm font-medium text-gray-300 border border-[#333] rounded-lg hover:bg-surface-light"
              >
                Create Bot from Script
              </Link>
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
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
                className="px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Status messages */}
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

      {/* Config Builder + Editor + AI Panel + Backtest */}
      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          {!script.isTemplate && (
            <div className="flex-shrink-0">
              <ConfigSchemaBuilder
                source={source}
                onSourceChange={handleSourceChange}
              />
            </div>
          )}
          <div className={`min-h-0 ${showBacktest ? 'flex-1' : 'flex-1'}`} style={showBacktest ? { flex: '1 1 60%' } : undefined}>
            <ScriptEditor
              value={source}
              onChange={handleSourceChange}
              readOnly={script.isTemplate}
              height="100%"
            />
          </div>
          {showBacktest && (
            <div className="flex-shrink-0" style={{ height: '300px' }}>
              <BacktestPanel scriptId={script.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
