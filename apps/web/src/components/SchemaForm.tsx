import { useState } from 'react';
import { fieldKind, formatInputValue, getAt, humanizeKey, parseInputValue, setAt, type FieldKind, type JsonSchema } from '../lib/schemaForm';
import { inputCls } from './ui';

/**
 * Form generated from a JSON Schema (the server's zod schemas, spec §3). Objects become sections,
 * scalars become inputs; lists of strings are one-per-line text areas; anything the form cannot
 * represent (e.g. category rules) is edited as JSON. Typing errors are reported through `onFieldError`
 * so the page can block "Review"; real validation happens on the server.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  onFieldError,
  secretPaths = [],
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  onFieldError: (path: string, error: string | null) => void;
  /** Dotted paths shown as password inputs */
  secretPaths?: string[];
}) {
  return <ObjectFields schema={schema} path={[]} root={value} onChange={onChange} onFieldError={onFieldError} secretPaths={secretPaths} depth={0} />;
}

interface FieldsProps {
  schema: JsonSchema;
  path: string[];
  root: unknown;
  onChange: (value: unknown) => void;
  onFieldError: (path: string, error: string | null) => void;
  secretPaths: string[];
  depth: number;
}

function ObjectFields({ schema, path, root, onChange, onFieldError, secretPaths, depth }: FieldsProps) {
  const props = Object.entries(schema.properties ?? {});
  const scalars = props.filter(([, s]) => fieldKind(s) !== 'object');
  const objects = props.filter(([, s]) => fieldKind(s) === 'object');
  return (
    <div className="space-y-4">
      {scalars.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {scalars.map(([key, s]) => (
            <Field
              key={[...path, key].join('.')}
              name={key}
              schema={s}
              path={[...path, key]}
              root={root}
              onChange={onChange}
              onFieldError={onFieldError}
              secret={secretPaths.includes([...path, key].join('.'))}
            />
          ))}
        </div>
      )}
      {objects.map(([key, s]) => (
        <fieldset key={key} className={`border border-[#2a2a2a] rounded-lg p-3 sm:p-4 ${depth > 0 ? 'bg-[#151515]' : ''}`}>
          <legend className="px-1 text-sm font-medium text-gray-200">{humanizeKey(key)}</legend>
          {s.description && <p className="text-xs text-gray-500 mb-2">{s.description}</p>}
          <ObjectFields
            schema={s}
            path={[...path, key]}
            root={root}
            onChange={onChange}
            onFieldError={onFieldError}
            secretPaths={secretPaths}
            depth={depth + 1}
          />
        </fieldset>
      ))}
    </div>
  );
}

function hint(schema: JsonSchema): string {
  const parts: string[] = [];
  if (schema.minimum !== undefined && schema.minimum > Number.MIN_SAFE_INTEGER) parts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER) parts.push(`max ${schema.maximum}`);
  if (schema.default !== undefined && typeof schema.default !== 'object') parts.push(`default ${JSON.stringify(schema.default)}`);
  return parts.join(' · ');
}

function Field({
  name,
  schema,
  path,
  root,
  onChange,
  onFieldError,
  secret,
}: {
  name: string;
  schema: JsonSchema;
  path: string[];
  root: unknown;
  onChange: (value: unknown) => void;
  onFieldError: (path: string, error: string | null) => void;
  secret: boolean;
}) {
  const kind: FieldKind = fieldKind(schema);
  const value = getAt(root, path);
  const key = path.join('.');
  const id = `cfg-${key}`;
  const label = (
    <label htmlFor={id} className="block text-sm text-gray-300">
      {humanizeKey(name)} <span className="text-xs text-gray-600 font-mono">{name}</span>
    </label>
  );
  const sub = hint(schema);

  if (kind === 'boolean') {
    return (
      <div className="flex items-center gap-3 py-1">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(setAt(root, path, e.target.checked))} />
        {label}
      </div>
    );
  }
  if (kind === 'enum') {
    return (
      <div>
        {label}
        <select id={id} className={`${inputCls} mt-1`} value={String(value ?? '')} onChange={(e) => onChange(setAt(root, path, e.target.value))}>
          {(schema.enum as string[]).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (kind === 'number-pair') {
    const pair = Array.isArray(value) ? value : [undefined, undefined];
    return (
      <div>
        {label}
        <div className="mt-1 flex items-center gap-2">
          {[0, 1].map((i) => (
            <TextInput
              key={i}
              id={i === 0 ? id : `${id}-1`}
              kind="number"
              schema={schema.prefixItems?.[i] ?? {}}
              value={pair[i]}
              onValue={(v) => {
                const next = [...pair];
                next[i] = v;
                onChange(setAt(root, path, next));
              }}
              onError={(err) => onFieldError(`${key}[${i}]`, err)}
            />
          ))}
        </div>
        <p className="mt-0.5 text-xs text-gray-600">from – to</p>
      </div>
    );
  }
  return (
    <div className={kind === 'json' || kind === 'string-list' ? 'md:col-span-2' : ''}>
      {label}
      <div className="mt-1">
        <TextInput
          id={id}
          kind={kind}
          schema={schema}
          value={value}
          secret={secret}
          onValue={(v) => onChange(setAt(root, path, v))}
          onError={(err) => onFieldError(key, err)}
        />
      </div>
      {sub && <p className="mt-0.5 text-xs text-gray-600">{sub}</p>}
    </div>
  );
}

/** Keeps the typed text locally (so "0." or a half-typed list is not reformatted) and reports parsed values */
function TextInput({
  id,
  kind,
  schema,
  value,
  secret,
  onValue,
  onError,
}: {
  id: string;
  kind: FieldKind;
  schema: JsonSchema;
  value: unknown;
  secret?: boolean;
  onValue: (v: unknown) => void;
  onError: (err: string | null) => void;
}) {
  const formatted = formatInputValue(kind, value);
  const [text, setText] = useState(formatted);
  const [error, setError] = useState<string | null>(null);
  const [lastFormatted, setLastFormatted] = useState(formatted);
  // The value changed from outside (reset, YAML edit): show it
  if (formatted !== lastFormatted) {
    setLastFormatted(formatted);
    const parsed = parseInputValue(kind, text, schema);
    if (!parsed.ok || formatInputValue(kind, parsed.value) !== formatted) {
      setText(formatted);
      setError(null);
    }
  }
  const update = (raw: string) => {
    setText(raw);
    const parsed = parseInputValue(kind, raw, schema);
    if (parsed.ok) {
      setError(null);
      onError(null);
      onValue(parsed.value);
    } else {
      setError(parsed.error);
      onError(parsed.error);
    }
  };
  const multiline = kind === 'string-list' || kind === 'json';
  return (
    <>
      {multiline ? (
        <textarea
          id={id}
          className={`${inputCls} font-mono`}
          rows={kind === 'json' ? 10 : Math.min(8, Math.max(2, text.split('\n').length + 1))}
          value={text}
          onChange={(e) => update(e.target.value)}
        />
      ) : (
        <input
          id={id}
          type={secret ? 'password' : 'text'}
          inputMode={kind === 'number' || kind === 'integer' ? 'decimal' : undefined}
          autoComplete="off"
          className={inputCls}
          value={text}
          onChange={(e) => update(e.target.value)}
        />
      )}
      {kind === 'string-list' && <p className="mt-0.5 text-xs text-gray-600">one per line</p>}
      {error && <p className="mt-0.5 text-xs text-red-400">{error}</p>}
    </>
  );
}
