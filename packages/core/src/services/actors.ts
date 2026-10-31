/**
 * Who is calling a service (spec §4.6, §8.2). Actors are opaque objects that only the factory
 * functions below create; a transport calls them **after** authenticating the caller and derives the
 * kind from the authenticated principal (HTTP: the session or the API token's scope), never from request data.
 *
 * Human-only domain actions (clearing halts, config writes/restores, position adoption, market
 * assessments, forced category rights) take a `HumanActor` at the type level and re-check at runtime
 * with `isHumanActor`, so the plain string `'human'` (or any object built by hand) is refused.
 * Audit rows keep the plain `AuditActor` string (`auditActorOf`).
 */

import type { AuditActor } from '../db/repositories/AuditRepository';
import { ServiceError } from './errors';

/** Private brand: not exported, so the type cannot be satisfied outside this module */
declare const ACTOR_BRAND: unique symbol;
/** Runtime registry of minted actors; objects not created here are not actors */
const MINTED = new WeakSet<object>();

interface ActorBase {
  readonly [ACTOR_BRAND]: true;
  /** Who, as the transport authenticated it (e.g. `electron:main-window`, `session:…`, `token:agent`) */
  readonly principal: string;
}
export interface HumanActor extends ActorBase {
  readonly kind: 'human';
}
export interface AgentActor extends ActorBase {
  readonly kind: 'agent';
}
export interface SystemActor extends ActorBase {
  readonly kind: 'system';
}
export type Actor = HumanActor | AgentActor | SystemActor;
export type ActorKind = Actor['kind'];

function mint<K extends ActorKind>(kind: K, principal: string): Extract<Actor, { kind: K }> {
  if (typeof principal !== 'string' || !principal.trim()) throw new Error('actor principal required');
  const actor = Object.freeze({ kind, principal: principal.trim() });
  MINTED.add(actor);
  return actor as unknown as Extract<Actor, { kind: K }>;
}

/** Only for a caller the transport authenticated as the human admin */
export function asHuman(principal: string): HumanActor {
  return mint('human', principal);
}

/** Only for a caller the transport authenticated with the agent scope */
export function asAgent(principal: string): AgentActor {
  return mint('agent', principal);
}

/** The application itself (schedulers, startup, Telegram commands mapped by core) */
export function asSystem(principal = 'core'): SystemActor {
  return mint('system', principal);
}

/** True only for actors created by the factories above */
export function isActor(value: unknown): value is Actor {
  return typeof value === 'object' && value !== null && MINTED.has(value);
}

export function isHumanActor(value: unknown): value is HumanActor {
  return isActor(value) && value.kind === 'human';
}

const AUDIT_ACTOR_RE = /^(human|agent|system|bot:.+)$/;

/**
 * Audit string for an actor. Minted actors map to their kind. A plain string (pre-actor callers,
 * denial paths) is kept if it looks like an AuditActor; anything else is recorded as `system`.
 */
export function auditActorOf(value: unknown): AuditActor {
  if (isActor(value)) return value.kind;
  if (typeof value === 'string' && AUDIT_ACTOR_RE.test(value)) return value as AuditActor;
  return 'system';
}

/** Throws unless `value` is a minted actor of one of `kinds` */
export function requireActor<K extends ActorKind>(value: unknown, kinds: readonly K[], what: string): Extract<Actor, { kind: K }> {
  if (!isActor(value)) throw new ServiceError('forbidden', `${what}: unauthenticated actor`);
  if (!(kinds as readonly string[]).includes(value.kind)) throw new ServiceError('forbidden', `${what}: not allowed for ${value.kind}`);
  return value as Extract<Actor, { kind: K }>;
}

/** Denial suffix for audit rows: says whether the caller was not human or not an authenticated actor */
export function humanDenial(value: unknown): string {
  return isActor(value) ? 'denied: human only' : 'denied: human only (unauthenticated actor)';
}
