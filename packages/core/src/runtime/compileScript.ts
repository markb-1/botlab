/**
 * Compiles a bot script (TypeScript) to the CommonJS body the worker evaluates (spec §5.1).
 *
 * Scripts may not import anything: they get only `module`, `exports` and `ctx`. The build uses
 * esbuild `bundle: true, platform: 'neutral'` with a resolver plugin that rejects every import or
 * literal `require()`, so `import fs from 'fs'` / `require('child_process')` are compile errors.
 * Type-only imports are erased by esbuild before resolution and stay allowed. Dynamic `import()` is
 * lowered to `require()`, which does not exist at runtime. See worker-bootstrap.ts for the limits.
 */

import type { Plugin } from 'esbuild';

export type CompileResult = { code: string } | { error: string };

const rejectImports: Plugin = {
  name: 'botlab-reject-imports',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      return {
        errors: [{ text: `Imports are not allowed in bot scripts ("${args.path}"). Use the ctx API instead.` }],
      };
    });
  },
};

export async function compileScript(source: string): Promise<CompileResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild') as typeof import('esbuild');
    const result = await esbuild.build({
      stdin: { contents: source, loader: 'ts', sourcefile: 'script.ts', resolveDir: process.cwd() },
      bundle: true,
      platform: 'neutral',
      format: 'cjs',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      plugins: [rejectImports],
      // import(x) ⇒ require(x), which is undefined in the sandbox
      supported: { 'dynamic-import': false },
    });
    const code = result.outputFiles?.[0]?.text;
    if (code === undefined) return { error: 'Compilation produced no output' };
    return { code };
  } catch (err: unknown) {
    const e = err as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }>; message?: string };
    if (e.errors?.length) {
      return {
        error: e.errors
          .map((x) => (x.location ? `${x.location.line}:${x.location.column}: ${x.text}` : x.text))
          .join('\n'),
      };
    }
    return { error: e.message || 'Compilation failed' };
  }
}
