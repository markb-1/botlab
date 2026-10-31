/**
 * MCP over Streamable HTTP at `/mcp` (spec §7.3, §8.2), stateless: each POST gets a fresh MCP server and
 * transport bound to the authenticated principal, with JSON responses (no server-initiated messages, so
 * GET streams and DELETE sessions are not offered: 405).
 *
 * Auth (Decision R137): an **agent-scope bearer token only** (`npm run cli -- token create --scope agent`
 * or Settings → API tokens). No credentials ⇒ 401; a readonly token or the admin session cookie ⇒ 403
 * (the human uses the UI; read-only dashboards use the HTTP API). The token is re-checked on every request,
 * so revoking it takes effect at once. The actor is `asAgent('token:<id>')`, minted here from the
 * principal, never from request data. Host check (DNS rebinding) runs before this for every route; a
 * browser Origin from another host is refused too.
 */

import type { Context, Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Core } from '../../../../packages/core/src/core';
import { asAgent } from '../../../../packages/core/src/services/actors';
import { principalMiddleware, type AppEnv } from '../http/principal';
import { createMcpServer } from './server';

export const MCP_PATH = '/mcp';

function jsonRpcError(c: Context, status: 401 | 403 | 405, message: string, headers: Record<string, string> = {}): Response {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }, status);
}

export function mountMcp(app: Hono<AppEnv>, core: Core, opts: { version?: string } = {}): void {
  app.use(MCP_PATH, principalMiddleware(core.auth));
  app.all(MCP_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const p = c.get('principal');
    if (!p) return jsonRpcError(c, 401, 'Agent bearer token required (Authorization: Bearer <token>)', { 'WWW-Authenticate': 'Bearer realm="botlab-mcp"' });
    if (p.via !== 'token' || p.scope !== 'agent') return jsonRpcError(c, 403, `MCP needs an agent-scope API token (got ${p.scope})`);
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid */
      }
      if (host !== c.req.header('host')) return jsonRpcError(c, 403, 'Cross-origin request refused');
    }
    if (c.req.method !== 'POST') return jsonRpcError(c, 405, 'Method not allowed: this MCP endpoint is stateless (POST only)', { Allow: 'POST' });

    const server = createMcpServer({ services: core.services, actor: asAgent(`token:${p.tokenId}`), tokenId: p.tokenId, version: opts.version });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => undefined);
    }
  });
}
