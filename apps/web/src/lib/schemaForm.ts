/**
 * Helpers for config forms generated from the server's JSON Schema (zod → `z.toJSONSchema`, spec §3).
 * Pure functions (unit tested): which input a schema node gets, reading/writing a value at a path
 * without mutating the original, and turning what was typed into the value the schema expects.
 * Validation proper stays on the server (`/api/config/:file/preview`); these only catch typing errors.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | false;
  prefixItems?: JsonSchema[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  description?: string;
}

export type FieldKind = 'object' | 'boolean' | 'number' | 'integer' | 'string' | 'enum' | 'string-list' | 'number-pair' | 'string-or-number' | 'json';

const typeOf = (s: JsonSchema): string | undefined => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

export function fieldKind(schema: JsonSchema | undefined): FieldKind {
  if (!schema) return 'json';
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) return 'enum';
  if (schema.anyOf) {
    const kinds = schema.anyOf.map((s) => typeOf(s));
    if (kinds.every((k) => k === 'string' || k === 'number' || k === 'integer')) return 'string-or-number';
    return 'json';
  }
  const t = typeOf(schema);
  switch (t) {
    case 'object':
      return schema.properties ? 'object' : 'json';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'string':
      return 'string';
    case 'array': {
      const p = schema.prefixItems;
      if (p && p.length === 2 && p.every((s) => typeOf(s) === 'number' || typeOf(s) === 'integer')) return 'number-pair';
      if (schema.items && typeOf(schema.items) === 'string') return 'string-list';
      return 'json';
    }
    default:
      return 'json';
  }
}

export function getAt(obj: unknown, path: readonly string[]): unknown {
  let node = obj;
  for (const k of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

/** Copy of `obj` with `value` at `path` (intermediate objects are created / copied, never mutated) */
export function setAt<T>(obj: T, path: readonly string[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const base = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  return { ...base, [head]: setAt(base[head], rest, value) } as T;
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Turn the text typed into a field into the value for the schema node (numbers, lists). */
export function parseInputValue(kind: FieldKind, raw: string, schema?: JsonSchema): Parsed {
  switch (kind) {
    case 'number':
    case 'integer': {
      const t = raw.trim();
      if (t === '') return { ok: false, error: 'required' };
      const n = Number(t);
      if (!Number.isFinite(n)) return { ok: false, error: 'not a number' };
      if (kind === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'must be a whole number' };
      if (schema?.minimum !== undefined && n < schema.minimum) return { ok: false, error: `must be ≥ ${schema.minimum}` };
      if (schema?.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER && n > schema.maximum)
        return { ok: false, error: `must be ≤ ${schema.maximum}` };
      return { ok: true, value: n };
    }
    case 'string-list':
      return {
        ok: true,
        value: raw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    case 'string-or-number':
    case 'string':
    case 'enum':
      return { ok: true, value: raw };
    case 'json': {
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch (err) {
        return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    default:
      return { ok: false, error: `no text input for ${kind}` };
  }
}

/** Text shown in a field for a value */
export function formatInputValue(kind: FieldKind, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (kind) {
    case 'string-list':
      return Array.isArray(value) ? value.join('\n') : String(value);
    case 'json':
      return JSON.stringify(value, null, 2);
    default:
      return String(value);
  }
}

const WORDS: Record<string, string> = { usd: '(USD)', pct: '(fraction)', id: 'ID', ttl: 'TTL', http: 'HTTP', llm: 'LLM', uma: 'UMA' };

/** `max_total_exposure_usd` → "Max total exposure (USD)" */
export function humanizeKey(key: string): string {
  const words = key.split('_').map((w) => WORDS[w] ?? w);
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
