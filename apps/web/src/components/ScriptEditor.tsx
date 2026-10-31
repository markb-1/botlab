import { useRef, useCallback, useMemo } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import sdkTypesSource from '../../../../packages/core/src/sdk/types.ts?raw';
import { sdkTypesToAmbient } from '../lib/sdkTypings';

let editorCounter = 0;

// BotContext typings for autocomplete: generated from the SDK's own type file, so they always match
// the current ctx API (orders v2, risk budget, ledger, fetch limits)
const BOT_CONTEXT_TYPES = sdkTypesToAmbient(sdkTypesSource);

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
