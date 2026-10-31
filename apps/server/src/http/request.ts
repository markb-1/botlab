import type { Context } from 'hono';

/** The TCP peer address (Node adapter), or 'local' for in-process requests (tests) */
export function clientAddress(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

/** Loopback peer (`local` = in-process request, tests) */
export function isLoopbackAddress(addr: string): boolean {
  return addr === 'local' || addr === '::1' || /^(::ffff:)?127\./.test(addr);
}

/**
 * HTTPS as the browser sees it: the request URL, or `X-Forwarded-Proto: https` from a proxy on this
 * machine (e.g. `tailscale serve`). Decides the cookie's Secure flag.
 */
export function isHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true;
  return c.req.header('x-forwarded-proto') === 'https' && isLoopbackAddress(clientAddress(c));
}
