/**
 * A small JSON-Schema subset check of a bot config against its script's `meta.configSchema` (5b): enough for the
 * flat config forms the templates declare. Used by BotService for agent bots on the builtin strategy templates
 * (consistency, resolution-rule), so a wrong config is refused at create / update time instead of at start.
 *
 * Supported per property: `type` (number, integer, string, boolean, array, object), `enum`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `items.type`, `minItems`, `maxItems`; and the schema's top-level `required` list.
 * Keys the schema does not declare are allowed (e.g. `paperBalance`).
 */

interface SchemaNode {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

function typeError(v: unknown, type: string | undefined): string | null {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? null : 'must be an integer';
    case 'string':
      return typeof v === 'string' ? null : 'must be a string';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'array':
      return Array.isArray(v) ? null : 'must be an array';
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? null : 'must be an object';
    default:
      return null;
  }
}

function checkValue(path: string, v: unknown, s: SchemaNode, out: string[]): void {
  const t = typeError(v, s.type);
  if (t) {
    out.push(`${path} ${t}`);
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.includes(v)) out.push(`${path} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${path} must be >= ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${path} must be <= ${s.maximum}`);
  }
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) out.push(`${path} must have at least ${s.minLength} characters`);
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) out.push(`${path} must have at most ${s.maxLength} characters`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${path} must have at least ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${path} must have at most ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => checkValue(`${path}[${i}]`, item, s.items as SchemaNode, out));
  }
}

/** Errors of `config` against `schema` (empty = valid). A schema without properties accepts anything. */
export function validateConfigAgainstSchema(config: Record<string, unknown> | undefined, schema: unknown): string[] {
  const out: string[] = [];
  const s = (schema && typeof schema === 'object' ? schema : {}) as SchemaNode;
  const cfg = config ?? {};
  for (const key of Array.isArray(s.required) ? s.required : []) {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') out.push(`${key} is required`);
  }
  for (const [key, node] of Object.entries(s.properties ?? {})) {
    const v = cfg[key];
    if (v === undefined || v === null) continue;
    checkValue(key, v, node ?? {}, out);
  }
  return out;
}
