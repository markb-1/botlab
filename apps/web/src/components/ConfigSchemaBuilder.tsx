import { useState } from 'react';
import { useConfigSchemaSync } from '../hooks/useConfigSchemaSync';
import { isValidKey, type ConfigParam, type ParamType } from '../utils/configSchemaParser';

interface ConfigSchemaBuilderProps {
  source: string;
  onSourceChange: (newSource: string) => void;
  readOnly?: boolean;
  defaultExpanded?: boolean;
}

const TYPE_OPTIONS: { value: ParamType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'array', label: 'Array' },
];

export function ConfigSchemaBuilder({
  source,
  onSourceChange,
  readOnly = false,
  defaultExpanded = false,
}: ConfigSchemaBuilderProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const {
    params,
    parseError,
    isBuilderEnabled,
    addParam,
    removeParam,
    updateParam,
  } = useConfigSchemaSync({ source, onSourceChange, readOnly });

  const handleAddParam = () => {
    // Generate a unique key
    let key = 'newParam';
    let counter = 1;
    while (params.some((p) => p.key === key)) {
      key = `newParam${counter++}`;
    }

    addParam({
      key,
      type: 'string',
      title: 'New Parameter',
      description: '',
      default: '',
    });
  };

  return (
    <div className="bg-surface border border-[#2a2a2a] rounded-lg overflow-hidden">
      {/* Toggle Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-light transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-sm font-medium text-gray-300">
            Config Parameters
          </span>
          <span className="text-xs text-gray-600">
            ({params.length})
          </span>
        </div>
        {!readOnly && expanded && isBuilderEnabled && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              handleAddParam();
            }}
            className="text-xs px-2 py-1 rounded text-accent hover:bg-accent/10 transition-colors cursor-pointer"
          >
            + Add
          </span>
        )}
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-[#2a2a2a] px-4 py-3 space-y-3">
          {/* Parse Error Warning */}
          {parseError && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              <p className="text-xs text-amber-300">
                Could not parse config from source. Edit manually in code.
              </p>
              <p className="text-xs text-amber-300/60 mt-0.5">{parseError}</p>
            </div>
          )}

          {/* Parameter List */}
          {isBuilderEnabled && params.length === 0 && (
            <div className="text-center py-3">
              <p className="text-xs text-gray-500">
                {readOnly ? 'No config parameters defined.' : 'No config parameters yet. Click "+ Add" to create one.'}
              </p>
            </div>
          )}

          {isBuilderEnabled &&
            params.map((param) => (
              <ParamRow
                key={param.key}
                param={param}
                readOnly={readOnly}
                allKeys={params.map((p) => p.key)}
                onUpdate={(updates) => updateParam(param.key, updates)}
                onRemove={() => removeParam(param.key)}
              />
            ))}

          {/* Add Button (bottom, for when list is long) */}
          {!readOnly && isBuilderEnabled && params.length > 2 && (
            <button
              type="button"
              onClick={handleAddParam}
              className="w-full py-2 text-xs text-gray-500 hover:text-accent border border-dashed border-[#333] rounded-lg hover:border-accent/30 transition-colors"
            >
              + Add Parameter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ParamRow Component
// ============================================================================

interface ParamRowProps {
  param: ConfigParam;
  readOnly: boolean;
  allKeys: string[];
  onUpdate: (updates: Partial<ConfigParam>) => void;
  onRemove: () => void;
}

function ParamRow({ param, readOnly, allKeys, onUpdate, onRemove }: ParamRowProps) {
  const isKeyDuplicate = allKeys.filter((k) => k === param.key).length > 1;
  const isKeyInvalid = !isValidKey(param.key);
  const isNumeric = param.type === 'number' || param.type === 'integer';

  if (readOnly) {
    return (
      <div className="bg-[#0f0f0f] border border-[#222] rounded-lg px-3 py-2">
        <div className="flex items-center gap-3 text-xs">
          <span className="text-white font-mono">{param.key}</span>
          <TypeBadge type={param.type} />
          <span className="text-gray-400">{param.title}</span>
          {param.default !== undefined && (
            <span className="text-gray-600 ml-auto">
              default: {String(param.default)}
            </span>
          )}
        </div>
        {param.description && (
          <p className="text-xs text-gray-600 mt-1">{param.description}</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-[#0f0f0f] border border-[#222] rounded-lg px-3 py-2.5 space-y-2">
      {/* Row 1: Key, Type, Title, Remove */}
      <div className="flex items-center gap-2">
        <div className="flex-shrink-0 w-[130px]">
          <input
            type="text"
            value={param.key}
            onChange={(e) => onUpdate({ key: e.target.value })}
            className={`w-full text-xs font-mono px-2 py-1 rounded border bg-[#111] text-white focus:outline-none focus:border-accent ${
              isKeyInvalid || isKeyDuplicate
                ? 'border-red-500/50'
                : 'border-[#2a2a2a]'
            }`}
            placeholder="key"
            spellCheck={false}
          />
        </div>
        <select
          value={param.type}
          onChange={(e) => onUpdate({ type: e.target.value as ParamType })}
          className="text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-gray-300 focus:outline-none focus:border-accent"
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={param.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="flex-1 text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-white focus:outline-none focus:border-accent"
          placeholder="Title"
        />
        <button
          type="button"
          onClick={onRemove}
          className="flex-shrink-0 p-1 text-gray-600 hover:text-red-400 transition-colors"
          title="Remove parameter"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Row 2: Default, Min/Max (conditional) */}
      <div className="flex items-center gap-2">
        <DefaultInput param={param} onUpdate={onUpdate} />
        {isNumeric && (
          <>
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-600">Min:</span>
              <input
                type="number"
                value={param.minimum ?? ''}
                onChange={(e) =>
                  onUpdate({
                    minimum: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                className="w-16 text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-white focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-600">Max:</span>
              <input
                type="number"
                value={param.maximum ?? ''}
                onChange={(e) =>
                  onUpdate({
                    maximum: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                className="w-16 text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-white focus:outline-none focus:border-accent"
              />
            </div>
          </>
        )}
      </div>

      {/* Row 3: Description */}
      <input
        type="text"
        value={param.description}
        onChange={(e) => onUpdate({ description: e.target.value })}
        className="w-full text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-gray-400 focus:outline-none focus:border-accent"
        placeholder="Description (optional)"
      />

      {/* Key validation messages */}
      {isKeyInvalid && param.key.length > 0 && (
        <p className="text-xs text-red-400">Invalid key — must be a valid JavaScript identifier</p>
      )}
      {isKeyDuplicate && (
        <p className="text-xs text-red-400">Duplicate key</p>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function DefaultInput({
  param,
  onUpdate,
}: {
  param: ConfigParam;
  onUpdate: (updates: Partial<ConfigParam>) => void;
}) {
  if (param.type === 'boolean') {
    return (
      <label className="flex items-center gap-1.5 cursor-pointer">
        <span className="text-xs text-gray-600">Default:</span>
        <input
          type="checkbox"
          checked={Boolean(param.default)}
          onChange={(e) => onUpdate({ default: e.target.checked })}
          className="rounded border-[#2a2a2a] bg-[#111] text-accent focus:ring-accent"
        />
        <span className="text-xs text-gray-400">{param.default ? 'true' : 'false'}</span>
      </label>
    );
  }

  if (param.type === 'number' || param.type === 'integer') {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-600">Default:</span>
        <input
          type="number"
          value={param.default !== undefined ? String(param.default) : ''}
          onChange={(e) =>
            onUpdate({
              default: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          className="w-24 text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-white focus:outline-none focus:border-accent"
          step={param.type === 'integer' ? 1 : 'any'}
        />
      </div>
    );
  }

  if (param.type === 'array') {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-600">Default:</span>
        <span className="text-xs text-gray-500 italic">
          {Array.isArray(param.default) && param.default.length > 0
            ? `[${(param.default as string[]).join(', ')}]`
            : '[]'}
        </span>
      </div>
    );
  }

  // String type
  return (
    <div className="flex items-center gap-1 flex-1">
      <span className="text-xs text-gray-600 flex-shrink-0">Default:</span>
      <input
        type="text"
        value={String(param.default ?? '')}
        onChange={(e) => onUpdate({ default: e.target.value || undefined })}
        className="flex-1 text-xs px-2 py-1 rounded border border-[#2a2a2a] bg-[#111] text-white focus:outline-none focus:border-accent"
        placeholder="(none)"
      />
    </div>
  );
}

function TypeBadge({ type }: { type: ParamType }) {
  const colors: Record<ParamType, string> = {
    string: 'text-blue-400 bg-blue-500/10',
    number: 'text-emerald-400 bg-emerald-500/10',
    integer: 'text-emerald-400 bg-emerald-500/10',
    boolean: 'text-purple-400 bg-purple-500/10',
    array: 'text-orange-400 bg-orange-500/10',
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${colors[type] || 'text-gray-400 bg-gray-500/10'}`}>
      {type}
    </span>
  );
}
