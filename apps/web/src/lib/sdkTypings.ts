/**
 * Monaco typings for bot scripts, generated from the real SDK types (`packages/core/src/sdk/types.ts`,
 * imported as text) so autocomplete can never drift from the ctx API again: `export interface/type`
 * become ambient declarations, the internal worker RPC protocol at the end of the file is dropped, and
 * a global `ctx: BotContext` is declared.
 */

const INTERNAL_MARKER = /^export type RpcMethod\b/m;

export function sdkTypesToAmbient(source: string): string {
  const cut = source.search(INTERNAL_MARKER);
  let body = cut >= 0 ? source.slice(0, cut) : source;
  // Drop the trailing section banner that introduced the internal part
  body = body.replace(/\/\/ =+\s*\n\/\/ RPC Protocol[^\n]*\n\/\/ =+\s*$/m, '');
  body = body.replace(/^export (interface|type|enum|const enum) /gm, 'declare $1 ');
  return `${body.trimEnd()}\n\n/** The bot context, also passed to onStart / onTick / onStop / onHeartbeat */\ndeclare const ctx: BotContext;\n`;
}
