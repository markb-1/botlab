/**
 * MCP over stdio for Claude Code / Claude Desktop (spec §7.3): a transparent proxy from stdin/stdout to the
 * running BotLab server's `/mcp` endpoint. It never opens the database (one server per data dir): every
 * message goes over HTTP with the agent token, so auth, auditing and all rules are the server's.
 *
 *   BOTLAB_URL          server base URL (default http://127.0.0.1:3780)
 *   BOTLAB_AGENT_TOKEN  an agent-scope API token (`npm run cli -- token create --scope agent --name claude`)
 *   BOTLAB_ALLOW_INSECURE=1  allow sending the token over plain http to another host (see insecureUrlReason)
 *
 * Run: `node dist/apps/server/src/mcp-stdio.js` (after `npm run build`) or `npm run mcp:stdio:dev`.
 * stdout carries the protocol only; diagnostics go to stderr.
 */

import type { Readable, Writable } from 'stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_BOTLAB_URL = 'http://127.0.0.1:3780';

export interface StdioProxyOptions {
  /** Server base URL (the proxy appends /mcp) */
  url: string;
  token: string;
  stdin?: Readable;
  stdout?: Writable;
  /** fetch override (tests) */
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** Allow plain http to a non-loopback, non-Tailscale host (BOTLAB_ALLOW_INSECURE=1) */
  allowInsecure?: boolean;
}

export interface StdioProxy {
  close(): Promise<void>;
  /** Resolves when stdin closes or the proxy is closed */
  closed: Promise<void>;
}

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } => 'method' in m && 'id' in m;

/** 100.64.0.0/10 (Tailscale CGNAT addresses) */
function isTailscaleIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/**
 * Why sending the bearer token to this URL is unsafe, or null (R148). https: always fine. Plain http: only
 * to loopback (localhost, 127.0.0.0/8, ::1) or over Tailscale (a `*.ts.net` MagicDNS name or a 100.64.0.0/10
 * address — WireGuard encrypts the traffic); anything else needs BOTLAB_ALLOW_INSECURE=1.
 */
export function insecureUrlReason(url: URL): string | null {
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return `unsupported protocol ${url.protocol}`;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return null;
  if (host.endsWith('.ts.net') || isTailscaleIpv4(host)) return null;
  return `refusing to send the agent token over plain http to ${host}: use https, a loopback or Tailscale address, or set BOTLAB_ALLOW_INSECURE=1`;
}

export function mcpEndpoint(baseUrl: string): URL {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return new URL(base.endsWith('/mcp') ? base : `${base}/mcp`);
}

export async function startStdioProxy(opts: StdioProxyOptions): Promise<StdioProxy> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[botlab-mcp] ${m}\n`));
  const insecure = insecureUrlReason(mcpEndpoint(opts.url));
  if (insecure && !opts.allowInsecure) throw new Error(insecure);
  const server = new StdioServerTransport(opts.stdin, opts.stdout);
  const client = new StreamableHTTPClientTransport(mcpEndpoint(opts.url), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const pendingInit = new Set<string | number>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let closing = false;

  const close = async () => {
    if (closing) return;
    closing = true;
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    resolveClosed();
  };

  server.onmessage = (msg) => {
    if (isRequest(msg) && msg.method === 'initialize') pendingInit.add(msg.id);
    client.send(msg).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      log(`request failed: ${reason}`);
      // Answer requests ourselves so the client does not hang; notifications are dropped
      if (isRequest(msg)) {
        void server
          .send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `BotLab server request failed (${opts.url}): ${reason}` } })
          .catch(() => undefined);
      }
    });
  };
  server.onclose = () => void close();
  server.onerror = (err) => log(`stdio error: ${err.message}`);

  client.onmessage = (msg) => {
    if ('id' in msg && msg.id !== null && pendingInit.has(msg.id as string | number)) {
      pendingInit.delete(msg.id as string | number);
      const version = 'result' in msg ? (msg.result as { protocolVersion?: unknown })?.protocolVersion : undefined;
      if (typeof version === 'string') client.setProtocolVersion(version);
    }
    void server.send(msg).catch((err: unknown) => log(`stdout write failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  client.onerror = (err) => log(`http error: ${err.message}`);

  await client.start();
  await server.start();
  opts.stdin?.once('end', () => void close());
  return { close, closed };
}

async function main(): Promise<void> {
  const token = process.env.BOTLAB_AGENT_TOKEN?.trim();
  if (!token) {
    process.stderr.write(
      'BOTLAB_AGENT_TOKEN is not set: create one with `npm run cli -- token create --scope agent --name claude` (or Settings → API tokens)\n'
    );
    process.exit(2);
  }
  const url = process.env.BOTLAB_URL?.trim() || DEFAULT_BOTLAB_URL;
  const proxy = await startStdioProxy({ url, token, stdin: process.stdin, stdout: process.stdout, allowInsecure: process.env.BOTLAB_ALLOW_INSECURE === '1' });
  process.stderr.write(`[botlab-mcp] proxying stdio to ${mcpEndpoint(url).href}\n`);
  process.stdin.once('end', () => void proxy.close());
  await proxy.closed;
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[botlab-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
