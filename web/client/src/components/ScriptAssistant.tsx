import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAI } from '../hooks/useAI';
import { useSettings } from '../hooks/useSettings';

type Tab = 'generate' | 'edit';

interface ScriptAssistantProps {
  source: string;
  onApply: (newSource: string) => void;
  onClose: () => void;
}

export function ScriptAssistant({ source, onApply, onClose }: ScriptAssistantProps) {
  const [tab, setTab] = useState<Tab>('generate');
  const [prompt, setPrompt] = useState('');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { generate, edit, isGenerating, isEditing, error, clearError } = useAI();
  const { settings } = useSettings();

  const isLoading = isGenerating || isEditing;
  const hasApiKey = settings?.hasClaudeApiKey ?? false;

  // Focus textarea on tab change
  useEffect(() => {
    textareaRef.current?.focus();
  }, [tab]);

  const handleSubmit = async () => {
    if (!prompt.trim() || isLoading) return;
    clearError();
    setGeneratedCode(null);

    try {
      let code: string;
      if (tab === 'generate') {
        code = await generate(prompt.trim());
      } else {
        code = await edit(prompt.trim(), source);
      }
      setGeneratedCode(code);
    } catch {
      // Error is already set in useAI
    }
  };

  const handleApply = () => {
    if (generatedCode) {
      onApply(generatedCode);
      setGeneratedCode(null);
      setPrompt('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // No API key state
  if (!hasApiKey) {
    return (
      <div className="h-full bg-surface border border-[#2a2a2a] rounded-lg flex flex-col">
        <Header onClose={onClose} />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <svg className="w-10 h-10 text-gray-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <p className="text-sm text-gray-400 mb-2">Claude API key required</p>
            <Link
              to="/settings"
              className="text-sm text-accent hover:text-accent-hover transition-colors"
            >
              Configure in Settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-surface border border-[#2a2a2a] rounded-lg flex flex-col">
      <Header onClose={onClose} />

      {/* Tabs */}
      <div className="flex border-b border-[#2a2a2a] px-3">
        <TabButton
          label="Generate"
          active={tab === 'generate'}
          onClick={() => { setTab('generate'); setGeneratedCode(null); clearError(); }}
        />
        <TabButton
          label="Edit"
          active={tab === 'edit'}
          onClick={() => { setTab('edit'); setGeneratedCode(null); clearError(); }}
        />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col p-3 gap-3 min-h-0 overflow-y-auto">
        {/* Prompt */}
        <div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              tab === 'generate'
                ? 'Describe the bot you want to create...\n\ne.g. "Create a bot that monitors NBA prediction markets and buys YES tokens when the odds drop below 30 cents"'
                : 'Describe the changes you want to make...\n\ne.g. "Add error handling to the trading logic and log all trades"'
            }
            className="w-full h-32 text-sm px-3 py-2 rounded-lg border border-[#2a2a2a] bg-[#111] text-white placeholder-gray-600 focus:outline-none focus:border-accent resize-none"
            disabled={isLoading}
          />
          <p className="text-xs text-gray-600 mt-1">
            {navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to submit
          </p>
        </div>

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isLoading}
          className="w-full py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Spinner />
              {tab === 'generate' ? 'Generating...' : 'Editing...'}
            </>
          ) : (
            tab === 'generate' ? 'Generate Script' : 'Edit Script'
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        {/* Generated Code Preview */}
        {generatedCode && (
          <div className="flex flex-col gap-2 min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400 font-medium">Preview</span>
              <span className="text-xs text-gray-600">
                {generatedCode.split('\n').length} lines
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-[#2a2a2a] bg-[#0a0a0a]">
              <pre className="text-xs text-gray-300 p-3 font-mono whitespace-pre overflow-x-auto">
                {generatedCode}
              </pre>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleApply}
                className="flex-1 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-500 transition-colors"
              >
                Apply to Editor
              </button>
              <button
                onClick={handleSubmit}
                disabled={isLoading}
                className="px-3 py-2 text-sm text-gray-400 border border-[#333] rounded-lg hover:bg-surface-light hover:text-white transition-colors disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#2a2a2a]">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
        </svg>
        <span className="text-sm font-medium text-gray-200">AI Assistant</span>
      </div>
      <button
        onClick={onClose}
        className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
        title="Close"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'text-accent border-accent'
          : 'text-gray-500 border-transparent hover:text-gray-300'
      }`}
    >
      {label}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}
