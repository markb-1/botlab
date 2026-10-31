/**
 * IPC response shaping. Handlers are thin (spec §1.1): check the sender, parse the input with the
 * shared schema, call a core service, wrap the result as `{ success, data }` or `{ success: false, error }`.
 */

import type { WebContents } from 'electron';
import type { IpcResponse } from '../../packages/core/src/services/types';

/** Run a service call; a thrown error becomes `{ success: false, error: message }`. */
export async function respond<T>(fn: () => T | Promise<T>, message?: string): Promise<IpcResponse<T>> {
  try {
    const data = await fn();
    return {
      success: true,
      ...(data !== undefined ? { data } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const UNTRUSTED: IpcResponse = { success: false, error: 'Not allowed from this window' };

/** Only the app's main window may perform human-only actions (R27) */
export type TrustedSenderCheck = (sender: WebContents) => boolean;
