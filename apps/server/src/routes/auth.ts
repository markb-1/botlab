/**
 * Auth endpoints (spec §8.2): first-run setup, login, logout, re-auth, password change, API tokens.
 *
 * - `GET  /api/auth/session` — public; what the UI needs to pick a screen
 * - `POST /api/auth/setup` — only while no admin password exists; sets it and logs in
 * - `POST /api/auth/login` / `logout` / `reauth` (refreshes the 15-minute window) / `password`
 * - `GET|POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id` — agent / readonly bearer tokens (admin;
 *   creating one needs a recent password check)
 *
 * Failed password checks are rate-limited per client address (5 per 15 minutes) and audited.
 */

import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Core } from '../../../../packages/core/src/core';
import { MIN_PASSWORD_LENGTH, SESSION_MAX_MS } from '../../../../packages/core/src/security/adminAuth';
import { z } from 'zod';
import { parseInput } from '../../../../packages/core/src/services/schemas';
import { HttpError, fail, ok } from '../http/respond';
import { SESSION_COOKIE, type AppEnv, type Principal } from '../http/principal';
import { mountRoutes, readJsonBody } from '../http/routes';
import { clientAddress, isHttps, isLoopbackAddress } from '../http/request';
import { hostName } from '../http/hosts';

const PasswordSchema = z.object({ password: z.string() });
const SetupSchema = z.object({ password: z.string(), setupCode: z.string().optional() });
const ChangePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string() });
const TokenCreateSchema = z.object({ name: z.string().optional(), scope: z.enum(['agent', 'readonly']) });

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;

/**
 * Failed-password limit per key (client address; behind a local proxy also the session, see
 * `limiterKey`). An attempt **reserves** a slot before the (slow) scrypt check and gives it back only on
 * success, so parallel wrong guesses cannot overtake the counter: at most MAX_FAILURES checks are ever
 * in flight or failed per window.
 */
export class LoginLimiter {
  private slots = new Map<string, { count: number; since: number }>();
  constructor(private now: () => number = () => Date.now()) {}

  /** Throws 429 when the key has no slot left; otherwise takes one */
  reserve(key: string): void {
    let f = this.slots.get(key);
    if (f && this.now() - f.since > WINDOW_MS) {
      this.slots.delete(key);
      f = undefined;
    }
    if (!f) {
      this.slots.set(key, { count: 1, since: this.now() });
      return;
    }
    if (f.count >= MAX_FAILURES) {
      const mins = Math.max(1, Math.ceil((WINDOW_MS - (this.now() - f.since)) / 60_000));
      throw new HttpError(429, 'rate_limited', `Too many failed attempts; try again in ${mins} min`);
    }
    f.count++;
  }

  /** Correct password: the key starts over */
  release(key: string): void {
    this.slots.delete(key);
  }
}

/**
 * Rate-limit key. Normally the client address. A loopback peer is usually a local proxy (`tailscale
 * serve`, the Vite dev server) through which every client arrives from 127.0.0.1: there the session is
 * added when there is one (re-auth, password change), so one browser cannot lock out another; logins
 * through such a proxy share one bucket (documented in the README).
 */
export function limiterKey(addr: string, sessionId?: string): string {
  return isLoopbackAddress(addr) && sessionId ? `${addr}|${sessionId}` : addr;
}

export interface SessionInfo {
  needsSetup: boolean;
  /** First-run setup needs the one-time code from the server log (not a local request to a loopback-bound server) */
  setupCodeRequired: boolean;
  authenticated: boolean;
  scope: Principal['scope'] | null;
  recentAuth: boolean;
  unlocked: boolean;
  /** Why the core is locked; only for authenticated callers (others just see unlocked: false) */
  lockReason: string | null;
}

export interface AuthRouteOptions {
  lockReason: () => string | null;
  limiter?: LoginLimiter;
  /** The server is bound to a loopback address only (127.0.0.1 / ::1) */
  loopbackOnly: boolean;
}

/**
 * A request from this machine straight to a loopback-bound server: loopback peer, no proxy headers and a
 * loopback Host. Anything else (LAN, Tailscale, `tailscale serve`, Docker port mapping) must present the
 * setup code from the server log.
 */
export function isLocalDirectRequest(c: Context, loopbackOnly: boolean): boolean {
  if (!loopbackOnly || !isLoopbackAddress(clientAddress(c))) return false;
  if (c.req.header('x-forwarded-for') || c.req.header('forwarded') || c.req.header('x-real-ip')) return false;
  const host = hostName(c.req.header('host'));
  return host === 'localhost' || host === '::1' || (!!host && /^127\./.test(host));
}

export function registerAuthRoutes(app: Hono<AppEnv>, core: Core, opts: AuthRouteOptions): void {
  const auth = core.auth;
  const limiter = opts.limiter ?? new LoginLimiter();
  const audit = core.services.audit;

  const info = (c: Context<AppEnv>, principal: Principal | null): SessionInfo => {
    const needsSetup = !auth.hasAdminPassword();
    return {
      needsSetup,
      setupCodeRequired: needsSetup && !isLocalDirectRequest(c, opts.loopbackOnly),
      authenticated: !!principal,
      scope: principal?.scope ?? null,
      recentAuth: principal?.scope === 'admin' ? principal.recentAuth : false,
      unlocked: core.isUnlocked(),
      lockReason: principal && !core.isUnlocked() ? opts.lockReason() : null,
    };
  };
  const startSession = (c: Context<AppEnv>): Principal => {
    const { token, session } = auth.createSession(c.req.header('user-agent'));
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: isHttps(c),
      path: '/',
      maxAge: Math.floor(SESSION_MAX_MS / 1000),
    });
    return { scope: 'admin', via: 'session', sessionId: session.id, recentAuth: true };
  };

  /** Checks the admin password with rate limiting (slot reserved before scrypt) and auditing; throws on failure */
  const checkPassword = async (c: Context<AppEnv>, password: string, action: string, sessionId?: string): Promise<void> => {
    const addr = clientAddress(c);
    const key = limiterKey(addr, sessionId);
    limiter.reserve(key);
    let valid = false;
    try {
      valid = await auth.verifyAdminPassword(password);
    } catch {
      valid = false;
    }
    if (valid) {
      limiter.release(key);
      return;
    }
    audit.record('human', action, null, { from: addr }, 'denied: wrong password');
    throw new HttpError(401, 'unauthenticated', 'Incorrect password');
  };

  const handle = (fn: (c: Context<AppEnv>) => Promise<unknown>) => async (c: Context<AppEnv>) => {
    try {
      return ok(c, await fn(c));
    } catch (err) {
      return fail(c, err);
    }
  };

  app.get('/api/auth/session', (c) => ok(c, info(c, c.get('principal'))));

  app.post(
    '/api/auth/setup',
    handle(async (c) => {
      const { password, setupCode } = parseInput(SetupSchema, await readJsonBody(c));
      if (auth.hasAdminPassword()) throw new HttpError(409, 'conflict', 'An admin password is already set; log in instead');
      if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, 'invalid_input', `The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      const addr = clientAddress(c);
      if (!isLocalDirectRequest(c, opts.loopbackOnly)) {
        // Rate-limited like a password: the code is the only secret here
        const key = limiterKey(addr);
        limiter.reserve(key);
        if (!auth.verifySetupCode(setupCode)) {
          audit.record('human', 'auth.setup', null, { from: addr }, 'denied: wrong setup code');
          throw new HttpError(403, 'setup_code_required', 'Enter the one-time setup code printed in the server log');
        }
        limiter.release(key);
      }
      if (!(await auth.setInitialAdminPassword(password))) throw new HttpError(409, 'conflict', 'An admin password is already set; log in instead');
      audit.record('human', 'auth.setup', null, { from: addr }, 'ok');
      return info(c, startSession(c));
    })
  );

  app.post(
    '/api/auth/login',
    handle(async (c) => {
      const { password } = parseInput(PasswordSchema, await readJsonBody(c));
      if (!auth.hasAdminPassword()) throw new HttpError(409, 'conflict', 'No admin password yet: complete the first-run setup');
      await checkPassword(c, password, 'auth.login');
      audit.record('human', 'auth.login', null, { from: clientAddress(c) }, 'ok');
      return info(c, startSession(c));
    })
  );

  app.post(
    '/api/auth/logout',
    handle(async (c) => {
      const p = c.get('principal');
      if (p?.scope === 'admin') auth.deleteSession(p.sessionId);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return undefined;
    })
  );

  app.post(
    '/api/auth/reauth',
    handle(async (c) => {
      const p = c.get('principal');
      if (p?.scope !== 'admin') throw new HttpError(401, 'unauthenticated', 'Not logged in');
      const { password } = parseInput(PasswordSchema, await readJsonBody(c));
      await checkPassword(c, password, 'auth.reauth', p.sessionId);
      auth.markReauth(p.sessionId);
      return info(c, { ...p, recentAuth: true });
    })
  );

  app.post(
    '/api/auth/password',
    handle(async (c) => {
      const p = c.get('principal');
      if (p?.scope !== 'admin') throw new HttpError(401, 'unauthenticated', 'Not logged in');
      const { currentPassword, newPassword } = parseInput(ChangePasswordSchema, await readJsonBody(c));
      await checkPassword(c, currentPassword, 'auth.password_change', p.sessionId);
      await auth.setAdminPassword(newPassword).catch((err) => {
        throw new HttpError(400, 'invalid_input', err instanceof Error ? err.message : String(err));
      });
      // Every other browser is logged out
      auth.deleteAllSessions(p.sessionId);
      auth.markReauth(p.sessionId);
      audit.record('human', 'auth.password_change', null, { from: clientAddress(c) }, 'ok');
      return undefined;
    })
  );

  mountRoutes(app, [
    { method: 'get', path: '/api/auth/tokens', allow: ['admin'], handler: () => auth.listTokens() },
    {
      method: 'post',
      path: '/api/auth/tokens',
      recentAuth: true,
      handler: ({ body }) => {
        const { name, scope } = parseInput(TokenCreateSchema, body);
        const created = auth.createToken(name ?? scope, scope);
        audit.record('human', 'auth.token_create', created.view.id, { name: created.view.name, scope }, 'ok');
        // The token is shown once; only its hash is stored
        return { token: created.token, ...created.view };
      },
    },
    {
      method: 'delete',
      path: '/api/auth/tokens/:id',
      allow: ['admin'],
      handler: ({ param }) => {
        const revoked = auth.revokeToken(param('id'));
        if (revoked) audit.record('human', 'auth.token_revoke', param('id'), undefined, 'ok');
        return { revoked };
      },
    },
  ]);
}
