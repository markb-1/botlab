/**
 * Typecheck a bot script against `botlab-sdk.d.ts` (spec §5.3) with the TypeScript compiler API, so the
 * agent (MCP validate_script / create_template) gets real type errors such as a misspelt ctx method or a
 * wrong argument type, not just esbuild syntax errors.
 *
 * - In memory: two virtual files (`/botlab/botlab-sdk.d.ts`, `/botlab/script.ts`), lib es2022 only (no DOM,
 *   no Node types — the sandbox has neither); lib source files are parsed once and cached.
 * - Untyped lifecycle parameters (`export async function onTick(ctx)`) are typed as `BotContext` before
 *   checking, so ctx calls are checked in scripts written without annotations; reported columns are mapped
 *   back to the original text.
 * - `strict` without `noImplicitAny` (helper parameters may stay untyped).
 */

import path from 'path';
import type * as TS from 'typescript';
import { SDK_DTS } from '../sdk/sdkDts.generated';

export interface ScriptDiagnostic {
  line: number;
  column: number;
  code: number;
  category: 'error' | 'warning';
  message: string;
}

export interface TypecheckResult {
  ok: boolean;
  diagnostics: ScriptDiagnostic[];
  /** Diagnostics left out beyond MAX_DIAGNOSTICS */
  truncated: number;
  ms: number;
}

const MAX_DIAGNOSTICS = 50;
const ROOT = '/botlab';
const SCRIPT_FILE = `${ROOT}/script.ts`;
const DTS_FILE = `${ROOT}/botlab-sdk.d.ts`;
const ANNOTATION = ': BotContext';

let tsModule: typeof TS | null = null;
function ts(): typeof TS {
  // Loaded lazily: only validate/typecheck needs it
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  tsModule ??= require('typescript') as typeof TS;
  return tsModule;
}

const libCache = new Map<string, TS.SourceFile>();
let dtsFile: TS.SourceFile | null = null;

function compilerOptions(t: typeof TS): TS.CompilerOptions {
  return {
    target: t.ScriptTarget.ES2022,
    module: t.ModuleKind.ESNext,
    moduleResolution: t.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    types: [],
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: false,
    moduleDetection: t.ModuleDetectionKind.Force,
  };
}

/** Lifecycle functions whose single untyped `ctx` parameter is annotated before checking */
const LIFECYCLE = '(?:onStart|onTick|onStop|onHeartbeat)';
const PATTERNS = [
  new RegExp(`(export\\s+(?:async\\s+)?function\\s+${LIFECYCLE}\\s*\\(\\s*)(ctx)(\\s*\\))`, 'g'),
  new RegExp(`(export\\s+const\\s+${LIFECYCLE}\\s*=\\s*(?:async\\s*)?\\(\\s*)(ctx)(\\s*\\)\\s*=>)`, 'g'),
];

/** Annotates untyped lifecycle `ctx` parameters; returns the text and the insertion offsets */
export function annotateLifecycleParams(source: string): { text: string; insertions: number[] } {
  const insertions: number[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) insertions.push(m.index + m[1].length + m[2].length);
  }
  insertions.sort((a, b) => a - b);
  let text = '';
  let last = 0;
  for (const at of insertions) {
    text += source.slice(last, at) + ANNOTATION;
    last = at;
  }
  text += source.slice(last);
  return { text, insertions };
}

/** Offset in the annotated text → offset in the original source */
function originalOffset(pos: number, insertions: number[]): number {
  let shift = 0;
  for (let i = 0; i < insertions.length; i++) {
    const at = insertions[i] + i * ANNOTATION.length; // position of insertion i in the annotated text
    if (pos >= at + ANNOTATION.length) shift += ANNOTATION.length;
    else if (pos >= at) return insertions[i];
  }
  return pos - shift;
}

function lineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function typecheckScript(source: string): TypecheckResult {
  const started = Date.now();
  const t = ts();
  const options = compilerOptions(t);
  const { text, insertions } = annotateLifecycleParams(source);
  const host = t.createCompilerHost(options, true);
  const libDir = path.dirname(t.getDefaultLibFilePath(options));
  const scriptSf = t.createSourceFile(SCRIPT_FILE, text, t.ScriptTarget.ES2022, true, t.ScriptKind.TS);
  dtsFile ??= t.createSourceFile(DTS_FILE, SDK_DTS, t.ScriptTarget.ES2022, true, t.ScriptKind.TS);

  const isLib = (fileName: string) => path.dirname(fileName) === libDir || fileName.startsWith(libDir);
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === SCRIPT_FILE) return scriptSf;
    if (fileName === DTS_FILE) return dtsFile!;
    const cached = libCache.get(fileName);
    if (cached) return cached;
    if (!isLib(fileName)) return undefined;
    const content = t.sys.readFile(fileName);
    if (content === undefined) return undefined;
    const sf = t.createSourceFile(fileName, content, languageVersion);
    libCache.set(fileName, sf);
    return sf;
  };
  const baseFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName === SCRIPT_FILE || fileName === DTS_FILE || (isLib(fileName) && baseFileExists(fileName));
  host.readFile = (fileName) => (fileName === SCRIPT_FILE ? text : fileName === DTS_FILE ? SDK_DTS : isLib(fileName) ? t.sys.readFile(fileName) : undefined);
  host.writeFile = () => undefined;
  host.getCurrentDirectory = () => ROOT;
  host.getDirectories = () => [];

  const program = t.createProgram({ rootNames: [DTS_FILE, SCRIPT_FILE], options, host });
  const raw = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(scriptSf),
    ...program.getSemanticDiagnostics(scriptSf),
    ...program.getGlobalDiagnostics(),
  ];

  const diagnostics: ScriptDiagnostic[] = [];
  let truncated = 0;
  for (const d of raw) {
    if (d.category !== t.DiagnosticCategory.Error && d.category !== t.DiagnosticCategory.Warning) continue;
    if (d.file && d.file.fileName !== SCRIPT_FILE) continue;
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      truncated++;
      continue;
    }
    const pos = d.file && d.start !== undefined ? lineCol(source, originalOffset(d.start, insertions)) : { line: 0, column: 0 };
    diagnostics.push({
      ...pos,
      code: d.code,
      category: d.category === t.DiagnosticCategory.Error ? 'error' : 'warning',
      message: t.flattenDiagnosticMessageText(d.messageText, '\n'),
    });
  }
  return { ok: !diagnostics.some((d) => d.category === 'error'), diagnostics, truncated, ms: Date.now() - started };
}
