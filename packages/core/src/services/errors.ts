/**
 * Errors thrown by services. Transports map `code` to their own shape (HTTP: a status code plus
 * `{ success: false, error, code }`). The message is what the user sees.
 */
export type ServiceErrorCode =
  /** The input failed schema or value validation */
  | 'invalid_input'
  /** The addressed bot / wallet / script / run does not exist */
  | 'not_found'
  /** The action needs the wallet keys and the core is still locked */
  | 'locked'
  /** The feature is not available in this core (e.g. no snapshot store) */
  | 'unavailable'
  /** The action is refused in the current state (e.g. editing a template) */
  | 'conflict'
  /** The actor may not do this (e.g. an agent calling a human-only action) */
  | 'forbidden';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export const notFound = (message: string): ServiceError => new ServiceError('not_found', message);
export const invalidInput = (message: string): ServiceError => new ServiceError('invalid_input', message);
export const conflict = (message: string): ServiceError => new ServiceError('conflict', message);
