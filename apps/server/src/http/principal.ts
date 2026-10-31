/**
 * Authenticated principal and actor derivation (spec §8.2, R84/R88/R89).
 *
 * - `admin`: a browser session (httpOnly SameSite=Strict cookie) after the password login. Acts as the
 *   human: `asHuman('session:<id>')`.
 * - `agent`: a bearer API token with the agent scope (MCP in Phase 4). Acts as the agent: `asAgent('token:<id>')`.
 * - `readonly`: a bearer API token with the readonly scope; GET routes only, never an actor.
 *
 * The actor is derived here from the principal, never from request data.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { asAgent, asHuman, type Actor, type HumanActor } from '../../../../packages/core/src/services/actors';
import type { AdminAuthStore } from '../../../../packages/core/src/security/adminAuth';
import { HttpError, fail } from './respond';

export type Scope = 'admin' | 'agent' | 'readonly';

export type Principal =
  | { scope: 'admin'; via: 'session'; sessionId: string; recentAuth: boolean }
  | { scope: 'agent' | 'readonly'; via: 'token'; tokenId: string; tokenName: string };

export const SESSION_COOKIE = 'botlab_session';

export type AppEnv = {
  Variables: {
    principal: Principal | null;
  };
};

/** Resolves the principal from `Authorization: Bearer` or the session cookie; a bad bearer token is 401. */
export function principalMiddleware(auth: AdminAuthStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
      const token = m ? auth.findToken(m[1]) : null;
      if (!token) return fail(c, new HttpError(401, 'unauthenticated', 'Invalid or revoked API token'));
      c.set('principal', { scope: token.scope, via: 'token', tokenId: token.id, tokenName: token.name });
      return next();
    }
    const session = auth.getSession(getCookie(c, SESSION_COOKIE));
    c.set('principal', session ? { scope: 'admin', via: 'session', sessionId: session.id, recentAuth: auth.isRecentAuth(session) } : null);
    return next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF (spec §8.2): mutating requests not authenticated by a bearer token must carry `X-BotLab: 1`
 * (a custom header forces a CORS preflight, which this server never grants) and, when the browser sends
 * an Origin, it must be this host. Together with the SameSite=Strict cookie.
 */
export function csrfMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.get('principal')?.via === 'token') return next();
    if (c.req.header('x-botlab') !== '1') return fail(c, new HttpError(403, 'csrf', 'Missing X-BotLab header'));
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* invalid */
      }
      if (originHost !== c.req.header('host')) return fail(c, new HttpError(403, 'csrf', 'Cross-origin request refused'));
    }
    return next();
  };
}

export function requirePrincipal(c: Context<AppEnv>): Principal {
  const p = c.get('principal');
  if (!p) throw new HttpError(401, 'unauthenticated', 'Not logged in');
  return p;
}

/** The service actor for the authenticated principal (never from request data) */
export function actorOf(p: Principal): Actor {
  if (p.scope === 'admin') return humanOf(p);
  if (p.scope === 'agent') return asAgent(`token:${p.tokenId}`);
  throw new HttpError(403, 'forbidden', 'Read-only token');
}

/** The human actor; only the admin session is the human */
export function humanOf(p: Principal): HumanActor {
  if (p.scope !== 'admin') throw new HttpError(403, 'forbidden', 'Human admin only');
  return asHuman(`session:${p.sessionId.slice(0, 12)}`);
}
