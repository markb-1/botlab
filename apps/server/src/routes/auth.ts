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
import { clientAddress, isHttps } from '../http/request';

const PasswordSchema = z.object({ password: z.string() });
const ChangePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string() });
const TokenCreateSchema = z.object({ name: z.string().optional(), scope: z.enum(['agent', 'readonly']) });

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;

/** Per-address failed-password counter */
export class LoginLimiter {
  private failures = new Map<string, { count: number; since: number }>();
  constructor(private now: () => number = Date.now) {}

  check(addr: string): void {
    const f = this.failures.get(addr);
    if (!f) return;
    if (this.now() - f.since > WINDOW_MS) {
      this.failures.delete(addr);
      return;
    }
    if (f.count >= MAX_FAILURES) {
      const mins = Math.ceil((WINDOW_MS - (this.now() - f.since)) / 60_000);
      throw new HttpError(429, 'rate_limited', `Too many failed attempts; try again in ${mins} min`);
    }
  }

  fail(addr: string): void {
    const f = this.failures.get(addr);
    if (!f || this.now() - f.since > WINDOW_MS) this.failures.set(addr, { count: 1, since: this.now() });
    else f.count++;
  }

  reset(addr: string): void {
    this.failures.delete(addr);
  }
}

export interface SessionInfo {
  needsSetup: boolean;
  authenticated: boolean;
  scope: Principal['scope'] | null;
  recentAuth: boolean;
  unlocked: boolean;
  lockReason: string | null;
}

export function registerAuthRoutes(app: Hono<AppEnv>, core: Core, opts: { lockReason: () => string | null; limiter?: LoginLimiter }): void {
  const auth = core.auth;
  const limiter = opts.limiter ?? new LoginLimiter();
  const audit = core.services.audit;

  const info = (principal: Principal | null): SessionInfo => ({
    needsSetup: !auth.hasAdminPassword(),
    authenticated: !!principal,
    scope: principal?.scope ?? null,
    recentAuth: principal?.scope === 'admin' ? principal.recentAuth : false,
    unlocked: core.isUnlocked(),
    lockReason: core.isUnlocked() ? null : opts.lockReason(),
  });

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

  /** Checks the admin password with rate limiting and auditing; throws on failure */
  const checkPassword = async (c: Context<AppEnv>, password: string, action: string): Promise<void> => {
    const addr = clientAddress(c);
    limiter.check(addr);
    if (await auth.verifyAdminPassword(password)) {
      limiter.reset(addr);
      return;
    }
    limiter.fail(addr);
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

  app.get('/api/auth/session', (c) => ok(c, info(c.get('principal'))));

  app.post(
    '/api/auth/setup',
    handle(async (c) => {
      const { password } = parseInput(PasswordSchema, await readJsonBody(c));
      if (auth.hasAdminPassword()) throw new HttpError(409, 'conflict', 'An admin password is already set; log in instead');
      if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, 'invalid_input', `The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      if (!(await auth.setInitialAdminPassword(password))) throw new HttpError(409, 'conflict', 'An admin password is already set; log in instead');
      audit.record('human', 'auth.setup', null, { from: clientAddress(c) }, 'ok');
      return info(startSession(c));
    })
  );

  app.post(
    '/api/auth/login',
    handle(async (c) => {
      const { password } = parseInput(PasswordSchema, await readJsonBody(c));
      if (!auth.hasAdminPassword()) throw new HttpError(409, 'conflict', 'No admin password yet: complete the first-run setup');
      await checkPassword(c, password, 'auth.login');
      audit.record('human', 'auth.login', null, { from: clientAddress(c) }, 'ok');
      return info(startSession(c));
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
      await checkPassword(c, password, 'auth.reauth');
      auth.markReauth(p.sessionId);
      return info({ ...p, recentAuth: true });
    })
  );

  app.post(
    '/api/auth/password',
    handle(async (c) => {
      const p = c.get('principal');
      if (p?.scope !== 'admin') throw new HttpError(401, 'unauthenticated', 'Not logged in');
      const { currentPassword, newPassword } = parseInput(ChangePasswordSchema, await readJsonBody(c));
      await checkPassword(c, currentPassword, 'auth.password_change');
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
