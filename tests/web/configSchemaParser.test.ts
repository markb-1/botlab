import { describe, it, expect } from 'vitest';
import {
  parseConfigSchemaFromSource,
  configParamsToSchema,
  generateConfigSchemaSource,
  patchConfigSchemaInSource,
  hasMetaObject,
  isValidKey,
  type ConfigParam,
} from '../../apps/web/src/utils/configSchemaParser';

// ============================================================================
// Test Fixtures
// ============================================================================

const SIMPLE_SOURCE = `
export const meta = {
  name: 'My Bot',
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
      symbol: {
        type: 'string',
        title: 'Trading Pair',
        description: 'Binance pair symbol',
        default: 'BTCUSDT',
      },
    },
  },
};

export async function onTick(ctx) {
  ctx.log.debug('tick');
}
`;

const COMPLEX_SOURCE = `
export const meta = {
  name: 'Odds Threshold',
  version: '1.0.0',
  configSchema: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        title: 'Sports Categories',
        items: { type: 'string' },
        default: ['NBA'],
      },
      enableFavorites: {
        type: 'boolean',
        title: 'Enable Favorites Strategy',
        default: true,
      },
      favoritesThreshold: {
        type: 'number',
        title: 'Favorites Threshold (cents)',
        default: 85,
        minimum: 50,
        maximum: 99,
      },
    },
  },
};

export async function onStart(ctx) {}
`;

const WITH_REQUIRED_SOURCE = `
export const meta = {
  name: 'Copy Trading',
  version: '1.0.0',
  configSchema: {
    type: 'object',
    properties: {
      traders: {
        type: 'array',
        title: 'Trader Addresses',
        items: { type: 'string' },
        default: [],
      },
      baseMultiplier: {
        type: 'number',
        title: 'Base Multiplier',
        default: 0.1,
        minimum: 0.01,
        maximum: 10,
      },
    },
    required: ['traders'],
  },
};

export async function onStart(ctx) {}
`;

const NO_META_SOURCE = `
export async function onTick(ctx) {
  ctx.log.debug('tick');
}
`;

const META_WITHOUT_SCHEMA_SOURCE = `
export const meta = {
  name: 'Simple Bot',
  version: '1.0.0',
};

export async function onTick(ctx) {}
`;

const META_WITHOUT_PROPERTIES_SOURCE = `
export const meta = {
  name: 'Minimal',
  configSchema: {
    type: 'object',
  },
};

export async function onTick(ctx) {}
`;

// ============================================================================
// parseConfigSchemaFromSource
// ============================================================================

describe('parseConfigSchemaFromSource', () => {
  it('should parse simple configSchema', () => {
    const result = parseConfigSchemaFromSource(SIMPLE_SOURCE);
    expect(result.success).toBe(true);
    expect(result.params).toHaveLength(2);
    expect(result.required).toEqual([]);

    const polling = result.params[0];
    expect(polling.key).toBe('pollingIntervalMs');
    expect(polling.type).toBe('number');
    expect(polling.title).toBe('Polling Interval (ms)');
    expect(polling.default).toBe(10000);
    expect(polling.minimum).toBe(1000);

    const symbol = result.params[1];
    expect(symbol.key).toBe('symbol');
    expect(symbol.type).toBe('string');
    expect(symbol.title).toBe('Trading Pair');
    expect(symbol.description).toBe('Binance pair symbol');
    expect(symbol.default).toBe('BTCUSDT');
  });

  it('should parse complex configSchema with arrays and booleans', () => {
    const result = parseConfigSchemaFromSource(COMPLEX_SOURCE);
    expect(result.success).toBe(true);
    expect(result.params).toHaveLength(3);

    const categories = result.params[0];
    expect(categories.type).toBe('array');
    expect(categories.items).toEqual({ type: 'string' });
    expect(categories.default).toEqual(['NBA']);

    const enableFavorites = result.params[1];
    expect(enableFavorites.type).toBe('boolean');
    expect(enableFavorites.default).toBe(true);

    const threshold = result.params[2];
    expect(threshold.minimum).toBe(50);
    expect(threshold.maximum).toBe(99);
  });

  it('should parse configSchema with required array', () => {
    const result = parseConfigSchemaFromSource(WITH_REQUIRED_SOURCE);
    expect(result.success).toBe(true);
    expect(result.required).toEqual(['traders']);
  });

  it('should return error for source with no meta', () => {
    const result = parseConfigSchemaFromSource(NO_META_SOURCE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No meta');
    expect(result.params).toEqual([]);
  });

  it('should return success with empty params when meta has no configSchema', () => {
    const result = parseConfigSchemaFromSource(META_WITHOUT_SCHEMA_SOURCE);
    expect(result.success).toBe(true);
    expect(result.params).toEqual([]);
    expect(result.required).toEqual([]);
  });

  it('should return success with empty params when configSchema has no properties', () => {
    const result = parseConfigSchemaFromSource(META_WITHOUT_PROPERTIES_SOURCE);
    expect(result.success).toBe(true);
    expect(result.params).toEqual([]);
  });

  it('should handle malformed source gracefully', () => {
    const result = parseConfigSchemaFromSource('export const meta = { broken');
    expect(result.success).toBe(false);
  });

  it('should handle empty source', () => {
    const result = parseConfigSchemaFromSource('');
    expect(result.success).toBe(false);
  });

  it('should map unknown types to string', () => {
    const source = `
export const meta = {
  configSchema: {
    type: 'object',
    properties: {
      weird: { type: 'unknown_type', title: 'Weird' },
    },
  },
};
`;
    const result = parseConfigSchemaFromSource(source);
    expect(result.success).toBe(true);
    expect(result.params[0].type).toBe('string');
  });
});

// ============================================================================
// hasMetaObject
// ============================================================================

describe('hasMetaObject', () => {
  it('should return true when meta exists', () => {
    expect(hasMetaObject(SIMPLE_SOURCE)).toBe(true);
  });

  it('should return false when no meta', () => {
    expect(hasMetaObject(NO_META_SOURCE)).toBe(false);
  });
});

// ============================================================================
// isValidKey
// ============================================================================

describe('isValidKey', () => {
  it('should accept valid identifiers', () => {
    expect(isValidKey('foo')).toBe(true);
    expect(isValidKey('camelCase')).toBe(true);
    expect(isValidKey('_private')).toBe(true);
    expect(isValidKey('$special')).toBe(true);
    expect(isValidKey('pollingIntervalMs')).toBe(true);
  });

  it('should reject invalid identifiers', () => {
    expect(isValidKey('')).toBe(false);
    expect(isValidKey('123start')).toBe(false);
    expect(isValidKey('has space')).toBe(false);
    expect(isValidKey('has-dash')).toBe(false);
    expect(isValidKey('has.dot')).toBe(false);
  });
});

// ============================================================================
// configParamsToSchema
// ============================================================================

describe('configParamsToSchema', () => {
  it('should convert params to JSON Schema', () => {
    const params: ConfigParam[] = [
      { key: 'symbol', type: 'string', title: 'Trading Pair', description: '', default: 'BTCUSDT' },
      { key: 'amount', type: 'number', title: 'Amount', description: 'Trade amount', default: 10, minimum: 1, maximum: 1000 },
    ];

    const schema = configParamsToSchema(params);
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();

    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.symbol.type).toBe('string');
    expect(props.symbol.default).toBe('BTCUSDT');
    expect(props.amount.minimum).toBe(1);
    expect(props.amount.maximum).toBe(1000);
  });

  it('should include required when non-empty', () => {
    const params: ConfigParam[] = [
      { key: 'traders', type: 'array', title: 'Traders', description: '', items: { type: 'string' } },
    ];
    const schema = configParamsToSchema(params, ['traders']);
    expect(schema.required).toEqual(['traders']);
  });

  it('should omit required when empty', () => {
    const params: ConfigParam[] = [
      { key: 'foo', type: 'string', title: 'Foo', description: '' },
    ];
    const schema = configParamsToSchema(params, []);
    expect(schema.required).toBeUndefined();
  });

  it('should only include min/max for number types', () => {
    const params: ConfigParam[] = [
      { key: 'name', type: 'string', title: 'Name', description: '', minimum: 5, maximum: 100 },
    ];
    const schema = configParamsToSchema(params);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.name.minimum).toBeUndefined();
    expect(props.name.maximum).toBeUndefined();
  });
});

// ============================================================================
// generateConfigSchemaSource
// ============================================================================

describe('generateConfigSchemaSource', () => {
  it('should generate valid source code', () => {
    const params: ConfigParam[] = [
      { key: 'interval', type: 'number', title: 'Interval', description: '', default: 10000, minimum: 1000 },
    ];
    const source = generateConfigSchemaSource(params);
    expect(source).toContain("type: 'object'");
    expect(source).toContain('interval:');
    expect(source).toContain("type: 'number'");
    expect(source).toContain('default: 10000');
    expect(source).toContain('minimum: 1000');
  });

  it('should handle empty params', () => {
    const source = generateConfigSchemaSource([]);
    expect(source).toContain("type: 'object'");
    expect(source).toContain('properties: {}');
  });

  it('should handle array type with items', () => {
    const params: ConfigParam[] = [
      { key: 'tags', type: 'array', title: 'Tags', description: '', items: { type: 'string' }, default: [] },
    ];
    const source = generateConfigSchemaSource(params);
    expect(source).toContain("items: { type: 'string' }");
    expect(source).toContain('default: []');
  });

  it('should handle boolean default', () => {
    const params: ConfigParam[] = [
      { key: 'enabled', type: 'boolean', title: 'Enabled', description: '', default: true },
    ];
    const source = generateConfigSchemaSource(params);
    expect(source).toContain('default: true');
  });

  it('should escape single quotes in strings', () => {
    const params: ConfigParam[] = [
      { key: 'msg', type: 'string', title: "It's a test", description: '', default: "don't" },
    ];
    const source = generateConfigSchemaSource(params);
    expect(source).toContain("title: 'It\\'s a test'");
    expect(source).toContain("default: 'don\\'t'");
  });

  it('should include required array', () => {
    const params: ConfigParam[] = [
      { key: 'name', type: 'string', title: 'Name', description: '' },
    ];
    const source = generateConfigSchemaSource(params, ['name']);
    expect(source).toContain("required: ['name']");
  });
});

// ============================================================================
// patchConfigSchemaInSource
// ============================================================================

describe('patchConfigSchemaInSource', () => {
  it('should replace existing configSchema', () => {
    const newParams: ConfigParam[] = [
      { key: 'newParam', type: 'string', title: 'New Param', description: '', default: 'hello' },
    ];

    const result = patchConfigSchemaInSource(SIMPLE_SOURCE, newParams);
    expect(result.success).toBe(true);

    // Verify the new source contains the new param
    expect(result.source).toContain('newParam');
    expect(result.source).toContain("default: 'hello'");

    // Verify old params are gone
    expect(result.source).not.toContain('pollingIntervalMs');
    expect(result.source).not.toContain('symbol');

    // Verify the rest of the source is intact
    expect(result.source).toContain('export async function onTick');
  });

  it('should insert configSchema when meta exists but no configSchema', () => {
    const params: ConfigParam[] = [
      { key: 'amount', type: 'number', title: 'Amount', description: '', default: 10 },
    ];

    const result = patchConfigSchemaInSource(META_WITHOUT_SCHEMA_SOURCE, params);
    expect(result.success).toBe(true);
    expect(result.source).toContain('configSchema:');
    expect(result.source).toContain('amount');
    expect(result.source).toContain("name: 'Simple Bot'");
  });

  it('should fail when no meta exists', () => {
    const result = patchConfigSchemaInSource(NO_META_SOURCE, []);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No meta');
  });

  it('should handle nested objects in configSchema (brace counting)', () => {
    const params: ConfigParam[] = [
      { key: 'items', type: 'array', title: 'Items', description: '', items: { type: 'string' } },
    ];

    const result = patchConfigSchemaInSource(COMPLEX_SOURCE, params);
    expect(result.success).toBe(true);
    expect(result.source).toContain("items: { type: 'string' }");
    expect(result.source).not.toContain('enableFavorites');
  });

  it('should preserve meta properties outside configSchema', () => {
    const params: ConfigParam[] = [
      { key: 'x', type: 'number', title: 'X', description: '', default: 1 },
    ];

    const result = patchConfigSchemaInSource(SIMPLE_SOURCE, params);
    expect(result.success).toBe(true);
    expect(result.source).toContain("name: 'My Bot'");
    expect(result.source).toContain("version: '1.0.0'");
  });

  it('should preserve required array in output', () => {
    const params: ConfigParam[] = [
      { key: 'traders', type: 'array', title: 'Traders', description: '', items: { type: 'string' } },
    ];

    const result = patchConfigSchemaInSource(WITH_REQUIRED_SOURCE, params, ['traders']);
    expect(result.success).toBe(true);
    expect(result.source).toContain("required: ['traders']");
  });

  it('round-trip: parse → patch → re-parse should preserve params', () => {
    const parsed = parseConfigSchemaFromSource(SIMPLE_SOURCE);
    expect(parsed.success).toBe(true);

    const patched = patchConfigSchemaInSource(SIMPLE_SOURCE, parsed.params, parsed.required);
    expect(patched.success).toBe(true);

    const reParsed = parseConfigSchemaFromSource(patched.source);
    expect(reParsed.success).toBe(true);
    expect(reParsed.params).toHaveLength(parsed.params.length);

    for (let i = 0; i < parsed.params.length; i++) {
      expect(reParsed.params[i].key).toBe(parsed.params[i].key);
      expect(reParsed.params[i].type).toBe(parsed.params[i].type);
      expect(reParsed.params[i].title).toBe(parsed.params[i].title);
      expect(reParsed.params[i].default).toEqual(parsed.params[i].default);
    }
  });

  it('round-trip with complex source', () => {
    const parsed = parseConfigSchemaFromSource(COMPLEX_SOURCE);
    expect(parsed.success).toBe(true);

    const patched = patchConfigSchemaInSource(COMPLEX_SOURCE, parsed.params, parsed.required);
    expect(patched.success).toBe(true);

    const reParsed = parseConfigSchemaFromSource(patched.source);
    expect(reParsed.success).toBe(true);
    expect(reParsed.params).toHaveLength(parsed.params.length);
  });
});
