/**
 * `botlab-sdk.d.ts` (spec §5.3): ambient declarations for bot scripts, generated from the real SDK types
 * (`sdk/types.ts`) so the editor, the MCP resource and the server-side typecheck can never drift from the
 * ctx API. `export interface/type` become ambient declarations, the internal worker RPC protocol at the end
 * of types.ts is dropped, a global `ctx: BotContext` is declared, plus the few globals the script sandbox
 * provides (`runtime/sandbox.ts` CONTEXT_GLOBALS).
 *
 * The result is committed as `sdkDts.generated.ts` (`npm run gen:sdk`, also run by `npm run build`), so the
 * compiled server needs no TypeScript sources at runtime; a test fails when it is stale.
 */

const INTERNAL_MARKER = /^export type RpcMethod\b/m;

/** types.ts source → ambient declarations (no sandbox globals) */
export function sdkTypesToAmbient(source: string): string {
  const cut = source.search(INTERNAL_MARKER);
  let body = cut >= 0 ? source.slice(0, cut) : source;
  // Drop the trailing section banner that introduced the internal part
  body = body.replace(/\/\/ =+\s*\n\/\/ RPC Protocol[^\n]*\n\/\/ =+\s*$/m, '');
  body = body.replace(/^export (interface|type|enum|const enum) /gm, 'declare $1 ');
  return `${body.trimEnd()}\n\n/** The bot context, also passed to onStart / onTick / onStop / onHeartbeat */\ndeclare const ctx: BotContext;\n`;
}

/**
 * Globals inside the script sandbox besides `ctx` (runtime/sandbox.ts). No `require`, `process`, `fetch`
 * (use `ctx.fetch`), `eval` / `Function`, filesystem or network APIs.
 */
export const SANDBOX_GLOBALS_DTS = `
// ─── Sandbox globals (runtime/sandbox.ts): nothing else exists — no require, process, fetch, eval ───
declare function setTimeout(fn: (...args: any[]) => void, ms?: number, ...args: any[]): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(fn: (...args: any[]) => void, ms?: number, ...args: any[]): unknown;
declare function clearInterval(handle: unknown): void;
declare function queueMicrotask(fn: () => void): void;
declare function structuredClone<T>(value: T): T;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
};
declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | Array<[string, string]>);
  append(name: string, value: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): void;
  toString(): string;
  forEach(cb: (value: string, key: string) => void): void;
}
declare class URL {
  constructor(url: string, base?: string | URL);
  href: string;
  origin: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
  toJSON(): string;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}
`;

const HEADER = `/**
 * botlab-sdk.d.ts — types available to BotLab bot scripts (generated from packages/core/src/sdk/types.ts).
 * A script exports \`meta\` and lifecycle functions (onStart / onTick / onStop / onHeartbeat) that receive \`ctx: BotContext\`.
 */
`;

/** The full d.ts served as `botlab://sdk/types.d.ts` and used by the typecheck */
export function buildSdkDts(typesSource: string): string {
  return `${HEADER}\n${sdkTypesToAmbient(typesSource)}${SANDBOX_GLOBALS_DTS}`;
}
