/**
 * @botlab/core — all domain logic, no transport code (spec §1.1). Transports import from here.
 */
export { createCore, CORE_EVENTS } from './core';
export type { Core, CoreOptions, CoreServices, CoreRepositories, CoreEventName } from './core';
export * from './services/index';
export type { AuditActor } from './audit/AuditService';
