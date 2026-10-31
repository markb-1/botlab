/**
 * Response envelope and error mapping. Every `/api` response is `{ success, data?, message? }` or
 * `{ success: false, error, code }` — the shape the Electron IPC returned, so the web client changed
 * little. `ServiceError` codes map to HTTP statuses; other errors are 500 with their message.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ServiceError, type ServiceErrorCode } from '../../../../packages/core/src/services/errors';

export type ErrorCode = ServiceErrorCode | 'unauthenticated' | 'reauth_required' | 'csrf' | 'host_not_allowed' | 'rate_limited' | 'error';

const STATUS: Record<ServiceErrorCode, ContentfulStatusCode> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  locked: 423,
  unavailable: 503,
};

/** An error with an HTTP status, thrown by the transport layer itself */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorInfo(err: unknown): { status: ContentfulStatusCode; code: ErrorCode; message: string } {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof ServiceError) return { status: STATUS[err.code] ?? 500, code: err.code, message: err.message };
  return { status: 500, code: 'error', message: err instanceof Error ? err.message : String(err) };
}

export function ok(c: Context, data: unknown, message?: string): Response {
  return c.json({ success: true, ...(data !== undefined ? { data } : {}), ...(message !== undefined ? { message } : {}) }, 200);
}

export function fail(c: Context, err: unknown): Response {
  const { status, code, message } = errorInfo(err);
  if (status >= 500) console.error(`[HTTP] ${c.req.method} ${c.req.path} → ${status}: ${message}`);
  return c.json({ success: false, error: message, code }, status);
}
