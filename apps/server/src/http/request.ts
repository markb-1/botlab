import type { Context } from 'hono';

/** The TCP peer address (Node adapter), or 'local' for in-process requests (tests) */
export function clientAddress(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'local';
}

/**
 * HTTPS as the browser sees it: the request URL, or `X-Forwarded-Proto: https` from a proxy on this
 * machine (e.g. `tailscale serve`). Decides the cookie's Secure flag.
 */
export function isHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true;
  return c.req.header('x-forwarded-proto') === 'https' && isLoopback(clientAddress(c));
}
