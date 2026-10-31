import { useState, useEffect, useRef, useCallback } from 'react';
import {
  parseConfigSchemaFromSource,
  patchConfigSchemaInSource,
  type ConfigParam,
} from '../utils/configSchemaParser';

interface UseConfigSchemaSyncOptions {
  source: string;
  onSourceChange: (newSource: string) => void;
  readOnly?: boolean;
}

interface UseConfigSchemaSyncReturn {
  params: ConfigParam[];
  required: string[];
  parseError: string | null;
  isBuilderEnabled: boolean;
  addParam: (param: ConfigParam) => void;
  removeParam: (key: string) => void;
  updateParam: (key: string, updates: Partial<ConfigParam>) => void;
  setRequired: (keys: string[]) => void;
}

const DEBOUNCE_MS = 500;

/**
 * Hook for bidirectional sync between script source code and config schema params.
 *
 * Code→UI: Debounced parse of source on change (500ms).
 * UI→Code: Immediate patch of source when params change.
 * Loop prevention: skipNextParse ref avoids re-parsing builder-initiated changes.
 */
export function useConfigSchemaSync({
  source,
  onSourceChange,
  readOnly = false,
}: UseConfigSchemaSyncOptions): UseConfigSchemaSyncReturn {
  const [params, setParams] = useState<ConfigParam[]>([]);
  const [required, setRequiredState] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  const skipNextParse = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Code→UI: Parse configSchema from source (debounced)
  useEffect(() => {
    if (skipNextParse.current) {
      skipNextParse.current = false;
      return;
    }

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      const result = parseConfigSchemaFromSource(source);
      if (result.success) {
        setParams(result.params);
        setRequiredState(result.required);
        setParseError(null);
      } else {
        setParseError(result.error || 'Parse error');
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [source]);

  // Initial parse (immediate, no debounce)
  useEffect(() => {
    const result = parseConfigSchemaFromSource(source);
    if (result.success) {
      setParams(result.params);
      setRequiredState(result.required);
      setParseError(null);
    } else {
      setParseError(result.error || 'Parse error');
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // UI→Code: Patch source with new params
  const patchSource = useCallback(
    (newParams: ConfigParam[], newRequired: string[]) => {
      if (readOnly) return;

      const result = patchConfigSchemaInSource(sourceRef.current, newParams, newRequired);
      if (result.success) {
        skipNextParse.current = true;
        setParams(newParams);
        setRequiredState(newRequired);
        setParseError(null);
        onSourceChange(result.source);
      }
    },
    [onSourceChange, readOnly]
  );

  const addParam = useCallback(
    (param: ConfigParam) => {
      const newParams = [...params, param];
      patchSource(newParams, required);
    },
    [params, required, patchSource]
  );

  const removeParam = useCallback(
    (key: string) => {
      const newParams = params.filter((p) => p.key !== key);
      const newRequired = required.filter((r) => r !== key);
      patchSource(newParams, newRequired);
    },
    [params, required, patchSource]
  );

  const updateParam = useCallback(
    (key: string, updates: Partial<ConfigParam>) => {
      const newParams = params.map((p) => {
        if (p.key !== key) return p;
        const updated = { ...p, ...updates };
        // If type changed, clean up type-specific fields
        if (updates.type && updates.type !== p.type) {
          if (updates.type !== 'number' && updates.type !== 'integer') {
            delete updated.minimum;
            delete updated.maximum;
          }
          if (updates.type !== 'array') {
            delete updated.items;
          }
          if (updates.type !== 'string') {
            delete updated.enum;
          }
          // Reset default to appropriate type
          if (updates.type === 'boolean') updated.default = false;
          else if (updates.type === 'number' || updates.type === 'integer') updated.default = 0;
          else if (updates.type === 'array') {
            updated.default = [];
            updated.items = { type: 'string' };
          }
          else updated.default = '';
        }
        return updated;
      });
      // If key changed, update required array
      let newRequired = required;
      if (updates.key && updates.key !== key) {
        newRequired = required.map((r) => (r === key ? updates.key! : r));
      }
      patchSource(newParams, newRequired);
    },
    [params, required, patchSource]
  );

  const setRequired = useCallback(
    (keys: string[]) => {
      patchSource(params, keys);
    },
    [params, patchSource]
  );

  const isBuilderEnabled = parseError === null;

  return {
    params,
    required,
    parseError,
    isBuilderEnabled,
    addParam,
    removeParam,
    updateParam,
    setRequired,
  };
}
