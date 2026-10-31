/**
 * Config Schema Parser/Generator/Patcher
 *
 * Pure utility module for bidirectional sync between script source code
 * and a structured config parameter UI. No React dependencies.
 *
 * Handles:
 *   - Parsing configSchema from script source (Code → UI)
 *   - Generating configSchema source code from params (UI → Code)
 *   - Patching configSchema back into script source (UI → Code)
 */

// ============================================================================
// Types
// ============================================================================

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'array';

/** Represents a single config parameter in the builder UI */
export interface ConfigParam {
  key: string;
  type: ParamType;
  title: string;
  description: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  items?: { type: string };
}

/** Result of parsing configSchema from source */
export interface ParseResult {
  success: boolean;
  params: ConfigParam[];
  required: string[];
  error?: string;
}

/** Result of patching configSchema into source */
export interface PatchResult {
  success: boolean;
  source: string;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const VALID_TYPES: ParamType[] = ['string', 'number', 'integer', 'boolean', 'array'];

const META_REGEX = /export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\};)/;

const VALID_KEY_REGEX = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

// ============================================================================
// Parsing (Code → UI)
// ============================================================================

/**
 * Parse configSchema from script source code.
 * Extracts the meta object using regex + Function eval, then maps
 * configSchema.properties to ConfigParam[].
 */
export function parseConfigSchemaFromSource(source: string): ParseResult {
  try {
    const metaMatch = source.match(META_REGEX);
    if (!metaMatch) {
      return { success: false, params: [], required: [], error: 'No meta export found' };
    }

    const metaStr = metaMatch[1];
    // eslint-disable-next-line no-new-func
    const meta = new Function(`return ${metaStr}`)();

    if (!meta || typeof meta !== 'object') {
      return { success: false, params: [], required: [], error: 'Meta is not an object' };
    }

    const schema = meta.configSchema;
    if (!schema || typeof schema !== 'object') {
      // Meta exists but no configSchema — valid, just empty
      return { success: true, params: [], required: [] };
    }

    const properties = schema.properties || {};
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const params: ConfigParam[] = [];

    for (const [key, prop] of Object.entries(properties)) {
      if (typeof prop !== 'object' || prop === null) continue;
      const p = prop as Record<string, unknown>;

      const rawType = typeof p.type === 'string' ? p.type : 'string';
      const type: ParamType = VALID_TYPES.includes(rawType as ParamType)
        ? (rawType as ParamType)
        : 'string';

      const param: ConfigParam = {
        key,
        type,
        title: typeof p.title === 'string' ? p.title : key,
        description: typeof p.description === 'string' ? p.description : '',
      };

      if (p.default !== undefined) param.default = p.default;
      if (typeof p.minimum === 'number') param.minimum = p.minimum;
      if (typeof p.maximum === 'number') param.maximum = p.maximum;
      if (Array.isArray(p.enum)) param.enum = p.enum.map(String);
      if (p.items && typeof p.items === 'object') {
        param.items = { type: (p.items as Record<string, unknown>).type as string || 'string' };
      }

      params.push(param);
    }

    return { success: true, params, required };
  } catch (err) {
    return {
      success: false,
      params: [],
      required: [],
      error: err instanceof Error ? err.message : 'Parse error',
    };
  }
}

/**
 * Quick check: does the source contain an export const meta = ... ?
 */
export function hasMetaObject(source: string): boolean {
  return META_REGEX.test(source);
}

/**
 * Validate a config parameter key.
 */
export function isValidKey(key: string): boolean {
  return VALID_KEY_REGEX.test(key);
}

// ============================================================================
// Generation (UI → Schema Object)
// ============================================================================

/**
 * Convert ConfigParam[] to a JSON Schema object suitable for DB storage.
 */
export function configParamsToSchema(
  params: ConfigParam[],
  required: string[] = []
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};

  for (const param of params) {
    const prop: Record<string, unknown> = { type: param.type };
    if (param.title) prop.title = param.title;
    if (param.description) prop.description = param.description;
    if (param.default !== undefined) prop.default = param.default;
    if (param.minimum !== undefined && (param.type === 'number' || param.type === 'integer')) {
      prop.minimum = param.minimum;
    }
    if (param.maximum !== undefined && (param.type === 'number' || param.type === 'integer')) {
      prop.maximum = param.maximum;
    }
    if (param.enum && param.enum.length > 0 && param.type === 'string') {
      prop.enum = param.enum;
    }
    if (param.items && param.type === 'array') {
      prop.items = param.items;
    }
    properties[param.key] = prop;
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

// ============================================================================
// Source Code Generation (UI → Code String)
// ============================================================================

/**
 * Generate a formatted TypeScript source string for a configSchema value.
 * Output matches the style used in existing templates (2-space indent).
 */
export function generateConfigSchemaSource(
  params: ConfigParam[],
  required: string[] = []
): string {
  if (params.length === 0 && required.length === 0) {
    return '{\n      type: \'object\',\n      properties: {},\n    }';
  }

  const lines: string[] = [];
  lines.push('{');
  lines.push('      type: \'object\',');
  lines.push('      properties: {');

  for (const param of params) {
    lines.push(`        ${param.key}: {`);
    lines.push(`          type: '${param.type}',`);
    if (param.title) lines.push(`          title: '${escapeString(param.title)}',`);
    if (param.description) lines.push(`          description: '${escapeString(param.description)}',`);
    if (param.default !== undefined) {
      lines.push(`          default: ${formatValue(param.default)},`);
    }
    if (param.minimum !== undefined && (param.type === 'number' || param.type === 'integer')) {
      lines.push(`          minimum: ${param.minimum},`);
    }
    if (param.maximum !== undefined && (param.type === 'number' || param.type === 'integer')) {
      lines.push(`          maximum: ${param.maximum},`);
    }
    if (param.enum && param.enum.length > 0 && param.type === 'string') {
      lines.push(`          enum: [${param.enum.map(e => `'${escapeString(e)}'`).join(', ')}],`);
    }
    if (param.items && param.type === 'array') {
      lines.push(`          items: { type: '${param.items.type || 'string'}' },`);
    }
    lines.push('        },');
  }

  lines.push('      },');

  if (required.length > 0) {
    lines.push(`      required: [${required.map(r => `'${escapeString(r)}'`).join(', ')}],`);
  }

  lines.push('    }');

  return lines.join('\n');
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatValue(val: unknown): string {
  if (typeof val === 'string') return `'${escapeString(val)}'`;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    return `[${val.map(formatValue).join(', ')}]`;
  }
  return JSON.stringify(val);
}

// ============================================================================
// Patching (Replace configSchema in source)
// ============================================================================

/**
 * Patch the configSchema block in the script source with new params.
 * Uses brace-counting to find the exact range of the existing configSchema value.
 * If no configSchema exists but meta does, inserts it.
 */
export function patchConfigSchemaInSource(
  source: string,
  params: ConfigParam[],
  required: string[] = []
): PatchResult {
  try {
    // Find the meta object
    const metaMatch = source.match(META_REGEX);
    if (!metaMatch || metaMatch.index === undefined) {
      return { success: false, source, error: 'No meta export found in source' };
    }

    const metaStart = metaMatch.index;
    const metaEnd = metaStart + metaMatch[0].length;
    const metaBody = source.slice(metaStart, metaEnd);

    const newSchemaSource = generateConfigSchemaSource(params, required);

    // Try to find existing configSchema within meta
    const csRange = findConfigSchemaRange(source, metaStart, metaEnd);

    if (csRange) {
      // Replace existing configSchema value
      const before = source.slice(0, csRange.valueStart);
      const after = source.slice(csRange.valueEnd);
      return { success: true, source: before + newSchemaSource + after };
    }

    // No configSchema found — insert it into meta
    // Find the last property in meta before the closing };
    // We insert before the closing `};` of the meta object
    const closingMatch = metaBody.match(/\n\};?\s*$/);
    if (!closingMatch || closingMatch.index === undefined) {
      return { success: false, source, error: 'Could not find end of meta object' };
    }

    const insertPos = metaStart + closingMatch.index;
    const before = source.slice(0, insertPos);
    const after = source.slice(insertPos);

    // Check if we need a comma before the new property
    const beforeTrimmed = before.trimEnd();
    const needsComma = !beforeTrimmed.endsWith(',') && !beforeTrimmed.endsWith('{');

    const insertion = `${needsComma ? ',' : ''}\n  configSchema: ${newSchemaSource},`;
    return { success: true, source: before + insertion + after };
  } catch (err) {
    return {
      success: false,
      source,
      error: err instanceof Error ? err.message : 'Patch error',
    };
  }
}

/**
 * Find the range of the configSchema value within the meta object.
 * Returns the start/end positions of just the value (the { ... } object literal),
 * including any trailing comma.
 */
function findConfigSchemaRange(
  source: string,
  metaStart: number,
  metaEnd: number
): { valueStart: number; valueEnd: number } | null {
  const metaBody = source.slice(metaStart, metaEnd);

  // Find "configSchema:" or "configSchema :" within meta
  const csMatch = metaBody.match(/configSchema\s*:\s*/);
  if (!csMatch || csMatch.index === undefined) return null;

  const valueStart = metaStart + csMatch.index + csMatch[0].length;

  // Find the opening brace
  let i = valueStart;
  while (i < metaEnd && source[i] !== '{') {
    // If we hit something other than whitespace before {, it's not an object
    if (!/\s/.test(source[i])) return null;
    i++;
  }
  if (i >= metaEnd) return null;

  // Brace-counting to find the matching closing brace
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (; i < metaEnd; i++) {
    const ch = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        // Found the matching closing brace
        let end = i + 1;
        // Skip trailing comma and whitespace on the same line
        if (end < metaEnd && source[end] === ',') end++;
        return { valueStart, valueEnd: end };
      }
    }
  }

  return null;
}
