/**
 * botlab-sdk.d.ts (spec §5.3): the committed generated file matches sdk/types.ts, and the typecheck maps
 * diagnostics back to the original source when it annotates untyped lifecycle parameters.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderGenerated } from '../../scripts/gen-sdk-dts';
import { annotateLifecycleParams, typecheckScript } from '../../packages/core/src/runtime/typecheckScript';

describe('botlab-sdk.d.ts', () => {
  it('sdkDts.generated.ts is up to date (run `npm run gen:sdk`)', () => {
    const file = path.join(__dirname, '..', '..', 'packages', 'core', 'src', 'sdk', 'sdkDts.generated.ts');
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(renderGenerated());
  });

  it('builtin templates typecheck', () => {
    for (const f of ['binance-spot.ts', 'copy-trading.ts']) {
      const r = typecheckScript(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', f), 'utf8'));
      expect({ f, diagnostics: r.diagnostics }).toEqual({ f, diagnostics: [] });
    }
  });

  it('annotates untyped lifecycle ctx and reports original positions', () => {
    const src = 'export async function onTick(ctx) { ctx.nope(); }\nexport const onStop = async (ctx) => { await ctx.storage.gett("k"); };\n';
    expect(annotateLifecycleParams(src).text).toContain('onTick(ctx: BotContext)');
    const r = typecheckScript(src);
    expect(r.diagnostics.map((d) => [d.line, d.column, d.code])).toEqual([
      [1, 41, 2339],
      [2, 58, 2551],
    ]);
    // No Node / DOM globals in the sandbox
    expect(typecheckScript('export async function onTick(ctx) { process.exit(1); require("fs"); }').diagnostics.map((d) => d.code)).toEqual([2591, 2591]);
  });
});
