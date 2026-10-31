/**
 * Declarative routes: each says which scopes may call it and whether it needs a recent password check;
 * `mountRoutes` enforces both before the handler runs, parses the JSON body and wraps the result in
 * the envelope. Handlers stay thin (spec §1.1): parse input with the shared zod schemas → call a
 * service with the actor derived from the principal → return the result.
 */

import type { Context, Hono } from 'hono';
import type { Actor, HumanActor } from '../../../../packages/core/src/services/actors';
import { HttpError, fail, ok } from './respond';
import { ServiceError, type ServiceErrorCode } from '../../../../packages/core/src/services/errors';
import { actorOf, humanOf, requirePrincipal, type AppEnv, type Principal, type Scope } from './principal';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteContext {
  c: Context<AppEnv>;
  principal: Principal;
  /** The actor for the principal (throws for readonly tokens) */
  actor: () => Actor;
  /** The human actor (throws unless the principal is the admin session) */
  human: () => HumanActor;
  /** Parsed JSON body (undefined when empty) */
  body: unknown;
  param: (name: string) => string;
  query: (name: string) => string | undefined;
}

export interface RouteDef {
  method: Method;
  path: string;
  /** Default: GET ⇒ admin + readonly; otherwise admin only. The agent scope is opt-in per route. */
  allow?: Scope[];
  /** Human-only admin actions (spec §4.6): the session's password check must be < 15 min old */
  recentAuth?: boolean;
  /**
   * The domain layer (BotManager, HaltService, ConfigService, wallet manager, exchange clients) throws
   * plain errors whose messages are meant for the user ("Bot is halted", "Live trading is disabled").
   * With this set, such errors become `ServiceError(domainErrors)` with their message; without it they
   * are internal errors (generic 500 + error id).
   */
  domainErrors?: ServiceErrorCode;
  /** `message` in the success envelope (shown by the UI) */
  message?: string | ((data: unknown) => string | undefined);
  handler: (ctx: RouteContext) => unknown;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function readJsonBody(c: Context): Promise<unknown> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_input', 'Request body too large');
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_input', 'Request body too large');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_input', 'Invalid input: body is not valid JSON');
  }
}

export function checkScope(principal: Principal, def: Pick<RouteDef, 'method' | 'allow' | 'recentAuth'>): void {
  const allow = def.allow ?? (def.method === 'get' ? ['admin', 'readonly'] : ['admin']);
  if (!allow.includes(principal.scope)) throw new HttpError(403, 'forbidden', `Not allowed for the ${principal.scope} scope`);
  if (def.recentAuth) {
    if (principal.scope !== 'admin') throw new HttpError(403, 'forbidden', 'Human admin only');
    if (!principal.recentAuth) throw new HttpError(403, 'reauth_required', 'Confirm your password to continue (last check is older than 15 minutes)');
  }
}

export function mountRoutes(app: Hono<AppEnv>, defs: RouteDef[]): void {
  for (const def of defs) {
    app.on(def.method.toUpperCase(), def.path, async (c) => {
      try {
        const principal = requirePrincipal(c);
        checkScope(principal, def);
        const body = def.method === 'get' || def.method === 'delete' ? undefined : await readJsonBody(c);
        const ctx: RouteContext = {
          c,
          principal,
          actor: () => actorOf(principal),
          human: () => humanOf(principal),
          body,
          param: (name) => c.req.param(name) ?? '',
          query: (name) => c.req.query(name),
        };
        let data: unknown;
        try {
          data = await def.handler(ctx);
        } catch (err) {
          if (def.domainErrors && err instanceof Error && !(err instanceof ServiceError) && !(err instanceof HttpError)) {
            throw new ServiceError(def.domainErrors, err.message);
          }
          throw err;
        }
        const message = typeof def.message === 'function' ? def.message(data) : def.message;
        return ok(c, data, message);
      } catch (err) {
        return fail(c, err);
      }
    });
  }
}

/** Query helpers: numbers and booleans arrive as strings */
export function queryNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_input', `Invalid input: not a number: ${v}`);
  return n;
}

export function queryBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new HttpError(400, 'invalid_input', `Invalid input: not a boolean: ${v}`);
}

export function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
