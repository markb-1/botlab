/**
 * The Hono application (spec §8): host check → `/healthz` → `/api` (principal, CSRF, auth routes, API
 * routes, SSE) → the built web app with SPA fallback. Transport only: every route calls core services.
 */

import { Hono } from 'hono';
import { CORE_EVENTS, type Core } from '../../../packages/core/src/core';
import { HttpError, fail } from './http/respond';
import { csrfMiddleware, principalMiddleware, requirePrincipal, type AppEnv } from './http/principal';
import { mountRoutes } from './http/routes';
import { isHostAllowed } from './http/hosts';
import { healthReport } from './http/health';
import { SseHub } from './http/sse';
import { serveWeb } from './http/static';
import { apiRoutes } from './routes/api';
import { registerAuthRoutes, LoginLimiter } from './routes/auth';

export interface AppOptions {
  core: Core;
  /** Built web app directory; null ⇒ no static serving (dev: Vite serves the UI) */
  webDir: string | null;
  /** Extra allowed Host names (server.yaml `http.allowed_hosts`, BOTLAB_ALLOWED_HOSTS) */
  allowedHosts?: readonly string[];
  /** Why the core is locked, if it is (shown on the login screen) */
  lockReason?: () => string | null;
  /** When unlock finished (health: reconciler "starting" grace period) */
  unlockedAt?: () => number | null;
  limiter?: LoginLimiter;
  /** The server is bound to loopback only: first-run setup from this machine needs no setup code */
  loopbackOnly?: boolean;
}

export interface BotLabApp {
  app: Hono<AppEnv>;
  sse: SseHub;
}

export function createApp(opts: AppOptions): BotLabApp {
  const { core } = opts;
  const app = new Hono<AppEnv>();
  const sse = new SseHub(core.events, CORE_EVENTS);
  const allowedHosts = opts.allowedHosts ?? [];

  app.onError((err, c) => fail(c, err));

  // DNS rebinding protection, then a few defensive headers on everything
  app.use('*', async (c, next) => {
    if (!isHostAllowed(c.req.header('host'), allowedHosts)) {
      return c.json({ success: false, error: 'Host not allowed (add it to http.allowed_hosts in server.yaml)', code: 'host_not_allowed' }, 403);
    }
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/healthz', (c) => {
    const report = healthReport(core, opts.unlockedAt?.() ?? null);
    return c.json(report, report.ok ? 200 : 503);
  });

  app.use('/api/*', principalMiddleware(core.auth));
  app.use('/api/*', csrfMiddleware());
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  registerAuthRoutes(app, core, { lockReason: opts.lockReason ?? (() => null), limiter: opts.limiter, loopbackOnly: opts.loopbackOnly ?? false });
  mountRoutes(app, apiRoutes(core.services));

  app.get('/api/app/info', (c) => {
    try {
      requirePrincipal(c);
      return c.json({ success: true, data: { version: process.env.npm_package_version ?? null, unlocked: core.isUnlocked() } });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Events: any authenticated principal; re-checked on each keepalive
  app.get('/api/events', (c) => {
    try {
      requirePrincipal(c);
    } catch (err) {
      return fail(c, err);
    }
    const p = c.get('principal');
    const stillAuthorized = () =>
      p?.via === 'session' ? core.auth.getSessionById(p.sessionId) !== null : p?.via === 'token' ? core.auth.isTokenActive(p.tokenId) : false;
    return sse.handle(c, stillAuthorized);
  });

  app.all('/api/*', (c) => fail(c, new HttpError(404, 'not_found', `No such endpoint: ${c.req.method} ${c.req.path}`)));

  if (opts.webDir) {
    const web = serveWeb(opts.webDir);
    app.get('*', (c) => web(c));
  } else {
    app.get('/', (c) => c.text('BotLab API server. The web UI is not built: run `npm run build` (or use `npm run dev`, which serves it on http://localhost:3000).'));
  }

  return { app, sse };
}
